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

const app = express();
const PORT = config.port;

// 中间件
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/exam', examRoutes);

// 错误处理
app.use((err, req, res, next) => {
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
