'use strict';
/**
 * 手抄报成品渲染器（纯代码版式，零 AI 底图）【运行时移植版，与 scripts/poster-library/render.js 同源】
 *
 * 设计原则（质量红线）：
 *  - 版式全部由代码计算：标题区 / 正文分栏卡 / 装饰区严格分离
 *  - 文字一律落在纯色卡片（白或近白）上，绝不压图案
 *  - 插画性元素只有两种：矢量小图案（星/花/点/云）与彩色 emoji，
 *    且只出现在标题带、边框角落、页脚等装饰位，不进正文区
 *  - 正文按字体度量自动换行 + 自动缩字号适配，宁可缩字不溢出
 */
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');

const W = 1240;          // A4 @150dpi
const H = 1754;
const FONT = '"Noto Sans CJK SC"';
const EMOJI_FONT = '"Noto Color Emoji"';
// 运行时：emoji 素材复用成品库工具目录（随仓库一同部署），可用环境变量覆盖
// 素材目录/文件名口径统一收敛到 emoji-assets（提示词选图约束与解析净化共用同一清单）
const { EMOJI_DIR, emojiFileName } = require('./emoji-assets');

/* ============ emoji：本地 Twemoji SVG 全彩渲染 ============
 * 注意：node-canvas 对系统 Noto Color Emoji 只能渲染单色剪影（随 fillStyle 染色），
 * 因此改用本地 SVG 素材（assets/emoji/<codepoint>.svg），注入宽高后 loadImage 全彩绘制。
 * 素材缺失时：装饰位（drawEmoji）回退为单色剪影（显式指定颜色，不再随上下文乱染色，
 * 且生产字体缺失时可能画成码点文字，故装饰位图标应由上层净化保证有素材）；
 * 板块角标位（drawBadgeIcon）回退为序号徽章——角标有明确序号语义，数字永远体面，
 * 绝不出现码点文字或空白。 */
const emojiCache = new Map();
async function preloadEmojis(list) {
  for (const e of list) {
    if (!e || emojiCache.has(e)) continue;
    try {
      let svg = fs.readFileSync(path.join(EMOJI_DIR, emojiFileName(e) + '.svg'), 'utf8');
      svg = svg.replace('<svg ', '<svg width="216" height="216" ');
      emojiCache.set(e, await loadImage(Buffer.from(svg)));
    } catch (err) {
      emojiCache.set(e, null);
    }
  }
}
const INK = '#2F3542';   // 正文主色
const SUBINK = '#57606F'; // 次级文字

