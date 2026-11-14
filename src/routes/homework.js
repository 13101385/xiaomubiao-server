/**
 * 作业拍照 AI 批改路由（1.5.13 新增）
 *
 * POST /api/homework/grade-photo  家长上传作业照片（base64），Agnes 视觉逐题给
 *                                 对错建议 + 一句话解析，返回结构化建议供家长逐题确认。
 * GET  /api/homework/tmp/:name   临时图片出口：照片落临时目录换公网 URL 供 Agnes 拉取，
 *                                 处理完成后立即删除（handler 内白名单 + TTL 双保险）。
 *
 * 口径与红线：
 * - AI 只给「建议」，不落库、不判分；是否生效由家长在小程序端逐题确认（前端完成）。
 * - 照片只在临时目录短暂停留（单次请求生命周期 + 10 分钟 TTL 清扫），不入数据库。
 * - 限流：同一账号 1 小时最多 20 次（与 feedback 同口径），无账号按来源 IP 计；内存计数。
 * - 依赖：优先火山方舟（环境变量 ARK_API_KEY，豆包视觉，base64 直传不需要临时图）；
 *   未配置 ARK_API_KEY 时回退 Agnes（环境变量 AGNES_AI_API_KEY，config.agnes，走临时图 URL）。
 * - 本文件不依赖 db，可独立挂载自测；两家调用均可经 __set*VisionCaller 注入 mock。
 */
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');

const router = express.Router();

const SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '政治'];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;      // 解码后图片上限 8MB
const MAX_BASE64_LEN = 12 * 1024 * 1024;      // base64 字符串上限（约对应 9MB 二进制）
const MAX_ITEMS = 30;                          // 与前端批改单题数上限一致
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const TMP_TTL_MS = 10 * 60 * 1000;             // 临时图最长存活 10 分钟
const TMP_DIR = path.join(__dirname, '..', '..', 'data', 'hw-tmp');
const TMP_NAME_RE = /^[a-f0-9]{32}\.(jpg|png)$/;

/* ==================== 限流（内存，基础口径） ==================== */

const rateMap = new Map(); // key -> [timestamp,...]

function rateAllowed(key) {
  const now = Date.now();
  const arr = (rateMap.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_LIMIT) {
    rateMap.set(key, arr);
    return false;
  }
  arr.push(now);
  rateMap.set(key, arr);
  return true;
}

/* ==================== Agnes 视觉调用 ==================== */

/**
 * 构造批改提示词：强制严格 JSON 输出，逐题给建议对错与一句话解析。
 * 解析只供家长参考的口径写进提示词，避免模型输出面向学生的答案讲解。
 */
function buildPrompt(subject) {
  const subj = SUBJECTS.includes(subject) ? subject : '';
  return [
    '你是一位小学/初中作业批改助手，正在协助家长批改' + (subj ? '「' + subj + '」' : '') + '作业。',
    '请仔细看这张作业照片，逐题识别并判断学生作答是否正确。',
    '',
    '只输出严格 JSON（不要任何其他文字、不要 markdown 代码块），格式如下：',
    '{"items":[{"no":1,"stem":"题目原文（简要转写）","studentAnswer":"学生写下的答案","verdict":"correct","explanation":"一句话说明为什么对或错","confidence":0.95}]}',
    '',
    '字段要求：',
    '- no：题号，按照片中顺序从 1 开始；',
    '- stem：题目原文，简要转写，不超过 80 字；',
    '- studentAnswer：学生写下的答案，看不清写空字符串；',
    '- verdict：只能是 correct（对）、wrong（错）、unsure（看不清或无法判断）；',
    '- explanation：一句话解析，面向家长说明对错原因，不超过 60 字；',
    '- confidence：0 到 1 的小数，你对这道题判断的把握；',
    '看不清、题目残缺或答案缺失时 verdict 用 unsure 且 confidence 给低值，不要猜测。',
    '最多识别 30 题。'
  ].join('\n');
}

