const db  = require('./db');
const cfg = require('./config');
const { postMessage } = require('./slack');

function todayJst() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function formatDateJa(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = ['日', '月', '火', '水', '木', '金', '土'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}年${m}月${d}日(${dow})`;
}

async function postMorningReport() {
  const channelId = cfg.get('morning_report_channel');
  if (!channelId) {
    console.log('[reporter] morning_report_channel が未設定のためスキップ');
    return;
  }

  const yesterday = addDays(todayJst(), -1);
  const members  = db.getActiveMembers();
  const checks   = db.getChecksForDate(yesterday);
  const checkMap = Object.fromEntries(checks.map(c => [c.user_id, c]));

  const total        = members.length;
  const postedCount  = members.filter(m => checkMap[m.user_id]?.posted).length;
  const morningCount = members.filter(m => checkMap[m.user_id]?.morning_posted).length;
  const eveningCount = members.filter(m => checkMap[m.user_id]?.evening_posted).length;
  const unpostedList = members.filter(m => !checkMap[m.user_id]?.posted);

  const rate      = total > 0 ? Math.round(postedCount / total * 100) : 0;
  const rateEmoji = rate >= 90 ? '🟢' : rate >= 70 ? '🟡' : '🔴';
  const dateLabel = formatDateJa(yesterday);

  // 未投稿者は <@userId> メンション形式で通知が届くようにする
  const unpostedMentions = unpostedList.length === 0
    ? '✅ 全員投稿済み！お疲れ様でした。'
    : unpostedList.map(m => `<@${m.user_id}>`).join('  ');

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📊 日報投稿レポート｜${dateLabel}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `${rateEmoji} *全体投稿率*\n*${postedCount} / ${total} 名 (${rate}%)*` },
        { type: 'mrkdwn', text: `🌅 *朝の日報*\n${morningCount} / ${total} 名` },
        { type: 'mrkdwn', text: `🌙 *夜の日報*\n${eveningCount} / ${total} 名` },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: unpostedList.length === 0
          ? unpostedMentions
          : `:warning: *昨日未投稿のメンバー（${unpostedList.length}名）*\n${unpostedMentions}`,
      },
    },
  ];

  const fallback = `📊 日報投稿レポート ${dateLabel} | ${postedCount}/${total}名 (${rate}%) | 未投稿: ${unpostedList.length}名`;

  try {
    await postMessage(channelId, fallback, blocks);
    console.log(`[reporter] 投稿率レポート送信: ${channelId} (${rate}%, 未投稿${unpostedList.length}名)`);
  } catch (e) {
    console.error('[reporter] Slack送信エラー:', e.message);
  }
}

module.exports = { postMorningReport };
