/**
 * 试卷路由
 * 提供：AI 生成试卷（agnes）、试卷列表、详情、删除、图片导出
 * 依赖：环境变量 AGNES_AI_API_KEY（agnes API 凭证）
 */
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();
const { config } = require('../config');
const db = require('../db');
const examQuality = require('../exam-quality');
const path = require('path');
const fs = require('fs');
const Jimp = require('jimp');
const PDFDocument = require('pdfkit');

const DAILY_LIMIT = 20; // 每账号每日生成上限（防 API 费用失控）

/* ==================== 参数定义 ==================== */

const SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '政治'];
const GRADES = ['小学一年级', '小学二年级', '小学三年级', '小学四年级', '小学五年级', '小学六年级', '初中一年级', '初中二年级', '初中三年级'];
const DIFFICULTY = ['简单', '中等', '困难'];
// PM-51：单元范围白名单（与前端 utils/exam.js 的 UNIT_RANGES 同口径，改一处须同步另一处）
const UNIT_RANGES = ['全部单元', '第 1–2 单元', '第 1–4 单元', '第 5–8 单元'];
const QUESTION_TYPES = ['选择题', '填空题', '判断题', '简答题', '计算题', '作文题'];

/* ==================== agnes 调用 ==================== */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 可重试的上游错误：429 限流 / 5xx / 网络与超时 / 内容解析失败（换一次采样可能成功） */
function isRetryableAgnesError(err) {
  if (!err) return false;
  const msg = err.message || '';
  if (msg.includes('未配置')) return false; // 配置缺失重试无用
  const status = err.response && err.response.status;
  if (status) return status === 429 || status >= 500;
  if (err.code) return true; // ECONNRESET / ETIMEDOUT 等网络类
  return /解析失败|未返回内容/.test(msg);
}

/**
 * 调用 agnes（带退避重试，最多 3 次）。
 * 评测实测单次调用成功率仅 56%（429 为主），无重试时家长点一次失败一次。
 */
async function callAgnes(prompt) {
  const delays = [1500, 4000];
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await callAgnesOnce(prompt);
    } catch (e) {
      lastErr = e;
      if (attempt < 2 && isRetryableAgnesError(e)) {
        console.warn(`[EXAM] agnes 调用失败（第 ${attempt + 1} 次），${delays[attempt]}ms 后重试：${e.message}`);
        await sleep(delays[attempt]);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * 调用 agnes（OpenAI 兼容）生成试卷（单次）
 */
async function callAgnesOnce(prompt) {
  const { apiKey, baseURL, model, timeoutMs } = config.agnes;
  if (!apiKey) {
    throw new Error('服务器未配置 AGNES_AI_API_KEY');
  }
  const resp = await axios.post(baseURL + '/chat/completions', {
    model,
    messages: [
      {
        role: 'system',
        content: '你是一位资深的中小学命题教师，精通中国课程标准，擅长编写规范、准确、有梯度的试卷。你只输出严格 JSON，不输出任何其他文字、markdown 或解释。'
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.8,
    max_tokens: 8192
  }, {
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    timeout: timeoutMs
  });

  const content = resp.data && resp.data.choices && resp.data.choices[0]
    ? (resp.data.choices[0].message && resp.data.choices[0].message.content) || ''
    : '';
  if (!content) {
    throw new Error('AI 未返回内容');
  }
  return parseJson(content);
}

/** 健壮解析 AI 返回的 JSON（剥离围栏、修复裸换行等常见问题） */
function parseJson(text) {
  let t = String(text).trim();
  // 去掉 ```json ... ``` 围栏
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start > -1 && end > start) {
    t = t.slice(start, end + 1);
  }
  // 1) 直接解析
  try {
    return JSON.parse(t);
  } catch (e) { /* 继续尝试修复 */ }
  // 2) 修复字符串值内的裸换行/制表符后再解析
  try {
    const fixed = t.replace(/"((?:[^"\\]|\\.)*)"/g, (m, inner) =>
      '"' + inner.replace(/\r\n/g, '\\n').replace(/\r/g, '\\n').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"'
    );
    return JSON.parse(fixed);
  } catch (e) { /* 继续 */ }
  throw new Error('AI 返回内容解析失败（返回内容不是有效 JSON）');
}

/* ==================== Prompt 构造 ==================== */

