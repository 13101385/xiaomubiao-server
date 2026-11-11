/**
 * 认证路由
 * 提供：微信登录、微信手机号验证、用户管理
 */
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();
const { config } = require('../config');
const db = require('../db');

/* ==================== 头像辅助 ==================== */

// 头像 blob key（与海报同套 poster_blobs 存储）
function avatarBlobKey(accountId) {
  return 'avatar:' + accountId;
}

// 头像访问 URL（相对路径，前端拼 API_BASE）；无头像返回 ''
function buildAvatarUrl(parent) {
  if (!parent || !parent.avatar_key) return '';
  const v = parent.avatar_updated_at || parent.updated_at || 0;
  return '/api/auth/avatar/' + encodeURIComponent(parent.account_id) + '?v=' + v;
}

// 图片扩展名 → Content-Type
function avatarContentType(ext) {
  switch (String(ext || '').toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'png':
    default:
      return 'image/png';
  }
}

// 规范化扩展名：优先用传入的 avatarExt，否则按 base64 魔数识别（同海报逻辑）
function detectAvatarExt(base64Data, avatarExt) {
  let ext = String(avatarExt || '').toLowerCase().replace(/^\./, '');
  if (ext === 'jpeg') ext = 'jpg';
  if (['png', 'jpg', 'gif', 'webp'].includes(ext)) return ext;
  const head = Buffer.from(base64Data.slice(0, 16), 'base64');
  if (head[0] === 0xFF && head[1] === 0xD8) return 'jpg';
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'gif';
  if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) return 'webp';
  return 'png';
}

/**
 * POST /api/auth/wechat-login
 * 微信登录：用 code 换取 openId（真实 code2session）
 */
router.post('/wechat-login', async (req, res) => {
  const { code } = req.body;
  
  if (!code) {
    return res.status(400).json({ ok: false, msg: '缺少 code 参数' });
  }
  
  try {
    // 调用微信接口换取 openId
    const wxRes = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: {
        appid: config.wx.appid,
        secret: config.wx.appsecret,
        js_code: code,
        grant_type: 'authorization_code'
      },
      timeout: 10000
    });
    
    const { openid, unionid, errcode, errmsg } = wxRes.data;
    
    if (errcode) {
      console.error('[WX] code2session error:', wxRes.data);
      return res.status(400).json({ ok: false, msg: '微信登录失败：' + errmsg });
    }
    
    if (!openid) {
      return res.status(400).json({ ok: false, msg: '微信登录失败：未获取到 openid' });
    }
    
    // 生成账号 ID
    const accountId = generateAccountId('wechat', openid);
    
    // 检查是否已存在家长记录
    const parent = await db.getParentRecord(accountId);
    const isNew = !parent || !parent.has_registered;
    
    const avatarUrl = buildAvatarUrl(parent);
    res.json({
      ok: true,
      user: {
        accountId,
        openId: openid,
        loginType: 'wechat',
        name: parent ? parent.parent_name : '',
        ...(avatarUrl ? { avatarUrl } : {}),
        isNew
      }
    });
  } catch (err) {
    console.error('[WX] Login error:', err.message);
    res.status(500).json({ ok: false, msg: '微信登录失败，请稍后重试' });
  }
});

/**
 * POST /api/auth/phone-verify
 * 微信手机号实时验证：用 getRealtimePhoneNumber 返回的 code 换取真实手机号
 * 说明：实时验证组件对个人主体小程序开放（快速验证 getuserphonenumber 需企业认证）
 */
router.post('/phone-verify', async (req, res) => {
  const { code } = req.body;
  
  if (!code) {
    return res.status(400).json({ ok: false, msg: '缺少 code 参数' });
  }
  
  try {
    // 1. 获取 access_token
    const tokenRes = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
      params: {
        grant_type: 'client_credential',
        appid: config.wx.appid,
        secret: config.wx.appsecret
      },
      timeout: 10000
    });
    
    if (tokenRes.data.errcode) {
      console.error('[WX] get token error:', tokenRes.data);
      return res.status(500).json({ ok: false, msg: '获取 access_token 失败' });
    }
    
    const accessToken = tokenRes.data.access_token;
    
    // 2. 用 code 换取手机号（实时验证接口）
    const phoneRes = await axios.post(
      'https://api.weixin.qq.com/phonenumber/getrealtimephonenumber?access_token=' + accessToken,
      { code },
      { timeout: 10000 }
    );
    
    const data = phoneRes.data;
    
    if (data.errcode) {
      console.error('[WX] get realtime phone error:', data);
      return res.status(400).json({ ok: false, msg: '获取手机号失败：' + (data.errmsg || data.errcode) });
    }
    
    const phone = data.phone_info && data.phone_info.purePhoneNumber;
    if (!phone) {
      return res.status(400).json({ ok: false, msg: '未获取到手机号' });
    }
    
    // 3. 生成账号并登录
    const accountId = generateAccountId('phone', phone);
    const parent = await db.getParentRecord(accountId);
    const isNew = !parent || !parent.has_registered;
    
    const avatarUrl = buildAvatarUrl(parent);
    res.json({
      ok: true,
      user: {
        accountId,
        phone,
        openId: '',
        loginType: 'phone',
        name: parent ? parent.parent_name : '',
        ...(avatarUrl ? { avatarUrl } : {}),
        isNew
      }
    });
  } catch (err) {
    console.error('[PHONE] Verify error:', err.message);
    res.status(500).json({ ok: false, msg: '手机号登录失败，请稍后重试' });
  }
});

