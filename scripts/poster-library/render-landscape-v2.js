'use strict';
/**
 * 手抄报横版渲染器 v2/v3（2026-11-14）
 *
 * v2（试点定版）：A 案「顶部整宽横幅插画 + 标题云朵 + 2×2 正文卡 + 班级姓名
 * 页脚」为用户批准骨架；B 案（左栏 45%）结构性落选、保留备查。
 *
 * v3 扩展（用户 15:13 追加：正文太单调 + 要小卡通元素）：
 *  - 板块形式库 5 种，按内容类型自动选配、同图混搭、全批轮换：
 *    classic 经典条目 / steps 编号步骤 / qa 问答气泡 / quote 诗句名言卡 /
 *    facts 图标事实行。每卡独立拟合字号（20–28），dropped 必须为 0。
 *  - 边框语言 4 种轮换：double 双线 / stitch 缝线虚线 / dots 圆点 / wave 波浪。
 *  - 卡片样式 3 种：plain 白卡 / tint 浅色卡 / dash 虚线边卡。
 *  - 贴纸层：opts.stickers 传入已裁好的方形贴纸图，圆贴纸呈现（白边+投影），
 *    位置 bannerTR/bannerTL/footerR，均在正文与人物脸之外；放不下可不传。
 * 共同纪律：只画手抄报正文（入口剥离 writeTips/decorTips）、无水印/品牌、
 * 班级/姓名页脚、文字 100% 程序排版。
 */
const { createCanvas } = require('canvas');
const R = require('./render');

const LW = 1754, LH = 1240;
const FOOTER_DIV = LH - 108;

