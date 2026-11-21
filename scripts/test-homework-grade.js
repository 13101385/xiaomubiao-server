'use strict';
/**
 * 作业拍照 AI 批改接口自测（不依赖 jest、无需真实 Agnes key）：mock Agnes 调用打真接口。
 * 运行：node scripts/test-homework-grade.js
 * 覆盖：成功链路（含临时图 URL 可被拉取、处理后删除）/ 返回解析容错与字段归一化 /
 *       坏 JSON 与调用异常的错误码 / 参数与图片校验 / 未配置 key / 限流 / 临时图出口白名单。
 */
const fs = require('fs');
const path = require('path');

delete process.env.AGNES_AI_API_KEY; // 保证「未配置」分支可测（config 在 require 时读 env）
delete process.env.ARK_API_KEY;      // 默认走 Agnes 路径；方舟分支在第 9 节单独开
delete process.env.PUBLIC_BASE_URL;

const express = require('express');
const homeworkRoutes = require('../src/routes/homework');
const { _internals } = homeworkRoutes;

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ ' + msg); }
}

// 构造一张「能过魔数校验」的假 JPG（路由只校验魔数与大小，内容识别在 Agnes 侧）
const imgBuf = Buffer.alloc(2048, 7);
imgBuf[0] = 0xFF; imgBuf[1] = 0xD8; imgBuf[2] = 0xFF; imgBuf[3] = 0xE0;
const imgB64 = imgBuf.toString('base64');
const notImgB64 = Buffer.from('this is not an image').toString('base64');