function buildPrompt(params) {
  const {
    subject, grade, knowledge, difficulty = '中等',
    choice = 0, fill = 0, trueFalse = 0, shortAnswer = 0, calculation = 0, essay = 0,
    durationMin = 60, term = '', unitRange = '全部单元'
  } = params;

  // 各题型分值
  const scoreMap = {
    choice: { score: 2, name: '选择题' },
    fill: { score: 2, name: '填空题' },
    trueFalse: { score: 1, name: '判断题' },
    shortAnswer: { score: 8, name: '简答题' },
    calculation: { score: 10, name: '计算题' },
    essay: { score: 30, name: '作文题' }
  };

  const sections = [];
  if (choice > 0) sections.push({ type: 'choice', count: choice, ...scoreMap.choice });
  if (fill > 0) sections.push({ type: 'fill', count: fill, ...scoreMap.fill });
  if (trueFalse > 0) sections.push({ type: 'trueFalse', count: trueFalse, ...scoreMap.trueFalse });
  if (shortAnswer > 0) sections.push({ type: 'shortAnswer', count: shortAnswer, ...scoreMap.shortAnswer });
  if (calculation > 0) sections.push({ type: 'calculation', count: calculation, ...scoreMap.calculation });
  if (essay > 0) sections.push({ type: 'essay', count: essay, ...scoreMap.essay });

  const sectionDesc = sections.map(s =>
    `${s.name} ${s.count} 题，每题 ${s.score} 分`
  ).join('；');

  const noEnglish = subject === '语文'
    ? '\n【特别注意】这是语文试卷：所有题干、选项、答案、解析中禁止出现任何英文单词（汉语拼音除外）。'
    : '';

  const guards = examQuality.gradeGuardrails(subject, grade, term);
  const guardText = guards.length
    ? '\n【难度与范围红线（务必逐条遵守）】\n' + guards.map(g => '- ' + g).join('\n')
    : '';

  return `为「${grade}·${subject}」生成一份${difficulty}难度试卷。
知识点：${knowledge || '该年级核心知识点'}${term ? '\n册次：' + term + '（只考' + term + '已学内容）' : ''}${unitRange && unitRange !== '全部单元' ? '\n单元范围：' + unitRange + '（只考该范围内的单元内容，超出该范围的单元一律不许出）' : ''}
时长：${durationMin}分钟。

【必须严格生成的题型和数量】
${sectionDesc || '（未选择任何题型）'}

【命题质量要求（务必逐条落实）】
- 每道题都必须带 "analysis" 解析字段（1~2 句，讲清解题思路或依据），不许省略。
- 每道题答案必须唯一且绝对正确：出题后自己先验算/核对一遍；选择题 4 个选项只有一个正确，其余似是而非但明确错误，绝不许出现两个都对的选项。
- 判断题的 answer 只能写 "对" 或 "错"；填空题 answer 写应填入的内容；只有选择题才有 options 字段。
- 选择题的 options 只写选项内容本身，禁止带 "A."、"A、"、"(A)" 等字母序号前缀（序号由系统统一添加）。${noEnglish}${guardText}

【JSON格式】只输出JSON，不要任何其他文字：
{
  "title": "试卷标题",
  "subject": "${subject}",
  "grade": "${grade}",
  "difficulty": "${difficulty}",
  "durationMin": ${durationMin},
  "sections": [
    ${sections.map(s => `{
      "name": "${s.name}",
      "type": "${s.type}",
      "scorePer": ${s.score},
      "instructions": "${s.name}共${s.count}小题",
      "questions": [
        ${Array(s.count).fill('{ "q": "题目", "options": ["选项1","选项2","选项3","选项4"], "answer": "A", "analysis": "解析", "score": ' + s.score + ' }').join(',\n        ')}
      ]
    }`).join(',\n    ')}
  ]
}`;
}

/* ==================== 缺额补题（2026-11-15 评测修复 #5） ==================== */

const TYPE_ORDER = ['choice', 'fill', 'trueFalse', 'shortAnswer', 'calculation', 'essay'];

/**
 * 质量管线丢题后，按题型缺额自动补出（每题型最多 2 轮）。
 * 补出的题走同一条质量管线（净化→校验→盲解复核→重出/丢弃）才并入整卷。
 * @returns {Promise<number>} 实际补入题数
 */
