/**
 * EC9 老板特邀邀约码（2026-11-19）
 *
 * 两个通用码：普通嘉宾 → 标准票，VIP 嘉宾 → 尊享票。
 * 扫码进 /v/<码> → H5 报名页锁定票种 → 提交时后端强制票种 + 免票 + 免审核 + 直接出票。
 *
 * ⚠️ 公开只读接口 /lookup/:code 必须免鉴权（H5 没有 admin token），
 *    后台列表/启停仍需 admin，与 11-17「所有审批写操作仅 admin」口径一致。
 */
const express = require('express');
const router = express.Router();
const { sequelize } = require('../models');
const { authenticate, authorize } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');

const SELECT = sequelize.QueryTypes.SELECT;
const TABLE = 'ec9_vip_invite_codes';

const BASE = `SELECT c.id,c.code,c.name,c.ticket_type_id,c.is_active,c.use_count,c.remark,
       c.created_at,c.updated_at,
       t.name AS ticket_name,t.price AS ticket_price,t.on_shelf AS ticket_on_shelf,
       t.status AS ticket_status
  FROM ${TABLE} c LEFT JOIN ec9_ticket_types t ON t.id=c.ticket_type_id`;

function publicRow(r) {
  if (!r) return null;
  return {
    code: r.code,
    name: r.name,
    ticket_type_id: Number(r.ticket_type_id),
    ticket_name: r.ticket_name || '',
    ticket_price: r.ticket_price == null ? 0 : Number(r.ticket_price),
    is_active: Number(r.is_active)
  };
}

/**
 * 公开只读：H5 扫码落地页用。只回最少字段，不暴露 id / 用量 / 备注。
 * 停用码与已下架票种一律拒绝，前端会禁用提交按钮。
 */
router.get('/lookup/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) return res.status(400).json({ code: 400, message: '邀约码不能为空' });
    const rows = await sequelize.query(
      BASE + ' WHERE UPPER(TRIM(c.code))=UPPER(TRIM(:code)) LIMIT 1',
      { replacements: { code }, type: SELECT }
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ code: 404, message: '邀约码不存在' });
    if (Number(r.is_active) !== 1) return res.status(403).json({ code: 403, message: '该邀约码已停用' });
    if (Number(r.ticket_on_shelf) !== 1 || Number(r.ticket_status) !== 1) {
      return res.status(403).json({ code: 403, message: '该邀约码对应的票种已下架' });
    }
    res.json({ code: 200, message: 'ok', data: publicRow(r) });
  } catch (error) {
    console.error('[vip-invite-codes/lookup] error:', error);
    res.status(500).json({ code: 500, message: '获取失败', error: error.message });
  }
});

/** 后台列表（含用量），只读：登录用户可看 */
router.get('/', authenticate, operationLog('vip-invite-codes', '获取特邀邀约码列表'), async (req, res) => {
  try {
    const rows = await sequelize.query(BASE + ' ORDER BY c.id ASC', { type: SELECT });
    res.json({ code: 200, message: 'ok', data: rows.map(r => ({ ...r, ticket_type_id: Number(r.ticket_type_id) })) });
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取失败', error: error.message });
  }
});

/** 启停（仅 admin）：停用后扫码页与提交接口一并失效 */
router.put('/:id/status', authenticate, authorize('admin'),
  operationLog('vip-invite-codes', '启停特邀邀约码'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const active = (req.body && Number(req.body.is_active)) === 1 ? 1 : 0;
      const rows = await sequelize.query(
        `UPDATE ${TABLE} SET is_active=:a, updated_at=CURRENT_TIMESTAMP WHERE id=:id RETURNING id`,
        { replacements: { a: active, id }, type: SELECT }
      );
      if (!rows.length) return res.status(404).json({ code: 404, message: '邀约码不存在' });
      res.json({ code: 200, message: 'ok', data: { id, is_active: active } });
    } catch (error) {
      res.status(500).json({ code: 500, message: '更新失败', error: error.message });
    }
  });

module.exports = router;
