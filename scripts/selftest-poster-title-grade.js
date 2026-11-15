'use strict';
/**
* 手抄报质量修复批专项自测（2026-11-15）：
* 1) 方案年级口径校验 validatePlanForGrade（纯函数，构造达标/不达标方案）
* 2) hero 提示词去文字载体约束（buildImagePrompt illustration 分支）
* 3) 板块标题适配 fitSectionTitle（真实 canvas 测宽：缩字号/换行/不截断）
* 4) 全链路合成一张「防溺水·六年级」长标题方案，落盘供人工读图验看
* 运行：node scripts/selftest-poster-title-grade.js
*/
let pass = 0, fail = 0;
function assert(cond, msg) {
if (cond) { pass++; console.log(' ✓ ' + msg);}
else { fail++; console.log(' ✗ ' + msg);}
}

const poster = require('../src/routes/poster');
const { validatePlanForGrade, buildImagePrompt} = poster;

console.log('\n方案年级口径校验 validatePlanForGrade');
const G6 = '小学六年级', G1 = '小学一年级';
const sec = (title, contentLen, bullets) => ({
title,
content: '知'.repeat(contentLen),
bullets: Array.from({ length: bullets}, (_, i) => '要点' + (i + 1))
});
// 达标：六年级 bullets 3 条（口径 3~5）、正文 200 字（上限 180 的 1.5 倍 = 270 内）
assert(validatePlanForGrade({ sections: [sec('板块甲', 200, 3), sec('板块乙', 150, 5)]}, G6).length === 0,
'六年级达标方案（bullets 达下限、正文在 1.5 倍容差内）不触发重试判定');
// bullets 不足：六年级 0 条 / 2 条均低于下限 3
const vBullets = validatePlanForGrade({ sections: [sec('无要点板块', 150, 0), sec('少要点板块', 150, 2)]}, G6);
assert(vBullets.length === 2 && vBullets.every(v => v.includes('要点')),
'六年级 bullets 0 条与 2 条均触发不达标（下限 3）');
// 字数超 1.5 倍：六年级正文 271 字 > 270
const vLen = validatePlanForGrade({ sections: [sec('超长板块', 271, 4)]}, G6);
assert(vLen.length === 1 && vLen[0].includes('正文'),
'六年级正文 271 字（>180×1.5=270）触发不达标');
// 一年级：bullets 下限 1、正文上限 40×1.5=60
assert(validatePlanForGrade({ sections: [sec('观察', 55, 1)]}, G1).length === 0,
'一年级 bullets 1 条、正文 55 字（≤60）达标');
assert(validatePlanForGrade({ sections: [sec('观察', 30, 0)]}, G1).length === 1,
'一年级 bullets 0 条触发不达标（下限 1）');
assert(validatePlanForGrade({ sections: [sec('观察', 61, 2)]}, G1).length === 1,
'一年级正文 61 字（>40×1.5=60）触发不达标');
// 结构异常不误报（结构问题归路由校验）
assert(validatePlanForGrade(null, G6).length === 0 && validatePlanForGrade({}, G6).length === 0,
'方案结构异常时校验不误报');

console.log('\nhero 提示词去文字载体（illustration 分支）');
const heroPrompt = buildImagePrompt({ theme: '春节', grade: '小学三年级', mode: 'illustration', custom: '庙会夜景'});
assert(heroPrompt.includes('承载文字的载体形态'), 'illustration 提示词含「承载文字的载体形态」硬约束');
assert(['春联', '横幅', '牌匾', '招牌', '书本封面', '海报', '黑板'].every(w => heroPrompt.includes(w)),
'载体清单齐全（春联/横幅/牌匾/招牌/书本封面/海报/黑板）');
assert(heroPrompt.includes('不得出现任何文字'), '原「绝对禁止文字」约束保留');

