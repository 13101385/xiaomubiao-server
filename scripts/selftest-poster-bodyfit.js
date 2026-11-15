'use strict';
/**
 * 手抄报正文适配专项自测（2026-11-15 正文溢出修复）：
 * 1) splitSentences 按句切分（句末标点 + 收尾引号归属）
 * 2) fitBodyV2 全页统一搜索：适中版面以原行距 1.52 命中（与旧行为一致）；
 *    设计上限 270 字/卡不截断落卡；bullets 只整组保留或整组省略，绝不部分丢弃
 * 3) fitCardBodyV2 降级顺序：省 bullets 保正文 → 整句截断加「……」
 * 4) 全链路合成 meta：长正文方案 dropped=0、极端方案 truncatedCards/droppedBullets 计数正确
 * 运行：node scripts/selftest-poster-bodyfit.js
 */
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(' ✓ ' + msg); }
  else { fail++; console.log(' ✗ ' + msg); }
}

const { createCanvas } = require('canvas');
const R = require('../src/poster-render/render');
const V2 = require('../src/poster-render/render-v2');
const { fitBodyV2, fitCardBodyV2, splitSentences } = V2;

const ctx = createCanvas(100, 100).getContext('2d');
// 最紧单元格几何（与 render-v2 版式同源：W=1240、两栏卡宽 538、三行卡高 307、单行标题头 70）
// 内宽 = 538 - 28*2 = 482；内高 = 307 - 70 - 14 = 223
const DIM = { innerW: 482, innerH: 223 };
const S = '珍爱生命，远离溺水，安全第一记心间。'; // 18 字/句
const rep = (n) => S.repeat(n);
const measureFitted = (sec, fit) =>
  R.measureSection(ctx, sec, DIM.innerW, fit.px, fit.factor / 1.52).total;

console.log('\n按句切分 splitSentences');
const parts = splitSentences('他说：「水里危险。」大家听了点头。最后一句没有标点');
assert(parts.length === 3 && parts.join('') === '他说：「水里危险。」大家听了点头。最后一句没有标点',
  '切分后拼回原文一致（收尾引号归入本句）');
assert(parts[0].endsWith('。」'), '首句以「。」+收尾引号结尾，未在引号处断句');

console.log('\n全页统一搜索 fitBodyV2');
const moderate = { title: '适中板块', content: rep(7), bullets: ['要点一二三四五六', '要点七八九十一二'] };
const fitMod = fitBodyV2(ctx, [moderate], [DIM]);
assert(fitMod.factor === 1.52 && fitMod.fitted[0].droppedBullets === 0 && !fitMod.fitted[0].truncated,
  '适中正文（126 字+2 要点）以原行距 1.52 命中，字号 ' + fitMod.px + 'px，无省略无截断');

const cap270 = { title: '设计上限板块', content: rep(15), bullets: [] };
assert(cap270.content.length === 270, '构造正文恰为 270 字（六年级上限 180×1.5）');
const fitCap = fitBodyV2(ctx, [cap270], [DIM]);
assert(!fitCap.fitted[0].truncated && fitCap.fitted[0].sec.content === cap270.content,
  '270 字正文不截断、原文完整（字号 ' + fitCap.px + 'px / 行距 ' + fitCap.factor + '）');
assert(measureFitted(fitCap.fitted[0].sec, fitCap) <= DIM.innerH, '270 字适配后测高落卡内');

const cap270b = { title: '设计上限带要点', content: rep(15), bullets: ['要点甲乙丙丁戊己庚', '要点辛壬癸子丑寅卯', '要点辰巳午未申酉戌亥'] };
const fitCapB = fitBodyV2(ctx, [cap270b], [DIM]);
const fb = fitCapB.fitted[0];
assert(!fb.truncated && fb.sec.content === cap270b.content, '270 字带要点时正文仍完整不截断');
assert(fb.droppedBullets === 0 || fb.droppedBullets === 3, 'bullets 整组保留或整组省略（实际 ' + fb.droppedBullets + '），绝不部分丢弃');
assert(measureFitted(fb.sec, fitCapB) <= DIM.innerH, '270 字带要点适配后测高落卡内');

