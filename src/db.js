const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DATABASE_PATH || './data/checker.db';
const absolutePath = path.resolve(DB_PATH);
fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

let _db;

function getDb() {
  if (!_db) {
    _db = new Database(absolutePath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    initTables();
    seedConfig();
  }
  return _db;
}

function initTables() {
  _db.exec(`
    -- 日報の生データ
    CREATE TABLE IF NOT EXISTS daily_reports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT    NOT NULL,
      report_date TEXT    NOT NULL,  -- YYYY-MM-DD (JST)
      posted_at   TEXT    NOT NULL,  -- ISO8601 UTC
      posted_hour INTEGER NOT NULL,  -- 0-23 (JST)
      text        TEXT    NOT NULL,
      char_count  INTEGER NOT NULL,  -- URL・空白除去後の文字数
      ts          TEXT    NOT NULL UNIQUE,
      channel_id  TEXT    NOT NULL,
      UNIQUE(user_id, report_date)
    );

    -- 3軸チェック結果
    CREATE TABLE IF NOT EXISTS condition_checks (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             TEXT    NOT NULL,
      check_date          TEXT    NOT NULL,
      posted              INTEGER NOT NULL DEFAULT 0,
      late_night_flag     INTEGER NOT NULL DEFAULT 0,
      sentiment_flag      INTEGER NOT NULL DEFAULT 0,
      sentiment_score     REAL,                    -- 0.0〜1.0（低=ネガ）
      volume_flag         INTEGER NOT NULL DEFAULT 0,
      volume_ratio        REAL,                    -- 今日/過去平均（1.0=同量）
      flag_count          INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, check_date)
    );

    -- チャンネルメンバーキャッシュ
    CREATE TABLE IF NOT EXISTS members (
      user_id      TEXT    PRIMARY KEY,
      display_name TEXT,
      real_name    TEXT,
      group_id     INTEGER REFERENCES groups(id),
      is_active    INTEGER NOT NULL DEFAULT 1,  -- 0=監視対象外
      is_bot       INTEGER NOT NULL DEFAULT 0,
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- グループ（2階層: parent_id=NULLがトップ）
    CREATE TABLE IF NOT EXISTS groups (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE,
      parent_id  INTEGER REFERENCES groups(id),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 管理者チャンネル（複数設定可）
    CREATE TABLE IF NOT EXISTS admin_channels (
      channel_id TEXT    NOT NULL PRIMARY KEY,
      label      TEXT,
      added_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 設定値（キーバリュー）
    CREATE TABLE IF NOT EXISTS config (
      key        TEXT    NOT NULL PRIMARY KEY,
      value      TEXT    NOT NULL,
      description TEXT,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ダッシュボードユーザー
    CREATE TABLE IF NOT EXISTS dashboard_users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL DEFAULT 'viewer', -- 'admin' | 'viewer'
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

const DEFAULT_CONFIG = [
  { key: 'late_night_hour',         value: '22',          description: '深夜フラグの閾値（この時間以降=深夜, 0-23 JST）' },
  { key: 'sentiment_threshold',     value: '0.35',        description: '感情スコアの下限（これ未満でフラグ, 0.0-1.0）' },
  { key: 'volume_lookback_days',    value: '14',          description: '文量比較に使う過去日数' },
  { key: 'volume_change_pct',       value: '50',          description: '文量変化率の閾値（%, 例: 50 = ±50%以上でフラグ）' },
  { key: 'volume_min_samples',      value: '3',           description: '文量チェックに必要な最低データ件数（不足時はスキップ）' },
  { key: 'summary_cron',            value: '0 4 * * *',   description: 'サマリー実行のcron式（JST）' },
  { key: 'report_channel_id',       value: 'C056L3ZQLKD', description: '日報チャンネルID' },
  { key: 'workflow_bot_id',         value: '',            description: 'ワークフローBotのID（空=全ユーザーメッセージを収集）' },
  { key: 'user_id_regex',           value: '<@(U[A-Z0-9]+)>', description: '投稿者IDをテキストから抽出するregex（グループ1がuser_id）' },
];

function seedConfig() {
  const stmt = _db.prepare('INSERT OR IGNORE INTO config (key, value, description) VALUES (?, ?, ?)');
  for (const c of DEFAULT_CONFIG) {
    stmt.run(c.key, c.value, c.description);
  }
}

// ── daily_reports ────────────────────────────────────────────────────────────

function upsertReport({ userId, reportDate, postedAt, postedHour, text, charCount, ts, channelId }) {
  return getDb().prepare(`
    INSERT INTO daily_reports (user_id, report_date, posted_at, posted_hour, text, char_count, ts, channel_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, report_date) DO UPDATE SET
      posted_at  = excluded.posted_at,
      posted_hour = excluded.posted_hour,
      text       = excluded.text,
      char_count = excluded.char_count,
      ts         = excluded.ts
  `).run(userId, reportDate, postedAt, postedHour, text, charCount, ts, channelId);
}

function getReport(userId, date) {
  return getDb().prepare('SELECT * FROM daily_reports WHERE user_id = ? AND report_date = ?').get(userId, date);
}

function getRecentReports(userId, limit) {
  return getDb().prepare(
    'SELECT * FROM daily_reports WHERE user_id = ? ORDER BY report_date DESC LIMIT ?'
  ).all(userId, limit);
}

// ── condition_checks ─────────────────────────────────────────────────────────

function upsertCheck(data) {
  return getDb().prepare(`
    INSERT INTO condition_checks
      (user_id, check_date, posted, late_night_flag, sentiment_flag, sentiment_score,
       volume_flag, volume_ratio, flag_count)
    VALUES
      (@userId, @checkDate, @posted, @lateNightFlag, @sentimentFlag, @sentimentScore,
       @volumeFlag, @volumeRatio, @flagCount)
    ON CONFLICT(user_id, check_date) DO UPDATE SET
      posted         = excluded.posted,
      late_night_flag = excluded.late_night_flag,
      sentiment_flag = excluded.sentiment_flag,
      sentiment_score = excluded.sentiment_score,
      volume_flag    = excluded.volume_flag,
      volume_ratio   = excluded.volume_ratio,
      flag_count     = excluded.flag_count,
      created_at     = datetime('now')
  `).run(data);
}

function getChecksForDate(date) {
  return getDb().prepare('SELECT * FROM condition_checks WHERE check_date = ?').all(date);
}

// ── members ──────────────────────────────────────────────────────────────────

function upsertMember({ userId, displayName, realName, isBot }) {
  return getDb().prepare(`
    INSERT INTO members (user_id, display_name, real_name, is_bot, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      display_name = excluded.display_name,
      real_name    = excluded.real_name,
      is_bot       = excluded.is_bot,
      updated_at   = datetime('now')
  `).run(userId, displayName || null, realName || null, isBot ? 1 : 0);
}

function getMember(userId) {
  return getDb().prepare('SELECT * FROM members WHERE user_id = ?').get(userId);
}

function getActiveMembers() {
  return getDb().prepare(
    'SELECT m.*, g.name as group_name, g.parent_id FROM members m LEFT JOIN groups g ON m.group_id = g.id WHERE m.is_active = 1 AND m.is_bot = 0 ORDER BY m.display_name'
  ).all();
}

function setMemberActive(userId, isActive) {
  return getDb().prepare("UPDATE members SET is_active = ?, updated_at = datetime('now') WHERE user_id = ?").run(isActive ? 1 : 0, userId);
}

function setMemberGroup(userId, groupId) {
  return getDb().prepare("UPDATE members SET group_id = ?, updated_at = datetime('now') WHERE user_id = ?").run(groupId, userId);
}

// ── groups ───────────────────────────────────────────────────────────────────

function createGroup(name, parentId, sortOrder = 0) {
  return getDb().prepare(
    'INSERT INTO groups (name, parent_id, sort_order) VALUES (?, ?, ?)'
  ).run(name, parentId || null, sortOrder);
}

function getGroup(nameOrId) {
  const db = getDb();
  if (typeof nameOrId === 'number' || /^\d+$/.test(String(nameOrId))) {
    return db.prepare('SELECT * FROM groups WHERE id = ?').get(Number(nameOrId));
  }
  return db.prepare('SELECT * FROM groups WHERE name = ?').get(nameOrId);
}

function getAllGroups() {
  return getDb().prepare('SELECT * FROM groups ORDER BY parent_id IS NOT NULL, sort_order, name').all();
}

function getTopGroups() {
  return getDb().prepare('SELECT * FROM groups WHERE parent_id IS NULL ORDER BY sort_order, name').all();
}

function getChildGroups(parentId) {
  return getDb().prepare('SELECT * FROM groups WHERE parent_id = ? ORDER BY sort_order, name').all(parentId);
}

function deleteGroup(id) {
  const db = getDb();
  // 子グループの親を解除
  db.prepare('UPDATE groups SET parent_id = NULL WHERE parent_id = ?').run(id);
  // メンバーのグループを解除
  db.prepare('UPDATE members SET group_id = NULL WHERE group_id = ?').run(id);
  return db.prepare('DELETE FROM groups WHERE id = ?').run(id);
}

// ── admin_channels ───────────────────────────────────────────────────────────

function addAdminChannel(channelId, label) {
  return getDb().prepare('INSERT OR IGNORE INTO admin_channels (channel_id, label) VALUES (?, ?)').run(channelId, label || null);
}

function removeAdminChannel(channelId) {
  return getDb().prepare('DELETE FROM admin_channels WHERE channel_id = ?').run(channelId);
}

function getAdminChannels() {
  return getDb().prepare('SELECT * FROM admin_channels ORDER BY added_at').all();
}

// ── config ───────────────────────────────────────────────────────────────────

function getConfigRaw(key) {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setConfigRaw(key, value) {
  return getDb().prepare(`
    INSERT INTO config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value));
}

function getAllConfigRows() {
  return getDb().prepare('SELECT * FROM config ORDER BY key').all();
}

// 週次ビュー用: 日付範囲の日報を一括取得
function getReportsForDateRange(startDate, endDate) {
  return getDb().prepare(
    'SELECT * FROM daily_reports WHERE report_date >= ? AND report_date <= ? ORDER BY report_date, user_id'
  ).all(startDate, endDate);
}

// 週次ビュー用: 日付範囲のチェック結果を一括取得
function getChecksForDateRange(startDate, endDate) {
  return getDb().prepare(
    'SELECT * FROM condition_checks WHERE check_date >= ? AND check_date <= ? ORDER BY check_date, user_id'
  ).all(startDate, endDate);
}

// メンバー管理ビュー用: ボット以外の全メンバー（非監視も含む）
function getAllMembersRaw() {
  return getDb().prepare(
    'SELECT m.*, g.name as group_name, g.parent_id as group_parent_id FROM members m LEFT JOIN groups g ON m.group_id = g.id WHERE m.is_bot = 0 ORDER BY m.is_active DESC, m.display_name'
  ).all();
}

// ── dashboard_users ──────────────────────────────────────────────────────────

function getDashboardUser(username) {
  return getDb().prepare('SELECT * FROM dashboard_users WHERE username = ?').get(username);
}

function getDashboardUserById(id) {
  return getDb().prepare('SELECT * FROM dashboard_users WHERE id = ?').get(id);
}

function getAllDashboardUsers() {
  return getDb().prepare('SELECT id, username, role, created_at FROM dashboard_users ORDER BY created_at').all();
}

function createDashboardUser(username, passwordHash, role) {
  return getDb().prepare('INSERT INTO dashboard_users (username, password_hash, role) VALUES (?, ?, ?)').run(username, passwordHash, role);
}

function updateDashboardUser(id, { role, passwordHash }) {
  if (role !== undefined && passwordHash !== undefined) {
    return getDb().prepare('UPDATE dashboard_users SET role = ?, password_hash = ? WHERE id = ?').run(role, passwordHash, id);
  }
  if (role !== undefined) {
    return getDb().prepare('UPDATE dashboard_users SET role = ? WHERE id = ?').run(role, id);
  }
  if (passwordHash !== undefined) {
    return getDb().prepare('UPDATE dashboard_users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  }
}

function deleteDashboardUser(id) {
  return getDb().prepare('DELETE FROM dashboard_users WHERE id = ?').run(id);
}

function countAdminUsers() {
  return getDb().prepare("SELECT COUNT(*) as cnt FROM dashboard_users WHERE role = 'admin'").get().cnt;
}

module.exports = {
  getDb,
  upsertReport, getReport, getRecentReports, getReportsForDateRange,
  upsertCheck, getChecksForDate, getChecksForDateRange,
  upsertMember, getMember, getActiveMembers, getAllMembersRaw, setMemberActive, setMemberGroup,
  createGroup, getGroup, getAllGroups, getTopGroups, getChildGroups, deleteGroup,
  addAdminChannel, removeAdminChannel, getAdminChannels,
  getConfigRaw, setConfigRaw, getAllConfigRows,
  getDashboardUser, getDashboardUserById, getAllDashboardUsers,
  createDashboardUser, updateDashboardUser, deleteDashboardUser, countAdminUsers,
};
