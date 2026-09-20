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
const path = require('path');
const fs = require('fs');
const Jimp = require('jimp');
const PDFDocument = require('pdfkit');

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

  return `为「${grade}·${subject}」生成一份${difficulty}难度试卷。
知识点：${knowledge || '该年级核心知识点'}
时长：${durationMin}分钟。

【必须严格生成的题型和数量】
${sectionDesc || '（未选择任何题型）'}

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
        ${Array(s.count).fill('{ "q": "题目", "options": ["A","B","C","D"], "answer": "A", "score": 2 }').join(',\n        ')}
      ]
    }`).join(',\n    ')}
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


/**
 * GET /api/exam/:id/image?accountId=xxx&showAnswer=0|1
 * 导出试卷为 PNG 图片
 */
/**
 * GET /api/exam/:id/image?accountId=xxx&showAnswer=0|1
 * 生成试卷 HTML（供前端渲染）
 */
router.get('/:id/html', async (req, res) => {
  const { accountId, showAnswer = '0' } = req.query;
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });

  try {
    const row = await db.getExam(req.params.id, accountId);
    if (!row) return res.status(404).json({ ok: false, msg: '试卷不存在' });

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
router.get('/:id/pdf', async (req, res) => {
  const { accountId, showAnswer = '0' } = req.query;
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });

  try {
    const row = await db.getExam(req.params.id, accountId);
    if (!row) return res.status(404).json({ ok: false, msg: '试卷不存在' });

    let content = {};
    try { content = JSON.parse(row.content); } catch (e) {}

    // 创建 PDF 文档
    const doc = new PDFDocument({ 
      margin: 50,
      size: 'A4',
      info: { Title: content.title || '试卷', Author: '成长趣味' }
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