console.log('\n板块标题适配 fitSectionTitle（真实 canvas 测宽）');
const { createCanvas} = require('canvas');
const R = require('../src/poster-render/render');
const { fitSectionTitle} = require('../src/poster-render/render-v2');
const ctx = createCanvas(100, 100).getContext('2d');
const AVAIL = 410; // 两栏卡标题可用宽：卡宽 538 - 徽章占位 100 - 右内边距 28
const lineWidths = (t) => {
R.setFont(ctx, t.px, true);
return t.lines.map(ln => ctx.measureText(ln).width);
};
// 短标题：原字号单行
const tShort = fitSectionTitle(ctx, '春节的由来', AVAIL);
assert(tShort.px === 41 && tShort.lines.length === 1, '短标题保持 41px 单行');
// 长标题（评测溢出形态，11~12 字）：缩字号或两行，且每行不超宽、文字不丢
for (const raw of ['掌握自救与求生智慧', '预防溺水是暑假最关键的事', '触目惊心的数据与事实']) {
const t = fitSectionTitle(ctx, raw, AVAIL);
const widths = lineWidths(t);
assert(t.lines.join('') === raw, '长标题「' + raw + '」未截断（拼回原文一致）');
assert(t.lines.length <= 2 && widths.every(w => w <= AVAIL + 2),
'长标题「' + raw + '」' + t.lines.length + ' 行、字号 ' + t.px + 'px、每行不超宽');
}
// 极端长标题（合并卡拼接形态，30 字）：2 行内放下且不截断
const rawLong = '溺水事故的惊人数据 · 落水自救与求生智慧 · 牢记六不准保平安';
const tLong = fitSectionTitle(ctx, rawLong, AVAIL);
assert(tLong.lines.join('') === rawLong && tLong.lines.length <= 2,
'极端长标题（' + rawLong.length + ' 字）2 行容纳且未截断（字号 ' + tLong.px + 'px）');

console.log('\n全链路合成：防溺水·六年级长标题方案成图');
(async () => {
try {
const { composePosterImage} = require('../src/poster-render/compose');
// 本地造一张无文字 hero（渐变 + 圆形装饰），不调线上生图
const heroCanvas = createCanvas(1536, 1024);
const hctx = heroCanvas.getContext('2d');
const grad = hctx.createLinearGradient(0, 0, 0, 1024);
grad.addColorStop(0, '#7ED6F2'); grad.addColorStop(1, '#1E7FB8');
hctx.fillStyle = grad; hctx.fillRect(0, 0, 1536, 1024);
hctx.fillStyle = 'rgba(255,255,255,0.5)';
for (let i = 0; i < 12; i++) { hctx.beginPath(); hctx.arc(120 + i * 120, 200 + (i % 3) * 220, 34, 0, Math.PI * 2); hctx.fill();}
const heroBuf = heroCanvas.toBuffer('image/png');
const body = '每年夏季是溺水事故的高发期。据统计，溺水是我国中小学生非正常死亡的第一杀手。阿基米德原理告诉我们，浮力与排开水的体积有关，会游泳也不意味着绝对安全。野外水域水情复杂，水下可能有暗流、漩涡和淤泥，切勿逞强下水。发现同伴落水时，要立即呼喊大人求助，并寻找竹竿、绳索等工具间接施救，绝不能手拉手盲目下水。';
const plan = {
title: '珍爱生命 预防溺水', subtitle: '远离危险水域',
colorScheme: { main: '#1E7FB8', accent: '#F5A623', bg: '#EFF8FF'},
sections: [
{ icon: '📊', title: '触目惊心的数据与事实', content: body, bullets: ['溺水是青少年非正常死亡第一杀手', '事故多发生在野外无人看管水域', '会游泳也可能发生意外']},
{ icon: '🛟', title: '掌握自救与求生智慧', content: body, bullets: ['落水后保持冷静、仰面漂浮', '大声呼救并挥手示意', '抓住漂浮物等待救援']},
{ icon: '⚠️', title: '牢记六不准才能保平安', content: body, bullets: ['不私自下水游泳', '不擅自结伴游泳', '不在无家长带领时游泳']},
{ icon: '🏊', title: '预防溺水是暑假最关键的事', content: body, bullets: ['去正规泳池并佩戴泳圈', '下水前做好热身运动', '不在水中嬉戏打闹']}
]
};
const { buffer, meta} = await composePosterImage({ plan, hero: heroBuf, theme: '防溺水'});
require('fs').writeFileSync('/tmp/poster-title-fix.jpg', buffer);
assert(buffer.length > 20000, '合成成功，成品图 ' + buffer.length + ' 字节（meta: ' + JSON.stringify(meta) + '），已存 /tmp/poster-title-fix.jpg');
} catch (e) {
assert(false, '合成失败：' + e.message);
}
console.log('\n==================================================');
console.log('专项自测完成：通过 ' + pass + ' | 失败 ' + fail);
console.log('==================================================');
process.exit(fail? 1: 0);
})();
