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
 * - 图片版（source='image'）：下载成品图嵌入单页 A4 PDF
 * - 方案版（source='ai'/'template'）：第 1 页为可打印后手写的空白版式模板，第 2 页为内容参考
 */
const CHINESE_FONT = path.join(__dirname, '..', 'fonts', 'SourceHanSansSC-Regular.otf');
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const FALLBACK_COLORS = { main: '#E8433A', accent: '#F7C948', bg: '#FFF8E1' };

/** 校验 #RRGGBB 颜色，非法回退默认色 */
function pickColor(value, fallback) {
  return HEX_RE.test(String(value || '')) ? value : fallback;
}

/** 画实心小圆点 */
function drawDot(doc, x, y, r, color) {
  doc.fillColor(color).circle(x, y, r).fill();
}

/** 画实心小方块（旋转 45°） */
function drawDiamond(doc, x, y, s, color) {
  doc.fillColor(color).polygon([x, y - s], [x + s, y], [x, y + s], [x - s, y]).fill();
}

/** 画五角星 */
function drawStar(doc, cx, cy, r, color) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? 1 : 0.46;
    pts.push([cx + Math.cos(ang) * r * rad, cy + Math.sin(ang) * r * rad]);
  }
  doc.fillColor(color).polygon(...pts).fill();
}

/**
 * 第 1 页「手抄报版式」：空白模板，供打印后手写
 * 背景铺色 + 双线装饰边框 + 四角圆点/方块 + 顶部标题横幅 + 中部板块框（大面积留白）+ 底部提示与装饰
 */
function drawPosterTemplatePage(doc, ctx) {
  const { pageW, pageH, mainColor, accentColor, bgColor } = ctx;

  // 背景铺色（淡色）
  doc.rect(0, 0, pageW, pageH).fill(bgColor);

  // 四周装饰边框：外层细线 + 内层粗线（accent 色）
  const b = 22;
  doc.lineWidth(1).strokeColor(accentColor).rect(b, b, pageW - b * 2, pageH - b * 2).stroke();
  doc.lineWidth(3).strokeColor(accentColor).rect(b + 9, b + 9, pageW - (b + 9) * 2, pageH - (b + 9) * 2).stroke();

  // 四角装饰：圆点 + 小方块
  [[b + 9, b + 9], [b + 9, pageH - b - 9], [pageW - b - 9, b + 9], [pageW - b - 9, pageH - b - 9]].forEach(([x, y]) => {
    drawDot(doc, x, y, 5, accentColor);
    drawDiamond(doc, x, y, 5, mainColor);
  });
  [[b, b], [b, pageH - b], [pageW - b, b], [pageW - b, pageH - b]].forEach(([x, y]) => drawDot(doc, x, y, 3, accentColor));

  // 顶部标题区：main 色圆角横幅 + 白字标题/副标题
  const bannerX = b + 40;
  const bannerW = pageW - (b + 40) * 2;
  const bannerH = 100;
  const bannerY = b + 26;
  doc.roundedRect(bannerX, bannerY, bannerW, bannerH, 18).fill(mainColor);

  const title = ctx.content.title || ctx.row.title || '手抄报';
  const subtitle = ctx.content.subtitle || '';
  doc.fillColor('#FFFFFF');
  if (subtitle) {
    doc.fontSize(26).text(title, bannerX, bannerY + 16, { width: bannerW, align: 'center' });
    doc.fontSize(11.5).text(subtitle, bannerX, bannerY + bannerH - 34, { width: bannerW, align: 'center' });
  } else {
    doc.fontSize(28).text(title, bannerX, bannerY + (bannerH - 36) / 2, { width: bannerW, align: 'center' });
  }

  // 中部板块框：2 列网格（板块多则加行、少则单列），accent 描边、顶部 icon+标题、框内大面积留白
  const sections = Array.isArray(ctx.content.sections) && ctx.content.sections.length > 0
    ? ctx.content.sections
    : [{ icon: '✏️', title: '内容区' }];
  const boxLeft = b + 34;
  const boxRight = pageW - b - 34;
  const gap = 18;
  const cols = sections.length >= 3 ? 2 : 1;
  const rows = Math.max(1, Math.ceil(sections.length / cols));
  const boxW = (boxRight - boxLeft - gap * (cols - 1)) / cols;
  const boxTop = bannerY + bannerH + 24;
  const boxBottom = pageH - b - 56; // 底部提示区上沿
  const boxH = Math.max(90, Math.min(320, (boxBottom - boxTop - gap * (rows - 1)) / rows));
  // 板块数量少时网格垂直居中
  const gridH = boxH * rows + gap * (rows - 1);
  const gridTop = boxTop + Math.max(0, (boxBottom - boxTop - gridH) / 2);

  sections.slice(0, rows * cols).forEach((section, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const bx = boxLeft + col * (boxW + gap);
    const by = gridTop + row * (boxH + gap);
    doc.roundedRect(bx, by, boxW, boxH, 10).lineWidth(2).strokeColor(accentColor).stroke();
    // 顶部 icon + 板块标题（小字，交替主色/点缀色）
    const icon = section.icon ? section.icon + ' ' : '';
    doc.fillColor(i % 2 === 0 ? mainColor : accentColor)
      .fontSize(13)
      .text(icon + (section.title || '板块'), bx + 14, by + 12, { width: boxW - 28 });
    // 标题下细分隔线（淡灰，标出书写区起点）
    const dividerY = by + Math.max(34, doc.y - by + 6);
    doc.lineWidth(1).strokeColor('#DCD4BE').moveTo(bx + 14, dividerY).lineTo(bx + boxW - 14, dividerY).stroke();
    // 框内其余部分大面积留白（供孩子手写，不打印 content/bullets）
  });

  // 底部小字提示
  doc.fillColor('#999999').fontSize(10)
    .text('打印后，按板块标题手写内容、画插图', 0, pageH - 44, { width: pageW, align: 'center' });

  // 页脚小装饰：星形 + 圆点 + 小方块
  const fy = pageH - b - 16;
  drawStar(doc, pageW / 2 - 80, fy, 6, accentColor);
  drawDiamond(doc, pageW / 2 - 40, fy, 4, mainColor);
  drawDot(doc, pageW / 2, fy, 4, accentColor);
  drawDiamond(doc, pageW / 2 + 40, fy, 4, mainColor);
  drawStar(doc, pageW / 2 + 80, fy, 6, accentColor);
}

