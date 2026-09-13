/**
 * 更新前端小程序的 API 地址配置
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = '/Users/aizaifeishiji/Documents/ai/xiaomubiao';
const UTILS_DIR = path.join(PROJECT_ROOT, 'utils');

// API 基础地址
const API_BASE = process.env.API_BASE || 'http://localhost:3000';

console.log(`[CONFIG] Setting API base to: ${API_BASE}`);

// 更新 engine.js 中的 API 地址
const enginePath = path.join(UTILS_DIR, 'engine.js');
let engineContent = fs.readFileSync(enginePath, 'utf8');

// 替换 API_BASE_URL
engineContent = engineContent.replace(
  /const\s+API_BASE_URL\s*=\s*['"][^'"]+['"]/g,
  `const API_BASE_URL = '${API_BASE}'`
);

fs.writeFileSync(enginePath, engineContent);
console.log('[CONFIG] Updated engine.js');

// 提示用户
console.log('\n[INFO] Please update the following files with API_BASE:', API_BASE);
console.log('  - utils/engine.js');
console.log('  - utils/store.js (if it has API calls)');
console.log('\n[INFO] Or set API_BASE environment variable before starting the server.');
