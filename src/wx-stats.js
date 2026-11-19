/**
 * 微信官方数据同步（流量主口径）
 *
 * 背景：后续开通流量主/广告，平台按微信官方口径考核（累计独立访客 UV 需达 500），
 * 管理后台概览以微信官方数据为主位；自有口径（注册/总用户/DAU/MAU）只作辅助，绝不混用冒充。
 *
 * 数据链路：
 * - 用 WX_APPID/WX_APPSECRET（env）经 wxapi 换 access_token，
 *   调数据分析接口 getweanalysisappiddailyvisittrend 按 30 天分片拉取（单次跨度上限 30 天）；
 * - 累计用户 = 各日 visit_uv_new 之和；昨日新增/昨日访问取最近一日（上海时区昨日）的
 *   visit_uv_new / visit_uv。
 * - 结果落 wx_daily_stats（按日一行）+ wx_stats_sync（单行同步状态：尝试/成功时间、errcode/errmsg）。
 *
 * 同步时机：服务启动后延迟跑一次（startWxStatsSync）；每日 08:30 后由提醒调度 5 分钟 tick
 * 挂 maybeDailySync 触发（失败 30 分钟后可重试，成功当日不再重复）。
 *
 * 失败诚实：Secret 无效/接口报错时只记录状态（errcode/errmsg/最后成功时间），
 * getWxOverview 返回 status='error'，概览页据此显示「微信数据同步未成功」，不拿自有口径填充。
 */
const axios = require('axios');
const db = require('./db');
const wxapi = require('./wxapi');
const { config } = require('./config');

const TARGET_USERS = 500;           // 流量主开通门槛：累计独立访客
const CHUNK_DAYS = 30;              // datacube 单次请求最大跨度（天）
const BACKFILL_DAYS = 400;          // 首次回填窗口（覆盖上线至今；无数据日返回 0，不影响求和）
const DAILY_SYNC_MIN = 8 * 60 + 30; // 每日同步触发时间 08:30（上海）
const DAILY_RETRY_MS = 30 * 60 * 1000;

/* ---------- 日期工具（固定 Asia/Shanghai = UTC+8，与 reminder-scheduler 同口径） ---------- */

function pad(n) { return String(n).padStart(2, '0'); }

/** 上海日期 'YYYY-MM-DD'，offsetDays 相对今天偏移 */
function shanghaiDay(offsetDays) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + (offsetDays || 0) * 86400 * 1000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function addDays(dayStr, n) {
  const parts = dayStr.split('-').map(Number);
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + n));
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

/** 'YYYY-MM-DD' -> 'YYYYMMDD'（datacube 接口日期格式） */
function toWxDay(dayStr) { return dayStr.replace(/-/g, ''); }

/** 'YYYYMMDD' -> 'YYYY-MM-DD'，格式不对返回 '' */
function fromWxDay(s) {
  const t = String(s || '');
  return /^\d{8}$/.test(t) ? t.slice(0, 4) + '-' + t.slice(4, 6) + '-' + t.slice(6, 8) : '';
}

/* ---------- 表与同步状态 ---------- */

let tablesReady = null;

function ensureTables() {
  if (!tablesReady) {
    tablesReady = (async () => {
      await db.runSql(
        'CREATE TABLE IF NOT EXISTS wx_daily_stats (day TEXT PRIMARY KEY, visit_uv INTEGER NOT NULL DEFAULT 0, visit_uv_new INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)'
      );
      await db.runSql(
        "CREATE TABLE IF NOT EXISTS wx_stats_sync (id INTEGER PRIMARY KEY CHECK (id = 1), last_attempt_at INTEGER NOT NULL DEFAULT 0, last_success_at INTEGER NOT NULL DEFAULT 0, last_errcode INTEGER, last_errmsg TEXT NOT NULL DEFAULT '')"
      );
      await db.runSql('INSERT OR IGNORE INTO wx_stats_sync (id) VALUES (1)');
    })().catch(err => { tablesReady = null; throw err; });
  }
  return tablesReady;
}