/**
 * 第 2 页「内容参考」：照着写
 * 板块内容 + bullets、配色色块、装饰建议、书写提示、版面布局说明
 */
function drawReferencePage(doc, ctx) {
  const { pageW, pageH, mainColor, accentColor, bgColor } = ctx;
  const margin = 46;
  const contentW = pageW - margin * 2;
  const bottomLimit = pageH - 50;

  const drawHeader = () => {
    doc.rect(0, 0, pageW, 60).fill(mainColor);
    doc.fillColor('#FFFFFF').fontSize(17).text('📖 内容参考（照着写）', 0, 16, { width: pageW, align: 'center' });
  };

  let y = 0;
  const fit = (needed) => {
    if (y + needed > bottomLimit) {
      doc.addPage();
      drawHeader();
      y = 70;
    }
  };

  drawHeader();
  y = 70;

  // 板块：icon + 标题（accent 色）+ content + bullets
  for (const section of (ctx.content.sections || [])) {
    const icon = section.icon ? section.icon + ' ' : '';
    const titleText = icon + (section.title || '板块');
    fit(doc.heightOfString(titleText, { width: contentW }) + 8);
    doc.fillColor(accentColor).fontSize(14).text(titleText, margin, y, { width: contentW });
    y = doc.y + 3;
    if (section.content) {
      const need = doc.heightOfString(section.content, { width: contentW, lineGap: 2 }) + 8;
      fit(need);
      doc.fillColor('#333333').fontSize(10.5).text(section.content, margin, y, { width: contentW, lineGap: 2 });
      y = doc.y + 3;
    }
    for (const bullet of (section.bullets || [])) {
      const line = '• ' + bullet;
      const need = doc.heightOfString(line, { width: contentW - 16, lineGap: 1.5 }) + 6;
      fit(need);
      doc.fillColor('#555555').fontSize(10).text(line, margin + 16, y, { width: contentW - 16, lineGap: 1.5 });
      y = doc.y + 1;
    }
    y += 8;
  }

  // 配色方案：3 个色块
  fit(70);
  y += 6;
  doc.fillColor(mainColor).fontSize(13).text('配色方案', margin, y, { width: contentW });
  y = doc.y + 6;
  const swatches = [
    { label: '主色', hex: mainColor },
    { label: '点缀色', hex: accentColor },
    { label: '背景色', hex: bgColor }
  ];
  const swatchW = 92;
  const swatchH = 20;
  let sx = margin;
  for (const sw of swatches) {
    doc.rect(sx, y, swatchW, swatchH).fill(sw.hex);
    doc.lineWidth(0.5).strokeColor('#CCCCCC').rect(sx, y, swatchW, swatchH).stroke();
    doc.fillColor('#333333').fontSize(9).text(`${sw.label} ${sw.hex}`, sx, y + swatchH + 3, { width: swatchW, align: 'center' });
    sx += swatchW + 14;
  }
  y += swatchH + 22;

  // 装饰建议
  if ((ctx.content.decorTips || []).length > 0) {
    fit(26);
    doc.fillColor(mainColor).fontSize(13).text('装饰建议', margin, y, { width: contentW });
    y = doc.y + 5;
    for (const tip of ctx.content.decorTips) {
      const need = doc.heightOfString('• ' + tip, { width: contentW - 16, lineGap: 1.5 }) + 6;
      fit(need);
      doc.fillColor('#555555').fontSize(10).text('• ' + tip, margin + 16, y, { width: contentW - 16, lineGap: 1.5 });
      y = doc.y + 1;
    }
    y += 6;
  }

  // 书写提示
  if (ctx.content.writeTips) {
    fit(34);
    doc.fillColor(mainColor).fontSize(13).text('书写提示', margin, y, { width: contentW });
    y = doc.y + 5;
    const need = doc.heightOfString(ctx.content.writeTips, { width: contentW, lineGap: 2 }) + 8;
    fit(need);
    doc.fillColor('#555555').fontSize(10.5).text(ctx.content.writeTips, margin, y, { width: contentW, lineGap: 2 });
    y = doc.y + 6;
  }

  // 底部小字：版面布局说明
  const layoutDesc = [ctx.content.layout, ctx.content.layoutDesc].filter(Boolean).join('：');
  doc.fillColor('#999999').fontSize(10)
    .text('版面布局：' + (layoutDesc || '自由排版'), margin, bottomLimit - 18, { width: contentW, align: 'center' });
}

