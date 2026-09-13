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
  }
};

module.exports = { config };
