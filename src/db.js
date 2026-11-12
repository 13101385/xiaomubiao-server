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
    'CREATE TABLE IF NOT EXISTS parent_records (account_id TEXT PRIMARY KEY, parent_name TEXT NOT NULL, pin_hash TEXT NOT NULL, has_registered INTEGER DEFAULT 0, avatar_key TEXT DEFAULT \'\', avatar_type TEXT DEFAULT \'\', avatar_updated_at INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS sms_codes (phone TEXT NOT NULL, code TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER DEFAULT 0, created_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS exams (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, open_id TEXT DEFAULT \'\', subject TEXT NOT NULL, grade TEXT NOT NULL, title TEXT NOT NULL, config TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS posters (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, open_id TEXT DEFAULT \'\', theme TEXT NOT NULL, grade TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, config TEXT NOT NULL, content TEXT NOT NULL, image_url TEXT DEFAULT \'\', composed_url TEXT DEFAULT \'\', created_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS poster_blobs (key TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)',
    // 订阅消息提醒：额度表（每账号每模板一行，quota 为微信一次性订阅的剩余可发送条数）
    'CREATE TABLE IF NOT EXISTS reminder_subs (account_id TEXT NOT NULL, template_id TEXT NOT NULL, open_id TEXT DEFAULT \'\', quota INTEGER DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(account_id, template_id))',
    // 订阅消息提醒：窄同步的任务镜像（仅提醒所需字段：孩子名/任务名/日期/起止时间/状态）
    'CREATE TABLE IF NOT EXISTS reminder_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, task_key TEXT NOT NULL, child_name TEXT DEFAULT \'\', task_name TEXT DEFAULT \'\', date TEXT NOT NULL, start_time TEXT DEFAULT \'\', end_time TEXT DEFAULT \'\', status TEXT DEFAULT \'\', reminded_start INTEGER DEFAULT 0, updated_at INTEGER NOT NULL, UNIQUE(account_id, date, task_key))',
    // 订阅消息提醒：发送流水（防重复：如未完成提醒每账号每天最多一条）
    'CREATE TABLE IF NOT EXISTS reminder_sent_log (account_id TEXT NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY(account_id, kind, day))'
  ];
  
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_users_open_id ON users(open_id)',
    'CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)',
    'CREATE INDEX IF NOT EXISTS idx_sms_codes_phone ON sms_codes(phone)',
    'CREATE INDEX IF NOT EXISTS idx_sms_codes_expires ON sms_codes(expires_at)',
    'CREATE INDEX IF NOT EXISTS idx_exams_account ON exams(account_id)',
    'CREATE INDEX IF NOT EXISTS idx_posters_account ON posters(account_id)',
    'CREATE INDEX IF NOT EXISTS idx_reminder_tasks_scan ON reminder_tasks(date, status, reminded_start)',
    'CREATE INDEX IF NOT EXISTS idx_reminder_tasks_account ON reminder_tasks(account_id, date)'
  ];
  
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      let count = 0;
      // +5：五条幂等加列 ALTER TABLE（posters 两列 + parent_records 头像三列）
      const total = tables.length + indexes.length + 5;
      const done = () => {
        count++;
        if (count === total) {
          console.log('[DB] Tables created/verified');
          resolve();
        }
      };
      
      tables.forEach(sql => db.run(sql, done));
      indexes.forEach(sql => db.run(sql, done));
      // 幂等加列：posters 表可能已存在（CREATE TABLE IF NOT EXISTS 不会补列），
      // 列已存在时 ALTER TABLE 会报错，直接忽略即可
      db.run("ALTER TABLE posters ADD COLUMN image_url TEXT DEFAULT ''", (err) => {
        if (err) {
          console.warn('[DB] posters 加 image_url 列失败（列可能已存在，忽略）:', err.message);
        }
        done();
      });
      db.run("ALTER TABLE posters ADD COLUMN composed_url TEXT DEFAULT ''", (err) => {
        if (err) {
          console.warn('[DB] posters 加 composed_url 列失败（列可能已存在，忽略）:', err.message);
        }
        done();
      });
      // 幂等加列：parent_records 头像字段（老库兼容，列已存在时忽略报错）
      db.run("ALTER TABLE parent_records ADD COLUMN avatar_key TEXT DEFAULT ''", (err) => {
        if (err) {
          console.warn('[DB] parent_records 加 avatar_key 列失败（列可能已存在，忽略）:', err.message);
        }
        done();
      });
      db.run("ALTER TABLE parent_records ADD COLUMN avatar_type TEXT DEFAULT ''", (err) => {
        if (err) {
          console.warn('[DB] parent_records 加 avatar_type 列失败（列可能已存在，忽略）:', err.message);
        }
        done();
      });
      db.run("ALTER TABLE parent_records ADD COLUMN avatar_updated_at INTEGER DEFAULT 0", (err) => {
        if (err) {
          console.warn('[DB] parent_records 加 avatar_updated_at 列失败（列可能已存在，忽略）:', err.message);
        }
        done();
      });
      // 一次性迁移：旧的 /composed/ 静态路径存放在容器临时层，重启即丢。
      // 成品图已改存数据库（poster_blobs），清空死指针以便重新生成。
      db.run("UPDATE posters SET composed_url = '' WHERE composed_url LIKE '/composed/%'", (err) => {
        if (err) console.warn('[DB] 清理失效 composed_url 失败:', err.message);
        else console.log('[DB] 已清理指向临时层的失效 composed_url');
      });
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

