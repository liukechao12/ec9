/**
 * EC9 订单服务（状态机 + 库存锁定/释放 + 超时关单）
 *
 * 状态机：
 *   pending_payment ──支付回调──> paid ──退款──> refunded
 *        │
 *        └──超时/手动关单──> closed
 *
 * 库存三层：
 *   stock_total 总量 / stock_locked 已锁（审核通过未付款）/ stock_sold 已售
 *   可用量 = total - locked - sold；审核通过下单即锁定，付款成功 locked→sold，
 *   关单/驳回/退款释放。
 */
const crypto = require('crypto');
const config = require('../config');
const { Op } = require('sequelize');
const {
  Order, ORDER_STATUS,
  Registration, REG_STATUS,
  Session, TicketType, Event, CheckinCode, Guest
} = require('../models');
const { decryptPhone } = require('../utils/phoneCrypto');
const { resolveSessionForRegistration } = require('./ticketBinding');
const sms = require('./verificationSmsService');

/** 订单号：EC9 + 年月日时分秒 + 6 位随机 */
function genOrderNo() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return 'EC9' + ts + String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function yuanToFen(y) { return Math.round(Number(y) * 100); }
function fenToYuan(f) { return (Number(f) / 100).toFixed(2); }

function genCheckinCode() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

/**
 * 创建订单（审核通过后调用；unitPrice 为审核环节指定价，优先级最高）
 * @param {number} registrationId
 * @param {{quantity?:number, unitPrice?:number|null, remark?:string}} opts
 */
