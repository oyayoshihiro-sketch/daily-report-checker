#!/usr/bin/env node
/**
 * 指定期間の日報を Slack から再クロールして DB に再格納する（冪等）。
 *
 * 使い方:
 *   node scripts/recrawl.js                       # 今月1日〜今日
 *   node scripts/recrawl.js 2026-06-01 2026-06-30 # 範囲指定
 *   node scripts/recrawl.js 2026-06-01 2026-06-30 --check   # 振り返りAI分析も再実行
 *
 * 既定（--check なし）は Slack 取得＋勝敗の再判定のみで、Claude API は呼ばない。
 * 勝率は日報テキストから読み取り時に都度判定されるため、これだけで正しく反映される。
 * --check を付けると振り返りスコア・成長メモ（AI分析）も再生成する。
 */
require('dotenv').config();
const db = require('./../src/db');
const { syncChannelMembers } = require('./../src/members');
const { fetchAndStoreReports, checkMember, todayJst, verdictForDay } = require('./../src/checker');

function jstToday() { return todayJst(); }

function dateRange(from, to) {
  const out = [];
  let d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

function isValidDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }

(async () => {
  const args = process.argv.slice(2);
  const runCheck = args.includes('--check');
  const positional = args.filter(a => !a.startsWith('--'));

  const today = jstToday();
  const from = positional[0] || today.slice(0, 8) + '01';
  const to   = positional[1] || today;

  if (!isValidDate(from) || !isValidDate(to)) {
    console.error('日付は YYYY-MM-DD 形式で指定してください。例: node scripts/recrawl.js 2026-06-01 2026-06-30');
    process.exit(1);
  }

  db.getDb();
  console.log(`\n=== 再クロール ${from} 〜 ${to}${runCheck ? '（+AI振り返り分析）' : '（Slack取得＋勝敗再判定のみ）'} ===\n`);

  console.log('[1/3] メンバー同期...');
  await syncChannelMembers();
  const members = db.getActiveMembers();
  console.log(`  アクティブメンバー: ${members.length}名\n`);

  const dates = dateRange(from, to);
  console.log(`[2/3] 日報を ${dates.length} 日分クロール...`);
  for (const date of dates) {
    await fetchAndStoreReports(date);
    if (runCheck) {
      await Promise.all(members.map(m => checkMember(m, date)));
    }
  }
  console.log('  完了\n');

  // 検証サマリ: 各メンバーの期間内 勝敗/勝率（日報テキストから都度判定）
  console.log('[3/3] 勝率サマリ（再現性チェック）');
  const reports = db.getReportsForDateRange(from, to);
  const byUser = {};
  for (const r of reports) {
    (byUser[r.user_id] ??= {})[r.report_date] ??= {};
    byUser[r.user_id][r.report_date][r.report_type] = r;
  }
  const memberMap = Object.fromEntries(members.map(m => [m.user_id, m]));
  const rows = [];
  for (const uid of Object.keys(byUser)) {
    const m = memberMap[uid];
    if (!m) continue;
    let w = 0, l = 0, posted = 0;
    for (const date of Object.keys(byUser[uid])) {
      const reps = byUser[uid][date];
      posted++;
      const v = verdictForDay({ eveningText: reps.evening?.text, morningText: reps.morning?.text });
      if (v === 'win') w++; else if (v === 'loss') l++;
    }
    const judged = w + l;
    rows.push({ name: m.real_name || m.display_name || uid, w, l, judged, posted, rate: judged ? Math.round(w / judged * 100) : null });
  }
  rows.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.w - a.w);
  for (const r of rows) {
    console.log(`  ${String(r.rate ?? '-').padStart(3)}%  ${r.w}勝${r.l}敗 (母数${r.judged}/投稿${r.posted})  ${r.name}`);
  }
  console.log(`\n対象 ${rows.length}名・日報 ${reports.length}件。完了。`);
  process.exit(0);
})().catch(e => { console.error('recrawl error:', e); process.exit(1); });