function buildPalette(tpl) {
  const cs = tpl.colorScheme || { main: '#7B5CE0', accent: '#F5A623', bg: '#F7F3FF' };
  return {
    main: cs.main, accent: cs.accent,
    mainDeep: R.deepEnough(cs.main),
    accentDeep: R.deepEnough(cs.accent),
    bg: R.lightEnough(cs.bg)
  };
}
function drawCover(ctx, img, x, y, w, h, biasX = 0.5, biasY = 0.5) {
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s, dh = img.height * s;
  ctx.drawImage(img, x + (w - dw) * biasX, y + (h - dh) * biasY, dw, dh);
}
function cloudPill(ctx, cx, cy, w, h, color) {
  ctx.save();
  ctx.fillStyle = color;
  R.roundRect(ctx, cx - w / 2, cy - h / 2, w, h, h / 2); ctx.fill();
  const bumps = [[-0.30, 24], [-0.10, 30], [0.12, 28], [0.30, 22]];
  for (const [fx, r] of bumps) {
    ctx.beginPath(); ctx.arc(cx + fx * w, cy - h / 2 + 9, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/* ---------- 边框语言 ---------- */
function drawFrameV(ctx, pal, kind = 'double') {
  ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, LW, LH);
  ctx.save();
  if (kind === 'stitch') {
    ctx.strokeStyle = pal.main; ctx.lineWidth = 7;
    R.roundRect(ctx, 30, 30, LW - 60, LH - 60, 36); ctx.stroke();
    ctx.strokeStyle = pal.accent; ctx.lineWidth = 4; ctx.setLineDash([17, 12]);
    R.roundRect(ctx, 54, 54, LW - 108, LH - 108, 26); ctx.stroke();
  } else if (kind === 'dots') {
    ctx.strokeStyle = pal.main; ctx.lineWidth = 11;
    R.roundRect(ctx, 28, 28, LW - 56, LH - 56, 36); ctx.stroke();
    ctx.strokeStyle = pal.accent; ctx.lineWidth = 9; ctx.lineCap = 'round';
    ctx.setLineDash([0.1, 25]);
    R.roundRect(ctx, 55, 55, LW - 110, LH - 110, 26); ctx.stroke();
  } else if (kind === 'wave') {
    ctx.strokeStyle = pal.main; ctx.lineWidth = 10;
    R.roundRect(ctx, 28, 28, LW - 56, LH - 56, 36); ctx.stroke();
    // 波浪内框：沿圆角矩形周长采样，径向正弦位移
    const x = 56, y = 56, w = LW - 112, h = LH - 112, r = 26;
    const pts = [];
    const seg = (x0, y0, x1, y1) => { const len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(2, Math.round(len / 15)); for (let i = 0; i < n; i++) pts.push([x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]); };
    const arc = (cx, cy, a0, a1) => { const n = 7; for (let i = 0; i < n; i++) { const a = a0 + (a1 - a0) * i / n; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } };
    seg(x + r, y, x + w - r, y); arc(x + w - r, y + r, -Math.PI / 2, 0);
    seg(x + w, y + r, x + w, y + h - r); arc(x + w - r, y + h - r, 0, Math.PI / 2);
    seg(x + w - r, y + h, x + r, y + h); arc(x + r, y + h - r, Math.PI / 2, Math.PI);
    seg(x, y + h - r, x, y + r); arc(x + r, y + r, Math.PI, Math.PI * 1.5);
    const cx0 = LW / 2, cy0 = LH / 2;
    ctx.strokeStyle = pal.accent; ctx.lineWidth = 3.2;
    ctx.beginPath();
    let dist = 0;
    pts.forEach(([px, py], i) => {
      if (i > 0) dist += Math.hypot(px - pts[i - 1][0], py - pts[i - 1][1]);
      const dx = px - cx0, dy = py - cy0, dl = Math.hypot(dx, dy) || 1;
      const off = Math.sin(dist * 0.055) * 3.2;
      const nx = px + dx / dl * off, ny = py + dy / dl * off;
      i === 0 ? ctx.moveTo(nx, ny) : ctx.lineTo(nx, ny);
    });
    ctx.closePath(); ctx.stroke();
  } else { // double（v2 原样）
    ctx.strokeStyle = pal.main; ctx.lineWidth = 12;
    R.roundRect(ctx, 28, 28, LW - 56, LH - 56, 36); ctx.stroke();
    ctx.strokeStyle = pal.accent; ctx.lineWidth = 3;
    R.roundRect(ctx, 52, 52, LW - 104, LH - 104, 26); ctx.stroke();
  }
  ctx.restore();
}
function drawFooter(ctx, pal) {
  ctx.save();
  ctx.strokeStyle = R.mix(pal.main, '#FFFFFF', 0.35); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(88, FOOTER_DIV); ctx.lineTo(LW - 88, FOOTER_DIV); ctx.stroke();
  R.setFont(ctx, 30, false);
  ctx.fillStyle = R.SUBINK;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  // 页脚文字上移 10px：旧位 LH-74 时下划线墨迹行（≈LH-58）与内框虚线（stitch≈LH-56、
  // dots≈LH-55、wave≈LH-56）仅隔约 2px，抗锯齿后粘连成「虚线压字」（2026-11-15 普查）；
  // 上移后与各框型内线留 ≥10px 净距，与分隔线（FOOTER_DIV=LH-108）留 14px。
  ctx.fillText('班级：____________      姓名：____________', 92, LH - 84);
  ctx.restore();
}
function drawTitleCloud(ctx, tpl, pal, cx, cy, maxW, cloudScale = 1) {
  const title = R.Q(tpl.title || tpl.theme);
  let tPx = Math.round(84 * cloudScale);
  R.setFont(ctx, tPx, true);
  while (ctx.measureText(title).width > maxW - 170 && tPx > 50) { tPx -= 4; R.setFont(ctx, tPx, true); }
  const titleW = ctx.measureText(title).width;
  const cloudW = Math.min(maxW - 30, titleW + 190);
  const cloudH = Math.round(136 * cloudScale);
  cloudPill(ctx, cx + 6, cy + 9, cloudW, cloudH, 'rgba(31,38,52,0.16)');
  cloudPill(ctx, cx, cy, cloudW, cloudH, pal.mainDeep);
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(title, cx, cy - (tpl.subtitle ? Math.round(20 * cloudScale) : 0));
  if (tpl.subtitle) {
    R.setFont(ctx, 28, false);
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.fillText(tpl.subtitle, cx, cy + Math.round(47 * cloudScale)); // 副标题偏移随 cloudScale 缩放，否则小云朵下副标题溢出云底（审计返修发现）
  }
  return cy + cloudH / 2;
}
function drawBadgeHead(ctx, sec, x, y, color, r, titlePx) {
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x + r, y + r, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(x + r, y + r, r, 0, Math.PI * 2); ctx.stroke();
  R.drawEmoji(ctx, sec.icon, x + r, y + r, r * 1.28, '#FFFFFF');
  R.setFont(ctx, titlePx, true);
  ctx.fillStyle = color;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(R.Q(sec.title || ''), x + r * 2 + 16, y + r + 2);
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 5;
  ctx.beginPath();
  const uw = 108, ux = x + r * 2 + 18, uy = y + r * 2 + 12;
  for (let px = 0; px <= uw; px += 4) {
    const yy = uy + Math.sin((px / uw) * Math.PI * 2) * 4;
    px === 0 ? ctx.moveTo(ux + px, yy) : ctx.lineTo(ux + px, yy);
  }
  ctx.stroke(); ctx.restore();
  return y + r * 2 + 24;
}
async function prep(tplIn) {
  const tpl = Object.assign({}, tplIn);
  delete tpl.writeTips; delete tpl.decorTips;
  await R.preloadEmojis([tpl.emoji, ...(tpl.sections || []).map(s => s.icon),
    '⭐', '💡', '🌟', '✨']);
  return tpl;
}

/* ================= 板块形式库（v3 新增） ================= */
const FORM_NAMES = { classic: '经典条目', steps: '编号步骤', qa: '问答气泡', quote: '诗句名言卡', facts: '图标事实行' };
const FACT_ICON_POOL = ['⭐', '💡', '🌟', '✨'];

function primaryForm(sec) {
  const t = (sec && sec.title) || '';
  if (/为什么|什么是/.test(t)) return 'qa';
  if (/由来/.test(t)) return 'qa';
  if (/诗词|古诗|儿歌|祝福|寄语|愿望|推荐|欣赏|致敬|的话/.test(t)) return 'quote';
  if (/计划|目标|怎么办|怎样|行动|习惯|窍门|技巧|预防|注意事项|六不准|小提示/.test(t)) return 'steps';
  if (/好处|习俗|分类|认识|标志|故事|危险|科学|单词|问候语|红旗|阅兵|四色/.test(t)) return 'facts';
  return 'classic';
}
const CASCADES = {
  qa: ['qa', 'facts', 'steps', 'classic', 'quote'],
  quote: ['quote', 'classic', 'facts', 'steps', 'qa'],
  steps: ['steps', 'facts', 'classic', 'qa', 'quote'],
  facts: ['facts', 'steps', 'classic', 'qa', 'quote'],
  classic: ['classic', 'facts', 'steps', 'qa', 'quote']
};
/** 按内容选配 + 同图去重混搭；rotate=true 时交换兜底顺序（全批轮换） */
function selectForms(sections, rotate = false) {
  const used = new Set();
  return sections.map(sec => {
    const prim = primaryForm(sec);
    let casc = (CASCADES[prim] || ['classic']).slice();
    if (rotate && casc.length > 2) casc = [casc[0], ...casc.slice(1).reverse()];
    const pick = casc.find(f => !used.has(f)) || prim;
    used.add(pick);
    return pick;
  });
}

/* 网格单元格断行：贪心断行把 1–2 字甩到第二行时改均衡断行，避免孤字掉行
   （2026-11-14 审计：中秋寄语「岁」字掉行、消防要点「逃生/跑」拆行） */
function balancedCellLines(ctx, text, avail) {
  const lines = R.wrapText(ctx, text, avail);
  if (lines.length === 2 && lines[1].length <= 2 && lines[0].length >= 6) {
    const target = Math.ceil(ctx.measureText(text).width / 2) + 10;
    const alt = R.wrapText(ctx, text, Math.min(avail, target));
    if (alt.length === 2 && alt[1].length > lines[1].length) return alt;
  }
  return lines;
}

/* ---- 各形式 layout（度量与绘制共用计划对象） ---- */
function layoutForm(form, ctx, sec, w, px, extra = {}) {
  const content = R.Q(sec.content || '');
  const bullets = (sec.bullets || []).map(b => R.Q(b));
  if (form === 'steps' || form === 'facts') {
    const bp = Math.round(px * 0.96), lh = bp * 1.4;
    const circD = form === 'steps' ? Math.round(px * 1.52) : Math.round(px * 1.45);
    // 条目 ≥5 条时双列排（顺序先左列后右列），避免纵向溢出（如防溺水六不准）
    const twoCol = bullets.length >= 5;
    const colW = twoCol ? (w - 18) / 2 : w;
    const textW = colW - circD - 16;
    R.setFont(ctx, px, false);
    const introLines = content ? R.wrapText(ctx, content, w) : [];
    R.setFont(ctx, bp, false);
    const rows = bullets.map(b => R.wrapText(ctx, b, textW));
    const rowHs = rows.map(ls => Math.max(circD, ls.length * lh));
    const introH = introLines.length * px * 1.48;
    const gap = (introLines.length && bullets.length) ? px * 0.34 : 0;
    let rowsH;
    if (twoCol) {
      const half = Math.ceil(bullets.length / 2);
      const colH = [0, 1].map(c => {
        const idx = bullets.map((_, i) => i).filter(i => (i < half ? 0 : 1) === c);
        return idx.reduce((a, i) => a + rowHs[i], 0) + 7 * Math.max(0, idx.length - 1);
      });
      rowsH = Math.max(colH[0], colH[1]);
    } else {
      rowsH = rowHs.reduce((a, b) => a + b, 0) + 7 * Math.max(0, bullets.length - 1);
    }
    const total = introH + gap + rowsH;
    const icons = bullets.map((_, i) => {
      const pool = [sec.icon, extra.tplEmoji, ...FACT_ICON_POOL].filter(Boolean);
      return pool[(extra.secIndex * 2 + i) % pool.length];
    });
    return { form, total, introLines, rows, rowHs, bp, lh, circD, px, icons, twoCol, colW };
  }
  if (form === 'qa') {
    const bubbleW = w - 30, pad = 15;
    R.setFont(ctx, px, false);
    const qLines = content ? R.wrapText(ctx, content, bubbleW - pad * 2) : [];
    const qH = qLines.length ? qLines.length * px * 1.42 + pad * 2 - 6 : 0;
    const bp = Math.round(px * 0.94);
    const aLines = bullets.map(b => R.wrapText(ctx, b, bubbleW - pad * 2 - 18));
    const aH = bullets.length ? aLines.reduce((a, ls) => a + ls.length * bp * 1.40, 0) + (bullets.length - 1) * 4 + pad * 2 - 10 : 0;
    const total = qH + (qH && aH ? 10 : 0) + aH;
    return { form, total, qLines, aLines, qH, aH, bp, px, bubbleW, pad };
  }
  if (form === 'quote') {
    const qPx = px + 5, introPx = Math.round(px * 0.94);
    R.setFont(ctx, introPx, false);
    const introLines = content ? R.wrapText(ctx, content, w - 30) : [];
    const introH = introLines.length * introPx * 1.45;
    const useGrid = bullets.length === 4 && bullets.every(b => b.length <= 18);
    const plan = { form, introLines, introH, introPx, qPx, useGrid, px, total: 0 };
    if (useGrid) {
      const cellW = (w - 16) / 2;
      R.setFont(ctx, qPx, true);
      plan.cellLines = bullets.map(b => balancedCellLines(ctx, b, cellW - 16));
      plan.cellW = cellW;
      plan.cellH = Math.max(...plan.cellLines.map(ls => ls.length)) * qPx * 1.42 + 10;
      // 顶距 14（与 draw 的 cy 起点一致，旧值 8 使引言首行贴/压内框上边线）
      plan.total = 12 + introH + (introH ? 8 : 0) + plan.cellH * 2 + 8 + 10;
    } else {
      R.setFont(ctx, qPx, true);
      plan.lines = bullets.map(b => R.wrapText(ctx, b, w - 76));
      const bulletsH = plan.lines.reduce((a, ls) => a + ls.length * qPx * 1.46, 0) + Math.max(0, bullets.length - 1) * 2;
      plan.total = 12 + introH + (introH ? 8 : 0) + bulletsH + 10;
    }
    return plan;
  }
  // classic：与 render.js 同一度量
  return { form: 'classic', total: R.measureSection(ctx, sec, w, px).total, px };
}

function drawForm(ctx, plan, sec, x, y, w, pal, headColor, maxH) {
  const form = plan.form;
  if (form === 'classic') {
    const r = R.drawSectionBody(ctx, sec, x, y, w, plan.px, pal, maxH);
    return r.dropped;
  }
  let dropped = 0;
  ctx.save();
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  if (form === 'steps' || form === 'facts') {
    let cy = y;
    if (plan.introLines.length) {
      R.setFont(ctx, plan.px, false); ctx.fillStyle = R.INK;
      for (const ln of plan.introLines) { ctx.fillText(ln, x, cy + plan.px); cy += plan.px * 1.48; }
      cy += plan.px * 0.34;
    }
    const rowsTop = cy;
    const half = Math.ceil(plan.rows.length / 2);
    const drawRow = (lines, i, rx, ry, isLastInCol) => {
      const rowH = plan.rowHs[i];
      if (ry + rowH - y > maxH) { dropped++; return; }
      const cxC = rx + plan.circD / 2, cyC = ry + plan.circD / 2;
      if (form === 'steps' && !isLastInCol) {
        ctx.save();
        ctx.strokeStyle = R.mix(headColor, '#FFFFFF', 0.45); ctx.lineWidth = 3; ctx.setLineDash([6, 6]);
        ctx.beginPath(); ctx.moveTo(cxC, ry + plan.circD); ctx.lineTo(cxC, ry + rowH + 7); ctx.stroke();
        ctx.restore();
      }
      ctx.fillStyle = form === 'steps' ? headColor : R.mix(headColor, '#FFFFFF', 0.86);
      ctx.beginPath(); ctx.arc(cxC, cyC, plan.circD / 2, 0, Math.PI * 2); ctx.fill();
      if (form === 'steps') {
        R.setFont(ctx, Math.round(plan.px * 0.92), true);
        ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), cxC, cyC + 1);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      } else {
        ctx.strokeStyle = headColor; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cxC, cyC, plan.circD / 2, 0, Math.PI * 2); ctx.stroke();
        R.drawEmoji(ctx, plan.icons[i], rx + plan.circD / 2, cyC, plan.circD * 0.8, '#FFFFFF');
      }
      R.setFont(ctx, plan.bp, false); ctx.fillStyle = R.SUBINK;
      const blockTop = ry + (rowH - lines.length * plan.lh) / 2;
      lines.forEach((ln, j) => ctx.fillText(ln, rx + plan.circD + 16, blockTop + plan.bp * 0.96 + j * plan.lh));
    };
    if (plan.twoCol) {
      [0, 1].forEach(c => {
        let ry = rowsTop;
        const idxs = plan.rows.map((_, i) => i).filter(i => (i < half ? 0 : 1) === c);
        idxs.forEach((gi, k) => { drawRow(plan.rows[gi], gi, x + c * (plan.colW + 18), ry, k === idxs.length - 1); ry += plan.rowHs[gi] + 7; });
      });
    } else {
      plan.rows.forEach((lines, i) => { drawRow(lines, i, x, cy, i === plan.rows.length - 1); cy += plan.rowHs[i] + 7; });
    }
  } else if (form === 'qa') {
    if (plan.total > maxH + 1) dropped++; // fitCard 兜底溢出必须上报，禁止静默出框
    let cy = y;
    const bx = x + 30;
    if (plan.qH) {
      ctx.fillStyle = R.mix(pal.mainDeep, '#FFFFFF', 0.87);
      R.roundRect(ctx, bx, cy, plan.bubbleW, plan.qH, 16); ctx.fill();
      ctx.beginPath(); // 左下小尾巴
      ctx.moveTo(bx + 30, cy + plan.qH - 2); ctx.lineTo(bx + 58, cy + plan.qH - 2); ctx.lineTo(bx + 34, cy + plan.qH + 11);
      ctx.closePath(); ctx.fill();
      // 「问」角标：圆盘骑在气泡左缘上（圆心 bx-1），与气泡明确咬合——
      // 2026-11-15 普查判「悬在留白带里像贴在卡片左缘」，且与气泡边框仅 1px 相邻易粘连；
      // 骑边后右缘距正文起始（bx+pad）仍留 2px，不压字。气泡无描边，绘制序不变。
      ctx.fillStyle = pal.mainDeep;
      ctx.beginPath(); ctx.arc(bx - 1, cy + 22, 14, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(bx - 1, cy + 22, 14, 0, Math.PI * 2); ctx.stroke();
      R.setFont(ctx, 19, true); ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('问', bx - 1, cy + 23);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      R.setFont(ctx, plan.px, false); ctx.fillStyle = R.INK;
      let ty = cy + plan.pad - 4 + plan.px;
      for (const ln of plan.qLines) { ctx.fillText(ln, bx + plan.pad, ty); ty += plan.px * 1.42; }
      cy += plan.qH + 10;
    }
    if (plan.aH) {
      ctx.fillStyle = '#FFFFFF';
      R.roundRect(ctx, x, cy, plan.bubbleW, plan.aH, 16); ctx.fill();
      ctx.strokeStyle = pal.accentDeep; ctx.lineWidth = 2.5;
      R.roundRect(ctx, x, cy, plan.bubbleW, plan.aH, 16); ctx.stroke();
      // 「答」角标：圆盘骑在气泡右缘上（圆心 bubbleW+1），与「问」成对骑边——
      // 2026-11-15 普查判「悬在答案框右缘外」；骑边后左缘距正文最右仍留 2px，不压字。
      // 必须在气泡描边之后画，否则描边会切过圆盘。
      ctx.fillStyle = pal.accentDeep;
      ctx.beginPath(); ctx.arc(x + plan.bubbleW + 1, cy + 22, 14, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(x + plan.bubbleW + 1, cy + 22, 14, 0, Math.PI * 2); ctx.stroke();
      R.setFont(ctx, 19, true); ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('答', x + plan.bubbleW + 1, cy + 23);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#FFFFFF'; // 气泡右侧思考小圆点（横向出泡，不占纵向版面）
      ctx.beginPath(); ctx.arc(x + plan.bubbleW + 11, cy + plan.aH - 18, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(x + plan.bubbleW + 23, cy + plan.aH - 7, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      R.setFont(ctx, plan.bp, false);
      let ty = cy + plan.pad - 4 + plan.bp;
      plan.aLines.forEach((lines) => {
        if (ty - plan.bp - (cy + plan.pad - 4) + lines.length * plan.bp * 1.40 > plan.aH - plan.pad + 4) { dropped++; return; }
        lines.forEach((ln, j) => {
          if (j === 0) { ctx.fillStyle = headColor; ctx.fillText('•', x + plan.pad, ty); }
          ctx.fillStyle = R.SUBINK;
          ctx.fillText(ln, x + plan.pad + 18, ty);
          ty += plan.bp * 1.40;
        });
        ty += 4;
      });
    }
  } else if (form === 'quote') {
    if (plan.total > maxH + 1) dropped++; // 兜底溢出上报（旧版静默溢出：开学季末行出框）
    // 卷轴感双框：内容起点下移至 y+14，引言首行与内框上边线留足呼吸距
    // （旧版 y+6 + 大引号装饰与首行争位，多主题出现首行被框线切/压）
    // 单框：标题字底（≈内容顶−7）与首行字顶（≈内容顶+16）间隙仅约 10px，双框必压标题，改单框居中
    ctx.strokeStyle = pal.main; ctx.lineWidth = 2.2;
    R.roundRect(ctx, x - 10, y + 11, w + 20, plan.total - 5, 14); ctx.stroke();
    let cy = y + 12;
    if (plan.introLines.length) {
      R.setFont(ctx, plan.introPx, false); ctx.fillStyle = R.SUBINK; ctx.textAlign = 'center';
      for (const ln of plan.introLines) { ctx.fillText(ln, x + w / 2, cy + plan.introPx); cy += plan.introPx * 1.45; }
      cy += 8;
    }
    R.setFont(ctx, plan.qPx, true); ctx.fillStyle = pal.mainDeep; ctx.textAlign = 'center';
    if (plan.useGrid) {
      plan.cellLines.forEach((lines, i) => {
        const cx = x + (i % 2) * (plan.cellW + 16);
        const cellTop = cy + Math.floor(i / 2) * (plan.cellH + 8);
        // 顶对齐（旧版垂直居中使 1 行与 2 行单元格上下错位，看着像排版错乱）
        let ty = cellTop + plan.qPx + 2;
        for (const ln of lines) { ctx.fillText(ln, cx + plan.cellW / 2, ty); ty += plan.qPx * 1.42; }
      });
    } else {
      let ty = cy + plan.qPx;
      plan.lines.forEach((lines) => {
        for (const ln of lines) { ctx.fillText(ln, x + w / 2, ty); ty += plan.qPx * 1.46; }
        ty += 2;
      });
    }
  }
  ctx.restore();
  return dropped;
}

/** 每卡独立拟合：在 [28..20] 内找该形式放得下的最大字号 */
function fitCard(ctx, form, sec, w, maxH, extra) {
  for (let px = 28; px >= 20; px--) {
    const plan = layoutForm(form, ctx, sec, w, px, extra);
    if (plan.total <= maxH) return { px, plan, trimmed: false };
  }
  return { px: 20, plan: layoutForm(form, ctx, sec, w, 20, extra), trimmed: true };
}

/* ---------- 贴纸层 ---------- */
function drawSticker(ctx, img, cx, cy, r) {
  ctx.save();
  ctx.fillStyle = 'rgba(31,38,52,0.16)';
  ctx.beginPath(); ctx.arc(cx + 4, cy + 6, r + 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath(); ctx.arc(cx, cy, r + 7, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
  drawCover(ctx, img, cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
}
const STICKER_POS = {
  bannerTR: [LW - 142, 110, 54],
  bannerTL: [142, 110, 54],
  footerR: [LW - 172, LH - 72, 46]
};

/* ---------- A 案：顶部整宽横幅 + 2×2 卡（v3 扩展） ---------- */
async function renderLandscapeBanner(tplIn, opts) {
  const o = opts || {};
  const { heroImg, motif = 'dots' } = o;
  if (!heroImg) throw new Error('renderLandscapeBanner 需要 heroImg');
  const tpl = await prep(tplIn);
  const pal = buildPalette(o.palette ? Object.assign({}, tpl, { colorScheme: o.palette }) : tpl);
  const canvas = createCanvas(LW, LH);
  const ctx = canvas.getContext('2d');
  const sections = tpl.sections.slice(0, 4);
  drawFrameV(ctx, pal, o.frame || 'double');

  const bx = 68, by = 62, bw = LW - 136, bh = 404;
  ctx.save();
  R.roundRect(ctx, bx, by, bw, bh, 30); ctx.clip();
  {
    // 裁切焦点/缩放可调（返修用）：zoom>1 时在 cover 基础上再放大，bias 决定取景窗位置
    const zoom = o.heroZoom || 1;
    if (zoom === 1) {
      drawCover(ctx, heroImg, bx, by, bw, bh, o.heroBiasX != null ? o.heroBiasX : 0.5, o.heroBiasY != null ? o.heroBiasY : 0.40);
    } else {
      const s = Math.max(bw / heroImg.width, bh / heroImg.height) * zoom;
      const dw = heroImg.width * s, dh = heroImg.height * s;
      const biasX = o.heroBiasX != null ? o.heroBiasX : 0.5;
      const biasY = o.heroBiasY != null ? o.heroBiasY : 0.40;
      ctx.drawImage(heroImg, bx + (bw - dw) * biasX, by + (bh - dh) * biasY, dw, dh);
    }
  }
  ctx.restore();
  ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 10;
  R.roundRect(ctx, bx, by, bw, bh, 30); ctx.stroke();
  ctx.strokeStyle = R.mix(pal.main, '#FFFFFF', 0.3); ctx.lineWidth = 2.5;
  R.roundRect(ctx, bx - 5, by - 5, bw + 10, bh + 10, 34); ctx.stroke();

  const titleBottom = drawTitleCloud(ctx, tpl, pal, LW / 2 + (o.titleDX || 0), by + bh + (o.titleDY || 0), bw, o.cloudScale || 1);
  R.drawMotif(ctx, motif, 120, by + bh, 24, pal.main, pal.accent);
  R.drawMotif(ctx, motif, LW - 120, by + bh, 24, pal.accent, pal.main);

  const forms = Array.isArray(o.forms) ? o.forms : selectForms(sections, !!o.rotate);
  const gridTop = titleBottom + 22;
  const gridBottom = FOOTER_DIV - 14;
  const gapX = 22, gapY = 20;
  const cardW = (bw - gapX) / 2;
  const cardH = (gridBottom - gridTop - gapY) / 2;
  const padX = 26, headH = 56;
  const innerW = cardW - padX * 2;
  const innerH = cardH - headH - 12;
  let droppedTotal = 0;
  const bodyPxs = [];
  sections.forEach((sec, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const cx = bx + col * (cardW + gapX);
    const cy = gridTop + row * (cardH + gapY);
    const headColor = i % 2 === 0 ? pal.mainDeep : pal.accentDeep;
    ctx.fillStyle = 'rgba(31,38,52,0.10)';
    R.roundRect(ctx, cx + 6, cy + 9, cardW, cardH, 30); ctx.fill();
    ctx.fillStyle = o.cardStyle === 'tint' ? R.mix(headColor, '#FFFFFF', 0.93) : '#FFFFFF';
    R.roundRect(ctx, cx, cy, cardW, cardH, 30); ctx.fill();
    ctx.save();
    ctx.strokeStyle = R.mix(headColor, '#FFFFFF', 0.55); ctx.lineWidth = 4;
    if (o.cardStyle === 'dash') ctx.setLineDash([14, 9]);
    R.roundRect(ctx, cx, cy, cardW, cardH, 30); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = headColor;
    ctx.beginPath(); ctx.arc(cx + 40, cy + 36, 33, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(cx + 40, cy + 36, 33, 0, Math.PI * 2); ctx.stroke();
    R.drawEmoji(ctx, sec.icon, cx + 40, cy + 36, 42, '#FFFFFF');
    R.setFont(ctx, 36, true);
    ctx.fillStyle = headColor;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(R.Q(sec.title || ''), cx + 86, cy + 38);
    const fit = fitCard(ctx, forms[i] || 'classic', sec, innerW, innerH, { secIndex: i, tplEmoji: tpl.emoji });
    bodyPxs.push(fit.px);
    droppedTotal += drawForm(ctx, fit.plan, sec, cx + padX, cy + headH + 4, innerW, pal, headColor, innerH);
  });

  drawFooter(ctx, pal);
  let stickerCount = 0;
  for (const st of (o.stickers || [])) {
    const pos = Array.isArray(st.at) ? st.at : STICKER_POS[st.at || 'footerR'];
    if (st.img && pos) { drawSticker(ctx, st.img, pos[0], pos[1], st.r || pos[2]); stickerCount++; }
  }
  return {
    canvas,
    meta: {
      bodyPx: bodyPxs, dropped: droppedTotal, forms,
      frame: o.frame || 'double', cardStyle: o.cardStyle || 'plain',
      stickers: stickerCount,
      layout: 'landscape-v3-banner', size: LW + 'x' + LH
    }
  };
}

/* ---------- B 案：左栏 45% 焦点裁切 + 右侧纵排（试点落选，保留备查） ---------- */
async function renderLandscapeWide(tplIn, opts) {
  const { heroImg, motif = 'dots' } = opts || {};
  if (!heroImg) throw new Error('renderLandscapeWide 需要 heroImg');
  const tpl = await prep(tplIn);
  const pal = buildPalette(tpl);
  const canvas = createCanvas(LW, LH);
  const ctx = canvas.getContext('2d');
  const sections = tpl.sections.slice(0, 4);
  drawFrameV(ctx, pal, 'double');

  const hx = 68, hy = 62, hw = 790, hh = FOOTER_DIV - 14 - hy;
  ctx.save();
  R.roundRect(ctx, hx, hy, hw, hh, 30); ctx.clip();
  drawCover(ctx, heroImg, hx, hy, hw, hh, 0.5, 0.5);
  ctx.restore();
  ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 10;
  R.roundRect(ctx, hx, hy, hw, hh, 30); ctx.stroke();
  ctx.strokeStyle = R.mix(pal.main, '#FFFFFF', 0.3); ctx.lineWidth = 2.5;
  R.roundRect(ctx, hx - 5, hy - 5, hw + 10, hh + 10, 34); ctx.stroke();

  const rx = hx + hw + 34, rw = LW - 68 - rx;
  const titleBottom = drawTitleCloud(ctx, tpl, pal, rx + rw / 2, 148, rw);
  R.drawMotif(ctx, motif, rx + 30, 148 + 92, 22, pal.main, pal.accent);
  R.drawMotif(ctx, motif, rx + rw - 30, 148 + 92, 22, pal.accent, pal.main);

  const Y0 = titleBottom + 30;
  const contentBottom = FOOTER_DIV - 14;
  const innerW = rw - 10;
  let px = 28, blocks = null;
  const measureAll = p => {
    let yy = Y0;
    const bs = sections.map(sec => {
      const total = R.measureSection(ctx, sec, innerW, p).total;
      const b = { sec, y: yy, h: 84 + total + 16 };
      yy += b.h + 14;
      return b;
    });
    return { bs, endY: yy - 14 };
  };
  for (; px >= 20; px--) {
    const m = measureAll(px);
    blocks = m.bs;
    if (m.endY <= contentBottom) break;
  }
  if (px < 20) { px = 20; blocks = measureAll(20).bs; }
  let droppedTotal = 0;
  blocks.forEach((b, i) => {
    const headColor = i % 2 === 0 ? pal.mainDeep : pal.accentDeep;
    const bodyY = drawBadgeHead(ctx, b.sec, rx, b.y, headColor, 34, 38);
    const r = R.drawSectionBody(ctx, b.sec, rx + 4, bodyY, innerW, px, pal, b.h - (bodyY - b.y) - 6);
    droppedTotal += r.dropped;
    if (i < blocks.length - 1) {
      ctx.save();
      ctx.strokeStyle = R.mix(headColor, '#FFFFFF', 0.45); ctx.lineWidth = 2.5;
      ctx.setLineDash([10, 9]);
      ctx.beginPath(); ctx.moveTo(rx + 6, b.y + b.h + 7); ctx.lineTo(rx + rw - 6, b.y + b.h + 7); ctx.stroke();
      ctx.restore();
    }
  });

  drawFooter(ctx, pal);
  return { canvas, meta: { bodyPx: px, dropped: droppedTotal, layout: 'landscape-v3-wide', size: LW + 'x' + LH } };
}

module.exports = { renderLandscapeBanner, renderLandscapeWide, selectForms, FORM_NAMES, LW, LH, layoutForm, fitCard };