async function createOrder(registrationId, opts = {}) {
  const quantity = Math.max(1, parseInt(opts.quantity) || 1);
  const sequelize = Order.sequelize;
  const t = await sequelize.transaction();
  try {
    const reg = await Registration.findByPk(registrationId, {
      include: [
        { model: Event, as: 'event' },
        { model: TicketType, as: 'ticketType' },
        { model: Session, as: 'session' }
      ],
      transaction: t
    });
    if (!reg) { await t.rollback(); return { ok: false, error: '报名记录不存在' }; }
    // 行锁防并发重复建单：PG 不允许对 outer join 的可空侧 FOR UPDATE，单独锁主表行
    await Registration.findByPk(registrationId, { transaction: t, lock: true });
    // 口径：审核通过才建单锁库存（pending_audit 未过审不能占库存）
    if (reg.status !== REG_STATUS.APPROVED) {
      await t.rollback();
      return { ok: false, error: `报名状态不可创建订单：${reg.status}` };
    }

    // 幂等：同一报名已有「待付款」订单 → 复用，不重复锁库存
    // H5 重复进支付页 / 刷新 / 断网重试都会再打一次建单接口，
    // 不复用会锁双倍库存并产生孤儿订单（支付完另一单仍是待付款）。
    const dup = await Order.findOne({
      where: { registration_id: reg.id, status: ORDER_STATUS.PENDING_PAYMENT },
      order: [['id', 'DESC']],
      transaction: t, lock: true
    });
    if (dup) {
      const stillValid = !dup.expire_at || new Date(dup.expire_at).getTime() > Date.now();
      if (stillValid && Number(dup.quantity) === quantity) {
        await t.commit();
        return { ok: true, order: dup, reused: true };
      }
      // 已过期或数量变了：就地关掉旧单释放库存。
      // 不走 closeOrder() —— 那个会把报名记录置成 closed，用户就再也下不了单。
      dup.status = ORDER_STATUS.CLOSED;
      dup.closed_at = new Date();
      dup.remark = stillValid ? '重新下单（数量变更，自动关闭原单）' : '超时未付款自动关闭';
      await dup.save({ transaction: t });
      const dupTt = await TicketType.findByPk(dup.ticket_type_id, { transaction: t, lock: true });
      if (dupTt) await dupTt.decrement('stock_locked', { by: dup.quantity, transaction: t });
      if (dup.session_id && Number(dup.session_id) > 0) {
        const dupSs = await Session.findByPk(dup.session_id, { transaction: t, lock: true });
        if (dupSs) await dupSs.decrement('stock_locked', { by: dup.quantity, transaction: t });
      }
    }

    const tt = reg.ticketType;
    if (!tt || !Number(tt.on_shelf)) { await t.rollback(); return { ok: false, error: '票种不存在或已下架' }; }

    // 规则 A：报名的场次必须与票种适用场次一致（场次票必须选对应场次）
    const bind = await resolveSessionForRegistration(reg);
    if (!bind.ok) {
      await t.rollback();
      return { ok: false, error: bind.error, code: bind.code };
    }

    // 价格三级：指定价 > 票种售价 > 原价
    let unitPrice;
    if (opts.unitPrice !== undefined && opts.unitPrice !== null && opts.unitPrice !== '') {
      unitPrice = Number(opts.unitPrice);
    } else if (Number(tt.price) > 0) {
      unitPrice = Number(tt.price);
    } else {
      unitPrice = Number(tt.original_price || 0);
    }
    const totalAmount = unitPrice * quantity;

    // 库存校验（行锁防并发超卖）
    const ttLocked = await TicketType.findByPk(tt.id, { transaction: t, lock: true });
    const available = Number(ttLocked.stock_total) - Number(ttLocked.stock_locked) - Number(ttLocked.stock_sold);
    if (available < quantity) {
      await t.rollback();
      return { ok: false, error: '票种库存不足', available };
    }

    let sessLocked = null;
    if (reg.session_id && Number(reg.session_id) > 0) {
      sessLocked = await Session.findByPk(reg.session_id, { transaction: t, lock: true });
      if (sessLocked) {
        const sAvail = Number(sessLocked.stock_total) - Number(sessLocked.stock_locked) - Number(sessLocked.stock_sold);
        if (sAvail < quantity) {
          await t.rollback();
          return { ok: false, error: '场次席位不足', available: sAvail };
        }
      }
    }

    const expireHours = Number(reg.event && reg.event.pay_expire_hours) || 48;
    const expireAt = new Date(Date.now() + expireHours * 3600000);

    const order = await Order.create({
      order_no: genOrderNo(),
      registration_id: reg.id,
      guest_id: reg.guest_id,
      event_id: reg.event_id,
      session_id: reg.session_id || 0,
      ticket_type_id: tt.id,
      quantity,
      unit_price: unitPrice.toFixed(2),
      total_amount: totalAmount.toFixed(2),
      discount_amount: '0.00',
      final_amount: totalAmount.toFixed(2),
      status: ORDER_STATUS.PENDING_PAYMENT,
      expire_at: expireAt,
      remark: opts.remark || null
    }, { transaction: t });

    // 锁库存
    await ttLocked.increment('stock_locked', { by: quantity, transaction: t });
    if (sessLocked) await sessLocked.increment('stock_locked', { by: quantity, transaction: t });

    await t.commit();
    return { ok: true, order };
  } catch (e) {
    await t.rollback();
    return { ok: false, error: e.message };
  }
}

/**
 * 支付成功（回调驱动）：订单 → paid，库存 locked→sold，报名 → paid，确保签到码，发短信
 */
