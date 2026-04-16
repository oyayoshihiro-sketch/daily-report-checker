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

  const oldest = new Date(date + 'T00:00:00+09:00').getTime() / 1000;
  const latest = new Date(date + 'T23:59:59+09:00').getTime() / 1000;

  const messages = await getChannelHistory(channelId, oldest, latest);
  console.log(`[checker] Fetched ${messages.length} messages for ${date}`);

  for (const msg of messages) {
    let userId = msg.user;

    if (msg.subtype === 'bot_message') {
      if (!workflowBotId) continue;
      if (msg.bot_id !== workflowBotId) continue;
      if (userIdRegex) {
        const m = msg.text?.match(new RegExp(userIdRegex));
        if (m?.[1]) userId = m[1];
      }
    }

    if (!userId || !msg.text) continue;
    const member = db.getMember(userId);
    if (!member || !member.is_active || member.is_bot) continue;

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
  }
}

async function checkMember(member, date) {
  const report = db.getReport(member.user_id, date);

  if (!report) {
    db.upsertCheck({
      userId: member.user_id, checkDate: date, posted: 0,
      lateNightFlag: 0, sentimentFlag: 0, sentimentScore: null,
      volumeFlag: 0, volumeRatio: null, flagCount: 0,
    });
    return;
  }

  const lateNightFlag = report.posted_hour >= cfg.get('late_night_hour') ? 1 : 0;

  let sentimentFlag = 0, sentimentScore = null;
  try {
    const r = await analyzeReport(report.text);
    sentimentScore = r.score;
    sentimentFlag = r.score < cfg.get('sentiment_threshold') ? 1 : 0;
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

  const flagCount = lateNightFlag + sentimentFlag + volumeFlag;
  db.upsertCheck({
    userId: member.user_id, checkDate: date, posted: 1,
    lateNightFlag, sentimentFlag, sentimentScore,
    volumeFlag, volumeRatio, flagCount,
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
