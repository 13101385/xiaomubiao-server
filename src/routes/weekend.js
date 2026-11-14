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

module.exports = router;
module.exports._internals = { isEventActive, localTodayStr, loadData };
