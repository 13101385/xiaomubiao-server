/**
 * 管理后台路由（v1）
 *
 * POST /api/admin/login                 口令登录，成功发 HMAC 签名会话 Cookie（httpOnly，7 天）
 * POST /api/admin/logout                退出登录
 * GET  /api/admin/me                    会话自检
 * GET  /api/admin/overview              概览聚合（全部来自现有表，取不到的项返回 null 并在 unavailable 注明）
 * GET  /api/admin/users                 用户列表（parent_records，只读、脱敏）
 * GET  /api/admin/feedbacks             反馈列表（支持 category/status 筛选、分页）
 * PATCH /api/admin/feedbacks/:id/status 反馈状态流转（pending/read/planned/done），写审计
 * GET  /api/admin/posters               官方库手抄报按主题分组
 * PATCH /api/admin/posters/:id/qa       验图标记（ok/bad/none），写审计
 * GET  /api/admin/system                系统状态 + 配置布尔（永不回密钥值）+ 最近审计
 *
 * 安全口径：
 * - ADMIN_SECRET 只读 process.env，未设置或长度 < 12 时全部接口返回 503，绝不硬编码/回退默认口令。
 * - 会话令牌 = base64url(payload).HMAC-SHA256(payload, ADMIN_SECRET)，校验用 timingSafeEqual。
 * - 登录失败按 IP 内存计数，5 次失败锁定 10 分钟。
 * - 兼容：GET /api/admin/feedbacks 仍接受旧 ?secret= 口径（必须与 env 精确相等且已配置），
 *   供既有运维脚本过渡；新后台页面统一走 Cookie 会话。
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');

const COOKIE_NAME = 'admin_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const FEEDBACK_STATUSES = ['pending', 'read', 'planned', 'done'];
const QA_VALUES = ['ok', 'bad', 'none'];
// 官方手抄报库账号（图库灌库脚本 fill-library.js 使用的官方账号）
const OFFICIAL_ACCOUNT_ID = process.env.OFFICIAL_ACCOUNT_ID || 'acc_16yue1j';

/* ==================== 配置与会话 ==================== */

function adminSecret() {
  return typeof process.env.ADMIN_SECRET === 'string' ? process.env.ADMIN_SECRET : '';
}

function adminConfigured() {
  return adminSecret().length >= 12;
}

function sha256Buf(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest();
}

function signPayload(payloadB64) {
  return crypto.createHmac('sha256', adminSecret()).update(payloadB64).digest('base64url');
}

function issueSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS }), 'utf8').toString('base64url');
  return payload + '.' + signPayload(payload);
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signPayload(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch (e) {
    return false;
  }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function isAuthed(req) {
  if (verifySession(parseCookies(req)[COOKIE_NAME])) return true;
  // 兼容旧运维脚本：仅反馈列表 GET 接受 ?secret=（须已配置且精确相等，无默认回退）
  if (req.method === 'GET' && req.path === '/feedbacks' && adminConfigured()) {
    const s = req.query && req.query.secret;
    if (typeof s === 'string' && s.length === adminSecret().length &&
        crypto.timingSafeEqual(sha256Buf(s), sha256Buf(adminSecret()))) {
      return true;
    }
  }
  return false;
}

/* ==================== 审计与结构迁移 ==================== */

let schemaReady = null;

async function ensureColumn(table, column, def) {
  const cols = await db.allSql('PRAGMA table_info(' + table + ')');
  if (!cols || cols.length === 0) return; // 表不存在则跳过（主流程建表后才会有）
  if (cols.some(c => c.name === column)) return;
  await db.runSql('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + def);
}

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.runSql(
        "CREATE TABLE IF NOT EXISTS admin_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT NOT NULL, target TEXT DEFAULT '', result TEXT DEFAULT '', ip TEXT DEFAULT '')"
      );
      await db.runSql('CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit_log(ts)');
      await ensureColumn('feedbacks', 'status', "TEXT DEFAULT 'pending'");
      await ensureColumn('posters', 'qa', "TEXT DEFAULT ''");
    })().catch(err => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

async function audit(action, target, result, req) {
  try {
    await db.runSql(
      'INSERT INTO admin_audit_log (ts, action, target, result, ip) VALUES (?, ?, ?, ?, ?)',
      [Date.now(), action, String(target || '').slice(0, 128), String(result || '').slice(0, 32), (req && req.ip) || '']
    );
  } catch (e) { /* 审计失败不阻塞主流程 */ }
}

/* ==================== 中间件 ==================== */

// 未配置（无 ADMIN_SECRET 或过短）时全部 admin 接口 503
router.use((req, res, next) => {
  if (!adminConfigured()) {
    return res.status(503).json({ ok: false, msg: 'admin not configured' });
  }
  next();
});

// 除登录外全部要求会话
router.use((req, res, next) => {
  if (req.path === '/login') return next();
  if (!isAuthed(req)) {
    return res.status(401).json({ ok: false, msg: '未登录' });
  }
  next();
});

// 数据接口前确保审计表与补列就绪
router.use(async (req, res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (err) {
    console.error('[ADMIN] schema error:', err.message);
    res.status(500).json({ ok: false, msg: '服务初始化失败' });
  }
});

/* ==================== 登录 ==================== */

const loginFails = new Map(); // ip -> { fails, lockedUntil }

router.post('/login', async (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const rec = loginFails.get(ip);
  if (rec && rec.lockedUntil > now) {
    return res.status(429).json({ ok: false, msg: '登录失败次数过多，请 10 分钟后再试' });
  }
  const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  const ok = password.length > 0 &&
    crypto.timingSafeEqual(sha256Buf(password), sha256Buf(adminSecret()));
  if (!ok) {
    const nextRec = rec && rec.lockedUntil <= now ? rec : { fails: 0, lockedUntil: 0 };
    nextRec.fails += 1;
    if (nextRec.fails >= LOGIN_MAX_FAILS) {
      nextRec.lockedUntil = now + LOGIN_LOCK_MS;
      nextRec.fails = 0;
    }
    loginFails.set(ip, nextRec);
    await audit('login', '', 'fail', req);
    return res.status(401).json({ ok: false, msg: '口令不正确' });
  }
  loginFails.delete(ip);
  await audit('login', '', 'success', req);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    COOKIE_NAME + '=' + issueSession() +
    '; HttpOnly; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) +
    '; SameSite=Lax' + (secure ? '; Secure' : ''));
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ ok: true, authed: true });
});

/* ==================== 概览 ==================== */

function shanghaiDay(offsetDays) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + (offsetDays || 0) * 86400 * 1000);
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

async function countValue(sql, params) {
  const row = await db.getSql(sql, params || []);
  if (!row) return null;
  const v = Object.values(row)[0];
  return typeof v === 'number' ? v : Number(v) || 0;
}

router.get('/overview', async (req, res) => {
  const data = {};
  const unavailable = [];
  const metric = async (name, fn) => {
    try { data[name] = await fn(); }
    catch (e) { data[name] = null; unavailable.push(name); }
  };
  const now = Date.now();
  // 注册用户口径：parent_records 为现行账号体系（海报/试卷/提醒均以 account_id 关联）
  await metric('totalUsers', () => countValue('SELECT COUNT(*) AS n FROM parent_records'));
  await metric('usersTableCount', () => countValue('SELECT COUNT(*) AS n FROM users'));
  await metric('newUsers7d', () => countValue('SELECT COUNT(*) AS n FROM parent_records WHERE created_at >= ?', [now - 7 * 86400 * 1000]));
  await metric('reminderSubscribers', () => countValue('SELECT COUNT(DISTINCT account_id) AS n FROM reminder_subs'));
  await metric('pendingFeedbacks', () => countValue("SELECT COUNT(*) AS n FROM feedbacks WHERE COALESCE(status, 'pending') = 'pending'"));
  await metric('officialPosters', () => countValue('SELECT COUNT(*) AS n FROM posters WHERE account_id = ?', [OFFICIAL_ACCOUNT_ID]));
  await metric('totalExams', () => countValue('SELECT COUNT(*) AS n FROM exams'));
  await metric('yesterdayPushSent', () => countValue('SELECT COUNT(*) AS n FROM reminder_sent_log WHERE day = ?', [shanghaiDay(-1)]));
  data.unavailable = unavailable;
  res.json({ ok: true, data });
});

