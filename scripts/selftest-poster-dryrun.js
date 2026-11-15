'use strict';
/**
 * 手抄报 generate-image「评测 dryRun 开关」专项自测。
 *
 * 方法：在 require 路由前用 require.cache 打桩替换 db / config / axios(Agnes) / 合成引擎，
 * 然后真实挂载 poster 路由发 HTTP 请求，断言：
 *  1) dryRun===true + 白名单账号 eval_ai_quality（默认合成模式）：不落库，响应带 composedBase64 + imageUrl；
 *  2) dryRun===true + 白名单（mode=illustration）：不落库，响应带 imageUrl；
 *  3) dryRun===true + 非白名单账号：参数被忽略，照常落库（createPoster + 合成回写都发生）；
 *  4) 无 dryRun + 白名单账号：照常落库（白名单本身不触发 dryRun）；
 *  5) dryRun='true'（字符串，非布尔）+ 白名单：不触发 dryRun，照常落库（严格 === true）；
 *  6) dryRun + 白名单 + 合成失败：返回 500，且 deletePoster 未被调用（无回滚误删）。
 * 用法: node scripts/selftest-poster-dryrun.js
 */
const path = require('path');
const http = require('http');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(' ✓ ' + msg); }
  else { failed++; console.log(' ✗ ' + msg); }
}

/* ================= 打桩（必须在 require 路由之前） ================= */
const FAKE_IMG_URL = 'https://fake-agnes.example/hero.png';
const FAKE_JPEG = Buffer.from('FAKE-COMPOSED-JPEG-BYTES');
const FAKE_PLAN = {
  title: '春节手抄报',
  subtitle: '欢欢喜喜过大年',
  sections: [
    { icon: '🧧', title: '春节习俗', content: '贴春联、放鞭炮、拜年。', bullets: ['贴春联', '拜年'] },
    { icon: '🏮', title: '年夜饭', content: '一家人团团圆圆吃年夜饭。', bullets: ['饺子', '鱼'] }
  ]
};

const dbCalls = { createPoster: 0, deletePoster: 0, putBlob: 0, updatePoster: 0 };
const dbStub = {
  createPoster: async () => { dbCalls.createPoster++; },
  deletePoster: async () => { dbCalls.deletePoster++; return true; },
  putBlob: async () => { dbCalls.putBlob++; },
  updatePoster: async () => { dbCalls.updatePoster++; return true; },
  countPostersToday: async () => 0
};

const axiosStub = {
  post: async (url) => {
    if (String(url).includes('/images/generations')) {
      return { data: { data: [{ url: FAKE_IMG_URL }] } };
    }
    if (String(url).includes('/chat/completions')) {
      return { data: { choices: [{ message: { content: JSON.stringify(FAKE_PLAN) } }] } };
    }
    throw new Error('unexpected axios.post ' + url);
  },
  get: async () => ({ data: Buffer.alloc(500, 7) }) // hero 图下载（≥100 字节过校验）
};

let composeShouldFail = false;
const composeCalls = { compose: 0, store: 0 };
const composeStub = {
  composePosterImage: async () => {
    composeCalls.compose++;
    if (composeShouldFail) throw new Error('stub 合成失败');
    return { buffer: FAKE_JPEG, meta: { stub: true } };
  },
  // 与真实 storeComposedImage 同口径：putBlob + updatePoster 回写，返回相对 URL
  storeComposedImage: async (db, posterId) => {
    composeCalls.store++;
    await db.putBlob('composed/' + posterId + '.jpg', FAKE_JPEG.toString('base64'));
    await db.updatePoster(posterId, '', { composedUrl: '/api/poster/composed/' + posterId + '.jpg' });
    return '/api/poster/composed/' + posterId + '.jpg';
  },
  pickMotif: () => 'star'
};

