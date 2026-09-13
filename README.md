# 小目标星球 后端服务

微信 Mini Program 后端服务，提供：
- 微信登录（code → openId）
- 短信验证码发送
- 用户数据 API

## 环境变量

| 变量 | 说明 | 必需 |
|------|------|------|
| `PORT` | 服务端口 | 否（默认3000）|
| `WX_APPID` | 微信小程序 AppID | 是 |
| `WX_APPSECRET` | 微信小程序 AppSecret | 是 |
| `ALIYUN_ACCESS_KEY_ID` | 阿里云 AccessKey ID | 是 |
| `ALIYUN_ACCESS_KEY_SECRET` | 阿里云 AccessKey Secret | 是 |
| `ALIYUN_SMS_SIGN_NAME` | 短信签名 | 是 |
| `ALIYUN_SMS_TEMPLATE_CODE` | 短信模板ID | 是 |

## 部署

### Railway
```bash
railway init
railway up -e .env.production
```

### Docker
```bash
docker build -t xiaomubiao-server .
docker run -p 3000:3000 --env-file .env.production xiaomubiao-server
```
