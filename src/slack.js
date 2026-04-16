const { WebClient } = require('@slack/web-api');

let _client;
function getClient() {
  if (!_client) _client = new WebClient(process.env.SLACK_BOT_TOKEN);
  return _client;
}

async function getChannelMembers(channelId) {
  const ids = [];
  let cursor;
  do {
    const res = await getClient().conversations.members({
      channel: channelId, limit: 200, ...(cursor ? { cursor } : {}),
    });
    ids.push(...res.members);
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return ids;
}

async function getUserInfo(userId) {
  const res = await getClient().users.info({ user: userId });
  return res.user;
}

// JST日付の0:00〜23:59に相当するUNIX秒範囲でメッセージを取得
async function getChannelHistory(channelId, oldest, latest) {
  const msgs = [];
  let cursor;
  do {
    const res = await getClient().conversations.history({
      channel: channelId,
      oldest: String(oldest),
      latest: String(latest),
      inclusive: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    msgs.push(...res.messages);
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return msgs;
}

module.exports = { getChannelMembers, getUserInfo, getChannelHistory };
