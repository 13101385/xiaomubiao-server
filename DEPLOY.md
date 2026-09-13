# 小目标星球后端部署指南

## 1. 准备工作

### 获取微信小程序 AppSecret
1. 登录 [微信公众平台](https://mp.weixin.qq.com/)
2. 进入「开发」→「开发管理」→「开发设置」
3. 复制「AppSecret」

### 申请阿里云 SMS（可选）
1. 登录 [阿里云控制台](https://www.aliyun.com/)
2. 搜索「短信服务」→ 开通
3. 创建签名和模板
4. 获取 AccessKey（RAM 控制台中创建）

## 2. 部署到 Railway

### 方法一：GitHub 自动部署（推荐）
```bash
# 1. 将代码推送到 GitHub
cd /Users/aizaifeishiji/Documents/ai/xiaomubiao-server
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/yourname/xiaomubiao-server.git
git push -u origin main

# 2. 在 Railway 部署
# 访问 https://railway.app/
# 点击「New Project」→「Deploy from GitHub repo」
# 选择 xiaomubiao-server 仓库
```

### 方法二：本地部署
```bash
# 安装 Railway CLI
npm install -g @railway/cli

# 登录并部署
railway login
cd /Users/aizaifeishiji/Documents/ai/xiaomubiao-server
railway init
railway up -e .env.production
```

## 3. 配置环境变量

在 Railway 控制台中添加以下变量：

| 变量名 | 值 | 必需 |
|--------|-----|------|
| `WX_APPID` | `wxc429c56b256445f7` | ✅ |
| `WX_APPSECRET` | 你的 AppSecret | ✅ |
| `ALIYUN_ACCESS_KEY_ID` | 阿里云 AK | 可选 |
| `ALIYUN_ACCESS_KEY_SECRET` | 阿里云 SK | 可选 |
| `ALIYUN_SMS_SIGN_NAME` | 小目标星球 | 可选 |
| `ALIYUN_SMS_TEMPLATE_CODE` | 短信模板ID | 可选 |

## 4. 更新小程序配置

部署后，修改 `utils/auth.js` 中的 `API_BASE`：
```javascript
const API_BASE = 'https://your-railway-app.up.railway.app';
```

## 5. 验证部署

```bash
# 测试健康检查
curl https://your-railway-app.up.railway.app/health

# 测试微信登录
curl -X POST https://your-railway-app.up.railway.app/api/auth/wechat-login \
  -H "Content-Type: application/json" \
  -d '{"code": "testcode"}'
```

