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
      email         TEXT    NOT NULL UNIQUE,
      password_hash TEXT,   -- NULL = 招待承認待ち
      role          TEXT    NOT NULL DEFAULT 'viewer',
      display_name  TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 招待トークン
    CREATE TABLE IF NOT EXISTS invitations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      email       TEXT    NOT NULL,
      role        TEXT    NOT NULL DEFAULT 'viewer',
      token       TEXT    NOT NULL UNIQUE,
      invited_by  TEXT,
      expires_at  TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // condition_checks に signal / sentiment_summary / late_post_flag 列を追加（マイグレーション）
  try {
    const ccCols = _db.prepare('PRAGMA table_info(condition_checks)').all().map(c => c.name);
    if (!ccCols.includes('signal'))            _db.exec("ALTER TABLE condition_checks ADD COLUMN signal TEXT");
    if (!ccCols.includes('sentiment_summary')) _db.exec("ALTER TABLE condition_checks ADD COLUMN sentiment_summary TEXT");
    if (!ccCols.includes('late_post_flag'))    _db.exec("ALTER TABLE condition_checks ADD COLUMN late_post_flag INTEGER NOT NULL DEFAULT 0");
  } catch (e) {
    console.error('[db] condition_checks migration error:', e.message);
  }

  // 旧スキーマ（username列）からの移行
  try {
    const cols = _db.prepare('PRAGMA table_info(dashboard_users)').all().map(c => c.name);
    if (cols.includes('username') && !cols.includes('email')) {
      _db.exec(`
        CREATE TABLE dashboard_users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT,
          role TEXT NOT NULL DEFAULT 'viewer',
          display_name TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO dashboard_users_new (id, email, password_hash, role, created_at)
          SELECT id, username, password_hash, role, created_at FROM dashboard_users;
        DROP TABLE dashboard_users;
        ALTER TABLE dashboard_users_new RENAME TO dashboard_users;
      `);
    }
  } catch (e) {
    console.error('[db] migration error:', e.message);
  }
}

