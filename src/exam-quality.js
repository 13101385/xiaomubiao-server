'use strict';
/**
* 试卷质量管线（生成后复核 / 修复 / 归一化）
*
* 职责：
* 1. 结构校验：选项数量/重复、答案越界、判断题答案规范、解析 analysis 必须存在；
* 2. 程序化验算：「最接近/大约」类算术题直接算出表达式的值，核对最近选项（双解也判错）；
* 3. 语文纯净筛查：语文卷题干/选项/答案/解析禁止混入英文单词（汉语拼音音节除外）；
* 4. AI 盲解复核：让模型独立作答客观题，与给定答案比对（双解/错答即判不合格）；
* 5. 修复闭环：不合格题自动重出（≤2 次）→ 仍不过则丢弃并换一道新题 → 再不过才丢弃；
* 6. 总分归一化：按题型权重配分后调整单题分值，保证全卷总分恒为 100。
*
* AI 调用通过注入的 callJson(prompt) 完成（返回解析后的 JSON），便于测试替身。
*/

const TYPE_NAMES = {
choice: '选择题', fill: '填空题', trueFalse: '判断题',
shortAnswer: '简答题', calculation: '计算题', essay: '作文题'
};
/** 题型基础权重（与 exam.js 历史配分口径一致） */
const BASE_SCORES = { choice: 2, fill: 2, trueFalse: 1, shortAnswer: 8, calculation: 10, essay: 30};
const OBJECTIVE_TYPES = ['choice', 'trueFalse', 'fill'];

/* ==================== 文本规范化 ==================== */

function normText(s) {
return String(s == null? '': s)
.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
.replace(/\s+/g, '')
.replace(/[。．.]$/, '')
.trim();
}

/** 判断题答案归一：对/正确/√/是 → '对'；错/错误/×/否 → '错'；无法识别返回 '' */
function normTrueFalse(s) {
const t = normText(s).toLowerCase();
if (['对', '正确', '√', '是', 'true', 't', 'yes'].includes(t)) return '对';
if (['错', '错误', '×', 'x', '否', 'false', 'f', 'no'].includes(t)) return '错';
if (/^(对|正确)/.test(t)) return '对';
if (/^(错|错误)/.test(t)) return '错';
return '';
}

/** 选择题答案归一为选项下标（0 基）；无法解析返回 -1 */
function normChoiceIndex(answer, optionCount) {
const t = String(answer == null? '': answer).trim().toUpperCase();
const m = t.match(/[A-Z]/);
if (m) {
const idx = m[0].charCodeAt(0) - 65;
return idx >= 0 && idx < optionCount? idx: -1;
}
const n = parseInt(t, 10);
if (!isNaN(n) && n >= 1 && n <= optionCount) return n - 1;
return -1;
}

/* ==================== 选项前缀净化（2026-11-15 评测修复 #2） ==================== */

/**
 * 剥离选项文本自带的字母序号前缀（「A. 」「A、」「(A)」「（A）」等）。
 * 渲染层（详情页/PDF/HTML）会统一再加一遍前缀，不剥离就会出现「A. A. 山」。
 * 只剥带分隔符的前缀，英文选项正文（如 "A cat"）不受影响。
 */
function stripOptionPrefix(text) {
let t = String(text == null? '': text);
for (let n = 0; n < 2; n++) {
const m = t.match(/^\s*(?:[（(]\s*[A-Da-d]\s*[)）]\s*[、．.·]?\s*|[A-Da-d]\s*[、．.]\s*)/);
if (!m || t.slice(m[0].length).trim() === '') break;
t = t.slice(m[0].length);
}
return t.trim();
}

/** 就地净化整卷所有选择题 options（幂等） */
function cleanExamOptions(exam) {
(exam.sections || []).forEach(sec => {
(sec.questions || []).forEach(q => {
if (Array.isArray(q.options)) q.options = q.options.map(stripOptionPrefix);
});
});
return exam;
}

/* ==================== 题型配比学科净化（2026-11-15 评测修复 #4） ==================== */

const COUNT_KEYS = ['choice', 'fill', 'trueFalse', 'shortAnswer', 'calculation', 'essay'];

/**
 * 计算题仅限数学学科：非数学学科收到 calculation 时剔除并等量补位到简答题
 * （题数总量不变，家长无感知缺额）。返回 { counts, moved }。
 */
