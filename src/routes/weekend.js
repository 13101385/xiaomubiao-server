/**
 * 周末好去处数据下发（1.5.14 新增）
 *
 * GET /api/weekend/all → { ok, dataVersion, generatedAt, cities, byCity }
 * 数据源：src/data/weekend.json（精选数据单一文件，由每日数据维护流程更新：
 * 前端 utils/weekend-places*.js 为编辑源，sync-data 汇总成本文件）。
 * 展览由服务端按「今天」过滤过期项再下发；小程序端另有本地打包数据兜底，
 * 接口不可用时页面照常可用。文件按 mtime 热加载，更新文件后无需改代码。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');

const router = express.Router();

const DATA_FILE = process.env.WEEKEND_DATA_FILE || path.join(__dirname, '..', 'data', 'weekend.json');

let cache = null; // { mtimeMs, raw }

function loadData() {
  try {
    const st = fs.statSync(DATA_FILE);
    if (!cache || cache.mtimeMs !== st.mtimeMs) {
      cache = { mtimeMs: st.mtimeMs, raw: JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
    }
    return cache.raw;
  } catch (e) {
    return null;
  }
}

function localTodayStr() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 与前端同口径：未结束，且已开始或 14 天内即将开始（演出提前展示方便订票）
const EVENT_UPCOMING_DAYS = 14;
function addDaysStr(dateStr, days) {
  const parts = dateStr.split('-');
  const ms = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) + days * 86400000;
  const d = new Date(ms);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}
function isEventActive(ev, todayStr) {
  const t = todayStr || localTodayStr();
  if (ev.endDate && ev.endDate < t) return false;
  if (!ev.startDate || ev.startDate <= t) return true;
  return ev.startDate <= addDaysStr(t, EVENT_UPCOMING_DAYS);
}

router.get('/all', (req, res) => {
  const raw = loadData();
  if (!raw || !raw.byCity) {
    return res.status(503).json({ ok: false, code: 'WEEKEND_DATA_MISSING', msg: '周末数据暂不可用' });
  }
  const t = localTodayStr();
  const byCity = {};
  Object.keys(raw.byCity).forEach((k) => {
    const c = raw.byCity[k] || {};
    byCity[k] = {
      name: c.name || '',
      verifiedDate: c.verifiedDate || '',
      places: Array.isArray(c.places) ? c.places : [],
      events: (Array.isArray(c.events) ? c.events : []).filter((ev) => isEventActive(ev, t))
    };
  });
  res.set('Cache-Control', 'public, max-age=1800');
  res.json({
    ok: true,
    dataVersion: raw.dataVersion || '',
    generatedAt: raw.generatedAt || '',
    cities: Array.isArray(raw.cities) ? raw.cities : [],
    byCity
  });
});

/* ---------- 未开通城市需求统计（1.5.16 新增） ----------
 * POST /api/weekend/city-demand { accountId, city }
 * 小程序定位到未收录城市时上报城市名（只报城市名，不含坐标）。
 * 落库 weekend_city_demand 表（本路由懒建表，不改 db.js），
 * 管理后台 GET /api/admin/city-demand 按城市聚合展示，供按热度排开通顺序。 */
let demandTableReady = false;
async function ensureDemandTable() {
  if (demandTableReady) return;
  await db.runSql("CREATE TABLE IF NOT EXISTS weekend_city_demand (id INTEGER PRIMARY KEY AUTOINCREMENT, city TEXT DEFAULT '', account_id TEXT DEFAULT '', created_at INTEGER NOT NULL)");
  await db.runSql('CREATE INDEX IF NOT EXISTS idx_wkd_city ON weekend_city_demand(city)');
  demandTableReady = true;
}

router.post('/city-demand', async (req, res) => {
  const body = req.body || {};
  const city = String(body.city || '').trim().slice(0, 20);
  const accountId = String(body.accountId || '').slice(0, 64);
  try {
    await ensureDemandTable();
    await db.runSql(
      'INSERT INTO weekend_city_demand (city, account_id, created_at) VALUES (?, ?, ?)',
      [city, accountId, Date.now()]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, code: 'DEMAND_SAVE_FAILED', msg: '需求记录失败' });
  }
});

module.exports = router;
module.exports._internals = { isEventActive, localTodayStr, loadData };
