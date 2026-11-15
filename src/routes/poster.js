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
/* 服务端合成引擎懒加载：canvas 是原生模块，若部署环境缺原生库/字体，
 * 只让生图接口报错，绝不拖垮整个服务启动 */
let _compose = null;
function loadCompose() {
  if (_compose === null) {
    try {
      _compose = require('../poster-render/compose');
    } catch (e) {
      console.error('[POSTER] 合成引擎加载失败:', e.message);
      _compose = false;
    }
  }
  if (!_compose) throw new Error('服务端合成引擎不可用，请稍后重试');
  return _compose;
}
/* emoji 素材清单（无原生依赖，可直接加载）：提示词选图约束与方案图标净化共用，
 * 保证 AI 选的板块图标一定有本地 SVG 素材可全彩绘制，不再画出码点文字 */
const emojiAssets = require('../poster-render/emoji-assets');

const DAILY_LIMIT = 200; // 每账号每日 AI 文字生成上限（防 API 费用失控）
const MAX_CUSTOM_LEN = 1200; // 自定义要求最大字数（refine 产物约 400-700 字，放宽到 1200）
const MAX_STYLE_LEN = 50; // 风格描述最大字数

/* ==================== 参数定义 ==================== */

const GRADES = ['小学一年级', '小学二年级', '小学三年级', '小学四年级', '小学五年级', '小学六年级'];

/* ==================== 年级分档口径 ====================
 * 2026-11-15 改造（用户裁决）：年级不再只是一个塞进提示词的字符串标签。
 * 每个年级映射到一组可执行约束——文字量（contentLen/bullets）、句式与生字（text）、
 * 内容深度（text）、画面复杂度（visual）——由 buildPrompt（文案）、
 * buildImagePrompt（生图）、refine（要求补全）在构造提示词时按年级查表注入。
 * 分档原则：低年级字少句短、只用常用字、画面元素少而大；年级越高，
 * 文字量、知识深度与画面信息量逐级递增。未知年级回落三年级口径。 */
const GRADE_PROFILES = {
  '小学一年级': {
    contentLen: '20~40', bullets: '1~2',
    text: '句子要短，一句只说一个意思；只用一年级小朋友学过的常用字，不用生僻字、不用成语和书面语；内容只讲看得见摸得着的事物（颜色、形状、身边的人和事），以观察、认识、感受为主，不讲抽象道理；语气活泼亲切，像讲给刚上学的孩子听',
    visual: '画面元素少而大：主体 1~2 个、个头大、轮廓圆润饱满，背景简单干净，线条粗、造型简单，装饰只用少量大号元素；配色明快、饱和度高；不要密集小装饰、不要复杂多层场景'
  },
  '小学二年级': {
    contentLen: '30~60', bullets: '2~3',
    text: '句子简短完整，一句一个意思；以常用字为主，可用最常见的简单词语，不用生僻字和成语典故；内容以观察和简单常识为主，可以有一句简单的原因说明；语气亲切自然',
    visual: '画面主体突出、元素适中：主场景 1 个加少量大号装饰，线条简单圆润，背景干净不堆砌；配色明快；不要密集小元素和复杂构图'
  },
  '小学三年级': {
    contentLen: '60~120', bullets: '2~5',
    text: '句子完整通顺；可用常见成语和简单修辞；内容要有具体知识信息（由来、习俗、常识、做法），不能只有口号；难度符合三年级学生的认知水平',
    visual: '画面元素丰富适中：主场景完整，可有 2~3 个辅助元素和适量装饰细节，构图整洁有层次；配色鲜艳明快'
  },
  '小学四年级': {
    contentLen: '80~140', bullets: '3~4',
    text: '语言通顺准确，可用成语、谚语和恰当修辞；内容要有知识含量：讲清来历、原理或做法步骤，可引用具体例子和简单数据；难度符合四年级学生的认知水平',
    visual: '画面细节较丰富：主场景加 3~4 个辅助元素，允许小场景呼应和精细装饰，构图有层次；风格可稍成熟，不要过于幼儿化'
  },
  '小学五年级': {
    contentLen: '100~160', bullets: '3~5',
    text: '可用成语、名言警句和准确的学科词汇；内容要有深度：历史背景、科学原理、文化内涵或社会意义，观点明确，可带倡议；难度符合五年级学生的认知水平',
    visual: '画面细节丰富、构图层次多：主场景加多个辅助元素和小场景呼应，装饰精细，信息量大；风格偏成熟稳重，不要婴儿化造型'
  },
  '小学六年级': {
    contentLen: '120~180', bullets: '3~5',
    text: '可用成语、名言警句、古诗文和准确的学科术语；内容要有深度和思辨：历史纵深、科学原理、社会意义或个人见解，引用要具体（人物、事件、数据、诗句出处）；难度符合六年级学生的认知水平',
    visual: '画面细节丰富、构图层次多：主场景加多个辅助元素和小场景呼应，装饰精细，信息量大；风格成熟稳重，可用国风、科普写实等偏大龄的画法，不要婴儿化造型'
  }
};

function gradeProfile(grade) {
  return GRADE_PROFILES[grade] || GRADE_PROFILES['小学三年级'];
}

/* 文字约束文本：注入文案生成与要求补全提示词（文字量数字与 text 口径同源于映射表） */
function gradeTextRule(grade) {
  const p = gradeProfile(grade);
  return `【年级适配：${grade}】必须严格按这个年级写：每个板块正文 ${p.contentLen} 字、要点 ${p.bullets} 条；${p.text}。`;
}

/* 画面约束文本：注入生图提示词（主体大小、元素密度、线条与构图复杂度按年级分档） */
function gradeVisualRule(grade) {
  const p = gradeProfile(grade);
  return `【年级画面适配：${grade}】${p.visual}。`;
}

/* ==================== agnes 调用 ==================== */

