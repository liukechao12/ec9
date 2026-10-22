/**
 * 强制验证中间件：提交类接口必须携带有效 verification_token
 * 用法：router.post('/xxx', requireVerified, handler)
 * token 来源：Header `x-verify-token` 或 body.verification_token
 */
const { consumeToken, peekToken } = require('../services/verificationService');
const { hmacPhone } = require('../utils/phoneCrypto');

async function requireVerified(req, res, next) {
  try {
    const token = req.headers['x-verify-token'] || req.body.verification_token || req.query.verification_token;
    if (!token) {
      return res.status(401).json({ code: 401, message: '请先完成手机号验证' });
    }
    // 若请求带了手机号，凭证必须与之匹配（防拿别人的票混进来）
    const phone = req.body.phone || req.query.phone || null;
    const result = await consumeToken(token, 'register', phone);
    if (!result.ok) {
      return res.status(401).json({ code: 401, message: result.error });
    }
    req.verifiedPhoneHmac = result.phoneHmac;
    next();
  } catch (e) {
    res.status(500).json({ code: 500, message: '验证校验失败' });
  }
}


/**
 * 可复用版：校验通过但不消费凭证。
 * 用于支付这种「一次动作、多次请求」的链路（下单 / 轮询 / 确认）。
 */
function requireVerifiedReusable(req, res, next) {
  try {
    const token = req.headers['x-verify-token'] || req.body.verification_token || req.query.verification_token;
    if (!token) {
      return res.status(401).json({ code: 401, message: '请先完成手机号验证' });
    }
    const phone = req.body.phone || req.query.phone || null;
    return peekToken(token, 'register', phone).then(result => {
      if (!result.ok) return res.status(401).json({ code: 401, message: result.error });
      req.verifiedPhoneHmac = result.phoneHmac;
      next();
    }).catch(() => res.status(500).json({ code: 500, message: '验证校验失败' }));
  } catch (e) {
    res.status(500).json({ code: 500, message: '验证校验失败' });
  }
}

module.exports = { requireVerified, requireVerifiedReusable };
