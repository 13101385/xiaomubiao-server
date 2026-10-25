/**
 * 主入口
 */
const path = require('path');

// 手动加载 .env 文件（不依赖 dotenv 包）
const fs = require('fs');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    line = line.trim();
    if (line && !line.startsWith('#')) {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        process.env[key.trim()] = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
      }
    }
  });
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { config } = require('./config');
const db = require('./db');
const authRoutes = require('./routes/auth');
const examRoutes = require('./routes/exam');
const posterRoutes = require('./routes/poster');

const app = express();
const PORT = config.port;

// 中间件（必须在路由之前）
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 静态文件服务：预合成海报
const staticPath = path.join(__dirname, '..', 'public', 'composed');
if (!fs.existsSync(staticPath)) {
  fs.mkdirSync(staticPath, { recursive: true });
}
app.use('/composed', express.static(staticPath));

/**
 * POST /api/poster/upload-composed
 * 上传合成海报，保存到 public/composed/ 并更新数据库
 */
app.post('/api/poster/upload-composed', express.json({ limit: '50mb' }), (req, res) => {
  const { posterId, accountId, imageBase64 } = req.body;
  if (!posterId || !accountId || !imageBase64) {
    return res.status(400).json({ ok: false, msg: '缺少参数' });
  }
  try {
    // 解析 base64
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // 保存到本地
    const filename = posterId + '.png';
    const filepath = path.join(staticPath, filename);
    fs.writeFileSync(filepath, buffer);

    // 更新数据库
    db.updatePoster(posterId, accountId, { composedUrl: '/composed/' + filename })
      .then(() => res.json({ ok: true, composedUrl: '/composed/' + filename }))
      .catch(err => res.status(500).json({ ok: false, msg: err.message }));
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});


// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/exam', examRoutes);
app.use('/api/poster', posterRoutes);

// 错误处理
app.use((err, req, res, next) => {
  // body 解析失败（非法/截断 JSON）返回 400 而非 500
  if (err.type === 'entity.parse.failed' || err.status === 400) {
    return res.status(400).json({ ok: false, msg: '请求体格式错误（非法 JSON）' });
  }
  console.error('[ERROR]', err.stack);
  res.status(500).json({ ok: false, msg: '服务器内部错误' });
});

// 启动服务
async function start() {
  try {
    await db.init();

    app.listen(PORT, () => {
      console.log(`[SERVER] Running on http://localhost:${PORT}`);
      console.log(`[SERVER] Health: http://localhost:${PORT}/health`);
      console.log(`[SERVER] API: http://localhost:${PORT}/api/auth`);
      console.log(`[SERVER] WX_APPID: ${config.wx.appid || '(not set)'}`);
    });
  } catch (err) {
    console.error('[FATAL] Failed to start:', err.message);
    process.exit(1);
  }
}

start();
