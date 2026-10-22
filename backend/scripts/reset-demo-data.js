/**
 * EC9 演示数据重置
 *
 * 为什么需要：smoke-http / selftest / walkthrough 每次跑都会在演示库里留下数据，
 * 跑几十次之后后台显示「嘉宾 89 / 订单 17」，其中大半是已删活动留下的孤儿，
 * 昊哥打开后台看到的是一堆假数据，没法判断系统对不对。
 *
 * ⚠️ 同时修一个真实 bug：删订单时**没有回退票种/场次库存**，
 *   导致 stock_sold 虚高、可售数被压低（清完数据显示「免费票售 16」但订单只剩 2 笔）。
 *   本脚本按**当前实际存在的订单**重算库存，而不是简单加回去。
 *
 * 用法：
 *   node scripts/reset-demo-data.js          # 体检 + 清理孤儿 + 按实际订单重算库存
 *   node scripts/reset-demo-data.js --check  # 只体检不动数据
 */
const { Op, sequelize, Event, Session, TicketType, Guest, Invitation, Registration, Order, Payment, CheckinCode, Checkin } = require('../models');

const CHECK_ONLY = process.argv.includes('--check');
const problems = [];
const note = m => { problems.push(m); console.log('  ⚠ ' + m); };
const ok = m => console.log('  ✓ ' + m);

/** 孤儿 = 主表已无对应记录，但子表还挂着（活动删了，嘉宾/订单还留着） */
const ORPHAN_RULES = [
  { table: 'ec9_orders', col: 'event_id', ref: 'ec9_events', label: '订单' },
  { table: 'ec9_orders', col: 'guest_id', ref: 'ec9_guests', label: '订单的嘉宾' },
  { table: 'ec9_registrations', col: 'guest_id', ref: 'ec9_guests', label: '报名的嘉宾' },
  { table: 'ec9_registrations', col: 'event_id', ref: 'ec9_events', label: '报名的活动' },
  { table: 'ec9_invitations', col: 'guest_id', ref: 'ec9_guests', label: '邀约的嘉宾' },
  { table: 'ec9_invitations', col: 'event_id', ref: 'ec9_events', label: '邀约的活动' },
  { table: 'ec9_sessions', col: 'event_id', ref: 'ec9_events', label: '场次的活动' },
  { table: 'ec9_ticket_types', col: 'event_id', ref: 'ec9_events', label: '票种的活动' },
  { table: 'ec9_checkins', col: 'guest_id', ref: 'ec9_guests', label: '签到的嘉宾' },
  { table: 'ec9_checkin_codes', col: 'guest_id', ref: 'ec9_guests', label: '签到码的嘉宾' },
  { table: 'ec9_checkin_codes', col: 'registration_id', ref: 'ec9_registrations', label: '签到码的报名' }
];

/** 测试脚本造的垃圾数据（按名称特征识别） */
const TEST_NAME_PATTERNS = [
  { table: 'ec9_events', col: 'name', like: ['演练会议%', '规则A%', '他活动%', '另一个活动%'], label: '测试活动' },
  { table: 'ec9_guests', col: 'name', like: ['冒烟-%', '自检%', '演练%', '支付演练%', '业绩会%', '规则A%'], label: '测试嘉宾' },
  { table: 'ec9_sessions', col: 'name', like: ['自检场次%', '演练%', '主论坛-%'], label: '测试场次' },
  { table: 'ec9_ticket_types', col: 'name', like: ['仅上午场票%', '全场次通用票%', '跨活动票%', '他活动通用票%'], label: '测试票种' }
];