/** 默认 Agnes 调用（OpenAI 兼容 chat/completions，image_url 内容块）。返回模型文本。 */
async function defaultAgnesVision(imageUrl, subject) {
  const { apiKey, baseURL, model, timeoutMs } = config.agnes;
  if (!apiKey) {
    const err = new Error('服务器未配置 AGNES_AI_API_KEY');
    err.code = 'AGNES_NOT_CONFIGURED';
    throw err;
  }
  const resp = await axios.post(baseURL + '/chat/completions', {
    model,
    messages: [
      { role: 'system', content: '你只输出严格 JSON，不输出任何其他文字、markdown 或解释。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildPrompt(subject) },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }
    ],
    temperature: 0.2,
    max_tokens: 4096
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
    const err = new Error('AI 未返回内容');
    err.code = 'AGNES_FAILED';
    throw err;
  }
  return String(content);
}

let agnesVisionCaller = defaultAgnesVision;

/* ==================== 火山方舟视觉调用（主力） ==================== */

const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const ARK_DEFAULT_MODEL = 'doubao-seed-2-1-pro-260915';

/** 默认方舟调用（OpenAI 兼容 chat/completions，图片以 base64 data URL 直传）。返回模型文本。 */
async function defaultArkVision(dataUrl, subject) {
  const apiKey = process.env.ARK_API_KEY || '';
  if (!apiKey) {
    const err = new Error('服务器未配置 ARK_API_KEY');
    err.code = 'ARK_NOT_CONFIGURED';
    throw err;
  }
  const model = process.env.ARK_MODEL || ARK_DEFAULT_MODEL;
  const resp = await axios.post(ARK_BASE + '/chat/completions', {
    model,
    messages: [
      { role: 'system', content: '你只输出严格 JSON，不输出任何其他文字、markdown 或解释。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildPrompt(subject) },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ],
    temperature: 0.2,
    max_tokens: 4096
  }, {
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    timeout: 90000
  });
  const content = resp.data && resp.data.choices && resp.data.choices[0]
    ? (resp.data.choices[0].message && resp.data.choices[0].message.content) || ''
    : '';
  if (!content) {
    const err = new Error('AI 未返回内容');
    err.code = 'ARK_FAILED';
    throw err;
  }
  return String(content);
}

let arkVisionCaller = defaultArkVision;

/** 当前生效的视觉提供方：配了 ARK_API_KEY 走方舟，否则回退 Agnes。 */
function visionProvider() {
  return process.env.ARK_API_KEY ? 'ark' : 'agnes';
}

/* ==================== 返回解析与归一化（容错） ==================== */

/** 从模型文本里提取 JSON（剥围栏、截取首尾大括号/方括号），失败抛 AGNES_BAD_JSON */
function extractJson(text) {
  let t = String(text == null ? '' : text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const firstObj = t.indexOf('{');
  const firstArr = t.indexOf('[');
  let start = -1;
  let end = -1;
  if (firstArr >= 0 && (firstObj < 0 || firstArr < firstObj)) {
    start = firstArr;
    end = t.lastIndexOf(']');
  } else if (firstObj >= 0) {
    start = firstObj;
    end = t.lastIndexOf('}');
  }
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    return JSON.parse(t);
  } catch (e) {
    const err = new Error('AI 返回内容不是合法 JSON');
    err.code = 'AGNES_BAD_JSON';
    throw err;
  }
}

function clampText(v, max) {
  const s = typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
  return s.slice(0, max);
}

function normalizeVerdict(v) {
  const s = String(v == null ? '' : v).toLowerCase();
  if (s === 'correct' || s === 'right' || s === '对' || s === '正确') return 'correct';
  if (s === 'wrong' || s === 'incorrect' || s === '错' || s === '错误') return 'wrong';
  return 'unsure';
}

function normalizeConfidence(v) {
  let n = Number(v);
  if (!isFinite(n)) return 0;
  if (n > 1 && n <= 100) n = n / 100; // 容错：百分数写法
  if (n < 0) n = 0;
  if (n > 1) n = 1;
  return Math.round(n * 100) / 100;
}

/** 把模型解析结果归一化为前端契约：[{no, stem, studentAnswer, verdict, explanation, confidence}] */
function normalizeItems(parsed) {
  const raw = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : null);
  if (!raw) {
    const err = new Error('AI 返回内容缺少 items 数组');
    err.code = 'AGNES_BAD_JSON';
    throw err;
  }
  const items = [];
  raw.slice(0, MAX_ITEMS).forEach((it, i) => {
    if (!it || typeof it !== 'object') return;
    const noRaw = Number(it.no);
    items.push({
      no: Number.isInteger(noRaw) && noRaw >= 1 && noRaw <= MAX_ITEMS ? noRaw : i + 1,
      stem: clampText(it.stem != null ? it.stem : (it.question != null ? it.question : it.title), 300),
      studentAnswer: clampText(it.studentAnswer != null ? it.studentAnswer : (it.answer != null ? it.answer : it.student_answer), 200),
      verdict: normalizeVerdict(it.verdict != null ? it.verdict : (it.suggestion != null ? it.suggestion : it.result)),
      explanation: clampText(it.explanation != null ? it.explanation : (it.analysis != null ? it.analysis : it.reason), 200),
      confidence: normalizeConfidence(it.confidence)
    });
  });
  if (!items.length) {
    const err = new Error('AI 没有识别出题目');
    err.code = 'AGNES_BAD_JSON';
    throw err;
  }
  return items;
}

/* ==================== 临时图片 ==================== */

function ensureTmpDir() {
  try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch (e) { /* 已存在忽略 */ }
}

/** 清扫过期临时图（兜底防残留） */
function sweepTmp() {
  ensureTmpDir();
  let names = [];
  try { names = fs.readdirSync(TMP_DIR); } catch (e) { return; }
  const now = Date.now();
  names.forEach(name => {
    if (!TMP_NAME_RE.test(name)) return;
    const p = path.join(TMP_DIR, name);
    try {
      const st = fs.statSync(p);
      if (now - st.mtimeMs > TMP_TTL_MS) fs.unlinkSync(p);
    } catch (e) { /* 忽略 */ }
  });
}

/** 校验图片 base64 并定扩展名；非法抛带 code 的 Error */
function decodeImage(imageBase64) {
  if (typeof imageBase64 !== 'string' || !imageBase64) {
    const err = new Error('缺少作业照片');
    err.code = 'PARAM';
    throw err;
  }
  const b64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  if (b64.length > MAX_BASE64_LEN) {
    const err = new Error('照片太大了，请拍清楚一点或裁剪后重试');
    err.code = 'IMAGE_INVALID';
    throw err;
  }
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (e) { buf = null; }
  if (!buf || !buf.length) {
    const err = new Error('照片数据无效');
    err.code = 'IMAGE_INVALID';
    throw err;
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    const err = new Error('照片太大了，请拍清楚一点或裁剪后重试');
    err.code = 'IMAGE_INVALID';
    throw err;
  }
  let ext = '';
  if (buf[0] === 0xFF && buf[1] === 0xD8) ext = 'jpg';
  else if (buf[0] === 0x89 && buf[1] === 0x50) ext = 'png';
  if (!ext) {
    const err = new Error('只支持 JPG / PNG 照片');
    err.code = 'IMAGE_INVALID';
    throw err;
  }
  return { buf, ext };
}

/** 由请求推导对外基地址（优先 env PUBLIC_BASE_URL，其次反代头，最后 Host） */
function publicBase(req) {
  const env = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (env) return env;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return proto + '://' + host;
}

/* ==================== 路由 ==================== */

/** 临时图出口：仅供 Agnes 拉取本次照片，文件名随机不可猜测，过期即删 */
router.get('/tmp/:name', (req, res) => {
  const name = String(req.params.name || '');
  if (!TMP_NAME_RE.test(name)) {
    return res.status(404).json({ ok: false, msg: '文件不存在' });
  }
  const file = path.join(TMP_DIR, name);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      return res.status(404).json({ ok: false, msg: '文件不存在' });
    }
    if (Date.now() - st.mtimeMs > TMP_TTL_MS) {
      fs.unlink(file, () => {});
      return res.status(404).json({ ok: false, msg: '文件已过期' });
    }
    res.type(name.endsWith('.png') ? 'png' : 'jpg');
    res.sendFile(file);
  });
});