const SENTIMENT_PROMPT_DEFAULT = `## ロール
あなたは日本の職場における感情分析の専門家です。
日報テキストを読み、メンバーのコンディションスコアを算出してください。

---

## スコアの定義

コンディションスコアは 0.00〜1.00 の連続値です。

  1.00 = 強いポジティブ（エネルギーに満ち、充実している）
  0.00 = 強いネガティブ（疲弊・消耗・危機的状態）

スコアは必ず以下の5段階のいずれかの帯域に収まるよう算出してください。

  0.80〜1.00  GREEN    良好
  0.60〜0.79  YELLOW   やや注意
  0.40〜0.59  ORANGE   要観察
  0.20〜0.39  RED      要対応
  0.00〜0.19  CRITICAL 緊急対応

---

## スコア帯域のアンカー定義（必ず参照すること）

以下は各帯域の「典型的な日報の特徴」です。
採点前にここを読み、日報がどの帯域に近いかを先に判断してから数値を決めてください。

【GREEN 0.80〜1.00】
- 成果・進捗が具体的な数値・固有名詞つきで記述されている
- 感謝・協力者への言及が自然に含まれている
- 明日の計画が具体的かつ能動的
- 文章にエネルギーと手応えが感じられる
- 課題があっても「こう解決する」という能動的記述がある
- 例）「田中さんと一緒に提案を詰められ、先方の反応も良かった。明日は資料を仕上げてFBをもらう予定。」

【YELLOW 0.60〜0.79】
- 成果はあるが記述がやや淡白・形式的
- 「一応」「ひとまず」等の薄い達成感が1〜2個混在
- 課題の記述はあるが、解決策が「調整します」程度
- 文章量は普通だが、感情の起伏が感じられない
- 例）「商談3件対応しました。資料も一通り完成しています。明日は続きをやります。」

【ORANGE 0.40〜0.59】
- 「なんとか」「ひとまず」「一応」が複数回登場
- 先送り・持ち越しの記述が含まれる
- 「問題ありません」「大丈夫です」の過剰使用（強がりサイン）
- 明日の予定が「引き続き対応」「検討中」等の曖昧表現
- 文章が短くなり始め、具体性が薄れている
- 例）「なんとか商談3件こなしました。資料も一応完成。少し悩んでいることがあります。引き続き頑張ります。」

【RED 0.20〜0.39】
- 失敗・遅延の報告がある
- 「問題ありません」「大丈夫です」の後に内容が続かない（空洞の強がり）
- 「…」「持ち越し」「来週以降」が複数登場
- 明日の予定が「頑張ります」のみ
- 体調・疲労への言及がある
- 人物名・感謝表現が消えている
- 例）「商談はうまくいきませんでした。資料は来週以降になります。問題ありません。頑張ります。」

【CRITICAL 0.00〜0.19】
- 文章が極端に短い（3〜5行以下）
- 謝罪・自己否定が含まれる
- 体調不良・疲弊の直接言及
- 将来への言及がほぼ「やっていきます」のみ
- 業務の具体的記述がほぼ消失
- 例）「商談しました。資料、間に合いませんでした。申し訳ありません。体が重いです。やっていきます。」

---

## 採点手順（必ずこの順番で実行すること）

### STEP 1: 帯域判定
上記アンカーを参照し、この日報はどの帯域（GREEN/YELLOW/ORANGE/RED/CRITICAL）に最も近いかを先に決める。

### STEP 2: 7軸サブスコア算出
各軸を 0.00〜1.00 で採点する（高い＝ポジティブ）。

  軸1 直接的ポジティブ表現    (重み 15%)
      - ポジティブ感情語・達成感の表現が豊富なら高い
      - ネガティブ感情語・失敗報告が多いなら低い

  軸2 自然な達成感・充実感    (重み 20%)  ★最重要★
      - 「なんとか」「一応」「ひとまず」「とりあえず」の使用回数が多いほど低くなる
      - 「問題ありません」「大丈夫です」の過剰使用は強がりサインで低くなる
      - 「できました！」「うまくいきました」等の素直な達成感は高くなる
      - 受動態多用（〜させられた、〜になってしまった）は低くなる

  軸3 文末・語尾の活力        (重み 15%)
      - 「…」「〜」の多用で低くなる
      - 文章量が普段より極端に少ない場合は低くなる
      - 具体的で能動的な文末表現は高くなる

  軸4 業務記述の具体性        (重み 20%)  ★最重要★
      - 固有名詞（人名・社名・サービス名）が豊富なら高い
      - 数値（件数・金額・時間）が含まれるなら高い
      - 「対応しました」「やりました」だけの抽象表現は低くなる
      - 「持ち越し」「来週以降」「調整中」の登場回数が多いほど低くなる

  軸5 対人関係の豊かさ        (重み 10%)
      - 感謝・協力者への言及があれば高い
      - 人物名が全く登場しない場合は低くなる
      - 「認識の齟齬」「調整が発生」等の摩擦表現で低くなる

  軸6 体調・エネルギー        (重み 10%)
      - 体調不良・疲弊への言及があれば大きく低くなる
      - 「集中できなかった」「頭が回らない」も低くなる
      - 言及がなければ中間（0.50）をベースに他要素で調整

  軸7 将来への意欲            (重み 10%)
      - 明日の予定が具体的で能動的なら高い
      - 「頑張ります」「やっていきます」のみなら低い
      - 「未定」「調整中」が多い場合は低くなる

### STEP 3: 重み付き平均でスコア算出
score = 軸1×0.15 + 軸2×0.20 + 軸3×0.15 + 軸4×0.20 + 軸5×0.10 + 軸6×0.10 + 軸7×0.10

### STEP 4: 帯域との整合チェック
STEP1で判定した帯域とSTEP3のスコアが一致しているか確認する。
ズレている場合は、どちらが正しいかを再判断してスコアを調整する。
※ LLMは中間値（0.45〜0.55）に寄りがちなので、GREENまたはCRITICALの特徴が明確なら
  迷わず端の帯域を選ぶこと。

---

## キャリブレーション注意事項

1. 「真ん中に逃げない」
   特徴が明確な日報に 0.45〜0.55 を付けるのは誤り。
   CRITICALの特徴があれば 0.10〜0.15、GREENの特徴があれば 0.85〜0.95 を付ける。

2. 「ポジティブ偽装を見抜く」
   「問題ありません！大丈夫です！頑張ります！」
   → これはGREENではなくREDまたはCRITICALのサイン。

3. 「不在も検出する」
   人物名・感謝・具体的数値が消えていること自体がネガティブシグナル。

4. 「矮小化表現に敏感になる」
   「少し」「ちょっと」は日本語では「かなり」の意味を持つことが多い。
   「少し悩んでいます」→ 実際は深刻に悩んでいる可能性が高い。

5. 「文章量の絶対値より変化を重視する」
   普段長い人が急に短くなった場合にスコアを下げる。
   （前回スコアが提供されている場合は必ず参照すること）

---

## 入力

日報テキスト:
{DAILY_REPORT_TEXT}

前回スコア（参考）: {PREVIOUS_SCORE}  ※初回または不明の場合は null

---

## 出力フォーマット

JSONのみ返すこと。前置き・説明・コードブロック記号（\`\`\`）は一切不要。

{
  "score": 0.00,
  "label": "GREEN",
  "summary": "100字以内。断定せず観察として記述。繁忙期等のコンテキストがあれば加味する。"
}

labelの値は GREEN / YELLOW / ORANGE / RED / CRITICAL のいずれか。`;

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
  { key: 'sentiment_prompt', value: SENTIMENT_PROMPT_DEFAULT, description: 'Claude に送る感情分析プロンプト（自由に編集可）' },
];

