/**
 * 家庭核心数据云端快照（1.5.69 信任修复 P0）
 *
 * 背景：孩子/任务/积分等核心数据此前只存小程序本地（按 accountId 分键），
 * 正式版/体验版/开发版的本地存储互相隔离、清缓存即丢，用户微信登录后被
 * 要求重新建档。此接口给每个微信账号在云端留一份全量快照用于恢复。
 *
 * POST /api/family/sync   body: { accountId, payload }
 *   payload 为前端快照对象 { version, savedAt, data: { 'gp:children': [...], ... } }。
 *   硬红线：快照里没有孩子数据（data['gp:children'] 不是非空数组）一律拒绝写入，
 *   绝不许用空本地覆盖云端已有数据。
 * GET  /api/family/data?accountId=
 *   返回 { ok:true, data:{ payload: <对象|null>, updatedAt } }，无快照时 payload=null。
 *
 * 隐私：快照只含该账号自己的业务数据（文本/结构化记录），不含照片/录音文件本体。
 */
const express = require('express');
const router = express.Router();
const db = require('../db');

const MAX_ACCOUNT_ID = 128;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024; // 8MB：家庭数据是文本记录，远够用；防异常大包

function validAccountId(v) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_ACCOUNT_ID;
}

/** 快照里是否有孩子数据——空覆盖防护的判定口径，与前端 restore 条件一致 */
function payloadHasChildren(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const data = payload.data;
  if (!data || typeof data !== 'object') return false;
  const children = data['gp:children'];
  return Array.isArray(children) && children.length > 0;
}

router.post('/sync', async (req, res) => {
  const body = req.body || {};
  const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
  if (!validAccountId(accountId)) {
    return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  }
  const payload = body.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ ok: false, msg: '快照格式不正确' });
  }
  if (!payloadHasChildren(payload)) {
    return res.status(400).json({ ok: false, msg: '本地没有孩子数据，拒绝覆盖云端快照' });
  }
  let payloadJson = '';
  try { payloadJson = JSON.stringify(payload); } catch (e) {
    return res.status(400).json({ ok: false, msg: '快照无法序列化' });
  }
  if (payloadJson.length > MAX_PAYLOAD_BYTES) {
    return res.status(413).json({ ok: false, msg: '快照太大了' });
  }
  try {
    const now = Date.now();
    await db.upsertFamilyData(accountId, payloadJson, now);
    res.json({ ok: true, data: { updatedAt: now } });
  } catch (err) {
    console.error('[FAMILY] sync error:', err.message);
    res.status(500).json({ ok: false, msg: '同步失败，请稍后再试' });
  }
});

router.get('/data', async (req, res) => {
  const accountId = typeof req.query.accountId === 'string' ? req.query.accountId.trim() : '';
  if (!validAccountId(accountId)) {
    return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  }
  try {
    const row = await db.getFamilyData(accountId);
    if (!row) {
      return res.json({ ok: true, data: { payload: null, updatedAt: 0 } });
    }
    let payload = null;
    try { payload = JSON.parse(row.payload); } catch (e) { payload = null; }
    res.json({ ok: true, data: { payload, updatedAt: row.updatedAt || 0 } });
  } catch (err) {
    console.error('[FAMILY] get error:', err.message);
    res.status(500).json({ ok: false, msg: '读取失败，请稍后再试' });
  }
});

module.exports = router;
