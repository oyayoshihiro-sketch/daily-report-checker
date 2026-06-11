const cron = require('node-cron');
const cfg  = require('./config');
const { runCheckForDate, todayJst } = require('./checker');
const { syncChannelMembers } = require('./members');
const { postMorningReport } = require('./reporter');

let _summaryTask;
let _morningReportTask;

function setupScheduler() {
  reloadSummaryCron();
  reloadMorningReportCron();
  // メンバーを6時間ごとに自動同期
  cron.schedule('0 */6 * * *', syncChannelMembers, { timezone: 'Asia/Tokyo' });
}

// JSTの当日から n 日前の日付文字列(YYYY-MM-DD)を返す
function jstDateMinus(days) {
  const t = new Date(Date.now() + 9 * 3600000 - days * 86400000);
  return t.toISOString().slice(0, 10);
}

function reloadSummaryCron() {
  if (_summaryTask) { _summaryTask.stop(); _summaryTask = null; }
  const expr = cfg.get('summary_cron') || '0 23 * * *';
  console.log(`[scheduler] Cron: ${expr} (JST)`);
  // 27時制では「前日」の日報サイクルが当日3:00に締まる。実行時刻に依らず取りこぼさないよう
  // 直近2日（前日＋当日）を毎回再クロールする（upsertなので冪等）。
  _summaryTask = cron.schedule(expr, async () => {
    await runCheckForDate(jstDateMinus(1));
    await runCheckForDate(jstDateMinus(0));
  }, { timezone: 'Asia/Tokyo' });
}

function reloadMorningReportCron() {
  if (_morningReportTask) { _morningReportTask.stop(); _morningReportTask = null; }
  const expr = cfg.get('morning_report_cron') || '0 9 * * 1-5';
  console.log(`[scheduler] Morning Report Cron: ${expr} (JST)`);
  _morningReportTask = cron.schedule(expr, postMorningReport, { timezone: 'Asia/Tokyo' });
}

module.exports = { setupScheduler, reloadSummaryCron, reloadMorningReportCron };