async function topUpExam(exam, effCounts, ctx, callJson) {
  let topped = 0;
  for (const type of TYPE_ORDER) {
    const want = Number(effCounts[type]) || 0;
    if (!want) continue;
    const secOf = () => exam.sections.find(s => s.type === type);
    let deficit = want - ((secOf() && secOf().questions) || []).length;
    for (let round = 0; round < 2 && deficit > 0; round++) {
      const existing = exam.sections.flatMap(s => (s.questions || []).map(q => String(q.q || '').slice(0, 30)));
      const fragParams = {
        subject: ctx.subject, grade: ctx.grade, knowledge: ctx.knowledge,
        difficulty: ctx.difficulty, term: ctx.term, unitRange: ctx.unitRange, durationMin: 60,
        choice: 0, fill: 0, trueFalse: 0, shortAnswer: 0, calculation: 0, essay: 0
      };
      fragParams[type] = deficit;
      const prompt = buildPrompt(fragParams)
        + '\n【补题要求】这是为同一份试卷补出的题目，不得与以下已有题目重复或雷同：\n'
        + (existing.length ? existing.join('；') : '（无）');
      let frag = null;
      try { frag = await callJson(prompt); } catch (e) { break; }
      const secIn = frag && Array.isArray(frag.sections)
        ? frag.sections.find(s => Array.isArray(s.questions) && s.questions.length)
        : null;
      if (!secIn) break;
      const fragExam = {
        sections: [{
          name: examQuality.TYPE_NAMES[type], type,
          scorePer: examQuality.BASE_SCORES[type],
          questions: secIn.questions.slice(0, deficit)
        }]
      };
      try {
        await examQuality.processExam(fragExam, ctx, callJson);
      } catch (e) { break; /* 补题管线异常：本轮补题整批不用 */ }
      const got = (fragExam.sections[0] && fragExam.sections[0].questions) || [];
      if (!got.length) break;
      let target = secOf();
      if (!target) {
        target = { name: examQuality.TYPE_NAMES[type], type, scorePer: examQuality.BASE_SCORES[type], questions: [] };
        exam.sections.push(target);
      }
      const take = got.slice(0, deficit); // 只补缺额，不因补题产生超额
      take.forEach(q => target.questions.push(q));
      topped += take.length;
      deficit -= take.length;
    }
  }
  if (topped > 0) {
    // 板块按题型标准顺序重排 + 全卷重新归一化
    exam.sections.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
    examQuality.normalizeScores(exam);
  }
  return topped;
}

/* ==================== 路由 ==================== */

// PM-87：同一账号同时生成中的试卷上限（防连点/滥用烧上游额度）
const MAX_GENERATING_PER_ACCOUNT = 3;

// QA 5 轮第 1 轮：同一份试卷的失败重试次数上限。重试不新建记录、不计每日限额，
// 无上限时可对同一份 failed 无限重试绕过 DAILY_LIMIT 烧上游调用，故按份封顶。
const MAX_EXAM_RETRIES = 5;

// QA 5 轮第 1 轮：提交临界区串行化——「查限额/并发计数 → 落库/翻转状态」必须原子，
// 否则多份齐发会同时通过计数检查、突破并发上限（实测 6 齐发被接受 4 份）。
// 单进程部署下一条模块级 promise 链即可；临界区只含 DB 读写，不含生成本身。
let submitChain = Promise.resolve();
function withSubmitLock(fn) {
  const run = submitChain.then(fn, fn);
  submitChain = run.catch(() => {});
  return run;
}

/** PM-87：把内部错误转成家长可读的失败原因（落 failed 状态时展示，并给重试入口） */
function friendlyFailReason(err) {
  const msg = (err && err.message) || '生成失败';
  if (msg.includes('未配置')) return '出题服务暂时不可用，请稍后再试';
  if (msg.includes('429') || /rate limit/i.test(msg)) return '出题服务正忙，请稍后重试';
  if (msg.includes('解析失败') || msg.includes('未返回内容') || msg.includes('缺少题目')) return '这次没生成成功，请重试';
  if (msg.includes('无可用题目')) return '这次题目质量没过关，请重试';
  return '生成失败：' + msg.slice(0, 80);
}

/**
 * PM-87：异步生成主体（与请求连接脱钩，detached 执行）：
 * 完成后回填题目转 ready；任何失败转 failed 并写明原因。内部重试沿用 callAgnes
 * 的退避重试（1.5s/4s、最多 3 次尝试，INS-129 的服务端侧口径）。
 * @param record 已落库的 generating 记录（含 id/accountId/config 等）
 * @param eff 已净化的生效参数（counts/term/unitRange 已定版）
 */
