const db = require('./db');
const cfg = require('./config');
const { analyzeReport } = require('./analyzer');
const { getChannelHistory } = require('./slack');

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
        // 特定のBotのみ対象にしている場合は他のBotをスキップ
        skippedBot++;
        continue;
      }
      // user_id_regexでユーザーIDを抽出（ワークフロー投稿対応）
      if (userIdRegex) {
        const m = msg.text?.match(new RegExp(userIdRegex));
        if (m?.[1]) userId = m[1];
      }
      if (!userId) {
        // user_idが取れないbot_messageはスキップ
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

    db.upsertReport({
      userId,
      reportDate: date,
      postedAt,
      postedHour: jstHour,
      text: msg.text,
      charCount: calcCharCount(msg.text),
      ts: msg.ts,
      channelId,
    });
    saved++;
  }

  console.log(`[checker] 保存=${saved}, botスキップ=${skippedBot}, userなし=${skippedNoUser}, メンバー不一致=${skippedNoMember}`);
}

// 投稿時刻による深夜フラグ計算
//   2 = 23:00〜翌5:00（赤）
//   1 = 22:00〜22:59（黄）
//   0 = それ以外
function calcLateNightFlag(postedHour) {
  if (postedHour >= 23 || postedHour < 5) return 2;
  if (postedHour === 22) return 1;
  return 0;
}

// 投稿遅れフラグ: 翌5:00〜13:00（朝〜昼に投稿 = 日報が遅延）
function calcLatePostFlag(postedHour) {
  return (postedHour >= 5 && postedHour <= 13) ? 1 : 0;
}

// 信号ロジック
// 優先順位:
//   1. 23時〜翌5時（lateNightFlag=2）→ 無条件で赤
//   2. 感情スコア <= 0.35 → 赤
//   3. 22時台（lateNightFlag=1）→ 黄
//   4. 感情スコア 0.36~0.59 → 黄
//   5. 投稿遅れ（latePostFlag=1, 翌5〜13時）→ 黄
//   6. 文量変化フラグ → 黄
//   7. それ以外 → 青
function calcSignal(lateNightFlag, latePostFlag, sentimentFlag, volumeFlag, sentimentScore) {
  if (lateNightFlag >= 2) return 'red';
  if (sentimentScore !== null && sentimentScore !== undefined) {
    if (sentimentScore <= 0.35) return 'red';
  }
  if (lateNightFlag >= 1) return 'yellow';
  if (sentimentScore !== null && sentimentScore !== undefined) {
    if (sentimentScore < 0.60) return 'yellow';
  }
  if (latePostFlag) return 'yellow';
  if (volumeFlag)   return 'yellow';
  return 'green';
}

async function checkMember(member, date) {
  const report = db.getReport(member.user_id, date);

  if (!report) {
    db.upsertCheck({
      userId: member.user_id, checkDate: date, posted: 0,
      lateNightFlag: 0, latePostFlag: 0, sentimentFlag: 0, sentimentScore: null,
      volumeFlag: 0, volumeRatio: null, flagCount: 0,
      signal: null, sentimentSummary: null, praisePoints: null, followPoints: null,
    });
    return;
  }

  const lateNightFlag = calcLateNightFlag(report.posted_hour);
  const latePostFlag  = calcLatePostFlag(report.posted_hour);

  let sentimentFlag = 0, sentimentScore = null, sentimentSummary = null, praisePoints = null, followPoints = null;
  try {
    const prevCheck   = db.getLatestCheck(member.user_id);
    const prevScore   = prevCheck && prevCheck.check_date !== date ? prevCheck.sentiment_score : null;
    const r = await analyzeReport(report.text, prevScore);
    sentimentScore   = r.score;
    sentimentSummary = r.summary || null;
    praisePoints     = r.praise || null;
    followPoints     = r.follow || null;
    sentimentFlag    = r.score < cfg.get('sentiment_threshold') ? 1 : 0;
  } catch (e) {
    console.error('[checker] sentiment error:', e.message);
  }

  const past = db.getRecentReports(member.user_id, cfg.get('volume_lookback_days') + 1)
    .filter(r => r.report_date !== date);
  let volumeFlag = 0, volumeRatio = null;
  if (past.length >= cfg.get('volume_min_samples')) {
    const avg = past.reduce((s, r) => s + r.char_count, 0) / past.length;
    if (avg > 0) {
      volumeRatio = report.char_count / avg;
      volumeFlag = Math.abs(volumeRatio - 1) * 100 >= cfg.get('volume_change_pct') ? 1 : 0;
    }
  }

  const flagCount = lateNightFlag + latePostFlag + sentimentFlag + volumeFlag;
  const signal    = calcSignal(lateNightFlag, latePostFlag, sentimentFlag, volumeFlag, sentimentScore);

  db.upsertCheck({
    userId: member.user_id, checkDate: date, posted: 1,
    lateNightFlag, latePostFlag, sentimentFlag, sentimentScore,
    volumeFlag, volumeRatio, flagCount,
    signal, sentimentSummary, praisePoints, followPoints,
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

module.exports = { runCheckForDate, todayJst };