function seedConfig() {
  const stmt = _db.prepare('INSERT OR IGNORE INTO config (key, value, description) VALUES (?, ?, ?)');
  for (const c of DEFAULT_CONFIG) {
    stmt.run(c.key, c.value, c.description);
  }
  // 旧プロンプト（{DAILY_REPORT_TEXT} を含まない、または "summary" フィールドがない）を新デフォルトに自動アップグレード
  const cur = _db.prepare("SELECT value FROM config WHERE key = 'sentiment_prompt'").get();
  if (cur && (!cur.value.includes('{DAILY_REPORT_TEXT}') || !cur.value.includes('"summary"'))) {
    _db.prepare("UPDATE config SET value = ? WHERE key = 'sentiment_prompt'").run(SENTIMENT_PROMPT_DEFAULT);
    console.log('[db] sentiment_prompt を新デフォルトにアップグレードしました（summary フィールド追加）');
  }
}

// ── daily_reports ────────────────────────────────────────────────────────────

function upsertReport({ userId, reportDate, postedAt, postedHour, text, charCount, ts, channelId }) {
  const db = getDb();
  // 同じtsが別の report_date で保存されている場合は削除（27時制による日付訂正）
  const existing = db.prepare('SELECT report_date FROM daily_reports WHERE ts = ?').get(ts);
  if (existing && existing.report_date !== reportDate) {
    console.log(`[db] 日付訂正: ts=${ts} を ${existing.report_date} → ${reportDate} に移動`);
    db.prepare('DELETE FROM daily_reports WHERE ts = ?').run(ts);
  }
  return db.prepare(`
    INSERT INTO daily_reports (user_id, report_date, posted_at, posted_hour, text, char_count, ts, channel_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, report_date) DO UPDATE SET
      posted_at   = excluded.posted_at,
      posted_hour = excluded.posted_hour,
      text        = excluded.text,
      char_count  = excluded.char_count,
      ts          = excluded.ts
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
      (user_id, check_date, posted, late_night_flag, late_post_flag, sentiment_flag, sentiment_score,
       volume_flag, volume_ratio, flag_count, signal, sentiment_summary)
    VALUES
      (@userId, @checkDate, @posted, @lateNightFlag, @latePostFlag, @sentimentFlag, @sentimentScore,
       @volumeFlag, @volumeRatio, @flagCount, @signal, @sentimentSummary)
    ON CONFLICT(user_id, check_date) DO UPDATE SET
      posted             = excluded.posted,
      late_night_flag    = excluded.late_night_flag,
      late_post_flag     = excluded.late_post_flag,
      sentiment_flag     = excluded.sentiment_flag,
      sentiment_score    = excluded.sentiment_score,
      volume_flag        = excluded.volume_flag,
      volume_ratio       = excluded.volume_ratio,
      flag_count         = excluded.flag_count,
      signal             = excluded.signal,
      sentiment_summary  = excluded.sentiment_summary,
      created_at         = datetime('now')
  `).run(data);
}