/**
 * 家长资料同步（头像/昵称）：按 accountId upsert，不触碰 pin_hash / has_registered
 * 行不存在则插入（pin_hash 置空字符串、has_registered 保持 0），注册逻辑仍走 saveParentRecord
 * @param {string} accountId
 * @param {{name?: string, avatarKey?: string, avatarType?: string, avatarUpdatedAt?: number}} fields
 * @returns {Promise<object|null>} 更新后的 parent_records 行
 */
function upsertParentProfile(accountId, fields) {
  const now = Date.now();
  const name = fields && typeof fields.name === 'string' ? fields.name : undefined;
  const avatarKey = fields && typeof fields.avatarKey === 'string' ? fields.avatarKey : undefined;
  const avatarType = fields && typeof fields.avatarType === 'string' ? fields.avatarType : undefined;
  const avatarUpdatedAt = fields && fields.avatarUpdatedAt ? fields.avatarUpdatedAt : undefined;

  return new Promise((resolve, reject) => {
    db.get('SELECT account_id FROM parent_records WHERE account_id = ?', [accountId], (err, row) => {
      if (err) return reject(err);

      if (row) {
        const sets = [];
        const values = [];
        if (name !== undefined) { sets.push('parent_name = ?'); values.push(name); }
        if (avatarKey !== undefined) { sets.push('avatar_key = ?'); values.push(avatarKey); }
        if (avatarType !== undefined) { sets.push('avatar_type = ?'); values.push(avatarType); }
        if (avatarUpdatedAt !== undefined) { sets.push('avatar_updated_at = ?'); values.push(avatarUpdatedAt); }
        sets.push('updated_at = ?');
        values.push(now, accountId);
        db.run(
          'UPDATE parent_records SET ' + sets.join(', ') + ' WHERE account_id = ?',
          values,
          (err2) => {
            if (err2) return reject(err2);
            getParentRecord(accountId).then(resolve).catch(reject);
          }
        );
      } else {
        db.run(
          'INSERT INTO parent_records (account_id, parent_name, pin_hash, has_registered, avatar_key, avatar_type, avatar_updated_at, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)',
          [
            accountId,
            name !== undefined ? name : '',
            '',
            avatarKey !== undefined ? avatarKey : '',
            avatarType !== undefined ? avatarType : '',
            avatarUpdatedAt !== undefined ? avatarUpdatedAt : 0,
            now, now
          ],
          (err2) => {
            if (err2) return reject(err2);
            getParentRecord(accountId).then(resolve).catch(reject);
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
      'INSERT INTO posters (id, account_id, open_id, theme, grade, title, source, config, content, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [poster.id, poster.accountId, poster.openId || '', poster.theme, poster.grade, poster.title, poster.source, poster.config, poster.content, poster.imageUrl || '', poster.createdAt],
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
      'SELECT id, account_id, theme, grade, title, source, image_url, composed_url, created_at FROM posters WHERE account_id = ? ORDER BY created_at DESC LIMIT 300',
      [accountId],
      (err, rows) => {
        if (err) reject(err);
        else resolve((rows || []).map(r => ({ ...r, imageUrl: r.image_url || '', composedUrl: r.composed_url || '' })));
      }
    );
  });
}

/**
 * 公共模板成品库：不区分账号，优先返回已合成文字的成品，再按时间倒序
 */
function listLibraryPosters(theme, limit) {
  return new Promise((resolve, reject) => {
    const n = Math.max(1, Math.min(parseInt(limit, 10) || 12, 50));
    db.all(
      "SELECT id, theme, grade, title, source, image_url, composed_url, created_at FROM posters WHERE theme = ? AND source = 'image' AND image_url != '' ORDER BY (composed_url != '') DESC, created_at DESC LIMIT " + n,
      [theme],
      (err, rows) => {
        if (err) reject(err);
        else resolve((rows || []).map(r => ({ ...r, imageUrl: r.image_url || '', composedUrl: r.composed_url || '' })));
      }
    );
  });
}


/** 管理用：列出全部成品图（含 account_id），用于批量重合成 */
function allPostersForAdmin() {
  return new Promise((resolve, reject) => {
    db.all(
      "SELECT id, theme, title, source, image_url, composed_url, account_id FROM posters ORDER BY created_at DESC",
      (err, rows) => {
        if (err) reject(err);
        else resolve((rows || []).map(r => ({
          id: r.id, theme: r.theme, title: r.title, source: r.source,
          imageUrl: r.image_url || '', composedUrl: r.composed_url || '',
          accountId: r.account_id || ''
        })));
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
        else resolve(row ? { ...row, imageUrl: row.image_url || '', composedUrl: row.composed_url || '' } : null);
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

/**
 * 成品图二进制存储（base64），存放在持久卷上的 SQLite 中，
 * 不依赖容器临时文件系统（重启不丢）
 */
function putBlob(key, data) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO poster_blobs (key, data, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, created_at = excluded.created_at',
      [key, data, Date.now()],
      (err) => (err ? reject(err) : resolve(true))
    );
  });
}

function getBlob(key) {
  return new Promise((resolve, reject) => {
    db.get('SELECT data FROM poster_blobs WHERE key = ?', [key], (err, row) => {
      if (err) reject(err);
      else resolve(row ? row.data : null);
    });
  });
}

/**
 * 更新海报的 composed_url（文字合成后的成品图）
 */
function updatePoster(posterId, accountId, data) {
  return new Promise((resolve, reject) => {
    const fields = [];
    const values = [];
    if (data.composedUrl !== undefined) { fields.push('composed_url = ?'); values.push(data.composedUrl || ''); }
    if (fields.length === 0) return resolve(false);
    values.push(posterId, accountId);
    db.run(
      'UPDATE posters SET ' + fields.join(', ') + ' WHERE id = ? AND account_id = ?',
      values,
      function(err) {
        if (err) reject(err);
        else resolve(this.changes > 0);
      }
    );
  });
}

function countImagesToday(accountId, startOfDay) {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT COUNT(*) AS n FROM posters WHERE account_id = ? AND source = 'image' AND created_at >= ?",
      [accountId, startOfDay],
      (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.n : 0);
      }
    );
  });
}

/* ==================== 订阅消息提醒（reminder） ==================== */

/**
 * 登记一次订阅额度（+1）；openId 非空时同步更新该账号所有模板行的 open_id
 */
function addReminderQuota(accountId, templateId, openId) {
  const now = Date.now();
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO reminder_subs (account_id, template_id, open_id, quota, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(account_id, template_id) DO UPDATE SET
         quota = quota + 1,
         open_id = CASE WHEN excluded.open_id != '' THEN excluded.open_id ELSE open_id END,
         updated_at = excluded.updated_at`,
      [accountId, templateId, openId || '', now],
      (err) => {
        if (err) return reject(err);
        if (openId) {
          db.run('UPDATE reminder_subs SET open_id = ? WHERE account_id = ?', [openId, accountId], () => {});
        }
        getReminderSub(accountId, templateId).then(resolve).catch(reject);
      }
    );
  });
}

/**
 * 记录账号 open_id（同步任务时带 code 换得）：为已知模板建占位行（quota 0），并刷新 open_id
 */
function touchReminderOpenid(accountId, openId, templateIds) {
  const now = Date.now();
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      (templateIds || []).forEach(tid => {
        db.run(
          `INSERT OR IGNORE INTO reminder_subs (account_id, template_id, open_id, quota, updated_at)
           VALUES (?, ?, ?, 0, ?)`,
          [accountId, tid, openId, now]
        );
      });
      db.run(
        'UPDATE reminder_subs SET open_id = ?, updated_at = ? WHERE account_id = ?',
        [openId, now, accountId],
        (err) => (err ? reject(err) : resolve(true))
      );
    });
  });
}

function getReminderSub(accountId, templateId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM reminder_subs WHERE account_id = ? AND template_id = ?',
      [accountId, templateId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

function listReminderSubs(accountId) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT * FROM reminder_subs WHERE account_id = ?',
      [accountId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

/** 原子扣减额度：quota>0 才扣，返回是否扣成功 */
function decReminderQuota(accountId, templateId) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE reminder_subs SET quota = quota - 1, updated_at = ? WHERE account_id = ? AND template_id = ? AND quota > 0',
      [Date.now(), accountId, templateId],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes > 0);
      }
    );
  });
}

/** 强制设置额度（如微信返回 43101 用户未订阅/额度不一致时归零对齐） */
function setReminderQuota(accountId, templateId, quota) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE reminder_subs SET quota = ?, updated_at = ? WHERE account_id = ? AND template_id = ?',
      [quota, Date.now(), accountId, templateId],
      (err) => (err ? reject(err) : resolve(true))
    );
  });
}

/**
 * 按账号+日期覆盖同步任务镜像；同 task_key 已发过开始提醒的，保留 reminded_start 防止重复推送
 * @param {Array<{taskKey, childName, taskName, startTime, endTime, status}>} tasks
 */
function replaceReminderDayTasks(accountId, date, tasks) {
  const now = Date.now();
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT task_key, reminded_start FROM reminder_tasks WHERE account_id = ? AND date = ?',
      [accountId, date],
      (err, rows) => {
        if (err) return reject(err);
        const reminded = {};
        (rows || []).forEach(r => { if (r.reminded_start) reminded[r.task_key] = 1; });
        db.serialize(() => {
          db.run('DELETE FROM reminder_tasks WHERE account_id = ? AND date = ?', [accountId, date]);
          const stmt = db.prepare(
            `INSERT INTO reminder_tasks
               (account_id, task_key, child_name, task_name, date, start_time, end_time, status, reminded_start, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          );
          (tasks || []).forEach(t => {
            stmt.run([
              accountId, String(t.taskKey || ''), String(t.childName || '').slice(0, 50),
              String(t.taskName || '').slice(0, 100), date,
              String(t.startTime || ''), String(t.endTime || ''), String(t.status || ''),
              reminded[String(t.taskKey || '')] ? 1 : 0, now
            ]);
          });
          stmt.finalize((e) => (e ? reject(e) : resolve(true)));
        });
      }
    );
  });
}

