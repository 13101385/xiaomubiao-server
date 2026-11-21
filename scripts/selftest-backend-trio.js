'use strict';
/**
* 后端三件自测（2026-11-22 全量冲刺后端补齐）：
* PM-39 —— POST /api/poster/save 对 source='image' 的模板保存放行无 grade（落库空串），
* 其余路径仍须合法年级；
* PM-28 —— 试卷独立 code：存量卷下发懒回填、列表/详情带 code、按 code 查卷仍校验归属
* （不是本人的卷 404）、html 导出 code 口径（code 与 id 对上放行、串码 404）；
* PM-91 —— /word-audio/ 静态托管：单词 mp3、例句 mp3、配图 png 可访问，不存在的文件 404。
* 用法: node scripts/selftest-backend-trio.js
*/
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync} = require('child_process');

let passed = 0, failed = 0;
function assert(cond, msg) {
if (cond) { passed++; console.log(' ✓ ' + msg);}
else { failed++; console.log(' ✗ ' + msg);}
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const APP_PORT = 18131;
const DB_FILE = '/tmp/selftest-backend-trio.db';
const BASE = `http://127.0.0.1:${APP_PORT}`;

function httpReq(method, url, bodyObj) {
return new Promise((resolve, reject) => {
const u = new URL(url);
const data = bodyObj? JSON.stringify(bodyObj): null;
const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
headers: data? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data)}: {}}, res => {
const cs = [];
res.on('data', c => cs.push(c));
res.on('end', () => {
const buf = Buffer.concat(cs);
let json = null;
try { json = JSON.parse(buf.toString());} catch (e) {}
resolve({ status: res.statusCode, headers: res.headers, text: buf.toString(), json});
});
});
r.on('error', reject);
if (data) r.write(data);
r.end();
});
}

/* ---------- 种子：两份存量试卷（一份无 code、一份预置 code 且属他人） ---------- */
function seed() {
try { fs.unlinkSync(DB_FILE);} catch (e) {}
const seedFile = '/tmp/selftest-backend-trio-seed.js';
fs.writeFileSync(seedFile, `
const db = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'db'))});
(async () => {
await db.init();
const content = JSON.stringify({ title: '存量卷', subject: '数学', grade: '小学三年级', durationMin: 60,
sections: [{ name: '选择题', questions: [{ q: '1+1等于几？', options: ['1', '2'], answer: '2', score: 2}]}]});
await db.createExam({ id: 'exam_legacy1', accountId: 'accA', openId: '', subject: '数学', grade: '小学三年级',
title: '存量卷', config: '{}', content, status: 'ready', failReason: '', code: '', createdAt: Date.now() - 1000});
await db.createExam({ id: 'exam_other1', accountId: 'accB', openId: '', subject: '数学', grade: '小学三年级',
title: '他人卷', config: '{}', content, status: 'ready', failReason: '', code: 'xc_presetb1234567', createdAt: Date.now()});
process.exit(0);
})().catch(e => { console.error(e); process.exit(1);});
`);
execFileSync('node', [seedFile], { env: Object.assign({}, process.env, { DB_PATH: DB_FILE}), stdio: 'inherit'});
}

async function waitHealth(timeoutMs) {
const t0 = Date.now();
while (Date.now() - t0 < timeoutMs) {
try {
const r = await httpReq('GET', BASE + '/health');
if (r.status === 200) return true;
} catch (e) {}
await sleep(300);
}
return false;
}

