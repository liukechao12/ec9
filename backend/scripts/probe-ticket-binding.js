/**
 * 票种绑定规则实测：验证「票种绑活动 / 绑场次 / 活动无场次」三条路径。
 *
 * 只探测不改数据，全用只读查询 + 现有接口。
 */
const { Event, Session, TicketType, Registration } = require('../models');
const http = require('http');

const BASE = { host: '127.0.0.1', port: 7098 };

function req(path, opt = {}) {
  return new Promise((res, rej) => {
    const r = http.request({ ...BASE, path, method: opt.method || 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, opt.headers || {}) }, s => {
      let d = ''; s.on('data', c => d += c); s.on('end', () => res({ code: s.statusCode, body: d }));
    });
    r.on('error', rej); if (opt.body) r.write(opt.body); r.end();
  });
}

(async () => {
  const problems = [];
  const ok = (m) => console.log('  ✓ ' + m);
  const bad = (m) => { console.log('  ✗ ' + m); problems.push(m); };

  const ev = await Event.findOne({ order: [['id', 'ASC']] });
  console.log('测试活动: [' + ev.id + '] ' + ev.name);

  const sessions = await Session.findAll({ where: { event_id: ev.id }, order: [['id', 'ASC']] });
  const tts = await TicketType.findAll({ where: { event_id: ev.id }, order: [['id', 'ASC']] });
  console.log('场次 ' + sessions.length + ' 个，票种 ' + tts.length + ' 个\n');

  // ---------- 1. 票种与活动绑定 ----------
  console.log('[1] 票种必须绑定活动');
  tts.forEach(t => {
    if (Number(t.event_id) === Number(ev.id)) ok('票种「' + t.name + '」绑定了活动 ' + t.event_id);
    else bad('票种「' + t.name + '」的 event_id=' + t.event_id + ' 与活动 ' + ev.id + ' 不符');
  });

  // ---------- 2. 限场次的票种，场次必须真属于该活动 ----------
  console.log('\n[2] 限场次票种的场次必须归属同一活动');
  const sIds = sessions.map(s => s.id);
  for (const t of tts) {
    const sid = Number(t.session_id);
    if (sid === 0) { ok('票种「' + t.name + '」= 全场次通用（session_id=0）'); continue; }
    if (sIds.includes(sid)) ok('票种「' + t.name + '」绑场次 ' + sid + '，该场次属于本活动');
    else bad('票种「' + t.name + '」绑场次 ' + sid + '，但该场次不属于活动 ' + ev.id + '（跨活动！）');
  }

  // ---------- 3. 限场次票种的 session_id 是否可空 ----------
  console.log('\n[3] session_id 的可空性（0 与 NULL 混用会让查询漏数据）');
  const raw = await TicketType.sequelize.query(
    'SELECT session_id, COUNT(*) FROM ec9_ticket_types GROUP BY session_id ORDER BY session_id');
  console.log('  DB 实际值分布:', JSON.stringify(raw[0]));
  const hasNull = raw[0].some(r => r.session_id === null);
  if (hasNull) bad('session_id 存在 NULL，与约定的 0（=全场次通用）不一致；查询条件 session_id>0 会漏掉这些行');
  else ok('session_id 无 NULL，统一用 0 表示全场次通用');

  // ---------- 4. 活动无场次时的接口表现 ----------
  console.log('\n[4] 公开接口在「活动无场次」时是否可用');
  const r1 = await req('/api/public/events/' + ev.id);
  const j1 = JSON.parse(r1.body);
  const d = j1.data || {};
  console.log('  GET /api/public/events/' + ev.id + ' → HTTP ' + r1.code);
  console.log('  sessions=' + (d.sessions ? d.sessions.length : '(无该字段)') +
    '  tickets=' + (d.tickets ? d.tickets.length : '(无该字段)'));
  if (r1.code === 200) ok('活动详情接口 200');
  else bad('活动详情接口 HTTP ' + r1.code);

  // ---------- 5. 关键缺口：建单是否校验「票种的场次约束」 ----------
  console.log('\n[5] ⚠️ 核心缺口：建单时有没有校验「票种限定的场次」');
  const orderService = require('../services/orderService');
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'services', 'orderService.js'), 'utf8');
  // 找取 session_id 的地方
  const usesReg = /reg\.session_id/.test(src);
  const checksTT = /tt\.session_id|ticketType\.session_id/.test(src);
  if (checksTT) ok('建单逻辑校验了票种的 session_id 约束');
  else if (usesReg) {
    bad('建单只读 reg.session_id（报名人选的场次），**完全不校验票种的 session_id**');
    console.log('     → 后果：报名选「上午主论坛」却能买「仅限下午分论坛」的票种，系统照收');
  } else bad('未找到建单时的场次处理逻辑，需人工确认');

  // ---------- 6. 报名接口是否校验票种的场次约束 ----------
  console.log('\n[6] 报名时有没有校验「所选场次与票种匹配」');
  const regSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'routes', 'registrations.js'), 'utf8');
  if (/ticket_type_id.*session_id|session_id.*ticket_type_id/s.test(regSrc) || /场次.*票种不匹配|票种.*不适用/.test(regSrc)) {
    ok('报名接口有票种/场次匹配校验');
  } else {
    bad('报名接口未见「票种限定的场次」校验 → 可能产生脏报名数据');
  }

  console.log('\n================ 结论 ================');
  if (!problems.length) console.log('全部通过');
  else { console.log('发现 ' + problems.length + ' 个问题:'); problems.forEach((p, i) => console.log('  ' + (i + 1) + '. ' + p)); }
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(2); });