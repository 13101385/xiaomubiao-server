/**
* 订阅消息提醒：模板与字段映射配置
*
* 模板均在 mp 后台「订阅消息 → 我的模板」中选用公共模板库模板，一次性订阅。
*
* 字段键名规则（微信订阅消息）：data 的 key = 关键词类型 + 该关键词在模板中的位置序号
* （从 1 起，跨类型连续编号），value 统一为 { value: string}。
* - thing：文本，≤20 字；time：时间，如 "2026-11-12 16:30"
*
* 备忘录任务提醒 hDYtrJ5uosH_J6KmrzOBEjHnhgDv4GyI-xweACoPL0A
* 选用关键词顺序：1 提醒标题(thing) 2 开始时间(time) 3 温馨提示(thing)
* → data = { thing1: 提醒标题, time2: 开始时间, thing3: 温馨提示}
*
* 任务即将到期提醒 6n5DOgzR1a5qS3PrqSz5Ph7Lv6zsVpIyK_ptWWo8itM
* 选用关键词顺序：1 任务名称(thing) 2 任务到期时间(time) 3 任务状态(thing) 4 温馨提示(thing)
* → data = { thing1: 任务名称, time2: 任务到期时间, thing3: 任务状态, thing4: 温馨提示}
*
* 若微信发送返回 47003（参数错误/关键词不匹配），按 mp 后台「我的模板 → 详情」
* 中各关键词的实际类型与顺序校准上面的编号即可，业务代码不用改。
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
time2: timeVal(date + ' ' + startTime),
thing3: thing('记得提前准备，按时开始哦')
};
}

/** 未完成提醒 payload：第一条未完成任务名 + 总数 + 当日 21:30 到期 */
function buildDueData(firstTaskName, count, date) {
return {
thing1: thing(firstTaskName || '今日任务'),
time2: timeVal(date + ' 21:30'),
thing3: thing('还有 ' + count + ' 项未完成'),
thing4: thing('睡前陪孩子一起收尾吧')
};
}

module.exports = { TEMPLATES, TEMPLATE_IDS, kindOfTemplate, buildStartData, buildDueData};
