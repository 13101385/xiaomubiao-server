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
const chatRoutes = require('./routes/chat');
const reminderRoutes = require('./routes/reminder'); const feedbackRoutes = require('./routes/feedback');
const homeworkRoutes = require('./routes/homework');
const weekendRoutes = require('./routes/weekend');
const adminRoutes = require('./routes/admin');
const { startReminderScheduler } = require('./reminder-scheduler');

const app = express();
const PORT = config.port;

// 中间件（必须在路由之前）
// crossOriginResourcePolicy 放开：小程序开发者工具的图片渲染器会遵循 CORP，
// same-origin 会导致 <image> 远程图空白（预览大图走原生生涯不受影响）
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));

/**
 * POST /api/poster/upload-composed
 * 上传合成海报：base64 存入数据库（持久卷），重启不丢
 * ext 可选 png/jpg（默认按 base64 魔数自动识别）
 */
app.post('/api/poster/upload-composed', (req, res) => {
  const { posterId, accountId, imageBase64 } = req.body;
  if (!posterId || !accountId || !imageBase64) {
    return res.status(400).json({ ok: false, msg: '缺少参数' });
  }
  const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  // 依据魔数识别类型：JPEG(FFD8) / PNG(89 50)
  let ext = String(req.body.ext || '').toLowerCase();
  if (ext !== 'jpg' && ext !== 'png') {
    const head = Buffer.from(base64Data.slice(0, 8), 'base64');
    ext = (head[0] === 0xFF && head[1] === 0xD8) ? 'jpg' : 'png';
  }
  const key = 'composed/' + posterId + '.' + ext;
  const url = '/api/poster/composed/' + posterId + '.' + ext;

  db.putBlob(key, base64Data)
    .then(() => db.updatePoster(posterId, accountId, { composedUrl: url }))
    .then(success => {
      if (success) res.json({ ok: true, composedUrl: url });
      else res.status(500).json({ ok: false, msg: '数据库更新失败（海报不存在?）' });
    })
    .catch(err => {
      console.error('[UPLOAD] 存储失败:', err.message);
      res.status(500).json({ ok: false, msg: err.message });
    });
});


// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/exam', examRoutes);
app.use('/api/poster', posterRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/reminder', reminderRoutes);
app.use('/api/homework', homeworkRoutes);
app.use('/api/weekend', weekendRoutes);
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin'))); app.use('/api/admin', adminRoutes); app.use('/api', feedbackRoutes);
// 睡前故事音频静态托管：story-audio/<故事id>.mp3（AI 合成语音，文件带 ID3 标识）
app.use('/story-audio', express.static(path.join(__dirname, '..', 'story-audio'), { maxAge: '7d', immutable: true }));

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

    startReminderScheduler();

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
