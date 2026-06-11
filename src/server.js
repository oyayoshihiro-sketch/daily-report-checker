const express = require('express');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');
// getReportByType is available via db module
const cfg = require('./config');
const { runCheckForDate, fetchAndStoreReports, checkMember, todayJst, extractVerdict, verdictForDay } = require('./checker');
const { syncChannelMembers } = require('./members');
const { reloadSummaryCron, reloadMorningReportCron } = require('./scheduler');
const { postMorningReport } = require('./reporter');
const { sendInvitation, isSmtpConfigured } = require('./mailer');

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'dr_session';
const TOKEN_TTL = '7d';
const APP_URL = process.env.APP_URL || 'http://localhost:3001';

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

// ── Cookie ───────────────────────────────────────────────────────────────────

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}

function setSessionCookie(res, payload) {
  const token = jwt.sign(payload, SESSION_SECRET, { expiresIn: TOKEN_TTL });
  const secure = process.env.NODE_ENV === 'production';
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}${secure ? '; Secure' : ''}`
  );
  return token;
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`);
}

// ── 認証ミドルウェア ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return res.redirect('/login.html');
  try {
    req.user = jwt.verify(token, SESSION_SECRET);
    req.role = req.user.role;
    req.authUser = req.user;
    next();
  } catch {
    clearSessionCookie(res);
    res.redirect('/login.html');
  }
}

function requireAuthApi(req, res, next) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    req.user = jwt.verify(token, SESSION_SECRET);
    req.role = req.user.role;
    req.authUser = req.user;
    next();
  } catch {
    res.status(401).json({ error: 'セッションが切れました' });
  }
}

function requireAdmin(req, res, next) {
  if (req.role !== 'admin') return res.status(403).json({ error: '管理者権限が必要です' });
  next();
}

// ── 初期管理者シード ──────────────────────────────────────────────────────────

function seedInitialAdmin() {
  if (db.getAllDashboardUsers().length > 0) return;
  const email = process.env.ADMIN_EMAIL || process.env.DASHBOARD_USER;
  const pass  = process.env.ADMIN_PASSWORD || process.env.DASHBOARD_PASS;
  if (!email || !pass) return;
  db.createDashboardUser(email, hashPassword(pass), 'admin', 'Admin');
  console.log(`[auth] Initial admin created: ${email}`);
}