async function getSyncState() {
  const row = await db.getSql('SELECT last_attempt_at, last_success_at, last_errcode, last_errmsg FROM wx_stats_sync WHERE id = 1');
  return row || { last_attempt_at: 0, last_success_at: 0, last_errcode: null, last_errmsg: '' };
}

async function setSyncState(patch) {
  const cur = await getSyncState();
  const next = Object.assign({}, cur, patch);
  await db.runSql(
    'UPDATE wx_stats_sync SET last_attempt_at = ?, last_success_at = ?, last_errcode = ?, last_errmsg = ? WHERE id = 1',
    [next.last_attempt_at || 0, next.last_success_at || 0,
     next.last_errcode == null ? null : Number(next.last_errcode),
     String(next.last_errmsg || '').slice(0, 300)]
  );
}

/* ---------- 微信接口 ---------- */

function wxError(errcode, errmsg) {
  const err = new Error(errmsg);
  if (errcode != null) err.errcode = errcode;
  return err;
}

/** 拉一个分片（beginDay..endDay，'YYYY-MM-DD'，跨度 ≤ CHUNK_DAYS），返回原始 list */
async function fetchTrendChunk(token, beginDay, endDay) {
  let res;
  try {
    res = await axios.post(
      'https://api.weixin.qq.com/datacube/getweanalysisappiddailyvisittrend?access_token=' + encodeURIComponent(token),
      { begin_date: toWxDay(beginDay), end_date: toWxDay(endDay) },
      { timeout: 15000 }
    );
  } catch (e) {
    throw wxError(e.errcode, '微信数据接口请求失败: ' + e.message);
  }
  const data = res.data || {};
  if (data.errcode) {
    throw wxError(data.errcode, '微信数据接口失败: ' + (data.errmsg || data.errcode));
  }
  return Array.isArray(data.list) ? data.list : [];
}

async function upsertDay(item) {
  const day = fromWxDay(item && item.ref_date);
  if (!day) return;
  const uv = Number(item.visit_uv) || 0;
  const uvNew = Number(item.visit_uv_new) || 0;
  await db.runSql(
    'INSERT INTO wx_daily_stats (day, visit_uv, visit_uv_new, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(day) DO UPDATE SET visit_uv = excluded.visit_uv, visit_uv_new = excluded.visit_uv_new, updated_at = excluded.updated_at',
    [day, uv, uvNew, Date.now()]
  );
}

/* ---------- 同步主流程 ---------- */

let syncing = false;

async function syncWxStats() {
  if (syncing) return { ok: false, skipped: true, errmsg: '已有同步在进行' };
  syncing = true;
  const attemptAt = Date.now();
  try {
    await ensureTables();
    if (!config.wx.appid || !config.wx.appsecret) {
      throw wxError(null, 'WX_APPID / WX_APPSECRET 未配置，无法同步微信数据');
    }
    const token = await wxapi.getAccessToken();
    const yesterday = shanghaiDay(-1);
    const latestRow = await db.getSql('SELECT MAX(day) AS latest FROM wx_daily_stats');
    const latest = latestRow && latestRow.latest ? String(latestRow.latest) : '';
    // 首次：回填 BACKFILL_DAYS；增量：从最新日回溯 2 天（覆盖修订）到昨日
    let begin = latest ? addDays(latest, -2) : addDays(yesterday, -BACKFILL_DAYS);
    if (begin > yesterday) begin = yesterday;
    let cursor = begin;
    while (cursor <= yesterday) {
      let chunkEnd = addDays(cursor, CHUNK_DAYS - 1);
      if (chunkEnd > yesterday) chunkEnd = yesterday;
      const list = await fetchTrendChunk(token, cursor, chunkEnd);
      for (const item of list) await upsertDay(item);
      cursor = addDays(chunkEnd, 1);
    }
    await setSyncState({ last_attempt_at: attemptAt, last_success_at: Date.now(), last_errcode: null, last_errmsg: '' });
    console.log('[WX-STATS] 同步完成，数据截至', yesterday);
    return { ok: true };
  } catch (e) {
    const errcode = e && e.errcode != null ? e.errcode : null;
    const errmsg = String((e && e.message) || e || 'unknown').slice(0, 300);
    try {
      await ensureTables();
      await setSyncState({ last_attempt_at: attemptAt, last_errcode: errcode, last_errmsg: errmsg });
    } catch (e2) { /* 状态落库失败也不掩盖原始错误 */ }
    console.warn('[WX-STATS] 同步失败:', errcode == null ? '' : 'errcode ' + errcode, errmsg);
    return { ok: false, errcode, errmsg };
  } finally {
    syncing = false;
  }
}

