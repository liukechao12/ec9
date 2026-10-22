/**
 * EC9 通用密钥加解密（AES-256-CBC，iv:ciphertext）
 *
 * 与 phoneCrypto 的区别：phoneCrypto 只服务手机号（带 11 位号码校验），
 * 这里用于任意配置密钥（微信 API 密钥 / V3 密钥 / 商户私钥等）。
 *
 * 落库一律密文；对外接口只回掩码，绝不回明文。
 */
const crypto = require('crypto');
const config = require('../config');

function getKey() {
  return Buffer.from(config.encryption.getKey(), 'utf8');
}

/** 加密：返回 "iv_hex:cipher_hex" */
function encryptSecret(plain) {
  if (plain === null || plain === undefined || plain === '') return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', getKey(), iv);
  let enc = cipher.update(String(plain), 'utf8', 'hex');
  enc += cipher.final('hex');
  return iv.toString('hex') + ':' + enc;
}

/** 解密：失败返回 null（绝不抛，避免配置损坏导致整站 500） */
function decryptSecret(value) {
  try {
    if (!value || typeof value !== 'string') return null;
    const parts = value.split(':');
    if (parts.length !== 2) return null;
    const iv = Buffer.from(parts[0], 'hex');
    if (iv.length !== 16 || !parts[1]) return null;
    const decipher = crypto.createDecipheriv('aes-256-cbc', getKey(), iv);
    let dec = decipher.update(parts[1], 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch (e) {
    return null;
  }
}

/**
 * 掩码：保留前 4 与后 4，中间统一 8 个星号
 * 短串（<=8）全星，避免反向推出长度
 */
function maskSecret(plain) {
  if (!plain) return '';
  const s = String(plain);
  if (s.length <= 8) return '********';
  return s.slice(0, 4) + '********' + s.slice(-4);
}

/** 掩码占位符：前端回传这个值表示「不改」 */
const MASK_PLACEHOLDER = '********';

module.exports = { encryptSecret, decryptSecret, maskSecret, MASK_PLACEHOLDER };
