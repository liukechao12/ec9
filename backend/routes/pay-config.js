/**
 * EC9 支付配置后台接口（仅管理员）
 *
 *   GET   /api/pay-config         当前配置（密钥回掩码）
 *   PUT   /api/pay-config         保存配置（改完立即热更新，无需重启）
 *   POST  /api/pay-config/test    配置自检（不发起真实请求）
 *   POST  /api/pay-config/reload  重新从库载入内存
 *
 * 微信支付资质属于客户资产，因此放后台可配：
 *   开发期用 mock 模式跑通全链路，客户资质到位后在后台切 real 并填参数即可，
 *   全程不需要碰服务器 .env、不需要重启。
 */
const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');
const payConfig = require('../services/payConfigService');

const adminOnly = [authenticate, authorize('admin')];

/**
 * GET /api/pay-config
 */
router.get('/', ...adminOnly, operationLog('payment_config', '查看支付配置'), async (req, res) => {
  try {
    res.json({
      code: 0,
      message: 'ok',
      data: {
        config: payConfig.masked(),
        modes: payConfig.MODES,
        sign_types: payConfig.SIGN_TYPES
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * PUT /api/pay-config
 * 密钥字段传空或掩码表示「保持原值」
 */
router.put('/', ...adminOnly, operationLog('payment_config', '保存支付配置'), async (req, res) => {
  try {
    const { config } = await payConfig.save(req.body || {}, req.user && req.user.id);
    res.json({
      code: 0,
      message: '支付配置已保存并生效',
      data: { config: payConfig.masked(), mode: config.mode }
    });
  } catch (e) {
    res.status(400).json({ code: 400, message: e.message });
  }
});

/**
 * POST /api/pay-config/test
 * 只做参数与证书可用性检查，不打微信接口
 */
router.post('/test', ...adminOnly, operationLog('payment_config', '支付配置自检'), async (req, res) => {
  try {
    const result = payConfig.selfTest();
    res.json({ code: 0, message: 'ok', data: result });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * POST /api/pay-config/reload
 */
router.post('/reload', ...adminOnly, operationLog('payment_config', '重载支付配置'), async (req, res) => {
  try {
    await payConfig.load();
    res.json({ code: 0, message: 'ok', data: { config: payConfig.masked() } });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

module.exports = router;
