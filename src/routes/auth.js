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
    
    res.json({
      ok: true,
      user: {
        accountId,
        openId: openid,
        loginType: 'wechat',
        name: parent ? parent.parent_name : '',
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
 * 微信手机号快速验证：用 getPhoneNumber 返回的 code 换取真实手机号
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
    
    // 2. 用 code 换取手机号
    const phoneRes = await axios.post(
      'https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=' + accessToken,
      { code },
      { timeout: 10000 }
    );
    
    const data = phoneRes.data;
    
    if (data.errcode) {
      console.error('[WX] get phone error:', data);
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
    
    res.json({
      ok: true,
      user: {
        accountId,
        phone,
        openId: '',
        loginType: 'phone',
        name: parent ? parent.parent_name : '',
        isNew
      }
    });
  } catch (err) {
    console.error('[PHONE] Verify error:', err.message);
    res.status(500).json({ ok: false, msg: '手机号登录失败，请稍后重试' });
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