function sanitizeCountsForSubject(subject, counts) {
const out = {};
COUNT_KEYS.forEach(k => { out[k] = Math.max(0, Number(counts && counts[k]) || 0);});
let moved = 0;
if (subject!== '数学' && out.calculation > 0) {
moved = out.calculation;
out.shortAnswer += moved;
out.calculation = 0;
}
return { counts: out, moved};
}

/* ==================== 年级/册次难度护栏（2026-11-15 评测修复 #3/#5） ==================== */

const GRADE_NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6};
function gradeBandOf(grade) {
const m = String(grade || '').match(/([一二三四五六])年级/);
return m? (GRADE_NUM[m[1]] || 0): 0;
}

/**
 * 按 学科×年级×册次 生成提示词红线（返回字符串数组）。
 * 依据课标常识：低年级英语无时态语法、低年级写作量分级、册次内容不得超前。
 */
function gradeGuardrails(subject, grade, term) {
const lines = [];
const band = gradeBandOf(grade);
if (term === '上册') {
lines.push('本卷只考【上册】已经学过的内容，严禁出现下册/下学期才学的内容（如下册才学的运算、课文与知识点）。');
} else if (term === '下册') {
lines.push('本卷按【下册】进度命题（可少量复习上册），严禁出现下一学年才学的内容。');
}
if (subject === '英语') {
if (band === 1) {
lines.push('一年级英语只考听说词汇、字母和简单口语：禁止任何时态语法（现在进行时、一般过去时、第三人称单数变化等），禁止 be 动词/动词形式填空类语法题；判断题只判断内容对错、不考语法对错；简答题参考答案最多 1 句或单词/短语级，禁止「至少写 N 句」类写作要求。');
} else if (band === 2) {
lines.push('二年级英语不考任何时态语法与动词变形；简答题参考答案不超过 2 句。');
} else if (band === 3) {
lines.push('三年级英语不考一般过去时、将来时，不考名词性物主代词（hers/theirs 等）四年级以后内容；简答题参考答案不超过 3 句。');
} else if (band > 0) {
lines.push('英语命题不得超出本年级课标的语法与词汇范围，不得把高年级的成段写作要求下放到本年级。');
}
}
if (subject === '语文' && band > 0 && band <= 2) {
lines.push('涉及笔顺/笔画顺序的题目：必须按《现代汉语通用字笔顺规范》逐笔核对后再写答案；解析中如写出笔顺，必须与答案完全一致，不得凭印象编造。');
}
return lines;
}

/* ==================== 笔顺工具（2026-11-15 评测修复 #6） ==================== */

/* 笔画名称（长名在前，贪心最长匹配） */
const STROKE_NAMES = ['竖折折钩', '横折折钩', '横折弯钩',
'竖弯钩', '横折钩', '竖折钩', '横折弯', '横撇', '竖钩', '竖弯', '弯钩', '卧钩', '斜钩', '撇折', '撇点', '横折', '竖折', '横钩',
'横', '竖', '撇', '捺', '点', '提', '折', '钩'];

/**
 * 从文本中抽取笔顺序列（笔画全称数组）。
 * 只取「笔顺」二字之后、句号/分号之前的一段，避免正文里散落的横/竖等字误触发。
 */
function strokeSequence(text) {
let s = String(text || '');
const idx = s.indexOf('笔顺');
if (idx >= 0) s = s.slice(idx + 2);
s = s.split(/[。；;！!？?\n]/)[0];
const seq = [];
let i = 0;
while (i < s.length) {
const hit = STROKE_NAMES.find(n => s.startsWith(n, i));
if (hit) { seq.push(hit); i += hit.length;}
else i++;
}
return seq;
}

/** 是否笔顺/笔画顺序类题目 */
function isStrokeQuestion(q) {
if (!q) return false;
return /笔顺|笔画顺序|书写顺序/.test(String(q.q || '') + ' ' + String(q.answer || ''));
}

/* ==================== 语文英文筛查 ==================== */

