/**
 * EC9 短信配置后台接口（仅管理员）
 *
 *   GET   /api/sms-config         当前配置（AccessKey Secret 只回掩码）
 *   PUT   /api/sms-config         保存配置（改完立即热更新，无需重启）
 *   POST  /api/sms-config/test    配置自检（不发真实短信）
 *   POST  /api/sms-config/reload  重新从库载入内存
 *
 * 与 /api/sms（模板、规则、日志）分工：这里只管通道凭证与验证码参数。
 */
const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');
const smsConfig = require('../services/smsConfigService');

const adminOnly = [authenticate, authorize('admin')];

router.get('/', ...adminOnly, operationLog('sms_config', '查看短信配置'), async (req, res) => {
  try {
    res.json({ code: 0, message: 'ok', data: { config: smsConfig.masked() } });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.put('/', ...adminOnly, operationLog('sms_config', '保存短信配置'), async (req, res) => {
  try {
    await smsConfig.save(req.body || {}, req.user && req.user.id);
    res.json({
      code: 0,
      message: '短信配置已保存并生效',
      data: { config: smsConfig.masked(), ready: smsConfig.ready() }
    });
  } catch (e) {
    res.status(400).json({ code: 400, message: e.message });
  }
});

router.post('/test', ...adminOnly, operationLog('sms_config', '短信配置自检'), async (req, res) => {
  try {
    res.json({ code: 0, message: 'ok', data: smsConfig.selfTest() });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/reload', ...adminOnly, operationLog('sms_config', '重载短信配置'), async (req, res) => {
  try {
    await smsConfig.load();
    res.json({ code: 0, message: 'ok', data: { config: smsConfig.masked() } });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

module.exports = router;
