/**
 * 手抄报路由
 * 提供：AI 生成手抄报（agnes）、本地模板保存、列表、详情、删除、PDF 导出
 * 依赖：环境变量 AGNES_AI_API_KEY（agnes API 凭证）
 */
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();
const { config } = require('../config');
const db = require('../db');
const path = require('path');
const PDFDocument = require('pdfkit');

const DAILY_LIMIT = 20; // 每账号每日 AI 生成上限（防 API 费用失控）
const IMAGE_DAILY_LIMIT = 10; // 每账号每日 AI 生图上限（生图更贵，独立于文本生成）
const MAX_CUSTOM_LEN = 500; // 自定义要求最大字数
const MAX_STYLE_LEN = 50; // 风格描述最大字数

/* ==================== 参数定义 ==================== */

const GRADES = ['小学一年级', '小学二年级', '小学三年级', '小学四年级', '小学五年级', '小学六年级'];

/* ==================== agnes 调用 ==================== */

/**
 * 调用 agnes（OpenAI 兼容）生成手抄报方案
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
        content: '你是一位优秀的小学手抄报设计老师，擅长为小学生设计主题鲜明、内容健康积极、图文并茂的手抄报方案。你只输出严格 JSON，不输出任何其他文字、markdown 或解释。'
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

/**
 * 调用 agnes（OpenAI 兼容）文生图，返回生成图片的 url
 * 返回结构：{ data: [ { url: "https://...", revised_prompt: "..." } ] }
 */
async function callAgnesImage(prompt) {
  const { apiKey, baseURL, timeoutMs } = config.agnes;
  if (!apiKey) {
    throw new Error('服务器未配置 AGNES_AI_API_KEY');
  }
  const model = process.env.AGNES_IMAGE_MODEL || 'agnes-image-2.5-flash';
  const resp = await axios.post(baseURL + '/images/generations', {
    model,
    prompt,
    size: '1024x1536'
  }, {
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    timeout: timeoutMs
  });

  const url = resp.data && resp.data.data && resp.data.data[0] && resp.data.data[0].url;
  if (!url) {
    throw new Error('AI 生图未返回图片地址');
  }
  return url;
}

/** 健壮解析 AI 返回的 JSON（剥离围栏、修复裸换行等常见问题，与 exam.js 相同） */
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
  const { theme, grade, custom = '', style = '' } = params;

  const customText = String(custom).trim() ? `\n【额外要求】${String(custom).trim()}` : '';
  const styleText = String(style).trim() ? `\n【整体风格】${String(style).trim()}` : '';

  return `请为「${grade}」设计一份主题为「${theme}」的手抄报方案。
内容要适合小学生阅读，健康积极、通俗易懂、有趣有料。${customText}${styleText}

【JSON格式】只输出JSON，不要任何其他文字、markdown 或解释，字段名必须与下面完全一致：
{
  "title": "手抄报标题",
  "subtitle": "副标题或标语",
  "layout": "横三栏式/竖两栏式/环绕式 等布局名称",
  "layoutDesc": "一句话描述布局怎么画",
  "colorScheme": { "main": "#E8433A", "accent": "#F7C948", "bg": "#FFF8E1" },
  "sections": [
    { "icon": "🧧", "title": "板块标题", "content": "一段内容", "bullets": ["要点1", "要点2"] }
  ],
  "decorTips": ["插图建议1", "插图建议2"],
  "writeTips": "书写/排版提示"
}

【要求】
- sections 至少 4 个板块，内容具体、紧扣「${theme}」主题
- 每个板块的 content 控制在 60~120 字，bullets 2~5 条
- colorScheme 三个颜色都必须是 #RRGGBB 格式
- title 控制在 12 个字以内`;
}

/**
 * 构造文生图提示词：儿童手抄报成品模板图片
 * 强调竖版 A4 构图、四周装饰边框、中央标题区与正文区大面积留白（供孩子手写）、适合打印后手写
 */
