const express = require('express');
const router = express.Router();
const verification = require('../services/verificationService');
const sms = require('../services/verificationSmsService');
const smsConfig = require('../services/smsConfigService');
const config = require('../config');
const { hmacPhone } = require('../utils/phoneCrypto');

/**
 * POST /api/verification/send-code
 * body: { phone, purpose }
 * 频率限制：60s/条、10 条/日；有效期 5 分钟
 */
router.post('/send-code', async (req, res) => {
  try {
    const { phone, purpose = 'register' } = req.body || {};
    const ip = req.ip || req.connection?.remoteAddress || '';
    const result = await verification.sendCode(phone, purpose, ip);
    if (!result.ok) {
      return res.status(result.retryAfter ? 429 : 400).json({
        code: result.retryAfter ? 429 : 400,
        message: result.error,
        retryAfter: result.retryAfter
      });
    }
    res.json({ code: 0, message: '验证码已发送' });
  } catch (e) {
    console.error('send-code 错误:', e);
    res.status(500).json({ code: 500, message: '发送失败，请稍后再试' });
  }
});

/**
 * POST /api/verification/verify-code
 * body: { phone, code, purpose }
 * 通过 → 返回 verification_token（提交接口凭此票入场）
 */
router.post('/verify-code', async (req, res) => {
  try {
    const { phone, code, purpose = 'register' } = req.body || {};
    const result = await verification.verifyCode(phone, code, purpose);
    if (!result.ok) {
      return res.status(400).json({ code: 400, message: result.error });
    }
    res.json({
      code: 0,
      message: '验证成功',
      data: { verification_token: result.token, expires_at: result.expires_at }
    });
  } catch (e) {
    console.error('verify-code 错误:', e);
    res.status(500).json({ code: 500, message: '校验失败，请稍后再试' });
  }
});


/**
 * POST /api/verification/dev-code —— 取开发用验证码（联调用）
 *
 * 短信通道没配好之前（mock 模式），真机上收不到短信，H5 联调就卡死在第一步。
 * 这里只在「非生产环境 + 通道处于 mock」时把进程内 devOutbox 的码吐出来，
 * 生产环境或真实通道启用后一律 404，明文验证码永不出生产。
 */
router.post('/dev-code', async (req, res) => {
  const isProd = String(process.env.NODE_ENV || config.server.env || '').toLowerCase() === 'production';
  const cfg = smsConfig.get();
  const channelMock = !smsConfig.ready() || Number(cfg.enabled) !== 1;
  if (isProd || !channelMock) {
    return res.status(404).json({ code: 404, message: '接口不存在' });
  }
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ code: 400, message: '缺少 phone' });
  const hit = sms.devOutbox.get(hmacPhone(String(phone)));
  if (!hit) return res.status(404).json({ code: 404, message: '该手机号暂无待用验证码' });
  res.json({ code: 0, message: 'ok', data: { code: hit.code, expires_at: hit.expires_at } });
});

module.exports = router;