/**
 * POST /api/auth/profile
 * 家长资料同步（昵称/头像）：登录后用微信头像昵称组件获取，保存到账号，换设备不丢
 * body: { accountId, name?, avatarBase64?, avatarExt? }
 * - 按 accountId upsert 家长记录（不存在则建行，has_registered 保持 0）
 * - name 非空时更新昵称；avatarBase64 存在时存入 blob 存储并记录图片类型
 * 返回: { ok: true, user: { accountId, name, avatarUrl } }
 */
router.post('/profile', async (req, res) => {
  const { accountId, name, avatarBase64, avatarExt } = req.body || {};

  if (!accountId) {
    return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  }

  try {
    const fields = {};
    if (typeof name === 'string' && name.trim()) {
      fields.name = name.trim().slice(0, 50);
    }

    if (avatarBase64) {
      const base64Data = String(avatarBase64).replace(/^data:image\/\w+;base64,/, '').replace(/\s/g, '');
      if (!base64Data || base64Data.length > 8 * 1024 * 1024) {
        return res.status(400).json({ ok: false, msg: '头像数据无效或过大' });
      }
      // 先校验 base64 可解码出图片字节
      const buf = Buffer.from(base64Data, 'base64');
      if (!buf.length) {
        return res.status(400).json({ ok: false, msg: '头像数据无效' });
      }
      const ext = detectAvatarExt(base64Data, avatarExt);
      const key = avatarBlobKey(accountId);
      await db.putBlob(key, base64Data);
      fields.avatarKey = key;
      fields.avatarType = ext;
      fields.avatarUpdatedAt = Date.now();
    }

    const parent = await db.upsertParentProfile(accountId, fields);

    res.json({
      ok: true,
      user: {
        accountId,
        name: parent ? parent.parent_name : '',
        avatarUrl: buildAvatarUrl(parent)
      }
    });
  } catch (err) {
    console.error('[AUTH] profile error:', err.message);
    res.status(500).json({ ok: false, msg: '资料保存失败，请稍后再试' });
  }
});

/**
 * GET /api/auth/avatar/:accountId
 * 返回该账号头像图片二进制；无头像 404 JSON
 */
router.get('/avatar/:accountId', async (req, res) => {
  const accountId = String(req.params.accountId || '');
  if (!accountId) {
    return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  }
  try {
    const parent = await db.getParentRecord(accountId);
    if (!parent || !parent.avatar_key) {
      return res.status(404).json({ ok: false, msg: '头像不存在' });
    }
    const data = await db.getBlob(parent.avatar_key);
    if (!data) {
      return res.status(404).json({ ok: false, msg: '头像不存在' });
    }
    const buf = Buffer.from(data, 'base64');
    res.set('Content-Type', avatarContentType(parent.avatar_type));
    res.set('Content-Length', buf.length);
    // URL 带 ?v= 版本戳，内容变更 URL 即变更，可放心缓存
    res.set('Cache-Control', 'public, max-age=604800');
    res.send(buf);
  } catch (err) {
    console.error('[AUTH] avatar 读取失败:', err.message);
    res.status(500).json({ ok: false, msg: '头像读取失败' });
  }
});

/**
 * POST /api/auth/parent-setup
 * 家长首次注册
 */
router.post('/parent-setup', async (req, res) => {
  const { accountId, parentName, pin } = req.body;
  
  if (!accountId || !parentName || !pin) {
    return res.status(400).json({ ok: false, msg: '缺少参数' });
  }
  
  if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ ok: false, msg: 'PIN 码需为4位数字' });
  }
  
  try {
    // 哈希 PIN
    const pinHash = crypto.createHash('sha256').update(pin).digest('hex');

    const record = await db.saveParentRecord(accountId, parentName, pinHash);

    res.json({ ok: true, record });
  } catch (err) {
    console.error('[PARENT] Setup error:', err.message);
    res.status(500).json({ ok: false, msg: '服务器错误' });
  }
});

/**
 * POST /api/auth/delete-account
 * 注销账号：删除该账号在服务器端的全部数据（家长记录/试卷/手抄报及成品图）
 * body: { accountId }
 */
router.post('/delete-account', async (req, res) => {
  const { accountId } = req.body || {};
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  try {
    await db.deleteAccountData(accountId);
    console.log('[AUTH] 账号已注销:', accountId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[AUTH] delete-account error:', err.message);
    res.status(500).json({ ok: false, msg: '注销失败，请稍后再试' });
  }
});

/**
 * GET /api/auth/check-parent
 * 检查家长是否已注册
 */
router.get('/check-parent', async (req, res) => {
  const { accountId } = req.query;
  
  if (!accountId) {
    return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  }
  
  try {
    const registered = await db.isParentRegistered(accountId);
    const parent = await db.getParentRecord(accountId);
    
    res.json({
      ok: true,
      registered,
      parentName: parent ? parent.parent_name : ''
    });
  } catch (err) {
    res.status(500).json({ ok: false, msg: '服务器错误' });
  }
});

/**
 * 生成账号 ID（与前端保持一致）
 */
function generateAccountId(type, val) {
  const raw = type === 'wechat' ? ('w_' + val) : ('p_' + val);
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash) + raw.charCodeAt(i);
  }
  return 'acc_' + (hash >>> 0).toString(36);
}

module.exports = router;