function buildImagePrompt(params) {
  const { theme, grade, custom = '', style = '' } = params;

  const styleText = String(style).trim() ? String(style).trim() : '卡通可爱';
  const customText = String(custom).trim() ? `\n【额外要求】${String(custom).trim()}` : '';

  return `请绘制一张「${grade}」主题为「${theme}」的儿童手抄报成品模板图片，用于打印后由孩子手写填字。

【画面要求】
1. 竖版 A4 纸张构图，比例约 3:4，画面干净整洁，适合打印后手写。
2. 整体风格：${styleText}，符合 ${grade} 小学生的审美。
3. 四周设计精美的手抄报装饰边框，边框元素紧扣「${theme}」主题（如节日、季节、学习相关的小插图、花边、气球等）。
4. 画面中上方预留醒目的标题区：可用装饰性大号美术字写出标题，或留出大块标题空白区域。
5. 正文区域大面积留白：仅用淡色线条/花边框出 3~4 个板块轮廓，中间保持大块空白，方便孩子用笔手写文字。
6. 色彩搭配鲜艳明快、和谐统一，主体颜色不超过 3~4 种。
7. 不要写入大段正文文字、不要出现与主题无关的内容，保持整体留白充足。${customText}`;
}

/* ==================== 路由 ==================== */

/**
 * POST /api/poster/generate
 * AI 生成手抄报
 * body: { accountId, openId?, theme, grade, custom?, style? }
 */
router.post('/generate', async (req, res) => {
  const {
    accountId, openId = '', theme, grade,
    custom = '', style = ''
  } = req.body || {};

  // 参数校验
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  if (!theme || !String(theme).trim()) return res.status(400).json({ ok: false, msg: '缺少 theme' });
  if (!GRADES.includes(grade)) return res.status(400).json({ ok: false, msg: '不支持的年级' });
  if (String(custom).length > MAX_CUSTOM_LEN) return res.status(400).json({ ok: false, msg: '自定义要求过长（最多' + MAX_CUSTOM_LEN + '字）' });
  if (String(style).length > MAX_STYLE_LEN) return res.status(400).json({ ok: false, msg: '风格描述过长' });

  try {
    // 每日限额
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayCount = await db.countPostersToday(accountId, startOfDay.getTime());
    if (todayCount >= DAILY_LIMIT) {
      return res.status(429).json({ ok: false, msg: '今日生成已达上限（' + DAILY_LIMIT + ' 份），明天再来吧' });
    }

    const prompt = buildPrompt(req.body);
    const poster = await callAgnes(prompt);

    // 校验返回结构
    if (!poster.title || !poster.sections || !Array.isArray(poster.sections) || poster.sections.length < 4) {
      throw new Error('AI 返回的手抄报缺少板块（至少 4 个）');
    }

    const record = {
      id: 'poster_' + crypto.randomBytes(8).toString('hex'),
      accountId,
      openId,
      theme: String(theme).trim(),
      grade,
      title: poster.title || (String(theme).trim() + '手抄报'),
      source: 'ai',
      config: JSON.stringify({ theme, grade, custom, style }),
      content: JSON.stringify(poster),
      createdAt: Date.now()
    };
    await db.createPoster(record);

    res.json({ ok: true, posterId: record.id });
  } catch (err) {
    console.error('[POSTER] generate error:', err.message);
    if (err.message && err.message.indexOf('AGNES') > -1) {
      return res.status(500).json({ ok: false, msg: err.message });
    }
    res.status(500).json({ ok: false, msg: '手抄报生成失败：' + err.message });
  }
});

/**
 * POST /api/poster/generate-image
 * AI 文生图：直接生成手抄报成品图片并存储
 * body: { accountId, openId?, theme, grade, style?, custom? }
 */
router.post('/generate-image', async (req, res) => {
  const {
    accountId, openId = '', theme, grade,
    custom = '', style = ''
  } = req.body || {};

  // 参数校验
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  if (!theme || !String(theme).trim()) return res.status(400).json({ ok: false, msg: '缺少 theme' });
  if (!GRADES.includes(grade)) return res.status(400).json({ ok: false, msg: '不支持的年级' });
  if (String(custom).length > MAX_CUSTOM_LEN) return res.status(400).json({ ok: false, msg: '自定义要求过长（最多' + MAX_CUSTOM_LEN + '字）' });
  if (String(style).length > MAX_STYLE_LEN) return res.status(400).json({ ok: false, msg: '风格描述过长' });

  try {
    // 每日生图限额（独立于文本生成限额）
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayCount = await db.countImagesToday(accountId, startOfDay.getTime());
    if (todayCount >= IMAGE_DAILY_LIMIT) {
      return res.status(429).json({ ok: false, msg: '今日AI生图已达上限（' + IMAGE_DAILY_LIMIT + ' 张），明天再来吧' });
    }

    const prompt = buildImagePrompt(req.body);
    const url = await callAgnesImage(prompt);

    const record = {
      id: 'poster_' + crypto.randomBytes(8).toString('hex'),
      accountId,
      openId,
      theme: String(theme).trim(),
      grade,
      title: String(theme).trim() + '手抄报图片',
      source: 'image',
      config: JSON.stringify({ theme, grade, style, custom }),
      content: JSON.stringify({ theme, grade, style, custom, prompt }),
      imageUrl: url,
      createdAt: Date.now()
    };
    await db.createPoster(record);

    res.json({ ok: true, posterId: record.id });
  } catch (err) {
    console.error('[POSTER] generate-image error:', err.message);
    if (err.message && err.message.indexOf('AGNES') > -1) {
      return res.status(500).json({ ok: false, msg: err.message });
    }
    res.status(500).json({ ok: false, msg: '手抄报图片生成失败：' + err.message });
  }
});