function getChecksForDate(date) {
  return getDb().prepare('SELECT * FROM condition_checks WHERE check_date = ?').all(date);
}

function getLatestCheck(userId) {
  return getDb().prepare(
    'SELECT * FROM condition_checks WHERE user_id = ? AND posted = 1 ORDER BY check_date DESC LIMIT 1'
  ).get(userId);
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

function getDashboardUser(email) {
  return getDb().prepare('SELECT * FROM dashboard_users WHERE email = ?').get(email);
}

function getDashboardUserById(id) {
  return getDb().prepare('SELECT * FROM dashboard_users WHERE id = ?').get(id);
}

function getAllDashboardUsers() {
  return getDb().prepare('SELECT id, email, display_name, role, created_at FROM dashboard_users ORDER BY created_at').all();
}

function createDashboardUser(email, passwordHash, role, displayName) {
  return getDb().prepare('INSERT INTO dashboard_users (email, password_hash, role, display_name) VALUES (?, ?, ?, ?)').run(email, passwordHash || null, role, displayName || null);
}

function updateDashboardUser(id, { role, passwordHash, displayName }) {
  const db = getDb();
  if (role !== undefined) db.prepare('UPDATE dashboard_users SET role = ? WHERE id = ?').run(role, id);
  if (passwordHash !== undefined) db.prepare('UPDATE dashboard_users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  if (displayName !== undefined) db.prepare('UPDATE dashboard_users SET display_name = ? WHERE id = ?').run(displayName, id);
}

function deleteDashboardUser(id) {
  return getDb().prepare('DELETE FROM dashboard_users WHERE id = ?').run(id);
}

function countAdminUsers() {
  return getDb().prepare("SELECT COUNT(*) as cnt FROM dashboard_users WHERE role = 'admin'").get().cnt;
}

// ── invitations ──────────────────────────────────────────────────────────────

function createInvitation(email, role, token, invitedBy, expiresAt) {
  return getDb().prepare(
    'INSERT OR REPLACE INTO invitations (email, role, token, invited_by, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(email, role, token, invitedBy || null, expiresAt);
}

function getInvitationByToken(token) {
  return getDb().prepare('SELECT * FROM invitations WHERE token = ?').get(token);
}

function getAllInvitations() {
  return getDb().prepare('SELECT * FROM invitations ORDER BY created_at DESC').all();
}

function deleteInvitation(id) {
  return getDb().prepare('DELETE FROM invitations WHERE id = ?').run(id);
}

function deleteInvitationByEmail(email) {
  return getDb().prepare('DELETE FROM invitations WHERE email = ?').run(email);
}

module.exports = {
  getDb,
  upsertReport, getReport, getRecentReports, getReportsForDateRange,
  upsertCheck, getChecksForDate, getChecksForDateRange, getLatestCheck,
  upsertMember, getMember, getActiveMembers, getAllMembersRaw, setMemberActive, setMemberGroup,
  createGroup, getGroup, getAllGroups, getTopGroups, getChildGroups, deleteGroup,
  addAdminChannel, removeAdminChannel, getAdminChannels,
  getConfigRaw, setConfigRaw, getAllConfigRows,
  getDashboardUser, getDashboardUserById, getAllDashboardUsers,
  createDashboardUser, updateDashboardUser, deleteDashboardUser, countAdminUsers,
  createInvitation, getInvitationByToken, getAllInvitations, deleteInvitation, deleteInvitationByEmail,
};
