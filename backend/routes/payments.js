/**
 * EC9 支付流水后台接口（对账用）
 *
 *   GET  /api/payments            流水列表（状态/渠道/会议/订单号/时间范围/分页）
 *   GET  /api/payments/summary    对账汇总（收款/退款笔数与金额）
 *   GET  /api/payments/reconcile  逐笔对账：微信侧应有 vs 本地实收，标出差异
 *   GET  /api/payments/:id        单笔详情（含微信原始回调报文）
 *
 * 与 /api/payment 的分工：
 *   /api/payment  = H5 侧下单 + 微信回调（交易链路）
 *   /api/payments = 后台侧查账对账（管理链路，只读 + 汇总）
 */
const express = require('express');
const router = express.Router();
const { Op, fn, col, Payment, Order, Guest, Event } = require('../models');
const { authenticate } = require('../middleware/auth');
const { decryptPhone, maskPhone } = require('../utils/phoneCrypto');

function toNum(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  return Number.isNaN(n) ? def : n;
}

/**
 * 支付状态口径：
 *   created   已下单未付
 *   success   支付成功
 *   refunded  已退款
 *   failed    支付失败
 */
function buildWhere(q) {
  const where = {};
  if (q.status) where.status = q.status;
  if (q.channel) where.channel = q.channel;
  if (q.keyword) where.out_trade_no = { [Op.like]: `%${q.keyword}%` };
  if (q.transaction_id) where.transaction_id = q.transaction_id;
  if (q.start || q.end) {
    const range = {};
    if (q.start) range[Op.gte] = new Date(q.start);
    if (q.end) range[Op.lte] = new Date(q.end);
    where.created_at = range;
  }
  // ⚠️ ec9_payments 没有 event_id 列（票务字段在 ec9_orders 上），
  //    按会议筛必须走 order_id，见 narrowByEvent
  return where;
}

/**
 * 按会议收敛：ec9_payments 无 event_id，需先查该会议下的订单 id 再 IN 过滤。
 * 空集合时用不可能命中的值，避免 IN () 造成语法错。
 */
async function narrowByEvent(where, eventId) {
  if (!eventId) return where;
  const orders = await Order.findAll({ where: { event_id: eventId }, attributes: ['id'], raw: true });
  const ids = orders.map(o => o.id);
  where.order_id = ids.length ? { [Op.in]: ids } : { [Op.in]: [0] };
  return where;
}

/**
 * 附加订单与嘉宾信息
 * ⚠️ 必须 { plain: true }：Sequelize 实例 set() 会丢弃模型未声明的字段
 */
async function attachContext(rows, withPhone) {
  if (!rows.length) return;
  const orderIds = [...new Set(rows.map(r => r.order_id).filter(Boolean))];
  const orders = orderIds.length
    ? await Order.findAll({ where: { id: { [Op.in]: orderIds } }, raw: true })
    : [];
  const oMap = {};
  orders.forEach(o => { oMap[o.id] = o; });

  const guestIds = [...new Set(orders.map(o => o.guest_id).filter(Boolean))];
  const guests = guestIds.length
    ? await Guest.findAll({
      where: { id: { [Op.in]: guestIds } },
      attributes: ['id', 'name', 'phone'],
      raw: true
    })
    : [];
  const gMap = {};
  guests.forEach(g => { gMap[g.id] = g; });

  rows.forEach(r => {
    const o = oMap[r.order_id] || null;
    const g = o ? gMap[o.guest_id] : null;
    const phone = g ? decryptPhone(g.phone) : null;
    r.event_id = o ? o.event_id : null;
    r.order_status = o ? o.status : null;
    r.quantity = o ? o.quantity : null;
    r.guest_name = g ? g.name : '';
    r.guest_phone_masked = maskPhone(phone);
    if (withPhone) r.guest_phone_plain = phone;
  });
}