/**
 * POST /api/poster/save
 * 保存本地模板方案（不调 AI、不限额）
 * body: { accountId, openId?, theme, grade, title?, content }
 */
router.post('/save', async (req, res) => {
  const { accountId, openId = '', theme, grade, title = '', content } = req.body || {};

  // 参数校验
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  if (!theme || !String(theme).trim()) return res.status(400).json({ ok: false, msg: '缺少 theme' });
  if (!GRADES.includes(grade)) return res.status(400).json({ ok: false, msg: '不支持的年级' });
  if (!content) return res.status(400).json({ ok: false, msg: '缺少 content' });

  // content 允许是对象或 JSON 字符串
  let contentObj = content;
  if (typeof content === 'string') {
    try {
      contentObj = JSON.parse(content);
    } catch (e) {
      return res.status(400).json({ ok: false, msg: 'content 不是合法的 JSON' });
    }
  }
  if (!contentObj || typeof contentObj !== 'object' || Array.isArray(contentObj)) {
    return res.status(400).json({ ok: false, msg: 'content 必须是 JSON 对象' });
  }

  try {
    const record = {
      id: 'poster_' + crypto.randomBytes(8).toString('hex'),
      accountId,
      openId,
      theme: String(theme).trim(),
      grade,
      title: String(title).trim() || (String(theme).trim() + '手抄报'),
      source: 'template',
      config: JSON.stringify({ theme, grade }),
      content: JSON.stringify(contentObj),
      createdAt: Date.now()
    };
    await db.createPoster(record);

    res.json({ ok: true, posterId: record.id });
  } catch (err) {
    console.error('[POSTER] save error:', err.message);
    res.status(500).json({ ok: false, msg: '保存失败：' + err.message });
  }
});

/**
 * GET /api/poster/list?accountId=xxx
 * 我的手抄报列表
 */
router.get('/list', async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  try {
    const rows = await db.listPosters(accountId);
    const list = rows.map(r => ({
      id: r.id,
      theme: r.theme,
      grade: r.grade,
      title: r.title,
      source: r.source,
      imageUrl: r.imageUrl,
      createdAt: r.created_at
    }));
    res.json({ ok: true, data: { list } });
  } catch (err) {
    console.error('[POSTER] list error:', err.message);
    res.status(500).json({ ok: false, msg: '获取手抄报列表失败' });
  }
});

/**
 * GET /api/poster/:id?accountId=xxx
 * 手抄报详情
 */
router.get('/:id', async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  try {
    const row = await db.getPoster(req.params.id, accountId);
    if (!row) return res.status(404).json({ ok: false, msg: '手抄报不存在' });
    let content = {};
    try { content = JSON.parse(row.content); } catch (e) {}
    res.json({
      ok: true,
      poster: {
        id: row.id,
        theme: row.theme,
        grade: row.grade,
        title: row.title,
        source: row.source,
        imageUrl: row.imageUrl,
        createdAt: row.created_at,
        content
      }
    });
  } catch (err) {
    console.error('[POSTER] get error:', err.message);
    res.status(500).json({ ok: false, msg: '获取手抄报失败' });
  }
});

/**
 * DELETE /api/poster/:id?accountId=xxx
 * 删除手抄报
 */
router.delete('/:id', async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  try {
    const ok = await db.deletePoster(req.params.id, accountId);
    res.json({ ok, msg: ok ? '已删除' : '手抄报不存在' });
  } catch (err) {
    console.error('[POSTER] delete error:', err.message);
    res.status(500).json({ ok: false, msg: '删除失败' });
  }
});

/**
 * GET /api/poster/:id/pdf?accountId=xxx
 * 导出手抄报为 PDF（pdfkit + 中文字体）
 */
