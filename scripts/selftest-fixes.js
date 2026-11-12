'use strict';
/**
* 三缺陷修复自测：
* Part 1 —— exam-quality 纯逻辑单元断言（归一化/英文筛查/验算/结构校验）
* Part 2 —— processExam 修复闭环（脚本化 AI 替身：错答被重出、无解析被补齐、顽固坏题被丢弃、语文混英文被重出）
* Part 3 —— 真实服务 E2E：本地起后端 + 假 Agnes（出题/生图端点替身，
* 其中手抄报方案与插画用的是真实 AI 产物：成品库模板方案 + 真实 hero 图），
* 走 generate-image → 详情 → /cover → /pdf 与 exam/generate → 详情 全链路。
* 用法: node scripts/selftest-fixes.js
*/
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn} = require('child_process');

let passed = 0, failed = 0;
function assert(cond, msg) {
if (cond) { passed++; console.log(' ✓ ' + msg);}
else { failed++; console.log(' ✗ ' + msg);}
}
const Q = require('../src/exam-quality');

/* ================= Part 1：纯逻辑 ================= */
function part1() {
console.log('\n');
// 总分归一化：多种题型组合恒为 100
const mixes = [
{ choice: 10, fill: 10, trueFalse: 10},
{ choice: 5, shortAnswer: 2, essay: 1},
{ calculation: 3},
{ choice: 1},
{ choice: 7, fill: 3, trueFalse: 5, shortAnswer: 2, calculation: 2, essay: 1}
];
mixes.forEach((mix, mi) => {
const exam = { sections: Object.entries(mix).map(([type, n]) => ({
type, name: Q.TYPE_NAMES[type],
questions: Array.from({ length: n}, (_, i) => ({ q: '题' + i, answer: 'A', analysis: '解析内容'}))
}))};
Q.normalizeScores(exam);
const total = exam.sections.flatMap(s => s.questions).reduce((a, q) => a + q.score, 0);
assert(total === 100 && exam.totalScore === 100, `组合${mi + 1} 总分恒为 100（实际 ${total}）`);
assert(exam.sections.flatMap(s => s.questions).every(q => q.score >= 1), `组合${mi + 1} 每题分值 ≥1`);
});

// 英文筛查
assert(Q.findEnglishWords('小明去 school 上学').join() === 'school', '英文单词 school 被检出');
assert(Q.findEnglishWords('看拼音写汉字：shàng xué').length === 0, '汉语拼音不误报');
assert(Q.findEnglishWords('这是一道纯中文题目').length === 0, '纯中文不误报');

// 结构校验
const dup = Q.structuralIssues({ q: '题', options: ['1', '1', '2', '3'], answer: 'A', analysis: '解析内容'}, 'choice', {});
assert(dup.some(s => s.includes('重复')), '选项重复被检出');
const noAna = Q.structuralIssues({ q: '题', options: ['1', '2', '3', '4'], answer: 'A'}, 'choice', {});
assert(noAna.some(s => s.includes('解析')), '缺少解析被检出');
const badTf = Q.structuralIssues({ q: '地球是圆的', answer: '应该是吧', analysis: '解析内容'}, 'trueFalse', {});
assert(badTf.some(s => s.includes('判断题')), '判断题答案不规范被检出');
const engQ = Q.structuralIssues({ q: '请用 school 造句', options: ['甲', '乙', '丙', '丁'], answer: 'A', analysis: '解析内容'}, 'choice', { subject: '语文'});
assert(engQ.some(s => s.includes('英文')), '语文题混英文被检出');
const engMath = Q.structuralIssues({ q: '请用 school 造句', options: ['甲', '乙', '丙', '丁'], answer: 'A', analysis: '解析内容'}, 'choice', { subject: '数学'});
assert(!engMath.some(s => s.includes('英文')), '非语文卷不做英文筛查');

// 程序化验算（最接近类）
const okQ = { q: '3.98×25 的结果最接近（ ）', options: ['90', '100', '110', '95'], answer: 'B', analysis: '解析'};
assert(Q.checkClosestQuestion(okQ) === 'ok', '验算题正确答案通过（3.98×25≈99.5→100）');
const badQ = { q: '3.98×25 的结果最接近（ ）', options: ['90', '100', '110', '95'], answer: 'A', analysis: '解析'};
assert(Q.checkClosestQuestion(badQ) === 'bad', '验算题错误答案被检出');
const tieQ = { q: '2.5×10 的结果最接近（ ）', options: ['20', '30', '24', '26'], answer: 'A', analysis: '解析'};
// 2.5×10=25，与 20/30 距离都是 5 → 双解判 bad（注：24/26 距离为 1 更近，此例实际最近是 24/26 并列）
assert(Q.checkClosestQuestion(tieQ) === 'bad', '验算题并列最近（双解）被检出');
const normalQ = { q: '3+4 等于几？', options: ['6', '7', '8', '9'], answer: 'B', analysis: '解析'};
assert(Q.checkClosestQuestion(normalQ) === null, '普通题不触发验算');
assert(Q.evalExpr('3.98*25') === 99.5 && Q.evalExpr('(2+3)*4') === 20, '表达式求值正确');
}

