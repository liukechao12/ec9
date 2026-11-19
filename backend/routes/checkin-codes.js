const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const config = require('../config');
const { sequelize } = require('../models');
const { generateQRCode } = require('../utils/qrcode');
const { authenticate } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');

const SELECT = sequelize.QueryTypes.SELECT;
const TABLE = 'ec9_event_checkin_codes';

// EC8 同款：16 位大写十六进制
function generateCheckinCode() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

function publicBaseUrl() {
  return String(config.frontend.baseUrl || '').replace(/\/+$/, '');
}

// 二维码内容：EC8 是纯文本 checkin:<码>（扫码不跳页），
// EC9 按现场实际需要改成可跳页 URL，扫码直接进 /checkin/<码>。
async function makeCheckinQR(code) {
  const target = publicBaseUrl() + '/checkin/' + encodeURIComponent(code);
  return await generateQRCode(target, 'checkin_' + code);
}

function rowOf(r) {
  if (!r) return null;
  return {
    id: r.id,
    event_id: r.event_id,
    code: r.code,
    code_type: Number(r.code_type),
    is_active: Number(r.is_active),
    created_by: r.created_by || null,
    qr_code_url: r.qr_code_url || null,
    created_at: r.created_at || null,
    event: {
      name: r.event_name || null,
      start_time: r.event_start || null,
      location: r.event_location || null
    }
  };
}

const CODE_JOIN = `SELECT c.id,c.event_id,c.code,c.code_type,c.is_active,c.created_by,
       c.qr_code_url,c.created_at,e.name AS event_name,e.start_time AS event_start,
       e.location AS event_location
  FROM ${TABLE} c LEFT JOIN ec9_events e ON e.id=c.event_id`;

// 公开只读：H5 签到页用。
// ⚠️ EC8 的 GET /api/checkin-codes 与 GET /api/events/:id 都挂了 authenticate，
//    而 H5 不带 admin token，EC8 那个页面实际会 401。EC9 单独开这个免鉴权接口修掉。
router.get('/lookup/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) return res.status(400).json({ code: 400, message: '签到码不能为空' });
    const rows = await sequelize.query(
      CODE_JOIN + ' WHERE c.code=:code LIMIT 1',
      { replacements: { code }, type: SELECT }
    );
    const r = rowOf(rows[0]);
    if (!r) return res.status(404).json({ code: 404, message: '签到码不存在' });
    if (r.is_active !== 1) return res.status(403).json({ code: 403, message: '签到码已禁用' });
    res.json({ code: 200, message: '获取成功', data: r });
  } catch (error) {
    console.error('[checkin-codes/lookup] error:', error);
    res.status(500).json({ code: 500, message: '获取失败', error: error.message });
  }
});

// 获取所有签到码（后台，需认证）
router.get('/', authenticate, operationLog('checkin-codes', '获取签到码列表'), async (req, res) => {
  try {
    const where = [];
    const replacements = {};
    if (req.query.event_id) { where.push('c.event_id=:eid'); replacements.eid = req.query.event_id; }
    const rows = await sequelize.query(
      CODE_JOIN + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY c.id DESC',
      { replacements, type: SELECT }
    );
    res.json({ code: 200, message: '获取成功', data: rows.map(rowOf) });
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取失败', error: error.message });
  }
});

// 创建签到码（后台，需认证）
router.post('/', authenticate, operationLog('checkin-codes', '创建签到码'), async (req, res) => {
  try {
    const eventId = Number(req.body && req.body.event_id) || 1;
    const codeType = Number(req.body && req.body.code_type) || 1;
    if (codeType !== 1 && codeType !== 2) {
      return res.status(400).json({ code: 400, message: '签到码类型错误：1-深圳专用，2-深圳+香港通用' });
    }
    let code = generateCheckinCode();
    for (let i = 0; i < 8; i++) {
      const dup = await sequelize.query('SELECT id FROM ' + TABLE + ' WHERE code=:code LIMIT 1',
        { replacements: { code }, type: SELECT });
      if (!dup.length) break;
      code = generateCheckinCode();
    }
    const ins = await sequelize.query(
      `INSERT INTO ${TABLE} (event_id,code,code_type,is_active,created_by,created_at)
       VALUES (:eid,:code,:ctype,1,:by,NOW()) RETURNING id`,
      { replacements: { eid: eventId, code, ctype: codeType, by: (req.body && req.body.created_by) || (req.user && req.user.username) || null }, type: SELECT }
    );
    const id = ins[0] && ins[0].id;
    let qr = null;
    try { qr = await makeCheckinQR(code); } catch (e) { console.error('生成签到二维码失败:', e); }
    if (qr) {
      await sequelize.query('UPDATE ' + TABLE + ' SET qr_code_url=:u, qr_code_data=:d WHERE id=:id',
        { replacements: { u: qr.url, d: qr.data, id }, type: sequelize.QueryTypes.UPDATE });
    }
    const rows = await sequelize.query(CODE_JOIN + ' WHERE c.id=:id', { replacements: { id }, type: SELECT });
    res.status(201).json({ code: 201, message: '创建成功', data: Object.assign(rowOf(rows[0]), { qr_code_data: qr ? qr.data : null }) });
  } catch (error) {
    console.error('[checkin-codes/create] error:', error);
    res.status(500).json({ code: 500, message: '创建失败', error: error.message });
  }
});

// 启停签到码（后台，需认证）
router.put('/:id/status', authenticate, operationLog('checkin-codes', '更新签到码状态'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const active = (req.body && req.body.is_active) ? 1 : 0;
    const rows = await sequelize.query('UPDATE ' + TABLE + ' SET is_active=:a WHERE id=:id RETURNING id',
      { replacements: { a: active, id }, type: SELECT });
    if (!rows.length) return res.status(404).json({ code: 404, message: '签到码不存在' });
    res.json({ code: 200, message: '更新成功', data: { id, is_active: active } });
  } catch (error) {
    res.status(500).json({ code: 500, message: '更新失败', error: error.message });
  }
});

// 删除签到码（后台，需认证）
router.delete('/:id', authenticate, operationLog('checkin-codes', '删除签到码'), async (req, res) => {
  try {
    await sequelize.query('DELETE FROM ' + TABLE + ' WHERE id=:id',
      { replacements: { id: Number(req.params.id) }, type: sequelize.QueryTypes.DELETE });
    res.json({ code: 200, message: '删除成功' });
  } catch (error) {
    res.status(500).json({ code: 500, message: '删除失败', error: error.message });
  }
});

// 重新生成二维码（后台，需认证）
router.post('/:id/regenerate-qrcode', authenticate, operationLog('checkin-codes', '重新生成签到码二维码'), async (req, res) => {
  try {
    const rows = await sequelize.query('SELECT id,code FROM ' + TABLE + ' WHERE id=:id LIMIT 1',
      { replacements: { id: Number(req.params.id) }, type: SELECT });
    if (!rows.length) return res.status(404).json({ code: 404, message: '签到码不存在' });
    const qr = await makeCheckinQR(rows[0].code);
    await sequelize.query('UPDATE ' + TABLE + ' SET qr_code_url=:u, qr_code_data=:d WHERE id=:id',
      { replacements: { u: qr.url, d: qr.data, id: rows[0].id }, type: sequelize.QueryTypes.UPDATE });
    res.json({ code: 200, message: '二维码重新生成成功', data: { qr_code_url: qr.url, qr_code_data: qr.data } });
  } catch (error) {
    res.status(500).json({ code: 500, message: '重新生成二维码失败', error: error.message });
  }
});

module.exports = router;
