/**
 * EC9 手机号规范化与校验（2026-11-05）
 *
 * 背景：原系统只认大陆 11 位 1[3-9]\d{9}。现支持中国大陆、中国香港、美国/加拿大
 * 以及带 + 的通用 E.164 号码，统一在「入口」规范化后再做 HMAC / AES / 短信发送，
 * 保证同一号码不同写法不会重复建嘉宾。
 *
 * ⚠️ 大陆号规范化后**原样返回**（不加 +86），历史 phone_hmac / 加密串完全兼容。
 * ⚠️ 不带 + 的 11 位 1XXXXXXXXXX 一律优先按大陆号处理（与美国号有歧义），
 *    美国号请写 +1XXXXXXXXXX 或 10 位本地号；香港号可写 +852XXXXXXXX 或 8 位本地号。
 */
'use strict';

/** 去掉常见分隔符：空格、横线、点、括号、全角空格、全角括号 */
function clean(raw) {
  let v = String(raw == null ? '' : raw).trim().replace(/[\s\-().（）·]/g, '');
  // 00 国际前缀 → +
  if (/^00[1-9]\d{6,14}$/.test(v)) v = '+' + v.slice(2);
  return v;
}

/**
 * 规范化手机号。
 * @returns {string} E.164（+开头）或大陆 11 位原样；无法识别返回 ''
 */
function normalizePhone(raw) {
  const v = clean(raw);
  if (!v) return '';

  // 显式 + 前缀：+ 后 7~15 位数字，首位非 0
  if (/^\+[1-9]\d{6,14}$/.test(v)) {
    // +86 大陆：去掉国家码，保持与历史数据一致的 11 位
    if (/^\+861[3-9]\d{9}$/.test(v)) return v.slice(3);
    return v;
  }

  if (!/^\d+$/.test(v)) return '';

  // 大陆 11 位（最高优先级，避免与美国 1XXXXXXXXXX 混淆）
  if (/^1[3-9]\d{9}$/.test(v)) return v;
  // 中国大陆带 86 前缀（13 位）
  if (/^861[3-9]\d{9}$/.test(v)) return v.slice(2);
  // 中国香港本地 8 位
  if (/^[2-9]\d{7}$/.test(v)) return '+852' + v;
  // 中国香港带 852 前缀（11 位）
  if (/^852[2-9]\d{7}$/.test(v)) return '+852' + v.slice(3);
  // 美国/加拿大本地 10 位
  if (/^[2-9]\d{9}$/.test(v)) return '+1' + v;

  return '';
}

function isValidPhone(raw) {
  return normalizePhone(raw) !== '';
}

/** 号码归属，仅用于展示/统计，不参与校验 */
function phoneRegion(raw) {
  const v = normalizePhone(raw);
  if (!v) return '';
  if (v.startsWith('+852')) return 'hk';
  if (v.startsWith('+1')) return 'us';
  if (/^1[3-9]\d{9}$/.test(v)) return 'cn';
  return 'intl';
}

/**
 * 掩码展示：大陆 138****5678；国际号保留区号与后 4 位。
 * 老实现遇到非 11 位直接返回明文，会把 8 位香港号整段暴露，这里一并修掉。
 */
function maskPhoneSafe(raw) {
  const v = normalizePhone(raw) || String(raw == null ? '' : raw).trim();
  if (!v) return '';
  if (/^1[3-9]\d{9}$/.test(v)) return v.slice(0, 3) + '****' + v.slice(7);
  // 已知国家码优先（长的在前），避免 +1415... 被贪婪切成 +141 区号
  const known = ['+852', '+853', '+886', '+65', '+81', '+82', '+44', '+86', '+1'];
  for (const p of known) {
    if (v.startsWith(p)) {
      const rest = v.slice(p.length);
      return p + '****' + rest.slice(-4);
    }
  }
  const m = v.match(/^\+(\d{1,3})(\d+)$/);
  if (m) return '+' + m[1] + '****' + m[2].slice(-4);
  return v.slice(0, 2) + '****' + v.slice(-4);
}

module.exports = { normalizePhone, isValidPhone, phoneRegion, maskPhoneSafe, clean };