async function runGeneration(record, eff) {
  const { subject, grade, knowledge, difficulty, durationMin, counts, moved, termVal, unitRangeVal, totalQuestions } = eff;
  try {
    const prompt = buildPrompt({ subject, grade, knowledge, difficulty, durationMin, term: termVal, unitRange: unitRangeVal, ...counts });
    const exam = await callAgnes(prompt);

    // 校验返回结构
    if (!exam.sections || !Array.isArray(exam.sections) || !exam.sections.length) {
      throw new Error('AI 返回的试卷缺少题目');
    }
    // 板块 type 兜底校正（以请求参数的题型顺序为准，避免 AI 写错 type 影响配分/复核）
    const requestedTypes = ['choice', 'fill', 'trueFalse', 'shortAnswer', 'calculation', 'essay']
      .filter(t => (Number(counts[t]) || 0) > 0);
    exam.sections.forEach((sec, i) => {
      if (!examQuality.BASE_SCORES[sec.type] && requestedTypes[i]) sec.type = requestedTypes[i];
      if (!sec.name) sec.name = examQuality.TYPE_NAMES[sec.type] || '题目';
    });

    // 质量管线：补解析 → 规则校验 → 客观题盲解复核 → 不合格重出/换题/丢弃 → 总分归一化（恒 100）
    const ctx = { subject, grade, difficulty, knowledge, term: termVal, unitRange: unitRangeVal };
    try {
      const { report } = await examQuality.processExam(exam, ctx, (p) => callAgnes(p));
      exam.quality = report;
      console.log('[EXAM] 质量复核完成:', JSON.stringify(report));
    } catch (qErr) {
      // 管线异常不阻断交付，但选项净化与总分归一化必须执行
      console.error('[EXAM] 质量管线异常（降级归一化）:', qErr.message);
      examQuality.cleanExamOptions(exam);
      examQuality.normalizeScores(exam);
    }

    // 缺额补题：管线丢弃后按题型缺额自动补出到请求数量（补不齐则如实带 missing）
    let toppedUp = 0;
    try {
      toppedUp = await topUpExam(exam, counts, ctx, (p) => callAgnes(p));
      if (exam.quality) exam.quality.toppedUp = toppedUp;
    } catch (tErr) {
      console.error('[EXAM] 补题异常（按实际题量交付）:', tErr.message);
    }

    const deliveredQuestions = exam.sections.reduce((a, s) => a + (s.questions || []).length, 0);
    if (!deliveredQuestions) {
      throw new Error('试卷质量复核后无可用题目，请重试');
    }
    exam.delivery = {
      requested: totalQuestions, delivered: deliveredQuestions,
      missing: Math.max(0, totalQuestions - deliveredQuestions), toppedUp,
      crossSubjectMoved: moved, term: termVal, unitRange: unitRangeVal
    };

    await db.updateExamReady(record.id, exam.title || (grade + '·' + subject + '试卷'), JSON.stringify(exam));
    console.log('[EXAM] 异步生成完成:', record.id, 'delivered', deliveredQuestions, '/', totalQuestions);
  } catch (err) {
    console.error('[EXAM] 异步生成失败:', record.id, err.message);
    try { await db.updateExamFailed(record.id, friendlyFailReason(err)); } catch (e) { /* 落状态失败只记日志 */ }
  }
}

/** 由已落库记录的 config 重建生效参数（失败重试与首次提交共用同一条生成管线） */
function effFromConfig(row) {
  let cfg = {};
  try { cfg = JSON.parse(row.config || '{}'); } catch (e) {}
  const counts = cfg.counts || { choice: 0, fill: 0, trueFalse: 0, shortAnswer: 0, calculation: 0, essay: 0 };
  const totalQuestions = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
  return {
    subject: row.subject, grade: row.grade,
    knowledge: cfg.knowledge || '', difficulty: cfg.difficulty || '中等',
    durationMin: cfg.durationMin || 60, counts, moved: 0,
    termVal: cfg.term || '', unitRangeVal: cfg.unitRange || '全部单元', totalQuestions
  };
}

/** PM-28：试卷分享 code——与 exam id 独立的随机标识，分享链接只带它、绝不带 accountId */
function genExamCode() {
  return 'xc_' + crypto.randomBytes(8).toString('hex');
}

/** PM-28：存量试卷 code 懒回填——下发前 code 为空则生成并落库（老卷原 id 路径不受影响） */
async function ensureExamCode(row) {
  if (row && !row.code) {
    const code = genExamCode();
    try {
      await db.setExamCode(row.id, code);
      row.code = code;
    } catch (e) {
      console.warn('[EXAM] code 回填失败（不阻塞下发）:', row.id, e.message);
    }
  }
  return row;
}

/** PM-28：文件导出（html/pdf）的双口径鉴权——accountId 本人校验优先；
 * 否则 code 与试卷对上即放行（前端 examFileUrl 带 code 时不带 accountId） */