/** 开始提醒候选：某日未开始（todo）且未提醒过的任务 */
function listStartCandidates(date) {
  return new Promise((resolve, reject) => {
    db.all(
      "SELECT * FROM reminder_tasks WHERE date = ? AND status = 'todo' AND reminded_start = 0 AND start_time != '' ORDER BY start_time ASC",
      [date],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

function markTaskReminded(id) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE reminder_tasks SET reminded_start = 1, updated_at = ? WHERE id = ?',
      [Date.now(), id],
      (err) => (err ? reject(err) : resolve(true))
    );
  });
}

/**
 * 未完成提醒汇总：某日仍有未完成（todo/doing）任务的账号
 * 返回 [{ account_id, n, first_name, first_child }]，first 为开始时间最早的一条
 */
function listUnfinishedByAccount(date) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT account_id,
              COUNT(*) AS n,
              (SELECT task_name FROM reminder_tasks t2
                WHERE t2.account_id = t.account_id AND t2.date = t.date
                  AND t2.status IN ('todo', 'doing')
                ORDER BY t2.start_time ASC LIMIT 1) AS first_name,
              (SELECT child_name FROM reminder_tasks t3
                WHERE t3.account_id = t.account_id AND t3.date = t.date
                  AND t3.status IN ('todo', 'doing')
                ORDER BY t3.start_time ASC LIMIT 1) AS first_child
       FROM reminder_tasks t
       WHERE date = ? AND status IN ('todo', 'doing')
       GROUP BY account_id`,
      [date],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

function hasSentLog(accountId, kind, day) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT 1 AS x FROM reminder_sent_log WHERE account_id = ? AND kind = ? AND day = ?',
      [accountId, kind, day],
      (err, row) => {
        if (err) reject(err);
        else resolve(!!row);
      }
    );
  });
}

function addSentLog(accountId, kind, day) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO reminder_sent_log (account_id, kind, day, sent_at) VALUES (?, ?, ?, ?)',
      [accountId, kind, day, Date.now()],
      (err) => (err ? reject(err) : resolve(true))
    );
  });
}

/** 清理过期镜像与流水（保留近 7 天流水防重复即可） */
function cleanupReminderData(beforeDate, beforeDay) {
  return new Promise((resolve) => {
    db.run('DELETE FROM reminder_tasks WHERE date < ?', [beforeDate], () => {
      db.run('DELETE FROM reminder_sent_log WHERE day < ?', [beforeDay], () => resolve(true));
    });
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

/**
 * 注销账号：删除该账号的全部数据（家长记录/试卷/手抄报及成品图）
 */
function deleteAccountData(accountId) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.all('SELECT id FROM posters WHERE account_id = ?', [accountId], (err, rows) => {
        if (err) return reject(err);
        const ids = (rows || []).map(r => r.id);
        const keys = ['avatar:' + accountId];
        ids.forEach(id => { keys.push('composed/' + id + '.jpg', 'composed/' + id + '.png'); });
        const finish = (e) => (e ? reject(e) : resolve(true));
        db.run('DELETE FROM posters WHERE account_id = ?', [accountId]);
        db.run('DELETE FROM exams WHERE account_id = ?', [accountId]);
        db.run('DELETE FROM reminder_subs WHERE account_id = ?', [accountId]);
        db.run('DELETE FROM reminder_tasks WHERE account_id = ?', [accountId]);
        db.run('DELETE FROM reminder_sent_log WHERE account_id = ?', [accountId]);
        db.run('DELETE FROM parent_records WHERE account_id = ?', [accountId], (e2) => {
          if (e2) return finish(e2);
          if (!keys.length) return finish();
          const ph = keys.map(() => '?').join(',');
          db.run('DELETE FROM poster_blobs WHERE key IN (' + ph + ')', keys, finish);
        });
      });
    });
  });
}

module.exports = {
  init, close,
  getUserByOpenId, getUserByPhone, upsertUser, updateUserName,
  saveSmsCode, verifySmsCode,
  getParentRecord, saveParentRecord, upsertParentProfile, isParentRegistered,
  createExam, listExams, getExam, deleteExam, countExamsToday,
  createPoster, listPosters, listLibraryPosters, allPostersForAdmin, getPoster, deletePoster, updatePoster,
  putBlob, getBlob,
  deleteAccountData,
  countPostersToday, countImagesToday,
  addReminderQuota, touchReminderOpenid, getReminderSub, listReminderSubs,
  decReminderQuota, setReminderQuota,
  replaceReminderDayTasks, listStartCandidates, markTaskReminded, listUnfinishedByAccount,
  hasSentLog, addSentLog, cleanupReminderData
};