function seedCache(resolved, exportsObj) {
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
seedCache(require.resolve('../src/db'), dbStub);
seedCache(require.resolve('../src/config'), {
  config: { agnes: { apiKey: 'test-key', baseURL: 'https://fake-agnes.example/v1', model: 'test-model', timeoutMs: 5000 } }
});
seedCache(require.resolve('axios', { paths: [path.join(__dirname, '..', 'src', 'routes')] }), axiosStub);
seedCache(require.resolve('../src/poster-render/compose'), composeStub);

/* ================= 挂载路由并请求 ================= */
const express = require('express');
const posterRouter = require('../src/routes/poster');

function postJson(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/poster/generate-image', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { /* keep null */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function resetCalls() {
  dbCalls.createPoster = 0; dbCalls.deletePoster = 0; dbCalls.putBlob = 0; dbCalls.updatePoster = 0;
  composeCalls.compose = 0; composeCalls.store = 0;
  composeShouldFail = false;
}

const BASE = { theme: '春节', grade: '小学三年级' };

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/poster', posterRouter);
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;

  try {
    // 1) dryRun + 白名单，默认合成模式
    resetCalls();
    let r = await postJson(port, { ...BASE, accountId: 'eval_ai_quality', dryRun: true });
    assert(r.status === 200 && r.json && r.json.ok === true, '用例1 请求成功');
    assert(r.json.dryRun === true, '用例1 响应带 dryRun:true');
    assert(r.json.composedBase64 === FAKE_JPEG.toString('base64'), '用例1 响应带 composedBase64（成品图 base64）');
    assert(r.json.imageUrl === FAKE_IMG_URL, '用例1 响应带 imageUrl（Agnes 原图）');
    assert(!r.json.posterId, '用例1 响应无 posterId（未落库）');
    assert(dbCalls.createPoster === 0 && dbCalls.deletePoster === 0, '用例1 createPoster/deletePoster 均未调用');
    assert(dbCalls.putBlob === 0 && dbCalls.updatePoster === 0 && composeCalls.store === 0, '用例1 合成图未回写（store/putBlob/updatePoster 均未调用）');
    assert(composeCalls.compose === 1, '用例1 合成引擎照常执行（测的是真实链路）');

    // 2) dryRun + 白名单，illustration 模式
    resetCalls();
    r = await postJson(port, { ...BASE, accountId: 'eval_ai_quality', dryRun: true, mode: 'illustration' });
    assert(r.status === 200 && r.json && r.json.dryRun === true && r.json.imageUrl === FAKE_IMG_URL, '用例2 illustration 模式 dryRun 返回 imageUrl');
    assert(dbCalls.createPoster === 0, '用例2 createPoster 未调用');

    // 3) dryRun + 非白名单账号：参数被忽略，照常落库
    resetCalls();
    r = await postJson(port, { ...BASE, accountId: 'acc_real_user', dryRun: true });
    assert(r.status === 200 && r.json && r.json.ok === true && !!r.json.posterId && r.json.dryRun === undefined, '用例3 非白名单带 dryRun 仍走正常流程（有 posterId、无 dryRun 标记）');
    assert(dbCalls.createPoster === 1 && composeCalls.store === 1 && dbCalls.putBlob === 1 && dbCalls.updatePoster === 1, '用例3 落库与合成回写照常发生');

    // 4) 无 dryRun + 白名单账号：照常落库
    resetCalls();
    r = await postJson(port, { ...BASE, accountId: 'eval_ai_quality' });
    assert(r.status === 200 && r.json && !!r.json.posterId && r.json.dryRun === undefined, '用例4 白名单不带 dryRun 时正常返回 posterId');
    assert(dbCalls.createPoster === 1, '用例4 createPoster 照常调用');

    // 5) dryRun='true' 字符串 + 白名单：严格 === true，不触发
    resetCalls();
    r = await postJson(port, { ...BASE, accountId: 'eval_ai_quality', dryRun: 'true' });
    assert(r.status === 200 && r.json && !!r.json.posterId && r.json.dryRun === undefined, "用例5 dryRun 传字符串 'true' 不触发 dryRun");
    assert(dbCalls.createPoster === 1, '用例5 照常落库');

    // 6) dryRun + 白名单 + 合成失败：500 且不调 deletePoster
    resetCalls();
    composeShouldFail = true;
    r = await postJson(port, { ...BASE, accountId: 'eval_ai_quality', dryRun: true });
    assert(r.status === 500 && r.json && r.json.ok === false, '用例6 合成失败返回 500');
    assert(dbCalls.createPoster === 0 && dbCalls.deletePoster === 0, '用例6 dryRun 失败路径 createPoster/deletePoster 均未调用');
  } finally {
    server.close();
  }

  console.log('\n==================================================');
  console.log(`dryRun 自测完成：通过 ${passed} | 失败 ${failed}`);
  console.log('==================================================');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('自测异常:', e);
  process.exit(1);
});
