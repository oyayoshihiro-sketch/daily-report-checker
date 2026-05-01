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

// 夕方の日報分析（勝ち/負け/振り返りスコア付き）
async function analyzeEveningReport(text, previousScore = null) {
  const promptTemplate = cfg.get('evening_prompt') || cfg.get('sentiment_prompt') || '';
  try {
    return await callClaude(promptTemplate, {
      '{DAILY_REPORT_TEXT}': text,
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