(async () => {
  console.log(CHECK_ONLY ? '=== EC9 演示数据体检（只读）===' : '=== EC9 演示数据重置 ===\n');

  // ---------- 1. 找测试垃圾数据 ----------
  console.log('[1] 测试脚本残留');
  const junkIds = {};
  const MODELS = { ec9_events: Event, ec9_guests: Guest, ec9_sessions: Session, ec9_ticket_types: TicketType };
  for (const p of TEST_NAME_PATTERNS) {
    const Model = MODELS[p.table];
    if (!Model) continue;
    const where = { [Op.or]: p.like.map(l => ({ [p.col]: { [Op.like]: l } })) };
    const found = await Model.findAll({ where, attributes: ['id'] });
    if (found.length) {
      junkIds[p.table] = (junkIds[p.table] || []).concat(found.map(x => x.id));
      note(p.label + ' ' + found.length + ' 条 → ' + JSON.stringify(found.map(x => x.id)));
    }
  }
  if (!Object.keys(junkIds).length) ok('无测试数据残留');

  // ---------- 2. 找孤儿记录 ----------
  console.log('\n[2] 孤儿记录（主表已删、子表还挂着）');
  const orphans = {};
  for (const r of ORPHAN_RULES) {
    const [rows] = await sequelize.query(
      `SELECT id FROM ${r.table} WHERE ${r.col} IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${r.ref} x WHERE x.id = ${r.table}.${r.col})
       LIMIT 500`);
    if (rows.length) {
      orphans[r.table] = (orphans[r.table] || []).concat(rows.map(x => x.id));
      note(r.label + ' 孤儿 ' + rows.length + ' 条');
    }
  }
  if (!Object.keys(orphans).length) ok('无孤儿记录');

  // ---------- 3. 库存自洽性 ----------
  console.log('\n[3] 库存一致性（stock_sold 应等于实际已支付订单量）');
  const tts = await TicketType.findAll({ order: [['id', 'ASC']] });
  for (const t of tts) {
    const paid = await Order.sum('quantity', { where: { ticket_type_id: t.id, status: 'paid' } });
    const pending = await Order.sum('quantity', { where: { ticket_type_id: t.id, status: 'pending_payment' } });
    const realSold = Number(paid || 0);
    const realLocked = Number(pending || 0);
    const driftSold = Number(t.stock_sold) - realSold;
    const driftLocked = Number(t.stock_locked) - realLocked;
    if (driftSold !== 0 || driftLocked !== 0) {
      note(`票种「${t.name}」库存漂移：sold=${t.stock_sold}(实际${realSold}) locked=${t.stock_locked}(实际${realLocked})`);
      if (!CHECK_ONLY) {
        await t.update({ stock_sold: realSold, stock_locked: realLocked });
      }
    }
  }
  if (!problems.some(p => p.includes('库存漂移'))) ok('票种库存与订单一致');

  const sss = await Session.findAll({ order: [['id', 'ASC']] });
  for (const s of sss) {
    const paid = await Order.sum('quantity', { where: { session_id: s.id, status: 'paid' } });
    const pending = await Order.sum('quantity', { where: { session_id: s.id, status: 'pending_payment' } });
    const realSold = Number(paid || 0), realLocked = Number(pending || 0);
    if (Number(s.stock_sold) !== realSold || Number(s.stock_locked) !== realLocked) {
      note(`场次「${s.name}」库存漂移：sold=${s.stock_sold}(实际${realSold}) locked=${s.stock_locked}(实际${realLocked})`);
      if (!CHECK_ONLY) await s.update({ stock_sold: realSold, stock_locked: realLocked });
    }
  }

  // ---------- 4. 执行删除 ----------
  if (CHECK_ONLY) {
    console.log('\n=== 体检完成（--check 未做任何修改）===');
    console.log(problems.length ? '发现 ' + problems.length + ' 项问题' : '数据干净');
    process.exit(problems.length ? 1 : 0);
  }

  console.log('\n[4] 清理');
  // 先清子表，再清主表（顺序错了会留下新的孤儿）
  const allDel = {};
  for (const src of [junkIds, orphans]) {
    for (const t of Object.keys(src)) allDel[t] = (allDel[t] || []).concat(src[t]);
  }
  // payments 没有 event_id，只能按 order 关联
  const orderIds = allDel['ec9_orders'];
  if (orderIds && orderIds.length) {
    await sequelize.query('DELETE FROM ec9_payments WHERE order_id IN (:ids)', { replacements: { ids: orderIds } });
    console.log('  清 ec9_payments ' + orderIds.length + ' 条');
  }
  const ORDER = ['ec9_payments', 'ec9_checkin_codes', 'ec9_checkins', 'ec9_orders',
    'ec9_registrations', 'ec9_invitations', 'ec9_ticket_types', 'ec9_sessions',
    'ec9_guests', 'ec9_events'];
  for (const t of ORDER) {
    const ids = Array.from(new Set(allDel[t] || []));
    if (!ids.length) continue;
    try {
      await sequelize.query(`DELETE FROM ${t} WHERE id IN (:ids)`, { replacements: { ids } });
      console.log('  清 ' + t + ' ' + ids.length + ' 条');
    } catch (e) {
      console.log('  ' + t + ' 跳过: ' + e.message.slice(0, 60));
    }
  }

  // ---------- 5. 结果 ----------
  console.log('\n[5] 现状');
  console.log('  活动 ' + await Event.count() + ' | 场次 ' + await Session.count() +
    ' | 票种 ' + await TicketType.count());
  console.log('  嘉宾 ' + await Guest.count() + ' | 邀约 ' + await Invitation.count() +
    ' | 报名 ' + await Registration.count());
  console.log('  订单 ' + await Order.count() + ' | 流水 ' + await Payment.count());
  const t2 = await TicketType.findAll({ order: [['id', 'ASC']] });
  t2.forEach(t => console.log('    ' + t.name + '  总' + t.stock_total + ' 锁' + t.stock_locked + ' 售' + t.stock_sold));

  console.log('\n=== 完成 ===');
  process.exit(0);
})().catch(e => { console.error('ERR', e.stack); process.exit(2); });