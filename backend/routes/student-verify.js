/**
 * 学生票学籍核验后台接口（仅管理员）
 *
 *   GET   /api/student-verify/config          当前通道配置（Access Key 只回掩码）
 *   PUT   /api/student-verify/config          保存配置（热更新，无需重启）
 *   POST  /api/student-verify/reload          重新从库载入内存
 *   GET   /api/student-verify/records         核验流水（身份证只回掩码）
 *   POST  /api/student-verify/recheck         人工重新核验（force=true，忽略缓存）
 *
 * 凭证（access_key）全程加密落库，接口只回掩码；回传掩码表示「不改」。
 */
const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');
const svc = require('../services/studentVerifyService');

const adminOnly = [authenticate, authorize('admin')];

router.get('/config', ...adminOnly, operationLog('student_verify', '查看学籍核验配置'), async (req, res) => {
  try {
    res.json({ code: 0, message: 'ok', data: { config: await svc.getConfigMasked() } });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.put('/config', ...adminOnly, operationLog('student_verify', '保存学籍核验配置'), async (req, res) => {
  try {
    const cfg = await svc.saveConfig(req.body || {});
    res.json({ code: 0, message: '学籍核验配置已保存并生效', data: { config: cfg } });
  } catch (e) {
    res.status(400).json({ code: 400, message: e.message });
  }
});

router.post('/reload', ...adminOnly, operationLog('student_verify', '重载学籍核验配置'), async (req, res) => {
  svc.reload();
  res.json({ code: 0, message: 'ok', data: { config: await svc.getConfigMasked() } });
});

router.get('/records', ...adminOnly, operationLog('student_verify', '查看学籍核验流水'), async (req, res) => {
  try {
    const data = await svc.listVerifications({
      limit: req.query.limit, offset: req.query.offset,
      status: req.query.status, keyword: req.query.keyword
    });
    res.json({ code: 0, message: 'ok', data });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/recheck', ...adminOnly, operationLog('student_verify', '人工重新核验学籍'), async (req, res) => {
  try {
    const { name, id_card, registration_id, event_id } = req.body || {};
    if (!name || !id_card) return res.status(400).json({ code: 400, message: '姓名与身份证号不能为空' });
    const r = await svc.verify({
      name, idCard: id_card,
      registrationId: Number(registration_id) || null,
      eventId: Number(event_id) || null,
      force: true            // 人工重核：忽略缓存，真调一次（会产生费用）
    });
    res.json({ code: 0, message: 'ok', data: r });
  } catch (e) {
    res.status(400).json({ code: 400, message: e.message });
  }
});

module.exports = router;
