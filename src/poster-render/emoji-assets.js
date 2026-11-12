'use strict';
/**
 * 手抄报 emoji 素材清单（运行时唯一口径）
 *
 * 渲染器只能绘制本地 Twemoji SVG 素材（scripts/poster-library/assets/emoji/<码点>.svg）；
 * 清单外的 emoji 在 node-canvas 里只能走字体回退，生产环境会画成码点文字（如 01F525）。
 * 因此：
 *  - 方案提示词只能从本清单选图标（buildPrompt 动态注入，清单随素材目录走、永不漂移）；
 *  - 解析方案后用 sanitizeIcon 把清单外图标映射到最接近的清单内图标或默认图标；
 *  - 渲染器角标对仍缺失的图标有序号徽章终极兜底（见 render.js drawBadgeIcon）。
 *
 * 本模块只依赖 fs/path（不碰 canvas 原生模块），路由层可直接 require。
 */
const fs = require('fs');
const path = require('path');

// 与 render.js 同一口径：可用环境变量覆盖
const EMOJI_DIR = process.env.POSTER_EMOJI_DIR || path.join(__dirname, '..', '..', 'scripts', 'poster-library', 'assets', 'emoji');

/** emoji → 素材文件名（不含 .svg）：码点十六进制以 '-' 连接，剔除 FE0F 变体选择符 */
function emojiFileName(e) {
  return [...String(e || '')].map(c => c.codePointAt(0).toString(16)).filter(h => h !== 'fe0f').join('-');
}

/** 素材文件名 → emoji（与 emojiFileName 互逆；200d 等连接符按码点还原） */
function emojiFromFileName(name) {
  try {
    return name.split('-').filter(Boolean).map(h => String.fromCodePoint(parseInt(h, 16))).join('');
  } catch (e) {
    return '';
  }
}

let _cache = null;
/** 扫描素材目录（进程内缓存）：{ files:Set<文件名>, emojis:[emoji...] } */
function scanAssets() {
  if (_cache) return _cache;
  let files = [];
  try {
    files = fs.readdirSync(EMOJI_DIR).filter(f => f.endsWith('.svg')).map(f => f.slice(0, -4));
  } catch (e) {
    files = [];
  }
  _cache = {
    files: new Set(files),
    emojis: files.map(emojiFromFileName).filter(Boolean)
  };
  return _cache;
}

/** 素材目录实际存在的全部 emoji（供提示词注入） */
function availableEmojis() {
  return scanAssets().emojis.slice();
}

/** 该 emoji 是否有本地素材可全彩绘制 */
function hasEmojiAsset(e) {
  if (!e) return false;
  return scanAssets().files.has(emojiFileName(e));
}

/** 默认图标：📝（清单内、语义中性，代表「内容/记录」） */
const DEFAULT_ICON = '📝';

/**
 * 常见清单外图标 → 语义最接近的清单内图标。
 * 仅当目标图标确有素材时才采用（apply 时逐个校验），否则继续走默认图标。
 */
const FALLBACK_MAP = {
  '🔥': '⚠️', // 火/危险 → 警示（防溺水等安全主题语义贴合）
  '🛟': '🌊', // 救生圈 → 海浪（水域安全）
  '👫': '👋', // 伙伴同行 → 招手示意
  '📞': '🚨', // 紧急求助电话 → 警报
  '📌': '📝', // 图钉（旧合并卡默认）→ 笔记
  '❤️': '💖', '❤': '💖', // 红心 → 爱心
  '☀️': '🌟', '☀': '🌟', // 太阳 → 闪烁星
  '🌈': '✨', // 彩虹 → 闪光
  '🎨': '✏️', // 调色盘 → 铅笔
  '🏆': '⭐', // 奖杯 → 星星
  '🚀': '🌟', // 火箭 → 闪烁星
  '🔍': '🔬', // 放大镜 → 显微镜（观察/科学）
  '🎵': '🎶', '🎶': '🎵' // 音符互备（🎵 有素材时优先）
};

/**
 * 把任意图标约束到素材清单内：
 * 本身有素材 → 原样；命中近似映射且目标有素材 → 映射值；
 * 否则 → 默认图标（有素材时）；连默认图标都没素材 → ''（渲染器序号徽章兜底）。
 */
function sanitizeIcon(icon) {
  const e = String(icon || '').trim();
  if (e && hasEmojiAsset(e)) return e;
  const mapped = FALLBACK_MAP[e];
  if (mapped && hasEmojiAsset(mapped)) return mapped;
  if (hasEmojiAsset(DEFAULT_ICON)) return DEFAULT_ICON;
  return '';
}

/** 规范化一份方案的全部图标（sections[].icon 与顶层 emoji），原地修改并返回 */
function sanitizePlanIcons(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  if (Array.isArray(plan.sections)) {
    plan.sections.forEach(sec => {
      if (sec && typeof sec === 'object') sec.icon = sanitizeIcon(sec.icon);
    });
  }
  if (plan.emoji) plan.emoji = sanitizeIcon(plan.emoji);
  return plan;
}

module.exports = {
  EMOJI_DIR,
  emojiFileName,
  availableEmojis,
  hasEmojiAsset,
  sanitizeIcon,
  sanitizePlanIcons,
  DEFAULT_ICON
};
