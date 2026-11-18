/**
 * 用户行为埋点路由
 *
 * POST /api/analytics/events   小程序 utils/track 攒批上报：逐条校验后落库 analytics_events 表，
 *                              管理后台经 GET /api/admin/analytics 聚合查看。
 *
 * 校验口径（不过度设计，但兜住灌水与脏数据）：
 * - body.events 必须为数组；单批最多 50 条，超出部分截断（响应 truncated 注明截断条数）。
 * - event 必须为字符串、1–64 字符；props 必须为普通对象且 JSON 序列化后 ≤2KB，超限整条丢弃。
 * - props 再过一遍敏感键黑名单（与前端 utils/track 同口径，纵深防御）：命中键直接剔除，
 *   埋点只许枚举/计数型元数据，用户输入的文本内容不落库。
 * - accountId 可为空（未登录/游客未建号时记匿名，account_id 存空串）。
 * - clientTs 只接受有限数字，明显超前于服务器时间的钳到服务器时间；server_ts 一律服务器落库时刻。
 * - 防灌水：按来源 IP 内存计数，10 分钟内最多 6000 条事件（约 120 批），超出返回 429。
 */
const express = require('express');
const router = express.Router();
const db = require('../db');

const MAX_BATCH = 50;
const MAX_EVENT_LEN = 64;
const MAX_PROPS_BYTES = 2048;
const RATE_LIMIT_EVENTS = 6000;
const RATE_WINDOW_MS = 10 * 60 * 1000;

/* props 敏感键黑名单（小写比较，与小程序 utils/track.BLOCKED_KEYS 保持一致） */
const BLOCKED_KEYS = [
  'title', 'content', 'name', 'text', 'contact', 'comment', 'remark', 'input',
  'stem', 'answer', 'reason', 'note', 'desc', 'message', 'address', 'phone',
  'childname', 'taskname', 'nickname', 'question', 'feedback'
];

function sliceStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** 校验并归一化一条事件；不合法返回 null（丢弃） */
function normalizeEvent(raw, serverTs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const event = typeof raw.event === 'string' ? raw.event.trim() : '';
  if (!event || event.length > MAX_EVENT_LEN) return null;
  let props = raw.props;
  if (props == null) props = {};
  if (typeof props !== 'object' || Array.isArray(props)) return null;
  // 剔除敏感键 + 只留标量（与前端 sanitize 同口径，后端再兜一遍）
  const clean = {};
  Object.keys(props).forEach(k => {
    if (BLOCKED_KEYS.indexOf(String(k).toLowerCase()) >= 0) return;
    const v = props[k];
    if (typeof v === 'string') clean[k] = v.slice(0, 64);
    else if (typeof v === 'number' && isFinite(v)) clean[k] = v;
    else if (typeof v === 'boolean') clean[k] = v;
  });
  let propsJson;
  try { propsJson = JSON.stringify(clean); } catch (e) { return null; }
  if (Buffer.byteLength(propsJson, 'utf8') > MAX_PROPS_BYTES) return null;
  let clientTs = typeof raw.clientTs === 'number' && isFinite(raw.clientTs) ? Math.floor(raw.clientTs) : 0;
  if (clientTs > serverTs + 5 * 60 * 1000) clientTs = serverTs; // 客户端时钟超前过多不可信，钳到服务器时间
  return {
    accountId: sliceStr(raw.accountId, 128),
    childId: sliceStr(raw.childId, 64),
    sessionId: sliceStr(raw.sessionId, 64),
    event,
    propsJson,
    clientTs,
    serverTs,
    appVersion: sliceStr(raw.appVersion, 32)
  };
}

/* ---------- 简单防灌水：IP -> { count, windowStart }（内存，口径同 admin 登录锁定） ---------- */
const ipHits = new Map();

function rateExceeded(ip, nEvents) {
  const now = Date.now();
  const rec = ipHits.get(ip);
  if (!rec || now - rec.windowStart >= RATE_WINDOW_MS) {
    ipHits.set(ip, { count: nEvents, windowStart: now });
    return false;
  }
  rec.count += nEvents;
  return rec.count > RATE_LIMIT_EVENTS;
}

router.post('/events', async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.events)) {
    return res.status(400).json({ ok: false, msg: 'events 必须为数组' });
  }
  const truncated = Math.max(0, body.events.length - MAX_BATCH);
  const batch = body.events.slice(0, MAX_BATCH);
  if (rateExceeded(req.ip || 'unknown', batch.length)) {
    return res.status(429).json({ ok: false, msg: '上报太频繁了，请稍后再试' });
  }
  const serverTs = Date.now();
  const rows = [];
  let dropped = 0;
  batch.forEach(raw => {
    const ev = normalizeEvent(raw, serverTs);
    if (ev) rows.push(ev); else dropped++;
  });
  try {
    const saved = await db.insertAnalyticsEvents(rows);
    res.json({ ok: true, saved, dropped, truncated });
  } catch (err) {
    console.error('[ANALYTICS] insert error:', err.message);
    res.status(500).json({ ok: false, msg: '保存失败，请稍后再试' });
  }
});

module.exports = router;
