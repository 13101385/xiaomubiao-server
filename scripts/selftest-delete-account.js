// 自测：deleteAccountData 部分失败不再静默报成功（P1-3 修复验证）
// 用法：DB_PATH=/tmp/delacct-test.db node scripts/selftest-delete-account.js
// 场景 A：全表有数据 → 全部删净、resolve(true)
// 场景 B：中间表缺失（模拟 DELETE 失败）→ 必须 reject，旧代码会 resolve(true)
const db = require('../src/db');

const ACC = 'delacct-test-acc';
const TABLES = [
  ['posters', "INSERT INTO posters (id, account_id, open_id, theme, grade, title, source, config, content, created_at) VALUES ('p1', ?, '', 't', 'g', 't', 'image', '{}', '{}', 1)"],
  ['exams', "INSERT INTO exams (id, account_id, open_id, subject, grade, title, config, content, created_at) VALUES ('e1', ?, '', 'math', 'g2', 't', '{}', '{}', 1)"],
  ['reminder_subs', "INSERT INTO reminder_subs (account_id, template_id, open_id, quota, updated_at) VALUES (?, 'tpl', '', 1, 1)"],
  ['reminder_tasks', "INSERT INTO reminder_tasks (account_id, task_key, date, updated_at) VALUES (?, 'k', '2026-11-26', 1)"],
  ['reminder_sent_log', "INSERT INTO reminder_sent_log (account_id, kind, day, sent_at) VALUES (?, 'k', '2026-11-26', 1)"],
  ['reminder_daily_hooks', "INSERT INTO reminder_daily_hooks (account_id, date, updated_at) VALUES (?, '2026-11-26', 1)"],
  ['analytics_events', "INSERT INTO analytics_events (account_id, event, server_ts) VALUES (?, 'ev', 1)"],
  ['family_data', "INSERT INTO family_data (account_id, payload, updated_at) VALUES (?, '{}', 1)"],
  ['parent_records', "INSERT INTO parent_records (account_id, parent_name, pin_hash, created_at, updated_at) VALUES (?, 'p', 'x', 1, 1)"],
  ['poster_blobs', "INSERT INTO poster_blobs (key, data, created_at) VALUES ('avatar:delacct-test-acc', 'x', 1)"],
];

async function count(table, acc) {
  const rows = await db.allSql('SELECT COUNT(*) c FROM ' + table + ' WHERE ' + (table === 'poster_blobs' ? "key = 'avatar:" + acc + "'" : 'account_id = ?'),
    table === 'poster_blobs' ? [] : [acc]);
  return rows[0].c;
}

(async () => {
  await db.init();
  let pass = 0, fail = 0;
  const check = (name, ok) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name); ok ? pass++ : fail++; };

  for (const [t, sql] of TABLES) await db.runSql(sql, t === 'poster_blobs' ? [] : [ACC]);
  const before = await count('family_data', ACC);
  check('A 种子数据已写入', before === 1);
  const r = await db.deleteAccountData(ACC);
  check('A 成功删除 resolve(true)', r === true);
  let allGone = true;
  for (const [t] of TABLES) { if (await count(t, ACC) !== 0) { allGone = false; console.log('  残留：' + t); } }
  check('A 十表全部清零', allGone);

  for (const [t, sql] of TABLES) await db.runSql(sql, t === 'poster_blobs' ? [] : [ACC]);
  await db.runSql('DROP TABLE exams');
  let rejected = false;
  try { await db.deleteAccountData(ACC); } catch (e) { rejected = true; console.log('  reject 原因：' + e.message); }
  check('B 中间表失败时 reject（不静默成功）', rejected);
  await db.runSql("CREATE TABLE exams (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, open_id TEXT DEFAULT '', subject TEXT NOT NULL, grade TEXT NOT NULL, title TEXT NOT NULL, config TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready', fail_reason TEXT DEFAULT '', created_at INTEGER NOT NULL)");
  try { await db.deleteAccountData(ACC); } catch (e) {}
  console.log('---');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('自测异常', e); process.exit(1); });
