/**
 * EC9 订单管理后台接口
 *
 *   GET    /api/orders                列表（会议/状态/票种/场次/关键词/时间范围/分页）
 *   GET    /api/orders/summary        订单状态汇总 + 实收
 *   GET    /api/orders/export         导出 CSV
 *   GET    /api/orders/:id            详情（订单 + 报名 + 嘉宾 + 支付流水 + 签到码）
 *   PUT    /api/orders/:id/remark     加备注
 *   POST   /api/orders/:id/close      手动关单（释放锁定库存）
 *   POST   /api/orders/:id/refresh    向微信查单并同步状态
 *   POST   /api/orders/batch-close    批量关单
 *
 * 退款不在这里：走 POST /api/payment/refund（要与微信退款 API 强绑定）。
 *
 * ⚠️ 路由顺序：/summary 与 /export 必须写在 /:id 之前，否则被 '/:id' 吃掉。
 */
const express = require('express');
const router = express.Router();
const {
  Op, fn, col,
  Order, ORDER_STATUS, Payment, Guest, Event, TicketType, Session, Registration, CheckinCode
} = require('../models');
const { authenticate, authorize } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');
const orderService = require('../services/orderService');
const wechat = require('../services/wechatPayService');
const { decryptPhone, maskPhone } = require('../utils/phoneCrypto');

function toNum(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  return Number.isNaN(n) ? def : n;
}

