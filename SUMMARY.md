# 小目标星球后端服务

## 功能清单

| 接口 | 方法 | 路径 | 说明 |
|------|------|------|------|
| 健康检查 | GET | `/health` | 服务状态 |
| 微信登录 | POST | `/api/auth/wechat-login` | code → openId |
| 发送验证码 | POST | `/api/auth/send-sms` | 发送短信验证码 |
| 手机号登录 | POST | `/api/auth/phone-login` | 手机+验证码登录 |
| 家长注册 | POST | `/api/auth/parent-setup` | 首次注册家长信息 |
| 检查注册 | GET | `/api/auth/check-parent` | 查询家长是否已注册 |

## 技术栈

- **运行时**: Node.js 18+
- **框架**: Express.js
- **数据库**: SQLite (轻量级，无需额外服务)
- **短信**: 阿里云 SMS (可选，默认模拟模式)

## 目录结构

```
xiaomubiao-server/
├── src/
│   ├── index.js       # 入口
│   ├── config.js      # 配置
│   ├── db.js          # 数据库
│   └── routes/
│       └── auth.js    # 认证路由
├── data/              # SQLite 数据文件
├── .env               # 环境变量
├── package.json
└── DEPLOY.md          # 部署指南
```

## 本地运行

```bash
cd /Users/aizaifeishiji/Documents/ai/xiaomubiao-server
npm install
npm start
```

## 部署到 Railway

1. 推送代码到 GitHub
2. 访问 https://railway.app/
3. 点击「New Project」→「Deploy from GitHub repo」
4. 配置环境变量（WX_APPID, WX_APPSECRET 必需）
5. 获取部署域名，更新小程序的 `API_BASE`

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `WX_APPID` | ✅ | 微信小程序 AppID |
| `WX_APPSECRET` | ✅ | 微信小程序 AppSecret |
| `ALIYUN_ACCESS_KEY_ID` | ❌ | 阿里云 AccessKey ID |
| `ALIYUN_ACCESS_KEY_SECRET` | ❌ | 阿里云 AccessKey Secret |
| `ALIYUN_SMS_SIGN_NAME` | ❌ | 短信签名 |
| `ALIYUN_SMS_TEMPLATE_CODE` | ❌ | 短信模板ID |

> 不配置短信服务时，验证码打印到控制台（模拟模式）
