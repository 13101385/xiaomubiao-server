'use strict';
/**
 * 手抄报服务端合成服务（运行时）
 *
 * 输入：AI 文字方案（plan）+ AI 无文字场景插画（hero，Buffer 或 URL）
 * 输出：排版完成的成品图 JPEG —— 标题与全部板块文字已程序化排进图里。
 * 合成图经 storeComposedImage 落库为该记录的 composed_url，
 * 详情页展示、/cover、PDF、保存相册统一以合成图为正式交付。
 */
const { loadImage } = require('canvas');
const { renderPosterV2 } = require('./render-v2');

/* 主题 → 插画下沿花边（与成品库口径一致） */
const MOTIF_RULES = [
  [/溺水|海洋|大海|水|科学|实验|泡泡/, 'bubble'],
  [/植树|花|春|开学|分类|环保|园艺/, 'flower'],
  [/数学|交通|消防|读书|阅读|几何/, 'dots']
];
function pickMotif(theme) {
  const t = String(theme || '');
  for (const [re, motif] of MOTIF_RULES) {
    if (re.test(t)) return motif;
  }
  return 'star';
}

/**
 * 合成一张成品图
 * @param {object} args { plan, hero, theme }
 *   plan: { title, subtitle, colorScheme, sections[], writeTips, emoji? }
 *   hero: Buffer | string(URL) —— 无文字的主题场景插画
 * @returns {Promise<{ buffer: Buffer, meta: object }>}
 */
async function composePosterImage({ plan, hero, theme }) {
  if (!plan || !Array.isArray(plan.sections) || !plan.sections.length) {
    throw new Error('合成失败：方案缺少板块');
  }
  if (!hero) throw new Error('合成失败：缺少插画');
  const heroImg = Buffer.isBuffer(hero) ? await loadImage(hero) : await loadImage(String(hero));
  const tpl = Object.assign({}, plan, { theme: theme || plan.theme || '' });
  const { canvas, meta } = await renderPosterV2(tpl, { heroImg, motif: pickMotif(theme || plan.theme) });
  const buffer = canvas.toBuffer('image/jpeg', { quality: 0.92 });
  return { buffer, meta };
}

/**
 * 把合成图存为记录的正式成品图（blob 持久化 + composed_url 回写）
 * @returns {Promise<string>} composedUrl（相对路径 /api/poster/composed/<id>.jpg）
 */
async function storeComposedImage(db, posterId, accountId, buffer) {
  const key = 'composed/' + posterId + '.jpg';
  const url = '/api/poster/composed/' + posterId + '.jpg';
  await db.putBlob(key, buffer.toString('base64'));
  const ok = await db.updatePoster(posterId, accountId, { composedUrl: url });
  if (!ok) throw new Error('合成图回写失败（记录不存在）');
  return url;
}

module.exports = { composePosterImage, storeComposedImage, pickMotif };
