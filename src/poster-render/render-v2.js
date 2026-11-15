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

/* ---------- 正文适配：字号 → 行距 → 省要点 → 整句截断，任何正文完整落卡 ----------
* 原实现缺陷（2026-11-15 评测实锤，防溺水·六年级）：字号只试到 20px 下限，试不下返回
* trimmed 标志但主流程不处理，drawSectionBody 对正文行又无高度守卫——两栏卡 200+ 字
* 正文直接画出卡外、压住下一行卡片；bullets 则因正文已耗尽高度被逐条丢弃（整卡无要点）。
* 新口径（顺序即优先级，不许跳步）：
* 1) 全页统一 (字号, 行距) 搜索：先固定原行距逐级缩字号 34→16px；仍放不下再逐档收紧
*    行距因子（1.52→1.44→1.37→1.30），每档内再走一遍字号——全部板块（含 bullets）
*    放得下即定版。此前能放下的版面在本步必然以原行距命中，与旧行为完全一致。
* 2) 仍放不下：全页定格 (16px, 1.30)，逐卡降级——先整组省略 bullets 保正文完整
*    （省略条数记 meta.droppedBullets）；正文还放不下才按整句截断并在末尾加「……」
*    （整句放不下首句时按字兜底），截断卡数记 meta.truncatedCards。
* 字号下限取 16px 的依据：设计上限 270 字/卡（六年级上限 180 字 ×1.5 容差）在最紧的
* 两栏三行卡（内宽 482、内高 223）内须不截断放下——17px 时约 10~11 行 ×22.1 临界溢出，
* 16px 时约 9 行 ×20.8 有余量；16px 于 A4@150dpi 成品约合 7.7pt，仅最长卡触达。 */
const BODY_MAX_PX = 34, BODY_MIN_PX = 16;
const LINE_FACTORS = [1.52, 1.44, 1.37, 1.30];
const ELLIPSIS = '……';

function lineScaleOf(factor) { return factor / LINE_FACTORS[0]; }
function measureBodyV2(ctx, sec, innerW, px, factor) {
return R.measureSection(ctx, sec, innerW, px, lineScaleOf(factor)).total;
}

/* 按句切分：句末标点（。！？；）连同紧随的收尾引号/括号归入本句，供整句截断用 */
function splitSentences(text) {
const chars = Array.from(String(text || ''));
const END = new Set(['。', '！', '？', '；']);
const TAIL = new Set(['」', '』', '）', '】', '”', '’', '"', "'", '〕']);
const out = [];
let cur = '';
for (let i = 0; i < chars.length; i++) {
cur += chars[i];
if (END.has(chars[i])) {
let j = i + 1;
while (j < chars.length && TAIL.has(chars[j])) { cur += chars[j]; j++; }
i = j - 1;
out.push(cur); cur = '';
}
}
if (cur) out.push(cur);
return out;
}

/* 把正文截断到恰好放进 innerH：优先整句保留（末尾加「……」并计入测高），首句都放不下时按字二分兜底 */
function truncateContentToFit(ctx, content, innerW, innerH, px, factor) {
const full = String(content || '');
const fits = (t) => measureBodyV2(ctx, { content: t, bullets: []}, innerW, px, factor) <= innerH;
if (fits(full)) return { content: full, truncated: false};
let acc = '';
for (const s of splitSentences(full)) {
if (!fits(acc + s + ELLIPSIS)) break;
acc += s;
}
if (acc) return { content: acc + ELLIPSIS, truncated: true};
let lo = 0, hi = full.length;
while (lo < hi) {
const mid = Math.ceil((lo + hi) / 2);
if (fits(full.slice(0, mid) + ELLIPSIS)) lo = mid; else hi = mid - 1;
}
return { content: full.slice(0, lo) + ELLIPSIS, truncated: true};
}

/* 单卡降级适配（仅在全页统一搜索失败后、于定格参数下逐卡执行）：
* 全量放得下原样返回 → 整组省略 bullets 保正文 → 按整句截断正文（bullets 一并省略） */
function fitCardBodyV2(ctx, sec, innerW, innerH, px, factor) {
if (measureBodyV2(ctx, sec, innerW, px, factor) <= innerH) {
return { sec, droppedBullets: 0, truncated: false};
}
const bullets = Array.isArray(sec.bullets)? sec.bullets: [];
if (bullets.length && measureBodyV2(ctx, {...sec, bullets: []}, innerW, px, factor) <= innerH) {
return { sec: {...sec, bullets: []}, droppedBullets: bullets.length, truncated: false};
}
const t = truncateContentToFit(ctx, sec.content, innerW, innerH, px, factor);
return { sec: {...sec, content: t.content, bullets: []}, droppedBullets: bullets.length, truncated: t.truncated};
}

/* 全页正文适配：dims[i] = 第 i 卡的 { innerW, innerH }（通栏卡更宽、各自头部高不同，逐卡测高） */
function fitBodyV2(ctx, cards, dims) {
for (const factor of LINE_FACTORS) {
for (let px = BODY_MAX_PX; px >= BODY_MIN_PX; px -= 1) {
const ok = cards.every((sec, i) => measureBodyV2(ctx, sec, dims[i].innerW, px, factor) <= dims[i].innerH);
if (ok) return { px, factor, fitted: cards.map(sec => ({ sec, droppedBullets: 0, truncated: false}))};
}
}
const px = BODY_MIN_PX, factor = LINE_FACTORS[LINE_FACTORS.length - 1];
const fitted = cards.map((sec, i) => fitCardBodyV2(ctx, sec, dims[i].innerW, dims[i].innerH, px, factor));
return { px, factor, fitted};
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
// 全页正文适配（字号/行距统一，逐卡按自身宽高测高；放不下的卡已在此降级：
// 省 bullets 或整句截断，绘制时必然落卡——见 fitBodyV2 口径）
const dims = cards.map((sec, i) => {
const span = (cols === 2 && i === n - 1 && n % 2 === 1)? 2: 1;
const w = span === 2? hw: cardW;
return { innerW: w - padX * 2, innerH: cardH - headHs[i] - 14};
});
const bodyFit = fitBodyV2(ctx, cards, dims);
const bodyPx = bodyFit.px;
const bodyLineScale = lineScaleOf(bodyFit.factor);
const droppedBulletsTotal = bodyFit.fitted.reduce((s, f) => s + f.droppedBullets, 0);
const truncatedTotal = bodyFit.fitted.filter(f => f.truncated).length;
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
// 正文用适配后的板块（可能已省 bullets/截断），标题与图标仍用原板块
const r = R.drawSectionBody(ctx, bodyFit.fitted[i].sec, cx + padX, cy + headHs[i] + 10, innerW, bodyPx, pal, innerH, bodyLineScale);
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

return { canvas, meta: { bodyPx, lineFactor: bodyFit.factor, dropped: droppedTotal, droppedBullets: droppedBulletsTotal, truncatedCards: truncatedTotal, layout: 'hero-v2-runtime', cards: n, rows, cols}};
}

module.exports = { renderPosterV2, toCards, MAX_GRID_SECTIONS, fitSectionTitle, fitBodyV2, fitCardBodyV2, splitSentences, truncateContentToFit, BODY_MIN_PX, LINE_FACTORS};
