const db = require('./db');
const cfg = require('./config');
const { getChannelMembers, getUserInfo } = require('./slack');

async function syncChannelMembers() {
  const channelId = cfg.get('report_channel_id');
  console.log(`[members] Syncing from channel ${channelId}`);
  try {
    const userIds = await getChannelMembers(channelId);
    let synced = 0;
    for (const userId of userIds) {
      try {
        const user = await getUserInfo(userId);
        if (user.deleted) continue;
        db.upsertMember({
          userId: user.id,
          displayName: user.profile?.display_name_normalized || user.profile?.display_name || user.name,
          realName: user.profile?.real_name || user.real_name,
          isBot: user.is_bot || user.id === 'USLACKBOT',
        });
        synced++;
      } catch (e) {
        console.error(`[members] users.info error ${userId}:`, e.message);
      }
    }
    console.log(`[members] Synced ${synced}/${userIds.length}`);
  } catch (e) {
    console.error('[members] sync error:', e);
  }
}

function displayName(userId) {
  const m = db.getMember(userId);
  return m?.display_name || m?.real_name || userId;
}

module.exports = { syncChannelMembers, displayName };