/* 汉语拼音音节表（无声调），语文卷出现这些拉丁字母组合视为拼音、放行 */
const PINYIN = new Set(('a o e ai ei ao ou an en ang eng er ' +
'ba bo bai bei bao ban ben bang beng bi bie biao bian bin bing bu ' +
'pa po pai pei pao pou pan pen pang peng pi pie piao pian pin ping pu ' +
'ma mo me mai mei mao mou man men mang meng mi mie miao miu mian min ming mu ' +
'fa fo fei fou fan fen fang feng fu ' +
'da de dai dei dao dou dan den dang deng di die diao diu dian ding du duo dui duan dun dong ' +
'ta te tai tao tou tan tang teng ti tie tiao tian ting tu tuo tui tuan tun tong ' +
'na ne nai nei nao nou nan nen nang neng ni nie niao niu nian nin niang ning nu nuo nuan nun nong nv nve lve ' +
'la le lai lei lao lou lan lang leng li lia lie liao liu lian lin liang ling lu luo luan lun long ' +
'ga ge gai gei gao gou gan gen gang geng gu gua guo guai gui guan gun guang gong ' +
'ka ke kai kao kou kan ken kang keng ku kua kuo kuai kui kuan kun kuang kong ' +
'ha he hai hei hao hou han hen hang heng hu hua huo huai hui huan hun huang hong ' +
'ji jia jie jiao jiu jian jin jiang jing ju jue juan jun jiong ' +
'qi qia qie qiao qiu qian qin qiang qing qu que quan qun qiong ' +
'xi xia xie xiao xiu xian xin xiang xing xu xue xuan xun xiong ' +
'zha zhe zhi zhai zhei zhao zhou zhan zhen zhang zheng zhu zhua zhuo zhuai zhui zhuan zhun zhuang zhong ' +
'cha che chi chai chao chou chan chen chang cheng chu chua chuo chuai chui chuan chun chuang chong ' +
'sha she shi shai shei shao shou shan shen shang sheng shu shua shuo shuai shui shuan shun shuang ' +
're ri rao rou ran ren rang reng ru ruo rui ruan run rong ' +
'za ze zi zai zei zao zou zan zen zang zeng zu zuo zui zuan zun zong ' +
'ca ce ci cai cao cou can cen cang ceng cu cuo cui cuan cun cong ' +
'sa se si sai sao sou san sen sang seng su suo sui suan sun song ' +
'ya ye yao you yan yang yi yin ying yu yue yuan yun yong wu wa wo wai wei wan wen wang weng ' +
'b p m f d t n l g k h j q x zh ch sh r z c s y w ü ve').split(/\s+/));

/** 找出文本中的英文单词（≥2 个拉丁字母组成的词元，拼音音节不算） */
function findEnglishWords(text) {
// 先去掉拼音声调符（NFD 分解 + 剥离组合附加符），避免 shàng 被声调符切成 sh/ng 碎片误报
const plain = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const tokens = plain.match(/[A-Za-z]{2,}/g) || [];
return tokens.filter(tok =>!PINYIN.has(tok.toLowerCase()));
}

/** 语文卷单题英文混入检查（题干/选项/答案/解析） */
function hasEnglishViolation(q) {
const parts = [q.q, q.answer, q.analysis].concat(Array.isArray(q.options)? q.options: []);
return parts.some(p => findEnglishWords(p).length > 0);
}

/* ==================== 程序化算术验算 ==================== */

/** 安全求值四则运算表达式（仅允许数字与 + - × ÷ x * / ().） */
function evalExpr(expr) {
const s = String(expr || '').replace(/×/g, '*').replace(/÷/g, '/').replace(/x|X/g, '*');
if (!/^[0-9.+\-*/()]+$/.test(s) || s.length > 60) return null;
let pos = 0;
const peek = () => s[pos];
function parseExpr() {
let v = parseTerm();
while (peek() === '+' || peek() === '-') { const op = s[pos++]; const r = parseTerm(); v = op === '+'? v + r: v - r;}
return v;
}
function parseTerm() {
let v = parseFactor();
while (peek() === '*' || peek() === '/') { const op = s[pos++]; const r = parseFactor(); v = op === '*'? v * r: v / r;}
return v;
}
function parseFactor() {
if (peek() === '(') { pos++; const v = parseExpr(); if (peek() === ')') pos++; return v;}
if (peek() === '-') { pos++; return -parseFactor();}
let num = '';
while (pos < s.length && /[0-9.]/.test(s[pos])) num += s[pos++];
if (!num) throw new Error('bad expr');
return parseFloat(num);
}
try {
const v = parseExpr();
if (pos < s.length && s.slice(pos).trim()!== '') return null;
return isFinite(v)? v: null;
} catch (e) { return null;}
}