async function resolveExamForFile(req) {
  const { accountId, code = '' } = req.query;
  if (accountId) {
    const own = await db.getExam(req.params.id, accountId);
    if (own) return own;
  }
  if (code) {
    const byCode = await db.getExamByCode(code);
    if (byCode && byCode.id === req.params.id) return byCode;
  }
  return null;
}

/**
 * POST /api/exam/generate
 * 提交生成（PM-87 异步化）：落一条 generating 记录立即返回 examId，生成与连接脱钩——
 * 客户端离开/断开不影响，完成后在「我的试卷」里转 ready，失败转 failed 并写明原因。
 * body: { accountId, openId?, subject, grade, knowledge?, difficulty?, choice?, fill?, trueFalse?, shortAnswer?, calculation?, essay?, durationMin? }
 */
router.post('/generate', async (req, res) => {
  const {
    accountId, openId = '', subject, grade,
    knowledge = '', difficulty = '中等',
    choice = 0, fill = 0, trueFalse = 0, shortAnswer = 0, calculation = 0, essay = 0,
    durationMin = 60, term = '', unitRange = '全部单元'
  } = req.body || {};

  // 参数校验
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  if (!SUBJECTS.includes(subject)) return res.status(400).json({ ok: false, msg: '不支持的学科' });
  if (!GRADES.includes(grade)) return res.status(400).json({ ok: false, msg: '不支持的年级' });
  if (!DIFFICULTY.includes(difficulty)) return res.status(400).json({ ok: false, msg: '不支持的难度' });

  // 学科净化：计算题仅限数学，非数学学科的 calculation 等量补位简答（题数总量不变）
  const { counts, moved } = examQuality.sanitizeCountsForSubject(subject, { choice, fill, trueFalse, shortAnswer, calculation, essay });
  const termVal = (term === '上册' || term === '下册') ? term : '';
  // PM-51：单元范围白名单校验（非法值回落「全部单元」，不让脏参数进提示词）
  const unitRangeVal = UNIT_RANGES.includes(unitRange) ? unitRange : '全部单元';
  const totalQuestions = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
  if (totalQuestions < 1) return res.status(400).json({ ok: false, msg: '请至少选择一种题型' });
  if (totalQuestions > 50) return res.status(400).json({ ok: false, msg: '题目数量过多（最多50题）' });

  try {
    const record = {
      id: 'exam_' + crypto.randomBytes(8).toString('hex'),
      accountId,
      openId,
      subject,
      grade,
      title: grade + '·' + subject + '试卷',
      config: JSON.stringify({ subject, grade, knowledge, difficulty, durationMin, counts, term: termVal, unitRange: unitRangeVal }),
      content: '',
      status: 'generating',
      failReason: '',
      code: genExamCode(),
      createdAt: Date.now()
    };
    // 限额/并发检查与落库在串行临界区内完成（QA 5 轮第 1 轮：防齐发 TOCTOU 突破上限）
    const gate = await withSubmitLock(async () => {
      // 每日限额（generating/failed 记录同样计入：它们同样消耗了上游调用，防费用失控口径不变）
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const todayCount = await db.countExamsToday(accountId, startOfDay.getTime());
      if (todayCount >= DAILY_LIMIT) {
        return { msg: '今日生成已达上限（' + DAILY_LIMIT + ' 份），明天再来吧' };
      }
      // 并发上限：同账号同时生成中的份数
      const generating = await db.countGeneratingExams(accountId);
      if (generating >= MAX_GENERATING_PER_ACCOUNT) {
        return { msg: '已有 ' + generating + ' 份试卷正在生成，等生成完再试吧' };
      }
      await db.createExam(record);
      return null;
    });
    if (gate) return res.status(429).json({ ok: false, msg: gate.msg });

    // 立即返回，生成脱钩在后台跑（客户端断开不影响；进程重启遗留由启动清扫置 failed）
    res.json({ ok: true, examId: record.id, code: record.code, status: 'generating' });
    runGeneration(record, { subject, grade, knowledge, difficulty, durationMin, counts, moved, termVal, unitRangeVal, totalQuestions })
      .catch(e => console.error('[EXAM] runGeneration 未捕获异常:', record.id, e && e.message));
  } catch (err) {
    console.error('[EXAM] generate submit error:', err.message);
    res.status(500).json({ ok: false, msg: '提交生成失败：' + err.message });
  }
});

