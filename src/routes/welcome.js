/**
 * 首页欢迎宣传位配置下发（1.5.52 新增）
 *
 * GET /api/welcome/config → { ok, enabled, version, imageUrl, title, subtitle, smallLine, primaryText, secondaryText }
 * 数据源：src/data/welcome-config.json（用户 2026-11-20 拍板：图片与全部文案可配、免发版生效；
 * 改配置＝改此文件并随服务部署，文件按 mtime 热加载，更新文件后无需改代码）。
 * 图片静态托管：public/welcome/<文件名>，经 /welcome 前缀对外（见 index.js 静态挂载）。
 * 小程序端有本地打包兜底（图＋默认文案），接口不可用时弹窗照常用兜底内容。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const DATA_FILE = path.join(__dirname, '..', 'data', 'welcome-config.json');

let cache = null; // { mtimeMs, raw }

function loadConfig() {
  try {
    const st = fs.statSync(DATA_FILE);
    if (!cache || cache.mtimeMs !== st.mtimeMs) {
      cache = { mtimeMs: st.mtimeMs, raw: JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
    }
    return cache.raw;
  } catch (e) {
    return null;
  }
}

router.get('/config', (req, res) => {
  const cfg = loadConfig();
  if (!cfg) {
    return res.status(500).json({ ok: false, code: 'WELCOME_CONFIG_MISSING', msg: '欢迎位配置缺失' });
  }
  res.json({
    ok: true,
    enabled: cfg.enabled !== false,
    version: Number(cfg.version) || 0,
    imageUrl: String(cfg.imageUrl || ''),
    title: String(cfg.title || ''),
    subtitle: String(cfg.subtitle || ''),
    smallLine: String(cfg.smallLine || ''),
    primaryText: String(cfg.primaryText || ''),
    secondaryText: String(cfg.secondaryText || '')
  });
});

module.exports = router;