async function markPaid(orderId, { transaction_id = null, prepay_id = null, paid_at = null } = {}) {
  const sequelize = Order.sequelize;
  const t = await sequelize.transaction();
  try {
    const order = await Order.findByPk(orderId, { transaction: t, lock: true });
    if (!order) { await t.rollback(); return { ok: false, error: '订单不存在' }; }
    if (order.status === ORDER_STATUS.PAID) { await t.rollback(); return { ok: true, order, idempotent: true }; }
    if (order.status !== ORDER_STATUS.PENDING_PAYMENT) {
      await t.rollback(); return { ok: false, error: `订单状态不允许支付：${order.status}` };
    }

    order.status = ORDER_STATUS.PAID;
    order.paid_at = paid_at || new Date();
    await order.save({ transaction: t });

    // ===== 多人代报订单：按 price_detail 逐票种流转库存 + 全员 paid + 全员入场码 =====
    if (order.group_no) {
      const groupSvc = require('./groupOrderService');
      await groupSvc.sellGroupStock(order, { transaction: t });
      const groupResults = await groupSvc.markGroupPaid(order, { transaction: t });
      await t.commit();
      // 全员订票成功短信（事务外，失败不阻塞）
      try { await groupSvc.sendGroupPaidSms(order); } catch (e) { /* ignore */ }
      const first = groupResults.find(x => x.registration_id === order.registration_id) || groupResults[0];
      return { ok: true, order, checkinCode: first ? first.checkin_code : null, group: groupResults };
    }

    // 库存 locked → sold
    const tt = await TicketType.findByPk(order.ticket_type_id, { transaction: t, lock: true });
    if (tt) {
      await tt.increment('stock_sold', { by: order.quantity, transaction: t });
      await tt.decrement('stock_locked', { by: order.quantity, transaction: t });
    }
    if (order.session_id && Number(order.session_id) > 0) {
      const ss = await Session.findByPk(order.session_id, { transaction: t, lock: true });
      if (ss) {
        await ss.increment('stock_sold', { by: order.quantity, transaction: t });
        await ss.decrement('stock_locked', { by: order.quantity, transaction: t });
      }
    }

    // 报名记录 → paid
    const reg = await Registration.findByPk(order.registration_id, { transaction: t });
    if (reg) {
      reg.status = REG_STATUS.PAID;
      await reg.save({ transaction: t });
    }

    // 签到码：付费票付款成功才生效
    let code = await CheckinCode.findOne({ where: { registration_id: order.registration_id }, transaction: t });
    if (!code) {
      code = await CheckinCode.create({
        registration_id: order.registration_id,
        guest_id: order.guest_id,
        event_id: order.event_id,
        code: genCheckinCode(),
        status: 'active',
        generated_at: new Date()
      }, { transaction: t });
    } else if (code.status !== 'active') {
      code.status = 'active';
      await code.save({ transaction: t });
    }

    await t.commit();

    // 短信通知（事务外，失败不阻塞）
    try {
      const guest = reg && reg.guest_id ? await Guest.findByPk(reg.guest_id) : null;
      if (guest && guest.phone) {
        const phone = decryptPhone(guest.phone);
        const event = await Event.findByPk(order.event_id);
        await sms.sendBusinessSms(phone, 'payment_success', {
          event: event ? event.name : '',
          code: code.code,
          url: `${config.frontend.baseUrl}/ticket.html?code=${code.code}`
        }, guest.lang || 'zh-CN');
      }
    } catch (e) { /* 短信失败不影响主流程 */ }

    return { ok: true, order, checkinCode: code.code };
  } catch (e) {
    await t.rollback();
    return { ok: false, error: e.message };
  }
}

/**
 * 关单（超时 / 手动）：pending_payment → closed，释放锁定库存
 */
async function closeOrder(orderId, reason = '超时未付款', operator = null) {
  const sequelize = Order.sequelize;
  const t = await sequelize.transaction();
  try {
    const order = await Order.findByPk(orderId, { transaction: t, lock: true });
    if (!order) { await t.rollback(); return { ok: false, error: '订单不存在' }; }
    if (order.status !== ORDER_STATUS.PENDING_PAYMENT) {
      await t.rollback(); return { ok: false, error: `订单状态不允许关闭：${order.status}` };
    }
    order.status = ORDER_STATUS.CLOSED;
    order.closed_at = new Date();
    order.remark = reason;
    await order.save({ transaction: t });

    // ===== 多人代报订单：按 price_detail 逐票种释放；全员回到 approved（可重新走付款） =====
    if (order.group_no) {
      await require('./groupOrderService').releaseGroupStock(order, { transaction: t });
      const regs = await Registration.findAll({ where: { group_no: order.group_no }, transaction: t });
      for (const r of regs) {
        if (r.status === REG_STATUS.APPROVED || r.status === REG_STATUS.PENDING_AUDIT) {
          r.status = REG_STATUS.APPROVED; // 关单不回退审核结果，仅释放占座
          await r.save({ transaction: t });
        }
      }
      await t.commit();
      return { ok: true, order };
    }

    const tt = await TicketType.findByPk(order.ticket_type_id, { transaction: t, lock: true });
    if (tt) await tt.decrement('stock_locked', { by: order.quantity, transaction: t });
    if (order.session_id && Number(order.session_id) > 0) {
      const ss = await Session.findByPk(order.session_id, { transaction: t, lock: true });
      if (ss) await ss.decrement('stock_locked', { by: order.quantity, transaction: t });
    }

    const reg = await Registration.findByPk(order.registration_id, { transaction: t });
    if (reg && (reg.status === REG_STATUS.APPROVED || reg.status === REG_STATUS.PENDING_AUDIT)) {
      reg.status = REG_STATUS.CLOSED;
      await reg.save({ transaction: t });
    }
    await t.commit();
    return { ok: true, order };
  } catch (e) {
    await t.rollback();
    return { ok: false, error: e.message };
  }
}

