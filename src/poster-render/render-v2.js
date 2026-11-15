'use strict';
/**
* 手抄报成品渲染器 v2
*
* 与 scripts/poster-library/render-v2.js 同源，差异：
* - 板块数动态排版：按方案 sections 的实际数量（1~6）自适应网格，
* 不再像离线版固定截断为 4 个，也不再依赖 AI 底图的固定空框数；
* - 6 个以上板块时合并尾部板块进最后一张卡（内容不丢、正文自动缩字适配）。
*
* 版式要点（沿用离线 v2 的质量口径）：
* - 顶部是真正的主题场景插画（AI 生成、无文字），波浪花边下沿；
* - 标题压在云朵形标题框上，横跨插画与正文；
* - 正文板块用错落圆角卡 + 圆形图标徽章 + 波浪下划线承载；
* - 文字 100% 程序排版，只落在白色卡片上；
* - 成品图无任何水印/品牌字样；页脚只留班级/姓名栏，条带内零装饰。
*/
const { createCanvas, loadImage} = require('canvas');
const R = require('./render');
const { W, H} = R;

const MAX_GRID_SECTIONS = 6;

function buildPalette(tpl) {
const cs = tpl.colorScheme || { main: '#E74C3C', accent: '#F5A623', bg: '#FFF6EF'};
return {
main: cs.main, accent: cs.accent,
mainDeep: R.deepEnough(cs.main),
accentDeep: R.deepEnough(cs.accent),
bg: R.lightEnough(cs.bg)
};
}

/* ---------- 形状工具（与离线版一致） ---------- */
function heroPath(ctx, x, y, w, h, r, scallop) {
ctx.beginPath();
ctx.moveTo(x + r, y);
ctx.lineTo(x + w - r, y);
ctx.arcTo(x + w, y, x + w, y + r, r);
ctx.lineTo(x + w, y + h);
const n = Math.max(6, Math.round(w / (scallop * 2)));
const sw = w / n;
for (let i = 0; i < n; i++) {
const cx = x + w - sw * (i + 0.5);
ctx.arc(cx, y + h, sw / 2, 0, Math.PI, false);
}
ctx.lineTo(x, y + r);
ctx.arcTo(x, y, x + r, y, r);
ctx.closePath();
}
function drawCover(ctx, img, x, y, w, h, biasY = 0.35) {
const s = Math.max(w / img.width, h / img.height);
const dw = img.width * s, dh = img.height * s;
ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) * biasY, dw, dh);
}
function cloudPill(ctx, cx, cy, w, h, color) {
ctx.save();
ctx.fillStyle = color;
R.roundRect(ctx, cx - w / 2, cy - h / 2, w, h, h / 2); ctx.fill();
const bumps = [[-0.30, 26], [-0.10, 32], [0.12, 30], [0.30, 24]];
for (const [fx, r] of bumps) {
ctx.beginPath(); ctx.arc(cx + fx * w, cy - h / 2 + 10, r, 0, Math.PI * 2); ctx.fill();
}
ctx.restore();
}
function bubble(ctx, cx, cy, r, color) {
ctx.save();
ctx.strokeStyle = color; ctx.lineWidth = 5;
ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 4;
ctx.beginPath(); ctx.arc(cx, cy, r * 0.55, Math.PI * 1.05, Math.PI * 1.45); ctx.stroke();
ctx.restore();
}
function drawLace(ctx, kind, x, y, color, color2) {
if (kind === 'bubble') { bubble(ctx, x, y, 24, color); bubble(ctx, x + 44, y + 14, 15, color2);}
else R.drawMotif(ctx, kind, x, y, 26, color, color2);
}

/* ---------- 字号适配（下限 20px，保证密排主题零裁剪） ---------- */
function fitBodySizeV2(ctx, sections, innerW, innerH) {
for (let px = 34; px >= 20; px -= 1) {
const ok = sections.every(sec => R.measureSection(ctx, sec, innerW, px).total <= innerH);
if (ok) return { px, trimmed: false};
}
return { px: 20, trimmed: true};
}

/* ---------- 板块标题适配：测宽 → 缩字号 → 换行，绝不截断、绝不压出框外 ----------
* 原实现固定 41px 单行直绘，长标题在两栏窄卡里末字被裁（2026-11-15 评测实锤：防溺水·六年级 4 个标题全溢出）。
* 口径：先按原字号 41px 测宽，超宽逐级缩到下限 26px；下限仍超宽则换行（最多 2 行）；
* 极端长标题 2 行仍放不下时继续缩字号直至可容纳（兜底下限 16px），任何情况不截断标题文字。 */
const TITLE_PX = 41, TITLE_MIN_PX = 26, TITLE_ABS_MIN_PX = 16;
function fitSectionTitle(ctx, rawTitle, availW) {
const title = R.Q(rawTitle || '');
let px = TITLE_PX;
R.setFont(ctx, px, true);
if (ctx.measureText(title).width <= availW) return { lines: [title], px};
while (px > TITLE_MIN_PX) {
px -= 2; R.setFont(ctx, px, true);
if (ctx.measureText(title).width <= availW) return { lines: [title], px};
}
for (;;) {
R.setFont(ctx, px, true);
const lines = R.wrapText(ctx, title, availW);
if (lines.length <= 2 || px <= TITLE_ABS_MIN_PX) return { lines, px};
px -= 2;
}
}

