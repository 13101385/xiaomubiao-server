/**
* 订阅消息提醒：模板与字段映射配置
*
* 模板均在 mp 后台「订阅消息 → 我的模板」中选用公共模板库模板，一次性订阅。
*
* 字段键名规则（微信订阅消息）：data 的 key = 关键词类型 + 该关键词在模板中的位置序号
* （从 1 起，跨类型连续编号），value 统一为 { value: string}。
* - thing：文本，≤20 字；time：时间，如 "2026-11-12 16:30"
*
* 【2026-11-13 已按 mp 后台模板详情逐字校准，旧推断编号曾导致真机 47003】
* 字段编号规则：编号 = 该关键词在模板全部关键词中的位置（跨类型连续计数），
* 不是按类型分别计数。
*
* 备忘录任务提醒 hDYtrJ5uosH_J6KmrzOBEjHnhgDv4GyI-xweACoPL0A（模板编号 39922）
* 实际字段：提醒标题 {{thing1}}、开始时间 {{time3}}、温馨提示 {{thing4}}
* → data = { thing1: 提醒标题, time3: 开始时间, thing4: 温馨提示}
*
* 任务即将到期提醒 6n5DOgzR1a5qS3PrqSz5Ph7Lv6zsVpIyK_ptWWo8itM（模板编号 27165）
* 实际字段：任务名称 {{thing1}}、任务到期时间 {{time2}}、任务状态 {{phrase3}}、温馨提示 {{thing5}}
* → data = { thing1: 任务名称, time2: 任务到期时间, phrase3: 任务状态, thing5: 温馨提示}
* phrase 类型为短语（宜 ≤5 字），状态用「未完成」。
*/
const TEMPLATES = {
start: 'hDYtrJ5uosH_J6KmrzOBEjHnhgDv4GyI-xweACoPL0A',
due: '6n5DOgzR1a5qS3PrqSz5Ph7Lv6zsVpIyK_ptWWo8itM'
};

const TEMPLATE_IDS = [TEMPLATES.start, TEMPLATES.due];

function kindOfTemplate(templateId) {
if (templateId === TEMPLATES.start) return 'start';
if (templateId === TEMPLATES.due) return 'due';
return '';
}

/** thing 类型最长 20 字，超出截断 */
function thing(v) {
const s = String(v == null? '': v);
return { value: s.length > 20? s.slice(0, 20): s};
}

function timeVal(v) {
return { value: String(v == null? '': v)};
}

/** 开始提醒 payload：标题「{孩子}的任务要开始啦：{任务名}」 */
function buildStartData(childName, taskName, date, startTime) {
const title = (childName? childName + '的任务要开始啦：': '任务要开始啦：') + (taskName || '新任务');
return {
thing1: thing(title),
time3: timeVal(date + ' ' + startTime),
thing4: thing('记得提前准备，按时开始哦')
};
}

/** 未完成提醒 payload：第一条未完成任务名 + 总数 + 当日 21:30 到期 */
function buildDueData(firstTaskName, count, date) {
return {
thing1: thing(firstTaskName || '今日任务'),
time2: timeVal(date + ' 21:30'),
phrase3: { value: '未完成' },
thing5: thing('还有 ' + count + ' 项未完成，睡前一起收尾')
};
}

/**
 * 每日精选 payload：复用「备忘录任务提醒」模板（与开始提醒共用模板与额度池）。
 * 提醒标题「今日亲子话题：{问题}」；thing 上限 20 字：问题过长时截断并加省略号
 * （推送只是钩子，完整问题在小程序今日卡里看）。
 */
function buildDailyData(topicQ, date) {
const prefix = '今日亲子话题：';
let q = String(topicQ || '今天和孩子聊点什么？');
if ((prefix + q).length > 20) q = q.slice(0, 20 - prefix.length - 1) + '…';
return {
thing1: thing(prefix + q),
time3: timeVal(date + ' 07:30'),
thing4: thing('点开看看答案和今天的科普，陪孩子聊 2 分钟')
};
}

/**
 * 测试提醒 payload：复用「备忘录任务提醒」模板，设置页「发一条测试提醒」立即发送。
 * dateTime 为上海当前时间 'YYYY-MM-DD HH:mm'。
 */
function buildTestData(dateTime) {
return {
thing1: thing('测试提醒：通道已打通'),
time3: timeVal(dateTime),
thing4: thing('明早 7:30 你会收到亲子读物')
};
}

module.exports = { TEMPLATES, TEMPLATE_IDS, kindOfTemplate, buildStartData, buildDueData, buildDailyData, buildTestData};
