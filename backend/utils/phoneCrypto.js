/**
 * EC9 手机号加密与索引工具
 * - 存储：AES-256-CBC 加密（iv:ciphertext）
 * - 索引：HMAC-SHA256（过程密钥 PHONE_HMAC_KEY 独立管理，替代 EC8 的无盐裸哈希）
 */
const crypto = require('crypto');
const config = require('../config');
const { maskPhoneSafe } = require('./phoneUtil');

function getEncryptionKey() {
  return Buffer.from(config.encryption.getKey(), 'utf8');
}

function encryptPhone(phone) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(String(phone), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptPhone(encryptedPhone) {
  try {
    if (!encryptedPhone || typeof encryptedPhone !== 'string') return null;
    const parts = encryptedPhone.split(':');
    if (parts.length !== 2) return null;
    const iv = Buffer.from(parts[0], 'hex');
    if (iv.length !== 16 || !parts[1]) return null;
    const decipher = crypto.createDecipheriv('aes-256-cbc', getEncryptionKey(), iv);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    // 2026-11-05：兼容 E.164 国际号；否则解密出的香港/美国号会被吞成 null
    const ok = /^1[3-9]\d{9}$/.test(decrypted) || /^\+[1-9]\d{6,14}$/.test(decrypted);
    return ok ? decrypted : null;
  } catch (e) {
    return null;
  }
}

/** HMAC-SHA256 手机号索引（不可逆，用于等值检索） */
function hmacPhone(phone) {
  return crypto.createHmac('sha256', config.phoneHmac.key).update(String(phone), 'utf8').digest('hex');
}

/**
 * EC8 兼容别名：EC8 后台代码 import 的是 hashPhone（当时是无盐裸 SHA256）。
 * EC9 底层统一走 HMAC-SHA256，此处仅做命名映射，安全性不降。
 */
const hashPhone = hmacPhone;

/** 掩码展示：138****5678 */
function maskPhone(phone) {
  // 2026-11-05：短号（香港 8 位）也要掩码，不能整段明文返回
  return maskPhoneSafe(phone);
}

/** 生成验证码哈希（HMAC，不存明文） */
function hashCode(code) {
  return crypto.createHmac('sha256', config.phoneHmac.key).update(String(code), 'utf8').digest('hex');
}

module.exports = { encryptPhone, decryptPhone, hmacPhone, hashPhone, maskPhone, hashCode };
