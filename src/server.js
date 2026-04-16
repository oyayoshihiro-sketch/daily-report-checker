const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const cfg = require('./config');
const { runCheckForDate, todayJst } = require('./checker');
const { syncChannelMembers } = require('./members');
const { reloadSummaryCron } = require('./scheduler');

// ── パスワードハッシュ ────────────────────────────────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const buf = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(buf, Buffer.from(hash, 'hex'));
  } catch { return false; }
}

// ── 初期管理者シード（環境変数 → DB） ────────────────────────────────────────

function seedInitialAdmin() {
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASS;
  if (!user || !pass) return;
  if (db.getAllDashboardUsers().length > 0) return; // 既にユーザーがいれば何もしない
  db.createDashboardUser(user, hashPassword(pass), 'admin');
  console.log(`[auth] Initial admin created: ${user}`);
}

// ── 認証ミドルウェア ──────────────────────────────────────────────────────────

function basicAuth(req, res, next) {
  const users = db.getAllDashboardUsers();
  if (users.length === 0) { req.role = 'admin'; return next(); } // ユーザー未設定時はスルー

  const auth = req.headers.authorization;
  if (auth?.startsWith('Basic ')) {
    // パスワードに':'が含まれる場合も正しく処理
    const decoded  = Buffer.from(auth.slice(6), 'base64').toString();
    const colonIdx = decoded.indexOf(':');
    const u = decoded.slice(0, colonIdx);
    const p = decoded.slice(colonIdx + 1);

    // DB認証
    const user = db.getDashboardUser(u);
    if (user && verifyPassword(p, user.password_hash)) {
      req.role = user.role;
      req.authUser = { id: user.id, username: user.username, role: user.role };
      return next();
    }

    // 環境変数フォールバック（緊急ログイン用）
    const adminUser = process.env.DASHBOARD_USER;
    const adminPass = process.env.DASHBOARD_PASS;
    if (adminUser && adminPass && u === adminUser && p === adminPass) {
      req.role = 'admin';
      req.authUser = { id: 0, username: adminUser, role: 'admin' };
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="日報チェッカー"');
  res.status(401).send('認証が必要です');
}

function requireAdmin(req, res, next) {
  if (req.role !== 'admin') return res.status(403).json({ error: '管理者権限が必要です' });
  next();
}

function createServer() {
  seedInitialAdmin();

  const server = express();
  server.use(basicAuth);
  server.use(express.json());
  server.use(express.static(path.join(__dirname, '..', 'public')));

  // ── 自分の情報 ───────────────────────────────────────────────────────────
  server.get('/api/me', (req, res) => {
    res.json({ role: req.role || 'admin', username: req.authUser?.username });
  });

  // ── Dashboard ────────────────────────────────────────────────────────────
  server.get('/api/dashboard', (req, res) => {
    try {
      const date = req.query.date || todayJst();
      const allGroups = db.getAllGroups();
      const allMembers = db.getActiveMembers();
      const checks = db.getChecksForDate(date);
      const checkMap = Object.fromEntries(checks.map(c => [c.user_id, c]));
      const groupMap = Object.fromEntries(allGroups.map(g => [g.id, g]));

      const enriched = allMembers.map(member => {
        const check = checkMap[member.user_id] || null;
        const report = check?.posted ? db.getReport(member.user_id, date) : null;

        let group = null;
        if (member.group_id && groupMap[member.group_id]) {
          const g = groupMap[member.group_id];
          const parent = g.parent_id ? groupMap[g.parent_id] : null;
          group = { id: g.id, name: g.name, parent: parent ? { id: parent.id, name: parent.name } : null };
        }

        return {
          user: { user_id: member.user_id, display_name: member.display_name, real_name: member.real_name, group },
          check: check ? {
            posted: check.posted, flag_count: check.flag_count,
            late_night_flag: check.late_night_flag, sentiment_flag: check.sentiment_flag,
            sentiment_score: check.sentiment_score, volume_flag: check.volume_flag,
            volume_ratio: check.volume_ratio, posted_at: check.posted_at,
          } : null,
          report: report ? { char_count: report.char_count } : null,
        };
      });

      const posted = enriched.filter(m => m.check?.posted).length;
      const missing = enriched.length - posted;
      const flagged = enriched.filter(m => (m.check?.flag_count ?? 0) > 0).length;
      const critical = enriched.filter(m => (m.check?.flag_count ?? 0) >= 3).length;

      const topGroups = allGroups.filter(g => !g.parent_id);
      const groupTree = topGroups.map(top => {
        const children = allGroups.filter(g => g.parent_id === top.id).map(child => ({
          id: child.id, name: child.name,
          members: enriched.filter(m => m.user.group?.id === child.id),
        }));
        return {
          id: top.id, name: top.name, children,
          direct_members: enriched.filter(m => m.user.group?.id === top.id),
        };
      });

      const ungrouped = enriched.filter(m => !m.user.group);

      res.json({
        date,
        config: {
          late_night_hour: cfg.get('late_night_hour'),
          sentiment_threshold: cfg.get('sentiment_threshold'),
          volume_change_pct: cfg.get('volume_change_pct'),
          volume_lookback_days: cfg.get('volume_lookback_days'),
          summary_cron: cfg.get('summary_cron'),
        },
        stats: { total: enriched.length, posted, missing, flagged, critical },
        members: enriched,
        group_tree: groupTree,
        ungrouped,
      });
    } catch (e) {
      console.error('/api/dashboard error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Check ────────────────────────────────────────────────────────────────
  server.post('/api/check/run', requireAdmin, async (req, res) => {
    const date = req.body?.date || todayJst();
    try {
      const results = await runCheckForDate(date);
      res.json({ ok: true, date, count: results.length });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Config ───────────────────────────────────────────────────────────────
  server.get('/api/config', (req, res) => {
    res.json(db.getAllConfigRows());
  });

  server.patch('/api/config/:key', requireAdmin, (req, res) => {
    const { key } = req.params;
    const { value } = req.body;
    try {
      cfg.set(key, value);
      if (key === 'summary_cron') reloadSummaryCron();
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // ── Weekly ───────────────────────────────────────────────────────────────
  server.get('/api/weekly', (req, res) => {
    try {
      const date   = req.query.date || todayJst();
      const today  = todayJst();
      const days   = weekDays(date);
      const allGroups  = db.getAllGroups();
      const allMembers = db.getActiveMembers();
      const groupMap   = Object.fromEntries(allGroups.map(g => [g.id, g]));

      const reports = db.getReportsForDateRange(days[0], days[6]);
      const checks  = db.getChecksForDateRange(days[0], days[6]);

      const rMap = {};
      for (const r of reports) rMap[`${r.user_id}:${r.report_date}`] = r;
      const cMap = {};
      for (const c of checks)  cMap[`${c.user_id}:${c.check_date}`]  = c;

      const enriched = allMembers.map(member => {
        let group = null;
        if (member.group_id && groupMap[member.group_id]) {
          const g = groupMap[member.group_id];
          const parent = g.parent_id ? groupMap[g.parent_id] : null;
          group = { id: g.id, name: g.name, parent: parent ? { id: parent.id, name: parent.name } : null };
        }

        const dayData = {};
        for (const day of days) {
          const report = rMap[`${member.user_id}:${day}`] || null;
          const check  = cMap[`${member.user_id}:${day}`] || null;
          const posted = !!(report || check?.posted);
          dayData[day] = {
            posted,
            checked:         !!check,
            flag_count:      check?.flag_count      ?? 0,
            late_night_flag: check?.late_night_flag  ?? 0,
            sentiment_flag:  check?.sentiment_flag   ?? 0,
            volume_flag:     check?.volume_flag      ?? 0,
            posted_at:       report?.posted_at || null,
            char_count:      report?.char_count ?? null,
            is_future:       day > today,
            is_weekend:      isWeekend(day),
          };
        }

        return {
          user: {
            user_id: member.user_id, display_name: member.display_name,
            real_name: member.real_name, group, is_active: member.is_active,
          },
          days: dayData,
        };
      });

      const topGroups = allGroups.filter(g => !g.parent_id);
      const groupTree = topGroups.map(top => ({
        id: top.id, name: top.name,
        children: allGroups.filter(g => g.parent_id === top.id).map(c => ({
          id: c.id, name: c.name,
          members: enriched.filter(m => m.user.group?.id === c.id),
        })),
        direct_members: enriched.filter(m => m.user.group?.id === top.id),
      }));
      const ungrouped = enriched.filter(m => !m.user.group);

      let totalExpected = 0, totalPosted = 0, totalFlagged = 0;
      for (const m of enriched) {
        for (const day of days) {
          const d = m.days[day];
          if (d.is_future || d.is_weekend) continue;
          totalExpected++;
          if (d.posted) { totalPosted++; if (d.flag_count > 0) totalFlagged++; }
        }
      }

      res.json({
        week_start: days[0], week_end: days[6], days, today,
        group_tree: groupTree, ungrouped,
        weekly_stats: { total_expected: totalExpected, total_posted: totalPosted, total_flagged: totalFlagged },
      });
    } catch (e) {
      console.error('/api/weekly error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Members ──────────────────────────────────────────────────────────────
  server.get('/api/members', (req, res) => {
    const allGroups = db.getAllGroups();
    const groupMap  = Object.fromEntries(allGroups.map(g => [g.id, g]));
    const members   = db.getAllMembersRaw().map(m => ({
      ...m,
      group: m.group_id && groupMap[m.group_id] ? groupMap[m.group_id] : null,
    }));
    res.json(members);
  });

  server.patch('/api/members/:userId', requireAdmin, (req, res) => {
    const { userId } = req.params;
    const { group_id, is_active } = req.body;
    try {
      if (group_id !== undefined) db.setMemberGroup(userId, group_id || null);
      if (is_active !== undefined) db.setMemberActive(userId, !!is_active);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  server.post('/api/members/sync', requireAdmin, async (req, res) => {
    try {
      await syncChannelMembers();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Groups ───────────────────────────────────────────────────────────────
  server.get('/api/groups', (req, res) => {
    const allGroups = db.getAllGroups();
    const allMembers = db.getActiveMembers();
    const countByGroup = {};
    for (const m of allMembers) {
      if (m.group_id) countByGroup[m.group_id] = (countByGroup[m.group_id] || 0) + 1;
    }
    res.json(allGroups.map(g => ({ ...g, member_count: countByGroup[g.id] || 0 })));
  });

  server.post('/api/groups', requireAdmin, (req, res) => {
    const { name, parent_id } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    if (parent_id) {
      const parent = db.getGroup(parent_id);
      if (parent?.parent_id) {
        return res.status(400).json({ ok: false, error: '階層は2段まで（サブグループの下にはグループを作れません）' });
      }
    }
    try {
      const result = db.createGroup(name, parent_id || null);
      res.json({ ok: true, id: result.lastInsertRowid });
    } catch (e) {
      if (e.message.includes('UNIQUE')) {
        return res.status(400).json({ ok: false, error: `グループ名 "${name}" は既に存在します` });
      }
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  server.delete('/api/groups/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    db.deleteGroup(id);
    res.json({ ok: true });
  });

  // ── Dashboard Users ───────────────────────────────────────────────────────
  server.get('/api/users', requireAdmin, (req, res) => {
    res.json(db.getAllDashboardUsers());
  });

  server.post('/api/users', requireAdmin, (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ ok: false, error: 'username と password は必須です' });
    if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ ok: false, error: 'role は admin または viewer です' });
    if (db.getDashboardUser(username)) return res.status(400).json({ ok: false, error: `"${username}" は既に存在します` });
    try {
      const result = db.createDashboardUser(username, hashPassword(password), role);
      res.json({ ok: true, id: result.lastInsertRowid });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  server.patch('/api/users/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { role, password } = req.body;

    // 自分自身のroleをadmin→viewerに変更不可
    if (role && role !== 'admin' && req.authUser?.id === id) {
      return res.status(400).json({ ok: false, error: '自分自身の権限は変更できません' });
    }
    // 最後の管理者の権限は変更不可
    if (role === 'viewer') {
      const target = db.getDashboardUserById(id);
      if (target?.role === 'admin' && db.countAdminUsers() <= 1) {
        return res.status(400).json({ ok: false, error: '管理者が1名のため権限を変更できません' });
      }
    }

    const updates = {};
    if (role) updates.role = role;
    if (password) updates.passwordHash = hashPassword(password);
    db.updateDashboardUser(id, updates);
    res.json({ ok: true });
  });

  server.delete('/api/users/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (req.authUser?.id === id) {
      return res.status(400).json({ ok: false, error: '自分自身は削除できません' });
    }
    const target = db.getDashboardUserById(id);
    if (target?.role === 'admin' && db.countAdminUsers() <= 1) {
      return res.status(400).json({ ok: false, error: '管理者が1名のため削除できません' });
    }
    db.deleteDashboardUser(id);
    res.json({ ok: true });
  });

  return server;
}

// 指定日を含む週の月〜日（ISO日付配列）
function weekDays(dateStr) {
  const d   = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay();
  const offset = dow === 0 ? 6 : dow - 1;
  const mon = new Date(d.getTime() - offset * 86400000);
  return Array.from({ length: 7 }, (_, i) =>
    new Date(mon.getTime() + i * 86400000).toISOString().slice(0, 10)
  );
}

function isWeekend(dateStr) {
  const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return dow === 0 || dow === 6;
}

module.exports = { createServer };