/**
 * 调用 agnes（OpenAI 兼容）生成手抄报方案
 * @param {string} prompt 用户提示词
 * @param {object} opts { plain: 纯文本模式(不强制JSON), maxTokens: 最大token }
 */
async function callAgnes(prompt, opts) {
  const { plain = false, maxTokens = 8192 } = opts || {};
  const { apiKey, baseURL, model, timeoutMs } = config.agnes;
  if (!apiKey) {
    throw new Error('服务器未配置 AGNES_AI_API_KEY');
  }
  const resp = await axios.post(baseURL + '/chat/completions', {
    model,
    messages: [
      {
        role: 'system',
        content: plain
          ? '你是小学生手抄报指导老师，回答简洁实用、通俗易懂。'
          : '你是一位优秀的小学手抄报设计老师，擅长为小学生设计主题鲜明、内容健康积极、图文并茂的手抄报方案。你只输出严格 JSON，不输出任何其他文字、markdown 或解释。'
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.8,
    max_tokens: maxTokens
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
  return plain ? String(content).trim() : parseJson(content);
}

/**
 * 调用 agnes（OpenAI 兼容）文生图，返回生成图片的 url
 * 返回结构：{ data: [ { url: "https://...", revised_prompt: "..." } ] }
 */
async function callAgnesImage(prompt, size) {
  const { apiKey, baseURL, timeoutMs } = config.agnes;
  if (!apiKey) {
    throw new Error('服务器未配置 AGNES_AI_API_KEY');
  }
  const model = process.env.AGNES_IMAGE_MODEL || 'agnes-image-2.5-flash';
  const resp = await axios.post(baseURL + '/images/generations', {
    model,
    prompt,
    size: size || '1024x1536'
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
  throw new Error('AI 返回内容解析失败（返回内容不是有效 JSON）');
}

/* ==================== Prompt 构造 ==================== */

function buildPrompt(params) {
  const { theme, grade, custom = '', style = '' } = params;

  const styleText = String(style).trim() ? String(style).trim() : '卡通可爱';
  const customText = String(custom).trim()
    ? `\n【用户的制作要求】（必须严格遵循，逐条落实到方案里）\n${String(custom).trim().slice(0, 1100)}`
    : '';
  // 图标只能从本地素材清单里选（清单动态读取素材目录，清单外图标渲染不出彩色图）
  const iconPool = emojiAssets.availableEmojis();
  const iconRule = iconPool.length
    ? `\n- 每个板块的 icon 只能从下面这组图标里选一个最贴切的，清单之外的图标一律不要用：${iconPool.join(' ')}`
    : '';

  return `请为小学主题手抄报设计一份完整方案。

【主题】${theme}
${gradeTextRule(grade)}
【画面风格】${styleText}
${customText}

内容要健康积极、通俗易懂、有趣有料。

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
}

【要求】
- sections 4~6 个板块，内容具体、紧扣「${theme}」主题${iconRule}
- 每个板块的 content 控制在 ${gradeProfile(grade).contentLen} 字，bullets ${gradeProfile(grade).bullets} 条（与上面年级适配同口径，必须严格执行）
- colorScheme 三个颜色都必须是 #RRGGBB 格式
- title 控制在 12 个字以内
- 【硬性禁令】成品图会直接打印交作业，整张图只能是手抄报正文：sections 只许是正文板块，禁止出现书写提示、排版提示、装饰建议、小贴士之类的指导性内容，也不要输出 writeTips、decorTips 字段`;
}

/**
 * 构造文生图提示词：儿童手抄报插画底图
 * 四周丰富装饰边框 + 中央大面积留白；禁止画面出现任何文字（乱码根源），
 * 标题与正文文字由 PDF 排版系统精确填入
 */
function buildImagePrompt(params) {
  const { theme, grade, custom = '', style = '', mode = '' } = params;

  const styleText = String(style).trim() ? String(style).trim() : '卡通可爱';

  /* 整图模式：AI 一次性画出「插画 + 文字」的完整手抄报 */
  if (mode === 'full') {
    const c = params.content || {};
    const secs = (Array.isArray(c.sections) ? c.sections : []).slice(0, 4)
      .map((s, i) => `【板块${i + 1}】标题「${s.title}」\n正文：${(s.content || '').slice(0, 60)}`)
      .join('\n');
    return `绘制一张竖版 A4 比例 3:4 的儿童手抄报，主题「${theme}」（${grade}）。
【画风】扁平卡通（flat cartoon），色彩鲜艳明快，构图整洁，适合 A4 直接打印。
${gradeVisualRule(grade)}
【顶部标题】醒目大标题「${c.title || theme}」${c.subtitle ? '，副标题「' + c.subtitle + '」' : ''}
${secs}
【硬性要求】
- 所有中文必须清晰、正确、无错别字、无乱码、无重复字。
- 标题醒目，板块标题与正文层级清楚。
- 文字与插画自然融合，像一张真正的黑板报/手抄报。
- 除上面指定的文字外，画面中不要出现其他任何文字。`;
  }

  /* 插画模式：为「图文分栏融合版式」生成无文字的横幅场景插画 */
  if (mode === 'illustration') {
    const scene = String(custom).trim().slice(0, 400) || (theme + '主题的欢乐卡通场景');
    return `绘制一张横向的儿童插画横幅，卡通风格：${styleText}。
画面内容：${scene}。
${gradeVisualRule(grade)}
【要求】画面饱满、色彩鲜艳、主体突出、细节丰富；适合作为手抄报的题头插画。
【绝对禁止】画面中不得出现任何文字、汉字、字母、数字、拼音、水印、签名。`;
  }

  return `请绘制一张儿童手抄报插画底图，竖版 A4 比例约 3:4，适合打印。

【主题】${theme}
${gradeVisualRule(grade)}
【画面风格】${styleText}

【版面结构】（必须严格遵守，从上到下分为四个区域）
1. 顶部标题区（约占画面高度 12%）：一条横向的空白装饰横幅/牌匾，形态要贴合「${theme}」主题（例如春节用红色春联横批或灯笼牌匾、读书日用翻开的书本造型横幅、环保日用树叶缠绕的木牌）。横幅上完全空白，不画任何文字。
2. 中部主场景区（约占画面高度 55%）：精美丰富的主题场景插画，这是画面主角——包含卡通小朋友的活动场景、主题装饰元素、节日氛围背景，色彩鲜艳、细节饱满、构图完整。
3. 内容区（约占画面高度 27%）：在场景下方错落分布 3 个空白文本框，形态贴合主题（如春节用空白春联竖条/红纸条、读书日用空白书页、科学日用空白实验记录卡）。每个框约占画面宽度 88%、高度 8%，框与框之间留出均匀间距，框内完全空白不画任何东西。
4. 底部落款区（约占画面高度 6%）：一条窄窄的空白装饰底边。

【绝对禁止】
- 全图禁止出现任何文字、汉字、字母、数字、拼音、符号。
- 所有横幅、牌匾、文本框内必须保持空白，文字将由系统后期精确排版填入。

【画风要求】色彩鲜艳明快（主体 3~4 色）、卡通造型圆润可爱、线条清晰、整体干净整洁适合 A4 打印。`;
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
  if (String(theme).length > 50) return res.status(400).json({ ok: false, msg: '主题过长（最多50字）' });
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
    // 图标净化：清单外图标映射到清单内近似/默认图标（落库即净化，详情/PDF/合成同口径）
    emojiAssets.sanitizePlanIcons(poster);
    // 整改 2026-11-14：成品图须整张即手抄报正文（可直接下载交作业），禁止书写小贴士/装饰建议等非正文板块
    delete poster.writeTips; delete poster.decorTips;

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
 * body: { accountId, openId?, theme, grade, style?, custom?, mode?, size?, dryRun? }
 * dryRun：评测专用开关，仅评测白名单账号（eval_ai_quality）+ dryRun===true 时跳过全部落库
 */
router.post('/generate-image', async (req, res) => {
  const {
    accountId, openId = '', theme, grade,
    custom = '', style = ''
  } = req.body || {};

  // 参数校验
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  if (!theme || !String(theme).trim()) return res.status(400).json({ ok: false, msg: '缺少 theme' });
  if (String(theme).length > 50) return res.status(400).json({ ok: false, msg: '主题过长（最多50字）' });
  if (!GRADES.includes(grade)) return res.status(400).json({ ok: false, msg: '不支持的年级' });
  if (String(custom).length > MAX_CUSTOM_LEN) return res.status(400).json({ ok: false, msg: '自定义要求过长（最多' + MAX_CUSTOM_LEN + '字）' });
  if (String(style).length > MAX_STYLE_LEN) return res.status(400).json({ ok: false, msg: '风格描述过长' });

  /* 评测专用 dryRun（AI 质量官抽检）：仅当 dryRun 严格 === true 且 accountId 为评测白名单账号时生效——
   * 完整走现行生成链路（提示词/Agnes 生图/文字方案/服务端合成照旧），但跳过全部 db 写入，
   * 成品图以 base64 随响应返回。其他任何账号带 dryRun 一律忽略该参数、按正常流程落库，防滥用。 */
  const isDryRun = !!(req.body && req.body.dryRun === true) && accountId === 'eval_ai_quality';

  const mode = (req.body && req.body.mode) || '';

  try {
    /* ===== illustration / full 模式：保持旧行为（素材生图 / AI 整图直出） ===== */
    if (mode === 'illustration' || mode === 'full') {
      const prompt = buildImagePrompt(req.body);
      const imgSize = req.body.size === 'landscape' ? '1536x1024'
        : (req.body.size === 'square' ? '1024x1024' : '');
      const url = await callAgnesImage(prompt, imgSize);
      if (isDryRun) {
        // dryRun：不落库，原图 URL 直接返回供评测看图
        return res.json({ ok: true, dryRun: true, imageUrl: url });
      }
      const record = {
        id: 'poster_' + crypto.randomBytes(8).toString('hex'),
        accountId,
        openId,
        theme: String(theme).trim(),
        grade,
        title: String(theme).trim() + '手抄报图片',
        source: 'image',
        config: JSON.stringify({ theme, grade, style, custom }),
        content: JSON.stringify({ theme, grade, style, custom, prompt, hasPlan: false }),
        imageUrl: url,
        createdAt: Date.now()
      };
      await db.createPoster(record);
      return res.json({ ok: true, posterId: record.id });
    }

    /* ===== 默认（自由生图）：方案 + 无文字场景插画 → 服务端合成完整成品 =====
     * 旧链路交付的是「3 个空框的空白模板图」，文字只在方案里、板块数还对不上框数。
     * 新链路：插画只作顶部主视觉，标题与全部板块由服务端排版引擎合成进图，
     * 合成图（composed_url）即正式交付，详情/封面/PDF/保存统一使用。 */
    const { composePosterImage, storeComposedImage } = loadCompose(); // 引擎不可用时先行报错，不浪费 AI 调用
    const heroScene = String(custom).trim()
      ? String(custom).trim()
      : (String(theme).trim() + '主题的欢乐卡通场景：卡通小朋友参与其中，场景饱满、色彩鲜艳、细节丰富');
    const heroPrompt = buildImagePrompt(Object.assign({}, req.body, { mode: 'illustration', custom: heroScene }));
    const planPrompt = buildPrompt(req.body);

    const [url, planFirst] = await Promise.all([
      callAgnesImage(heroPrompt, '1536x1024'),
      callAgnes(planPrompt).catch((e) => {
        console.warn('[POSTER] 文字方案生成失败，将重试一次:', e.message);
        return null;
      })
    ]);
    // 方案是合成的必需品：重试一次仍失败就报错，绝不交付无字半成品
    const plan = planFirst || await callAgnes(planPrompt);
    if (!plan || !Array.isArray(plan.sections) || plan.sections.length < 1) {
      throw new Error('AI 返回的方案缺少板块');
    }
    // 图标净化：清单外图标（如 🔥🛟👫📞）映射到清单内近似/默认图标，角标不再画码点文字
    emojiAssets.sanitizePlanIcons(plan);
    // 整改 2026-11-14：成品图须整张即手抄报正文（可直接下载交作业），禁止书写小贴士/装饰建议等非正文板块
    delete plan.writeTips; delete plan.decorTips;

    const heroResp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    const heroBuf = Buffer.from(heroResp.data || []);
    if (heroBuf.length < 100) throw new Error('插画下载失败，请重试');

    const record = {
      id: isDryRun ? 'eval_' + crypto.randomBytes(8).toString('hex') : 'poster_' + crypto.randomBytes(8).toString('hex'),
      accountId,
      openId,
      theme: String(theme).trim(),
      grade,
      title: plan.title || (String(theme).trim() + '手抄报'),
      source: 'image',
      config: JSON.stringify({ theme, grade, style, custom }),
      content: JSON.stringify(Object.assign({}, plan, {
        theme, grade, style, custom, prompt: heroPrompt,
        hasPlan: true, composed: true
      })),
      imageUrl: url,
      createdAt: Date.now()
    };
    if (!isDryRun) {
      await db.createPoster(record);
    }

    try {
      const { buffer, meta } = await composePosterImage({ plan, hero: heroBuf, theme: record.theme });
      if (isDryRun) {
        // dryRun：不走 storeComposedImage（它会 putBlob + updatePoster 回写记录），成品直接 base64 返回
        console.log('[POSTER] dryRun 合成完成（不落库）:', record.id, JSON.stringify(meta));
        return res.json({ ok: true, dryRun: true, composedBase64: buffer.toString('base64'), imageUrl: url });
      }
      const composedUrl = await storeComposedImage(db, record.id, accountId, buffer);
      console.log('[POSTER] 服务端合成完成:', record.id, JSON.stringify(meta));
      return res.json({ ok: true, posterId: record.id, composedUrl });
    } catch (composeErr) {
      // 合成失败不留半成品记录，避免用户拿到无字图（dryRun 本无记录可回滚，跳过删除）
      console.error('[POSTER] 服务端合成失败' + (isDryRun ? '（dryRun，无回滚）' : '，删除记录') + ':', composeErr.message);
      if (!isDryRun) {
        await db.deletePoster(record.id, accountId).catch(() => {});
      }
      throw new Error('手抄报合成失败，请重试');
    }
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
  if (String(theme).length > 50) return res.status(400).json({ ok: false, msg: '主题过长（最多50字）' });
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
 * POST /api/poster/create-slot
 * 为成品库槽位创建独立记录（复用已有底图 URL，供不同排版成品各自挂载）
 * body: { accountId, theme, grade, imageUrl, title }
 */
router.post('/create-slot', async (req, res) => {
  const { accountId, theme, grade, imageUrl, title = '' } = req.body || {};
  if (!accountId || !theme || !imageUrl) {
    return res.status(400).json({ ok: false, msg: '缺少参数' });
  }
  try {
    const record = {
      id: 'poster_' + crypto.randomBytes(8).toString('hex'),
      accountId,
      openId: '',
      theme: String(theme).trim(),
      grade: GRADES.includes(grade) ? grade : '小学三年级',
      title: String(title).trim() || (String(theme).trim() + '手抄报'),
      source: 'image',
      config: JSON.stringify({ theme, slot: true }),
      content: JSON.stringify({ slot: true, baseImageUrl: imageUrl }),
      imageUrl: String(imageUrl),
      createdAt: Date.now()
    };
    await db.createPoster(record);
    res.json({ ok: true, posterId: record.id });
  } catch (err) {
    console.error('[POSTER] create-slot error:', err.message);
    res.status(500).json({ ok: false, msg: '创建槽位失败：' + err.message });
  }
});


/**
 * GET /api/poster/admin-list?secret=xxx
 * 管理用：列出全部成品图（含 account_id），用于批量重合成
 */
router.get('/admin-list', async (req, res) => {
  const { secret } = req.query;
  if (secret !== (process.env.ADMIN_SECRET || 'gp-admin-2026')) {
    return res.status(403).json({ ok: false, msg: '无权限' });
  }
  try {
    const list = await db.allPostersForAdmin();
    res.json({ ok: true, data: { list } });
  } catch (err) {
    console.error('[POSTER] admin-list error:', err.message);
    res.status(500).json({ ok: false, msg: '获取失败' });
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
      imageUrl: r.imageUrl, composedUrl: r.composedUrl || r.composed_url || "",
      createdAt: r.created_at
    }));
    res.json({ ok: true, data: { list } });
  } catch (err) {
    console.error('[POSTER] list error:', err.message);
    res.status(500).json({ ok: false, msg: '获取手抄报列表失败' });
  }
});

/**
 * GET /api/poster/library?theme=xxx&limit=12
 * 公共模板成品库（不区分账号）：任何用户进入模板页都能看到预生成成品
 */
router.get('/library', async (req, res) => {
  const { theme, limit } = req.query;
  if (!theme) return res.status(400).json({ ok: false, msg: '缺少 theme' });
  try {
    const rows = await db.listLibraryPosters(String(theme).slice(0, 50), limit);
    const list = rows.map(r => ({
      id: r.id,
      theme: r.theme,
      grade: r.grade,
      title: r.title,
      source: r.source,
      imageUrl: r.imageUrl,
      composedUrl: r.composedUrl || '',
      createdAt: r.created_at
    }));
    res.json({ ok: true, data: { list } });
  } catch (err) {
    console.error('[POSTER] library error:', err.message);
    res.status(500).json({ ok: false, msg: '获取模板成品库失败' });
  }
});

/**
 * 读取记录的合成成品图（库内 blob）；无成品或数据无效返回 null
 * composed_url 形如 /api/poster/composed/poster_xxx.jpg
 */
async function loadComposedBuffer(row) {
  const url = row && (row.composedUrl || row.composed_url);
  if (!url) return null;
  const name = String(url).split('/').pop();
  if (!/^poster_[a-z0-9]+\.(png|jpg)$/i.test(name)) return null;
  const data = await db.getBlob('composed/' + name);
  if (!data) return null;
  const buf = Buffer.from(data, 'base64');
  return buf.length >= 100 ? buf : null;
}

/**
 * GET /api/poster/composed/:name
 * 返回数据库中存储的成品图（持久卷，重启不丢）
 */
router.get('/composed/:name', async (req, res) => {
  const name = String(req.params.name || '');
  // 只允许 poster_xxx.(png|jpg) 形式，防目录穿越
  const m = name.match(/^poster_[a-z0-9]+\.(png|jpg)$/i);
  if (!m) {
    return res.status(400).json({ ok: false, msg: '非法文件名' });
  }
  const ext = m[1].toLowerCase();
  try {
    const data = await db.getBlob('composed/' + name);
    if (!data) return res.status(404).json({ ok: false, msg: '成品图不存在' });
    const buf = Buffer.from(data, 'base64');
    res.set('Content-Type', ext === 'png' ? 'image/png' : 'image/jpeg');
    res.set('Content-Length', buf.length);
    res.set('Cache-Control', 'public, max-age=604800');
    res.send(buf);
  } catch (err) {
    console.error('[POSTER] composed 读取失败:', err.message);
    res.status(500).json({ ok: false, msg: '读取成品图失败' });
  }
});

/**
 * GET /api/poster/limits?accountId=xxx
 * 今日剩余生成次数（AI 文字 / AI 生图），供前端展示
 */
router.get('/limits', async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const aiUsed = await db.countPostersToday(accountId, startOfDay.getTime());
    res.json({
      ok: true,
      data: {
        aiRemain: Math.max(0, DAILY_LIMIT - aiUsed),
        imageRemain: null,  // 生图不限制
        aiLimit: DAILY_LIMIT,
        imageLimit: null    // 生图不限制
      }
    });
  } catch (err) {
    console.error('[POSTER] limits error:', err.message);
    res.status(500).json({ ok: false, msg: '获取剩余次数失败' });
  }
});

/**
 * POST /api/poster/refine
 * AI 补全/优化自定义要求：粗略想法 → 400~500 字详细制作说明，可多轮迭代
 * body: { accountId, theme, grade, rough }
 */
router.post('/refine', async (req, res) => {
  const { accountId, theme = '', grade = '', rough = '' } = req.body || {};
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  if (!rough || !String(rough).trim()) return res.status(400).json({ ok: false, msg: '请先输入你的想法' });

  const input = String(rough).trim().slice(0, 600);
  const prompt = `你是小学生手抄报指导老师。手抄报主题「${theme || '自定'}」（${grade || '小学'}）。
${GRADES.includes(grade) ? gradeTextRule(grade) + '\n' : ''}用户的需求描述：
「${input}」

请把它整理/扩写成一份详细的手抄报制作说明，建议总长度 400~500 字左右（内容需要时可适当更多，不设硬性上限），用数字序号分条，必须覆盖以下 6 个方面：
1. 版面布局：分几个板块、各板块的位置与大致比例（如顶部标题带、左/右/下板块分布）。
2. 板块内容：每个板块的标题和 2~3 条具体内容要点（写什么文字，紧扣主题、适合${grade || '小学生'}）。
3. 插图元素：具体画什么（人物、建筑、植物、吉祥物等），紧扣「${theme || '主题'}」，位置明确。
4. 配色方案：主色、辅色、背景色，给出具体颜色（如"中国红 #E63946 + 金黄"）。
5. 标题设计：标题文字建议 + 美术字样式（如空心字、彩色描边）。
6. 装饰细节：花边样式、四角装饰、点缀元素。

要求：内容具体可执行、健康积极、适合直接照着制作。只输出说明文本本身，不要开场白、不要解释、不要 markdown 标记。`;

  try {
    const refined = await callAgnes(prompt, { plain: true, maxTokens: 1200 });
    res.json({ ok: true, data: { refined } });
  } catch (err) {
    console.error('[POSTER] refine error:', err.message);
    res.status(500).json({ ok: false, msg: 'AI 补全失败，请直接填写要求或稍后再试' });
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
        composedUrl: row.composedUrl || '',
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
 * GET /api/poster/:id/cover?accountId=xxx
 * 图片代理：服务端拉取 AI 图床图片后以图片流返回。
 * 解决真机 downloadFile 域名白名单限制（AI 图床域名不可配）。
 */
router.get('/:id/cover', async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  try {
    const row = await db.getPoster(req.params.id, accountId);
    if (!row) return res.status(404).json({ ok: false, msg: '图片不存在' });
    // 正式交付是合成成品图：有 composed 就直接发库内成品（详情保存相册走本接口）
    const composedBuf = await loadComposedBuffer(row);
    if (composedBuf) {
      let mime = 'image/png';
      if (composedBuf[0] === 0xFF && composedBuf[1] === 0xD8) mime = 'image/jpeg';
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Length', composedBuf.length);
      return res.send(composedBuf);
    }
    if (!row.imageUrl) return res.status(404).json({ ok: false, msg: '图片不存在' });
    const resp = await axios.get(row.imageUrl, { responseType: 'arraybuffer', timeout: 20000 });
    const buf = Buffer.from(resp.data || []);
    if (buf.length < 100) return res.status(500).json({ ok: false, msg: '图片数据无效' });
    // 依据签名给 MIME
    let mime = 'image/png';
    if (buf[0] === 0xFF && buf[1] === 0xD8) mime = 'image/jpeg';
    else if (buf.toString('ascii', 0, 4) === 'RIFF') mime = 'image/webp';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (err) {
    console.error('[POSTER] cover 代理失败:', err.message);
    res.status(500).json({ ok: false, msg: '图片拉取失败，请稍后重试' });
  }
});

/**
 * POST /api/poster/batch-delete
 * 批量删除手抄报
 * body: { accountId, ids: [id1, id2, ...] }
 */
router.post('/batch-delete', async (req, res) => {
  const { accountId, ids } = req.body || {};
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ ok: false, msg: '缺少要删除的 ids' });
  }
  // 上限保护：单次最多 50 条
  const target = ids.slice(0, 50);
  try {
    const results = await Promise.all(target.map(id => db.deletePoster(id, accountId)));
    const deleted = results.filter(Boolean).length;
    res.json({ ok: true, data: { deleted, failed: target.length - deleted } });
  } catch (err) {
    console.error('[POSTER] batch-delete error:', err.message);
    res.status(500).json({ ok: false, msg: '批量删除失败' });
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

/** 画一朵小花（6 片花瓣 + 花心），用于手抄报装饰 */
function drawFlower(doc, cx, cy, r, petalColor, centerColor) {
  const petals = 6;
  for (let i = 0; i < petals; i++) {
    const ang = (i / petals) * Math.PI * 2;
    doc.fillColor(petalColor)
      .circle(cx + Math.cos(ang) * r * 0.72, cy + Math.sin(ang) * r * 0.72, r * 0.42)
      .fill();
  }
  doc.fillColor(centerColor).circle(cx, cy, r * 0.38).fill();
}

/** 画太阳（圆 + 8 条射线） */
function drawSun(doc, cx, cy, r, color) {
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const x1 = cx + Math.cos(ang) * r * 1.25;
    const y1 = cy + Math.sin(ang) * r * 1.25;
    const x2 = cx + Math.cos(ang) * r * 1.7;
    const y2 = cy + Math.sin(ang) * r * 1.7;
    doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(2).strokeColor(color).stroke();
  }
  doc.fillColor(color).circle(cx, cy, r).fill();
}

/** 画云朵（3 圆并排 + 底边） */
function drawCloud(doc, cx, cy, r, color) {
  doc.fillColor(color)
    .circle(cx - r * 0.9, cy, r * 0.62).fill()
    .circle(cx, cy - r * 0.35, r * 0.85).fill()
    .circle(cx + r * 0.9, cy, r * 0.62).fill();
  doc.roundedRect(cx - r * 1.5, cy - r * 0.1, r * 3, r * 0.7, r * 0.35).fill();
}

/** 画气球（椭圆 + 线 + 结） */
function drawBalloon(doc, cx, cy, rx, ry, color) {
  doc.fillColor(color).ellipse(cx, cy, rx, ry).fill();
  doc.moveTo(cx, cy + ry).lineTo(cx - 3, cy + ry + 5).lineTo(cx + 3, cy + ry + 5).closePath().fill();
  doc.moveTo(cx, cy + ry + 5)
    .quadraticCurveTo(cx + 8, cy + ry + 18, cx - 2, cy + ry + 30)
    .lineWidth(1).strokeColor('#999999').stroke();
}

/** 画卡通小朋友（圆头 + 表情 + 身体 + 张开手臂），手拉手效果 */
function drawKid(doc, cx, cy, scale, shirtColor, skinColor) {
  const s = scale;
  // 手臂（先画，压在身体下）：从肩到外侧上扬
  doc.lineWidth(2.5 * s).strokeColor(skinColor)
    .moveTo(cx - 8 * s, cy + 4 * s).lineTo(cx - 15 * s, cy - 4 * s).stroke()
    .moveTo(cx + 8 * s, cy + 4 * s).lineTo(cx + 15 * s, cy - 4 * s).stroke();
  // 身体（衣服）
  doc.fillColor(shirtColor)
    .roundedRect(cx - 8 * s, cy, 16 * s, 14 * s, 4 * s).fill();
  // 腿
  doc.lineWidth(2 * s).strokeColor('#555555')
    .moveTo(cx - 4 * s, cy + 14 * s).lineTo(cx - 5 * s, cy + 21 * s).stroke()
    .moveTo(cx + 4 * s, cy + 14 * s).lineTo(cx + 5 * s, cy + 21 * s).stroke();
  // 头
  doc.fillColor(skinColor).circle(cx, cy - 8 * s, 8 * s).fill();
  // 头发（头顶半圆）
  doc.fillColor('#4A3728');
  doc.moveTo(cx - 8 * s, cy - 9 * s);
  doc.quadraticCurveTo(cx, cy - 20 * s, cx + 8 * s, cy - 9 * s);
  doc.quadraticCurveTo(cx, cy - 14 * s, cx - 8 * s, cy - 9 * s);
  doc.fill();
  // 眼睛 + 微笑
  doc.fillColor('#333333')
    .circle(cx - 3 * s, cy - 7 * s, 1.1 * s).fill()
    .circle(cx + 3 * s, cy - 7 * s, 1.1 * s).fill();
  doc.lineWidth(1.2 * s).strokeColor('#333333')
    .moveTo(cx - 2.5 * s, cy - 4.5 * s)
    .quadraticCurveTo(cx, cy - 2.5 * s, cx + 2.5 * s, cy - 4.5 * s).stroke();
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

  // 花边：虚线内框（手抄报花边感）
  doc.lineWidth(1.2).strokeColor(accentColor).dash(5, { space: 4 })
    .rect(b + 17, b + 17, pageW - b * 2 - 34, pageH - b * 2 - 34).stroke();
  doc.undash();

  // 四角装饰：圆点 + 小方块
  [[b + 9, b + 9], [b + 9, pageH - b - 9], [pageW - b - 9, b + 9], [pageW - b - 9, pageH - b - 9]].forEach(([x, y]) => {
    drawDot(doc, x, y, 5, accentColor);
    drawDiamond(doc, x, y, 5, mainColor);
  });
  [[b, b], [b, pageH - b], [pageW - b, b], [pageW - b, pageH - b]].forEach(([x, y]) => drawDot(doc, x, y, 3, accentColor));

  // 小花装饰：四角 + 上下边中间（花边点缀）
  [[b + 8, b + 8], [b + 8, pageH - b - 8], [pageW - b - 8, b + 8], [pageW - b - 8, pageH - b - 8]].forEach(([x, y]) => {
    drawFlower(doc, x, y, 9, mainColor, '#FFFFFF');
  });
  drawFlower(doc, pageW / 2, b + 6, 8, mainColor, '#FFFFFF');
  drawFlower(doc, pageW / 2, pageH - b - 6, 8, mainColor, '#FFFFFF');

  // 上/下边零星点缀小圆点
  for (let i = 0; i < 6; i++) {
    const ex = 60 + i * ((pageW - 120) / 5);
    drawDot(doc, ex, b + 4, 2.5, accentColor);
    drawDot(doc, ex, pageH - b - 4, 2.5, accentColor);
  }

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

  // 标题横幅两侧装饰星形
  const bannerCY = bannerY + bannerH / 2;
  drawStar(doc, bannerX - 26, bannerCY, 8, '#FFFFFF');
  drawStar(doc, bannerX + bannerW + 26, bannerCY, 8, '#FFFFFF');
  drawDot(doc, bannerX - 14, bannerCY + 30, 3, '#FFFFFF');
  drawDot(doc, bannerX + bannerW + 14, bannerCY + 30, 3, '#FFFFFF');

  // 中部板块框：2 列网格（板块多则加行、少则单列），accent 描边、顶部 icon+标题、框内填入真实内容
  const sections = Array.isArray(ctx.content.sections) && ctx.content.sections.length > 0
    ? ctx.content.sections
    : [{ icon: '✏️', title: '内容区' }];
  const boxLeft = b + 34;
  const boxRight = pageW - b - 34;
  const gap = 18;
  const cols = sections.length >= 3 ? 2 : 1;
  const rows = Math.max(1, Math.ceil(sections.length / cols));

  // 卡通装饰带（板块少时才有空间）：太阳 + 手拉手小朋友 + 气球 + 云朵
  let decoBandH = 0;
  if (rows <= 2) {
    decoBandH = 64;
    const bandCY = bannerY + bannerH + 14 + 24;
    const bandL = b + 70;
    const bandR = pageW - b - 70;
    drawSun(doc, bandL + 14, bandCY - 10, 11, '#F5B840');
    drawCloud(doc, bandR - 20, bandCY - 12, 13, '#BFD9F2');
    drawBalloon(doc, bandL + 66, bandCY - 14, 8, 10, accentColor);
    const kidCY = bandCY + 6;
    drawKid(doc, (bandL + bandR) / 2 - 22, kidCY, 1.1, mainColor, '#FFD9B3');
    drawKid(doc, (bandL + bandR) / 2 + 22, kidCY, 1.1, accentColor, '#FFE3C2');
    // 拉手
    doc.lineWidth(2.5).strokeColor('#FFD9B3')
      .moveTo((bandL + bandR) / 2 - 7, kidCY - 4.4)
      .lineTo((bandL + bandR) / 2 + 7, kidCY - 4.4).stroke();
  }

  const boxW = (boxRight - boxLeft - gap * (cols - 1)) / cols;
  const boxTop = bannerY + bannerH + 24 + decoBandH;
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
    // 框内填入真实内容（正文自动换行 + 要点列表，直接打印可用）
    const bodyTop = dividerY + 8;
    const bodyLeft = bx + 14;
    const bodyW = boxW - 28;
    const bodyBottom = by + boxH - 10;
    doc.fillColor('#333333').fontSize(10.5);
    if (section.content) {
      doc.text(String(section.content), bodyLeft, bodyTop, {
        width: bodyW, height: bodyBottom - bodyTop, ellipsis: true, lineGap: 2.5
      });
    }
    const bullets = Array.isArray(section.bullets) ? section.bullets : [];
    let ly = Math.min(bodyBottom - 14, doc.y + 5);
    bullets.forEach((bl, bi) => {
      if (ly > bodyBottom - 13) return;
      doc.fillColor('#555555').fontSize(9.5)
        .text('• ' + String(bl), bodyLeft, ly, { width: bodyW, height: 14, ellipsis: true });
      ly += 15;
      if (bi === 0 && !section.content) doc.y = ly; // 无正文时为后续要点续行
    });
  });

  // 底部小字提示
  doc.fillColor('#999999').fontSize(10)
    .text('内容已为你填好，直接打印即可使用', 0, pageH - 44, { width: pageW, align: 'center' });

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
      // 优先用库内合成成品图（文字已在图上）：此时整页即成品，不再叠字
      const composedBuf = await loadComposedBuffer(row).catch(() => null);
      let imageBuffer;
      if (composedBuf) {
        imageBuffer = composedBuf;
      } else if (!row.imageUrl) {
        return res.status(500).json({ ok: false, msg: '该手抄报缺少图片地址，无法导出 PDF' });
      } else {
        // 下载成品图（15s 超时），失败返回友好错误
        try {
          const resp = await axios.get(row.imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
          imageBuffer = Buffer.from(resp.data || []);
        } catch (err) {
          console.error('[POSTER] pdf 图片下载失败:', err.message);
          return res.status(500).json({ ok: false, msg: '手抄报图片下载失败，请稍后重试' });
        }
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
      // 第 1 页：纯插画 cover 铺满 A4（无任何叠框，完整保留 AI 画面）
      const coverScale = Math.max(pageW / img.width, pageH / img.height);
      const w = img.width * coverScale;
      const h = img.height * coverScale;
      doc.image(img, (pageW - w) / 2, (pageH - h) / 2, { width: w, height: h });

      // ===== 单页成品：插画做背景 + 文字叠在半透明纱上，打印一张 A4 即是成品 =====
      let planContent = {};
      try { planContent = JSON.parse(row.content) || {}; } catch (e) {}
      const sections = Array.isArray(planContent.sections) ? planContent.sections.filter(s => s && (s.title || s.content)) : [];
      const mainColor = pickColor(planContent.colorScheme && planContent.colorScheme.main, FALLBACK_COLORS.main);
      const accentColor = pickColor(planContent.colorScheme && planContent.colorScheme.accent, FALLBACK_COLORS.accent);
      doc.font(CHINESE_FONT);

      if (!composedBuf && (sections.length > 0 || planContent.title)) {
        // 整页半透明白纱：插画隐约可见当背景，叠字后打印清晰
        doc.fillOpacity(0.5).fillColor('#FFFFFF');
        doc.rect(0, 0, pageW, pageH).fill();
        doc.fillOpacity(1);

        // 顶部标题横幅：主色实底 + 白字（手抄报报头）
        const bnH = 88;
        const bnY = 36;
        const bnX = 40;
        const bnW = pageW - bnX * 2;
        doc.fillOpacity(0.94).fillColor(mainColor);
        doc.roundedRect(bnX, bnY, bnW, bnH, 16).fill();
        doc.fillOpacity(1).fillColor('#FFFFFF');
        const posterTitle = planContent.title || title;
        const posterSubtitle = planContent.subtitle || ((planContent.grade || '') + (planContent.theme ? ' · ' + planContent.theme : ''));
        if (posterSubtitle) {
          doc.fontSize(26).text(posterTitle, bnX, bnY + 12, { width: bnW, align: 'center' });
          doc.fontSize(11).fillOpacity(0.92).text(posterSubtitle, bnX, bnY + bnH - 28, { width: bnW, align: 'center' });
          doc.fillOpacity(1);
        } else {
          doc.fontSize(29).text(posterTitle, bnX, bnY + (bnH - 38) / 2, { width: bnW, align: 'center' });
        }

        // 板块卡：占页面上部约 72%，底部留白露出插画装饰带（像真手抄报的底部花边）
        if (sections.length > 0) {
          const sTop = bnY + bnH + 16;
          const sBottom = pageH * 0.74;
          const sGap = 12;
          const cols = sections.length >= 3 ? 2 : 1;
          const rows = Math.ceil(Math.min(sections.length, 6) / cols);
          const sLeft = 40;
          const sW = (pageW - sLeft * 2 - sGap * (cols - 1)) / cols;
          const sH = Math.min(240, Math.max(110, (sBottom - sTop - sGap * (rows - 1)) / rows));
          sections.slice(0, rows * cols).forEach((section, i) => {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const sx = sLeft + col * (sW + sGap);
            const sy = sTop + row * (sH + sGap);
            // 半透明白卡：透出插画色感，正文仍清晰
            doc.fillOpacity(0.88).fillColor('#FFFFFF');
            doc.roundedRect(sx, sy, sW, sH, 12).fill();
            doc.roundedRect(sx, sy, sW, sH, 12).lineWidth(2).strokeColor(accentColor).stroke();
            doc.fillOpacity(1);
            // 标题条（accent 浅底）
            const headH = 24;
            doc.fillOpacity(0.16).fillColor(accentColor);
            doc.roundedRect(sx, sy, sW, headH, 12).fill();
            doc.roundedRect(sx, sy + headH - 12, sW, 12, 0).fill();
            doc.fillOpacity(1);
            doc.fillColor(mainColor).fontSize(12.5)
              .text((section.icon ? section.icon + ' ' : '') + (section.title || ''), sx + 12, sy + 5, { width: sW - 24, lineBreak: false });
            // 正文
            doc.fillColor('#333333').fontSize(9.5);
            const bodyY = sy + headH + 7;
            const bodyH = sH - headH - 16;
            doc.text(section.content || '', sx + 12, bodyY, { width: sW - 24, height: bodyH, ellipsis: true, lineGap: 1.5 });
            // 要点
            const bullets = Array.isArray(section.bullets) ? section.bullets.slice(0, 3) : [];
            let by = Math.min(sy + sH - 13, doc.y + 5);
            bullets.forEach((b) => {
              if (by > sy + sH - 13) return;
              doc.fillColor(accentColor).fontSize(8.5).text('•', sx + 12, by, { lineBreak: false });
              doc.fillColor('#555555').fontSize(8.5).text(String(b), sx + 21, by, { width: sW - 33, ellipsis: true, lineBreak: false });
              by += 12;
            });
          });
        }

        // 底部小字落款（白纱上深灰可读）
        doc.fillOpacity(0.9).fillColor('#8A97A8').fontSize(8.5)
          .text('「成长趣味」· 打印后可直接装饰上色', 0, pageH - 24, { width: pageW, align: 'center' });
        doc.fillOpacity(1);
      }
      doc.end();
      return;
    }

    /* ==================== 方案版：两页（版式模板 + 内容参考） ==================== 版：两页（版式模板 + 内容参考） ==================== */
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
/* 供质量自测直接调用取证：年级映射表与提示词构造函数（验证年级约束真的注入提示词） */
module.exports.GRADES = GRADES;
module.exports.GRADE_PROFILES = GRADE_PROFILES;
module.exports.gradeProfile = gradeProfile;
module.exports.gradeTextRule = gradeTextRule;
module.exports.gradeVisualRule = gradeVisualRule;
module.exports.buildPrompt = buildPrompt;
module.exports.buildImagePrompt = buildImagePrompt;