/* ==================== 用户（只读、脱敏） ==================== */

function maskId(id) {
  const s = String(id || '');
  if (s.length <= 4) return '***';
  return '***' + s.slice(-4);
}

function avatarUrlOf(row) {
  if (!row.avatar_key) return '';
  const v = row.avatar_updated_at || row.updated_at || 0;
  return '/api/auth/avatar/' + encodeURIComponent(row.account_id) + '?v=' + v;
}

router.get('/users', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.max(1, Math.min(parseInt(req.query.pageSize, 10) || 20, 100));
  const offset = (page - 1) * pageSize;
  try {
    const total = await countValue('SELECT COUNT(*) AS n FROM parent_records');
    let rows;
    let subKnown = true;
    try {
      rows = await db.allSql(
        `SELECT p.account_id, p.parent_name, p.has_registered, p.avatar_key, p.avatar_type,
                p.avatar_updated_at, p.created_at, p.updated_at,
                EXISTS(SELECT 1 FROM reminder_subs rs WHERE rs.account_id = p.account_id) AS subscribed
         FROM parent_records p ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
        [pageSize, offset]
      );
    } catch (e) {
      subKnown = false; // reminder_subs 缺失时降级：不带订阅标记
      rows = await db.allSql(
        `SELECT account_id, parent_name, has_registered, avatar_key, avatar_type,
                avatar_updated_at, created_at, updated_at
         FROM parent_records ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [pageSize, offset]
      );
    }
    const list = rows.map(r => ({
      maskedId: maskId(r.account_id),
      nickname: r.parent_name || '',
      avatarUrl: avatarUrlOf(r),
      registered: r.has_registered === 1,
      subscribedReminder: subKnown ? r.subscribed === 1 : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
    res.json({ ok: true, data: { list, total, page, pageSize } });
  } catch (err) {
    console.error('[ADMIN] users error:', err.message);
    res.status(500).json({ ok: false, msg: '获取用户列表失败' });
  }
});

/* ==================== 反馈 ==================== */

router.get('/feedbacks', async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const where = [];
  const params = [];
  if (req.query.category) { where.push('category = ?'); params.push(String(req.query.category).slice(0, 32)); }
  if (req.query.status && FEEDBACK_STATUSES.includes(req.query.status)) {
    where.push("COALESCE(status, 'pending') = ?"); params.push(req.query.status);
  }
  const sql = 'SELECT id, account_id, category, content, contact, app_version, status, created_at FROM feedbacks' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  try {
    const rows = await db.allSql(sql, params.concat([limit, offset]));
    const list = rows.map(r => ({
      id: r.id,
      maskedAccountId: maskId(r.account_id),
      category: r.category || '',
      content: r.content,
      contact: r.contact || '',
      appVersion: r.app_version || '',
      status: r.status || 'pending',
      createdAt: r.created_at
    }));
    res.json({ ok: true, data: { list } });
  } catch (err) {
    console.error('[ADMIN] feedbacks error:', err.message);
    res.status(500).json({ ok: false, msg: '获取反馈失败' });
  }
});

router.patch('/feedbacks/:id/status', async (req, res) => {
  const status = req.body && req.body.status;
  if (!FEEDBACK_STATUSES.includes(status)) {
    return res.status(400).json({ ok: false, msg: '状态不合法' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, msg: 'id 不合法' });
  try {
    const r = await db.runSql('UPDATE feedbacks SET status = ? WHERE id = ?', [status, id]);
    if (!r.changes) return res.status(404).json({ ok: false, msg: '反馈不存在' });
    await audit('feedback_status', 'feedback:' + id, status, req);
    res.json({ ok: true, id, status });
  } catch (err) {
    console.error('[ADMIN] feedback status error:', err.message);
    res.status(500).json({ ok: false, msg: '更新失败' });
  }
});

/* ==================== 手抄报（官方库） ==================== */

router.get('/posters', async (req, res) => {
  try {
    const rows = await db.allSql(
      `SELECT id, theme, grade, title, source, image_url, composed_url, qa, created_at
       FROM posters WHERE account_id = ? ORDER BY theme ASC, created_at DESC`,
      [OFFICIAL_ACCOUNT_ID]
    );
    const byTheme = new Map();
    rows.forEach(r => {
      if (!byTheme.has(r.theme)) byTheme.set(r.theme, []);
      byTheme.get(r.theme).push({
        id: r.id,
        theme: r.theme,
        grade: r.grade || '',
        title: r.title || '',
        imageUrl: r.composed_url || r.image_url || '',
        rawImageUrl: r.image_url || '',
        composedUrl: r.composed_url || '',
        qa: r.qa || '',
        createdAt: r.created_at
      });
    });
    const groups = Array.from(byTheme.entries()).map(([theme, list]) => ({ theme, count: list.length, list }));
    res.json({ ok: true, data: { groups, total: rows.length } });
  } catch (err) {
    console.error('[ADMIN] posters error:', err.message);
    res.status(500).json({ ok: false, msg: '获取手抄报失败' });
  }
});

router.patch('/posters/:id/qa', async (req, res) => {
  const qa = req.body && req.body.qa;
  if (!QA_VALUES.includes(qa)) {
    return res.status(400).json({ ok: false, msg: 'qa 不合法' });
  }
  try {
    const r = await db.runSql(
      'UPDATE posters SET qa = ? WHERE id = ? AND account_id = ?',
      [qa === 'none' ? '' : qa, req.params.id, OFFICIAL_ACCOUNT_ID]
    );
    if (!r.changes) return res.status(404).json({ ok: false, msg: '官方库海报不存在' });
    await audit('poster_qa', 'poster:' + req.params.id, qa, req);
    res.json({ ok: true, id: req.params.id, qa });
  } catch (err) {
    console.error('[ADMIN] poster qa error:', err.message);
    res.status(500).json({ ok: false, msg: '更新失败' });
  }
});

/* ==================== 系统 ==================== */

router.get('/system', async (req, res) => {
  let version = '';
  try { version = require('../../package.json').version || ''; } catch (e) { /* 忽略 */ }
  let auditRecent = [];
  try {
    const rows = await db.allSql('SELECT ts, action, target, result FROM admin_audit_log ORDER BY ts DESC LIMIT 10');
    auditRecent = rows.map(r => ({ ts: r.ts, action: r.action, target: r.target, result: r.result }));
  } catch (e) { /* 审计表不可用时留空 */ }
  res.json({
    ok: true,
    data: {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptimeSec: Math.floor(process.uptime()),
      node: process.version,
      version,
      // 只回布尔：是否已配置，永不回任何密钥值
      config: {
        adminConfigured: adminConfigured(),
        wxAppidSet: !!process.env.WX_APPID,
        wxAppsecretSet: !!process.env.WX_APPSECRET,
        agnesKeySet: !!process.env.AGNES_AI_API_KEY,
        smsKeySet: !!process.env.ALIYUN_ACCESS_KEY_ID,
        dbPathSet: !!process.env.DB_PATH
      },
      auditRecent
    }
  });
});

module.exports = router;
