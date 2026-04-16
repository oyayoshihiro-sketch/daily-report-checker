const Anthropic = require('@anthropic-ai/sdk');
const cfg = require('./config');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function analyzeReport(text, previousScore = null) {
  const promptTemplate = cfg.get('sentiment_prompt') || '';
  try {
    let systemArr, userContent;

    if (promptTemplate.includes('{DAILY_REPORT_TEXT}')) {
      // テンプレート形式: "## 入力" より前をsystem、以降をuserとして分割
      const MARKER = '\n## 入力';
      const splitIdx = promptTemplate.indexOf(MARKER);
      if (splitIdx >= 0) {
        const systemPart = promptTemplate.slice(0, splitIdx);
        const userPart   = promptTemplate.slice(splitIdx + 1)
          .replace('{DAILY_REPORT_TEXT}', text)
          .replace('{PREVIOUS_SCORE}', previousScore !== null ? String(previousScore) : 'null');
        systemArr   = [{ type: 'text', text: systemPart, cache_control: { type: 'ephemeral' } }];
        userContent = userPart;
      } else {
        // 分割点が見つからない場合はプロンプト全体にプレースホルダーを埋め込んでuserとして送る
        userContent = promptTemplate
          .replace('{DAILY_REPORT_TEXT}', text)
          .replace('{PREVIOUS_SCORE}', previousScore !== null ? String(previousScore) : 'null');
        systemArr = null;
      }
    } else {
      // レガシー形式: promptをsystemとして使い、textをuserで送る
      systemArr   = [{ type: 'text', text: promptTemplate, cache_control: { type: 'ephemeral' } }];
      userContent = `以下の日報を分析してください:\n\n${text}`;
    }

    const params = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: userContent }],
    };
    if (systemArr) params.system = systemArr;

    const response = await client.messages.create(params);

    const raw  = response.content[0].text.trim();
    const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(json);
  } catch (e) {
    console.error('[analyzer] Error:', e.message);
    return { score: 0.5, label: 'YELLOW', summary: '分析エラー' };
  }
}

module.exports = { analyzeReport };
