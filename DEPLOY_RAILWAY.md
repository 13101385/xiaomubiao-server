# ============================================
# 小目标星球后端 - Railway 部署指南（一步步）
# ============================================

## 第 1 步：注册 GitHub（如已注册可跳过）
1. 打开 https://github.com/
2. 点 "Sign up" 注册（免费）
3. 记住你的 GitHub 用户名和密码

## 第 2 步：注册 Railway（用 GitHub 登录）
1. 打开 https://railway.app/
2. 点右上角 "Start a New Project" 或 "Login"
3. 选 "Continue with GitHub"，授权登录
4. 首次登录有 $5 免费额度（约 500 小时/月）

## 第 3 步：把后端代码推到 GitHub
在你的电脑上执行（我已经初始化好 git 了）：
```bash
cd /Users/aizaifeishiji/Documents/ai/xiaomubiao-server
git add -A
git commit -m "小目标星球后端服务"
git branch -M main
git remote add origin https://github.com/你的用户名/xiaomubiao-server.git
git push -u origin main
```
（第一次推送会让你输入 GitHub 用户名和密码/Token）

## 第 4 步：在 Railway 部署
1. 打开 https://railway.app/
2. 点 "New Project" → "Deploy from GitHub repo"
3. 选择 xiaomubiao-server 仓库
4. Railway 会自动识别 Node.js 项目并部署
5. 部署完成后，点服务 → Settings → Networking → 添加 Domain
   （会生成 https://xxx.up.railway.app 公网地址）

## 第 5 步：配置环境变量
在 Railway 服务 → Variables 里添加：

| 变量名 | 值 |
|--------|-----|
| `WX_APPID` | `wxc429c56b256445f7` |
| `WX_APPSECRET` | `c63abdf9c0f88097218e0e1120ca3f59` |
| `DB_PATH` | `/app/data/xiaomubiao.db` |
| `ALIYUN_ACCESS_KEY_ID` | （阿里云短信，可选） |
| `ALIYUN_ACCESS_KEY_SECRET` | （可选） |
| `ALIYUN_SMS_SIGN_NAME` | 小目标星球 |
| `ALIYUN_SMS_TEMPLATE_CODE` | （可选） |

## 第 6 步：添加数据持久化 Volume（重要！）
SQLite 数据文件要持久化，否则重启会丢失：
1. Railway 服务 → Volumes → 添加 Volume
2. 挂载路径填：`/app/data`
3. 重启服务

## 第 7 步：验证部署
浏览器打开 `https://你的域名.up.railway.app/health`
应该返回：`{"status":"ok",...}`

## 第 8 步：配置微信合法域名
1. 打开 https://mp.weixin.qq.com/
2. 开发管理 → 开发设置 → 服务器域名
3. 在 "request 合法域名" 添加：`https://你的域名.up.railway.app`
4. 保存

## 第 9 步：小程序指向生产环境
修改 `/Users/aizaifeishiji/Documents/ai/xiaomubiao/utils/auth.js`：
```javascript
const API_BASE = 'https://你的域名.up.railway.app';
```

## 第 10 步：发布小程序
微信开发者工具 → 上传 → 微信后台提交审核 → 发布
