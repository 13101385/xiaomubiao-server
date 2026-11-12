/**
 * 订阅消息提醒调度（进程内，每 5 分钟一轮）
 * 时区：固定按 Asia/Shanghai 计算（中国无夏令时，UTC+8 恒定），不依赖服务器 TZ。
 *
 * 1) 任务开始提醒：任务开始前 10 分钟内、状态 todo、未提醒过、额度 > 0 → 发送，
 *    成功后额度 -1 并标记 reminded_start，绝不重复。
 * 2) 未完成提醒：每天 20:30–21:30 窗口内（错过 20:30 可补发，sent_log 保证每账号每天 ≤1 条）：
 *    当日仍有 todo/doing 任务的账号发一条汇总。
 */
const db = require('./db');
const wxapi = require('./wxapi');
const { TEMPLATES, buildStartData, buildDueData } = require('./reminder-config');

const TICK_MS = 5 * 60 * 1000;
const DUE_START_MIN = 20 * 60 + 30; // 20:30
const DUE_END_MIN = 21 * 60 + 30;   // 21:30

let timer = null;
let ticking = false;

function pad(n) { return String(n).padStart(2, '0'); }

/** 上海当前时间：{ date: 'YYYY-MM-DD', minutes: 当日分钟数 } */
function shanghaiNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return {
    date: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes()
  };
}

function addDays(dateStr, n) {
  const [y, m, dd] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, dd + n));
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function minOf(hhmm) {
  const parts = String(hhmm || '').split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
}

/**
 * 发送一条订阅消息并处理额度：
 * - errcode 0：扣额度，返回 true
 * - errcode 43101：用户未订阅/拒收，与本地额度不一致 → 本地额度归零对齐，返回 false
 * - 其它错误：不扣额度不标记，下一轮重试，返回 false
 */
async function sendAndSettle(accountId, templateId, openid, data) {
  let resp;
  try {
    resp = await wxapi.sendSubscribeMessage({ openid, templateId, data });
  } catch (e) {
    console.warn('[REMINDER] 发送请求失败:', accountId, e.message);
    return false;
  }
  if (resp.errcode === 0) {
    await db.decReminderQuota(accountId, templateId);
    return true;
  }
  if (resp.errcode === 43101) {
    console.warn('[REMINDER] 用户未订阅(43101)，额度归零:', accountId, templateId);
    await db.setReminderQuota(accountId, templateId, 0);
    return false;
  }
  console.warn('[REMINDER] 发送失败:', accountId, templateId, resp.errcode, resp.errmsg);
  return false;
}

async function scanStartReminders(now) {
  const candidates = await db.listStartCandidates(now.date);
  for (const t of candidates) {
    const delta = minOf(t.start_time) - now.minutes;
    if (delta <= 0 || delta > 10) continue;
    const sub = await db.getReminderSub(t.account_id, TEMPLATES.start);
    if (!sub || !sub.open_id || sub.quota <= 0) continue;
    const ok = await sendAndSettle(
      t.account_id, TEMPLATES.start, sub.open_id,
      buildStartData(t.child_name, t.task_name, t.date, t.start_time)
    );
    if (ok) {
      await db.markTaskReminded(t.id);
      console.log('[REMINDER] 开始提醒已发送:', t.account_id, t.task_name, t.start_time);
    }
  }
}

async function scanDueReminders(now) {
  if (now.minutes < DUE_START_MIN || now.minutes > DUE_END_MIN) return;
  const groups = await db.listUnfinishedByAccount(now.date);
  for (const g of groups) {
    if (await db.hasSentLog(g.account_id, 'due', now.date)) continue;
    const sub = await db.getReminderSub(g.account_id, TEMPLATES.due);
    if (!sub || !sub.open_id || sub.quota <= 0) continue;
    const ok = await sendAndSettle(
      g.account_id, TEMPLATES.due, sub.open_id,
      buildDueData(g.first_name, g.n, now.date)
    );
    if (ok) {
      await db.addSentLog(g.account_id, 'due', now.date);
      console.log('[REMINDER] 未完成提醒已发送:', g.account_id, '未完成', g.n, '项');
    }
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = shanghaiNow();
    await scanStartReminders(now);
    await scanDueReminders(now);
    await db.cleanupReminderData(addDays(now.date, -1), addDays(now.date, -7));
  } catch (e) {
    console.error('[REMINDER] 调度轮次失败:', e.message);
  } finally {
    ticking = false;
  }
}

function startReminderScheduler() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  // 启动后先跑一轮（错过整点窗口时未完成提醒可补发）
  tick();
  console.log('[REMINDER] 调度已启动（每 5 分钟，Asia/Shanghai）');
}

module.exports = { startReminderScheduler, _tick: tick, _shanghaiNow: shanghaiNow };
