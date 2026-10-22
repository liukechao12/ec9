/**
 * EC9 手机号加密与索引工具
 * - 存储：AES-256-CBC 加密（iv:ciphertext）
 * - 索引：HMAC-SHA256（过程密钥 PHONE_HMAC_KEY 独立管理，替代 EC8 的无盐裸哈希）
 */
const crypto = require('crypto');
const config = require('../config');

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
    return /^1[3-9]\d{9}$/.test(decrypted) ? decrypted : null;
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
  if (!phone || phone.length < 11) return phone || '';
  return phone.slice(0, 3) + '****' + phone.slice(7);
}

/** 生成验证码哈希（HMAC，不存明文） */
function hashCode(code) {
  return crypto.createHmac('sha256', config.phoneHmac.key).update(String(code), 'utf8').digest('hex');
}

module.exports = { encryptPhone, decryptPhone, hmacPhone, hashPhone, maskPhone, hashCode };