/**
* 把方案板块整理成网格卡列表：
* - n<=6：一板块一卡；
* - n>6：前 5 个各一卡，其余合并为第 6 卡（标题拼接、正文与要点拼接），内容不丢。
*/
function toCards(sections) {
const secs = (Array.isArray(sections)? sections: []).filter(s => s && (s.title || s.content));
if (secs.length <= MAX_GRID_SECTIONS) return secs;
const head = secs.slice(0, MAX_GRID_SECTIONS - 1);
const tail = secs.slice(MAX_GRID_SECTIONS - 1);
const merged = {
icon: tail[0].icon || '📝',
title: tail.map(s => s.title || '').filter(Boolean).join(' · '),
content: tail.map(s => s.content || '').filter(Boolean).join(' '),
bullets: tail.flatMap(s => Array.isArray(s.bullets)? s.bullets: [])
};
return [...head, merged];
}

/* ---------- 主版式（动态网格） ---------- */
async function renderPosterV2(tpl, opts) {
const { heroImg, motif = 'star'} = opts || {};
if (!heroImg) throw new Error('renderPosterV2 需要 heroImg（已 loadImage 的插画）');
const cards = toCards(tpl.sections);
if (!cards.length) throw new Error('renderPosterV2 方案缺少板块');
await R.preloadEmojis([tpl.emoji, '✏️', '📝',...cards.map(s => s.icon)]);
const pal = buildPalette(tpl);
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

/* 网格几何：列数/行数随板块数走；3 行时压低插画区给正文让位 */
const n = cards.length;
const cols = n <= 1? 1: 2;
const rows = Math.ceil(n / cols);
const heroH = rows >= 3? 372: 500;

/* 背景与花边外框 */
ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H);
ctx.strokeStyle = pal.main; ctx.lineWidth = 12;
R.roundRect(ctx, 28, 28, W - 56, H - 56, 36); ctx.stroke();
ctx.strokeStyle = pal.accent; ctx.lineWidth = 3;
R.roundRect(ctx, 52, 52, W - 104, H - 104, 26); ctx.stroke();

/* ---- 插画主视觉（顶部，波浪下沿） ---- */
const hx = 68, hy = 66, hw = W - 136, hh = heroH;
ctx.save();
heroPath(ctx, hx, hy, hw, hh, 34, 30);
ctx.clip();
drawCover(ctx, heroImg, hx, hy - 6, hw, hh + 40);
ctx.restore();
ctx.save();
heroPath(ctx, hx, hy, hw, hh, 34, 30);
ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 10; ctx.stroke();
ctx.restore();
drawLace(ctx, motif, hx + 66, hy + hh + 146, pal.main, pal.accent);
drawLace(ctx, motif, hx + hw - 120, hy + hh + 146, pal.accent, pal.main);

/* ---- 云朵标题框（横跨插画与正文） ---- */
const title = R.Q(tpl.title || tpl.theme);
let tPx = 96;
R.setFont(ctx, tPx, true);
while (ctx.measureText(title).width > 900 && tPx > 54) { tPx -= 4; R.setFont(ctx, tPx, true);}
const titleW = ctx.measureText(title).width;
const cloudW = Math.min(1030, titleW + 190);
const cloudH = 150, cloudCY = hy + hh + 112;
ctx.save();
cloudPill(ctx, W / 2 + 6, cloudCY + 10, cloudW, cloudH, 'rgba(31,38,52,0.16)');
ctx.restore();
cloudPill(ctx, W / 2, cloudCY, cloudW, cloudH, pal.mainDeep);
ctx.fillStyle = '#FFFFFF';
ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
ctx.fillText(title, W / 2, cloudCY - (tpl.subtitle? 22: 0));
if (tpl.subtitle) {
R.setFont(ctx, 31, false);
ctx.fillStyle = 'rgba(255,255,255,0.94)';
ctx.fillText(tpl.subtitle, W / 2, cloudCY + 52);
}

