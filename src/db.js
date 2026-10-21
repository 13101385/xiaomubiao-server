/**
 * 数据库模块 - SQLite
 * 存储用户账号信息
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { config } = require('./config');

let db = null;

async function init() {
  const dir = path.dirname(config.db.path);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(config.db.path, (err) => {
      if (err) return reject(err);
      console.log('[DB] Connected to SQLite:', config.db.path);
      createTables().then(resolve).catch(reject);
    });
  });
}

function createTables() {
  const tables = [
    'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, open_id TEXT UNIQUE, phone TEXT UNIQUE, login_type TEXT NOT NULL, name TEXT DEFAULT \'\', pin_hash TEXT DEFAULT \'\', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS parent_records (account_id TEXT PRIMARY KEY, parent_name TEXT NOT NULL, pin_hash TEXT NOT NULL, has_registered INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS sms_codes (phone TEXT NOT NULL, code TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER DEFAULT 0, created_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS exams (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, open_id TEXT DEFAULT \'\', subject TEXT NOT NULL, grade TEXT NOT NULL, title TEXT NOT NULL, config TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS posters (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, open_id TEXT DEFAULT \'\', theme TEXT NOT NULL, grade TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, config TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)'
  ];
  
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_users_open_id ON users(open_id)',
    'CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)',
    'CREATE INDEX IF NOT EXISTS idx_sms_codes_phone ON sms_codes(phone)',
    'CREATE INDEX IF NOT EXISTS idx_sms_codes_expires ON sms_codes(expires_at)',
    'CREATE INDEX IF NOT EXISTS idx_exams_account ON exams(account_id)',
    'CREATE INDEX IF NOT EXISTS idx_posters_account ON posters(account_id)'
  ];
  
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      let count = 0;
      const total = tables.length + indexes.length;
      const done = () => {
        count++;
        if (count === total) {
          console.log('[DB] Tables created/verified');
          resolve();
        }
      };
      
      tables.forEach(sql => db.run(sql, done));
      indexes.forEach(sql => db.run(sql, done));
    });
  });
}

function getUserByOpenId(openId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE open_id = ?', [openId], (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function getUserByPhone(phone) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE phone = ?', [phone], (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function upsertUser(openId, phone, loginType) {
  const id = generateUserId(openId, phone);
  const now = Date.now();
  
  return new Promise((resolve, reject) => {
    db.get('SELECT id FROM users WHERE id = ?', [id], async (err, row) => {
      if (err) return reject(err);
      
      if (row) {
        db.run('UPDATE users SET updated_at = ? WHERE id = ?', [now, id], (err) => {
          if (err) return reject(err);
          resolve({ id, openId, phone, loginType, updated_at: now });
        });
      } else {
        db.run(
          'INSERT INTO users (id, open_id, phone, login_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          [id, openId || null, phone || null, loginType, now, now],
          function(err) {
            if (err) return reject(err);
            resolve({ id, openId, phone, loginType, created_at: now });
          }
        );
      }
    });
  });
}

function updateUserName(userId, name) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE users SET name = ?, updated_at = ? WHERE id = ?', [name, Date.now(), userId], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function generateUserId(openId, phone) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256');
  hash.update(openId || phone || '');
  return 'u_' + hash.digest('hex').slice(0, 16);
}

function saveSmsCode(phone, code) {
  const now = Date.now();
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO sms_codes (phone, code, expires_at, created_at) VALUES (?, ?, ?, ?)',
      [phone, code, now + 5 * 60 * 1000, now],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

async function verifySmsCode(phone, code) {
  const record = await new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM sms_codes WHERE phone = ? AND code = ? AND used = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
      [phone, code, Date.now()],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
  
  if (!record) return { ok: false, msg: '验证码错误' };
  
  await new Promise((resolve, reject) => {
    db.run("UPDATE sms_codes SET used = 1 WHERE phone = ? AND code = ?", [phone, code], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  
  return { ok: true };
}

function getParentRecord(accountId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM parent_records WHERE account_id = ?', [accountId], (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function saveParentRecord(accountId, parentName, pinHash) {
  const now = Date.now();
  return new Promise((resolve, reject) => {
    db.get('SELECT account_id FROM parent_records WHERE account_id = ?', [accountId], async (err, row) => {
      if (err) return reject(err);
      
      if (row) {
        db.run(
          'UPDATE parent_records SET parent_name = ?, pin_hash = ?, has_registered = 1, updated_at = ? WHERE account_id = ?',
          [parentName, pinHash, now, accountId],
          (err) => {
            if (err) return reject(err);
            resolve({ accountId, parentName, hasRegistered: 1 });
          }
        );
      } else {
        db.run(
          'INSERT INTO parent_records (account_id, parent_name, pin_hash, has_registered, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
          [accountId, parentName, pinHash, now, now],
          (err) => {
            if (err) return reject(err);
            resolve({ accountId, parentName, hasRegistered: 1 });
          }
        );
      }
    });
  });
}

function isParentRegistered(accountId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT has_registered FROM parent_records WHERE account_id = ?',
      [accountId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.has_registered === 1 : false);
      }
    );
  });
}

/* ==================== 试卷（exams） ==================== */

