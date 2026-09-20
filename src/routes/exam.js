/**
 * 试卷路由
 * 提供：AI 生成试卷（agnes）、试卷列表、详情、删除
 * 依赖：环境变量 AGNES_AI_API_KEY（agnes API 凭证）
 */
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();
const { config } = require('../config');
const db = require('../db');

const DAILY_LIMIT = 20; // 每账号每日生成上限（防 API 费用失控）

/* ==================== 参数定义 ==================== */

const SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '政治'];
const GRADES = ['小学一年级', '小学二年级', '小学三年级', '小学四年级', '小学五年级', '小学六年级', '初中一年级', '初中二年级', '初中三年级'];
const DIFFICULTY = ['简单', '中等', '困难'];
const QUESTION_TYPES = ['选择题', '填空题', '判断题', '简答题', '计算题', '作文题'];

/* ==================== agnes 调用 ==================== */

/**
 * 调用 agnes（OpenAI 兼容）生成试卷
 */
async function callAgnes(prompt) {
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
  throw new Error('AI 返回内容解析失败：' + e.message);
}

/* ==================== Prompt 构造 ==================== */

function buildPrompt(params) {
  const {
    subject, grade, knowledge, difficulty = '中等',
    choice = 0, fill = 0, trueFalse = 0, shortAnswer = 0, calculation = 0, essay = 0,
    durationMin = 60
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

  return `请为「${grade}·${subject}」生成一份${difficulty}难度的试卷。

【命题要求】
- 知识点范围：${knowledge || '覆盖该年级该学科核心知识点'}
- 严格依据中国义务教育课程标准，题目准确、无超纲、无歧义
- 各题要由浅入深，有一定区分度
- 选择题必须给出 4 个选项（A/B/C/D），且只有一个正确答案
- 计算题需包含适当步骤；作文题给出题目和要求
- 时长 ${durationMin} 分钟，满分尽可能接近 100 分
- 重要：题目与答案文本中一律不要使用换行符，较长的表述用中文顿号、分号连接

【题型与题量】
${sectionDesc}

【输出格式】严格输出如下 JSON 结构（不要输出任何其他文字）：
{
  "title": "试卷标题",
  "subject": "${subject}",
  "grade": "${grade}",
  "difficulty": "${difficulty}",
  "durationMin": ${durationMin},
  "sections": [
    {
      "name": "一、选择题",
      "type": "choice",
      "scorePer": 2,
      "instructions": "本大题共X小题，每小题2分",
      "questions": [
        { "q": "题目文字", "options": ["选项A", "选项B", "选项C", "选项D"], "answer": "C", "score": 2, "analysis": "简要解析" }
      ]
    },
    {
      "name": "二、填空题",
      "type": "fill",
      "scorePer": 2,
      "instructions": "本大题共X小题",
      "questions": [
        { "q": "题目文字（用____表示空格）", "answer": "答案", "score": 2, "analysis": "简要解析" }
      ]
    },
    {
      "name": "三、判断题",
      "type": "trueFalse",
      "scorePer": 1,
      "instructions": "本大题共X小题，正确打√，错误打×",
      "questions": [
        { "q": "陈述句", "answer": "√", "score": 1, "analysis": "简要解析" }
      ]
    },
    {
      "name": "四、简答题",
      "type": "shortAnswer",
      "scorePer": 8,
      "instructions": "本大题共X小题",
      "questions": [
        { "q": "问题", "answer": "参考答案", "score": 8, "analysis": "" }
      ]
    },
    {
      "name": "五、计算题",
      "type": "calculation",
      "scorePer": 10,
      "instructions": "本大题共X小题，要求写出计算过程",
      "questions": [
        { "q": "计算题题目", "answer": "详细步骤与答案", "score": 10, "analysis": "" }
      ]
    },
    {
      "name": "六、作文题",
      "type": "essay",
      "scorePer": 30,
      "instructions": "根据要求写作",
      "questions": [
        { "q": "作文题目", "answer": "写作要求与评分参考", "score": 30, "analysis": "" }
      ]
    }
  ]
}`;
}

/* ==================== 路由 ==================== */

/**
 * POST /api/exam/generate
 * 生成试卷
 * body: { accountId, openId?, subject, grade, knowledge?, difficulty?, choice?, fill?, trueFalse?, shortAnswer?, calculation?, essay?, durationMin? }
 */
router.post('/generate', async (req, res) => {
  const {
    accountId, openId = '', subject, grade,
    knowledge = '', difficulty = '中等',
    choice = 0, fill = 0, trueFalse = 0, shortAnswer = 0, calculation = 0, essay = 0,
    durationMin = 60
  } = req.body || {};

  // 参数校验
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  if (!SUBJECTS.includes(subject)) return res.status(400).json({ ok: false, msg: '不支持的学科' });
  if (!GRADES.includes(grade)) return res.status(400).json({ ok: false, msg: '不支持的年级' });
  if (!DIFFICULTY.includes(difficulty)) return res.status(400).json({ ok: false, msg: '不支持的难度' });

  const counts = { choice, fill, trueFalse, shortAnswer, calculation, essay };
  const totalQuestions = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
  if (totalQuestions < 1) return res.status(400).json({ ok: false, msg: '请至少选择一种题型' });
  if (totalQuestions > 50) return res.status(400).json({ ok: false, msg: '题目数量过多（最多50题）' });

  try {
    // 每日限额
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayCount = await db.countExamsToday(accountId, startOfDay.getTime());
    if (todayCount >= DAILY_LIMIT) {
      return res.status(429).json({ ok: false, msg: '今日生成已达上限（' + DAILY_LIMIT + ' 份），明天再来吧' });
    }

    const prompt = buildPrompt(req.body);
    const exam = await callAgnes(prompt);

    // 校验返回结构
    if (!exam.sections || !Array.isArray(exam.sections) || !exam.sections.length) {
      throw new Error('AI 返回的试卷缺少题目');
    }

    const record = {
      id: 'exam_' + crypto.randomBytes(8).toString('hex'),
      accountId,
      openId,
      subject,
      grade,
      title: exam.title || (grade + '·' + subject + '试卷'),
      config: JSON.stringify({ subject, grade, knowledge, difficulty, durationMin, counts }),
      content: JSON.stringify(exam),
      createdAt: Date.now()
    };
    await db.createExam(record);

    res.json({ ok: true, examId: record.id });
  } catch (err) {
    console.error('[EXAM] generate error:', err.message);
    if (err.message && err.message.indexOf('AGNES') > -1) {
      return res.status(500).json({ ok: false, msg: err.message });
    }
    res.status(500).json({ ok: false, msg: '试卷生成失败：' + err.message });
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
    const list = rows.map(r => ({
      id: r.id,
      subject: r.subject,
      grade: r.grade,
      title: r.title,
      createdAt: r.created_at
    }));
    res.json({ ok: true, list });
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
    const row = await db.getExam(req.params.id, accountId);
    if (!row) return res.status(404).json({ ok: false, msg: '试卷不存在' });
    let content = {};
    try { content = JSON.parse(row.content); } catch (e) {}
    res.json({
      ok: true,
      exam: {
        id: row.id,
        subject: row.subject,
        grade: row.grade,
        title: row.title,
        createdAt: row.created_at,
        content
      }
    });
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

module.exports = router;