// ========== 流水列表 ==========
router.get('/', authenticate, async (req, res) => {
  try {
    const q = req.query || {};
    const page = Math.max(toNum(q.page, 1), 1);
    const pageSize = Math.min(toNum(q.pageSize, 20), 200);
    const offset = (page - 1) * pageSize;

    const where = await narrowByEvent(buildWhere(q), q.event_id);

    const { rows, count } = await Payment.findAndCountAll({
      where, order: [['id', 'DESC']], limit: pageSize, offset, raw: true
    });
    await attachContext(rows, false);

    // 当前筛选条件下的收款 / 退款合计
    const successSum = await Payment.sum('amount', { where: Object.assign({}, where, { status: 'success' }) });
    const refundSum = await Payment.sum('amount', { where: Object.assign({}, where, { status: 'refunded' }) });
    const successCnt = await Payment.count({ where: Object.assign({}, where, { status: 'success' }) });
    const refundCnt = await Payment.count({ where: Object.assign({}, where, { status: 'refunded' }) });

    res.json({
      code: 0, message: 'ok',
      data: {
        list: rows,
        total: count,
        page, pageSize,
        summary: {
          success_count: successCnt,
          success_amount: Number(successSum || 0),
          refund_count: refundCnt,
          refund_amount: Number(refundSum || 0),
          net_amount: Number(successSum || 0) - Number(refundSum || 0)
        }
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 对账汇总（必须在 /:id 之前） ==========
router.get('/summary', authenticate, async (req, res) => {
  try {
    const where = await narrowByEvent(buildWhere(req.query || {}), req.query.event_id);

    const rows = await Payment.findAll({
      where,
      attributes: ['status', [fn('COUNT', col('id')), 'cnt'], [fn('SUM', col('amount')), 'amount']],
      group: ['status'],
      raw: true
    });

    const map = {};
    rows.forEach(r => { map[r.status] = { count: Number(r.cnt || 0), amount: Number(r.amount || 0) }; });
    const s = map.success || { count: 0, amount: 0 };
    const r = map.refunded || { count: 0, amount: 0 };

    res.json({
      code: 0, message: 'ok',
      data: {
        by_status: map,
        success: s,
        refunded: r,
        net_revenue: Number((s.amount - r.amount).toFixed(2))
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 逐笔对账（必须在 /:id 之前）
 *
 * 口径：以订单为基准，看每笔订单的支付流水状态是否与订单状态自洽。
 * 差异类型：
 *   order_paid_no_payment  订单已支付但没有成功流水 → 严重（钱收了没入账）
 *   payment_success_order_not_paid  流水成功但订单未支付 → 严重（回调丢失）
 *   amount_mismatch         流水金额 ≠ 订单实付 → 严重
 *   orphan_payment          流水指向不存在的订单 → 需人工核查
 */
router.get('/reconcile', authenticate, async (req, res) => {
  try {
    const q = req.query || {};
    const where = q.status ? { status: q.status } : {};
    const limit = Math.min(toNum(q.limit, 200), 1000);

    const payments = await Payment.findAll({ order: [['id', 'DESC']], limit, where });
    const orderIds = [...new Set(payments.map(p => p.order_id))];
    const orders = orderIds.length
      ? await Order.findAll({ where: { id: { [Op.in]: orderIds } } })
      : [];
    const oMap = {};
    orders.forEach(o => { oMap[o.id] = o; });

    const issues = [];
    payments.forEach(p => {
      const o = oMap[p.order_id];
      if (!o) {
        issues.push({ type: 'orphan_payment', level: 'warn', payment_id: p.id, out_trade_no: p.out_trade_no, message: '流水指向的订单不存在' });
        return;
      }
      if (o.status === 'paid' && p.status !== 'success') {
        issues.push({ type: 'order_paid_no_payment', level: 'error', payment_id: p.id, order_no: o.order_no, message: '订单已支付但无成功流水' });
      }
      if (o.status !== 'paid' && p.status === 'success') {
        issues.push({ type: 'payment_success_order_not_paid', level: 'error', payment_id: p.id, order_no: o.order_no, message: '流水成功但订单未标记已支付' });
      }
      if (p.status === 'success' && Math.abs(Number(p.amount) - Number(o.final_amount)) > 0.001) {
        issues.push({
          type: 'amount_mismatch', level: 'error', payment_id: p.id, order_no: o.order_no,
          payment_amount: Number(p.amount), order_amount: Number(o.final_amount),
          message: '流水金额与订单实付不一致'
        });
      }
    });

    res.json({
      code: 0, message: 'ok',
      data: {
        checked: payments.length,
        issue_count: issues.length,
        error_count: issues.filter(i => i.level === 'error').length,
        warn_count: issues.filter(i => i.level === 'warn').length,
        issues
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 单笔详情（放在最后） ==========
router.get('/:id(\\d+)', authenticate, async (req, res) => {
  try {
    const p = await Payment.findByPk(req.params.id);
    if (!p) return res.status(404).json({ code: 404, message: '支付流水不存在' });

    const order = await Order.findByPk(p.order_id);
    let guest = null;
    let event = null;
    if (order) {
      guest = await Guest.findByPk(order.guest_id);
      event = await Event.findByPk(order.event_id);
    }
    const phone = guest ? decryptPhone(guest.phone) : null;

    res.json({
      code: 0, message: 'ok',
      data: {
        ...p.get(),
        order: order ? {
          id: order.id, order_no: order.order_no, status: order.status,
          final_amount: Number(order.final_amount), quantity: order.quantity
        } : null,
        guest: guest ? {
          id: guest.id, name: guest.name, company: guest.company,
          phone_masked: maskPhone(phone), phone_plain: phone
        } : null,
        event_name: event ? event.name : '',
        // 微信原始回调报文（对账关键证据）
        notify_raw: p.notify_raw || null
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

module.exports = router;