function fmtTime(d) {
  if (!d) return '';
  const t = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

/**
 * 组装查询条件
 * 支持：event_id / status / ticket_type_id / session_id / guest_id / keyword / start / end / expired
 */
function buildWhere(q) {
  const where = {};
  if (q.event_id) where.event_id = q.event_id;
  if (q.status) where.status = q.status;
  if (q.ticket_type_id) where.ticket_type_id = q.ticket_type_id;
  if (q.session_id && toNum(q.session_id, 0) > 0) where.session_id = q.session_id;
  if (q.guest_id) where.guest_id = q.guest_id;
  if (q.keyword) where.order_no = { [Op.like]: `%${q.keyword}%` };
  if (q.start || q.end) {
    const range = {};
    if (q.start) range[Op.gte] = new Date(q.start);
    if (q.end) range[Op.lte] = new Date(q.end);
    where.created_at = range;
  }
  // expired=1：只看待付款且已过期（给「可关单」提示用）
  if (q.expired === '1' || q.expired === 'true') {
    where.status = ORDER_STATUS.PENDING_PAYMENT;
    where.expire_at = { [Op.lt]: new Date() };
  }
  return where;
}

/**
 * 附加嘉宾信息（默认手机号脱敏，withPhone=true 才给明文）
 *
 * ⚠️ 必须用 { plain: true } 查出普通对象再拼字段：
 *    Sequelize 实例的 set() 会丢弃「模型未声明」的属性（guest_info），
 *    挂在实例上 res.json 里就读不到了。
 */
async function attachGuests(rows, withPhone) {
  const gids = [...new Set(rows.map(r => r.guest_id).filter(Boolean))];
  if (!gids.length) return;
  const guests = await Guest.findAll({
    where: { id: { [Op.in]: gids } },
    attributes: ['id', 'name', 'company', 'phone', 'bd_id'],
    raw: true
  });
  const gMap = {};
  guests.forEach(g => {
    const phone = decryptPhone(g.phone);
    gMap[g.id] = {
      name: g.name,
      company: g.company,
      phone_masked: maskPhone(phone),
      bd_id: g.bd_id
    };
    if (withPhone) gMap[g.id].phone_plain = phone;
  });
  rows.forEach(r => { r.guest_info = gMap[r.guest_id] || null; });
}

/**
 * 附加票种名 / 场次名。
 * 列表页要直接显示这两列，省得前端为每行再发一次详情请求。
 */
async function attachNames(rows) {
  const ttIds = [...new Set(rows.map(r => r.ticket_type_id).filter(x => Number(x) > 0))];
  const sdIds = [...new Set(rows.map(r => r.session_id).filter(x => Number(x) > 0))];

  const [tts, sessions] = await Promise.all([
    ttIds.length ? TicketType.findAll({ where: { id: { [Op.in]: ttIds } }, attributes: ['id', 'name'] }) : [],
    sdIds.length ? Session.findAll({ where: { id: { [Op.in]: sdIds } }, attributes: ['id', 'name'] }) : []
  ]);
  const ttMap = {}; tts.forEach(t => { ttMap[t.id] = t.name; });
  const sMap = {}; sessions.forEach(s => { sMap[s.id] = s.name; });

  rows.forEach(r => {
    r.ticket_type_name = ttMap[r.ticket_type_id] || '';
    r.session_name = Number(r.session_id) > 0 ? (sMap[r.session_id] || '') : '全部场次';
  });
}


/**
 * POST /api/orders —— 为报名创建订单（锁库存）
 *
 * 之前只有 orderService.createOrder()，没有任何 HTTP 入口，
 * 导致「报名通过 → 建单 → 支付」这条链在接口层是断的：
 * H5 拿不到订单号，/api/payment/native 也就无从下单。
 *
 * 鉴权二选一：
 *   - 后台管理员（Bearer JWT）
 *   - 嘉宾本人（x-verify-token，手机号须与报名记录的嘉宾一致）
 *
 * body: { registration_id, quantity?, unit_price? }
 */
async function authAdminOrSelf(req, res, next) {
  const hasBearer = !!(req.headers.authorization && String(req.headers.authorization).startsWith('Bearer '));
  if (hasBearer) return require('../middleware/auth').authenticate(req, res, next);
  // 可复用版：建单不消费凭证，否则紧接着的 /api/payment/* 会 401（H5 支付链路依赖）
  return require('../middleware/requireVerified').requireVerifiedReusable(req, res, next);
}

router.post('/', authAdminOrSelf, async (req, res) => {
  try {
    const b = req.body || {};
    const regId = Number(b.registration_id || 0);
    if (!regId) return res.status(400).json({ code: 400, message: '缺少 registration_id' });

    const reg = await Registration.findByPk(regId, { include: [{ model: Guest, as: 'guest' }] });
    if (!reg) return res.status(404).json({ code: 404, message: '报名记录不存在' });

    // 嘉宾自助时必须校验归属，防止拿别人的报名建单
    if (req.verifiedPhoneHmac) {
      const g = await Guest.findByPk(reg.guest_id);
      if (!g || g.phone_hmac !== req.verifiedPhoneHmac) {
        return res.status(403).json({ code: 403, message: '报名记录与当前验证手机号不匹配' });
      }
    }

    const r = await orderService.createOrder(regId, {
      quantity: b.quantity,
      unitPrice: b.unit_price
    });
    if (!r.ok) return res.status(400).json({ code: 400, message: r.error, errorCode: r.code || null });

    res.json({ code: 0, message: '订单已创建', data: r.order || r });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 列表 ==========
router.get('/', authenticate, async (req, res) => {
  try {
    const q = req.query || {};
    const page = Math.max(toNum(q.page, 1), 1);
    const pageSize = Math.min(toNum(q.pageSize, 20), 200);
    const offset = (page - 1) * pageSize;
    const where = buildWhere(q);

    const { rows, count } = await Order.findAndCountAll({
      where, order: [['id', 'DESC']], limit: pageSize, offset, raw: true
    });

    await attachGuests(rows, false);
    await attachNames(rows);

    // 实收金额：只有筛到已支付（或不筛状态）时才统计，避免把待付款算成收入
    let paidSum = 0;
    const sumWhere = Object.assign({}, where);
    if (!sumWhere.status) sumWhere.status = ORDER_STATUS.PAID;
    if (sumWhere.status === ORDER_STATUS.PAID) {
      paidSum = await Order.sum('final_amount', { where: sumWhere });
    }

    // 各状态条数：给后台列表上方的四张统计卡片用
    const grouped = await Order.findAll({
      where,
      attributes: ['status', [fn('COUNT', col('id')), 'cnt']],
      group: ['status'],
      raw: true
    });
    const cntMap = {};
    grouped.forEach(g => { cntMap[g.status] = Number(g.cnt); });

    res.json({
      code: 0, message: 'ok',
      data: {
        list: rows,
        total: count,
        page, pageSize
      },
      summary: {
        total: count,
        paid_count: cntMap[ORDER_STATUS.PAID] || 0,
        pending_count: cntMap[ORDER_STATUS.PENDING_PAYMENT] || 0,
        closed_count: cntMap[ORDER_STATUS.CLOSED] || 0,
        refunded_count: cntMap[ORDER_STATUS.REFUNDED] || 0,
        paid_revenue: Number(paidSum || 0),
        sum_amount: Number(paidSum || 0)     // 兼容前端两种叫法
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 状态汇总（必须在 /:id 之前） ==========
router.get('/summary', authenticate, async (req, res) => {
  try {
    const where = buildWhere(req.query || {});
    const rows = await Order.findAll({
      where,
      attributes: ['status', [fn('COUNT', col('id')), 'cnt'], [fn('SUM', col('final_amount')), 'amount']],
      group: ['status'],
      raw: true
    });

    const map = {
      [ORDER_STATUS.PENDING_PAYMENT]: { count: 0, amount: 0 },
      [ORDER_STATUS.PAID]: { count: 0, amount: 0 },
      [ORDER_STATUS.CLOSED]: { count: 0, amount: 0 },
      [ORDER_STATUS.REFUNDED]: { count: 0, amount: 0 }
    };
    rows.forEach(r => {
      map[r.status] = { count: Number(r.cnt || 0), amount: Number(r.amount || 0) };
    });

    const paid = map[ORDER_STATUS.PAID];
    res.json({
      code: 0, message: 'ok',
      data: {
        pending_payment: map[ORDER_STATUS.PENDING_PAYMENT],
        paid,
        closed: map[ORDER_STATUS.CLOSED],
        refunded: map[ORDER_STATUS.REFUNDED],
        total_count: Object.values(map).reduce((s, v) => s + v.count, 0),
        paid_revenue: paid.amount
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 导出 CSV（必须在 /:id 之前） ==========
router.get('/export', authenticate, async (req, res) => {
  try {
    const where = buildWhere(req.query || {});
    const rows = await Order.findAll({ where, order: [['id', 'DESC']], limit: 20000, raw: true });
    await attachGuests(rows, false);

    const tts = await TicketType.findAll();
    const ttMap = {};
    tts.forEach(t => { ttMap[t.id] = t.name; });

    const STATUS_CN = {
      pending_payment: '待付款', paid: '已支付', closed: '已关闭', refunded: '已退款'
    };

    const header = ['订单号', '状态', '嘉宾', '公司', '手机', '票种', '数量', '单价', '实付金额', '下单时间', '支付时间'];
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const lines = [header.join(',')];
    rows.forEach(o => {
      lines.push([
        o.order_no,
        STATUS_CN[o.status] || o.status,
        o.guest_info ? o.guest_info.name : '',
        o.guest_info ? (o.guest_info.company || '') : '',
        o.guest_info ? (o.guest_info.phone_masked || '') : '',
        ttMap[o.ticket_type_id] || '',
        o.quantity,
        o.unit_price,
        o.final_amount,
        fmtTime(o.created_at),
        fmtTime(o.paid_at)
      ].map(esc).join(','));
    });

    // BOM：Excel 直接双击打开不乱码
    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="orders-${Date.now()}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 详情（放在最后） ==========
router.get('/:id(\\d+)', authenticate, async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ code: 404, message: '订单不存在' });

    const [event, tt, session, reg, guest, payment, code] = await Promise.all([
      Event.findByPk(order.event_id),
      TicketType.findByPk(order.ticket_type_id),
      Number(order.session_id) > 0 ? Session.findByPk(order.session_id) : null,
      Registration.findByPk(order.registration_id),
      Guest.findByPk(order.guest_id),
      Payment.findOne({ where: { order_id: order.id }, order: [['id', 'DESC']] }),
      CheckinCode.findOne({ where: { registration_id: order.registration_id } })
    ]);

    const phone = guest ? decryptPhone(guest.phone) : null;

    res.json({
      code: 0, message: 'ok',
      data: {
        ...order.get(),
        event_name: event ? event.name : '',
        ticket_type_name: tt ? tt.name : '',
        session_name: session ? session.name : '全部场次',
        guest: guest ? {
          id: guest.id, name: guest.name, company: guest.company,
          position: guest.position, bd_id: guest.bd_id,
          phone_masked: maskPhone(phone), phone_plain: phone
        } : null,
        registration: reg ? { id: reg.id, status: reg.status, form_data: reg.form_data } : null,
        payment: payment ? payment.get() : null,
        checkin_code: code ? { code: code.code, status: code.status } : null
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 加备注 ==========
router.put('/:id/remark', authenticate, operationLog('orders', '订单加备注'), async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ code: 404, message: '订单不存在' });
    order.remark = (req.body && req.body.remark) || null;
    await order.save();
    res.json({ code: 0, message: '备注已保存', data: order });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 手动关单 ==========
router.post('/:id/close', authenticate, operationLog('orders', '手动关闭订单'), async (req, res) => {
  try {
    const reason = (req.body && req.body.reason) || '后台手动关闭';
    const r = await orderService.closeOrder(req.params.id, reason, req.user);
    if (!r.ok) return res.status(400).json({ code: 400, message: r.error });
    res.json({ code: 0, message: '订单已关闭，锁定库存已释放', data: r.order });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 批量关单 ==========
router.post('/batch-close', authenticate, authorize('admin'), operationLog('orders', '批量关闭订单'), async (req, res) => {
  try {
    const ids = (req.body && req.body.ids) || [];
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ code: 400, message: '缺少 ids' });
    }
    const reason = (req.body && req.body.reason) || '后台批量关闭';
    const results = [];
    for (const id of ids) {
      const r = await orderService.closeOrder(id, reason, req.user);
      results.push({ id, ok: r.ok, error: r.error || '' });
    }
    const okCount = results.filter(r => r.ok).length;
    res.json({
      code: 0,
      message: `成功关闭 ${okCount} / ${ids.length} 笔`,
      data: { total: ids.length, success: okCount, results }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 向微信查单并同步 ==========
router.post('/:id/refresh', authenticate, async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ code: 404, message: '订单不存在' });
    if (order.status !== ORDER_STATUS.PENDING_PAYMENT) {
      return res.status(400).json({ code: 400, message: `订单当前状态为 ${order.status}，无需刷新` });
    }

    const result = await wechat.queryOrder(order.order_no);
    if (!result.ok) return res.status(500).json({ code: 500, message: result.error || '查单失败' });

    // 微信已支付 → 走正常支付成功流程（金额核对 + 幂等）
    if (result.tradeState === 'SUCCESS') {
      const paid = await orderService.markPaid(order.id, {
        transaction_id: result.transactionId,
        prepay_id: result.prepayId,
        paid_at: new Date()
      });
      if (!paid.ok) return res.status(500).json({ code: 500, message: paid.error });
      await Payment.update(
        { status: 'success', transaction_id: result.transactionId, paid_at: new Date() },
        { where: { out_trade_no: order.order_no } }
      );
      return res.json({ code: 0, message: '已同步为已支付', data: paid.order });
    }

    if (['CLOSED', 'REVOKED', 'PAYERROR'].indexOf(result.tradeState) >= 0) {
      const closed = await orderService.closeOrder(order.id, `微信侧已${result.tradeState}`);
      return res.json({
        code: 0,
        message: `微信侧状态：${result.tradeState}，本地已同步`,
        data: closed.order
      });
    }

    res.json({
      code: 0, message: '已查询',
      data: { trade_state: result.tradeState, status: order.status }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

module.exports = router;
