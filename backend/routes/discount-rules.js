/**
 * EC9 多人折扣阶梯规则（后台可配）
 *
 *   GET    /api/discount-rules?event_id=1   列表（按 min_qty 升序）
 *   PUT    /api/discount-rules              整表保存（后台表格改完一次性提交）
 *   POST   /api/discount-rules              新增单条
 *   PUT    /api/discount-rules/:id          更新单条
 *   DELETE /api/discount-rules/:id          删除单条
 *
 * 迁移前因背诵的是「>=3 张 9 折、>=5 张 8 折」，现在改成读 ec9_discount_rules，
 * 运营在后台改档位即时生效（不缓存，每次查表——表就几条行，成本可忽略）。
 *
 * 语义务必与 services/groupOrderService.js 的 calcDiscount 保持一致：
 *   张数 = 付费标准票张数；命中的 rate 只乘在标准票金额上。
 */
const express = require('express');
const router = express.Router();
const { DiscountRule, Event } = require('../models');
const { authenticate } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');

/** 对外最小字段（H5 端也照这个结构消费） */
function publicRule(r) {
  return {
    id: r.id,
    event_id: r.event_id,
    min_qty: Number(r.min_qty),
    rate: Number(r.rate),
    enabled: Number(r.enabled),
    sort: Number(r.sort),
    remark: r.remark || ''
  };
}

/**
 * 校验并规范化一条规则输入
 * @returns {{ok:true,row:object}|{ok:false,msg:string}}
 */
function normalize(body, eventId) {
  const minQty = Number(body.min_qty);
  const rate = Number(body.rate);
  if (!Number.isInteger(minQty) || minQty < 1) return { ok: false, msg: 'min_qty 必须是不小于 1 的整数' };
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1) return { ok: false, msg: 'rate 必须在 (0, 1] 区间，如 0.9 表示 9 折' };
  return {
    ok: true,
    row: {
      // id 非空表示更新已有行（整表保存时用于判断哪些要删）
      ...(body.id ? { id: Number(body.id) } : {}),
      event_id: Number(body.event_id) || eventId,
      min_qty: minQty,
      rate: Math.round(rate * 100) / 100,
      remark: body.remark == null ? '' : String(body.remark).slice(0, 200),
      enabled: body.enabled === undefined ? 1 : (Number(body.enabled) ? 1 : 0),
      sort: Number(body.sort) || 0
    }
  };
}

/** 列表 */
router.get('/', authenticate, async (req, res) => {
  try {
    const eventId = Number(req.query.event_id) || 1;
    const list = await DiscountRule.findAll({
      where: { event_id: eventId },
      order: [['min_qty', 'ASC'], ['id', 'ASC']]
    });
    res.json({ code: 0, message: 'ok', data: { list: list.map(publicRule) } });
  } catch (e) {
    res.json({ code: 500, message: e.message, data: null });
  }
});

/**
 * 整表保存：后台表格增删改成什么样，就以提交的数组为准
 * body: { event_id, list: [{id?, min_qty, rate, enabled, remark, sort}] }
 */
router.put('/', authenticate, operationLog('discount_rules', '保存折扣规则'), async (req, res) => {
  try {
    const eventId = Number(req.body.event_id) || 1;
    const raw = Array.isArray(req.body.list) ? req.body.list : null;
    if (!raw) return res.json({ code: 400, message: 'list 必须是数组', data: null });

    if (eventId) {
      const ev = await Event.findByPk(eventId);
      if (!ev) return res.json({ code: 404, message: '活动不存在', data: null });
    }

    const rows = [];
    for (const it of raw) {
      const n = normalize(it, eventId);
      if (!n.ok) return res.json({ code: 400, message: n.msg, data: null });
      rows.push(n.row);
    }
    // 同一 min_qty 不允许重复（否则命中哪条说不清）
    const seen = new Set();
    for (const r of rows) {
      if (seen.has(r.min_qty)) return res.json({ code: 400, message: `张数门槛 ${r.min_qty} 重复了`, data: null });
      seen.add(r.min_qty);
    }

    const keepIds = rows.filter(r => r.id).map(r => Number(r.id));
    await DiscountRule.destroy({
      where: {
        event_id: eventId,
        ...(keepIds.length ? { id: { [require('sequelize').Op.notIn]: keepIds } } : {})
      }
    });
    for (const { id, ...fields } of rows) {
      if (id) await DiscountRule.update(fields, { where: { id, event_id: eventId } });
      else await DiscountRule.create(fields);
    }

    const list = await DiscountRule.findAll({
      where: { event_id: eventId }, order: [['min_qty', 'ASC'], ['id', 'ASC']]
    });
    res.json({ code: 0, message: 'ok', data: { list: list.map(publicRule) } });
  } catch (e) {
    res.json({ code: 500, message: e.message, data: null });
  }
});

/** 新增单条 */
router.post('/', authenticate, operationLog('discount_rules', '新增折扣规则'), async (req, res) => {
  try {
    const eventId = Number(req.body.event_id) || 1;
    const n = normalize(req.body, eventId);
    if (!n.ok) return res.json({ code: 400, message: n.msg, data: null });
    const dup = await DiscountRule.findOne({ where: { event_id: eventId, min_qty: n.row.min_qty } });
    if (dup) return res.json({ code: 400, message: `已存在「${n.row.min_qty} 张」的档位`, data: null });
    const row = await DiscountRule.create(n.row);
    res.json({ code: 0, message: 'ok', data: { rule: publicRule(row) } });
  } catch (e) {
    res.json({ code: 500, message: e.message, data: null });
  }
});

/** 更新单条 */
router.put('/:id', authenticate, operationLog('discount_rules', '更新折扣规则'), async (req, res) => {
  try {
    const row = await DiscountRule.findByPk(req.params.id);
    if (!row) return res.json({ code: 404, message: '规则不存在', data: null });
    const n = normalize(Object.assign({ event_id: row.event_id }, req.body), row.event_id);
    if (!n.ok) return res.json({ code: 400, message: n.msg, data: null });
    const dup = await DiscountRule.findOne({
      where: { event_id: row.event_id, min_qty: n.row.min_qty, id: { [require('sequelize').Op.ne]: row.id } }
    });
    if (dup) return res.json({ code: 400, message: `已存在「${n.row.min_qty} 张」的档位`, data: null });
    await row.update(n.row);
    res.json({ code: 0, message: 'ok', data: { rule: publicRule(row) } });
  } catch (e) {
    res.json({ code: 500, message: e.message, data: null });
  }
});

/** 删除单条 */
router.delete('/:id', authenticate, operationLog('discount_rules', '删除折扣规则'), async (req, res) => {
  try {
    const row = await DiscountRule.findByPk(req.params.id);
    if (!row) return res.json({ code: 404, message: '规则不存在', data: null });
    await row.destroy();
    res.json({ code: 0, message: 'ok', data: null });
  } catch (e) {
    res.json({ code: 500, message: e.message, data: null });
  }
});

module.exports = router;
