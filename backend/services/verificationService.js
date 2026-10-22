/**
 * EC9 强制手机号验证（服务端强制，不可绕过）
 *
 * 流程：
 *   1) POST /api/verification/send-code   发码（频率限制 + 有效期 + 日上限）
 *   2) POST /api/verification/verify-code 验码 → 签发 verification_token
 *   3) 提交类接口（报名等）经 requireVerified 中间件验 token，无票 401
 *
 * 安全设计：
 *   - 验证码只存 HMAC 哈希，数据库不落明文
 *   - 错误次数超限作废；一次性消费
 *   - 开发模式验证码只进进程内 devOutbox（自检用），**任何情况下不回传前端**
 */
const crypto = require('crypto');
const config = require('../config');
const smsConfig = require('./smsConfigService');
const { VerificationCode, VerificationToken } = require('../models');
const { hmacPhone, hashCode } = require('../utils/phoneCrypto');
const sms = require('./verificationSmsService');

const PHONE_RE = /^1[3-9]\d{9}$/;

function genCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function genToken() {
  return crypto.randomBytes(64).toString('hex');
}

/**
 * 发送验证码
 * @returns {Promise<{ok:boolean, error?:string, retryAfter?:number}>}
 */
async function sendCode(phone, purpose = 'register', ip = '') {
  if (!PHONE_RE.test(String(phone || ''))) {
    return { ok: false, error: '手机号格式不正确' };
  }
  const phoneHmac = hmacPhone(phone);
  const now = new Date();

  // 频率限制：60 秒内不可重发
  const [recent] = await VerificationCode.findAll({
    where: { phone_hmac: phoneHmac, purpose },
    order: [['created_at', 'DESC']],
    limit: 1
  });
  if (recent) {
    const lastAt = new Date(recent.created_at).getTime();
    const waitMs = smsConfig.get().code_resend_seconds * 1000 - (now.getTime() - lastAt);
    if (waitMs > 0) {
      return { ok: false, error: '发送过于频繁，请稍后再试', retryAfter: Math.ceil(waitMs / 1000) };
    }
  }

  // 日上限
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const todayCount = await VerificationCode.count({
    where: {
      phone_hmac: phoneHmac, purpose,
      created_at: { [require('sequelize').Op.gte]: dayStart }
    }
  });
  if (todayCount >= smsConfig.get().code_daily_limit) {
    return { ok: false, error: '今日验证码发送次数已达上限' };
  }

  // 生成 + 哈希落库
  const code = genCode();
  const expiresAt = new Date(now.getTime() + smsConfig.get().code_expire_minutes * 60000);
  await VerificationCode.create({
    phone_hmac: phoneHmac,
    code_hash: hashCode(code),
    purpose,
    ip,
    expires_at: expiresAt
  });

  // 发送（无通道 → mock；mock 时登记到进程内 outbox 供自检）
  const sent = await sms.sendVerificationSms(phone, code);
  if (!sent.ok) return { ok: false, error: sent.error || '验证码发送失败' };
  if (sent.mock) sms.devOutbox.set(phoneHmac, { code, expires_at: expiresAt });

  return { ok: true };
}

/**
 * 校验验证码 → 签发凭证
 * @returns {Promise<{ok:boolean, token?:string, error?:string}>}
 */
async function verifyCode(phone, code, purpose = 'register') {
  if (!PHONE_RE.test(String(phone || ''))) {
    return { ok: false, error: '手机号格式不正确' };
  }
  if (!code || !/^\d{6}$/.test(String(code))) {
    return { ok: false, error: '验证码格式不正确' };
  }
  const phoneHmac = hmacPhone(phone);

  const [record] = await VerificationCode.findAll({
    where: { phone_hmac: phoneHmac, purpose, consumed_at: null },
    order: [['created_at', 'DESC']],
    limit: 1
  });
  if (!record) return { ok: false, error: '请先获取验证码' };
  if (new Date(record.expires_at).getTime() < Date.now()) {
    return { ok: false, error: '验证码已过期，请重新获取' };
  }
  if (record.attempts >= record.max_attempts) {
    return { ok: false, error: '错误次数过多，请重新获取验证码' };
  }

  if (record.code_hash !== hashCode(String(code))) {
    await record.increment('attempts');
    const left = record.max_attempts - record.attempts - 1;
    return { ok: false, error: left > 0 ? `验证码错误，还可尝试 ${left} 次` : '错误次数过多，请重新获取验证码' };
  }

  // 通过：消费 + 签发凭证
  await record.update({ consumed_at: new Date() });
  const token = genToken();
  const expiresAt = new Date(Date.now() + config.business.tokenExpireHours * 3600000);
  await VerificationToken.create({
    token, phone_hmac: phoneHmac, purpose, expires_at: expiresAt
  });
  sms.devOutbox.delete(phoneHmac);

  return { ok: true, token, expires_at: expiresAt };
}

/**
 * 校验并消费凭证（一次性）。
 * @returns {Promise<{ok:boolean, phoneHmac?:string, error?:string}>}
 */
async function consumeToken(token, purpose = 'register', phone = null) {
  if (!token) return { ok: false, error: '缺少验证凭证' };
  const [record] = await VerificationToken.findAll({
    where: { token },
    limit: 1
  });
  if (!record) return { ok: false, error: '验证凭证无效' };
  if (record.used) return { ok: false, error: '验证凭证已使用' };
  if (new Date(record.expires_at).getTime() < Date.now()) {
    return { ok: false, error: '验证凭证已过期，请重新验证' };
  }
  if (record.purpose !== purpose) return { ok: false, error: '验证凭证用途不符' };
  if (phone && record.phone_hmac !== hmacPhone(phone)) {
    return { ok: false, error: '验证凭证与手机号不匹配' };
  }
  await record.update({ used: 1 });
  return { ok: true, phoneHmac: record.phone_hmac };
}


/**
 * 校验凭证但**不消费**（可重复用）
 *
 * 支付链路天然是多次调用：下单 → 前端每 3 秒轮询状态 → 支付完成再确认。
 * 用一次性凭证的话，第二次轮询就 401「凭证已使用」，H5 根本走不完。
 * 因此查询/支付类接口用 peek，提交类接口（报名 submit）仍用 consume 防重放。
 */
async function peekToken(token, purpose = 'register', phone = null) {
  if (!token) return { ok: false, error: '缺少验证凭证' };
  const [record] = await VerificationToken.findAll({ where: { token }, limit: 1 });
  if (!record) return { ok: false, error: '验证凭证无效' };
  if (record.used) return { ok: false, error: '验证凭证已使用' };
  if (new Date(record.expires_at).getTime() < Date.now()) {
    return { ok: false, error: '验证凭证已过期，请重新验证' };
  }
  if (record.purpose !== purpose) return { ok: false, error: '验证凭证用途不符' };
  if (phone && record.phone_hmac !== hmacPhone(phone)) {
    return { ok: false, error: '验证凭证与手机号不匹配' };
  }
  return { ok: true, phoneHmac: record.phone_hmac };
}

module.exports = { sendCode, verifyCode, consumeToken, peekToken, PHONE_RE };
