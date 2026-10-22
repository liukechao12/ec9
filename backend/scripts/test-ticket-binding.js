/**
 * 规则 A 回归测试：限场次票种必须同时选择对应场次
 *
 * 覆盖：
 *   A1 场次票 + 未选场次        → 拒绝 SESSION_REQUIRED
 *   A2 场次票 + 选了正确场次     → 通过
 *   A3 场次票 + 选了别的场次     → 拒绝 SESSION_MISMATCH
 *   A4 活动票 + 未选场次         → 通过（全场次通用）
 *   A5 活动票 + 选了本活动场次   → 通过
 *   A6 场次不属于该活动          → 拒绝 SESSION_EVENT_MISMATCH
 *   A7 票种不属于该活动          → 拒绝 TICKET_EVENT_MISMATCH
 *   A8 不选票种也不选场次        → 通过（EC8 老流程不受影响）
 *   A9 建单时报名场次与票种不符   → 拒绝（脏数据防线）
 *   A10 建单正常路径             → 通过并锁库存
 *   A11 票种管理：绑别活动的场次 → 拒绝
 *
 * 用自己的测试数据，跑完清理，不碰种子数据。
 */
const { Event, Session, TicketType, Registration, Guest, Order, sequelize } = require('../models');
const orderService = require('../services/orderService');
const { validateSelection, validateTicketSession } = require('../services/ticketBinding');