/**
 * POST /api/exam/migrate（PM-167：游客出卷门控后移——登录后游客卷归属迁移）
  * body: { fromAccountId, toAccountId }——把游客账号名下的试卷改归属到正式账号，
   * 幂等、只改归属字段、不删数据；登录迁移链路调用，失败时前端明示、不阻断登录。
    * 注意：必须注册在 '/:id/retry' 等参数路由之前，避免 '/migrate' 被当作 :id 匹配。
     */
router.post('/migrate', async (req, res) => {
    const fromAccountId = (req.body && req.body.fromAccountId) || '';
    const toAccountId = (req.body && req.body.toAccountId) || '';
    if (!fromAccountId || !toAccountId) return res.status(400).json({ ok: false, msg: '缺少 fromAccountId 或 toAccountId' });
    if (fromAccountId === toAccountId) return res.status(400).json({ ok: false, msg: 'fromAccountId 与 toAccountId 相同，无需迁移' });
    try {
          const r = await db.migrateExams(fromAccountId, toAccountId);
          res.json({ ok: true, data: { migrated: r.migrated } });
    } catch (err) {
          console.error('[EXAM] migrate error:', err.message);
          res.status(500).json({ ok: false, msg: '试卷迁移失败' });
    }
});

/**
 * POST /api/exam/:id/retry
 * 失败重试：仅 failed 记录可重试，按落库 config 原参数重新异步生成。
 * body/query: { accountId }
 */
router.post('/:id/retry', async (req, res) => {
  const accountId = (req.body && req.body.accountId) || req.query.accountId;
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  try {
    const row = await db.getExam(req.params.id, accountId);
    if (!row) return res.status(404).json({ ok: false, msg: '试卷不存在' });
    if (row.status !== 'failed') {
      return res.status(409).json({ ok: false, msg: row.status === 'generating' ? '这份试卷正在生成中' : '这份试卷已生成成功，不用重试' });
    }
    // QA 5 轮第 1 轮：重试次数按份封顶（计数存 config.retryCount），防无限重试绕过每日限额
    let cfg = {};
    try { cfg = JSON.parse(row.config || '{}'); } catch (e) {}
    const retryCount = Number(cfg.retryCount) || 0;
    if (retryCount >= MAX_EXAM_RETRIES) {
      return res.status(429).json({ ok: false, msg: '这份试卷已重试 ' + MAX_EXAM_RETRIES + ' 次还没成功，请重新生成一份吧' });
    }
    // 并发检查＋状态翻转＋计数回写在串行临界区内完成（与 generate 共用同一把锁）
    const gate = await withSubmitLock(async () => {
      const generating = await db.countGeneratingExams(accountId);
      if (generating >= MAX_GENERATING_PER_ACCOUNT) {
        return { status: 429, msg: '已有 ' + generating + ' 份试卷正在生成，等生成完再试吧' };
      }
      const flipped = await db.resetExamGenerating(req.params.id);
      if (!flipped) return { status: 409, msg: '状态已变化，请刷新列表再试' };
      cfg.retryCount = retryCount + 1;
      await db.updateExamConfig(req.params.id, JSON.stringify(cfg));
      return null;
    });
    if (gate) return res.status(gate.status).json({ ok: false, msg: gate.msg });
    res.json({ ok: true, examId: req.params.id, status: 'generating' });
    const record = { id: row.id, accountId: row.account_id };
    runGeneration(record, effFromConfig(row))
      .catch(e => console.error('[EXAM] runGeneration(retry) 未捕获异常:', row.id, e && e.message));
  } catch (err) {
    console.error('[EXAM] retry error:', err.message);
    res.status(500).json({ ok: false, msg: '重试提交失败：' + err.message });
  }
});

/**
 * GET /api/exam/list?accountId=xxx
 * 我的试卷列表
 */
router.get('/list', async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  try {
    const rows = await db.listExams(accountId);
    // PM-28：存量试卷在下发前懒回填 code，列表项带 code 供前端拼分享链接
    for (const r of rows) await ensureExamCode(r);
    const list = rows.map(r => ({
      id: r.id,
      subject: r.subject,
      grade: r.grade,
      title: r.title,
      // PM-87：生成状态与失败原因（老数据无 status 列值时默认 ready）
      status: r.status || 'ready',
      failReason: r.fail_reason || '',
      // PM-28：分享 code（前端 examCode 优先取它拼分享路径，不带 accountId）
      code: r.code || '',
      createdAt: r.created_at
    }));
    res.json({ ok: true, data: { list } });
  } catch (err) {
    console.error('[EXAM] list error:', err.message);
    res.status(500).json({ ok: false, msg: '获取试卷列表失败' });
  }
});

