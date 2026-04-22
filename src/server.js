const express = require('express');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');
const cfg = require('./config');
const { runCheckForDate, todayJst } = require('./checker');
const { syncChannelMembers } = require('./members');
const { reloadSummaryCron } = require('./scheduler');
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
  server.use(express.static(path.join(__dirname, '..', 'public')));

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
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ ok: false, error: 'トークンとパスワードが必要です' });
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'パスワードは8文字以上で設定してください' });

    const inv = db.getInvitationByToken(token);
    if (!inv) return res.status(404).json({ ok: false, error: '無効な招待リンクです' });
    if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ ok: false, error: '招待リンクの有効期限が切れています' });

    try {
      const existing = db.getDashboardUser(inv.email);
      if (existing) {
        // 既存ユーザーのパスワードを更新
        db.updateDashboardUser(existing.id, { passwordHash: hashPassword(password) });
        db.deleteInvitation(inv.id);
        setSessionCookie(res, { id: existing.id, email: existing.email, role: existing.role, displayName: existing.display_name });
      } else {
        const result = db.createDashboardUser(inv.email, hashPassword(password), inv.role);
        db.deleteInvitation(inv.id);
        setSessionCookie(res, { id: result.lastInsertRowid, email: inv.email, role: inv.role, displayName: null });
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

      // フラグ＋スコアから信号を動的計算（旧DBレコードも正しく扱う）
      // late_night_flag: 2=23時〜翌5時(赤), 1=22時台(黄), 0=通常
      // late_post_flag:  1=翌5〜13時(投稿遅れ→黄)
      const calcSig = c => {
        if (!c?.posted) return null;
        if (c.late_night_flag >= 2) return 'red';
        const s = c.sentiment_score;
        if (s !== null && s !== undefined) {
          if (s <= 0.35) return 'red';
        }
        if (c.late_night_flag >= 1) return 'yellow';
        if (s !== null && s !== undefined) {
          if (s < 0.60) return 'yellow';
        }
        if (c.late_post_flag) return 'yellow';
        if (c.volume_flag)    return 'yellow';
        return 'green';
      };

      const enriched = allMembers.map(member => {
        const check = checkMap[member.user_id] || null;
        const report = check?.posted ? db.getReport(member.user_id, date) : null;
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
        const signal = calcSig(check);
        return {
          user: { user_id: member.user_id, display_name: member.display_name, real_name: member.real_name, group },
          check: check ? {
            posted: check.posted, flag_count: check.flag_count,
            late_night_flag: check.late_night_flag, late_post_flag: check.late_post_flag || 0,
            sentiment_flag: check.sentiment_flag,
            sentiment_score: check.sentiment_score, volume_flag: check.volume_flag,
            volume_ratio: check.volume_ratio, posted_at: check.posted_at,
            signal,
            sentiment_summary: check.sentiment_summary || null,
            praise_points: check.praise_points || null,
            follow_points: check.follow_points || null,
            composite: (check.late_night_flag||0) + (check.late_post_flag||0) + (check.sentiment_flag||0) + (check.volume_flag||0),
          } : null,
          report: report ? { char_count: report.char_count, posted_at: report.posted_at, text: report.text } : null,
        };
      });

      const posted      = enriched.filter(m => m.check?.posted).length;
      const missing     = enriched.length - posted;
      const flagged     = enriched.filter(m => (m.check?.flag_count ?? 0) > 0).length;
      const critical    = enriched.filter(m => (m.check?.flag_count ?? 0) >= 3).length;
      const redCount    = enriched.filter(m => m.check?.signal === 'red').length;
      const yellowCount = enriched.filter(m => m.check?.signal === 'yellow').length;
      const greenCount  = enriched.filter(m => m.check?.signal === 'green').length;

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

      // 組織全体スコア
      const postedMs  = enriched.filter(m => m.check?.posted);
      const orgScores = postedMs.map(m => m.check?.sentiment_score).filter(s => s != null);
      const orgScore  = orgScores.length ? orgScores.reduce((a, b) => a + b, 0) / orgScores.length : null;
      const orgSignal = orgScore != null
        ? (orgScore <= 0.35 ? 'red' : orgScore < 0.60 ? 'yellow' : 'green')
        : (redCount > 0 ? 'red' : yellowCount > 0 ? 'yellow' : greenCount > 0 ? 'green' : null);
      const postingRate = enriched.length ? postedMs.length / enriched.length : 0;
      const opct = Math.round(postingRate * 100);
      const ocond = orgSignal === 'red' ? '要警戒' : orgSignal === 'yellow' ? '要注意' : '良好';
      const oScorePart = orgScore != null ? `平均スコア${orgScore.toFixed(2)}（${ocond}）` : `コンディション${orgSignal ? ocond : '計算中'}`;
      const oFlags = [redCount > 0 ? `赤信号${redCount}名` : '', yellowCount > 0 ? `黄信号${yellowCount}名` : ''].filter(Boolean);
      const orgSummary = `投稿率${opct}%・${oScorePart}${oFlags.length ? '。' + oFlags.join('・') + 'が要注意' : ''}。`;
      const orgStats = { score: orgScore, signal: orgSignal, posting_rate: postingRate, summary: orgSummary };

      res.json({
        date,
        config: {
          late_night_hour: cfg.get('late_night_hour'),
          sentiment_threshold: cfg.get('sentiment_threshold'),
          volume_change_pct: cfg.get('volume_change_pct'),
          volume_lookback_days: cfg.get('volume_lookback_days'),
          summary_cron: cfg.get('summary_cron'),
        },
        stats: { total: enriched.length, posted, missing, flagged, critical, redCount, yellowCount, greenCount },
        org_stats: orgStats,
        members: enriched,
        group_tree: groupTree,
        ungrouped: enriched.filter(m => !m.user.group),
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
      if (key === 'summary_cron') reloadSummaryCron();
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // ── Weekly ───────────────────────────────────────────────────────────────
  server.get('/api/weekly', (req, res) => {
    try {
      const date  = req.query.date || todayJst();
      const today = todayJst();
      const days  = weekDays(date);
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
          let parent = null;
          if (g.parent_id && groupMap[g.parent_id]) {
            const p = groupMap[g.parent_id];
            const gp = p.parent_id && groupMap[p.parent_id] ? { id: groupMap[p.parent_id].id, name: groupMap[p.parent_id].name, parent: null } : null;
            parent = { id: p.id, name: p.name, parent: gp };
          }
          group = { id: g.id, name: g.name, parent };
        }
        const dayData = {};
        for (const day of days) {
          const report = rMap[`${member.user_id}:${day}`] || null;
          const check  = cMap[`${member.user_id}:${day}`] || null;
          dayData[day] = {
            posted: !!(report || check?.posted),
            checked: !!check,
            flag_count:      check?.flag_count      ?? 0,
            late_night_flag: check?.late_night_flag  ?? 0,
            late_post_flag:  check?.late_post_flag   ?? 0,
            sentiment_flag:  check?.sentiment_flag   ?? 0,
            sentiment_score: check?.sentiment_score  ?? null,
            volume_flag:     check?.volume_flag      ?? 0,
            posted_at:  report?.posted_at || null,
            char_count: report?.char_count ?? null,
            is_future:  day > today,
            is_weekend: isWeekend(day),
          };
        }
        return { user: { user_id: member.user_id, display_name: member.display_name, real_name: member.real_name, group, is_active: member.is_active }, days: dayData };
      });

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

      let totalExpected = 0, totalPosted = 0, totalFlagged = 0;
      for (const m of enriched) for (const day of days) {
        const d = m.days[day];
        if (d.is_future || d.is_weekend) continue;
        totalExpected++;
        if (d.posted) { totalPosted++; if (d.flag_count > 0) totalFlagged++; }
      }

      // 日次ごとの組織スコア
      const weekdays = days.filter(d => !isWeekend(d));
      const dayOrgStats = {};
      for (const day of weekdays) {
        if (day > today) { dayOrgStats[day] = null; continue; }
        const dayMs   = enriched.filter(m => !m.days[day]?.is_weekend);
        const postedD = dayMs.filter(m => m.days[day]?.posted);
        const scoresD = postedD.map(m => m.days[day]?.sentiment_score).filter(s => s != null);
        const orgScoreD = scoresD.length ? scoresD.reduce((a, b) => a + b, 0) / scoresD.length : null;
        let rD = 0, yD = 0, gD = 0;
        for (const m of postedD) {
          const dd = m.days[day];
          const s = dd.sentiment_score;
          let sig = 'green';
          if (dd.late_night_flag >= 2) sig = 'red';
          else if (s != null && s <= 0.35) sig = 'red';
          else if (dd.late_night_flag === 1) sig = 'yellow';
          else if (s != null && s < 0.60) sig = 'yellow';
          else if (dd.late_post_flag) sig = 'yellow';
          else if (dd.volume_flag) sig = 'yellow';
          if (sig === 'red') rD++; else if (sig === 'yellow') yD++; else gD++;
        }
        const orgSignalD = orgScoreD != null
          ? (orgScoreD <= 0.35 ? 'red' : orgScoreD < 0.60 ? 'yellow' : 'green')
          : (rD > 0 ? 'red' : yD > 0 ? 'yellow' : gD > 0 ? 'green' : null);
        const postingRateD = dayMs.length ? postedD.length / dayMs.length : 0;
        const pctD = Math.round(postingRateD * 100);
        const condD = orgSignalD === 'red' ? '要警戒' : orgSignalD === 'yellow' ? '要注意' : '良好';
        const flagsD = [rD > 0 ? `赤${rD}名` : '', yD > 0 ? `黄${yD}名` : ''].filter(Boolean);
        const summaryD = orgScoreD != null
          ? `スコア${orgScoreD.toFixed(2)}（${condD}）・投稿率${pctD}%${flagsD.length ? '・' + flagsD.join('/') : ''}`
          : `投稿率${pctD}%`;
        dayOrgStats[day] = { score: orgScoreD, signal: orgSignalD, posting_rate: postingRateD, summary: summaryD, red_count: rD, yellow_count: yD };
      }

      res.json({
        week_start: days[0], week_end: days[6], days, today,
        group_tree: groupTree, ungrouped: enriched.filter(m => !m.user.group),
        weekly_stats: { total_expected: totalExpected, total_posted: totalPosted, total_flagged: totalFlagged },
        day_org_stats: dayOrgStats,
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

        const sig     = check.signal || '不明';
        const score   = check.sentiment_score != null ? check.sentiment_score.toFixed(2) : '—';
        const summary = check.sentiment_summary ? `「${check.sentiment_summary}」` : 'なし';
        const flags   = [
          check.late_night_flag >= 2 ? '深夜投稿(23〜5時)' : check.late_night_flag === 1 ? '夜間投稿(22時台)' : '',
          check.late_post_flag ? '投稿遅れ(朝〜昼)' : '',
          check.volume_flag ? `文量${check.volume_ratio < 1 ? '減少' : '増加'}(${Math.abs(Math.round((check.volume_ratio - 1) * 100))}%)` : '',
        ].filter(Boolean).join(', ');

        // 直近7日の推移（新→旧）
        const trend = (memberTrends[m.user_id] || [])
          .filter(c => c.posted && c.check_date !== date)
          .sort((a, b) => b.check_date.localeCompare(a.check_date))
          .slice(0, 7)
          .map(c => c.signal === 'red' ? '🔴' : c.signal === 'yellow' ? '🟡' : '🟢')
          .join('');

        return `【${name}】(${group})
  本日: 信号=${sig}, 感情スコア=${score}${flags ? ', フラグ=[' + flags + ']' : ''}
  日報サマリー: ${summary}
  直近7日推移: ${trend || 'データなし'}`;
      });

      const systemPrompt = `あなたは「バディくん」という名前のAIアシスタントです。
日報チェッカーシステムのデータをもとに、マネージャーやリーダーがチームメンバーのコンディションを把握し、適切なフォローアップを行えるよう支援します。

## 基本姿勢
- 温かく親しみやすい口調で、でもプロフェッショナルに対応する
- 感情スコアや日報サマリーはあくまで参考情報として扱い、「〜の傾向が見られます」「〜かもしれません」と観察として伝える
- 具体的なメンバー名を挙げながら実践的なアドバイスをする
- 1on1のアドバイスは具体的な質問例や話題を提案する
- 回答は適切な長さにする（箇条書きを活用して読みやすく）

## 今日のメンバーコンディション（${date}）

${memberLines.join('\n\n')}

## 凡例
- 信号: 🟢緑=良好, 🟡黄=要注意, 🔴赤=要警戒
- 感情スコア: 0.00〜1.00（高いほどポジティブ）
  - 0.80以上: 良好、0.60〜0.79: やや注意、0.40〜0.59: 要観察、0.39以下: 要対応

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
    if (role === 'viewer') {
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
    const { email, role } = req.body;
    if (!email) return res.status(400).json({ ok: false, error: 'メールアドレスが必要です' });
    if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ ok: false, error: 'role は admin または viewer です' });

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