console.log('\n单卡降级 fitCardBodyV2（定格 16px / 行距 1.30）');
const longSec = { title: '长正文板块', content: rep(14), bullets: ['要点一', '要点二', '要点三'] }; // 252 字
const fitLong = fitCardBodyV2(ctx, longSec, DIM.innerW, DIM.innerH, 16, 1.30);
assert(!fitLong.truncated && fitLong.sec.content === longSec.content && fitLong.droppedBullets === 3,
  '正文放得下、带要点放不下：整组省要点保正文（省 ' + fitLong.droppedBullets + ' 条），正文不截断');

const hugeSec = { title: '超长板块', content: rep(23), bullets: ['要点一', '要点二', '要点三', '要点四', '要点五'] }; // 414 字
const fitHuge = fitCardBodyV2(ctx, hugeSec, DIM.innerW, DIM.innerH, 16, 1.30);
assert(fitHuge.truncated && fitHuge.sec.content.endsWith('……'), '超长正文（414 字）触发整句截断并以「……」结尾');
assert(hugeSec.content.startsWith(fitHuge.sec.content.slice(0, -2)), '截断保留的是原文前缀（按句切，无半句）');
assert(fitHuge.droppedBullets === 5, '截断时 bullets 整组省略并计数（' + fitHuge.droppedBullets + ' 条）');
assert(R.measureSection(ctx, fitHuge.sec, DIM.innerW, 16, 1.30 / 1.52).total <= DIM.innerH,
  '截断后测高落卡内（截断口径含「……」）');

console.log('\n全链路合成 meta（本地合成，不调线上）');
(async () => {
  try {
    const { composePosterImage } = require('../src/poster-render/compose');
    const heroCanvas = createCanvas(1536, 1024);
    const hctx = heroCanvas.getContext('2d');
    const grad = hctx.createLinearGradient(0, 0, 0, 1024);
    grad.addColorStop(0, '#7ED6F2'); grad.addColorStop(1, '#1E7FB8');
    hctx.fillStyle = grad; hctx.fillRect(0, 0, 1536, 1024);
    const heroBuf = heroCanvas.toBuffer('image/png');
    const body200 = '溺水是我国中小学生意外死亡的头号杀手。据统计，每年约有五点七万人死于溺水，其中未成年人占比超过百分之九十五，且大多发生在野外水域。许多人以为溺水者会拼命拍水大喊，其实静默溺水恰恰相反，患者往往无声无息地垂直下沉。古人云，水能载舟，亦能覆舟。认识真相，才能真正敬畏每一片水域，珍爱宝贵生命。';
    const mk = (icon, title) => ({ icon, title, content: body200, bullets: ['要点甲乙丙丁戊己', '要点庚辛壬癸子丑', '要点寅卯辰巳午未'] });
    const plan = {
      title: '珍爱生命 远离溺水', subtitle: '防溺水安全知识',
      colorScheme: { main: '#1E7FB8', accent: '#F5A623', bg: '#EFF8FF' },
      sections: [mk('⚠️', '溺水知多少'), mk('🏊', '游泳安全守则'), mk('🆘', '自救与急救'), mk('📜', '古人的智慧'),
        { icon: '💗', title: '每个人的责任', content: body200, bullets: ['主动宣传防溺水知识', '发现危险及时劝阻'] }]
    };
    const r1 = await composePosterImage({ plan, hero: heroBuf, theme: '防溺水' });
    assert(r1.meta.dropped === 0 && r1.meta.droppedBullets === 0 && r1.meta.truncatedCards === 0,
      '长正文五板块（约 200 字/卡+要点）：绘制零丢弃、要点全保留、无截断（meta: ' + JSON.stringify(r1.meta) + '）');
    const planX = JSON.parse(JSON.stringify(plan));
    planX.sections[0] = { icon: '⚠️', title: '事故教训要牢记', content: rep(18), bullets: ['要点一', '要点二', '要点三', '要点四', '要点五'] };
    const r2 = await composePosterImage({ plan: planX, hero: heroBuf, theme: '防溺水' });
    assert(r2.meta.truncatedCards === 1 && r2.meta.droppedBullets === 5 && r2.meta.dropped === 0,
      '极端卡（324 字+5 要点）：整句截断 1 卡、要点整组省略 5 条、绘制零溢出（meta: ' + JSON.stringify(r2.meta) + '）');
  } catch (e) {
    assert(false, '合成失败：' + e.message);
  }
  console.log('\n==================================================');
  console.log('正文适配专项自测完成：通过 ' + pass + ' | 失败 ' + fail);
  console.log('==================================================');
  process.exit(fail ? 1 : 0);
})();