/**
 * GET /api/exam/:id?accountId=xxx
 * 试卷详情（含答案）
 */
router.get('/:id', async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  try {
    let row = await db.getExam(req.params.id, accountId);
    if (!row) {
      // PM-28：分享链接带 code 打开时前端把 code 放在 :id 位——按 code 查到卷后
      // 仍须校验归属（code 只是标识不是通行证），不是本人的卷一律 404
      const byCode = await db.getExamByCode(req.params.id);
      if (byCode && byCode.account_id === accountId) row = byCode;
    }
    if (!row) return res.status(404).json({ ok: false, msg: '试卷不存在' });
    await ensureExamCode(row);
    // PM-87：generating/failed 明确返回状态（content 为空），前端据此渲染状态页而非空白/报错
    const status = row.status || 'ready';
    let content = {};
    if (status === 'ready' && row.content) {
      try { content = JSON.parse(row.content); } catch (e) {}
    }
    const exam = {
      id: row.id,
      subject: row.subject,
      grade: row.grade,
      title: row.title,
      status,
      failReason: row.fail_reason || '',
      // PM-28：分享 code（前端 examCode 优先取它）
      code: row.code || '',
      createdAt: row.created_at,
      content
    };
    if (status === 'ready' && content.delivery) {
      exam.requested = content.delivery.requested;
      exam.delivered = content.delivery.delivered;
      exam.missing = content.delivery.missing;
    }
    res.json({ ok: true, exam });
  } catch (err) {
    console.error('[EXAM] get error:', err.message);
    res.status(500).json({ ok: false, msg: '获取试卷失败' });
  }
});

/**
 * DELETE /api/exam/:id?accountId=xxx
 * 删除试卷
 */
router.delete('/:id', async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  try {
    const ok = await db.deleteExam(req.params.id, accountId);
    res.json({ ok, msg: ok ? '已删除' : '试卷不存在' });
  } catch (err) {
    console.error('[EXAM] delete error:', err.message);
    res.status(500).json({ ok: false, msg: '删除失败' });
  }
});


/**
 * GET /api/exam/:id/image?accountId=xxx&showAnswer=0|1
 * 导出试卷为 PNG 图片
 */
/**
 * GET /api/exam/:id/image?accountId=xxx&showAnswer=0|1
 * 生成试卷 HTML（供前端渲染）
 */
