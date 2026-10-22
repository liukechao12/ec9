/**
 * EC9 票种管理后台接口
 *
 *   GET    /api/ticket-types            列表（按会议 / 场次 / 上下架过滤）
 *   GET    /api/ticket-types/:id        详情（含售卖统计）
 *   POST   /api/ticket-types            新建票种
 *   PUT    /api/ticket-types/:id        更新票种（含加库存）
 *   DELETE /api/ticket-types/:id        删除票种（已售不可删）
 *   POST   /api/ticket-types/:id/shelf  上架 / 下架
 *   POST   /api/ticket-types/:id/stock  追加库存
 *   POST   /api/ticket-types/reorder    批量排序
 *
 * 票种 = 售卖单位（早鸟票 / 全程票 / 晚宴票 …），绑定会议 + 可选场次。
 * EC8 的门票只是一条记录，EC9 升级为「票种 + 场次 + 三层库存」。
 *
 * 库存三层：total 总量 / locked 下单未支付占用 / sold 已支付售出。
 *   可售 = total - locked - sold
 */
const express = require('express');
const router = express.Router();
const { Op, TicketType, Session, Order, Order: OrderModel } = require('../models');
const { authenticate, authorize } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');
const { buildI18nTree } = require('./_i18nTree');
const { validateTicketSession } = require('../services/ticketBinding');
const { ORDER_STATUS } = require('../models/Order');

const TT_I18N_FIELDS = ['name', 'description'];

/** 可售 = 总量 - 锁定 - 已售 */
function available(row) {
  return Number(row.stock_total || 0) - Number(row.stock_locked || 0) - Number(row.stock_sold || 0);
}

function buildTicketI18n(body) {
  return buildI18nTree(body.i18n, body, TT_I18N_FIELDS);
}

function toNumber(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  return Number.isNaN(n) ? def : n;
}

/** 校验价格：不能为负，原价不能低于现价 */
function checkPrice(price, originalPrice) {
  const p = toNumber(price, 0);
  if (p < 0) return { ok: false, error: '售价不能为负' };
  if (originalPrice !== undefined && originalPrice !== null && originalPrice !== '') {
    const op = Number(originalPrice);
    if (Number.isNaN(op) || op < 0) return { ok: false, error: '原价不合法' };
    if (op < p) return { ok: false, error: '原价不能低于售价' };
  }
  return { ok: true };
}