router.get('/:id/pdf', async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });

  try {
    const row = await db.getPoster(req.params.id, accountId);
    if (!row) return res.status(404).json({ ok: false, msg: '手抄报不存在' });

    const title = row.title || '手抄报';
    const sendPdf = (pdfBuffer) => {
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(title) + '.pdf"');
      res.send(pdfBuffer);
    };

    /* ==================== 图片版：成品图直接嵌入单页 ==================== */
    if (row.source === 'image') {
      if (!row.imageUrl) {
        return res.status(500).json({ ok: false, msg: '该手抄报缺少图片地址，无法导出 PDF' });
      }
      // 下载成品图（15s 超时），失败返回友好错误
      let imageBuffer;
      try {
        const resp = await axios.get(row.imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
        imageBuffer = Buffer.from(resp.data || []);
      } catch (err) {
        console.error('[POSTER] pdf 图片下载失败:', err.message);
        return res.status(500).json({ ok: false, msg: '手抄报图片下载失败，请稍后重试' });
      }
      // 校验图片签名（png/jpeg/webp），避免把 HTML 错误页当图片嵌入
      const sigOk = imageBuffer.length > 12 &&
        ((imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 && imageBuffer[2] === 0x4E && imageBuffer[3] === 0x47) ||
         (imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8 && imageBuffer[2] === 0xFF) ||
         (imageBuffer.toString('ascii', 0, 4) === 'RIFF' && imageBuffer.toString('ascii', 8, 12) === 'WEBP'));
      if (!sigOk) {
        return res.status(500).json({ ok: false, msg: '手抄报图片数据无效，请重新生成后再导出' });
      }

      const doc = new PDFDocument({ margin: 0, size: 'A4', info: { Title: title, Author: '成长趣味' } });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => sendPdf(Buffer.concat(buffers)));
      const pageW = doc.page.width;
      const pageH = doc.page.height;
      let img;
      try {
        img = doc.openImage(imageBuffer);
      } catch (err) {
        console.error('[POSTER] pdf 图片解析失败:', err.message);
        return res.status(500).json({ ok: false, msg: '手抄报图片解析失败，请重新生成后再导出' });
      }
      // 居中适配 A4 页面，保持宽高比
      const scale = Math.min(pageW / img.width, pageH / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      doc.image(img, (pageW - w) / 2, (pageH - h) / 2, { width: w, height: h });
      doc.end();
      return;
    }

    /* ==================== 方案版：两页（版式模板 + 内容参考） ==================== */
    let content = {};
    try { content = JSON.parse(row.content); } catch (e) {}

    const colorScheme = content.colorScheme || {};
    const mainColor = pickColor(colorScheme.main, FALLBACK_COLORS.main);
    const accentColor = pickColor(colorScheme.accent, FALLBACK_COLORS.accent);
    const bgColor = pickColor(colorScheme.bg, FALLBACK_COLORS.bg);

    const doc = new PDFDocument({ margin: 0, size: 'A4', info: { Title: title, Author: '成长趣味' } });
    doc.font(CHINESE_FONT);
    const buffers = [];
    let pageCount = 1; // 初始页
    doc.on('data', buffers.push.bind(buffers));
    doc.on('pageAdded', () => { pageCount++; });
    doc.on('end', () => {
      console.log('[POSTER] pdf 生成完成: 页数=' + pageCount + ' 大小=' + Buffer.concat(buffers).length + 'B');
      sendPdf(Buffer.concat(buffers));
    });

    const ctx = {
      pageW: doc.page.width,
      pageH: doc.page.height,
      mainColor, accentColor, bgColor,
      content, row
    };

    // 第 1 页：空白手抄报版式模板
    drawPosterTemplatePage(doc, ctx);
    // 第 2 页：内容参考
    doc.addPage();
    drawReferencePage(doc, ctx);

    doc.end();
  } catch (err) {
    console.error('[POSTER] pdf error:', err.message);
    res.status(500).json({ ok: false, msg: 'PDF 生成失败：' + err.message });
  }
});

module.exports = router;