/* ================= Part 2：修复闭环（脚本化替身） ================= */
function solverFor(prompt) {
// 盲解替身：按题干标记给独立答案
const blocks = prompt.split(/---Q\d+---/).slice(1);
const table = [
['3+4', 'B'], ['5×6', 'A'], ['7×8', 'B'], ['7+5', 'B'], ['2×9', 'A'], ['9×9', 'A'], ['10-4', '6'],
['法国的首都是', 'A']
];
return { results: blocks.map((b, i) => {
const hit = table.find(([mark]) => b.includes(mark));
return { i: i + 1, answer: hit? hit[1]: 'A'};
})};
}

async function part2() {
console.log('\n');
let regenCount = 0;
const fake = async (prompt) => {
if (prompt.includes('独立解答')) return solverFor(prompt);
if (prompt.includes('简明解析')) {
const blocks = prompt.split(/---Q\d+---/).slice(1);
return { results: blocks.map((_, i) => ({ i: i + 1, analysis: '结合题干一步步推导即可得出答案。'}))};
}
if (prompt.includes('重新命制')) {
regenCount++;
if (regenCount === 1) {
// 第一次重出（给 5×6 错答题）：返回好题
return { q: '2×9等于几？', options: ['18', '16', '20', '12'], answer: 'A', analysis: '二九十八，2×9=18。'};
}
// 之后（顽固题 7×8 的两次重出 + 一次换题）：都返回同一道自带错答的题
return { q: '9×9等于几？', options: ['81', '72', '90', '99'], answer: 'B', analysis: '九九八十一。'};
}
throw new Error('未预期的 prompt');
};

const exam = {
title: '三年级数学测试', subject: '数学', grade: '小学三年级',
sections: [
{ type: 'choice', name: '选择题', questions: [
{ q: '3+4等于几？', options: ['6', '7', '8', '9'], answer: 'B', analysis: '3+4=7。'},
{ q: '5×6等于几？', options: ['30', '25', '35', '40'], answer: 'B', analysis: '五六三十，5×6=30。'},
{ q: '7×8等于几？', options: ['54', '56', '48', '64'], answer: 'A', analysis: '七八五十六。'}
]},
{ type: 'fill', name: '填空题', questions: [
{ q: '10-4=（ ）', answer: '6'} // 缺解析，应被自动补齐
]}
]
};
const { exam: out, report} = await Q.processExam(exam, { subject: '数学', grade: '小学三年级', difficulty: '中等', knowledge: '乘法'}, fake);
const all = out.sections.flatMap(s => s.questions);
assert(all.every(q => String(q.analysis || '').trim().length >= 4), '修复后每题都有解析');
assert(all.some(q => q.q.includes('2×9')), '错答题 5×6 已被重出为 2×9');
assert(!all.some(q => q.q.includes('7×8')), '顽固错答题 7×8 已被丢弃');
assert(report.regenerated === 1 && report.dropped === 1, `报告计数正确（重出 ${report.regenerated} / 丢弃 ${report.dropped}）`);
assert(report.analysisFilled === 1, '缺失解析被自动补齐 1 道');
assert(out.totalScore === 100, '修复后总分恒为 100');

// 语文场景：混英文题被重出为纯中文题
const fakeCn = async (prompt) => {
if (prompt.includes('独立解答')) return solverFor(prompt);
if (prompt.includes('简明解析')) return { results: []};
if (prompt.includes('重新命制')) {
return { q: '法国的首都是哪里？', options: ['巴黎', '伦敦', '柏林', '罗马'], answer: 'A', analysis: '法国的首都是巴黎。'};
}
throw new Error('未预期的 prompt');
};
const examCn = {
title: '语文测试', subject: '语文', grade: '小学三年级',
sections: [{ type: 'choice', name: '选择题', questions: [
{ q: '下面哪个词是学校的意思？', options: ['school', '老师', '同学', '教室'], answer: 'A', analysis: '学校对应选项一。'}
]}]
};
const r2 = await Q.processExam(examCn, { subject: '语文', grade: '小学三年级', difficulty: '中等', knowledge: '词语'}, fakeCn);
const allCn = r2.exam.sections.flatMap(s => s.questions);
assert(allCn.length === 1 &&!Q.hasEnglishViolation(allCn[0]), '语文混英文题已被重出为纯中文题');
assert(r2.exam.totalScore === 100, '语文卷总分恒为 100');
}