let pass = 0, fail = 0;
const problems = [];

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; problems.push(name + (extra ? ' → ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

/** 建一个干净的活动用于测试 */
async function makeFixture() {
  const suffix = Date.now().toString(36).slice(-5);
  const ev = await Event.create({
    name: '规则A测试活动_' + suffix,
    description: 'test',
    location: 'test',
    status: 1,
    start_time: new Date(),
    end_time: new Date(Date.now() + 86400000),
    pay_expire_hours: 48
  });
  const s1 = await Session.create({ event_id: ev.id, name: '上午场', status: 1, stock_total: 50, sort: 1 });
  const s2 = await Session.create({ event_id: ev.id, name: '下午场', status: 1, stock_total: 50, sort: 2 });

  const ttSession = await TicketType.create({
    event_id: ev.id, session_id: s1.id, name: '仅上午场票',
    price: 199, stock_total: 10, per_order_limit: 2, on_shelf: 1, status: 1, sort: 1
  });
  const ttAll = await TicketType.create({
    event_id: ev.id, session_id: 0, name: '全场次通用票',
    price: 299, stock_total: 10, per_order_limit: 2, on_shelf: 1, status: 1, sort: 2
  });

  const guest = await Guest.create({
    name: '规则A测试嘉宾', company: 'T', position: 'P',
    phone: null, phone_hash: null, status: 1
  });

  return { ev, s1, s2, ttSession, ttAll, guest };
}

async function cleanup(fx) {
  const ids = [fx && fx.ev ? fx.ev.id : null].filter(Boolean);
  if (!ids.length) return;
  for (const t of ['ec9_orders', 'ec9_registrations', 'ec9_invitations', 'ec9_ticket_types', 'ec9_sessions']) {
    await sequelize.query(`DELETE FROM ${t} WHERE event_id IN (:ids)`, { replacements: { ids } });
  }
  await sequelize.query('DELETE FROM ec9_events WHERE id IN (:ids)', { replacements: { ids } });
  if (fx && fx.guest && fx.guest.id) {
    await sequelize.query('DELETE FROM ec9_guests WHERE id = :g', { replacements: { g: fx.guest.id } });
  }
}

/** 造一条报名记录 */
async function makeReg(fx, { sessionId, ticketTypeId, status = 'approved' }) {
  return Registration.create({
    event_id: fx.ev.id,
    guest_id: fx.guest.id,
    session_id: sessionId,
    ticket_type_id: ticketTypeId,
    status,
    registration_time: new Date()
  });
}

/**
 * 存量数据体检。
 * 必须在造测试数据**之前**跑：脚本自己会造一条故意的脏报名（regDirty），
 * 放在后面跑就会把自己的测试样本报成脏数据。
 */
async function auditExistingData() {
  console.log('\n[体检] 库里已有的报名/票种是否自洽');
  const bad = await sequelize.query(`
    SELECT r.id, r.session_id, tt.session_id AS tt_sid, tt.name
    FROM ec9_registrations r
    JOIN ec9_ticket_types tt ON tt.id = r.ticket_type_id
    WHERE tt.session_id > 0 AND r.session_id <> tt.session_id
    LIMIT 10
  `);
  check('无「报名场次≠票种场次」的存量脏数据', bad[0].length === 0,
    bad[0].length ? JSON.stringify(bad[0].slice(0, 3)) : '');

  const cross = await sequelize.query(`
    SELECT tt.id, tt.name, tt.event_id, s.event_id AS s_event
    FROM ec9_ticket_types tt
    JOIN ec9_sessions s ON s.id = tt.session_id
    WHERE tt.session_id > 0 AND tt.event_id <> s.event_id
    LIMIT 10
  `);
  check('无「票种跨活动绑场次」的存量脏数据', cross[0].length === 0,
    cross[0].length ? JSON.stringify(cross[0].slice(0, 3)) : '');

  const nullSid = await sequelize.query(
    'SELECT COUNT(*)::int AS c FROM ec9_ticket_types WHERE session_id IS NULL');
  check('票种 session_id 无 NULL（统一用 0）', Number(nullSid[0][0].c) === 0);
}

(async () => {
  await auditExistingData();

  const fx = await makeFixture();
  console.log('\n测试活动 id=' + fx.ev.id + '  上午场=' + fx.s1.id + '  下午场=' + fx.s2.id + '\n');

  try {
    // ---------- 规则 A 主体 ----------
    console.log('[规则 A] 限场次票种必须同时选择对应场次');

    let r = await validateSelection({ ticketTypeId: fx.ttSession.id, sessionId: 0, eventId: fx.ev.id });
    check('A1 场次票 + 未选场次 → 拒绝', !r.ok && r.code === 'SESSION_REQUIRED', r.code || '居然通过了');

    r = await validateSelection({ ticketTypeId: fx.ttSession.id, sessionId: fx.s1.id, eventId: fx.ev.id });
    check('A2 场次票 + 正确场次 → 通过', r.ok && r.sessionId === fx.s1.id, r.error);

    r = await validateSelection({ ticketTypeId: fx.ttSession.id, sessionId: fx.s2.id, eventId: fx.ev.id });
    check('A3 场次票 + 错误场次 → 拒绝', !r.ok && r.code === 'SESSION_MISMATCH', r.code || '居然通过了');

    // ---------- 活动票不受场次约束 ----------
    console.log('\n[活动票] session_id=0 适用于全部场次');
    r = await validateSelection({ ticketTypeId: fx.ttAll.id, sessionId: 0, eventId: fx.ev.id });
    check('A4 活动票 + 未选场次 → 通过', r.ok, r.error);

    r = await validateSelection({ ticketTypeId: fx.ttAll.id, sessionId: fx.s2.id, eventId: fx.ev.id });
    check('A5 活动票 + 选本活动场次 → 通过', r.ok && r.sessionId === fx.s2.id, r.error);

    // ---------- 跨活动守卫 ----------
    console.log('\n[跨活动] 场次与票种必须同属一个活动');
    const ev2 = await Event.create({
      name: '另一个活动_' + fx.s1.id, status: 1,
      start_time: new Date(), end_time: new Date()
    });
    const ttEv2 = await TicketType.create({
      event_id: ev2.id, session_id: 0, name: '他活动通用票',
      price: 100, stock_total: 5, per_order_limit: 1, on_shelf: 1, status: 1
    });
    try {
      // 活动2 的通用票 + 活动1 的场次 → 场次跨活动
      r = await validateSelection({ ticketTypeId: ttEv2.id, sessionId: fx.s1.id, eventId: ev2.id });
      check('A6 票种的场次跨到别的活动 → 拒绝', !r.ok && r.code === 'SESSION_EVENT_MISMATCH', r.code || '居然通过了');

      r = await validateSelection({ ticketTypeId: fx.ttAll.id, sessionId: fx.s2.id, eventId: ev2.id });
      check('A7 拿别的活动的票种 → 拒绝', !r.ok && r.code === 'TICKET_EVENT_MISMATCH', r.code || '居然通过了');

      // ---------- 票种管理守卫 ----------
      const g1 = await validateTicketSession(fx.ev.id, fx.s1.id);
      check('A11a 票种绑本活动场次 → 通过', g1.ok, g1.error);
      const g2 = await validateTicketSession(ev2.id, fx.s1.id);
      check('A11b 票种绑别活动场次 → 拒绝', !g2.ok && g2.code === 'SESSION_EVENT_MISMATCH', g2.code);
    } finally {
      await sequelize.query('DELETE FROM ec9_ticket_types WHERE event_id = :e', { replacements: { e: ev2.id } });
      await sequelize.query('DELETE FROM ec9_events WHERE id = :e', { replacements: { e: ev2.id } });
    }
    // ---------- 兼容 EC8 老流程 ----------
    console.log('\n[兼容] 不选票种、不选场次的老报名流程');
    r = await validateSelection({ ticketTypeId: 0, sessionId: 0, eventId: fx.ev.id });
    check('A8 都不选 → 通过（后台再指派）', r.ok, r.error);
    r = await validateSelection({ ticketTypeId: 0, sessionId: 0, eventId: fx.ev.id, requireTicket: true });
    check('A8b requireTicket 模式 → 拒绝', !r.ok && r.code === 'TICKET_REQUIRED', r.code);

    // ---------- 建单 ----------
    console.log('\n[建单] 脏数据防线');
    const regDirty = await makeReg(fx, { sessionId: fx.s2.id, ticketTypeId: fx.ttSession.id });
    let ord = await orderService.createOrder(regDirty.id, { quantity: 1 });
    check('A9 场次不符的报名 → 建单拒绝', !ord.ok && ord.code === 'SESSION_MISMATCH',
      (ord.code || '') + ' ' + (ord.error || ''));

    const regOk = await makeReg(fx, { sessionId: fx.s1.id, ticketTypeId: fx.ttSession.id });
    ord = await orderService.createOrder(regOk.id, { quantity: 2 });
    check('A10 正常报名 → 建单成功并锁库存', ord.ok, ord.error);

    if (ord.ok) {
      const ttReload = await TicketType.findByPk(fx.ttSession.id);
      const sReload = await Session.findByPk(fx.s1.id);
      check('A10b 票种库存已锁 2', Number(ttReload.stock_locked) === 2, 'locked=' + ttReload.stock_locked);
      check('A10c 场次库存已锁 2', Number(sReload.stock_locked) === 2, 'locked=' + sReload.stock_locked);
      check('A10d 订单带上场次与票种',
        Number(ord.order.session_id) === fx.s1.id && Number(ord.order.ticket_type_id) === fx.ttSession.id,
        'session=' + ord.order.session_id + ' tt=' + ord.order.ticket_type_id);
    }
  } finally {
    await cleanup(fx);
    console.log('\n（测试数据已清理）');
  }

  console.log('\n================ 结论 ================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail) { problems.forEach((p, i) => console.log('  ' + (i + 1) + '. ' + p)); process.exit(1); }
  console.log('规则 A 全部通过');
  process.exit(0);
})().catch(e => { console.error('ERR', e.stack); process.exit(2); });