/**
 * POST /api/homework/grade-photo
 * 入参：{ accountId, imageBase64, subject? }
 * 成功：{ ok:true, data:{ items:[{no,stem,studentAnswer,verdict,explanation,confidence}], count } }
 * 失败：{ ok:false, code, msg }（400 参数/图片、429 限流、502 AI 异常、500 未配置/内部）
 */
router.post('/grade-photo', async (req, res) => {
  const body = req.body || {};
  const accountId = typeof body.accountId === 'string' ? body.accountId.slice(0, 128) : '';
  if (!accountId) {
    return res.status(400).json({ ok: false, code: 'PARAM', msg: '缺少账号信息，请重新登录后再试' });
  }
  const subject = SUBJECTS.includes(body.subject) ? body.subject : '';

  const rateKey = accountId || ('ip:' + (req.ip || 'unknown'));
  if (!rateAllowed(rateKey)) {
    return res.status(429).json({ ok: false, code: 'RATE_LIMITED', msg: '拍照批改太频繁了，请稍后再试' });
  }

  let tmpFile = '';
  try {
    sweepTmp();
    const { buf, ext } = decodeImage(body.imageBase64);
    let text;
    if (visionProvider() === 'ark') {
      // 方舟支持 base64 直传，照片不落盘
      const dataUrl = 'data:image/' + (ext === 'png' ? 'png' : 'jpeg') + ';base64,' + buf.toString('base64');
      text = await arkVisionCaller(dataUrl, subject);
    } else {
      // Agnes 需要公网 URL：照片落临时目录，请求结束即删
      ensureTmpDir();
      const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
      tmpFile = path.join(TMP_DIR, name);
      fs.writeFileSync(tmpFile, buf);
      const imageUrl = publicBase(req) + '/api/homework/tmp/' + name;
      text = await agnesVisionCaller(imageUrl, subject);
    }
    const items = normalizeItems(extractJson(text));
    res.json({ ok: true, data: { items, count: items.length } });
  } catch (err) {
    const code = err && err.code ? err.code : '';
    if (code === 'PARAM') {
      return res.status(400).json({ ok: false, code, msg: err.message });
    }
    if (code === 'IMAGE_INVALID') {
      return res.status(400).json({ ok: false, code, msg: err.message });
    }
    if (/_NOT_CONFIGURED$/.test(code)) {
      console.error('[HOMEWORK] vision provider not configured:', code);
      return res.status(500).json({ ok: false, code, msg: 'AI 批改暂未开通，请先用手动批改' });
    }
    if (/_BAD_JSON$/.test(code)) {
      console.error('[HOMEWORK] vision bad json:', err.message);
      return res.status(502).json({ ok: false, code: 'AI_BAD_JSON', msg: 'AI 没看清这张照片，请拍清楚一点后重试' });
    }
    console.error('[HOMEWORK] grade-photo error:', err && err.message);
    return res.status(502).json({ ok: false, code: 'AI_FAILED', msg: 'AI 批改失败了，请稍后重试或用手动批改' });
  } finally {
    if (tmpFile) fs.unlink(tmpFile, () => {});
  }
});

module.exports = router;
/* 自测钩子（不影响线上行为）：注入 mock Agnes 调用 / 重置限流 / 暴露纯函数 */
module.exports.__setAgnesVisionCaller = (fn) => { agnesVisionCaller = typeof fn === 'function' ? fn : defaultAgnesVision; };
module.exports.__setArkVisionCaller = (fn) => { arkVisionCaller = typeof fn === 'function' ? fn : defaultArkVision; };
module.exports.__resetRateLimit = () => rateMap.clear();
module.exports._internals = { buildPrompt, extractJson, normalizeItems, decodeImage, TMP_DIR, TMP_NAME_RE };
