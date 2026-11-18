'use strict';
/**
 * 行为埋点自测（不依赖 jest）：临时 SQLite + 真起服务打接口。
 * 运行：node scripts/selftest-analytics.js
 * 覆盖：批量写入（合法一批全落库）/ 单批 >50 截断 / 校验丢弃（event 非法、props 非对象、
 *       props >2KB、敏感键剔除、标量过滤、clientTs 超前钳制）/ 匿名事件（无 accountId）可落库 /
 *       events 非数组 400 / admin 未登录 401 / admin 聚合（概览三段、页面 Top、功能 Top、
 *       意图分布、明细与单用户时间线）/ admin 页签静态页含关键区块。
 * 说明：测试口令为脚本内 dummy 值（仅本地临时库），不是任何真实凭据。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), 'analytics_selftest_' + Date.now() + '.db');
process.env.DB_PATH = tmpDb;
const DUMMY_SECRET = ['analytics', 'dummy', 'secret', '2026'].join('-');
process.env.ADMIN_SECRET = DUMMY_SECRET;

const express = require('express');
const db = require('../src/db');
const analyticsRoutes = require('../src/routes/analytics');
const adminRoutes = require('../src/routes/admin');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ ' + msg); }
}

(async () => {
  await db.init();

  const app = express();
  app.use(express.json());
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/admin', adminRoutes);
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const call = (method, p, opts) => {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (opts.cookie) headers.Cookie = opts.cookie;
    return fetch(base + p, {
      method, headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
  };
  const post = async (events) => {
    const res = await call('POST', '/api/analytics/events', { body: { events } });
    return { status: res.status, json: await res.json() };
  };

  try {
    /* ---------- 批量写入 ---------- */
    const now = Date.now();
    let r = await post([
      { event: 'session_start', props: { scene: '1001' }, accountId: 'acc_a', childId: 'c1', sessionId: 's_a1', clientTs: now, appVersion: '1.5.29' },
      { event: 'page_view', props: { path: 'pages/index/index' }, accountId: 'acc_a', childId: 'c1', sessionId: 's_a1', clientTs: now },
      { event: 'page_view', props: { path: 'pages/poster/poster' }, accountId: 'acc_a', childId: 'c1', sessionId: 's_a1', clientTs: now },
      { event: 'feature_click', props: { entry: 'poster' }, accountId: 'acc_a', childId: 'c1', sessionId: 's_a1', clientTs: now },
      { event: 'intent_select', props: { intent: 'poster' }, accountId: 'acc_a', childId: 'c1', sessionId: 's_a1', clientTs: now },
      { event: 'page_view', props: { path: 'pages/index/index' }, accountId: 'acc_b', childId: 'c2', sessionId: 's_b1', clientTs: now }
    ]);
    assert(r.status === 200 && r.json.ok === true, '合法批量上报返回 200 ok');
    assert(r.json.saved === 6 && r.json.dropped === 0 && r.json.truncated === 0, '6 条全落库（saved=6, dropped=0, truncated=0）');

    /* ---------- 校验丢弃 ---------- */
    r = await post([
      { event: '', props: {} },                                            // event 空 → 丢
      { event: 'x'.repeat(65), props: {} },                                // event 超长 → 丢
      { event: 123, props: {} },                                           // event 非字符串 → 丢
      { event: 'page_view', props: 'not-an-object' },                      // props 非对象 → 丢
      { event: 'page_view', props: [1, 2] },                               // props 数组 → 丢
      { event: 'page_view', props: { blob: 'y'.repeat(2100) } },           // props 序列化 >2KB → 丢（blob 被截断 64 后其实不超，见下条说明）
      { event: 'page_view', props: { path: 'pages/my/my' } }               // 合法 → 存
    ]);
    // 说明：blob 值在归一化时先截断到 64 字，序列化后远小于 2KB，会被存下；>2KB 丢弃由下一组多键场景覆盖
    assert(r.json.dropped === 5 && r.json.saved === 2, '非法 event/props 丢弃 5 条、合法 2 条落库（saved=' + r.json.saved + ', dropped=' + r.json.dropped + '）');

    // props >2KB：40 个键 × 64 字值 ≈ 2.8KB → 整条丢弃
    const bigProps = {};
    for (let i = 0; i < 40; i++) bigProps['k' + i] = 'v'.repeat(64);
    r = await post([{ event: 'page_view', props: bigProps }]);
    assert(r.json.saved === 0 && r.json.dropped === 1, 'props 序列化 >2KB 整条丢弃');

    /* ---------- 敏感键剔除 + 标量过滤 + clientTs 钳制 ---------- */
    const future = now + 60 * 60 * 1000;
    r = await post([{
      event: 'task_create',
      props: { by: 'parent', title: '用户任务标题', content: '正文', nested: { a: 1 }, list: [1], long: 'z'.repeat(100), count: 2 },
      accountId: 'acc_a', sessionId: 's_a1', clientTs: future
    }]);
    assert(r.json.saved === 1, '含敏感键的事件本身可落库（键被剔除而非整条丢）');
    const row = await db.getSql("SELECT props, client_ts FROM analytics_events WHERE event = 'task_create' ORDER BY id DESC LIMIT 1");
    const props = JSON.parse(row.props);
    assert(props.by === 'parent' && props.count === 2, '标量 props 保留（by/count）');
    assert(!('title' in props) && !('content' in props) && !('nested' in props) && !('list' in props), '敏感键与对象/数组值被剔除');
    assert(props.long.length === 64, '字符串值截断 64 字');
    assert(row.client_ts <= Date.now() + 1000, 'clientTs 超前被钳到服务器时间');

    /* ---------- 匿名事件 ---------- */
    r = await post([{ event: 'page_view', props: { path: 'pages/tasks/tasks' } }]);
    assert(r.json.saved === 1, '无 accountId 的匿名事件可落库');
    const anon = await db.getSql("SELECT account_id FROM analytics_events WHERE event = 'page_view' AND account_id = '' ORDER BY id DESC LIMIT 1");
    assert(!!anon, '匿名事件 account_id 存空串');

    /* ---------- 单批截断 ---------- */
    const many = Array.from({ length: 60 }, () => ({ event: 'page_view', props: { path: 'pages/exchange/exchange' }, accountId: 'acc_c', sessionId: 's_c1' }));
    r = await post(many);
    assert(r.json.saved === 50 && r.json.truncated === 10, '单批 60 条截断为 50（truncated=10）');

    /* ---------- 入参形态 ---------- */
    let res = await call('POST', '/api/analytics/events', { body: { events: 'nope' } });
    assert(res.status === 400, 'events 非数组返回 400');
    r = await post([]);
    assert(r.status === 200 && r.json.saved === 0, '空数组返回 200 saved=0');

    /* ---------- admin 鉴权 ---------- */
    res = await call('GET', '/api/admin/analytics');
    assert(res.status === 401, '未登录 admin/analytics 返回 401');
    res = await call('POST', '/api/admin/login', { body: { password: DUMMY_SECRET } });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const cookie = setCookie.length ? setCookie[0].split(';')[0] : '';
    assert(res.status === 200 && cookie.indexOf('admin_session=') === 0, 'admin 登录成功发 Cookie');

    /* ---------- admin 聚合 ---------- */
    res = await call('GET', '/api/admin/analytics', { cookie });
    const data = (await res.json()).data || {};
    assert(res.status === 200 && !!data.overview, 'admin/analytics 返回 200 且含 overview');
    // 今日总量：6 + 2（校验组） + 0（大 props 丢） + 1（task_create） + 1（匿名） + 50（截断批） = 60
    assert(data.overview.today.events === 60, '今日事件量 = 60（实际 ' + (data.overview.today || {}).events + '）');
    assert(data.overview.today.users === 3, '今日活跃用户 = 3（acc_a/acc_b/acc_c，匿名不计）');
    assert(data.overview.today.sessions === 3, '今日会话数 = 3（s_a1/s_b1/s_c1）');
    assert(data.overview.yesterday.events === 0 && data.overview.last7d.events === 60, '昨日 0、近 7 天 = 今日 60');
    const pvTop = data.pageViews || [];
    assert(pvTop.length > 0 && pvTop[0].key === 'pages/exchange/exchange' && pvTop[0].count === 50, '页面 Top 第一为 exchange（50 次）');
    assert(pvTop.some(x => x.key === 'pages/index/index' && x.count === 2), '页面 Top 含 index（2 次）');
    const fcTop = data.featureClicks || [];
    assert(fcTop.length === 1 && fcTop[0].key === 'poster' && fcTop[0].count === 1, '功能点击 Top：poster × 1');
    const inTop = data.intents || [];
    assert(inTop.length === 1 && inTop[0].key === 'poster' && inTop[0].count === 1, '意图分布：poster × 1');
    const recent = data.recent || [];
    assert(recent.length === 60, '明细返回最近 100 条上限内的全部 60 条（实际 ' + recent.length + '）');
    assert(recent.every(e => typeof e.maskedAccountId === 'string' && typeof e.propsText === 'string'), '明细带脱敏账号与 props 摘要');

    /* ---------- 单用户时间线 ---------- */
    res = await call('GET', '/api/admin/analytics?accountId=acc_a', { cookie });
    const tl = (await res.json()).data || {};
    assert(tl.timelineFor === 'acc_a', '时间线回带 timelineFor=acc_a');
    assert(tl.recent.length === 6 && tl.recent.every(e => e.accountId === 'acc_a'), 'acc_a 时间线 6 条且全属该用户（实际 ' + tl.recent.length + '）');
    assert(tl.recent[0].event === 'task_create', '时间线按时间倒序（最新为 task_create）');

    /* ---------- admin 页签静态页 ---------- */
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'index.html'), 'utf8');
    assert(html.includes('data-tab="analytics"') && html.includes('行为分析'), 'admin 页含「行为分析」页签按钮');
    assert(html.includes('id="tab-analytics"') && html.includes('id="analyticsCards"') && html.includes('id="analyticsPages"') &&
      html.includes('id="analyticsFeatures"') && html.includes('id="analyticsIntents"') && html.includes('id="analyticsRecent"'),
      'admin 页含行为分析关键区块（概览卡/页面 Top/功能 Top/意图/明细）');
    assert(html.includes('/api/admin/analytics'), 'admin 页调用 /api/admin/analytics');
  } finally {
    srv.close();
    await db.close();
    try { fs.unlinkSync(tmpDb); } catch (e) { /* 忽略 */ }
  }

  console.log('\n自测完成：通过 ' + passed + ' | 失败 ' + failed);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('自测异常:', err);
  process.exit(1);
});
