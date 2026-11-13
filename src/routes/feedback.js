/**
 * 用户反馈路由
 *
 * POST /api/feedback           小程序「意见反馈」页提交：简单校验后落库 feedbacks 表
 * GET  /api/admin/feedbacks    管理用查看（沿用 ADMIN_SECRET 校验模式，同 poster admin-list）
 *
 * 校验口径（不过度设计）：content 必填、trim 后非空且 ≤500 字；category 白名单，
 * 非法值归一化为空串（表示未分类）；contact 选填、≤64 字；同一账号 1 小时内
 * 最多 20 条（无账号时按来源 IP 计），超出返回 429 提示稍后再试。
 */
const express = require('express');
const router = express.Router();
const db = require('../db');

const CATEGORIES = ['bug', 'suggestion', 'feature', 'other'];
const MAX_CONTENT = 500;
const MAX_CONTACT = 64;
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000;

router.post('/feedback', async (req, res) => {
  const body = req.body || {};
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) {
    return res.status(400).json({ ok: false, msg: '反馈内容不能为空' });
  }
  if (content.length > MAX_CONTENT) {
    return res.status(400).json({ ok: false, msg: '反馈内容最多 ' + MAX_CONTENT + ' 字' });
  }
  const contact = typeof body.contact === 'string' ? body.contact.trim() : '';
  if (contact.length > MAX_CONTACT) {
    return res.status(400).json({ ok: false, msg: '联系方式太长了' });
  }
  const category = CATEGORIES.includes(body.category) ? body.category : '';
  const accountId = typeof body.accountId === 'string' ? body.accountId.slice(0, 128) : '';
  const appVersion = typeof body.appVersion === 'string' ? body.appVersion.slice(0, 32) : '';
  // 频率 sanity：有账号按账号计；无账号按来源 IP 计，并以同一 key 落库保证统计成立
  const rateKey = accountId || ('ip:' + (req.ip || 'unknown'));
  try {
    const recent = await db.countFeedbacksSince(rateKey, Date.now() - RATE_WINDOW_MS);
    if (recent >= RATE_LIMIT) {
      return res.status(429).json({ ok: false, msg: '提交太频繁了，请稍后再试' });
    }
    const id = await db.createFeedback({
      accountId: rateKey,
      category,
      content,
      contact,
      appVersion
    });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('[FEEDBACK] submit error:', err.message);
    res.status(500).json({ ok: false, msg: '提交失败，请稍后再试' });
  }
});

/**
 * GET /api/admin/feedbacks?secret=<redacted>
 * 管理用：倒序查看反馈（含分类/联系方式/版本），供日常翻看用户建议
 */
router.get('/admin/feedbacks', async (req, res) => {
  const { secret, limit, offset } = req.query;
  if (secret !== (process.env.ADMIN_SECRET || 'gp-admin-2026')) {
    return res.status(403).json({ ok: false, msg: '无权限' });
  }
  try {
    const list = await db.listFeedbacks(limit, offset);
    res.json({ ok: true, data: { list } });
  } catch (err) {
    console.error('[FEEDBACK] admin list error:', err.message);
    res.status(500).json({ ok: false, msg: '获取失败' });
  }
});

module.exports = router;
