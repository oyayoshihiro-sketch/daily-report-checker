const Anthropic = require('@anthropic-ai/sdk');
const cfg = require('./config');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// プロンプトテンプレートを展開してClaude APIに送る共通関数
async function callClaude(promptTemplate, replacements, maxTokens = 500) {
  let systemArr, userContent;

  if (promptTemplate.includes('{DAILY_REPORT_TEXT}')) {
    const MARKER = '\n## 入力';
    const splitIdx = promptTemplate.indexOf(MARKER);
    let filled = promptTemplate;
    for (const [k, v] of Object.entries(replacements)) {
      filled = filled.replace(k, v !== null && v !== undefined ? String(v) : 'null');
    }
    if (splitIdx >= 0) {
      const systemPart = promptTemplate.slice(0, splitIdx);
      const userPart   = filled.slice(splitIdx + 1);
      systemArr   = [{ type: 'text', text: systemPart, cache_control: { type: 'ephemeral' } }];
      userContent = userPart;
    } else {
      userContent = filled;
      systemArr   = null;
    }
  } else {
    systemArr   = [{ type: 'text', text: promptTemplate, cache_control: { type: 'ephemeral' } }];
    userContent = `以下の日報を分析してください:\n\n${replacements['{DAILY_REPORT_TEXT}'] || ''}`;
  }

  const params = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: userContent }],
  };
  if (systemArr) params.system = systemArr;

  const response = await client.messages.create(params);
  const raw  = response.content[0].text.trim();
  const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(json);
}

// ワークフロー別の勝ち/負けセクション抽出
// 対応フォーマット:
//   Biz日報_退勤時          → :crossed_swords: 勝敗 の直下行
//   コーポレート_勝ち負け通信 → 今日の勝ち負け（戦績）の直下テキスト
//   StandUP                 → 今日の勝ち負け（戦績）の直下テキスト
function extractWinsSection(text) {
  if (!text) return null;

  // --- Biz日報_退勤時 ---
  const bizIdx = text.search(/:crossed_swords:\s*勝敗/);
  if (bizIdx !== -1) {
    const lineEnd = text.indexOf('\n', bizIdx);
    if (lineEnd !== -1) {
      const afterHeader = text.slice(lineEnd + 1);
      // 次の :emoji: ヘッダー行 または 空行まで
      const stopAt = afterHeader.search(/\n\s*:[a-zA-Z0-9_]+:|\n\s*\n/);
      const section = (stopAt !== -1 ? afterHeader.slice(0, stopAt) : afterHeader).trim();
      if (section) {
        console.log('[analyzer] wins section (Biz):', section.slice(0, 80));
        return section;
      }
    }
  }

  // --- コーポレート_勝ち負け通信 / StandUP ---
  const corpIdx = text.search(/今日の勝ち負け[（(]戦績[）)]/);
  if (corpIdx !== -1) {
    const lineEnd = text.indexOf('\n', corpIdx);
    if (lineEnd !== -1) {
      const afterHeader = text.slice(lineEnd + 1);
      // 空行（\n\n）または末尾まで
      const stopAt = afterHeader.search(/\n\s*\n/);
      const section = (stopAt !== -1 ? afterHeader.slice(0, stopAt) : afterHeader).trim();
      if (section) {
        console.log('[analyzer] wins section (Corp/StandUP):', section.slice(0, 80));
        return section;
      }
    }
  }

  return null;
}

// 夕方の日報分析（勝ち/負け/振り返りスコア付き）
async function analyzeEveningReport(text, previousScore = null) {
  const promptTemplate = cfg.get('evening_prompt') || cfg.get('sentiment_prompt') || '';

  // ワークフロー別の勝ち/負けセクションを抽出し、判定の根拠として追記
  const winsSection = extractWinsSection(text);
  const reportText  = winsSection
    ? `${text}\n\n---\n【勝ち/負け判定の根拠（必ずこのセクションのみを使用すること）】\n${winsSection}`
    : text;

  try {
    return await callClaude(promptTemplate, {
      '{DAILY_REPORT_TEXT}': reportText,
      '{PREVIOUS_SCORE}': previousScore !== null ? String(previousScore) : 'null',
    }, 600);
  } catch (e) {
    console.error('[analyzer] analyzeEveningReport error:', e.message);
    return { score: 0.5, label: 'YELLOW', summary: '分析エラー' };
  }
}

// 朝の日報分析（意欲・計画の評価）
async function analyzeMorningReport(text) {
  const promptTemplate = cfg.get('morning_prompt') || cfg.get('sentiment_prompt') || '';
  try {
    return await callClaude(promptTemplate, {
      '{DAILY_REPORT_TEXT}': text,
      '{PREVIOUS_SCORE}': 'null',
    }, 350);
  } catch (e) {
    console.error('[analyzer] analyzeMorningReport error:', e.message);
    return { score: 0.5, label: 'YELLOW', summary: '分析エラー' };
  }
}

// 後方互換: 既存コードから使われているケースに対応
async function analyzeReport(text, previousScore = null) {
  return analyzeEveningReport(text, previousScore);
}

module.exports = { analyzeReport, analyzeEveningReport, analyzeMorningReport };
