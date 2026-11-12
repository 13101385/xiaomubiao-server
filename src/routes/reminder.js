/**
 * 订阅消息提醒路由
 * 任务数据只在用户手机本地，后端只保存「提醒专用窄同步」镜像：
 *   reminder_tasks（孩子名/任务名/日期/起止时间/状态）+ reminder_subs（openid 与订阅额度）
 *
 * POST /api/reminder/subscribe  登记额度：用户每次授权订阅成功后前端调用一次，quota +1
 * POST /api/reminder/sync       同步今天+明天的任务窄字段（按 accountId+date 覆盖）；
 *                                另接受顶层 dailyPush（每日精选开关）与每日 hook（今日卡钩子：
 *                                亲子话题问题/科普标题/年龄档），供早间每日精选推送引用
 * POST /api/reminder/status     查询两模板剩余额度（设置页展示）
 * POST /api/reminder/test       立即发送一条测试提醒（开始提醒模板，落点今日精选页），
 *                                成功扣 1 条额度并记 sent_log(kind='test')；失败带 errcode 回前端排查
 *
 * openid 来源：请求可带 wx.login 的 code，后端 code2session 换取并落库；
 * 不带 code 时复用已存的 open_id。手机号登录账号同样可用（code 换得的 openid
 * 即当前微信用户本人的，消息发给本人）。
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const wxapi = require('../wxapi');
const { TEMPLATES, TEMPLATE_IDS, kindOfTemplate, buildTestData } = require('../reminder-config');

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
  const dailyPush = !!(req.body || {}).dailyPush;
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
      // 今日卡钩子（每日精选早间推送引用）：字段做长度/枚举校验后按日覆盖保存
      if (day.hook && typeof day.hook === 'object') {
        await db.replaceReminderDailyHook(accountId, String(day.date), {
          topicQ: String(day.hook.topicQ || '').slice(0, 100),
          scienceTitle: String(day.hook.scienceTitle || '').slice(0, 100),
          band: (day.hook.band === 'low' || day.hook.band === 'high') ? day.hook.band : ''
        }, dailyPush);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[REMINDER] sync error:', err.message);
    res.status(500).json({ ok: false, msg: '同步失败，请稍后再试' });
  }
});

/** 上海当前时间：{ date: 'YYYY-MM-DD', text: 'YYYY-MM-DD HH:mm' }（UTC+8 恒定） */
function shanghaiNowText() {
  const p = n => String(n).padStart(2, '0');
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const date = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  return { date, text: date + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) };
}

/**
 * 立即发送一条测试提醒：让家长当场验证推送通道。
 * 用开始提醒模板（与每日精选共用额度池），落点 pages/daily/daily。
 * 业务失败统一 200 + { ok:false, errcode, msg }：errcode 为 'NO_OPENID' / 'NO_QUOTA' /
 * 'NETWORK' 或微信原始数字 errcode，前端原样展示便于排查。
 */
router.post('/test', async (req, res) => {
  const { accountId, code } = req.body || {};
  if (!accountId) return res.status(400).json({ ok: false, msg: '缺少 accountId' });
  try {
    // 带 code 时顺带刷新 openid 落库（与 subscribe/sync 同口径，失败不阻断）
    if (code) {
      try {
        const openid = await wxapi.code2session(code);
        await db.touchReminderOpenid(accountId, openid, TEMPLATE_IDS);
      } catch (e) {
        console.warn('[REMINDER] test code2session 失败（忽略）:', e.message);
      }
    }
    const sub = await db.getReminderSub(accountId, TEMPLATES.start);
    if (!sub || !sub.open_id) {
      return res.json({ ok: false, errcode: 'NO_OPENID', msg: '还没有你的微信记录，请先打开任意一个提醒开关并完成授权' });
    }
    if (sub.quota <= 0) {
      return res.json({ ok: false, errcode: 'NO_QUOTA', msg: '开始提醒的订阅额度已用完，请重新打开开关授权一次' });
    }
    const now = shanghaiNowText();
    let resp;
    try {
      resp = await wxapi.sendSubscribeMessage({
        openid: sub.open_id,
        templateId: TEMPLATES.start,
        data: buildTestData(now.text),
        page: 'pages/daily/daily'
      });
    } catch (e) {
      return res.json({ ok: false, errcode: 'NETWORK', msg: '发送请求失败：' + e.message });
    }
    if (resp.errcode === 0) {
      await db.decReminderQuota(accountId, TEMPLATES.start);
      await db.addSentLog(accountId, 'test', now.date);
      const after = await db.getReminderSub(accountId, TEMPLATES.start);
      console.log('[REMINDER] 测试提醒已发送:', accountId);
      return res.json({ ok: true, quota: after ? after.quota : 0 });
    }
    if (resp.errcode === 43101) {
      // 用户未订阅/拒收：与调度层同口径，本地额度归零对齐
      await db.setReminderQuota(accountId, TEMPLATES.start, 0);
      return res.json({ ok: false, errcode: 43101, msg: '微信提示未订阅或已拒收（43101），本地额度已清零，请重新授权一次' });
    }
    return res.json({ ok: false, errcode: resp.errcode, msg: '微信发送失败（' + resp.errcode + '）：' + (resp.errmsg || '未知错误') });
  } catch (err) {
    console.error('[REMINDER] test error:', err.message);
    res.status(500).json({ ok: false, msg: '发送失败，请稍后再试' });
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
