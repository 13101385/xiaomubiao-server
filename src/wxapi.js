/**
 * 微信小程序服务端 API 助手
 * - access_token 进程内缓存（提前 5 分钟刷新），供手机号/订阅消息等接口共用
 * - code2session：wx.login code 换 openid
 * - subscribeMessage.send：发送订阅消息
 */
const axios = require('axios');
const { config } = require('./config');

let tokenCache = { token: '', expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 5 * 60 * 1000) {
    return tokenCache.token;
  }
  const res = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
    params: {
      grant_type: 'client_credential',
      appid: config.wx.appid,
      secret: config.wx.appsecret
    },
    timeout: 10000
  });
  const data = res.data || {};
  if (!data.access_token) {
    throw new Error('获取 access_token 失败: ' + (data.errmsg || data.errcode || 'unknown'));
  }
  tokenCache = {
    token: data.access_token,
    expiresAt: now + (Number(data.expires_in) || 7200) * 1000
  };
  return tokenCache.token;
}

/** 用 wx.login 的 code 换 openid；失败抛错（errcode 附在 message 中） */
async function code2session(code) {
  const res = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
    params: {
      appid: config.wx.appid,
      secret: config.wx.appsecret,
      js_code: code,
      grant_type: 'authorization_code'
    },
    timeout: 10000
  });
  const data = res.data || {};
  if (data.errcode) {
    throw new Error('code2session 失败: ' + data.errcode + ' ' + (data.errmsg || ''));
  }
  if (!data.openid) throw new Error('code2session 未返回 openid');
  return data.openid;
}

/**
 * 发送订阅消息，返回微信原始响应 { errcode, errmsg, msgid }
 * @param {{openid: string, templateId: string, data: object, page?: string}} opts
 * data 的键名按模板关键词位置编号（如 thing1/time2/thing3），值格式 { value }
 */
async function sendSubscribeMessage(opts) {
  const token = await getAccessToken();
  const body = {
    touser: opts.openid,
    template_id: opts.templateId,
    page: opts.page || 'pages/index/index',
    miniprogram_state: process.env.REMINDER_MP_STATE || 'formal',
    lang: 'zh_CN',
    data: opts.data
  };
  const res = await axios.post(
    'https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + token,
    body,
    { timeout: 10000 }
  );
  return res.data || {};
}

module.exports = { getAccessToken, code2session, sendSubscribeMessage };