/* ---------- 概览读数 ---------- */

/**
 * 概览微信区数据：
 * status: 'ok' 已同步 | 'pending' 从未同步（表空且无尝试记录） | 'error' 最近一次同步失败
 * error 时仍带最后一次成功落库的数字与 dataDate（页面会同时挂失败横幅并标注数据日期），
 * 从未成功过则数字为 null，页面只显示失败原因，不冒充。
 */
async function getWxOverview() {
  await ensureTables();
  const state = await getSyncState();
  const sumRow = await db.getSql('SELECT COALESCE(SUM(visit_uv_new), 0) AS total, COUNT(*) AS days, MAX(day) AS latest FROM wx_daily_stats');
  const hasData = !!(sumRow && sumRow.days > 0);
  const cumulative = hasData ? Number(sumRow.total) || 0 : null;
  const yesterday = shanghaiDay(-1);
  const yRow = await db.getSql('SELECT visit_uv, visit_uv_new FROM wx_daily_stats WHERE day = ?', [yesterday]);
  const lastAttemptAt = state.last_attempt_at || 0;
  const lastSuccessAt = state.last_success_at || 0;
  const failed = lastAttemptAt > 0 && lastAttemptAt > lastSuccessAt;
  let status = 'ok';
  if (!hasData && lastAttemptAt === 0) status = 'pending';
  else if (failed) status = 'error';
  return {
    status,
    target: TARGET_USERS,
    cumulativeUsers: cumulative,
    yesterdayNew: yRow ? (Number(yRow.visit_uv_new) || 0) : null,
    yesterdayUv: yRow ? (Number(yRow.visit_uv) || 0) : null,
    dataDate: hasData ? String(sumRow.latest) : null,
    remaining: cumulative == null ? null : Math.max(0, TARGET_USERS - cumulative),
    percent: cumulative == null ? null : Math.min(100, Math.round(cumulative / TARGET_USERS * 1000) / 10),
    lastAttemptAt,
    lastSuccessAt,
    errcode: failed ? state.last_errcode : null,
    errmsg: failed ? (state.last_errmsg || '') : ''
  };
}

/* ---------- 调度挂钩 ---------- */

let dailyDoneDate = '';
let lastDailyAttemptAt = 0;

/** 由提醒调度 5 分钟 tick 调用（now 为 reminder-scheduler 的 shanghaiNow() 结果） */
function maybeDailySync(now) {
  if (!now || typeof now.minutes !== 'number') return;
  if (now.minutes < DAILY_SYNC_MIN) return;
  if (dailyDoneDate === now.date) return;
  if (Date.now() - lastDailyAttemptAt < DAILY_RETRY_MS) return;
  lastDailyAttemptAt = Date.now();
  syncWxStats()
    .then(r => { if (r && r.ok) dailyDoneDate = now.date; })
    .catch(() => { /* syncWxStats 内部已记录失败状态 */ });
}

/** 服务启动后延迟同步一次（非阻塞，失败只记状态） */
function startWxStatsSync() {
  ensureTables().catch(() => { /* 同步时还会重试建表 */ });
  const t = setTimeout(() => { syncWxStats().catch(() => {}); }, 5000);
  if (t.unref) t.unref();
}

module.exports = {
  syncWxStats,
  getWxOverview,
  maybeDailySync,
  startWxStatsSync,
  TARGET_USERS,
  _ensureTables: ensureTables,
  _shanghaiDay: shanghaiDay
};