(async () => {
/* ---- PM-28 纯函数口径 ---- */
const examRoute = require('../src/routes/exam');
const c1 = examRoute.genExamCode(), c2 = examRoute.genExamCode();
assert(/^xc_[0-9a-f]{16}$/.test(c1), 'PM-28：genExamCode 格式 xc_+16 位 hex');
assert(c1!== c2, 'PM-28：genExamCode 两次不重样');

/* ---- PM-91 文件落位 ---- */
const audioDir = path.join(__dirname, '..', 'word-audio');
const mp3s = fs.readdirSync(audioDir).filter(f => f.endsWith('.mp3'));
const imgs = fs.readdirSync(path.join(audioDir, 'img')).filter(f => f.endsWith('.png'));
assert(mp3s.length === 240, 'PM-91：word-audio 落位 240 个 mp3（实数 ' + mp3s.length + '）');
assert(imgs.length === 21, 'PM-91：word-audio/img 落位 21 张词卡配图（实数 ' + imgs.length + '）');

seed();
const app = spawn('node', ['src/index.js'], {
cwd: path.join(__dirname, '..'),
env: Object.assign({}, process.env, { PORT: String(APP_PORT), DB_PATH: DB_FILE}),
stdio: 'pipe'
});
let serverLog = '';
app.stdout.on('data', d => { serverLog += d;});
app.stderr.on('data', d => { serverLog += d;});

try {
assert(await waitHealth(20000), '服务启动成功（/health 200）');

/* ================= PM-39 ================= */
console.log('\n');
let r = await httpReq('POST', BASE + '/api/poster/save', {
accountId: 'accA', theme: '保护地球', source: 'image',
content: { title: '保护地球手抄报', variant: 'color', libraryId: 'lib1', imageUrl: 'https://example.com/p.png'}
});
assert(r.status === 200 && r.json && r.json.ok && r.json.posterId, 'PM-39：source=image 无 grade 保存成功（不再被 400 拒）');

r = await httpReq('POST', BASE + '/api/poster/save', {
accountId: 'accA', theme: '节约粮食', source: 'image', grade: '乱填的年级',
content: { title: '节约粮食手抄报'}
});
assert(r.status === 200 && r.json && r.json.ok, 'PM-39：source=image 带非法 grade 同样放行');

r = await httpReq('POST', BASE + '/api/poster/save', {
accountId: 'accA', theme: '读书', content: { title: '读书手抄报'}
});
assert(r.status === 400, 'PM-39：无 source 无 grade 的普通保存仍被 400 拒（口径不变）');

r = await httpReq('POST', BASE + '/api/poster/save', {
accountId: 'accA', theme: '读书', grade: '九年级', content: { title: '读书手抄报'}
});
assert(r.status === 400, 'PM-39：普通保存带非法年级仍被 400 拒');

r = await httpReq('POST', BASE + '/api/poster/save', {
accountId: 'accA', theme: '读书', grade: '小学三年级', content: { title: '读书手抄报', sections: []}
});
assert(r.status === 200 && r.json && r.json.ok, 'PM-39：普通保存带合法年级正常通过');

r = await httpReq('GET', BASE + '/api/poster/list?accountId=accA');
const plist = (r.json && r.json.data && r.json.data.list) || [];
const imgRec = plist.find(p => p.theme === '保护地球');
const tplRec = plist.find(p => p.theme === '读书');
assert(!!imgRec && imgRec.grade === '' && imgRec.source === 'image', 'PM-39：image 保存记录落库 grade 为空串、source=image');
assert(!!tplRec && tplRec.grade === '小学三年级' && tplRec.source === 'template', 'PM-39：普通保存记录 grade/source 口径不变');

/* ================= PM-28 ================= */
console.log('\n');
r = await httpReq('GET', BASE + '/api/exam/list?accountId=accA');
const list = (r.json && r.json.data && r.json.data.list) || [];
const legacy = list.find(x => x.id === 'exam_legacy1');
assert(!!legacy && /^xc_[0-9a-f]{16}$/.test(legacy.code || ''), 'PM-28：存量卷列表下发时懒回填 code');
const code = legacy && legacy.code;

r = await httpReq('GET', `${BASE}/api/exam/${code}?accountId=accA`);
assert(r.status === 200 && r.json && r.json.exam && r.json.exam.id === 'exam_legacy1' && r.json.exam.code === code,
'PM-28：按 code 查卷（本人）成功且回带 code');

r = await httpReq('GET', `${BASE}/api/exam/${code}?accountId=accB`);
assert(r.status === 404, 'PM-28：按 code 查卷（他人）返回 404（code 不是通行证）');

r = await httpReq('GET', BASE + '/api/exam/exam_legacy1?accountId=accA');
assert(r.status === 200 && r.json.exam.code === code, 'PM-28：原 id 路径不受影响且 code 稳定不重复生成');

r = await httpReq('GET', BASE + '/api/exam/exam_legacy1?accountId=accB');
assert(r.status === 404, 'PM-28：原 id 路径他人仍 404');

r = await httpReq('GET', BASE + '/api/exam/exam_other1?accountId=accB');
assert(r.status === 200 && r.json.exam.code === 'xc_presetb1234567', 'PM-28：已有 code 的试卷不被回填覆盖');

r = await httpReq('GET', `${BASE}/api/exam/exam_legacy1/html?code=${code}`);
assert(r.status === 200 && String(r.headers['content-type']).includes('text/html') && r.text.includes('1+1'),
'PM-28：html 导出 code 口径（不带 accountId）可打开');

r = await httpReq('GET', BASE + '/api/exam/exam_legacy1/html?code=xc_presetb1234567');
assert(r.status === 404, 'PM-28：html 串用他人试卷 code 返回 404');

r = await httpReq('GET', BASE + '/api/exam/exam_legacy1/html');
assert(r.status === 400, 'PM-28：html 无 accountId 无 code 仍 400');

r = await httpReq('GET', BASE + '/api/exam/exam_legacy1/html?accountId=accB');
assert(r.status === 404, 'PM-28：html 他人 accountId 仍 404');

/* ================= PM-91 ================= */
console.log('\n');
r = await httpReq('GET', BASE + '/word-audio/animals-01.mp3');
assert(r.status === 200 && String(r.headers['content-type']).includes('audio'), 'PM-91：单词音频可访问（animals-01.mp3）');

r = await httpReq('GET', BASE + '/word-audio/animals-01-ex.mp3');
assert(r.status === 200, 'PM-91：例句音频可访问（animals-01-ex.mp3）');

r = await httpReq('GET', BASE + '/word-audio/img/animals-03.png');
assert(r.status === 200 && String(r.headers['content-type']).includes('image/png'), 'PM-91：词卡配图可访问（img/animals-03.png）');

r = await httpReq('GET', BASE + '/word-audio/nope-99.mp3');
assert(r.status === 404, 'PM-91：不存在的音频返回 404');
} finally {
app.kill('SIGKILL');
try { fs.unlinkSync(DB_FILE);} catch (e) {}
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) { console.log(serverLog.slice(-2000)); process.exit(1);}
})().catch(e => { console.error(e); process.exit(1);});