/* ================= 颜色工具 ================= */
function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(v, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex({ r, g, b }) {
  const c = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return ('#' + c(r) + c(g) + c(b)).toUpperCase();
}
function mix(hexA, hexB, t) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return rgbToHex({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
}
function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
/** 确保作为底色时够深（白字可读）：过亮则压暗 */
function deepEnough(hex, maxLum = 0.52) {
  let c = hex, guard = 0;
  while (luminance(c) > maxLum && guard++ < 12) c = mix(c, '#000000', 0.12);
  return c;
}
/** 确保作为背景时够浅（深字可读） */
function lightEnough(hex, minLum = 0.86) {
  let c = hex, guard = 0;
  while (luminance(c) < minLum && guard++ < 12) c = mix(c, '#FFFFFF', 0.15);
  return c;
}

/* ================= 文字度量 / 换行 ================= */
const NO_LINE_START = '，。、；：？！）】」』％·…—”’';
const NO_LINE_END = '（【「『《“‘';

function wrapText(ctx, text, maxW) {
  const chars = Array.from(String(text || ''));
  const lines = [];
  let line = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\n') { lines.push(line); line = ''; continue; }
    const test = line + ch;
    if (ctx.measureText(test).width > maxW && line) {
      // 行尾禁则：开引号类不能留在行尾
      let carry = '';
      if (NO_LINE_END.includes(line[line.length - 1])) {
        carry = line[line.length - 1];
        lines.push(line.slice(0, -1));
      } else {
        lines.push(line);
      }
      // 行首禁则：收尾标点不能落到行首，挂到上一行
      if (NO_LINE_START.includes(ch)) {
        lines[lines.length - 1] += ch;
        line = carry;
      } else {
        line = carry + ch;
      }
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  // 后处理禁则（覆盖链式情形，如「。」触发断行后紧跟的「”」落到行首）：
  // 收尾标点一律挂到上一行末尾；开引号类一律挪到下一行开头。
  const fontPx = parseFloat((ctx.font.match(/([\d.]+)px/) || [])[1] || 30);
  for (let i = 1; i < lines.length; i++) {
    while (lines[i].length && NO_LINE_START.includes(lines[i][0])) {
      // 挂版上限 1 个字宽：再多（如 。”—— 链）会冲出卡片边距，宁可留行首
      if (ctx.measureText(lines[i - 1] + lines[i][0]).width > maxW + fontPx * 1.02) break;
      lines[i - 1] += lines[i][0];
      lines[i] = lines[i].slice(1);
    }
  }
  for (let i = 0; i < lines.length - 1; i++) {
    while (lines[i].length > 1 && NO_LINE_END.includes(lines[i][lines[i].length - 1])) {
      lines[i + 1] = lines[i][lines[i].length - 1] + lines[i + 1];
      lines[i] = lines[i].slice(0, -1);
    }
  }
  return lines.filter((l, idx) => l.length > 0 || idx === 0);
}

function setFont(ctx, px, bold) {
  ctx.font = `${bold ? 'bold ' : ''}${px}px ${FONT}`;
}

/** 计算一个板块在给定正文字号下需要的高度（不含卡片内边距） */
function measureSection(ctx, sec, innerW, bodyPx) {
  setFont(ctx, bodyPx, false);
  const contentLines = wrapText(ctx, Q(sec.content || ''), innerW);
  const bulletPx = Math.round(bodyPx * 0.94);
  setFont(ctx, bulletPx, false);
  const indent = bulletPx * 1.1;
  let bulletLines = 0;
  for (const b of (sec.bullets || [])) {
    bulletLines += wrapText(ctx, Q(b), innerW - indent).length;
  }
  const contentH = contentLines.length * bodyPx * 1.52;
  const bulletH = bulletLines * bulletPx * 1.46;
  const gap = (sec.bullets && sec.bullets.length) ? bodyPx * 0.45 : 0;
  return { total: contentH + gap + bulletH, contentLines: contentLines.length, bulletLines };
}

/** 为整页挑选统一正文字号：从大到小试，全部板块都放得下为准 */
function fitBodySize(ctx, sections, innerW, innerH) {
  for (let px = 34; px >= 24; px -= 2) {
    const ok = sections.every(sec => measureSection(ctx, sec, innerW, px).total <= innerH);
    if (ok) return { px, trimmed: false };
  }
  return { px: 24, trimmed: true };
}

/* ================= 矢量小图案（只用于装饰位） ================= */
function star(ctx, cx, cy, r, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? r : r * 0.46;
    const x = cx + Math.cos(ang) * rad, y = cy + Math.sin(ang) * rad;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.fill(); ctx.restore();
}
function flower(ctx, cx, cy, r, petal, center) {
  ctx.save();
  ctx.fillStyle = petal;
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(ang) * r * 0.72, cy + Math.sin(ang) * r * 0.72, r * 0.44, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = center;
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function dots(ctx, cx, cy, r, color) {
  ctx.save(); ctx.fillStyle = color;
  [[0, 0], [-1.6, 0.9], [1.6, 0.9], [-0.8, -1.1], [0.9, -1.2]].forEach(([dx, dy]) => {
    ctx.beginPath(); ctx.arc(cx + dx * r, cy + dy * r, r * 0.52, 0, Math.PI * 2); ctx.fill();
  });
  ctx.restore();
}
function drawMotif(ctx, kind, x, y, r, c1, c2) {
  if (kind === 'star') star(ctx, x, y, r, c1);
  else if (kind === 'flower') flower(ctx, x, y, r, c1, c2);
  else dots(ctx, x, y, r * 0.9, c1);
}

/* ================= 基础绘图 ================= */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function drawEmoji(ctx, emoji, cx, cy, size, fallbackColor) {
  if (!emoji) return;
  const img = emojiCache.get(emoji);
  if (img) {
    ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    return;
  }
  // 回退：单色剪影（颜色显式传入，避免随 fillStyle 乱染色）
  ctx.save();
  ctx.font = `${size}px ${EMOJI_FONT}`;
  ctx.fillStyle = fallbackColor || '#888888';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, cx, cy + size * 0.04);
  ctx.restore();
}

/**
 * 板块角标专用绘制：有素材画全彩图标；素材缺失时画「板块序号」数字。
 * 角标本来就坐在圆形徽章/标题条上，序号与版式同语义同配色，是唯一体面的缺图兜底——
 * 绝不走 drawEmoji 的字体回退（生产环境会画出 01F525 这类码点文字，像报错）。
 * @param {number} index 板块下标（0 起，显示为 index+1）
 * @param {string} color 序号颜色（与该角标位的图标回退色一致：徽章内白色、浅底主色深调）
 */
function drawBadgeIcon(ctx, emoji, index, cx, cy, size, color) {
  const img = emoji ? emojiCache.get(emoji) : null;
  if (img) {
    ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    return;
  }
  ctx.save();
  setFont(ctx, Math.round(size * 0.92), true);
  ctx.fillStyle = color || '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String((index || 0) + 1), cx, cy + size * 0.04);
  ctx.restore();
}

/** 直引号 → 中文引号（仅展示层规范化，不改模板数据） */
function Q(s) {
  let open = true;
  return String(s || '').replace(/"/g, () => { const c = open ? '“' : '”'; open = !open; return c; });
}

/* ================= 板块正文绘制 ================= */
/**
 * 在 (x, y, w) 处绘制板块正文（内容 + 要点），返回占用高度。
 * bullets 逐条绘制，超出 maxH 的条数会被裁掉并计数（正常情况不应发生）。
 */
function drawSectionBody(ctx, sec, x, y, w, bodyPx, pal, maxH) {
  const bulletPx = Math.round(bodyPx * 0.94);
  const indent = bulletPx * 1.1;
  let cy = y;
  let dropped = 0;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if (sec.content) {
    setFont(ctx, bodyPx, false);
    ctx.fillStyle = INK;
    const lines = wrapText(ctx, Q(sec.content), w);
    for (const ln of lines) {
      ctx.fillText(ln, x, cy + bodyPx);
      cy += bodyPx * 1.52;
    }
  }
  const bullets = sec.bullets || [];
  if (bullets.length) cy += bodyPx * 0.45;
  setFont(ctx, bulletPx, false);
  for (const b of bullets) {
    const lines = wrapText(ctx, Q(b), w - indent);
    const need = lines.length * bulletPx * 1.46;
    if (cy + need - y > maxH) { dropped++; continue; }
    lines.forEach((ln, i) => {
      if (i === 0) {
        ctx.fillStyle = pal.main;
        ctx.fillText('•', x + bulletPx * 0.08, cy + bulletPx);
      }
      ctx.fillStyle = SUBINK;
      ctx.fillText(ln, x + indent, cy + bulletPx);
      cy += bulletPx * 1.46;
    });
  }
  return { h: cy - y, dropped };
}

/* ================= 版式 A：横幅式 ================= */
function layoutBanner(ctx, tpl, pal, variant) {
  const M = 84;                 // 内容边距
  const gridW = W - M * 2;
  // 背景 + 双线框
  ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = pal.main; ctx.lineWidth = 12;
  roundRect(ctx, 30, 30, W - 60, H - 60, 30); ctx.stroke();
  ctx.strokeStyle = pal.accent; ctx.lineWidth = 3;
  roundRect(ctx, 54, 54, W - 108, H - 108, 22); ctx.stroke();
  // 四角装饰
  [[54, 54], [W - 54, 54], [54, H - 54], [W - 54, H - 54]].forEach(([x, y]) =>
    drawMotif(ctx, variant.motif, x, y, 26, pal.main, pal.accent));

  /* ---- 标题带 ---- */
  const bX = M, bY = 78, bW = gridW, bH = 224;
  const grad = ctx.createLinearGradient(bX, bY, bX, bY + bH);
  grad.addColorStop(0, mix(pal.mainDeep, '#FFFFFF', 0.10));
  grad.addColorStop(1, pal.mainDeep);
  ctx.fillStyle = grad;
  roundRect(ctx, bX, bY, bW, bH, 38); ctx.fill();
  // 标题带内的淡点阵（仅装饰，避开文字中心区上沿/下沿）
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.20)';
  for (let i = 0; i < 9; i++) {
    ctx.beginPath(); ctx.arc(bX + 44 + i * 26, bY + 26, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(bX + 44 + i * 26, bY + bH - 26, 4.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  // 主标题：自动缩字
  const title = Q(tpl.title || tpl.theme);
  let tPx = 100;
  setFont(ctx, tPx, true);
  const maxTitleW = bW - 300;
  while (ctx.measureText(title).width > maxTitleW && tPx > 52) { tPx -= 4; setFont(ctx, tPx, true); }
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(title, W / 2, bY + 84);
  // 标题两侧 emoji
  drawEmoji(ctx, tpl.emoji, bX + 78, bY + 96, 104);
  drawEmoji(ctx, tpl.emoji, bX + bW - 78, bY + 96, 104);
  // 副标题药丸
  if (tpl.subtitle) {
    setFont(ctx, 33, false);
    const sw = ctx.measureText(tpl.subtitle).width + 56;
    ctx.fillStyle = pal.accent;
    roundRect(ctx, W / 2 - sw / 2, bY + bH - 66, sw, 46, 23); ctx.fill();
    ctx.fillStyle = luminance(pal.accent) > 0.6 ? '#5B4A12' : '#FFFFFF';
    ctx.fillText(tpl.subtitle, W / 2, bY + bH - 42);
  }

  /* ---- emoji 装饰带（可选） ---- */
  let gridTop = bY + bH + 34;
  if (variant.band) {
    const icons = (tpl.sections || []).map(s => s.icon).filter(Boolean);
    const row = [tpl.emoji, ...icons, tpl.emoji];
    const bandY = gridTop + 40;
    row.forEach((e, i) => {
      const x = M + (gridW / (row.length + 1)) * (i + 1);
      drawEmoji(ctx, e, x, bandY, 74);
      if (i < row.length - 1) drawMotif(ctx, variant.motif, x + gridW / (row.length + 1) / 2, bandY, 13, pal.accent, pal.main);
    });
    gridTop += 92;
  }

  /* ---- 2×2 板块卡 ---- */
  const gap = 26;
  const cardW = (gridW - gap) / 2;
  const footerH = 118;
  const cardH = (H - gridTop - footerH - gap) / 2;
  const padX = 30, chipH = 64;
  const innerW = cardW - padX * 2;
  const innerH = cardH - chipH - 58;
  const fit = fitBodySize(ctx, tpl.sections, innerW, innerH);
  let droppedTotal = 0;

  tpl.sections.slice(0, 4).forEach((sec, i) => {
    const cx = M + (i % 2) * (cardW + gap);
    const cy = gridTop + Math.floor(i / 2) * (cardH + gap);
    // 卡身
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = pal.accent; ctx.lineWidth = 4;
    roundRect(ctx, cx, cy, cardW, cardH, 26); ctx.fill(); ctx.stroke();
    // 标题条（主/辅色交替）
    const chipColor = i % 2 === 0 ? pal.mainDeep : pal.accentDeep;
    ctx.fillStyle = chipColor;
    roundRect(ctx, cx + 18, cy + 16, cardW - 36, chipH, 18); ctx.fill();
    setFont(ctx, 40, true);
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(Q(sec.title || ''), cx + 92, cy + 16 + chipH / 2 + 2);
    drawBadgeIcon(ctx, sec.icon, i, cx + 56, cy + 16 + chipH / 2, 46, '#FFFFFF');
    // 正文
    const r = drawSectionBody(ctx, sec, cx + padX, cy + chipH + 40, innerW, fit.px, pal, innerH);
    droppedTotal += r.dropped;
  });

  drawFooter(ctx, pal, variant);
  return { bodyPx: fit.px, dropped: droppedTotal };
}

/* ================= 版式 B：彩带式 ================= */
function layoutRibbon(ctx, tpl, pal, variant) {
  const M = 84;
  const gridW = W - M * 2;
  ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H);
  // 顶部色带 + 波浪下沿
  const bandH = 268;
  const grad = ctx.createLinearGradient(0, 0, 0, bandH);
  grad.addColorStop(0, mix(pal.mainDeep, '#FFFFFF', 0.08));
  grad.addColorStop(1, pal.mainDeep);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, bandH);
  ctx.beginPath();
  const waveR = 34;
  for (let x = waveR; x < W; x += waveR * 2) {
    ctx.arc(x, bandH, waveR, 0, Math.PI, false);
  }
  ctx.fill();
  // 标题（左对齐）+ 右侧大 emoji
  const title = Q(tpl.title || tpl.theme);
  let tPx = 96;
  setFont(ctx, tPx, true);
  while (ctx.measureText(title).width > gridW - 250 && tPx > 50) { tPx -= 4; setFont(ctx, tPx, true); }
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(title, M, 108);
  if (tpl.subtitle) {
    setFont(ctx, 35, false);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillText(tpl.subtitle, M + 2, 196);
  }
  drawEmoji(ctx, tpl.emoji, W - M - 74, 128, 148);
  // 色带下点缀
  for (let i = 0; i < 5; i++) drawMotif(ctx, variant.motif, M + 20 + i * 54, bandH + 66, 14, pal.accent, pal.main);

  /* ---- 板块卡（白卡 + 顶部色条 + 阴影） ---- */
  const gap = 26;
  const cardW = (gridW - gap) / 2;
  const gridTop = bandH + 96;
  const footerH = 118;
  const cardH = (H - gridTop - footerH - gap) / 2;
  const padX = 30;
  const innerW = cardW - padX * 2;
  const headH = 74;
  const innerH = cardH - headH - 44;
  const fit = fitBodySize(ctx, tpl.sections, innerW, innerH);
  let droppedTotal = 0;

  tpl.sections.slice(0, 4).forEach((sec, i) => {
    const cx = M + (i % 2) * (cardW + gap);
    const cy = gridTop + Math.floor(i / 2) * (cardH + gap);
    const barColor = i % 2 === 0 ? pal.mainDeep : pal.accentDeep;
    // 阴影
    ctx.fillStyle = 'rgba(31,38,52,0.10)';
    roundRect(ctx, cx + 7, cy + 10, cardW, cardH, 24); ctx.fill();
    // 卡身
    ctx.fillStyle = '#FFFFFF';
    roundRect(ctx, cx, cy, cardW, cardH, 24); ctx.fill();
    // 顶部色条
    ctx.save();
    roundRect(ctx, cx, cy, cardW, cardH, 24); ctx.clip();
    ctx.fillStyle = barColor; ctx.fillRect(cx, cy, cardW, 14);
    ctx.restore();
    // 标题行：emoji + 主色标题 + 下划线
    setFont(ctx, 41, true);
    ctx.fillStyle = pal.mainDeep;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(Q(sec.title || ''), cx + 96, cy + 52);
    drawBadgeIcon(ctx, sec.icon, i, cx + 58, cy + 52, 48, pal.mainDeep);
    ctx.fillStyle = barColor;
    ctx.fillRect(cx + padX, cy + headH - 6, 72, 6);
    // 正文
    const r = drawSectionBody(ctx, sec, cx + padX, cy + headH + 18, innerW, fit.px, pal, innerH);
    droppedTotal += r.dropped;
  });

  drawFooter(ctx, pal, variant);
  return { bodyPx: fit.px, dropped: droppedTotal };
}

/* ================= 版式 C：报纸分栏式 ================= */
function layoutPaper(ctx, tpl, pal, variant) {
  const M = 84;
  const gridW = W - M * 2;
  // 背景比卡片式更浅，保证长文可读
  ctx.fillStyle = mix(pal.bg, '#FFFFFF', 0.45); ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = pal.main; ctx.lineWidth = 5;
  roundRect(ctx, 40, 40, W - 80, H - 80, 18); ctx.stroke();
  ctx.lineWidth = 1.6;
  roundRect(ctx, 52, 52, W - 104, H - 104, 14); ctx.stroke();

  // 标题（主色大字，无底色带）+ 两侧图案
  const title = Q(tpl.title || tpl.theme);
  let tPx = 102;
  setFont(ctx, tPx, true);
  while (ctx.measureText(title).width > gridW - 240 && tPx > 54) { tPx -= 4; setFont(ctx, tPx, true); }
  ctx.fillStyle = pal.mainDeep;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(title, W / 2, 158);
  drawMotif(ctx, variant.motif, M + 30, 158, 30, pal.accent, pal.main);
  drawMotif(ctx, variant.motif, W - M - 30, 158, 30, pal.accent, pal.main);
  drawEmoji(ctx, tpl.emoji, M + 34, 250, 64);
  drawEmoji(ctx, tpl.emoji, W - M - 34, 250, 64);
  if (tpl.subtitle) {
    setFont(ctx, 36, false);
    ctx.fillStyle = SUBINK;
    ctx.fillText(tpl.subtitle, W / 2, 248);
  }
  // 双线分隔
  ctx.fillStyle = pal.main; ctx.fillRect(M, 292, gridW, 7);
  ctx.fillStyle = pal.accent; ctx.fillRect(M, 308, gridW, 3);

  /* ---- 两栏正文（每栏 2 个板块） ---- */
  const colGap = 54;
  const colW = (gridW - colGap) / 2;
  const top = 348;
  const footerH = 118;
  const tipsH = tpl.writeTips ? 104 : 0;
  const colH = H - top - footerH - tipsH;
  const secGap = 44;
  const secH = (colH - secGap) / 2;
  const headH = 66;
  const innerH = secH - headH - 16;
  const fit = fitBodySize(ctx, tpl.sections, colW - 8, innerH);
  let droppedTotal = 0;
  // 中缝虚线
  ctx.save();
  ctx.strokeStyle = pal.accent; ctx.lineWidth = 3; ctx.setLineDash([10, 12]);
  ctx.beginPath(); ctx.moveTo(W / 2, top + 6); ctx.lineTo(W / 2, top + colH - 6); ctx.stroke();
  ctx.restore();

  tpl.sections.slice(0, 4).forEach((sec, i) => {
    const col = i < 2 ? 0 : 1;            // 左栏 1、2 板块，右栏 3、4 板块
    const row = i % 2;
    const sx = M + col * (colW + colGap);
    const sy = top + row * (secH + secGap);
    setFont(ctx, 42, true);
    ctx.fillStyle = pal.mainDeep;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(Q(sec.title || ''), sx + 72, sy + 30);
    drawBadgeIcon(ctx, sec.icon, i, sx + 34, sy + 30, 48, pal.mainDeep);
    ctx.fillStyle = i % 2 === 0 ? pal.main : pal.accent;
    roundRect(ctx, sx + 74, sy + headH - 12, 84, 8, 4); ctx.fill();
    const r = drawSectionBody(ctx, sec, sx + 4, sy + headH + 8, colW - 8, fit.px, pal, innerH);
    droppedTotal += r.dropped;
  });

  /* ---- 底部书写小贴士条（填补留白 + 实用信息） ---- */
  if (tpl.writeTips) {
    const tY = top + colH + 18;
    const tH = 78;
    ctx.fillStyle = mix(pal.main, '#FFFFFF', 0.88);
    roundRect(ctx, M, tY, gridW, tH, 16); ctx.fill();
    ctx.strokeStyle = mix(pal.main, '#FFFFFF', 0.45); ctx.lineWidth = 2;
    roundRect(ctx, M, tY, gridW, tH, 16); ctx.stroke();
    drawEmoji(ctx, '✏️', M + 44, tY + tH / 2, 44, pal.mainDeep);
    setFont(ctx, 27, false);
    ctx.fillStyle = INK;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const tipLines = wrapText(ctx, '书写小贴士：' + Q(tpl.writeTips), gridW - 130).slice(0, 2);
    tipLines.forEach((ln, i) => {
      ctx.fillText(ln, M + 82, tY + tH / 2 + (i - (tipLines.length - 1) / 2) * 36);
    });
  }

  drawFooter(ctx, pal, variant);
  return { bodyPx: fit.px, dropped: droppedTotal };
}

/* ================= 页脚 ================= */
function drawFooter(ctx, pal, variant) {
  const y = H - 78;
  ctx.save();
  ctx.strokeStyle = mix(pal.main, '#FFFFFF', 0.35); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(84, y - 44); ctx.lineTo(W - 84, y - 44); ctx.stroke();
  setFont(ctx, 31, false);
  ctx.fillStyle = SUBINK;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('班级：____________      姓名：____________', 88, y);
  // 品牌字样默认不画（成品图无水印，方便用户直接使用）；
  // 仅当变体显式配置 brandText 时才绘制，v1/v2 变体均不配置。
  if (variant && variant.brandText) {
    ctx.textAlign = 'right';
    ctx.fillText(variant.brandText, W - 88, y);
  }
  ctx.restore();
}

/* ================= 变体定义 ================= */
const VARIANTS = [
  { n: 1, layout: 'banner', palette: 'orig', motif: 'star',   band: true,  label: '横幅式·经典配色' },
  { n: 2, layout: 'banner', palette: 'swap', motif: 'flower', band: false, label: '横幅式·交替配色' },
  { n: 3, layout: 'ribbon', palette: 'orig', motif: 'dots',   band: false, label: '彩带式·经典配色' },
  { n: 4, layout: 'ribbon', palette: 'swap', motif: 'star',   band: false, label: '彩带式·交替配色' },
  { n: 5, layout: 'paper',  palette: 'orig', motif: 'flower', band: false, label: '报纸分栏·经典配色' },
  { n: 6, layout: 'paper',  palette: 'swap', motif: 'dots',   band: false, label: '报纸分栏·交替配色' }
];

function buildPalette(tpl, kind) {
  const cs = tpl.colorScheme || { main: '#E74C3C', accent: '#F5A623', bg: '#FFF6EF' };
  const main = kind === 'swap' ? cs.accent : cs.main;
  const accent = kind === 'swap' ? cs.main : cs.accent;
  return {
    main, accent,
    mainDeep: deepEnough(main),
    accentDeep: deepEnough(accent),
    bg: lightEnough(cs.bg)
  };
}

const LAYOUTS = { banner: layoutBanner, ribbon: layoutRibbon, paper: layoutPaper };

/**
 * 渲染一张成品图（异步：先预加载本图用到的 emoji 素材）
 * @returns {Promise<{ canvas, meta: { bodyPx, dropped, variant } }>}
 */
async function renderPoster(tpl, variantIdx) {
  const variant = VARIANTS[variantIdx - 1];
  if (!variant) throw new Error('variant 必须在 1..6');
  const used = [tpl.emoji, '✏️', ...(tpl.sections || []).map(s => s.icon)];
  await preloadEmojis(used);
  const pal = buildPalette(tpl, variant.palette);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const meta = LAYOUTS[variant.layout](ctx, tpl, pal, variant);
  return { canvas, meta: { ...meta, variant } };
}

module.exports = {
  renderPoster, VARIANTS, W, H, preloadEmojis,
  // 以下供 render-v2 复用（同一套度量/禁则/对比度逻辑，避免双份实现漂移）
  wrapText, measureSection, fitBodySize, drawSectionBody,
  deepEnough, lightEnough, mix, hexToRgb, luminance,
  roundRect, drawEmoji, drawBadgeIcon, drawMotif, star, flower, dots, Q, setFont,
  INK, SUBINK, FONT
};
