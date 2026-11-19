/**
 * 微信官方数据同步（流量主口径）
 *
 * 背景：后续开通流量主/广告，平台按微信官方口径考核（累计独立访客 UV 需达 500），
 * 管理后台概览以微信官方数据为主位；自有口径（注册/总用户/DAU/MAU）只作辅助，绝不混用冒充。
 *
 * 数据链路：
 * - 用 WX_APPID/WX_APPSECRET（env）经 wxapi 换 access_token，
 *   调数据分析接口 getweanalysisappiddailyvisittrend 逐日拉取（官方文档限定该接口单次
 *   只查 1 天数据：begin_date 必须等于 end_date，end_date 最大值为昨日；跨度超限回
 *   errcode 61501 date range error）；
 * - 累计用户 = 各日 visit_uv_new 之和；昨日新增/昨日访问取最近一日（上海时区昨日）的
 *   visit_uv_new / visit_uv。
 * - 结果落 wx_daily_stats（按日一行）+ wx_stats_sync（单行同步状态：尝试/成功时间、errcode/errmsg）。
 *
 * 同步时机：服务启动后延迟跑一次（startWxStatsSync）；每日 08:30 后由提醒调度 5 分钟 tick
 * 挂 maybeDailySync 触发（失败 30 分钟后可重试，成功当日不再重复）。
 *
 * 失败诚实：Secret 无效/接口报错时只记录状态（errcode/errmsg/最后成功时间），
 * getWxOverview 返回 status='error'，概览页据此显示「微信数据同步未成功」，不拿自有口径填充。
 *
 * 抗限流（2026-11-19）：逐日连发 401 次曾触发微信 61504「system busy」。现逐日请求间加
 * REQUEST_INTERVAL_MS 节流；单日遇 61504 或网络类临时错误时等 BUSY_RETRY_DELAY_MS 后重试该日，
 * 单日最多尝试 MAX_ATTEMPTS_PER_DAY 次，仍失败才中止本轮（已落库天数不回滚）；其他 errcode
 * （61501、40125 等）不重试、立即按失败口径处理。
 */
const axios = require('axios');
const db = require('./db');
const wxapi = require('./wxapi');
const { config } = require('./config');

const TARGET_USERS = 500;           // 流量主开通门槛：累计独立访客
const CHUNK_DAYS = 1;               // datacube 单次请求跨度：官方限定只查 1 天（begin=end），故逐日拉取
const BACKFILL_DAYS = 400;          // 首次回填窗口（覆盖上线至今；无数据日返回 0，不影响求和）
const DAILY_SYNC_MIN = 8 * 60 + 30; // 每日同步触发时间 08:30（上海）
const DAILY_RETRY_MS = 30 * 60 * 1000;

/* ---------- 抗限流节流/重试（可用 env 覆盖以便 mock 测试，生产用默认值） ---------- */
function envMs(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
}
const REQUEST_INTERVAL_MS = envMs('WX_STATS_THROTTLE_MS', 400);       // 逐日请求之间的间隔
const BUSY_RETRY_DELAY_MS = envMs('WX_STATS_RETRY_DELAY_MS', 60 * 1000); // 61504/网络错误后重试等待
const MAX_ATTEMPTS_PER_DAY = 3;  // 单日最多尝试次数（首次 + 重试），用尽仍失败才中止本轮

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

/** 网络类临时错误（无业务 errcode、重试可能恢复）：超时/连接重置/ DNS 抖动等 */
function isNetworkError(e) {
  if (!e) return false;
  const code = e.code || '';
  if (['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ERR_NETWORK'].indexOf(code) >= 0) return true;
  if (!e.response && /timeout|network|socket|econn|etimedout/i.test(String(e.message || ''))) return true;
  return false;
}

/** 可重试错误：微信 61504（system busy）或网络类临时错误；其他 errcode 一律不重试 */
function isRetryable(err) {
  if (!err) return false;
  if (err.errcode === 61504) return true;
  return !!err.retryable;
}

/** 拉一个分片（beginDay..endDay，'YYYY-MM-DD'，跨度 ≤ CHUNK_DAYS；当前即单日 begin=end），返回原始 list */
async function fetchTrendChunk(token, beginDay, endDay) {
  let res;
  try {
    res = await axios.post(
      'https://api.weixin.qq.com/datacube/getweanalysisappiddailyvisittrend?access_token=' + encodeURIComponent(token),
      { begin_date: toWxDay(beginDay), end_date: toWxDay(endDay) },
      { timeout: 15000 }
    );
  } catch (e) {
    const err = wxError(e.errcode, '微信数据接口请求失败: ' + e.message);
    if ((e && e.errcode === 61504) || isNetworkError(e)) err.retryable = true;
    throw err;
  }
  const data = res.data || {};
  if (data.errcode) {
    const err = wxError(data.errcode, '微信数据接口失败: ' + (data.errmsg || data.errcode));
    if (data.errcode === 61504) err.retryable = true;
    throw err;
  }
  return Array.isArray(data.list) ? data.list : [];
}

/**
 * 拉单日数据（带抗限流重试）：遇 61504/网络临时错误时等 BUSY_RETRY_DELAY_MS 后重试该日，
 * 单日最多尝试 MAX_ATTEMPTS_PER_DAY 次；非临时错误立即抛出，用尽次数仍失败也抛出（中止本轮，
 * 已落库天数不回滚，由 syncWxStats 按既有口径落失败状态）。
 */
async function fetchDayWithRetry(token, day) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_DAY; attempt++) {
    try {
      return await fetchTrendChunk(token, day, day);
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || attempt === MAX_ATTEMPTS_PER_DAY) throw e;
      console.warn('[WX-STATS]', day, '临时失败（' + (e.errcode != null ? 'errcode ' + e.errcode : '网络错误') +
        '），' + Math.round(BUSY_RETRY_DELAY_MS / 1000) + ' 秒后重试（第 ' + (attempt + 1) + '/' + MAX_ATTEMPTS_PER_DAY + ' 次）');
      await sleep(BUSY_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
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
    let firstRequest = true;
    while (cursor <= yesterday) {
      let chunkEnd = addDays(cursor, CHUNK_DAYS - 1);
      if (chunkEnd > yesterday) chunkEnd = yesterday;
      // 抗限流节流：逐日请求之间留间隔（首个请求不等待；重试自带更长的等待，不再叠加）
      if (!firstRequest && REQUEST_INTERVAL_MS > 0) await sleep(REQUEST_INTERVAL_MS);
      firstRequest = false;
      const list = await fetchDayWithRetry(token, cursor);
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
  _shanghaiDay: shanghaiDay,
  _timing: { REQUEST_INTERVAL_MS, BUSY_RETRY_DELAY_MS, MAX_ATTEMPTS_PER_DAY }
};