function createExam(exam) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO exams (id, account_id, open_id, subject, grade, title, config, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [exam.id, exam.accountId, exam.openId || '', exam.subject, exam.grade, exam.title, exam.config, exam.content, exam.createdAt],
      (err) => {
        if (err) reject(err);
        else resolve(exam);
      }
    );
  });
}

function listExams(accountId) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT id, account_id, subject, grade, title, created_at FROM exams WHERE account_id = ? ORDER BY created_at DESC LIMIT 100',
      [accountId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

function getExam(examId, accountId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM exams WHERE id = ? AND account_id = ?',
      [examId, accountId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

function deleteExam(examId, accountId) {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM exams WHERE id = ? AND account_id = ?',
      [examId, accountId],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes > 0);
      }
    );
  });
}

function countExamsToday(accountId, startOfDay) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT COUNT(*) AS n FROM exams WHERE account_id = ? AND created_at >= ?',
      [accountId, startOfDay],
      (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.n : 0);
      }
    );
  });
}

/* ==================== 手抄报（posters） ==================== */

function createPoster(poster) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO posters (id, account_id, open_id, theme, grade, title, source, config, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [poster.id, poster.accountId, poster.openId || '', poster.theme, poster.grade, poster.title, poster.source, poster.config, poster.content, poster.createdAt],
      (err) => {
        if (err) reject(err);
        else resolve(poster);
      }
    );
  });
}

function listPosters(accountId) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT id, account_id, theme, grade, title, source, created_at FROM posters WHERE account_id = ? ORDER BY created_at DESC LIMIT 100',
      [accountId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

function getPoster(posterId, accountId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM posters WHERE id = ? AND account_id = ?',
      [posterId, accountId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

function deletePoster(posterId, accountId) {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM posters WHERE id = ? AND account_id = ?',
      [posterId, accountId],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes > 0);
      }
    );
  });
}

/**
 * 统计某账号当日 AI 生成的手抄报数量（仅统计 source = 'ai'，本地模板保存不占限额）
 */
function countPostersToday(accountId, startOfDay) {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT COUNT(*) AS n FROM posters WHERE account_id = ? AND source = 'ai' AND created_at >= ?",
      [accountId, startOfDay],
      (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.n : 0);
      }
    );
  });
}

function close() {
  return new Promise((resolve, reject) => {
    if (db) {
      db.close((err) => {
        if (err) reject(err);
        else { db = null; resolve(); }
      });
    } else {
      resolve();
    }
  });
}

module.exports = {
  init, close,
  getUserByOpenId, getUserByPhone, upsertUser, updateUserName,
  saveSmsCode, verifySmsCode,
  getParentRecord, saveParentRecord, isParentRegistered,
  createExam, listExams, getExam, deleteExam, countExamsToday,
  createPoster, listPosters, getPoster, deletePoster, countPostersToday
};