(async () => {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/homework', homeworkRoutes);
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const post = (body) => fetch(base + '/api/homework/grade-photo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });

  try {
    /* ---------- 1. 成功链路：mock 校验临时图 URL 可达且字节一致 ---------- */
    homeworkRoutes.__resetRateLimit();
    let seenUrl = '';
    homeworkRoutes.__setAgnesVisionCaller(async (imageUrl) => {
      seenUrl = imageUrl;
      const r = await fetch(imageUrl);
      assert(r.status === 200, '临时图 URL 在处理中可被拉取（Agnes 抓图契约）');
      const buf = Buffer.from(await r.arrayBuffer());
      assert(buf.equals(imgBuf), '临时图字节与上传一致');
      return '```json\n{"items":[' +
        '{"no":1,"stem":"3 + 5 = ?","studentAnswer":"8","verdict":"correct","explanation":"计算正确","confidence":0.98},' +
        '{"no":2,"question":"一根绳子长 12 米，剪去 4 米，还剩几米？","answer":"7 米","result":"wrong","reason":"12-4 应为 8，孩子算成 7","confidence":95},' +
        '{"no":3,"stem":"看图写话","studentAnswer":"","verdict":"unsure","explanation":"照片反光看不清","confidence":0.2}' +
        ']}\n```';
    });
    let res = await post({ accountId: 'acc_ok', imageBase64: imgB64, subject: '数学' });
    let data = await res.json();
    assert(res.status === 200 && data.ok === true, '正常拍照批改返回 200 ok');
    assert(/\/api\/homework\/tmp\/[a-f0-9]{32}\.jpg$/.test(seenUrl), 'Agnes 收到的是临时图 URL（随机名）');
    const items = (data.data && data.data.items) || [];
    assert(items.length === 3 && data.data.count === 3, '识别出 3 题');
    assert(items[0].verdict === 'correct' && items[0].studentAnswer === '8' && items[0].confidence === 0.98, '第 1 题字段原样归一化');
    assert(items[1].stem.indexOf('绳子') >= 0 && items[1].verdict === 'wrong' && items[1].confidence === 0.95,
      '第 2 题别名字段（question/answer/result/reason）与百分数置信度被容错归一化');
    assert(items[2].verdict === 'unsure', '第 3 题 unsure 保留');
    const leftovers = fs.existsSync(_internals.TMP_DIR)
      ? fs.readdirSync(_internals.TMP_DIR).filter(f => _internals.TMP_NAME_RE.test(f)) : [];
    assert(leftovers.length === 0, '处理完成后临时图已删除，无残留');

    /* ---------- 2. 模型返回坏 JSON → 502 AI_BAD_JSON ---------- */
    homeworkRoutes.__setAgnesVisionCaller(async () => '我看这张图里好像有几道题……（非 JSON）');
    res = await post({ accountId: 'acc_bad', imageBase64: imgB64 });
    data = await res.json();
    assert(res.status === 502 && data.code === 'AI_BAD_JSON' && !!data.msg, '坏 JSON 返回 502 + AI_BAD_JSON + 可读提示');

    /* ---------- 3. 模型调用抛错 → 502 AI_FAILED ---------- */
    homeworkRoutes.__setAgnesVisionCaller(async () => { throw new Error('network boom'); });
    res = await post({ accountId: 'acc_err', imageBase64: imgB64 });
    data = await res.json();
    assert(res.status === 502 && data.code === 'AI_FAILED', '调用异常返回 502 + AI_FAILED');

    /* ---------- 4. 参数与图片校验 ---------- */
    res = await post({ imageBase64: imgB64 });
    data = await res.json();
    assert(res.status === 400 && data.code === 'PARAM', '缺 accountId 返回 400 PARAM');
    homeworkRoutes.__setAgnesVisionCaller(async () => '{"items":[{"no":1,"stem":"x","verdict":"correct"}]}');
    res = await post({ accountId: 'acc_img', imageBase64: notImgB64 });
    data = await res.json();
    assert(res.status === 400 && data.code === 'IMAGE_INVALID', '非图片内容返回 400 IMAGE_INVALID');
    res = await post({ accountId: 'acc_img' });
    data = await res.json();
    assert(res.status === 400 && data.code === 'PARAM', '缺照片返回 400 PARAM');

    /* ---------- 5. 未配置 key（默认 caller）→ 500 AGNES_NOT_CONFIGURED ---------- */
    homeworkRoutes.__setAgnesVisionCaller(null);
    res = await post({ accountId: 'acc_nokey', imageBase64: imgB64 });
    data = await res.json();
    assert(res.status === 500 && data.code === 'AGNES_NOT_CONFIGURED', '未配置 AGNES_AI_API_KEY 返回 500 + 明确错误码');

    /* ---------- 6. 限流：同账号 20 次通过、第 21 次 429 ---------- */
    homeworkRoutes.__resetRateLimit();
    homeworkRoutes.__setAgnesVisionCaller(async () => '{"items":[{"no":1,"stem":"1+1","verdict":"correct","confidence":1}]}');
    let lastStatus = 0;
    for (let i = 0; i < 20; i++) {
      const r = await post({ accountId: 'acc_rate', imageBase64: imgB64 });
      lastStatus = r.status;
      await r.json();
    }
    assert(lastStatus === 200, '限流内 20 次均可通过');
    res = await post({ accountId: 'acc_rate', imageBase64: imgB64 });
    data = await res.json();
    assert(res.status === 429 && data.code === 'RATE_LIMITED', '第 21 次返回 429 RATE_LIMITED');

    /* ---------- 7. 临时图出口白名单 ---------- */
    res = await fetch(base + '/api/homework/tmp/../config.js');
    assert(res.status === 404, '临时图出口拒绝路径穿越');
    res = await fetch(base + '/api/homework/tmp/' + 'a'.repeat(32) + '.jpg');
    assert(res.status === 404, '临时图不存在返回 404');

    /* ---------- 8. 纯函数容错 ---------- */
    const parsed = _internals.extractJson('前缀废话 {"items":[{"no":1,"stem":"x","verdict":"right"}]} 后缀');
    assert(parsed.items[0].verdict === 'right', 'extractJson 能从夹杂文本中截取 JSON');
    const norm = _internals.normalizeItems(parsed);
    assert(norm[0].verdict === 'correct', 'normalizeItems 把 right 别名归一化为 correct');
    let threw = false;
    try { _internals.normalizeItems({ foo: 1 }); } catch (e) { threw = e.code === 'AGNES_BAD_JSON'; }
    assert(threw, 'normalizeItems 缺 items 时抛 AGNES_BAD_JSON');
    const prompt = _internals.buildPrompt('语文');
    assert(prompt.includes('严格 JSON') && prompt.includes('语文') && prompt.includes('unsure'), '提示词含科目、严格 JSON 与 unsure 口径');

    /* ---------- 9. 方舟分支：配了 ARK_API_KEY 时走方舟，base64 直传、不落临时图、不调 Agnes ---------- */
    homeworkRoutes.__resetRateLimit();
    process.env.ARK_API_KEY = 'test-ark-key';
    let agnesCalled = false;
    homeworkRoutes.__setAgnesVisionCaller(async () => { agnesCalled = true; throw new Error('should not be called'); });
    let arkSeenUrl = '';
    homeworkRoutes.__setArkVisionCaller(async (dataUrl) => {
      arkSeenUrl = dataUrl;
      return '{"items":[{"no":1,"stem":"9 - 4 = ?","studentAnswer":"5","verdict":"correct","explanation":"计算正确","confidence":0.97}]}';
    });
    res = await post({ accountId: 'acc_ark', imageBase64: imgB64, subject: '数学' });
    data = await res.json();
    assert(res.status === 200 && data.ok === true && data.data.count === 1, '方舟分支正常返回批改结果');
    assert(data.data.provider === 'ark', '方舟分支响应标明 provider=ark');
    assert(arkSeenUrl.indexOf('data:image/jpeg;base64,') === 0, '方舟收到 base64 data URL 直传');
    const arkBuf = Buffer.from(arkSeenUrl.split(',')[1], 'base64');
    assert(arkBuf.equals(imgBuf), '方舟收到的图片字节与上传一致');
    assert(agnesCalled === false, '方舟分支不调用 Agnes');
    const leftovers2 = fs.existsSync(_internals.TMP_DIR)
      ? fs.readdirSync(_internals.TMP_DIR).filter(f => _internals.TMP_NAME_RE.test(f)) : [];
    assert(leftovers2.length === 0, '方舟分支不落临时图');
    homeworkRoutes.__setArkVisionCaller(async () => { const e = new Error('ark boom'); e.code = 'ARK_FAILED'; throw e; });
    res = await post({ accountId: 'acc_ark2', imageBase64: imgB64 });
    data = await res.json();
    assert(res.status === 502 && data.code === 'AI_FAILED', '方舟调用异常返回 502 + AI_FAILED');
    delete process.env.ARK_API_KEY;
    homeworkRoutes.__setArkVisionCaller(null);
    homeworkRoutes.__setAgnesVisionCaller(null);

    /* ---------- 10. 兜底：方舟失败（额度耗尽等）自动回落 Agnes；两家都失败才报错 ---------- */
    homeworkRoutes.__resetRateLimit();
    process.env.ARK_API_KEY = 'test-ark-key';
    homeworkRoutes.__setArkVisionCaller(async () => { const e = new Error('quota exceeded'); e.code = 'ARK_FAILED'; throw e; });
    let fallbackUrl = '';
    homeworkRoutes.__setAgnesVisionCaller(async (imageUrl) => {
      fallbackUrl = imageUrl;
      return '{"items":[{"no":1,"stem":"7 + 6 = ?","studentAnswer":"13","verdict":"correct","explanation":"计算正确","confidence":0.99}]}';
    });
    res = await post({ accountId: 'acc_fb', imageBase64: imgB64, subject: '数学' });
    data = await res.json();
    assert(res.status === 200 && data.ok === true && data.data.count === 1, '方舟失败后回落 Agnes 成功返回');
    assert(data.data.provider === 'agnes', '回落响应标明 provider=agnes');
    assert(/\/api\/homework\/tmp\/[a-f0-9]{32}\.jpg$/.test(fallbackUrl), '回落 Agnes 走临时图 URL');
    const leftovers3 = fs.existsSync(_internals.TMP_DIR)
      ? fs.readdirSync(_internals.TMP_DIR).filter(f => _internals.TMP_NAME_RE.test(f)) : [];
    assert(leftovers3.length === 0, '回落处理后临时图已删除');
    homeworkRoutes.__setAgnesVisionCaller(async () => { throw new Error('agnes also down'); });
    res = await post({ accountId: 'acc_fb2', imageBase64: imgB64 });
    data = await res.json();
    assert(res.status === 502 && data.code === 'AI_FAILED', '两家都失败才返回 502 AI_FAILED');
    delete process.env.ARK_API_KEY;
    homeworkRoutes.__setArkVisionCaller(null);
    homeworkRoutes.__setAgnesVisionCaller(null);

    /* ---------- 11. PM-83 只识别端点 recognize-photo：零判定字段下发 ---------- */
    const postRec = (body) => fetch(base + '/api/homework/recognize-photo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    homeworkRoutes.__resetRateLimit();
    let recPrompt = '';
    homeworkRoutes.__setAgnesVisionCaller(async (imageUrl, subject, prompt) => {
      recPrompt = prompt || '';
      // 模型不听话、硬塞判定类字段时，服务端必须剥离干净
      return '{"items":[' +
        '{"no":7,"stem":"36 + 25 =","studentAnswer":"61","verdict":"correct","explanation":"计算正确","cause":"","confidence":0.99,"knowledge":"两位数加法"},' +
        '{"no":9,"question":"78 - 39 =","answer":"49","result":"wrong","reason":"算错了"}' +
        ']}';
    });
    res = await postRec({ accountId: 'acc_rec', imageBase64: imgB64, subject: '数学' });
    data = await res.json();
    assert(res.status === 200 && data.ok === true && data.data.count === 2, '只识别端点正常返回 2 题');
    const rItems = (data.data && data.data.items) || [];
    assert(rItems.every(it => Object.keys(it).sort().join(',') === 'no,stem,studentAnswer'),
      '识别响应每题只有 no/stem/studentAnswer 三个字段（判定类字段被剥离）');
    assert(!JSON.stringify(data).includes('verdict') && !JSON.stringify(data).includes('explanation'),
      '识别响应全文无 verdict/explanation 字样');
    assert(rItems.length === 2 && rItems[0].no === 1 && rItems[1].no === 2, '题号不信任模型值、按顺序重编 1..N');
    assert(rItems[0].stem === '36 + 25 =' && rItems[0].studentAnswer === '61' && rItems[1].studentAnswer === '49',
      '题干与作答转写原样保留（别名字段容错）');
    assert(recPrompt.includes('不要判断') && !recPrompt.includes('verdict'),
      '识别提示词明确不判断对错且不含 verdict 字段要求');
    assert(data.data.provider === 'agnes', '未配 ARK 时识别走 Agnes 并标明 provider');

    /* ---------- 12. recognize-photo 失败口径：坏 JSON / 缺账号 / 方舟路径 ---------- */
    homeworkRoutes.__setAgnesVisionCaller(async () => '不是 JSON 的闲聊');
    res = await postRec({ accountId: 'acc_rec_bad', imageBase64: imgB64 });
    data = await res.json();
    assert(res.status === 502 && data.code === 'AI_BAD_JSON' && data.msg.includes('没看清'), '识别坏 JSON 返回 502 + 家长可读提示');
    res = await postRec({ imageBase64: imgB64 });
    data = await res.json();
    assert(res.status === 400 && data.code === 'PARAM', '识别缺 accountId 返回 400 PARAM');
    process.env.ARK_API_KEY = 'test-ark-key';
    let arkPrompt = '';
    homeworkRoutes.__setArkVisionCaller(async (dataUrl, subject, prompt) => {
      arkPrompt = prompt || '';
      return '{"items":[{"no":1,"stem":"5 × 4 =","studentAnswer":"20"}]}';
    });
    homeworkRoutes.__setAgnesVisionCaller(async () => { throw new Error('agnes should not be called'); });
    res = await postRec({ accountId: 'acc_rec_ark', imageBase64: imgB64, subject: '数学' });
    data = await res.json();
    assert(res.status === 200 && data.data.provider === 'ark' && data.data.items[0].stem === '5 × 4 =', '配了 ARK 时识别走方舟');
    assert(arkPrompt.includes('不要判断') && !arkPrompt.includes('verdict'), '方舟识别同样用只识别提示词');
    delete process.env.ARK_API_KEY;
    homeworkRoutes.__setArkVisionCaller(null);
    homeworkRoutes.__setAgnesVisionCaller(null);

    /* ---------- 13. 只识别纯函数 ---------- */
    const rp = _internals.buildRecognizePrompt('数学');
    assert(!rp.includes('verdict') && rp.includes('不要判断学生作答是对是错'), 'buildRecognizePrompt 零判定语义');
    const stripped = _internals.normalizeRecognizedItems({ items: [{ stem: '1+1=', studentAnswer: '2', verdict: 'correct', cause: '计算粗心' }] });
    assert(stripped.length === 1 && !('verdict' in stripped[0]) && !('cause' in stripped[0]), 'normalizeRecognizedItems 剥离判定字段');
    let threwRec = false;
    try { _internals.normalizeRecognizedItems({ items: [] }); } catch (e) { threwRec = e.code === 'AGNES_BAD_JSON'; }
    assert(threwRec, 'normalizeRecognizedItems 空结果抛 AGNES_BAD_JSON（不假装识别成功）');

    /* ---------- 14. QA 5 轮 R2 回归锁：空壳行剔除＋坏图不烧限流额度 ---------- */
    let threwBlank = false;
    try { _internals.normalizeRecognizedItems({ items: [{}] }); } catch (e) { threwBlank = e.code === 'AGNES_BAD_JSON'; }
    assert(threwBlank, 'QA-R2：题干/作答双空的空壳行被剔除、全空走失败口径（不下发空行）');
    const mixedBlank = _internals.normalizeRecognizedItems({ items: [{}, { stem: '1+1=', studentAnswer: '2' }, { stem: ' ', studentAnswer: '' }] });
    assert(mixedBlank.length === 1 && mixedBlank[0].no === 1 && mixedBlank[0].stem === '1+1=', 'QA-R2：混合空壳行剔除后有效题重编连续');
    homeworkRoutes.__resetRateLimit();
    homeworkRoutes.__setAgnesVisionCaller(async () => '{"items":[{"stem":"1+1=","studentAnswer":"2"}]}');
    for (let i = 0; i < 20; i++) { const r = await postRec({ accountId: 'acc_burn', imageBase64: notImgB64 }); await r.json(); }
    res = await postRec({ accountId: 'acc_burn', imageBase64: imgB64 });
    data = await res.json();
    assert(res.status === 200 && data.ok === true, 'QA-R2：坏图连传 20 次不烧限流额度，正常识别仍可通过');
  } catch (e) {
    failed++;
    console.log('  ✗ 自测异常:', e && e.message);
  } finally {
    srv.close();
  }

  console.log('\n==================================================');
  console.log('作业拍照批改后端自测完成');
  console.log('通过: ' + passed + ' | 失败: ' + failed);
  console.log('==================================================');
  process.exit(failed ? 1 : 0);
})();