/**
 * 退款：paid → refunded，库存 sold 回退，报名 → cancelled，签到码撤销
 */
async function refundOrder(orderId, reason = '申请退款') {
  const sequelize = Order.sequelize;
  const t = await sequelize.transaction();
  try {
    const order = await Order.findByPk(orderId, { transaction: t, lock: true });
    if (!order) { await t.rollback(); return { ok: false, error: '订单不存在' }; }
    if (order.status !== ORDER_STATUS.PAID) {
      await t.rollback(); return { ok: false, error: `订单状态不允许退款：${order.status}` };
    }
    order.status = ORDER_STATUS.REFUNDED;
    order.refunded_at = new Date();
    order.remark = reason;
    await order.save({ transaction: t });

    const tt = await TicketType.findByPk(order.ticket_type_id, { transaction: t, lock: true });
    if (tt) await tt.decrement('stock_sold', { by: order.quantity, transaction: t });
    if (order.session_id && Number(order.session_id) > 0) {
      const ss = await Session.findByPk(order.session_id, { transaction: t, lock: true });
      if (ss) await ss.decrement('stock_sold', { by: order.quantity, transaction: t });
    }

    const reg = await Registration.findByPk(order.registration_id, { transaction: t });
    if (reg) {
      reg.status = REG_STATUS.CANCELLED;
      await reg.save({ transaction: t });
    }
    const code = await CheckinCode.findOne({ where: { registration_id: order.registration_id }, transaction: t });
    if (code && code.status === 'active') {
      code.status = 'revoked';
      await code.save({ transaction: t });
    }
    await t.commit();
    return { ok: true, order };
  } catch (e) {
    await t.rollback();
    return { ok: false, error: e.message };
  }
}

/** 扫描超时未付订单并关单 */
async function scanExpiredOrders() {
  const expired = await Order.findAll({
    where: {
      status: ORDER_STATUS.PENDING_PAYMENT,
      expire_at: { [Op.lt]: new Date() }
    },
    limit: 100
  });
  const results = [];
  for (const o of expired) {
    const r = await closeOrder(o.id, '付款超时自动关单');
    results.push({ orderNo: o.order_no, ok: r.ok, error: r.error });
  }
  return results;
}

/** 启动超时关单扫描器（每 60 秒） */
function startExpireScanner() {
  setInterval(async () => {
    try {
      const closed = await scanExpiredOrders();
      if (closed.length) console.log(`[订单] 超时关单 ${closed.length} 笔:`, closed.map(c => c.orderNo).join(','));
    } catch (e) {
      console.error('[订单] 超时扫描失败:', e.message);
    }
  }, 60000);
  console.log('[订单] 超时关单扫描器已启动（60s 间隔）');
}

module.exports = {
  genOrderNo, yuanToFen, fenToYuan,
  createOrder, markPaid, closeOrder, refundOrder,
  scanExpiredOrders, startExpireScanner
};
