/**
 * 小味 · AI 智能客服路由
 * POST /api/chat
 * body: { message, accountId? }
 * 依赖：环境变量 AGNES_AI_API_KEY（agnes API 凭证，与 exam.js 相同来源）
 */
const express = require('express');
const axios = require('axios');
const router = express.Router();
const { config } = require('../config');

/* ==================== 系统提示词 ==================== */

const SYSTEM_PROMPT = `你是「小味」，成长趣味微信小程序的 AI 智能客服助手，语气活泼亲切，回答简短友好、条理清晰，家长和孩子都能看懂，可适当用 emoji。

成长趣味是一款儿童成长激励微信小程序，功能包括：任务打卡（孩子自己排任务、赚积分）、一键模板（上学日/周末/节假日任务包）、积分规则（完成加分、未完成扣分、连续3/7天奖励、每周达标奖励）、盲盒抽奖（普通20/进阶50/高级100积分三档）、兑换中心（电视时间、游戏、免作业、晚餐等奖励，家长审批+兑换码核销）、电视特权卡、家长审批中心、数据报告、徽章系统（8枚）、多孩子管理、年龄模式（6-8/9-11/12-15岁自动调整任务与积分规则）、智能出题（AI生成试卷并批改）、AI手抄报（输入主题一键生成可打印海报，含公共模板成品库）、6套主题切换、孩子/家长角色切换（家长4位PIN码）。

回答规则：
1. 只回答与成长趣味小程序相关的问题：功能使用、操作步骤、规则说明、常见问题排查。
2. 回答内容要准确，不编造小程序不存在的功能；不确定时建议查看「我的」页面或联系开发者。
3. 如果问题与成长趣味小程序无关（如其他软件、编程、新闻、闲聊等），礼貌拒绝：「这个问题超出小味的服务范围啦～ 小味只负责回答成长趣味小程序的使用问题，比如任务打卡、积分、盲盒、兑换、AI手抄报、智能出题这些。还有其他小程序使用问题随时问我哦～」`;

/* ==================== agnes 调用（参照 exam.js 的 callAgnes 写法） ==================== */

/**
 * 调用 agnes（OpenAI 兼容）聊天补全
 */
async function callAgnesChat(message) {
  const { apiKey, baseURL, model, timeoutMs } = config.agnes;
  if (!apiKey) {
    throw new Error('服务器未配置 AGNES_AI_API_KEY');
  }
  const resp = await axios.post(baseURL + '/chat/completions', {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: message }
    ],
    temperature: 0.7,
    max_tokens: 800
  }, {
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    timeout: timeoutMs
  });

  const content = resp.data && resp.data.choices && resp.data.choices[0]
    ? (resp.data.choices[0].message && resp.data.choices[0].message.content) || ''
    : '';
  if (!content) {
    throw new Error('AI 未返回内容');
  }
  return content;
}

/* ==================== 路由 ==================== */

/**
 * POST /api/chat
 * body: { message, accountId? }
 */
router.post('/', async (req, res) => {
  const { message, accountId } = req.body || {};

  // 参数校验：message 必须是非空字符串，trim 后长度 1~500
  if (typeof message !== 'string') {
    return res.status(400).json({ ok: false, msg: 'message 必须是非空字符串' });
  }
  const msg = message.trim();
  if (!msg || msg.length < 1 || msg.length > 500) {
    return res.status(400).json({ ok: false, msg: '消息长度需在 1~500 字之间' });
  }

  try {
    const reply = await callAgnesChat(msg);
    res.json({ ok: true, reply });
  } catch (err) {
    console.error('[CHAT] agnes error:', err.message);
    res.status(500).json({ ok: false, msg: '小味开小差了，请稍后再试' });
  }
});

module.exports = router;
