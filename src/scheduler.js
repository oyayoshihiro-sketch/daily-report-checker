const cron = require('node-cron');
const cfg = require('./config');
const { runCheckForDate, todayJst } = require('./checker');
const { syncChannelMembers } = require('./members');

let _task;

function setupScheduler() {
  reloadSummaryCron();
  // メンバーを6時間ごとに自動同期
  cron.schedule('0 */6 * * *', syncChannelMembers, { timezone: 'Asia/Tokyo' });
}

function reloadSummaryCron() {
  if (_task) { _task.stop(); _task = null; }
  const expr = cfg.get('summary_cron') || '0 23 * * *';
  console.log(`[scheduler] Cron: ${expr} (JST)`);
  _task = cron.schedule(expr, () => runCheckForDate(todayJst()), { timezone: 'Asia/Tokyo' });
}

module.exports = { setupScheduler, reloadSummaryCron };