const CHINESE_FONT = path.join(__dirname, '..', 'fonts', 'SourceHanSansSC-Regular.otf');

router.get('/:id/pdf', async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });

  try {
    const row = await db.getPoster(req.params.id, accountId);
    if (!row) return res.status(404).json({ ok: false, msg: '手抄报不存在' });

    let content = {};
    try { content = JSON.parse(row.content); } catch (e) {}

    // 创建 PDF 文档
    const doc = new PDFDocument({
      margin: 50,
      size: 'A4',
      info: { Title: row.title, Author: '成长趣味' },
      font: CHINESE_FONT
    });
    doc.font(CHINESE_FONT);

    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(buffers);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(row.title || '手抄报') + '.pdf"');
      res.send(pdfBuffer);
    });

    const pageWidth = doc.page.width;
    const margin = 50;

    // 配色（校验 #RRGGBB 格式，非法值回退默认）
    const colorScheme = content.colorScheme || {};
    const hexRe = /^#[0-9a-fA-F]{6}$/;
    const mainColor = hexRe.test(colorScheme.main || '') ? colorScheme.main : '#E8433A';
    const accentColor = hexRe.test(colorScheme.accent || '') ? colorScheme.accent : '#F7C948';

    // 顶部色带 + 标题 + 副标题
    doc.rect(0, 0, pageWidth, 112).fill(mainColor);
    doc.fillColor('#FFFFFF');
    doc.fontSize(26).text(content.title || row.title || '手抄报', { align: 'center', lineGap: 6 });
    doc.moveDown(0.2);
    if (content.subtitle) {
      doc.fontSize(14).text(content.subtitle, { align: 'center' });
    }

    // 元信息：主题 · 年级 · 布局
    doc.fillColor('#333333');
    doc.moveDown(1);
    doc.fontSize(11).text(`${row.theme} · ${row.grade}${content.layout ? ' · ' + content.layout : ''}`, { align: 'center' });
    if (content.layoutDesc) {
      doc.moveDown(0.3);
      doc.fontSize(10).text(content.layoutDesc, { align: 'center', color: '#666666' });
    }
    doc.moveDown(0.8);

    // 板块（标题 + 内容 + 要点）
    for (const section of (content.sections || [])) {
      const icon = section.icon ? section.icon + ' ' : '';
      doc.fontSize(15).text(icon + (section.title || '板块'), { color: accentColor });
      doc.moveDown(0.3);
      if (section.content) {
        doc.fontSize(11).text(section.content, { lineGap: 3 });
        doc.moveDown(0.3);
      }
      for (const bullet of (section.bullets || [])) {
        doc.fontSize(10.5).text('• ' + bullet, { indent: 12, lineGap: 2 });
      }
      doc.moveDown(0.6);
    }

    // 配色方案（色块 + 色值）
    doc.moveDown(0.4);
    doc.fontSize(13).text('配色方案', { color: accentColor });
    doc.moveDown(0.3);
    const swatches = [
      { label: '主色', hex: mainColor },
      { label: '点缀色', hex: accentColor },
      { label: '背景色', hex: hexRe.test(colorScheme.bg || '') ? colorScheme.bg : '#FFF8E1' }
    ];
    const swatchW = 70;
    const swatchH = 24;
    const sy = doc.y;
    let sx = margin;
    for (const sw of swatches) {
      doc.rect(sx, sy, swatchW, swatchH).fill(sw.hex);
      doc.fillColor('#333333');
      doc.fontSize(9).text(`${sw.label} ${sw.hex}`, sx, sy + swatchH + 3, { width: swatchW, align: 'center' });
      sx += swatchW + 18;
    }
    doc.y = sy + swatchH + 22;
    doc.moveDown(0.6);

    // 装饰建议
    if ((content.decorTips || []).length > 0) {
      doc.fontSize(13).text('装饰建议', { color: accentColor });
      doc.moveDown(0.3);
      for (const tip of content.decorTips) {
        doc.fontSize(10.5).text('• ' + tip, { indent: 12, lineGap: 2 });
      }
      doc.moveDown(0.5);
    }

    // 书写提示
    if (content.writeTips) {
      doc.fontSize(13).text('书写提示', { color: accentColor });
      doc.moveDown(0.3);
      doc.fontSize(10.5).text(content.writeTips, { lineGap: 3 });
    }

    doc.end();
  } catch (err) {
    console.error('[POSTER] pdf error:', err.message);
    res.status(500).json({ ok: false, msg: 'PDF 生成失败：' + err.message });
  }
});

module.exports = router;
