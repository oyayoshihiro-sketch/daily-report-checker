const Anthropic = require('@anthropic-ai/sdk');
const cfg = require('./config');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// プロンプトテンプレートを展開してClaude APIに送る共通関数
function callClaude(promptTemplate, replacements, maxTokens = 400) {
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

  return client.messages.create(params).then(response => {
    const raw  = response.content[0].text.trim();
    const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(json);
  });
}

// 夕方の日報分析（振り返りスコア・成長メモのみ）
// ※ 勝ち/負けの判定は checker.js の extractWinsLoss で直接抽出する
// ※ コンディション（感情スコア・信号）は廃止済み
async function analyzeEveningReport(text) {
  const promptTemplate = cfg.get('evening_prompt') || '';
  try {
    const r = await callClaude(promptTemplate, { '{DAILY_REPORT_TEXT}': text }, 350);
    return {
      reflection_score: r.reflection_score != null ? r.reflection_score : null,
      growth_note: r.growth_note || null,
    };
  } catch (e) {
    console.error('[analyzer] analyzeEveningReport error:', e.message);
    return { reflection_score: null, growth_note: null };
  }
}

module.exports = { analyzeEveningReport };