function createServer() {
  seedInitialAdmin();

  const server = express();
  server.use(express.json());

  // 静的ファイル（login.html, invite.html は認証不要）
  // HTML は常に最新版を返す（ブラウザキャッシュ防止）
  server.use(express.static(path.join(__dirname, '..', 'public'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  }));

  // ── 認証 ─────────────────────────────────────────────────────────────────
  server.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ ok: false, error: 'メールアドレスとパスワードを入力してください' });

    const user = db.getDashboardUser(email);
    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ ok: false, error: 'メールアドレスまたはパスワードが正しくありません' });
    }

    setSessionCookie(res, { id: user.id, email: user.email, role: user.role, displayName: user.display_name });
    res.json({ ok: true, role: user.role });
  });

  server.get('/auth/logout', (req, res) => {
    clearSessionCookie(res);
    res.redirect('/login.html');
  });

  // ── 招待承認（認証不要） ─────────────────────────────────────────────────
  server.get('/api/invitations/verify', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ ok: false, error: 'トークンが必要です' });
    const inv = db.getInvitationByToken(token);
    if (!inv) return res.status(404).json({ ok: false, error: '無効な招待リンクです' });
    if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ ok: false, error: '招待リンクの有効期限が切れています' });
    res.json({ ok: true, email: inv.email, role: inv.role });
  });

  server.post('/api/invitations/accept', async (req, res) => {
    const { token, password, displayName } = req.body;
    let   { email } = req.body;
    if (!token || !password) return res.status(400).json({ ok: false, error: 'トークンとパスワードが必要です' });
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'パスワードは8文字以上で設定してください' });

    const inv = db.getInvitationByToken(token);
    if (!inv) return res.status(404).json({ ok: false, error: '無効な招待リンクです' });
    if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ ok: false, error: '招待リンクの有効期限が切れています' });

    // 招待にメールが設定済みならそちらを優先、なければリクエストのメールを使用
    email = (inv.email || '').trim() || (email || '').trim();
    if (!email) return res.status(400).json({ ok: false, error: 'メールアドレスが必要です' });

    try {
      const existing = db.getDashboardUser(email);
      if (existing) {
        db.updateDashboardUser(existing.id, {
          passwordHash: hashPassword(password),
          ...(displayName ? { displayName } : {}),
        });
        db.deleteInvitation(inv.id);
        setSessionCookie(res, { id: existing.id, email: existing.email, role: existing.role, displayName: displayName || existing.display_name });
      } else {
        const result = db.createDashboardUser(email, hashPassword(password), inv.role, displayName || null);
        db.deleteInvitation(inv.id);
        setSessionCookie(res, { id: result.lastInsertRowid, email, role: inv.role, displayName: displayName || null });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 以降のAPIは全て認証必須
  server.use('/api', requireAuthApi);

  // ── 自分の情報 ───────────────────────────────────────────────────────────
  server.get('/api/me', (req, res) => {
    res.json({ role: req.user.role, email: req.user.email, displayName: req.user.displayName });
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
        let group = null;
        if (member.group_id && groupMap[member.group_id]) {
          const g = groupMap[member.group_id];
          let parent = null;
          if (g.parent_id && groupMap[g.parent_id]) {
            const p = groupMap[g.parent_id];
            const gp = p.parent_id && groupMap[p.parent_id] ? { id: groupMap[p.parent_id].id, name: groupMap[p.parent_id].name, parent: null } : null;
            parent = { id: p.id, name: p.name, parent: gp };
          }
          group = { id: g.id, name: g.name, parent };
        }
        // 投稿有無・勝敗は日報テキストから都度判定（保存済みチェックに依存しない）
        const morningReport = db.getReportByType(member.user_id, date, 'morning');
        const eveningReport = db.getReportByType(member.user_id, date, 'evening');
        const morningPosted = !!morningReport;
        const eveningPosted = !!eveningReport;
        const posted = morningPosted || eveningPosted;
        const report = eveningReport || morningReport;  // 夕方優先
        const verdict = verdictForDay({ eveningText: eveningReport?.text, morningText: morningReport?.text });
        return {
          user: { user_id: member.user_id, display_name: member.display_name, real_name: member.real_name, group },
          check: posted ? {
            posted: 1,
            morning_posted: morningPosted ? 1 : 0,
            evening_posted: eveningPosted ? 1 : 0,
            dual_post_flag: (morningPosted && eveningPosted) ? 0 : 1,
            wins_text:   verdict === 'win'  ? '勝ち' : null,
            losses_text: verdict === 'loss' ? '負け' : null,
            reflection_score: check && check.reflection_score != null ? check.reflection_score : null,
            growth_note: (check && check.growth_note) || null,
          } : null,
          report: report ? { char_count: report.char_count, posted_at: report.posted_at, text: report.text } : null,
          morning_report: morningReport ? { char_count: morningReport.char_count, posted_at: morningReport.posted_at, text: morningReport.text } : null,
          evening_report: eveningReport ? { char_count: eveningReport.char_count, posted_at: eveningReport.posted_at, text: eveningReport.text } : null,
        };
      });

      const posted      = enriched.filter(m => m.check?.posted).length;
      const missing     = enriched.length - posted;

      const topGroups = allGroups.filter(g => !g.parent_id);
      const groupTree = topGroups.map(top => {
        const children = allGroups.filter(g => g.parent_id === top.id).map(child => {
          const grandchildren = allGroups.filter(g => g.parent_id === child.id).map(gc => ({
            id: gc.id, name: gc.name,
            members: enriched.filter(m => m.user.group?.id === gc.id),
          }));
          return {
            id: child.id, name: child.name,
            children: grandchildren,
            members: enriched.filter(m => m.user.group?.id === child.id),
          };
        });
        return { id: top.id, name: top.name, children, direct_members: enriched.filter(m => m.user.group?.id === top.id) };
      });

      res.json({
        date,
        config: {
          summary_cron: cfg.get('summary_cron'),
        },
        stats: { total: enriched.length, posted, missing },
        members: enriched,
        group_tree: groupTree,
        ungrouped: enriched.filter(m => !m.user.group),
      });
    } catch (e) {
      console.error('/api/dashboard error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Wins/Losses range ────────────────────────────────────────────────────
  server.get('/api/wins-range', requireAuthApi, (req, res) => {
    try {
      const { from, to } = req.query;
      if (!from || !to) return res.status(400).json({ error: 'from/to required' });

      const allGroups  = db.getAllGroups();
      const allMembers = db.getActiveMembers();
      const checks     = db.getChecksForDateRange(from, to);
      const reports    = db.getReportsForDateRange(from, to);
      const groupMap   = Object.fromEntries(allGroups.map(g => [g.id, g]));

      // 日付リストを生成
      const dates = [];
      let d = new Date(from + 'T00:00:00Z');
      const end = new Date(to + 'T00:00:00Z');
      while (d <= end) {
        dates.push(d.toISOString().slice(0, 10));
        d.setUTCDate(d.getUTCDate() + 1);
      }

      // user別にチェックをインデックス化（振り返りスコア・成長メモ用）
      const checksByUser = {};
      for (const c of checks) {
        if (!checksByUser[c.user_id]) checksByUser[c.user_id] = {};
        checksByUser[c.user_id][c.check_date] = c;
      }

      // user×date×type で日報をインデックス化（勝敗は日報テキストから都度判定）
      const reportsByUser = {};
      for (const r of reports) {
        (reportsByUser[r.user_id] ??= {})[r.report_date] ??= {};
        reportsByUser[r.user_id][r.report_date][r.report_type] = r;
      }

      const members = allMembers.map(member => {
        const userChecks  = checksByUser[member.user_id]  || {};
        const userReports = reportsByUser[member.user_id] || {};
        let group = null;
        if (member.group_id && groupMap[member.group_id]) {
          const g = groupMap[member.group_id];
          let parent = null;
          if (g.parent_id && groupMap[g.parent_id]) {
            const p = groupMap[g.parent_id];
            parent = { id: p.id, name: p.name };
          }
          group = { id: g.id, name: g.name, parent };
        }

        const days = {};
        for (const date of dates) {
          const c    = userChecks[date];
          const reps = userReports[date] || {};
          const morningPosted = !!reps.morning;
          const eveningPosted = !!reps.evening;
          const posted = morningPosted || eveningPosted;
          if (!posted) { days[date] = { posted: 0 }; continue; }

          // 勝敗は日報テキストから読み取り時に再判定（保存値に依存しない、夜優先・朝もフォロー）
          const verdict = verdictForDay({ eveningText: reps.evening?.text, morningText: reps.morning?.text });
          days[date] = {
            posted: 1,
            wins_text:        verdict === 'win'  ? '勝ち' : null,
            losses_text:      verdict === 'loss' ? '負け' : null,
            reflection_score: c && c.reflection_score != null ? c.reflection_score : null,
            growth_note:      (c && c.growth_note) || null,
            morning_posted:   morningPosted ? 1 : 0,
            evening_posted:   eveningPosted ? 1 : 0,
            dual_post_flag:   (morningPosted && eveningPosted) ? 0 : 1,
          };
        }

        const postedDays  = Object.values(days).filter(d => d.posted);
        // 勝率の母数は「勝敗を記入した日」のみ（wins_text=勝ち / losses_text=負け）
        const winsDays    = postedDays.filter(d => d.wins_text);
        const lossesDays  = postedDays.filter(d => !d.wins_text && d.losses_text);
        const refScores   = postedDays.map(d => d.reflection_score).filter(s => s != null);

        return {
          user: { user_id: member.user_id, display_name: member.display_name, real_name: member.real_name, group },
          days,
          summary: {
            wins_count:    winsDays.length,
            losses_count:  lossesDays.length,
            judged_count:  winsDays.length + lossesDays.length,  // 勝率の母数
            posted_count:  postedDays.length,
            total_days:    dates.length,
            avg_reflection: refScores.length ? refScores.reduce((a, b) => a + b, 0) / refScores.length : null,
          },
        };
      });

      res.json({ from, to, dates, members });
    } catch (e) {
      console.error('/api/wins-range error:', e);
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

  // 投稿率レポートを手動送信
  server.post('/api/report/morning', requireAdmin, async (req, res) => {
    try {
      await postMorningReport();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 診断: 日付範囲の各eveningレポートを「今のロジックで再判定」して勝敗の根拠行を返す
  // 例) /api/debug/verdicts?from=2026-06-08&to=2026-06-14
  server.get('/api/debug/verdicts', requireAdmin, (req, res) => {
    try {
      const from = req.query.from || todayJst();
      const to   = req.query.to   || from;
      const reports = db.getReportsForDateRange(from, to).filter(r => r.report_type === 'evening');
      const memberMap = Object.fromEntries(db.getActiveMembers().map(m => [m.user_id, m]));
      const out = reports.map(r => {
        const { verdict, text } = extractVerdict(r.text);
        // 「勝敗」を含む行の周辺を抜き出して根拠を可視化
        const lines = (r.text || '').replace(/\r\n/g, '\n').split('\n');
        const idx = lines.findIndex(l => /勝敗/.test(l.replace(/[*_~`]|:[a-z0-9_+'-]+:/gi, '')));
        const context = idx >= 0 ? lines.slice(idx, idx + 3).join(' ⏎ ') : '（「勝敗」行なし）';
        const m = memberMap[r.user_id];
        return {
          user: m ? (m.real_name || m.display_name || m.user_id) : r.user_id,
          date: r.report_date,
          verdict: verdict || '判定なし(母数外)',
          matched: text,
          勝敗行の根拠: context.slice(0, 160),
        };
      });
      const wins = out.filter(o => o.verdict === 'win').length;
      const loss = out.filter(o => o.verdict === 'loss').length;
      const none = out.length - wins - loss;
      res.json({ from, to, total: out.length, wins, loss, none, judged: wins + loss,
                 win_rate: (wins + loss) ? Math.round(wins / (wins + loss) * 100) + '%' : '-', rows: out });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // デバッグ: DBに保存されたeveningレポートのテキスト全文と勝敗判定結果を確認
  server.get('/api/debug/reports', requireAdmin, (req, res) => {
    try {
      const date  = req.query.date || todayJst();
      const limit = parseInt(req.query.limit || '10', 10);
      const rows  = db.getDb().prepare(`
        SELECT dr.user_id, dr.report_date, dr.text,
               cc.wins_text, cc.losses_text, cc.posted,
               m.real_name, m.display_name
        FROM daily_reports dr
        LEFT JOIN condition_checks cc ON dr.user_id = cc.user_id AND dr.report_date = cc.check_date
        LEFT JOIN members m ON dr.user_id = m.user_id
        WHERE dr.report_type = 'evening'
          AND dr.report_date = ?
        ORDER BY dr.posted_at DESC
        LIMIT ?
      `).all(date, limit);
      res.json(rows.map(r => ({
        user:       r.real_name || r.display_name || r.user_id,
        date:       r.report_date,
        wins_text:  r.wins_text,
        losses_text: r.losses_text,
        text_full:  r.text,
      })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 生メッセージ確認: チャンネルの実際のメッセージをデバッグ用に返す
  server.get('/api/debug/messages', requireAdmin, async (req, res) => {
    try {
      const { getChannelHistory } = require('./slack');
      const channelId = cfg.get('report_channel_id');
      const date = req.query.date || todayJst();
      const oldest = new Date(date + 'T00:00:00+09:00').getTime() / 1000;
      const latest = new Date(date + 'T23:59:59+09:00').getTime() / 1000;
      const messages = await getChannelHistory(channelId, oldest, latest);
      const userIdRegex = cfg.get('user_id_regex');
      res.json({
        date, channelId, total: messages.length,
        messages: messages.slice(0, 20).map(m => {
          const match = userIdRegex ? m.text?.match(new RegExp(userIdRegex)) : null;
          return {
            subtype: m.subtype || 'user',
            user: m.user || null,
            bot_id: m.bot_id || null,
            bot_name: m.username || m.bot_profile?.name || null,
            text_preview: (m.text || '').slice(0, 200),
            regex_match: match?.[1] || null,
          };
        }),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ワークフローBot検出: 日報チャンネルの直近メッセージからbot_idを列挙する
  server.get('/api/check/detect-workflow-bot', requireAdmin, async (req, res) => {
    try {
      const { getChannelHistory } = require('./slack');
      const channelId = cfg.get('report_channel_id');
      const date = req.query.date || todayJst();
      const oldest = new Date(date + 'T00:00:00+09:00').getTime() / 1000;
      const latest = new Date(date + 'T23:59:59+09:00').getTime() / 1000;
      const messages = await getChannelHistory(channelId, oldest, latest);
      const bots = {};
      for (const m of messages) {
        if (m.subtype === 'bot_message' && m.bot_id) {
          if (!bots[m.bot_id]) bots[m.bot_id] = { bot_id: m.bot_id, bot_name: m.username || m.bot_profile?.name || '', sample: (m.text || '').slice(0, 80), count: 0 };
          bots[m.bot_id].count++;
        }
      }
      res.json({ ok: true, date, total: messages.length, bots: Object.values(bots) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Config ───────────────────────────────────────────────────────────────
  server.get('/api/config', (req, res) => res.json(db.getAllConfigRows()));

  server.patch('/api/config/:key', requireAdmin, (req, res) => {
    const { key } = req.params;
    const { value } = req.body;
    try {
      cfg.set(key, value);
      if (key === 'summary_cron')        reloadSummaryCron();
      if (key === 'morning_report_cron') reloadMorningReportCron();
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });


  // ── Members ──────────────────────────────────────────────────────────────
  server.get('/api/members', (req, res) => {
    const allGroups = db.getAllGroups();
    const groupMap  = Object.fromEntries(allGroups.map(g => [g.id, g]));
    res.json(db.getAllMembersRaw().map(m => ({ ...m, group: m.group_id && groupMap[m.group_id] ? groupMap[m.group_id] : null })));
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
    const allGroups  = db.getAllGroups();
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
        const grandparent = db.getGroup(parent.parent_id);
        if (grandparent?.parent_id) return res.status(400).json({ ok: false, error: '階層は3段まで' });
      }
    }
    try {
      const result = db.createGroup(name, parent_id || null);
      res.json({ ok: true, id: result.lastInsertRowid });
    } catch (e) {
      if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: `グループ名 "${name}" は既に存在します` });
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  server.delete('/api/groups/:id', requireAdmin, (req, res) => {
    db.deleteGroup(parseInt(req.params.id, 10));
    res.json({ ok: true });
  });

  // ── バディくん チャット ──────────────────────────────────────────────────
  server.post('/api/buddy/chat', async (req, res) => {
    try {
      const { message, history = [], date: queryDate } = req.body;
      if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

      const date = queryDate || todayJst();
      const allGroups  = db.getAllGroups();
      const allMembers = db.getActiveMembers();
      const groupMap   = Object.fromEntries(allGroups.map(g => [g.id, g]));
      const checks     = db.getChecksForDate(date);
      const checkMap   = Object.fromEntries(checks.map(c => [c.user_id, c]));

      // 過去14日のチェック履歴（トレンド用）
      const trendStart = new Date(date + 'T00:00:00Z');
      trendStart.setUTCDate(trendStart.getUTCDate() - 13);
      const pastChecks = db.getChecksForDateRange(trendStart.toISOString().slice(0, 10), date);
      const memberTrends = {};
      for (const c of pastChecks) {
        if (!memberTrends[c.user_id]) memberTrends[c.user_id] = [];
        memberTrends[c.user_id].push(c);
      }

      // グループパスを解決
      const resolveGroup = id => {
        if (!id || !groupMap[id]) return '未分類';
        const g = groupMap[id];
        const parts = [g.name];
        if (g.parent_id && groupMap[g.parent_id]) {
          parts.unshift(groupMap[g.parent_id].name);
          const p = groupMap[g.parent_id];
          if (p.parent_id && groupMap[p.parent_id]) parts.unshift(groupMap[p.parent_id].name);
        }
        return parts.join(' > ');
      };

      // メンバーごとにコンディション情報を構築
      const memberLines = allMembers.map(m => {
        const name  = m.display_name || m.real_name || m.user_id;
        const group = resolveGroup(m.group_id);
        const check = checkMap[m.user_id];

        if (!check)         return `【${name}】(${group}): 本日未チェック`;
        if (!check.posted)  return `【${name}】(${group}): 本日未投稿`;

        const refScore = check.reflection_score != null ? check.reflection_score.toFixed(2) : '—';
        const verdict  = check.wins_text ? '🏆勝ち' : check.losses_text ? '💪負け' : '判定なし';
        const winsLine   = check.wins_text   ? `\n  勝ち内容: ${check.wins_text}` : '';
        const lossesLine = check.losses_text ? `\n  負け内容: ${check.losses_text}` : '';
        const growthLine = check.growth_note ? `\n  成長メモ: ${check.growth_note}` : '';

        // 直近7日の勝敗推移（新→旧）
        const trend = (memberTrends[m.user_id] || [])
          .filter(c => c.posted && c.check_date !== date)
          .sort((a, b) => b.check_date.localeCompare(a.check_date))
          .slice(0, 7)
          .map(c => {
            const wl = c.wins_text ? '🏆' : c.losses_text ? '💪' : '・';
            const dp = (c.morning_posted && c.evening_posted) ? '☀️🌙' : c.morning_posted ? '☀️' : c.evening_posted ? '🌙' : '📭';
            return `${wl}${dp}`;
          })
          .join(' ');

        return `【${name}】(${group})
  本日: 勝敗=${verdict}, 振返スコア=${refScore}
  投稿状況: 朝=${check.morning_posted?'✓':'×'} / 夜=${check.evening_posted?'✓':'×'}${winsLine}${lossesLine}${growthLine}
  直近7日推移(勝敗/投稿): ${trend || 'データなし'}`;
      });

      const systemPrompt = `あなたは「バディくん」という名前のAIアシスタントです。
日報チェッカーシステムのデータをもとに、マネージャーやリーダーがチームメンバーの勝ち負け・振り返りを把握し、適切なフォローアップを行えるよう支援します。

## 基本姿勢
- 温かく親しみやすい口調で、でもプロフェッショナルに対応する
- 勝敗や振り返りスコアはあくまで参考情報として扱い、「〜の傾向が見られます」「〜かもしれません」と観察として伝える
- 具体的なメンバー名を挙げながら実践的なアドバイスをする
- 1on1のアドバイスは具体的な質問例や話題を提案する
- 回答は適切な長さにする（箇条書きを活用して読みやすく）

## 今日のメンバーの勝ち負け・振り返り（${date}）

${memberLines.join('\n\n')}

## 凡例
- 勝敗: 日報の「勝敗」欄に基づく（🏆勝ち / 💪負け / 判定なし=未記入）
- 振返スコア: 0.00〜1.00（高いほど振り返りが具体的で深い）

回答は日本語でお願いします。`;

      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const messages = [
        ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: message.trim() }
      ];

      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 900,
        system: systemPrompt,
        messages,
      });

      res.json({ ok: true, reply: response.content[0].text });
    } catch (e) {
      console.error('/api/buddy/chat error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Dashboard Users ───────────────────────────────────────────────────────
  server.get('/api/users', requireAdmin, (req, res) => {
    res.json(db.getAllDashboardUsers());
  });

  server.patch('/api/users/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { role, password } = req.body;
    if (role && role !== 'admin' && req.authUser?.id === id)
      return res.status(400).json({ ok: false, error: '自分自身の権限は変更できません' });
    if (role && role !== 'admin') {
      const target = db.getDashboardUserById(id);
      if (target?.role === 'admin' && db.countAdminUsers() <= 1)
        return res.status(400).json({ ok: false, error: '管理者が1名のため権限を変更できません' });
    }
    const updates = {};
    if (role) updates.role = role;
    if (password) updates.passwordHash = hashPassword(password);
    db.updateDashboardUser(id, updates);
    res.json({ ok: true });
  });

  server.delete('/api/users/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (req.authUser?.id === id) return res.status(400).json({ ok: false, error: '自分自身は削除できません' });
    const target = db.getDashboardUserById(id);
    if (target?.role === 'admin' && db.countAdminUsers() <= 1)
      return res.status(400).json({ ok: false, error: '管理者が1名のため削除できません' });
    db.deleteDashboardUser(id);
    res.json({ ok: true });
  });

  // ── Invitations ───────────────────────────────────────────────────────────
  server.get('/api/invitations', requireAdmin, (req, res) => {
    res.json(db.getAllInvitations());
  });

  server.post('/api/invitations', requireAdmin, async (req, res) => {
    const email = (req.body.email || '').trim();   // 空可（URLのみ発行）
    const { role } = req.body;
    if (!['admin', 'executive', 'member'].includes(role)) return res.status(400).json({ ok: false, error: 'role は admin / executive / member です' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    db.createInvitation(email, role, token, req.authUser.email, expiresAt);

    const inviteUrl = `${APP_URL}/invite.html?token=${token}`;

    // SMTP未設定なら即座にURLを返す（タイムアウト待ちなし）
    if (!isSmtpConfigured()) {
      return res.json({ ok: true, warning: 'メール送信が未設定です。URLを直接共有してください。', inviteUrl });
    }

    try {
      await sendInvitation({ to: email, inviterName: req.authUser.displayName || req.authUser.email, inviteUrl, role });
      res.json({ ok: true });
    } catch (e) {
      console.error('[invite] email error:', e.message);
      res.json({ ok: true, warning: 'メール送信に失敗しました。URLを直接共有してください。', inviteUrl });
    }
  });

  server.delete('/api/invitations/:id', requireAdmin, (req, res) => {
    db.deleteInvitation(parseInt(req.params.id, 10));
    res.json({ ok: true });
  });

  return server;
}

function weekDays(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay();
  const offset = dow === 0 ? 6 : dow - 1;
  const mon = new Date(d.getTime() - offset * 86400000);
  return Array.from({ length: 7 }, (_, i) => new Date(mon.getTime() + i * 86400000).toISOString().slice(0, 10));
}

function isWeekend(dateStr) {
  const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return dow === 0 || dow === 6;
}

module.exports = { createServer };
