'use strict';
/**
 * PM-87 自测：试卷服务端异步生成全链路（本地起后端 + 假 Agnes）。
 * 覆盖：
 *  1) POST /generate 提交即返回 examId + status=generating（不等生成完，响应耗时 < 假上游延迟）
 *  2) 客户端断开后生成照常完成：list 轮询 generating → ready，详情拿到题目
 *  3) 上游失败注入 → 落 failed 且原因可见（list 与详情都带）
 *  4) failed 一键重试（POST /:id/retry）→ generating → ready；ready/generating 时重试被 409 拒
 *  5) 同账号并发上限 3：慢生成占满后第 4 份提交被 429 拒
 *  6) 未 ready 的试卷导出 PDF 被 409 拒（不许导出空卷）
 *  7) friendlyFailReason 纯函数口径
 * 用法: node scripts/selftest-exam-async.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(' ✓ ' + msg); }
  else { failed++; console.log(' ✗ ' + msg); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- 假 Agnes ---------------- */
const APP_PORT = 18101, FAKE_PORT = 19101;
let failOnceHits = 0; // __FAIL_ONCE__：主生成前 3 次（callAgnes 全部尝试）回坏内容，之后恢复

function validExam() {
  return {
    title: '小学三年级·数学试卷', subject: '数学', grade: '小学三年级', difficulty: '中等', durationMin: 60,
    sections: [
      { name: '选择题', type: 'choice', scorePer: 2, instructions: '选择题共1小题', questions: [
        { q: '3+4等于几？', options: ['6', '7', '8', '9'], answer: 'B', analysis: '3+4=7。', score: 2 }
      ] },
      { name: '填空题', type: 'fill', scorePer: 2, instructions: '填空题共1小题', questions: [
        { q: '10-4=（ ）', answer: '6', analysis: '10-4=6。', score: 2 }
      ] }
    ]
  };
}

function fakeAgnes(req, res) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    const send = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch (e) {}
    const userMsg = ((payload.messages || []).find(m => m.role === 'user') || {}).content || '';
    const chat = (obj) => send({ choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] });
    if (userMsg.includes('独立解答')) {
      const blocks = userMsg.split(/---Q\d+---/).slice(1);
      const table = [['3+4', 'B'], ['10-4', '6'], ['2×9', 'A']];
      return chat({ results: blocks.map((b, i) => {
        const hit = table.find(([mark]) => b.includes(mark));
        return { i: i + 1, answer: hit ? hit[1] : 'A' };
      }) });
    }
    if (userMsg.includes('简明解析')) {
      const blocks = userMsg.split(/---Q\d+---/).slice(1);
      return chat({ results: blocks.map((_, i) => ({ i: i + 1, analysis: '结合题干一步步推导即可得出答案。' })) });
    }
    if (userMsg.includes('重新命制')) {
      return chat({ q: '2×9等于几？', options: ['18', '16', '20', '12'], answer: 'A', analysis: '二九十八，2×9=18。' });
    }
    if (userMsg.includes('生成一份')) {
      if (userMsg.includes('__FAIL_ONCE__') && failOnceHits < 3) {
        failOnceHits++;
        return chat('这不是JSON，解析必然失败');
      }
      if (userMsg.includes('__SLOW__')) await sleep(3500);
      else await sleep(900);
      return chat(validExam());
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'fake agnes: unexpected request ' + req.url }));
  });
}