/* ================= Part 3：真实服务 E2E ================= */
const APP_PORT = 18099, FAKE_PORT = 18999;
const templates = require('../scripts/poster-library/templates.json');
const fangPlan = templates.find(t => t.theme === '防溺水');

function fakeAgnes(req, res) {
let body = '';
req.on('data', c => body += c);
req.on('end', () => {
const send = (obj) => {
res.writeHead(200, { 'Content-Type': 'application/json'});
res.end(JSON.stringify(obj));
};
if (req.url === '/hero.png') {
const buf = fs.readFileSync('/home/hatch/workspace/projects/poster-library-v2/assets/fangnishui-hero.png');
res.writeHead(200, { 'Content-Type': 'image/png'});
return res.end(buf);
}
if (req.url.includes('/images/generations')) {
return send({ data: [{ url: `http://127.0.0.1:${FAKE_PORT}/hero.png`}]});
}
let payload = {};
try { payload = JSON.parse(body || '{}');} catch (e) {}
const userMsg = ((payload.messages || []).find(m => m.role === 'user') || {}).content || '';
const chat = (obj) => send({ choices: [{ message: { content: typeof obj === 'string'? obj: JSON.stringify(obj)}}]});
if (userMsg.includes('请为小学主题手抄报设计一份完整方案')) return chat(fangPlan);
if (userMsg.includes('独立解答')) return chat(solverFor(userMsg));
if (userMsg.includes('简明解析')) {
const blocks = userMsg.split(/---Q\d+---/).slice(1);
return chat({ results: blocks.map((_, i) => ({ i: i + 1, analysis: '结合题干一步步推导即可得出答案。'}))});
}
if (userMsg.includes('重新命制')) {
return chat({ q: '2×9等于几？', options: ['18', '16', '20', '12'], answer: 'A', analysis: '二九十八，2×9=18。'});
}
if (userMsg.includes('生成一份')) {
// 缺陷试卷：5×6 错答、7+5 缺解析、分值随意
return chat({
title: '小学三年级·数学试卷', subject: '数学', grade: '小学三年级', difficulty: '中等', durationMin: 60,
sections: [
{ name: '选择题', type: 'choice', scorePer: 3, instructions: '选择题共3小题', questions: [
{ q: '3+4等于几？', options: ['6', '7', '8', '9'], answer: 'B', analysis: '3+4=7。', score: 3},
{ q: '5×6等于几？', options: ['30', '25', '35', '40'], answer: 'B', analysis: '五六三十。', score: 3},
{ q: '7+5等于几？', options: ['11', '12', '13', '14'], answer: 'B', score: 3}
]},
{ name: '填空题', type: 'fill', scorePer: 3, instructions: '填空题共1小题', questions: [
{ q: '10-4=（ ）', answer: '6', analysis: '10-4=6。', score: 3}
]}
]
});
}
res.writeHead(500, { 'Content-Type': 'application/json'});
res.end(JSON.stringify({ error: 'fake agnes: unexpected request ' + req.url}));
});
}