// ========== 列表 ==========
router.get('/', authenticate, async (req, res) => {
  try {
    const { event_id, session_id, on_shelf, status, keyword, page = 1, pageSize = 100 } = req.query;
    const where = {};
    if (event_id) where.event_id = event_id;
    if (session_id !== undefined && session_id !== '') where.session_id = session_id;
    if (on_shelf !== undefined && on_shelf !== '') where.on_shelf = on_shelf;
    if (status !== undefined && status !== '') where.status = status;
    if (keyword) {
      where[Op.or] = [
        { name: { [Op.like]: `%${keyword}%` } },
        { description: { [Op.like]: `%${keyword}%` } }
      ];
    }
    const limit = Math.min(toNumber(pageSize, 100), 500);
    const offset = (Math.max(toNumber(page, 1), 1) - 1) * limit;

    const { rows, count } = await TicketType.findAndCountAll({
      where, order: [['sort', 'ASC'], ['id', 'ASC']], limit, offset
    });

    // 附带场次名，省一次前端请求
    const sids = [...new Set(rows.map(r => r.session_id).filter(x => Number(x) > 0))];
    const sessions = sids.length
      ? await Session.findAll({ where: { id: { [Op.in]: sids } }, attributes: ['id', 'name'] })
      : [];
    const sMap = {};
    sessions.forEach(s => { sMap[s.id] = s.name; });

    const list = rows.map(r => ({
      ...r.get(),
      session_name: Number(r.session_id) > 0 ? (sMap[r.session_id] || '') : '全部场次',
      stock_available: available(r)
    }));

    res.json({
      code: 0, message: 'ok',
      data: { list, total: count, page: toNumber(page, 1), pageSize: limit }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 详情 ==========
router.get('/:id(\\d+)', authenticate, async (req, res) => {
  try {
    const tt = await TicketType.findByPk(req.params.id);
    if (!tt) return res.status(404).json({ code: 404, message: '票种不存在' });

    const session = Number(tt.session_id) > 0 ? await Session.findByPk(tt.session_id) : null;

    // 售卖情况汇总
    const paidCount = await Order.count({
      where: { ticket_type_id: tt.id, status: ORDER_STATUS.PAID }
    });
    const pendingCount = await Order.count({
      where: { ticket_type_id: tt.id, status: ORDER_STATUS.PENDING_PAYMENT }
    });
    const revenue = await Order.sum('final_amount', {
      where: { ticket_type_id: tt.id, status: ORDER_STATUS.PAID }
    });

    res.json({
      code: 0, message: 'ok',
      data: {
        ...tt.get(),
        stock_available: available(tt),
        session_name: session ? session.name : '全部场次',
        sales: {
          paid_orders: paidCount,
          pending_orders: pendingCount,
          paid_revenue: Number(revenue || 0)
        }
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 新建 ==========
router.post('/', authenticate, operationLog('ticket_types', '新建票种'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.event_id) return res.status(400).json({ code: 400, message: '缺少 event_id' });
    if (!b.name || !String(b.name).trim()) {
      return res.status(400).json({ code: 400, message: '票种名称不能为空' });
    }

    const priceCheck = checkPrice(b.price, b.original_price);
    if (!priceCheck.ok) return res.status(400).json({ code: 400, message: priceCheck.error });

    const sessionId = toNumber(b.session_id, 0);
    const bind = await validateTicketSession(b.event_id, sessionId);
    if (!bind.ok) return res.status(400).json({ code: 400, message: bind.error, errorCode: bind.code });

    const stockTotal = toNumber(b.stock_total, 0);
    if (stockTotal < 0) return res.status(400).json({ code: 400, message: '库存不能为负' });

    const limit = toNumber(b.per_order_limit, 1);
    if (limit < 1) return res.status(400).json({ code: 400, message: '每单限购不能小于 1' });

    const row = await TicketType.create({
      event_id: b.event_id,
      session_id: sessionId,
      name: String(b.name).trim(),
      i18n: buildTicketI18n(b),
      description: b.description || null,
      price: toNumber(b.price, 0),
      original_price: (b.original_price === undefined || b.original_price === '' || b.original_price === null)
        ? null : toNumber(b.original_price, 0),
      stock_total: stockTotal,
      per_order_limit: limit,
      on_shelf: b.on_shelf !== undefined ? b.on_shelf : 1,
      product_type: b.product_type || 'ticket',
      coupon_enabled: b.coupon_enabled !== undefined ? b.coupon_enabled : 0,
      sort: toNumber(b.sort, 0),
      status: b.status !== undefined ? b.status : 1
    });

    res.json({ code: 0, message: '创建成功', data: { ...row.get(), stock_available: available(row) } });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 更新 ==========
router.put('/:id', authenticate, operationLog('ticket_types', '更新票种'), async (req, res) => {
  try {
    const tt = await TicketType.findByPk(req.params.id);
    if (!tt) return res.status(404).json({ code: 404, message: '票种不存在' });

    const b = req.body || {};

    // 价格校验（合并新旧值一起判断）
    const priceCheck = checkPrice(
      b.price !== undefined ? b.price : tt.price,
      b.original_price !== undefined ? b.original_price : tt.original_price
    );
    if (!priceCheck.ok) return res.status(400).json({ code: 400, message: priceCheck.error });

    if (b.name !== undefined) {
      if (!String(b.name).trim()) return res.status(400).json({ code: 400, message: '票种名称不能为空' });
      tt.name = String(b.name).trim();
    }
    if (b.i18n !== undefined) tt.i18n = buildTicketI18n(b);
    if (b.description !== undefined) tt.description = b.description || null;
    if (b.price !== undefined) tt.price = toNumber(b.price, tt.price);
    if (b.original_price !== undefined) {
      tt.original_price = b.original_price === null || b.original_price === '' ? null : toNumber(b.original_price, 0);
    }
    if (b.session_id !== undefined) {
      const sid = toNumber(b.session_id, 0);
      // event_id 以库里为准（允许改归属活动，但场次必须跟着换）
      const bind = await validateTicketSession(b.event_id !== undefined ? b.event_id : tt.event_id, sid);
      if (!bind.ok) return res.status(400).json({ code: 400, message: bind.error, errorCode: bind.code });
      tt.session_id = sid;
    } else if (b.event_id !== undefined && Number(b.event_id) !== Number(tt.event_id)) {
      // 只改归属活动、没动场次：已有场次必须也属于新活动，否则留下脏绑定
      const keep = await validateTicketSession(b.event_id, tt.session_id);
      if (!keep.ok) return res.status(400).json({ code: 400, message: keep.error, errorCode: keep.code });
      tt.event_id = b.event_id;
    }
    if (b.per_order_limit !== undefined) {
      const lim = toNumber(b.per_order_limit, tt.per_order_limit);
      if (lim < 1) return res.status(400).json({ code: 400, message: '每单限购不能小于 1' });
      tt.per_order_limit = lim;
    }
    if (b.sort !== undefined) tt.sort = toNumber(b.sort, 0);
    if (b.status !== undefined) tt.status = b.status;
    if (b.on_shelf !== undefined) tt.on_shelf = b.on_shelf;
    if (b.product_type !== undefined) tt.product_type = b.product_type;
    if (b.coupon_enabled !== undefined) tt.coupon_enabled = b.coupon_enabled;

    // 库存：允许调整，但不能调到低于 locked + sold
    if (b.stock_total !== undefined) {
      const next = toNumber(b.stock_total, tt.stock_total);
      const used = Number(tt.stock_locked || 0) + Number(tt.stock_sold || 0);
      if (next < 0) return res.status(400).json({ code: 400, message: '库存不能为负' });
      if (next < used) {
        return res.status(400).json({
          code: 400,
          message: `库存不能小于已占用数量（锁定 ${tt.stock_locked} + 已售 ${tt.stock_sold}）`
        });
      }
      tt.stock_total = next;
    }

    await tt.save();
    res.json({ code: 0, message: '更新成功', data: { ...tt.get(), stock_available: available(tt) } });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 删除 ==========
router.delete('/:id', authenticate, operationLog('ticket_types', '删除票种'), async (req, res) => {
  try {
    const tt = await TicketType.findByPk(req.params.id);
    if (!tt) return res.status(404).json({ code: 404, message: '票种不存在' });

    const used = Number(tt.stock_locked || 0) + Number(tt.stock_sold || 0);
    if (used > 0) {
      return res.status(400).json({ code: 400, message: `该票种已产生 ${used} 张占用，请改为下架` });
    }

    await tt.destroy();
    res.json({ code: 0, message: '删除成功' });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 上架 / 下架 ==========
router.post('/:id/shelf', authenticate, operationLog('ticket_types', '票种上下架'), async (req, res) => {
  try {
    const tt = await TicketType.findByPk(req.params.id);
    if (!tt) return res.status(404).json({ code: 404, message: '票种不存在' });

    const next = req.body && req.body.on_shelf !== undefined
      ? (Number(req.body.on_shelf) ? 1 : 0)
      : (tt.on_shelf === 1 ? 0 : 1);

    // 上架前必须还有可售库存
    if (next === 1 && available(tt) <= 0) {
      return res.status(400).json({ code: 400, message: '可售库存为 0，无法上架' });
    }

    tt.on_shelf = next;
    await tt.save();
    res.json({ code: 0, message: next === 1 ? '已上架' : '已下架', data: tt });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 追加库存 ==========
router.post('/:id/stock', authenticate, authorize('admin'), operationLog('ticket_types', '调整票种库存'), async (req, res) => {
  try {
    const tt = await TicketType.findByPk(req.params.id);
    if (!tt) return res.status(404).json({ code: 404, message: '票种不存在' });

    const delta = Number(req.body && req.body.delta);
    if (Number.isNaN(delta) || delta === 0) {
      return res.status(400).json({ code: 400, message: 'delta 必须是非零数字（可正可负）' });
    }
    const next = Number(tt.stock_total || 0) + delta;
    const used = Number(tt.stock_locked || 0) + Number(tt.stock_sold || 0);
    if (next < 0) return res.status(400).json({ code: 400, message: '库存不能为负' });
    if (next < used) {
      return res.status(400).json({ code: 400, message: `库存不能低于已占用数量（锁定 ${tt.stock_locked} + 已售 ${tt.stock_sold}）` });
    }

    tt.stock_total = next;
    await tt.save();
    res.json({
      code: 0,
      message: `库存已${delta > 0 ? '增加' : '减少'} ${Math.abs(delta)}`,
      data: { ...tt.get(), stock_available: available(tt) }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 批量排序 ==========
router.post('/reorder', authenticate, authorize('admin'), async (req, res) => {
  try {
    const items = (req.body && req.body.items) || [];
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ code: 400, message: '缺少 items' });
    }
    for (const it of items) {
      if (!it.id) continue;
      await TicketType.update({ sort: toNumber(it.sort, 0) }, { where: { id: it.id } });
    }
    res.json({ code: 0, message: '排序已保存' });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

module.exports = router;
