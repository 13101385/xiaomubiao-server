/**
 * 订阅消息提醒路由
 * 任务数据只在用户手机本地，后端只保存「提醒专用窄同步」镜像：
 *   reminder_tasks（孩子名/任务名/日期/起止时间/状态）+ reminder_subs（openid 与订阅额度）
 *
 * POST /api/reminder/subscribe  登记额度：用户每次授权订阅成功后前端调用一次，quota +1
 * POST /api/reminder/sync       同步今天+明天的任务窄字段（按 accountId+date 覆盖）
 * POST /api/reminder/status     查询两模板剩余额度（设置页展示）
 *
 * openid 来源：请求可带 wx.login 的 code，后端 code2session 换取并落库；
 * 不带 code 时复用已存的 open_id。手机号登录账号同样可用（code 换得的 openid
 * 即当前微信用户本人的，消息发给本人）。
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const wxapi = require('../wxapi');
const { TEMPLATES, TEMPLATE_IDS, kindOfTemplate } = require('../reminder-config');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;

/** 带 code 时换 openid 并落库；不带 code 返回已存 openid（可能为空串） */
async function resolveOpenid(accountId, code) {
  if (code) {
    const openid = await wxapi.code2session(code);
    await db.touchReminderOpenid(accountId, openid, TEMPLATE_IDS);
    return openid;
  }
  const subs = await db.listReminderSubs(accountId);
  const withId = subs.find(s => s.open_id);
  return withId ? withId.open_id : '';
}

router.post('/subscribe', async (req, res) => {
  const { accountId, templateId, code } = req.body || {};
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  if (!kindOfTemplate(templateId)) {
    return res.status(400).json({ ok: false, msg: '未知模板' });
  }
  try {
    let openid = '';
    try {
      openid = await resolveOpenid(accountId, code);
    } catch (e) {
      console.warn('[REMINDER] subscribe code2session 失败:', e.message);
    }
    if (!openid) {
      return res.status(400).json({ ok: false, msg: '无法获取微信 openid，请重新登录后再开启提醒' });
    }
    const sub = await db.addReminderQuota(accountId, templateId, openid);
    res.json({ ok: true, quota: sub ? sub.quota : 1 });
  } catch (err) {
    console.error('[REMINDER] subscribe error:', err.message);
    res.status(500).json({ ok: false, msg: '登记失败，请稍后再试' });
  }
});

router.post('/sync', async (req, res) => {
  const { accountId, code, days } = req.body || {};
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  if (!Array.isArray(days) || days.length === 0 || days.length > 7) {
    return res.status(400).json({ ok: false, msg: '缺少同步数据' });
  }
  try {
    // openid 刷新失败不阻断任务同步（额度登记时已存过）
    if (code) {
      try {
        const openid = await wxapi.code2session(code);
        await db.touchReminderOpenid(accountId, openid, TEMPLATE_IDS);
      } catch (e) {
        console.warn('[REMINDER] sync code2session 失败（忽略）:', e.message);
      }
    }
    for (const day of days) {
      if (!day || !DATE_RE.test(String(day.date || ''))) continue;
      const tasks = Array.isArray(day.tasks) ? day.tasks.slice(0, 60) : [];
      const clean = tasks
        .filter(t => t && t.taskKey)
        .map(t => ({
          taskKey: String(t.taskKey),
          childName: String(t.childName || ''),
          taskName: String(t.taskName || ''),
          startTime: TIME_RE.test(String(t.startTime || '')) ? String(t.startTime) : '',
          endTime: TIME_RE.test(String(t.endTime || '')) ? String(t.endTime) : '',
          status: String(t.status || '')
        }));
      await db.replaceReminderDayTasks(accountId, String(day.date), clean);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[REMINDER] sync error:', err.message);
    res.status(500).json({ ok: false, msg: '同步失败，请稍后再试' });
  }
});

router.post('/status', async (req, res) => {
  const { accountId } = req.body || {};
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  try {
    const subs = await db.listReminderSubs(accountId);
    const byId = {};
    subs.forEach(s => { byId[s.template_id] = s; });
    res.json({
      ok: true,
      hasOpenid: subs.some(s => !!s.open_id),
      quotas: {
        start: byId[TEMPLATES.start] ? byId[TEMPLATES.start].quota : 0,
        due: byId[TEMPLATES.due] ? byId[TEMPLATES.due].quota : 0
      }
    });
  } catch (err) {
    console.error('[REMINDER] status error:', err.message);
    res.status(500).json({ ok: false, msg: '查询失败' });
  }
});

module.exports = router;