function httpJson(method, url, bodyObj) {
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
resolve({ status: res.statusCode, headers: res.headers, buf, json});
});
});
r.on('error', reject);
if (data) r.write(data);
r.end();
});
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function part3() {
console.log('\n');
const fake = http.createServer(fakeAgnes);
await new Promise(r => fake.listen(FAKE_PORT, r));
const dbFile = '/tmp/selftest-fixes.db';
try { fs.unlinkSync(dbFile);} catch (e) {}
const app = spawn('node', ['src/index.js'], {
cwd: path.join(__dirname, '..'),
env: Object.assign({}, process.env, {
PORT: String(APP_PORT), DB_PATH: dbFile,
AGNES_AI_API_KEY: 'selftest-key',
AGNES_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/v1`
}),
stdio: ['ignore', 'pipe', 'pipe']
});
let appLog = '';
app.stdout.on('data', d => appLog += d);
app.stderr.on('data', d => appLog += d);
try {
// 等服务起来
let up = false;
for (let i = 0; i < 40 &&!up; i++) {
try { const h = await httpJson('GET', `http://127.0.0.1:${APP_PORT}/health`); up = h.status === 200;} catch (e) { await sleep(300);}
}
assert(up, '本地后端启动成功');
if (!up) { console.log(appLog.slice(-800)); return;}

/* ---- 手抄报自由生图全链路 ---- */
const gen = await httpJson('POST', `http://127.0.0.1:${APP_PORT}/api/poster/generate-image`, {
accountId: 'selftest', theme: '防溺水', grade: '小学三年级'
});
assert(gen.json && gen.json.ok &&!!gen.json.composedUrl, 'generate-image 返回成功且带 composedUrl');
const pid = gen.json && gen.json.posterId;
const detail = await httpJson('GET', `http://127.0.0.1:${APP_PORT}/api/poster/${pid}?accountId=selftest`);
assert(detail.json && detail.json.poster && detail.json.poster.composedUrl === gen.json.composedUrl,
'详情接口返回 composedUrl（合成图为正式交付）');
assert(detail.json.poster.content && detail.json.poster.content.hasPlan === true, '记录含完整文字方案');
const cover = await httpJson('GET', `http://127.0.0.1:${APP_PORT}/api/poster/${pid}/cover?accountId=selftest`);
assert(cover.status === 200 && (cover.headers['content-type'] || '').includes('image/jpeg') && cover.buf.length > 100000,
'/cover 直接返回合成成品图（JPEG，' + cover.buf.length + 'B）');
fs.writeFileSync('/tmp/e2e-composed-fangnishui.jpg', cover.buf);
const composedDirect = await httpJson('GET', `http://127.0.0.1:${APP_PORT}/api/poster/composed/${pid}.jpg`);
assert(composedDirect.status === 200 && composedDirect.buf.equals(cover.buf), '/composed 与 /cover 返回同一张成品图');
const pdf = await httpJson('GET', `http://127.0.0.1:${APP_PORT}/api/poster/${pid}/pdf?accountId=selftest`);
assert(pdf.status === 200 && pdf.buf.slice(0, 4).toString() === '%PDF' && pdf.buf.length > 200000,
'PDF 导出成功且嵌入合成成品图（' + pdf.buf.length + 'B）');

/* ---- 试卷生成全链路 ---- */
const egen = await httpJson('POST', `http://127.0.0.1:${APP_PORT}/api/exam/generate`, {
accountId: 'selftest', subject: '数学', grade: '小学三年级', difficulty: '中等', choice: 3, fill: 1
});
assert(egen.json && egen.json.ok, 'exam/generate 返回成功');
const ed = await httpJson('GET', `http://127.0.0.1:${APP_PORT}/api/exam/${egen.json.examId}?accountId=selftest`);
const content = ed.json && ed.json.exam && ed.json.exam.content;
const allQ = content? content.sections.flatMap(s => s.questions): [];
assert(allQ.length === 4, '试卷题量保持 4 道（实际 ' + allQ.length + '）');
assert(allQ.every(q => String(q.analysis || '').trim().length >= 4), '每道题都带解析 analysis');
assert(!allQ.some(q => q.q.includes('5×6')), '错答题 5×6 已被复核重出');
assert(allQ.some(q => q.q.includes('2×9') && q.answer === 'A'), '重出题 2×9 答案正确');
const total = allQ.reduce((a, q) => a + (q.score || 0), 0);
assert(total === 100 && content.totalScore === 100, '全卷总分恒为 100（实际 ' + total + '）');
assert(content.quality && content.quality.regenerated === 1, '质量报告记录重出 1 道');
console.log(' 质量报告:', JSON.stringify(content.quality));
} finally {
app.kill('SIGKILL');
fake.close();
try { fs.unlinkSync(dbFile);} catch (e) {}
}
}

(async () => {
part1();
await part2();
await part3();
console.log('\n' + '='.repeat(50));
console.log(`自测完成：通过 ${passed} | 失败 ${failed}`);
console.log('='.repeat(50));
process.exit(failed > 0? 1: 0);
})().catch(e => { console.error('自测异常:', e); process.exit(1);});
