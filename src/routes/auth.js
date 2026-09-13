/**
 * 认证路由
 * 提供：微信登录、短信验证码、用户管理
 */
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();
const { config } = require('../config');
const db = require('../db');

// 临时验证码存储（内存，生产环境用 Redis）
const TEMP_CODES = {};

/**
 * POST /api/auth/wechat-login
 * 微信登录：用 code 换取 openId
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
      }
    });
    
    const { openid, unionid, errcode, errmsg } = wxRes.data;
    
    if (errcode) {
      console.error('[WX] code2session error:', wxRes.data);
      return res.status(400).json({ ok: false, msg: '微信登录失败：' + errmsg });
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
    
    // 如果微信接口调用失败（如未配置 AppSecret），使用模拟模式
    if (!config.wx.appsecret || config.wx.appsecret === 'your_appsecret_here') {
      console.log('[WX] Using MOCK mode (no AppSecret configured)');
      const mockOpenId = 'wx_mock_' + crypto.createHash('md5').update(code).digest('hex').slice(0, 16);
      const accountId = generateAccountId('wechat', mockOpenId);
      
      return res.json({
        ok: true,
        user: {
          accountId,
          openId: mockOpenId,
          loginType: 'wechat',
          name: '',
          isNew: true,
          mock: true
        }
      });
    }
    
    res.status(500).json({ ok: false, msg: '服务器错误' });
  }
});

/**
 * POST /api/auth/send-sms
 * 发送短信验证码
 */
router.post('/send-sms', async (req, res) => {
  const { phone } = req.body;
  
  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ ok: false, msg: '请输入正确的手机号' });
  }
  
  // 生成6位验证码
  const code = String(Math.floor(100000 + Math.random() * 900000));
  
  // 存入内存
  TEMP_CODES[phone] = {
    code,
    expiresAt: Date.now() + 5 * 60 * 1000
  };
  
  // 尝试发送真实短信
  try {
    if (config.sms.accessKeyId && config.sms.accessKeyId !== 'your_access_key_id') {
      await sendAliyunSms(phone, code);
      console.log(`[SMS] Sent real SMS to ${phone}: ${code}`);
    } else {
      console.log(`[SMS Mock] 验证码: ${code} → ${phone}`);
    }
  } catch (err) {
    console.error('[SMS] Send error:', err.message);
  }
  
  // 测试模式下返回验证码（生产环境不要这样做！）
  res.json({ 
    ok: true, 
    msg: '验证码已发送',
    _test_code: config.sms.accessKeyId === 'your_access_key_id' ? code : undefined
  });
});

/**
 * POST /api/auth/phone-login
 * 手机号登录
 */
router.post('/phone-login', async (req, res) => {
  const { phone, code } = req.body;
  
  if (!phone || !code) {
    return res.status(400).json({ ok: false, msg: '缺少参数' });
  }
  
  // 验证验证码
  const stored = TEMP_CODES[phone];
  if (!stored || stored.code !== code || Date.now() > stored.expiresAt) {
    return res.status(400).json({ ok: false, msg: '验证码错误' });
  }
  
  // 删除已使用的验证码
  delete TEMP_CODES[phone];
  
  try {
    const accountId = generateAccountId('phone', phone);
    const parent = await db.getParentRecord(accountId);
    const isNew = !parent || !parent.has_registered;
    
    res.json({
      ok: true,
      user: {
        accountId,
        phone,
        loginType: 'phone',
        name: parent ? parent.parent_name : '',
        isNew
      }
    });
  } catch (err) {
    console.error('[PHONE] Login error:', err.message);
    res.status(500).json({ ok: false, msg: '服务器错误' });
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

/**
 * 调用阿里云 SMS
 */
async function sendAliyunSms(phone, code) {
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomBytes(8).toString('hex');
  
  // 阿里云 SMS API v2.0 签名
  const params = {
    PhoneNumbers: phone,
    SignName: config.sms.signName,
    TemplateCode: config.sms.templateCode,
    TemplateParam: JSON.stringify({ code }),
    RegionId: 'cn-hangzhou',
    OutId: `${phone}_${Date.now()}`,
    'Action': 'SendSms',
    'Version': '2017-05-25',
    'AccessKeyId': config.sms.accessKeyId,
    'Timestamp': timestamp,
    'SignatureVersion': '1.0',
    'SignatureNonce': nonce,
    'Format': 'JSON'
  };
  
  // 按参数名排序
  const sortedParams = Object.keys(params).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  
  // 计算签名
  const stringToSign = `GET&%2F&${encodeURIComponent(sortedParams)}`;
  const sign = crypto.createHmac('sha256', `${config.sms.accessKeySecret}&`).update(stringToSign).digest('base64');
  
  // 发送请求
  await axios.get('https://dysmsapi.aliyuncs.com/', {
    params: { ...params, Signature: sign }
  });
}

module.exports = router;
