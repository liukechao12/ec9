/**
 * EC9 场次管理后台接口
 *
 *   GET    /api/sessions          列表（按会议过滤 / 分页 / 关键词）
 *   GET    /api/sessions/:id      详情（含票种分布）
 *   POST   /api/sessions          新建场次
 *   PUT    /api/sessions/:id      更新场次
 *   DELETE /api/sessions/:id      删除场次（已售票不可删）
 *   POST   /api/sessions/:id/status   启用 / 停用
 *   POST   /api/sessions/reorder     批量排序
 *
 * 场次 = 会议下的时间单元（如「上午场 / 下午场」）。EC9 特有，EC8 没有此概念。
 */
const express = require('express');
const router = express.Router();
const { Op, Session, TicketType } = require('../models');
const { authenticate, authorize } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');
const { buildI18nTree } = require('./_i18nTree');

const SESSION_I18N_FIELDS = ['name', 'location'];

/** 组装场次 i18n 树 */
function buildSessionI18n(body) {
  return buildI18nTree(body.i18n, body, SESSION_I18N_FIELDS);
}

/** 取库存占用（场次级）：已售 + 已锁定 */
function stockUsed(row) {
  return Number(row.stock_sold || 0) + Number(row.stock_locked || 0);
}

// ========== 列表 ==========
router.get('/', authenticate, async (req, res) => {
  try {
    const { event_id, page = 1, pageSize = 100, keyword, status } = req.query;
    const where = {};
    if (event_id) where.event_id = event_id;
    if (status !== undefined && status !== '') where.status = status;
    if (keyword) {
      where[Op.or] = [
        { name: { [Op.like]: `%${keyword}%` } },
        { location: { [Op.like]: `%${keyword}%` } }
      ];
    }
    const limit = Math.min(Number(pageSize) || 100, 500);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

    const { rows, count } = await Session.findAndCountAll({
      where, order: [['sort', 'ASC'], ['id', 'ASC']], limit, offset
    });

    res.json({
      code: 0, message: 'ok',
      data: { list: rows, total: count, page: Number(page) || 1, pageSize: limit }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 详情 ==========
router.get('/:id(\\d+)', authenticate, async (req, res) => {
  try {
    const s = await Session.findByPk(req.params.id);
    if (!s) return res.status(404).json({ code: 404, message: '场次不存在' });

    const tickets = await TicketType.findAll({
      where: { session_id: s.id },
      order: [['sort', 'ASC'], ['id', 'ASC']]
    });

    res.json({
      code: 0, message: 'ok',
      data: {
        ...s.get(),
        stock_used: stockUsed(s),
        stock_remaining: Number(s.stock_total || 0) - stockUsed(s),
        ticket_types: tickets
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 新建 ==========
router.post('/', authenticate, operationLog('sessions', '新建场次'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.event_id) return res.status(400).json({ code: 400, message: '缺少 event_id' });
    if (!b.name || !String(b.name).trim()) {
      return res.status(400).json({ code: 400, message: '场次名称不能为空' });
    }

    const stockTotal = Number(b.stock_total || 0);
    if (stockTotal < 0) return res.status(400).json({ code: 400, message: '库存不能为负' });

    const row = await Session.create({
      event_id: b.event_id,
      name: String(b.name).trim(),
      i18n: buildSessionI18n(b),
      start_time: b.start_time || null,
      end_time: b.end_time || null,
      location: b.location || null,
      stock_total: stockTotal,
      status: b.status !== undefined ? b.status : 1,
      sort: Number(b.sort || 0)
    });

    res.json({ code: 0, message: '创建成功', data: row });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 更新 ==========
router.put('/:id', authenticate, operationLog('sessions', '更新场次'), async (req, res) => {
  try {
    const s = await Session.findByPk(req.params.id);
    if (!s) return res.status(404).json({ code: 404, message: '场次不存在' });

    const b = req.body || {};
    if (b.name !== undefined) {
      if (!String(b.name).trim()) return res.status(400).json({ code: 400, message: '场次名称不能为空' });
      s.name = String(b.name).trim();
    }
    if (b.i18n !== undefined) s.i18n = buildSessionI18n(b);
    if (b.start_time !== undefined) s.start_time = b.start_time || null;
    if (b.end_time !== undefined) s.end_time = b.end_time || null;
    if (b.location !== undefined) s.location = b.location || null;
    if (b.sort !== undefined) s.sort = Number(b.sort || 0);
    if (b.status !== undefined) s.status = b.status;

    // 库存只允许调高，或调低到不低于已占用
    if (b.stock_total !== undefined) {
      const next = Number(b.stock_total);
      if (Number.isNaN(next) || next < 0) {
        return res.status(400).json({ code: 400, message: '库存不合法' });
      }
      if (next < stockUsed(s)) {
        return res.status(400).json({
          code: 400,
          message: `库存不能小于已占用数量（已售 ${s.stock_sold} + 锁定 ${s.stock_locked}）`
        });
      }
      s.stock_total = next;
    }

    await s.save();
    res.json({ code: 0, message: '更新成功', data: s });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 删除 ==========
router.delete('/:id', authenticate, operationLog('sessions', '删除场次'), async (req, res) => {
  try {
    const s = await Session.findByPk(req.params.id);
    if (!s) return res.status(404).json({ code: 404, message: '场次不存在' });

    const sold = Number(s.stock_sold || 0);
    if (sold > 0) {
      return res.status(400).json({ code: 400, message: `该场次已有 ${sold} 张票售出，请改为停用` });
    }

    const usedByTicket = await TicketType.count({ where: { session_id: s.id } });
    if (usedByTicket > 0) {
      // 场次被票种引用时不能真删（会丢历史），改为软删除
      s.status = 0;
      await s.save();
      return res.json({ code: 0, message: `场次下还有 ${usedByTicket} 个票种，已停用而非删除`, data: s, softDeleted: true });
    }

    await s.destroy();
    res.json({ code: 0, message: '删除成功' });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 启用 / 停用 ==========
router.post('/:id/status', authenticate, operationLog('sessions', '设置场次状态'), async (req, res) => {
  try {
    const s = await Session.findByPk(req.params.id);
    if (!s) return res.status(404).json({ code: 404, message: '场次不存在' });
    const next = req.body && req.body.status !== undefined ? req.body.status : (s.status === 1 ? 0 : 1);
    s.status = next;
    await s.save();
    res.json({ code: 0, message: next === 1 ? '已启用' : '已停用', data: s });
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
      await Session.update({ sort: Number(it.sort || 0) }, { where: { id: it.id } });
    }
    res.json({ code: 0, message: '排序已保存' });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

module.exports = router;
