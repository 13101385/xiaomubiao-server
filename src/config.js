/**
 * 配置文件
 * 从环境变量读取配置，提供默认值
 */
const config = {
  port: process.env.PORT || 3000,
  
  // 微信小程序
  wx: {
    appid: process.env.WX_APPID || '',
    appsecret: process.env.WX_APPSECRET || ''
  },
  
  // 阿里云 SMS
  sms: {
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET || '',
    signName: process.env.ALIYUN_SMS_SIGN_NAME || '小目标星球',
    templateCode: process.env.ALIYUN_SMS_TEMPLATE_CODE || ''
  },
  
  // JWT 密钥
  jwtSecret: process.env.JWT_SECRET || 'xiaomubiao-dev-secret-change-in-production',
  jwtExpiresIn: '7d',
  
  // 数据库
  db: {
    path: process.env.DB_PATH || './data/xiaomubiao.db'
  },

  // agnes AI（试卷生成）
  agnes: {
    apiKey: process.env.AGNES_AI_API_KEY || '',
    baseURL: process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1',
    model: process.env.AGNES_MODEL || 'agnes-2.5-flash',
    timeoutMs: Number(process.env.AGNES_TIMEOUT_MS || 120000)
  }
};

module.exports = { config };