router.get('/:id/html', async (req, res) => {
  const { accountId, code = '', showAnswer = '0' } = req.query;
  // PM-28：accountId 与 code 至少带一个（前端 examFileUrl 带 code 时不带 accountId）
  if (!accountId && !code) return res.status(400).json({ ok: false, msg: '缺少 accountId' });

  try {
    const row = await resolveExamForFile(req);
    if (!row) return res.status(404).json({ ok: false, msg: '试卷不存在' });
    // PM-87：未 ready 的试卷不许导出（否则导出一张空卷）
    if ((row.status || 'ready') !== 'ready') {
      return res.status(409).json({ ok: false, msg: row.status === 'failed' ? ('试卷生成失败：' + (row.fail_reason || '请重试')) : '试卷正在生成中，请稍后再试' });
    }

    let content = {};
    try { content = JSON.parse(row.content); } catch (e) {}

    // 生成 HTML
    let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: "Microsoft YaHei", sans-serif; max-width: 750px; margin: 0 auto; padding: 20px; background: #fff; }
    .title { text-align: center; font-size: 28px; font-weight: bold; margin-bottom: 10px; }
    .meta { text-align: center; font-size: 16px; color: #666; margin-bottom: 30px; }
    .section-title { font-size: 20px; font-weight: bold; color: #3E8EF7; margin: 20px 0 10px; }
    .section-desc { font-size: 14px; color: #888; margin-bottom: 15px; }
    .question { margin-bottom: 20px; }
    .q-text { font-size: 18px; margin-bottom: 8px; }
    .options { margin-left: 20px; }
    .option { font-size: 16px; margin: 5px 0; }
    .answer { font-size: 16px; color: #38A169; margin-top: 8px; padding: 8px; background: #F0FFF4; border-radius: 4px; }
    .score { font-size: 14px; color: #999; float: right; }
  </style>
</head>
<body>
  <div class="title">${content.title || '试卷'}</div>
  <div class="meta">${content.subject} · ${content.grade} · ${content.durationMin || 60}分钟</div>
`;

    for (const section of (content.sections || [])) {
      html += `<div class="section-title">${section.name}</div>`;
      if (section.instructions) html += `<div class="section-desc">${section.instructions}</div>`;
      
      for (let i = 0; i < (section.questions || []).length; i++) {
        const q = section.questions[i];
        html += `<div class="question"><span class="score">(${q.score || 0}分)</span><div class="q-text">${i + 1}. ${q.q}</div>`;
        
        if (q.options?.length > 0) {
          html += '<div class="options">';
          q.options.forEach((opt, oi) => {
            html += `<div class="option">${['A','B','C','D'][oi]}. ${opt}</div>`;
          });
          html += '</div>';
        }
        
        if (showAnswer === '1' && q.answer) {
          html += `<div class="answer">答案：${q.answer}</div>`;
        }
        
        html += '</div>';
      }
    }

    html += '</body></html>';

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[EXAM] html error:', err.message);
    res.status(500).json({ ok: false, msg: '生成失败：' + err.message });
  }
});;


/**
 * GET /api/exam/:id/pdf?accountId=xxx&showAnswer=0|1
 * 导出试卷为 PDF
 */
const CHINESE_FONT = path.join(__dirname, '..', 'fonts', 'SourceHanSansSC-Regular.otf');

router.get('/:id/pdf', async (req, res) => {
  const { accountId, code = '', showAnswer = '0' } = req.query;
  // PM-28：accountId 与 code 至少带一个（前端 examFileUrl 带 code 时不带 accountId）
  if (!accountId && !code) return res.status(400).json({ ok: false, msg: '缺少 accountId' });

  try {
    const row = await resolveExamForFile(req);
    if (!row) return res.status(404).json({ ok: false, msg: '试卷不存在' });
    // PM-87：未 ready 的试卷不许导出（否则导出一张空卷）
    if ((row.status || 'ready') !== 'ready') {
      return res.status(409).json({ ok: false, msg: row.status === 'failed' ? ('试卷生成失败：' + (row.fail_reason || '请重试')) : '试卷正在生成中，请稍后再试' });
    }

    let content = {};
    try { content = JSON.parse(row.content); } catch (e) {}

    // 创建 PDF 文档
    const doc = new PDFDocument({ 
      margin: 50,
      size: 'A4',
      info: { Title: '试卷', Author: '成长趣味' },
      font: CHINESE_FONT
    });

    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(buffers);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(content.title || '试卷') + '.pdf"');
      res.send(pdfBuffer);
    });

    // 标题
    doc.fontSize(22).text(content.title || '试卷', { align: 'center', bottom: 80 });
    
    // 元信息
    doc.fontSize(12).text(`${content.subject} · ${content.grade} · ${content.durationMin || 60}分钟`, { align: 'center', bottom: 50 });
    doc.moveDown();

    // 题目内容
    for (const section of (content.sections || [])) {
      doc.fontSize(16).text(section.name, { underline: true });
      doc.moveDown(0.5);
      
      if (section.instructions) {
        doc.fontSize(10).text(section.instructions, { italics: true, color: '#666666' });
        doc.moveDown(0.5);
      }

      for (let i = 0; i < (section.questions || []).length; i++) {
        const q = section.questions[i];
        const scoreText = q.score ? ` (${q.score}分)` : '';
        
        doc.fontSize(12).text(`${i + 1}.${scoreText} ${q.q}`);
        doc.moveDown(0.3);

        // 选项
        if (q.options?.length > 0) {
          doc.fontSize(11).text(q.options.map((opt, oi) => `  ${['A','B','C','D'][oi]}. ${opt}`).join('    '));
          doc.moveDown(0.5);
        } else {
          doc.moveDown(0.5);
        }

        // 答案
        if (showAnswer === '1' && q.answer) {
          doc.fontSize(10).text(`参考答案：${String(q.answer).slice(0, 100)}`, { color: '#38A169' });
          doc.moveDown(0.5);
        }
      }
    }

    doc.end();
  } catch (err) {
    console.error('[EXAM] pdf error:', err.message);
    res.status(500).json({ ok: false, msg: 'PDF 生成失败：' + err.message });
  }
});

module.exports = router;
// 供自测使用的内部钩子（不影响路由行为）
module.exports.buildPrompt = buildPrompt;
module.exports.topUpExam = topUpExam;
module.exports.isRetryableAgnesError = isRetryableAgnesError;
module.exports.runGeneration = runGeneration;
module.exports.friendlyFailReason = friendlyFailReason;
module.exports.MAX_GENERATING_PER_ACCOUNT = MAX_GENERATING_PER_ACCOUNT;
module.exports.MAX_EXAM_RETRIES = MAX_EXAM_RETRIES;
module.exports.genExamCode = genExamCode;