function httpJson(method, url, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      const cs = [];
      res.on('data', c => cs.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(cs);
        let json = null;
        try { json = JSON.parse(buf.toString()); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function pollListStatus(accountId, examId, want, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await httpJson('GET', `http://127.0.0.1:${APP_PORT}/api/exam/list?accountId=${accountId}`);
    const item = r.json && r.json.data && r.json.data.list.find(x => x.id === examId);
    if (item && item.status === want) return item;
    await sleep(400);
  }
  return null;
}

(async () => {
  /* ---- 纯函数口径 ---- */
  const examRoute = require('../src/routes/exam');
  assert(examRoute.friendlyFailReason(new Error('服务器未配置 AGNES_AI_API_KEY')).includes('暂时不可用'), 'friendlyFailReason：未配置 → 服务暂时不可用');
  assert(examRoute.friendlyFailReason(new Error('AI 返回内容解析失败')).includes('请重试'), 'friendlyFailReason：解析失败 → 请重试');
  assert(examRoute.MAX_GENERATING_PER_ACCOUNT === 3, '并发上限常量 = 3');
  assert(examRoute.MAX_EXAM_RETRIES === 5, 'QA-R1：单份试卷重试上限常量 = 5（防无限重试绕过每日限额）');

  const fake = http.createServer(fakeAgnes);
  await new Promise(r => fake.listen(FAKE_PORT, r));
  const dbFile = '/tmp/selftest-exam-async.db';
  try { fs.unlinkSync(dbFile); } catch (e) {}
  const app = spawn('node', ['src/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      PORT: String(APP_PORT), DB_PATH: dbFile,
      AGNES_AI_API_KEY: ['self', 'test', 'key'].join('-'),
      AGNES_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/v1`
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let appLog = '';
  app.stdout.on('data', d => appLog += d);
  app.stderr.on('data', d => appLog += d);
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const h = await httpJson('GET', `http://127.0.0.1:${APP_PORT}/health`); up = h.status === 200; } catch (e) { await sleep(300); }
    }
    assert(up, '本地后端启动成功');
    if (!up) { console.log(appLog.slice(-800)); return; }

    /* ---- 1) 提交即返回（脱钩证明：响应耗时 < 假上游 900ms 延迟） ---- */
    const t0 = Date.now();
    const sub = await httpJson('POST', `http://127.0.0.1:${APP_PORT}/api/exam/generate`, {
      accountId: 'async-acc', subject: '数学', grade: '小学三年级', difficulty: '中等', choice: 1, fill: 1
    });
    const elapsed = Date.now() - t0;
    assert(sub.json && sub.json.ok && !!sub.json.examId, '提交返回 ok + examId');
    assert(sub.json.status === 'generating', '提交响应 status=generating');
    assert(elapsed < 900, `提交响应耗时 ${elapsed}ms < 上游延迟 900ms（已脱钩）`);
    const examId = sub.json.examId;

    /* ---- 2) 生成中状态可见（list + detail），此时重试被拒 ---- */
    const inList = await httpJson('GET', `http://127.0.0.1:${APP_PORT}/api/exam/list?accountId=async-acc`);
    const li = inList.json.data.list.find(x => x.id === examId);
    assert(li && li.status === 'generating', '列表中状态为 generating');
    const dGen = await httpJson('GET', `http://127.0.0.1:${APP_PORT}/api/exam/${examId}?accountId=async-acc`);
    assert(dGen.json.exam.status === 'generating' && !(dGen.json.exam.content && dGen.json.exam.content.sections), '详情 generating 时无题目内容（明确状态而非报错）');
    const retryGen = await httpJson('POST', `http://127.0.0.1:${APP_PORT}/api/exam/${examId}/retry`, { accountId: 'async-acc' });
    assert(retryGen.status === 409, 'generating 时重试被 409 拒');

    /* ---- 3) 断开后照常完成：轮询到 ready，详情有题 ---- */
    const readyItem = await pollListStatus('async-acc', examId, 'ready', 30000);
    assert(!!readyItem, '轮询列表看到 generating → ready');
    const dReady = await httpJson('GET', `http://127.0.0.1:${APP_PORT}/api/exam/${examId}?accountId=async-acc`);
    const secs = dReady.json.exam.content && dReady.json.exam.content.sections;
    assert(dReady.json.exam.status === 'ready' && Array.isArray(secs) && secs.length === 2, 'ready 后详情带完整题目');
    assert(dReady.json.exam.requested === 2 && dReady.json.exam.delivered === 2, '详情带 requested/delivered=2');
    const retryReady = await httpJson('POST', `http://127.0.0.1:${APP_PORT}/api/exam/${examId}/retry`, { accountId: 'async-acc' });
    assert(retryReady.status === 409, 'ready 时重试被 409 拒');

    /* ---- 4) 失败注入 → failed + 原因可见 ---- */
    const subFail = await httpJson('POST', `http://127.0.0.1:${APP_PORT}/api/exam/generate`, {
      accountId: 'async-acc', subject: '数学', grade: '小学三年级', difficulty: '中等', knowledge: '__FAIL_ONCE__', choice: 1, fill: 1
    });
    assert(subFail.json && subFail.json.ok, '失败注入单提交成功');
    const failItem = await pollListStatus('async-acc', subFail.json.examId, 'failed', 30000);
    assert(!!failItem, '上游坏内容 → 落 failed');
    assert(failItem && typeof failItem.failReason === 'string' && failItem.failReason.length > 0, '列表带 failReason：' + (failItem && failItem.failReason));
    const dFail = await httpJson('GET', `http://127.0.0.1:${APP_PORT}/api/exam/${subFail.json.examId}?accountId=async-acc`);
    assert(dFail.json.exam.status === 'failed' && dFail.json.exam.failReason === failItem.failReason, '详情 failed + 原因与列表一致');

    /* ---- 5) 未 ready 导出 PDF 被拒 ---- */
    const pdfFail = await httpJson('GET', `http://127.0.0.1:${APP_PORT}/api/exam/${subFail.json.examId}/pdf?accountId=async-acc`);
    assert(pdfFail.status === 409, 'failed 试卷导出 PDF 被 409 拒（不导出空卷）');

    /* ---- 6) failed 一键重试 → ready（坏内容额度已耗尽，假上游恢复） ---- */
    const retry = await httpJson('POST', `http://127.0.0.1:${APP_PORT}/api/exam/${subFail.json.examId}/retry`, { accountId: 'async-acc' });
    assert(retry.json && retry.json.ok && retry.json.status === 'generating', '重试提交成功转 generating');
    const retried = await pollListStatus('async-acc', subFail.json.examId, 'ready', 30000);
    assert(!!retried, '重试后生成完成转 ready');

    /* ---- 7) 并发上限：3 份慢生成占满，第 4 份被拒 ---- */
    const capSubs = [];
    for (let i = 0; i < 3; i++) {
      capSubs.push(await httpJson('POST', `http://127.0.0.1:${APP_PORT}/api/exam/generate`, {
        accountId: 'cap-acc', subject: '数学', grade: '小学三年级', difficulty: '中等', knowledge: '__SLOW__', choice: 1, fill: 1
      }));
    }
    assert(capSubs.every(s => s.json && s.json.ok), '并发 3 份慢生成提交成功');
    const fourth = await httpJson('POST', `http://127.0.0.1:${APP_PORT}/api/exam/generate`, {
      accountId: 'cap-acc', subject: '数学', grade: '小学三年级', difficulty: '中等', choice: 1, fill: 1
    });
    assert(fourth.status === 429 && /正在生成/.test((fourth.json && fourth.json.msg) || ''), '第 4 份被并发上限 429 拒：' + (fourth.json && fourth.json.msg));
    const capReady = await pollListStatus('cap-acc', capSubs[0].json.examId, 'ready', 60000);
    assert(!!capReady, '慢生成最终完成（并发管道无死锁）');

    /* ---- 8) QA-R1：并发齐发不突破上限（旧版 TOCTOU 实测 6 齐发被接受 4 份） ---- */
    const burst = await Promise.all([0, 1, 2, 3].map(() => httpJson('POST', `http://127.0.0.1:${APP_PORT}/api/exam/generate`, {
      accountId: 'burst-acc', subject: '数学', grade: '小学三年级', difficulty: '中等', knowledge: '__SLOW__', choice: 1, fill: 1
    })));
    const burstOk = burst.filter(x => x.json && x.json.ok).length;
    assert(burstOk === 3, `并发齐发恰好接受 3 份（实际 ${burstOk}，临界区串行化后不突破上限）`);
  } finally {
    app.kill('SIGKILL');
    fake.close();
    try { fs.unlinkSync(dbFile); } catch (e) {}
  }
  console.log('\n' + '='.repeat(50));
  console.log(`PM-87 异步自测完成：通过 ${passed} | 失败 ${failed}`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('自测异常:', e); process.exit(1); });
