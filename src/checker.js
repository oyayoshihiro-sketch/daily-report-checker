const db = require('./db');
const cfg = require('./config');
const { analyzeEveningReport } = require('./analyzer');
const { getChannelHistory } = require('./slack');

// ── 勝敗判定 ────────────────────────────────────────────────────────────────
// 日報の「勝敗」フィールド（例: ":crossed_swords:勝敗" の直下行）から
// 勝ち / 負け を抽出する。AIは使わず、テキストから決定的に判定する。
//
// 返り値: 'win' | 'loss' | null
//   - 'win'  … 明示的に勝ち（勝ち / 勝利 / ○ など）
//   - 'loss' … 明示的に負け（負け / 敗北 / × など）
//   - null   … 勝敗フィールドが無い／引き分け・なし等で判定対象外
//             （勝率の母数には含めない）

// Slack装飾（*bold* _italic_ ~strike~）と絵文字ショートコード :xxx: を除去
function stripDecor(s) {
  return (s || '')
    .replace(/:[a-z0-9_+'-]+:/gi, '')  // :crossed_swords: などのショートコード
    .replace(/[*_~`]/g, '')
    .replace(/️/g, '')            // 異体字セレクタ
    .trim();
}

// 値文字列を勝ち / 負け / 判定対象外 に分類
function classifyVerdict(rawVal) {
  const val = stripDecor(rawVal).replace(/[\s　]/g, '');
  if (!val) return null;

  // 引き分け・該当なし・未定 → 判定対象外（母数から除外）
  if (/引[きこ]?分け|ドロー|draw|△|—|なし|未定|保留|N\/?A/i.test(val)) return null;
  if (/^[-ー－]+$/.test(val)) return null;

  // 明示的な負けを先に判定（「勝ち」を含む文字列でも負けが書かれていれば負け優先）
  if (/負け|負け越し|敗北|惨敗|完敗|敗け|×|✕|✗|✖/.test(val)) return 'loss';

  // 明示的な勝ち
  if (/勝ち|勝利|快勝|圧勝|辛勝|勝[っち]た|○|◯|〇|win/i.test(val)) return 'win';

  return null;
}

// テキスト全体から「勝敗」フィールドの勝敗を抽出
// 返り値: { verdict, text }
function extractVerdict(text) {
  if (!text) return { verdict: null, text: null };

  const lines = text.replace(/\r\n/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const clean = stripDecor(lines[i]);
    // 「勝敗」ラベルを含む行のみ対象（"勝ち負け要因" や "今日の勝ち" は対象外）
    if (!/勝敗/.test(clean)) continue;

    // (A) 同一行に値: 「勝敗：勝ち」「勝敗 = 勝ち」など
    const inline = clean.match(/勝敗\s*[：:＝=\-ー]?\s*(.*)$/);
    const inlineVal = inline ? inline[1] : '';
    let v = classifyVerdict(inlineVal);
    if (v) {
      console.log(`[checker] extractVerdict (inline) "${stripDecor(inlineVal)}" → ${v}`);
      return { verdict: v, text: stripDecor(inlineVal) || v };
    }

    // (B) 次の非空行
    let j = i + 1;
    while (j < lines.length && stripDecor(lines[j]) === '') j++;
    if (j < lines.length) {
      const next = stripDecor(lines[j]);
      v = classifyVerdict(next);
      if (v) {
        console.log(`[checker] extractVerdict (nextline) "${next.slice(0, 40)}" → ${v}`);
        return { verdict: v, text: next };
      }
    }
    // この「勝敗」行では判定できなかった → 次の「勝敗」行を探す
  }

  const preview = lines.slice(0, 5).map(stripDecor).join(' | ').slice(0, 120);
  console.log(`[checker] extractVerdict: 勝敗を判定できず。先頭: "${preview}"`);
  return { verdict: null, text: null };
}

// 後方互換のため wins_text / losses_text 形式に変換
function extractWinsLoss(text) {
  const { verdict, text: val } = extractVerdict(text);
  if (verdict === 'win')  return { wins: val, losses: null };
  if (verdict === 'loss') return { wins: null, losses: val };
  return { wins: null, losses: null };
}

function todayJst() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

function calcCharCount(text) {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/:[a-z0-9_+-]+:/g, '')
    .replace(/\s/g, '')
    .length;
}

// 3-12時 = 朝の日報, それ以外 = 夜の日報
function classifyReportType(postedHour) {
  return (postedHour >= 3 && postedHour <= 12) ? 'morning' : 'evening';
}

async function fetchAndStoreReports(date) {
  const channelId = cfg.get('report_channel_id');
  const workflowBotId = cfg.get('workflow_bot_id');
  const userIdRegex = cfg.get('user_id_regex');

  // 27時制: D日の03:00 JST ～ (D+1)日の02:59 JST をD日分として扱う
  const dateBase = new Date(date + 'T00:00:00+09:00').getTime();
  const oldest = (dateBase + 3  * 3600 * 1000) / 1000;       // D 03:00 JST
  const latest = (dateBase + 27 * 3600 * 1000 - 1) / 1000;   // D+1 02:59:59 JST

  const messages = await getChannelHistory(channelId, oldest, latest);
  console.log(`[checker] Fetched ${messages.length} messages for ${date} (channel: ${channelId})`);
  console.log(`[checker] workflow_bot_id="${workflowBotId || ''}", user_id_regex="${userIdRegex || ''}"`);

  let saved = 0, skippedBot = 0, skippedNoUser = 0, skippedNoMember = 0;

  for (const msg of messages) {
    let userId = msg.user;

    if (msg.subtype === 'bot_message') {
      if (workflowBotId && msg.bot_id !== workflowBotId) {
        skippedBot++;
        continue;
      }
      if (userIdRegex) {
        const m = msg.text?.match(new RegExp(userIdRegex));
        if (m?.[1]) userId = m[1];
      }
      if (!userId) {
        console.log(`[checker] skip bot_message (userId抽出不可): bot_id=${msg.bot_id}, text=${(msg.text || '').slice(0, 60)}`);
        skippedBot++;
        continue;
      }
    }

    if (!userId || !msg.text) { skippedNoUser++; continue; }
    const member = db.getMember(userId);
    if (!member || !member.is_active || member.is_bot) {
      console.log(`[checker] skip user=${userId}: member=${JSON.stringify(member ? { is_active: member.is_active, is_bot: member.is_bot } : null)}`);
      skippedNoMember++;
      continue;
    }

    const postedAt = new Date(parseFloat(msg.ts) * 1000).toISOString();
    const jstHour = new Date(new Date(postedAt).getTime() + 9 * 3600000).getUTCHours();
    const reportType = classifyReportType(jstHour);

    db.upsertReport({
      userId,
      reportDate: date,
      reportType,
      postedAt,
      postedHour: jstHour,
      text: msg.text,
      charCount: calcCharCount(msg.text),
      ts: msg.ts,
      channelId,
    });
    saved++;
  }

  console.log(`[checker] 保存=${saved} (朝/夜自動分類), botスキップ=${skippedBot}, userなし=${skippedNoUser}, メンバー不一致=${skippedNoMember}`);
}

// 勝ち負け＋投稿状況のみをチェック（コンディション分析は廃止済み）
async function checkMember(member, date) {
  const morningReport = db.getReportByType(member.user_id, date, 'morning');
  const eveningReport = db.getReportByType(member.user_id, date, 'evening');
  const morningPosted = !!morningReport;
  const eveningPosted = !!eveningReport;
  const posted = morningPosted || eveningPosted;

  // 共通: 削除済みコンディション列は null/0 で埋める（スキーマ互換のため）
  const legacy = {
    lateNightFlag: 0, latePostFlag: 0, sentimentFlag: 0, sentimentScore: null,
    volumeFlag: 0, volumeRatio: null, flagCount: 0, signal: null,
    sentimentSummary: null, praisePoints: null, followPoints: null, morningSummary: null,
  };

  if (!posted) {
    db.upsertCheck({
      userId: member.user_id, checkDate: date, posted: 0,
      morningPosted: 0, eveningPosted: 0, dualPostFlag: 0,
      winsText: null, lossesText: null, reflectionScore: null, growthNote: null,
      ...legacy,
    });
    return;
  }

  // 二回投稿フラグ: 朝・夜の両方が揃っていない場合に立てる
  const dualPostFlag = !(morningPosted && eveningPosted) ? 1 : 0;

  let winsText = null, lossesText = null, reflectionScore = null, growthNote = null;

  // 勝敗を「勝敗」フィールドから決定的に抽出（AI不使用、夜優先・朝もフォロー）
  const verdict = verdictForDay({ eveningText: eveningReport?.text, morningText: morningReport?.text });
  if (verdict === 'win')  winsText = '勝ち';
  if (verdict === 'loss') lossesText = '負け';

  if (eveningReport) {
    // 振り返りスコア・成長メモのみ AI で分析
    try {
      const r = await analyzeEveningReport(eveningReport.text);
      reflectionScore = r.reflection_score != null ? r.reflection_score : null;
      growthNote      = r.growth_note || null;
    } catch (e) {
      console.error('[checker] evening reflection error:', e.message);
    }
  }

  db.upsertCheck({
    userId: member.user_id, checkDate: date, posted: 1,
    morningPosted: morningPosted ? 1 : 0,
    eveningPosted: eveningPosted ? 1 : 0,
    dualPostFlag,
    winsText, lossesText, reflectionScore, growthNote,
    ...legacy,
  });
}

async function runCheckForDate(date) {
  date = date || todayJst();
  console.log(`[checker] Running check for ${date}`);
  await fetchAndStoreReports(date);
  const members = db.getActiveMembers();
  await Promise.all(members.map(m => checkMember(m, date)));
  return members;
}

// 1日分の勝敗を、その日の日報（夜優先・なければ朝）から判定する。
// 投稿時刻による朝/夜の誤分類に強い（勝敗欄がどちらにあっても拾う）。
function verdictForDay({ eveningText, morningText } = {}) {
  if (eveningText) {
    const v = extractVerdict(eveningText).verdict;
    if (v) return v;
  }
  if (morningText) {
    const v = extractVerdict(morningText).verdict;
    if (v) return v;
  }
  return null;
}

module.exports = {
  runCheckForDate, fetchAndStoreReports, checkMember, todayJst,
  extractWinsLoss, extractVerdict, classifyVerdict, verdictForDay,
};
