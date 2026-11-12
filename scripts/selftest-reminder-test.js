/**
* 自测：POST /api/reminder/test（测试提醒）+ 每日精选落点页
* 临时 DB 起真实服务（仅挂 reminder 路由），wx 发送打桩捕获参数。
* 运行：node scripts/selftest-reminder-test.js
*/
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

let passed = 0, failed = 0;
function assert(cond, label) {
if (cond) { passed++; console.log(' ✓', label);}
else { failed++; console.log(' ✗', label);}
}

/* ---------- wx 发送打桩（路由/调度与本脚本共用同一模块对象） ---------- */
const wxapi = require('../src/wxapi');
const sendCalls = [];
let sendBehavior = async () => ({ errcode: 0, errmsg: 'ok'});
wxapi.sendSubscribeMessage = async (opts) => { sendCalls.push(opts); return sendBehavior(opts);};
wxapi.code2session = async () => 'openid_from_code';

const express = require('express');
const db = require('../src/db');
const { TEMPLATES} = require('../src/reminder-config');
const scheduler = require('../src/reminder-scheduler');

function shanghaiDate() {
const p = n => String(n).padStart(2, '0');
const d = new Date(Date.now() + 8 * 3600 * 1000);
return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

async function main() {
await db.init();

/* ---------- 种子 ---------- */
// acc_a：有 openid，开始模板额度 2
await db.addReminderQuota('acc_a', TEMPLATES.start, 'openid_a');
await db.addReminderQuota('acc_a', TEMPLATES.start, 'openid_a');
// acc_b：什么都没有 → NO_OPENID
// acc_c：有 openid 但额度 0 → NO_QUOTA
await db.touchReminderOpenid('acc_c', 'openid_c', [TEMPLATES.start, TEMPLATES.due]);
// acc_d：每日精选目标（钩子 + 额度 1），供落点页断言
const today = shanghaiDate();
await db.replaceReminderDailyHook('acc_d', today, { topicQ: '为什么天会下雨？', scienceTitle: '雨的形成', band: 'low'}, true);
await db.addReminderQuota('acc_d', TEMPLATES.start, 'openid_d');

const app = express();
app.use(express.json());
app.use('/api/reminder', require('../src/routes/reminder'));
const server = await new Promise(r => { const s = app.listen(0, () => r(s));});
const base = 'http://127.0.0.1:' + server.address().port;
const postTest = (accountId) => fetch(base + '/api/reminder/test', {
method: 'POST', headers: { 'Content-Type': 'application/json'},
body: JSON.stringify({ accountId})
}).then(r => r.json());

console.log('');
let before = sendCalls.length;
let r = await postTest('acc_a');
assert(r.ok === true, '发送成功 ok=true');
assert(sendCalls.length === before + 1, 'wx 发送被调用一次');
let call = sendCalls[sendCalls.length - 1];
assert(call.templateId === TEMPLATES.start, '用开始提醒（备忘录）模板');
assert(call.page === 'pages/daily/daily', '落点页为 pages/daily/daily');
assert(call.openid === 'openid_a', 'openid 正确');
assert(call.data.thing1.value === '测试提醒：通道已打通', '标题文案正确');
assert(call.data.thing3.value === '明早 7:30 你会收到今日精选', '温馨提示文案正确');
assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(call.data.time2.value), '时间为当前时间格式');
let sub = await db.getReminderSub('acc_a', TEMPLATES.start);
assert(sub.quota === 1, '成功后额度 2 → 1（扣 1 条）');
assert(r.quota === 1, '响应带回剩余额度 1');
assert(await db.hasSentLog('acc_a', 'test', today), "sent_log 已记 kind='test'");

console.log('');
before = sendCalls.length;
r = await postTest('acc_b');
assert(r.ok === false && r.errcode === 'NO_OPENID', '无 openid → NO_OPENID 且带中文原因: ' + r.msg);
r = await postTest('acc_c');
assert(r.ok === false && r.errcode === 'NO_QUOTA', '额度 0 → NO_QUOTA 且带中文原因: ' + r.msg);
assert(sendCalls.length === before, '被拒绝时不调用 wx 发送');

console.log('');
sendBehavior = async () => ({ errcode: 47003, errmsg: 'argument invalid'});
r = await postTest('acc_a');
assert(r.ok === false && r.errcode === 47003, '微信 47003 原样带回 errcode');
sub = await db.getReminderSub('acc_a', TEMPLATES.start);
assert(sub.quota === 1, '普通失败不扣额度（仍为 1）');
sendBehavior = async () => ({ errcode: 43101, errmsg: 'user refuse'});
r = await postTest('acc_a');
assert(r.ok === false && r.errcode === 43101, '微信 43101 原样带回 errcode');
sub = await db.getReminderSub('acc_a', TEMPLATES.start);
assert(sub.quota === 0, '43101 后本地额度归零对齐');

console.log('');
sendBehavior = async () => ({ errcode: 0, errmsg: 'ok'});
before = sendCalls.length;
await scheduler._scanDailyPush({ date: today, minutes: 7 * 60 + 45});
assert(sendCalls.length === before + 1, '窗口内每日精选发送一条');
call = sendCalls[sendCalls.length - 1];
assert(call.page === 'pages/daily/daily', '每日精选落点为 pages/daily/daily');
// 开始/未完成提醒不传 page（wxapi 默认回落首页）——源码级断言
const schedSrc = fs.readFileSync(path.join(__dirname, '../src/reminder-scheduler.js'), 'utf8');
const startBlock = schedSrc.slice(schedSrc.indexOf('scanStartReminders'), schedSrc.indexOf('scanDueReminders'));
const dueBlock = schedSrc.slice(schedSrc.indexOf('scanDueReminders'), schedSrc.indexOf('scanDailyPush'));
assert(!startBlock.includes('pages/daily') &&!dueBlock.includes('pages/daily'),
'开始/未完成提醒未指定 daily 落点（保持首页默认）');

server.close();
await db.close();
fs.rmSync(tmpDir, { recursive: true, force: true});
console.log('\n自测完成：通过 ' + passed + ' | 失败 ' + failed);
process.exit(failed > 0? 1: 0);
}

main().catch(e => { console.error('自测异常:', e); process.exit(1);});
