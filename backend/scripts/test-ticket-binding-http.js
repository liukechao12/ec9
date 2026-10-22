/**
 * 规则 A 的 HTTP 层验证：真调报名接口，确认真能 400 拦下
 *
 * 与 test-ticket-binding.js 的区别：那个直驱服务层，这个走 HTTP + 鉴权，
 * 确认 readSelection 已正确接进 4 个报名入口的前置校验。
 */
const http = require('http');
const { Event, Session, TicketType, sequelize } = require('../models');

const BASE = { host: '127.0.0.1', port: 7098 };
let pass = 0, fail = 0;
const problems = [];

function req(path, opt = {}) {
  return new Promise((res, rej) => {
    const r = http.request({ ...BASE, path, method: opt.method || 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, opt.headers || {}) }, s => {
      let d = ''; s.on('data', c => d += c); s.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (e) {}
        res({ code: s.statusCode, body: d, json: j });
      });
    });
    r.on('error', rej); if (opt.body) r.write(JSON.stringify(opt.body)); r.end();
  });
}

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; problems.push(name + (extra ? ' → ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

(async () => {
  // 登录拿 token
  const login = await req('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  const token = login.json && login.json.data && login.json.data.token;
  console.log('登录: HTTP ' + login.code + (token ? '  ✓' : '  ✗ 拿不到 token'));
  if (!token) { console.log(login.body.slice(0, 300)); process.exit(2); }
  const H = { Authorization: 'Bearer ' + token };

  // ---------- 用真实接口建一个场次票 ----------
  console.log('\n[造数] 走后台接口建活动/场次/票种（顺带验证票种守卫在 HTTP 层生效）');
  const ev = await req('/api/events', { method: 'POST', headers: H, body: {
    name: '规则A_HTTP测试_' + Date.now().toString(36).slice(-4),
    start_time: new Date(), end_time: new Date(Date.now() + 86400000), status: 1
  } });
  check('建活动 HTTP 2xx', ev.code >= 200 && ev.code < 300, 'HTTP ' + ev.code + ' ' + ev.body.slice(0, 150));
  const eventId = ev.json && ev.json.data && ev.json.data.id;
  if (!eventId) process.exit(2);

  const s1 = await req('/api/sessions', { method: 'POST', headers: H, body: { event_id: eventId, name: '上午场', status: 1, stock_total: 20 } });
  const s2 = await req('/api/sessions', { method: 'POST', headers: H, body: { event_id: eventId, name: '下午场', status: 1, stock_total: 20 } });
  const sid1 = s1.json && s1.json.data && s1.json.data.id;
  const sid2 = s2.json && s2.json.data && s2.json.data.id;
  check('建两个场次', !!(sid1 && sid2), 'sid1=' + sid1 + ' sid2=' + sid2);
  if (!sid1 || !sid2) process.exit(2);

  // 另一个活动（用于验证跨活动守卫）
  const ev2 = await req('/api/events', { method: 'POST', headers: H, body: {
    name: '他活动_' + Date.now().toString(36).slice(-4), start_time: new Date(), end_time: new Date(Date.now() + 86400000), status: 1
  } });
  const eventId2 = ev2.json && ev2.json.data && ev2.json.data.id;

  // 场次票
  const ttS = await req('/api/ticket-types', { method: 'POST', headers: H, body: {
    event_id: eventId, session_id: sid1, name: '仅上午场票_HTTP', price: 199, stock_total: 10
  } });
  const ttSid = ttS.json && ttS.json.data && ttS.json.data.id;
  check('建场次票 HTTP 200', !!ttSid, 'HTTP ' + ttS.code + ' ' + ttS.body.slice(0, 150));

  // 跨活动守卫：拿别活动的场次来绑
  const bad = await req('/api/ticket-types', { method: 'POST', headers: H, body: {
    event_id: eventId2, session_id: sid1, name: '跨活动票', price: 100, stock_total: 5
  } });
  check('票种绑别活动场次 → 400 SESSION_EVENT_MISMATCH',
    bad.code === 400 && bad.json && bad.json.errorCode === 'SESSION_EVENT_MISMATCH',
    'HTTP ' + bad.code + ' ' + bad.body.slice(0, 160));

  // 活动票
  const ttA = await req('/api/ticket-types', { method: 'POST', headers: H, body: {
    event_id: eventId, session_id: 0, name: '全场次通用票_HTTP', price: 299, stock_total: 10
  } });
  const ttAid = ttA.json && ttA.json.data && ttA.json.data.id;
  check('建活动票 HTTP 200', !!ttAid, 'HTTP ' + ttA.code + ' ' + ttA.body.slice(0, 150));

  // ---------- 走公开报名接口 ----------
  console.log('\n[报名接口] 规则 A 是否真的拦得住');

  // 找一个已发布的活动来报名（submit-by-phone 需要 status=1 且页面能走通）
  // 这里直接用刚建的活动 + 手机号走 submit-by-phone
  const phone = '138' + String(Date.now()).slice(-8);

  // 场景1：场次票 + 不传场次 → 应 400
  let r = await req('/api/registrations/submit-by-phone', { method: 'POST', body: {
    phone, name: 'HTTP测试', company: 'T', position: 'P', inviter: 'BD',
    event_id: eventId, ticket_type_id: ttSid
  } });
  check('场次票 + 不传场次 → 400 SESSION_REQUIRED',
    r.code === 400 && r.json && r.json.errorCode === 'SESSION_REQUIRED',
    'HTTP ' + r.code + ' ' + r.body.slice(0, 180));

  // 场景2：场次票 + 错误场次 → 应 400
  r = await req('/api/registrations/submit-by-phone', { method: 'POST', body: {
    phone, name: 'HTTP测试', company: 'T', position: 'P', inviter: 'BD',
    event_id: eventId, ticket_type_id: ttSid, session_id: sid2
  } });
  check('场次票 + 错误场次 → 400 SESSION_MISMATCH',
    r.code === 400 && r.json && r.json.errorCode === 'SESSION_MISMATCH',
    'HTTP ' + r.code + ' ' + r.body.slice(0, 180));

  // 场景3：场次票 + 正确场次 → 应通过
  r = await req('/api/registrations/submit-by-phone', { method: 'POST', body: {
    phone, name: 'HTTP测试', company: 'T', position: 'P', inviter: 'BD',
    event_id: eventId, ticket_type_id: ttSid, session_id: sid1
  } });
  check('场次票 + 正确场次 → 报名成功',
    r.code === 200 && r.json && r.json.code === 200,
    'HTTP ' + r.code + ' ' + r.body.slice(0, 200));

  // 确认写库正确
  if (r.code === 200) {
    const { Registration } = require('../models');
    const regs = await Registration.findAll({ where: { event_id: eventId }, order: [['id', 'DESC']], limit: 5 });
    const reg = regs.find(x => Number(x.ticket_type_id) === Number(ttSid));
    if (reg) {
      check('报名记录写入了场次与票种',
        Number(reg.session_id) === sid1 && Number(reg.ticket_type_id) === ttSid,
        'session=' + reg.session_id + ' tt=' + reg.ticket_type_id);
    } else {
      check('报名记录写入了场次与票种', false, '没找到带该票种的报名记录');
    }
  }

  // 场景4：活动票 + 不传场次 → 应通过
  const phone2 = '139' + String(Date.now()).slice(-8);
  r = await req('/api/registrations/submit-by-phone', { method: 'POST', body: {
    phone: phone2, name: 'HTTP测试2', company: 'T', position: 'P', inviter: 'BD',
    event_id: eventId, ticket_type_id: ttAid
  } });
  check('活动票 + 不传场次 → 报名成功（全场次通用）',
    r.code === 200 && r.json && r.json.code === 200,
    'HTTP ' + r.code + ' ' + r.body.slice(0, 200));

  // 场景5：都不传 → 老流程不受影响
  const phone3 = '137' + String(Date.now()).slice(-8);
  r = await req('/api/registrations/submit-by-phone', { method: 'POST', body: {
    phone: phone3, name: 'HTTP测试3', company: 'T', position: 'P', inviter: 'BD',
    event_id: eventId
  } });
  check('都不传 → 老报名流程不受影响',
    r.code === 200 && r.json && r.json.code === 200,
    'HTTP ' + r.code + ' ' + r.body.slice(0, 200));

  // 场景6：英文态错误文案
  r = await req('/api/registrations/submit-by-phone', { method: 'POST', body: {
    phone: '136' + String(Date.now()).slice(-8), name: 'X', company: 'T', position: 'P', inviter: 'BD',
    event_id: eventId, ticket_type_id: ttSid, lang: 'en'
  } });
  check('英文态错误文案返回英文',
    r.code === 400 && r.json && /session/i.test(r.json.message || ''),
    'HTTP ' + r.code + ' msg=' + (r.json && r.json.message));

  // ---------- 清理 ----------
  console.log('\n[清理]');
  // ⚠️ 清理必须无条件执行（放 finally），中途断言失败时否则会留下测试活动，
  //    而活动会排在种子数据前面，让后续按 start_time DESC 取活动的用例拿到空活动。
  const ids = [eventId, eventId2].filter(Boolean);
  for (const t of ['ec9_orders', 'ec9_registrations', 'ec9_invitations', 'ec9_ticket_types', 'ec9_sessions']) {
    await sequelize.query(`DELETE FROM ${t} WHERE event_id IN (:ids)`, { replacements: { ids } });
  }
  await sequelize.query('DELETE FROM ec9_events WHERE id IN (:ids)', { replacements: { ids } });

  // 顺带扫掉历史失败运行可能残留的同名测试活动
  const { Op } = require('sequelize');
  const junk = await sequelize.query(
    `SELECT id FROM ec9_events WHERE name LIKE '规则A%' OR name LIKE '他活动%' OR name LIKE '另一个活动%'`);
  if (junk[0].length) {
    const junkIds = junk[0].map(x => x.id);
    for (const t of ['ec9_orders', 'ec9_registrations', 'ec9_invitations', 'ec9_ticket_types', 'ec9_sessions']) {
      await sequelize.query(`DELETE FROM ${t} WHERE event_id IN (:ids)`, { replacements: { ids: junkIds } });
    }
    await sequelize.query('DELETE FROM ec9_events WHERE id IN (:ids)', { replacements: { ids: junkIds } });
    console.log('  额外清掉 ' + junkIds.length + ' 个历史残留测试活动');
  }
  console.log('  已清理测试活动与报名数据');

  console.log('\n================ 结论 ================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail) { problems.forEach((p, i) => console.log('  ' + (i + 1) + '. ' + p)); process.exit(1); }
  console.log('HTTP 层规则 A 全部通过');
  process.exit(0);
})().catch(e => { console.error('ERR', e.stack); process.exit(2); });