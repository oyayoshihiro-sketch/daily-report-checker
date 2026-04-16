const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// キャッシュ対象のシステムプロンプト（全メンバーで共通）
const SYSTEM_PROMPT = `あなたは日報の感情分析を行うアシスタントです。
日報テキストを読み、メンバーのコンディションを評価してください。

## 出力形式
必ず以下のJSONのみを返してください。説明文は不要です。
{
  "score": <0.0〜1.0の数値。0.0=非常にネガティブ、0.5=中立、1.0=非常にポジティブ>,
  "label": <"negative" | "neutral" | "positive">,
  "summary": <1〜2文の日本語サマリー。懸念点があれば含める>
}

## スコアの目安
- 0.0〜0.25: 強いネガティブ（疲弊・強いストレス・諦め・孤立感）
- 0.25〜0.45: ネガティブ（困難・課題感・不安が前面に出ている）
- 0.45〜0.65: 中立（事実報告が中心、感情表現は少ない）
- 0.65〜0.85: ポジティブ（成果・達成感・意欲的）
- 0.85〜1.0: 強いポジティブ（高い達成感・チームへの貢献実感）

## 注意事項
- 仕事上の「困難な課題」「タフな交渉」などは文脈で判断する
- 「疲れた」単体より「疲れて限界」「もう無理」など強度を重視する
- 敬語・丁寧語が多い日本語ビジネス文書の特性を考慮する
- JSONのみ返すこと`;

async function analyzeReport(text) {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
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