/* ---- 正文板块：错落圆角卡 + 圆形图标徽章（动态行列） ---- */
const gridTop = cloudCY + cloudH / 2 + 24;
// 页脚条带 = 装饰禁区：[footerDividerY, H-54] 内只许分割线与班级/姓名文字
const footerDividerY = H - 122;
const tipsReserve = 0; // 整改 2026-11-14：成品图须整张即手抄报正文（可直接下载交作业），禁止书写小贴士/装饰建议等非正文板块
const gridBottom = footerDividerY - tipsReserve - 14;
const gapX = 28, gapY = 24;
const stagger = rows >= 3? 0: 18;
const cardW = cols === 1? hw: (hw - gapX) / 2;
const cardH = (gridBottom - gridTop - gapY * (rows - 1) - stagger) / rows;
const padX = 28, headH = 70;
// 每卡标题先行适配（测宽/缩字号/换行）：标题可用宽 = 卡宽 - 左侧徽章占位 100 - 右内边距 padX；
// 换行标题的卡相应加高头部（headHs），正文字号适配与绘制都按各自头部高走，布局不错位
const titleLayouts = cards.map((sec, i) => {
const span = (cols === 2 && i === n - 1 && n % 2 === 1)? 2: 1;
const w = span === 2? hw: cardW;
return fitSectionTitle(ctx, sec.title, w - 100 - padX);
});
const headHs = titleLayouts.map(t => t.lines.length <= 1? headH: Math.max(98, Math.ceil(t.lines.length * t.px * 1.25) + 36));
// 每张卡按自身宽度做字号适配（通栏卡更宽，可用更大字号；取全体最小保证统一）
const fits = cards.map((sec, i) => {
const span = (cols === 2 && i === n - 1 && n % 2 === 1)? 2: 1;
const w = span === 2? hw: cardW;
return fitBodySizeV2(ctx, [sec], w - padX * 2, cardH - headHs[i] - 14);
});
const bodyPx = Math.min(...fits.map(f => f.px));
let droppedTotal = 0;

cards.forEach((sec, i) => {
const row = Math.floor(i / cols);
const col = cols === 1? 0: i % cols;
const spanFull = cols === 2 && i === n - 1 && n % 2 === 1;
const w = spanFull? hw: cardW;
const cx = spanFull? hx: hx + col * (cardW + gapX);
const cy = gridTop + row * (cardH + gapY) + (col === 1 && rows < 3? stagger: 0);
const innerW = w - padX * 2;
const innerH = cardH - headHs[i] - 14;
const headColor = i % 2 === 0? pal.mainDeep: pal.accentDeep;
ctx.fillStyle = 'rgba(31,38,52,0.10)';
R.roundRect(ctx, cx + 7, cy + 10, w, cardH, 34); ctx.fill();
ctx.fillStyle = '#FFFFFF';
R.roundRect(ctx, cx, cy, w, cardH, 34); ctx.fill();
ctx.strokeStyle = R.mix(headColor, '#FFFFFF', 0.55); ctx.lineWidth = 4;
R.roundRect(ctx, cx, cy, w, cardH, 34); ctx.stroke();
ctx.fillStyle = headColor;
ctx.beginPath(); ctx.arc(cx + 46, cy + 42, 40, 0, Math.PI * 2); ctx.fill();
ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 5;
ctx.beginPath(); ctx.arc(cx + 46, cy + 42, 40, 0, Math.PI * 2); ctx.stroke();
R.drawBadgeIcon(ctx, sec.icon, i, cx + 46, cy + 42, 50, '#FFFFFF');
const tl = titleLayouts[i];
R.setFont(ctx, tl.px, true);
ctx.fillStyle = headColor;
ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
if (tl.lines.length <= 1) {
ctx.fillText(tl.lines[0], cx + 100, cy + 44);
} else {
const lh = tl.px * 1.25;
const centerY = cy + (headHs[i] - 8) / 2;
tl.lines.forEach((ln, li) => ctx.fillText(ln, cx + 100, centerY + (li - (tl.lines.length - 1) / 2) * lh));
}
ctx.save();
ctx.strokeStyle = headColor; ctx.lineWidth = 5;
ctx.beginPath();
const uw = 118, ux = cx + 102, uy = cy + headHs[i] - 8;
for (let x = 0; x <= uw; x += 4) {
const yy = uy + Math.sin((x / uw) * Math.PI * 2) * 4;
x === 0? ctx.moveTo(ux + x, yy): ctx.lineTo(ux + x, yy);
}
ctx.stroke(); ctx.restore();
const r = R.drawSectionBody(ctx, sec, cx + padX, cy + headHs[i] + 10, innerW, bodyPx, pal, innerH);
droppedTotal += r.dropped;
});


/* ---- 页脚（无品牌，仅班级/姓名；条带内零装饰） ---- */
const fy = H - 86;
ctx.save();
ctx.strokeStyle = R.mix(pal.main, '#FFFFFF', 0.35); ctx.lineWidth = 2;
ctx.beginPath(); ctx.moveTo(88, footerDividerY); ctx.lineTo(W - 88, footerDividerY); ctx.stroke();
R.setFont(ctx, 31, false);
ctx.fillStyle = R.SUBINK;
ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
ctx.fillText('班级：____________ 姓名：____________', 92, fy);
ctx.restore();

return { canvas, meta: { bodyPx, dropped: droppedTotal, layout: 'hero-v2-runtime', cards: n, rows, cols}};
}

module.exports = { renderPosterV2, toCards, MAX_GRID_SECTIONS, fitSectionTitle};