/** 从选项文本中抽取第一个数值 */
function optionNumber(opt) {
const m = String(opt || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
return m? parseFloat(m[0]): null;
}

/**
* 「最接近/大约/约等于」类选择题程序化验算
* @returns {'ok'|'bad'|null} null=不适用（非此类题/选项非数值/表达式取不到）
*/
function checkClosestQuestion(q) {
if (!/最接近|大约|约等于|近似值/.test(String(q.q || ''))) return null;
if (!Array.isArray(q.options) || q.options.length < 2) return null;
const nums = q.options.map(optionNumber);
if (nums.some(v => v === null)) return null;
// 抽取题干中最长的算术表达式（要求至少含一个运算符）
const cleaned = String(q.q).replace(/[（(]\s*[）)]/g, '');
const cands = cleaned.match(/\d[\d.+\-×÷xX*/()]*\d|\d+(\.\d+)?\s*[+\-×÷xX*/]\s*\d+(\.\d+)?/g) || [];
let value = null;
for (const c of cands) {
if (!/[+\-×÷xX*/]/.test(c)) continue;
const v = evalExpr(c.trim());
if (v!== null) { value = v; break;}
}
if (value === null) return null;
const dists = nums.map(v => Math.abs(v - value));
const min = Math.min(...dists);
const winners = dists.filter(d => Math.abs(d - min) < 1e-9).length;
if (winners!== 1) return 'bad'; // 并列最近 = 双解
const answerIdx = normChoiceIndex(q.answer, q.options.length);
if (answerIdx < 0) return 'bad';
return dists[answerIdx] === min? 'ok': 'bad';
}

/* ==================== 结构校验 ==================== */

/**
* 单题规则校验，返回问题数组（空=通过）
* opts: { subject}
*/
function structuralIssues(q, type, opts) {
const issues = [];
if (!q ||!String(q.q || '').trim()) issues.push('题干为空');
if (!q ||!String(q.analysis || '').trim() || String(q.analysis).trim().length < 4) {
issues.push('缺少解析');
}
if (type === 'choice') {
const options = Array.isArray(q.options)? q.options: [];
if (options.length < 3) issues.push('选择题选项不足');
const norm = options.map(o => normText(o));
if (new Set(norm).size!== norm.length) issues.push('选项重复');
if (normChoiceIndex(q.answer, options.length) < 0) issues.push('答案不在选项范围内');
const closest = checkClosestQuestion(q);
if (closest === 'bad') issues.push('验算题答案与计算结果不符或双解');
}
if (type === 'trueFalse') {
if (normTrueFalse(q.answer) === '') issues.push('判断题答案不规范');
}
if (type === 'fill' || type === 'shortAnswer' || type === 'calculation') {
if (!String(q.answer || '').trim()) issues.push('缺少参考答案');
}
if (opts && opts.subject === '语文' && q && hasEnglishViolation(q)) {
issues.push('语文题混入英文单词');
}
if (opts && opts.subject === '语文' && q && isStrokeQuestion(q)) {
// 笔顺题：答案与解析若都写了笔顺序列，必须逐笔一致（防解析编造笔顺，评测 P2）
const aSeq = strokeSequence(q.answer);
const anSeq = strokeSequence(q.analysis);
if (aSeq.length >= 2 && anSeq.length >= 2 && aSeq.join('/')!== anSeq.join('/')) {
issues.push('解析中的笔顺与答案不一致');
}
}
return issues;
}

/* ==================== 总分归一化（恒为 100） ==================== */

/**
* 按题型权重配分并做整数归一化，保证全卷总分恰好 100。
* 每题分值 ≥1；最大余数法分配，余数调整落在权重最大的题上。
* 同步回写 section.scorePer（同题型分值一致时）与 section.instructions。
*/
function normalizeScores(exam) {
const sections = (exam.sections || []).filter(s => Array.isArray(s.questions) && s.questions.length);
const flat = [];
sections.forEach(sec => sec.questions.forEach(q => flat.push({ q, sec, base: BASE_SCORES[sec.type] || Number(sec.scorePer) || 2})));
if (!flat.length) { exam.totalScore = 0; return exam;}
const W = flat.reduce((a, f) => a + f.base, 0);
flat.forEach(f => { f.raw = (100 * f.base) / W; f.score = Math.max(1, Math.floor(f.raw)); f.rem = f.raw - Math.floor(f.raw);});
let sum = flat.reduce((a, f) => a + f.score, 0);
// 补差：按余数从大到小 +1；扣差：从权重最大且分值>1 的题 -1
const byRem = [...flat].sort((a, b) => b.rem - a.rem);
let i = 0;
while (sum < 100) { byRem[i % byRem.length].score++; sum++; i++;}
const byBase = [...flat].sort((a, b) => b.base - a.base || b.score - a.score);
i = 0;
while (sum > 100) {
const f = byBase[i % byBase.length];
if (f.score > 1) { f.score--; sum--;}
i++;
if (i > byBase.length * 200) break;
}
flat.forEach(f => { f.q.score = f.score;});
sections.forEach(sec => {
const scores = sec.questions.map(q => q.score);
const secTotal = scores.reduce((a, b) => a + b, 0);
sec.scorePer = scores.every(s => s === scores[0])? scores[0]: null;
sec.totalScore = secTotal;
sec.instructions = `${sec.name}共${sec.questions.length}小题，共${secTotal}分`;
});
exam.totalScore = flat.reduce((a, f) => a + f.score, 0);
return exam;
}

/* ==================== AI 盲解复核 ==================== */

function buildVerifyPrompt(items, ctx) {
const lines = items.map((it, i) => {
const q = it.q;
let s = `---Q${i + 1}--- 题型：${TYPE_NAMES[it.type] || it.type}\n题目：${q.q}`;
if (it.type === 'choice' && Array.isArray(q.options)) {
s += '\n选项：' + q.options.map((o, oi) => String.fromCharCode(65 + oi) + '. ' + o).join('；');
}
return s;
}).join('\n\n');
return `你是资深${ctx.grade}${ctx.subject}教师。请独立解答下面每道客观题（不要臆测命题人的答案，自己认真算/想），判断每题的正确答案。
要求：
- 选择题：给出唯一正确选项字母；如果有两个或以上选项都正确，answer 写成 "A,C" 这样的多字母形式（如实标注双解）。
- 判断题：answer 写 "对" 或 "错"。
- 填空题：answer 写应填入的内容（只要核心答案，不要单位赘述之外的解释）。
- 笔顺/笔画顺序题：按《现代汉语通用字笔顺规范》独立写出完整笔顺序列（笔画全称，如：竖钩、横撇、撇、捺），不要只写画数。

只输出严格 JSON，不要任何其他文字：
{ "results": [ { "i": 1, "answer": "B"}, { "i": 2, "answer": "对"}]}
其中 i 与题号对应。

${lines}`;
}

/** 盲解答案与给定答案比对 */
function verifyOne(item, solved) {
const q = item.q;
if (solved == null || solved === '') return false;
if (item.stroke) {
// 笔顺题（填空/简答/计算等自由文本题型）：逐笔比对笔顺序列；抽不出序列视为未复核（null）
const aSeq = strokeSequence(q.answer);
const bSeq = strokeSequence(solved);
if (aSeq.length < 2 || bSeq.length < 2) return null;
return aSeq.join('/') === bSeq.join('/');
}
if (item.type === 'choice') {
const letters = String(solved).toUpperCase().match(/[A-Z]/g) || [];
if (letters.length!== 1) return false; // 双解/无解
const idx = normChoiceIndex(q.answer, (q.options || []).length);
return idx === letters[0].charCodeAt(0) - 65;
}
if (item.type === 'trueFalse') {
const a = normTrueFalse(q.answer);
const b = normTrueFalse(solved);
return a!== '' && a === b;
}
if (item.type === 'fill') {
const a = normText(q.answer).replace(/^(答[:：])/, '');
const b = normText(solved).replace(/^(答[:：])/, '');
if (!a ||!b) return false;
return a === b || (a.length >= 2 && b.includes(a)) || (b.length >= 2 && a.includes(b));
}
return true;
}

/**
* 批量盲解复核客观题。items: [{type, q, ref}]，callJson: (prompt)=>Promise<obj>
* @returns {Promise<Map>} ref -> true(通过)/false(不通过)/null(未能复核，网络或解析失败)
*/
async function verifyObjectiveBatch(items, callJson, ctx) {
const verdicts = new Map();
const CHUNK = 10;
for (let s = 0; s < items.length; s += CHUNK) {
const chunk = items.slice(s, s + CHUNK);
let results = null;
try {
const out = await callJson(buildVerifyPrompt(chunk, ctx));
if (out && Array.isArray(out.results)) results = out.results;
} catch (e) { /* 本批记为未复核 */}
chunk.forEach((it, i) => {
const key = it.ref !== undefined ? it.ref : it.q;
if (!results) { verdicts.set(key, null); return;}
const r = results.find(x => Number(x.i) === i + 1);
verdicts.set(key, r? verifyOne(it, r.answer): null);
});
}
return verdicts;
}

/* ==================== 解析补齐 ==================== */

function buildAnalysisPrompt(items, ctx) {
const lines = items.map((it, i) => {
const q = it.q;
let s = `---Q${i + 1}--- ${q.q}\n参考答案：${q.answer}`;
if (it.type === 'choice' && Array.isArray(q.options)) {
s += '\n选项：' + q.options.map((o, oi) => String.fromCharCode(65 + oi) + '. ' + o).join('；');
}
return s;
}).join('\n\n');
return `你是资深${ctx.grade}${ctx.subject}教师。请为下面每道题写一句简明解析（1~2 句，讲清思路或依据，面向学生）。
只输出严格 JSON，不要任何其他文字：
{ "results": [ { "i": 1, "analysis": "解析内容"}]}

${lines}`;
}

async function fillMissingAnalysis(items, callJson, ctx) {
const missing = items.filter(it =>!String(it.q.analysis || '').trim());
if (!missing.length) return 0;
try {
const out = await callJson(buildAnalysisPrompt(missing, ctx));
const results = out && Array.isArray(out.results)? out.results: [];
let filled = 0;
missing.forEach((it, i) => {
const r = results.find(x => Number(x.i) === i + 1);
if (r && String(r.analysis || '').trim().length >= 4) {
it.q.analysis = String(r.analysis).trim();
filled++;
}
});
return filled;
} catch (e) {
return 0;
}
}

/* ==================== 单题重出 ==================== */

function buildRegenPrompt(spec, ctx, avoidReason) {
const typeName = TYPE_NAMES[spec.type] || spec.type;
const noEnglish = ctx.subject === '语文'
? '\n这是语文试卷：题干、选项、答案、解析中禁止出现任何英文单词（汉语拼音除外）。'
: '';
const guards = gradeGuardrails(ctx.subject, ctx.grade, ctx.term);
const guardText = guards.length? '\n【难度与范围红线】\n' + guards.map(g => '- ' + g).join('\n'): '';
const shape = spec.type === 'choice'
? '{ "q": "题目", "options": ["选项1","选项2","选项3","选项4"], "answer": "A", "analysis": "解析"}'
: '{ "q": "题目", "answer": "参考答案", "analysis": "解析"}';
return `你是资深${ctx.grade}${ctx.subject}命题教师。为「${ctx.grade}·${ctx.subject}」重新命制 1 道${typeName}（难度：${ctx.difficulty}，知识点：${ctx.knowledge || '该年级核心知识点'}）。
上一道同类题不合格，原因：${avoidReason}。请换一道题（不要与常见题重复），确保：
- 答案唯一且绝对正确（自己先验算一遍）；选择题 4 个选项、只有一个正确，其余选项要似是而非但明确错误；
- 必须带 analysis 解析（1~2 句讲清思路）；
- 选择题 options 只写选项内容本身，禁止带 "A."、"A、"、"(A)" 等字母序号前缀；
- 判断题 answer 只能写 "对" 或 "错"。${noEnglish}${guardText}
只输出严格 JSON（单个题目对象），不要任何其他文字：
${shape}`;
}

async function regenQuestion(spec, callJson, ctx, avoidReason) {
const out = await callJson(buildRegenPrompt(spec, ctx, avoidReason));
const q = out && (out.question || out);
if (!q ||!String(q.q || '').trim()) throw new Error('重出题目为空');
return q;
}

/* ==================== 主管线 ==================== */

/**
* 对整卷执行：补解析 → 规则校验 → 客观题盲解复核 → 不合格重出/换题/丢弃 → 总分归一化
* @param {object} exam AI 原始试卷（含 sections）
* @param {object} ctx { subject, grade, difficulty, knowledge}
* @param {function} callJson (prompt) => Promise<object>
* @returns {Promise<{ exam, report}>}
*/
async function processExam(exam, ctx, callJson) {
const report = { verified: 0, verifySkipped: 0, regenerated: 0, replaced: 0, dropped: 0, analysisFilled: 0, strokeChecked: 0, issues: []};
// 0) 选项前缀净化（幂等，先于一切校验/复核）
cleanExamOptions(exam);
const allItems = [];
(exam.sections || []).forEach(sec => {
(sec.questions || []).forEach(q => allItems.push({ type: sec.type, q, sec}));
});

// 1) 先补齐缺失解析（减少无谓重出）
report.analysisFilled = await fillMissingAnalysis(allItems, callJson, ctx);

// 2) 客观题盲解复核（语文笔顺题——含计算/简答等自由文本题型——一并纳入，评测 P1 漏检教训）
const objective = allItems.filter(it => OBJECTIVE_TYPES.includes(it.type)
|| (ctx.subject === '语文' && isStrokeQuestion(it.q)));
objective.forEach(it => {
if (!OBJECTIVE_TYPES.includes(it.type)) { it.stroke = true; report.strokeChecked++;}
});
const verdicts = await verifyObjectiveBatch(objective, callJson, ctx);
const badReason = new Map(); // item -> reason
objective.forEach(it => {
const v = verdicts.get(it.q);
if (v === true) report.verified++;
else if (v === null) report.verifySkipped++;
else badReason.set(it, '盲解复核未通过（答案错误或双解）');
});

// 3) 规则校验（全部题型）
allItems.forEach(it => {
const issues = structuralIssues(it.q, it.type, { subject: ctx.subject});
if (issues.length &&!badReason.has(it)) badReason.set(it, issues.join('；'));
else if (issues.length) badReason.set(it, badReason.get(it) + '；' + issues.join('；'));
});

// 4) 修复闭环：重出 ≤2 次 → 换题 1 次 → 丢弃
for (const [item, reason] of [...badReason.entries()]) {
let fixed = null;
let lastReason = reason;
for (let attempt = 1; attempt <= 2 &&!fixed; attempt++) {
try {
const nq = await regenQuestion(item, callJson, ctx, lastReason);
const issues = structuralIssues(nq, item.type, { subject: ctx.subject});
if (issues.length) { lastReason = issues.join('；'); continue;}
if (OBJECTIVE_TYPES.includes(item.type) || item.stroke) {
const v = await verifyObjectiveBatch([{ type: item.type, q: nq, ref: nq, stroke: !!item.stroke }], callJson, ctx);
if (v.get(nq)!== true) { lastReason = '重出题盲解复核未通过'; continue;}
}
fixed = nq;
report.regenerated++;
} catch (e) { lastReason = '重出失败：' + e.message;}
}
if (!fixed) {
// 换题：换考法重新命制一次
try {
const nq = await regenQuestion(item, callJson, ctx, lastReason + '。请换一个考法/情境重新命题');
const issues = structuralIssues(nq, item.type, { subject: ctx.subject});
let ok =!issues.length;
if (ok && (OBJECTIVE_TYPES.includes(item.type) || item.stroke)) {
const v = await verifyObjectiveBatch([{ type: item.type, q: nq, ref: nq, stroke: !!item.stroke }], callJson, ctx);
ok = v.get(nq) === true;
}
if (ok) { fixed = nq; report.replaced++;}
} catch (e) { /* 换题失败则丢弃 */}
}
if (fixed) {
// 就地替换（保持题目顺序与引用）
const idx = item.sec.questions.indexOf(item.q);
if (idx >= 0) item.sec.questions[idx] = fixed;
} else {
const idx = item.sec.questions.indexOf(item.q);
if (idx >= 0) item.sec.questions.splice(idx, 1);
report.dropped++;
report.issues.push(`丢弃不合格题（${TYPE_NAMES[item.type] || item.type}）：${String(item.q.q || '').slice(0, 40)}`);
}
}

// 5) 清理空板块 + 总分归一化（恒 100）
exam.sections = (exam.sections || []).filter(s => Array.isArray(s.questions) && s.questions.length > 0);
normalizeScores(exam);
return { exam, report};
}

module.exports = {
TYPE_NAMES, BASE_SCORES,
normText, normTrueFalse, normChoiceIndex,
stripOptionPrefix, cleanExamOptions,
sanitizeCountsForSubject, gradeGuardrails, gradeBandOf,
strokeSequence, isStrokeQuestion,
findEnglishWords, hasEnglishViolation,
evalExpr, checkClosestQuestion,
structuralIssues, normalizeScores,
verifyObjectiveBatch, fillMissingAnalysis, regenQuestion,
processExam
};
