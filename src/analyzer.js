const Anthropic = require('@anthropic-ai/sdk');
const cfg = require('./config');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function analyzeReport(text) {
  const systemPrompt = cfg.get('sentiment_prompt') || '';
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `以下の日報を分析してください:\n\n${text}`,
        },
      ],
    });

    const raw = response.content[0].text.trim();
    // ```json ... ``` のコードブロックを除去
    const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(json);
  } catch (e) {
    console.error('[analyzer] Error:', e.message);
    return { score: 0.5, label: 'neutral', summary: '分析エラー' };
  }
}

module.exports = { analyzeReport };
