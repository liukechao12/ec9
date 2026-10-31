/**
 * 学生票学籍核验服务（天远 API · 学籍核验政务V1 / 产品号 IVYZX7J9）
 *
 * ── 省钱设计（昊哥明确要求）────────────────────────────
 *   同一人（姓名+身份证号）的核验结果落库并设有效期（默认 30 天）：
 *   命中且未过期 → 直接复用，**不调 API**；只有查不到或过期才真调一次。
 *   每次真实调用写一行流水（transaction_id 用于对账）。
 *
 * ── 接口规格 ─────────────────────────────────────────
 *   POST {endpoint}/api/v1/{productCode}?t=<13位毫秒时间戳>
 *   Header: Access-Id: <accessId>        Content-Type: application/json
 *   Body  : { "data": base64( IV(16B) + AES-128-CBC(JSON{name,id_card}) ) }
 *   响应  : { code, message, transaction_id, data: base64(加密的业务数据) }
 *
 * ── 返回结论（已归一）────────────────────────────────
 *   enrolled      在籍（是真学生）        → 允许买学生票
 *   not_enrolled  不在籍                  → 不允许买学生票
 *   unknown       接口返回「无法判断」     → 按 on_unknown 处置（默认转人工）
 *   error         接口异常/超时/未配置     → 按 on_unknown 处置（默认转人工）
 *
 * ⚠️ 红线：error / unknown **不等于** 不是学生。接口一挂就自动驳回会误杀真实学生，
 *          所以这两档默认转人工审核，只有明确 not_enrolled 才拒绝。
 */
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');
const config = require('../config');
const { StudentVerifyConfig, StudentVerification, VERIFY_STATUS } = require('../models');
const { encryptSecret, decryptSecret, maskSecret } = require('../utils/secretCrypto');

// ==================== 进程内配置缓存 ====================
let cache = null;
let loaded = false;
let cacheSource = 'env';

const DEFAULT_ROW = {
  name: 'tianyuan',
  provider: 'tianyuan',
  product_code: 'IVYZX7J9',
  endpoint: 'https://api.tianyuanapi.com',
  access_id: '',
  enabled: 0,
  reuse_days: 30,
  timeout_ms: 8000,
  on_not_enrolled: 'reject',
  on_unknown: 'manual',
  remark: ''
};

function fromEnv() {
  return {
    ...DEFAULT_ROW,
    access_id: process.env.TIANYUAN_ACCESS_ID || '',
    enabled: (process.env.TIANYUAN_ACCESS_ID && process.env.TIANYUAN_ACCESS_KEY) ? 1 : 0
  };
}

/** 读配置（明文凭证，仅进程内使用，绝不外泄）。DB 优先，DB 无记录回退 .env */
async function loadConfig() {
  if (loaded) return cache;
  try {
    const row = await StudentVerifyConfig.findOne({ where: { name: 'tianyuan' } });
    if (!row) {
      const env = fromEnv();
      cache = { ...env, access_key: process.env.TIANYUAN_ACCESS_KEY || '' };
      cacheSource = 'env';
    } else {
      const p = row.get ? row.get({ plain: true }) : row;
      let cred = {};
      try {
        const raw = decryptSecret(p.config_encrypted);
        if (raw) cred = JSON.parse(raw);
      } catch (e) { /* 凭证损坏 → 当作没配 */ }
      cache = {
        id: p.id,
        name: p.name,
        provider: p.provider || 'tianyuan',
        product_code: p.product_code || 'IVYZX7J9',
        endpoint: p.endpoint || DEFAULT_ROW.endpoint,
        access_id: p.access_id || '',
        enabled: Number(p.enabled) === 1 ? 1 : 0,
        reuse_days: Number(p.reuse_days) || 30,
        timeout_ms: Number(p.timeout_ms) || 8000,
        on_not_enrolled: p.on_not_enrolled || 'reject',
        on_unknown: p.on_unknown || 'manual',
        remark: p.remark || '',
        access_key: cred.access_key || ''
      };
      cacheSource = 'db';
    }
  } catch (e) {
    // 表还没建 / DB 异常：绝不阻断报名，按「未配置」处理
    cache = { ...fromEnv(), access_key: process.env.TIANYUAN_ACCESS_KEY || '', enabled: 0 };
    cacheSource = 'error';
  }
  loaded = true;
  return cache;
}

/** 后台改完配置调用：清缓存，下次读取即生效（免重启） */
function reload() {
  loaded = false;
  cache = null;
  return true;
}

/** 是否已具备调用条件（凭证齐 + 已启用） */
async function isReady() {
  const c = await loadConfig();
  return !!(c && c.enabled === 1 && c.access_id && c.access_key);
}

/** 对外接口用：凭证打码 */
async function getConfigMasked() {
  const c = await loadConfig();
  return {
    name: c.name,
    provider: c.provider,
    product_code: c.product_code,
    endpoint: c.endpoint,
    access_id: c.access_id || '',
    access_key_masked: maskSecret(c.access_key || ''),
    access_key_set: !!c.access_key,
    enabled: c.enabled,
    reuse_days: c.reuse_days,
    timeout_ms: c.timeout_ms,
    on_not_enrolled: c.on_not_enrolled,
    on_unknown: c.on_unknown,
    remark: c.remark || '',
    ready: !!(c.enabled === 1 && c.access_id && c.access_key),
    source: cacheSource
  };
}

/** 后台保存：只更新传入的白名单字段；凭证是掩码占位符表示「不改」 */
async function saveConfig(patch = {}) {
  const EDITABLE = [
    'enabled', 'provider', 'product_code', 'endpoint', 'access_id',
    'reuse_days', 'timeout_ms', 'on_not_enrolled', 'on_unknown', 'remark'
  ];
  const cur = await loadConfig();
  let row = await StudentVerifyConfig.findOne({ where: { name: 'tianyuan' } });
  if (!row) {
    row = await StudentVerifyConfig.create({ name: 'tianyuan' });
  }
  const next = { ...cur };
  EDITABLE.forEach(k => {
    if (patch[k] === undefined) return;
    if (k === 'enabled') next[k] = Number(patch[k]) === 1 ? 1 : 0;
    else if (k === 'reuse_days' || k === 'timeout_ms') next[k] = Number(patch[k]) || cur[k];
    else next[k] = String(patch[k] ?? '').trim();
  });
  // 凭证：只有真的传了新值（不是掩码）才覆盖
  if (patch.access_key && patch.access_key !== maskSecret(cur.access_key) && patch.access_key.indexOf('*') === -1) {
    next.access_key = String(patch.access_key).trim();
  }
  const update = {};
  EDITABLE.forEach(k => { update[k] = next[k]; });
  update.config_encrypted = encryptSecret(JSON.stringify({ access_key: next.access_key || '' }));
  await row.update(update);
  reload();
  return getConfigMasked();
}

// ==================== 身份证处理 ====================
/** 18 位校验位（ISO 7064:1983 MOD 11-2） */
function idCardCheckBit(body17) {
  const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const T = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += parseInt(body17[i], 10) * W[i];
  return T[sum % 11];
}

/** 身份证格式校验（18 位 + 校验位 + 出生日期合法性） */
function validateIdCard(v) {
  const s = String(v || '').trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(s)) return { ok: false, error: '身份证号格式错误' };
  if (idCardCheckBit(s.slice(0, 17)) !== s[17]) return { ok: false, error: '身份证号校验位不正确' };
  const y = parseInt(s.slice(6, 10), 10), m = parseInt(s.slice(10, 12), 10), d = parseInt(s.slice(12, 14), 10);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return { ok: false, error: '身份证号出生日期无效' };
  const age = (Date.now() - dt.getTime()) / 31557600000;
  if (age < 10 || age > 80) return { ok: false, error: '身份证号年龄超出学生票范围' };
  return { ok: true, value: s };
}

/** HMAC 索引：与手机号分区（加前缀），避免和 phone_hmac 混用 */
function hmacIdCard(name, idCard) {
  const key = config.phoneHmac.key || config.encryption.getKey();
  return crypto.createHmac('sha256', key)
    .update('idcard|' + String(name || '').trim() + '|' + String(idCard || '').trim().toUpperCase())
    .digest('hex');
}

function maskIdCard(v) {
  const s = String(v || '');
  if (s.length < 8) return '********';
  return s.slice(0, 4) + '*'.repeat(s.length - 8) + s.slice(-4);
}

// ==================== 天远 API 加解密 ====================
function aesKey(accessKey) {
  const s = String(accessKey || '').trim();
  // 天远的 Access Key 是 16 进制字符串（32 字符 = 16 字节）；不是就按 UTF-8 取前 16 字节兜底
  if (/^[0-9a-fA-F]{32}$/.test(s)) return Buffer.from(s, 'hex');
  const b = Buffer.from(s, 'utf8');
  return b.length >= 16 ? b.slice(0, 16) : Buffer.concat([b, Buffer.alloc(16 - b.length, 0)]);
}

/** 加密：IV(16B) + AES-128-CBC → base64 */
function encryptPayload(obj, accessKey) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', aesKey(accessKey), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, body]).toString('base64');
}

/** 解密：base64 → IV(16B) + 密文 */
function decryptPayload(b64, accessKey) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (buf.length < 17) throw new Error('响应 data 长度异常');
  const iv = buf.slice(0, 16);
  const enc = buf.slice(16);
  const decipher = crypto.createDecipheriv('aes-128-cbc', aesKey(accessKey), iv);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** POST 天远（自带超时，不依赖第三方 HTTP 库） */
function postTianyuan({ endpoint, productCode, accessId, accessKey, payload, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const t = Date.now();
    const u = new URL(`${String(endpoint).replace(/\/+$/, '')}/api/v1/${productCode}?t=${t}`);
    const body = JSON.stringify({ data: encryptPayload(payload, accessKey) });
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Access-Id': accessId,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('timeout', () => { req.destroy(new Error('接口超时')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ==================== 结果归一 ====================
/**
 * 把天远返回（外层 + 解密后的内层）归一成 enrolled / not_enrolled / unknown / error
 * 兼容两种版本：status(1在籍/0不在籍) 和 resultCode(2在籍/1不在籍/0无法判断)
 */
function normalize(outer, inner) {
  const code = outer && outer.code !== undefined ? outer.code : null;
  const msg = (outer && (outer.message || outer.msg)) || '';
  const tx = (outer && (outer.transaction_id || outer.transactionId)) || '';

  // 外层非成功：余额不足 / 参数错 / 无权限 等，一律按 error（不是「不是学生」）
  if (code !== null && code !== undefined && String(code) !== '0' && String(code) !== '200') {
    return { status: VERIFY_STATUS.ERROR, apiCode: String(code), message: String(msg), tx };
  }

  const pick = (o, keys) => {
    if (!o) return undefined;
    for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
    return undefined;
  };

  const st = pick(inner, ['status', 'Status']);
  if (st !== undefined) {
    if (String(st) === '1') return { status: VERIFY_STATUS.ENROLLED, apiCode: 'status=1', message: '在籍', tx };
    if (String(st) === '0') return { status: VERIFY_STATUS.NOT_ENROLLED, apiCode: 'status=0', message: '不在籍', tx };
  }

  const rc = pick(inner, ['resultCode', 'result_code', 'resultcode']);
  if (rc !== undefined) {
    if (String(rc) === '2') return { status: VERIFY_STATUS.ENROLLED, apiCode: 'resultCode=2', message: '在籍', tx };
    if (String(rc) === '1') return { status: VERIFY_STATUS.NOT_ENROLLED, apiCode: 'resultCode=1', message: '不在籍', tx };
    if (String(rc) === '0') return { status: VERIFY_STATUS.UNKNOWN, apiCode: 'resultCode=0', message: '无法判断', tx };
  }

  return { status: VERIFY_STATUS.UNKNOWN, apiCode: String(code ?? ''), message: String(msg || '返回格式未识别'), tx };
}

// ==================== 主入口 ====================
/**
 * 核验一个学生票报名人
 * @param {object} p
 * @param {string} p.name      姓名
 * @param {string} p.idCard    身份证号（明文，只在内存里用）
 * @param {number} [p.guestId] [p.eventId] [p.registrationId] [p.groupNo] 关联信息（可空）
 * @param {boolean} [p.force]   true=忽略缓存强制调 API（后台人工重试用）
 * @returns {Promise<{status, fromCache, message, transactionId, apiCode, verificationId}>}
 */
async function verify({ name, idCard, guestId = null, eventId = null, registrationId = null, groupNo = null, force = false } = {}) {
  const chk = validateIdCard(idCard);
  if (!chk.ok) return { status: VERIFY_STATUS.ERROR, fromCache: false, message: chk.error, code: 'bad_id_card' };
  const idVal = chk.value;
  const hmac = hmacIdCard(name, idVal);
  const cfg = await loadConfig();

  // ---- ① 先查库：命中未过期结果直接复用，不花钱 ----
  if (!force) {
    try {
      const hit = await StudentVerification.findOne({
        where: { id_card_hmac: hmac },
        order: [['verified_at', 'DESC']]
      });
      if (hit) {
        const exp = hit.expires_at ? new Date(hit.expires_at).getTime() : 0;
        const fresh = exp > Date.now() &&
          [VERIFY_STATUS.ENROLLED, VERIFY_STATUS.NOT_ENROLLED].indexOf(hit.status) > -1;
        if (fresh) {
          // 补关联（同一人换个活动/订单时把链路串起来）
          const patch = {};
          if (guestId && !hit.guest_id) patch.guest_id = guestId;
          if (eventId && !hit.event_id) patch.event_id = eventId;
          if (registrationId && !hit.registration_id) patch.registration_id = registrationId;
          if (groupNo && !hit.group_no) patch.group_no = groupNo;
          if (Object.keys(patch).length) await hit.update(patch).catch(() => {});
          return {
            status: hit.status, fromCache: true, message: hit.api_message || '',
            transactionId: hit.transaction_id || '', apiCode: hit.api_code || '',
            verificationId: hit.id, verifiedAt: hit.verified_at, expiresAt: hit.expires_at
          };
        }
      }
    } catch (e) {
      // 查库失败不阻断：往下走 API（表没建时会走到这里，接口也多半没配 → 返回未配置）
    }
  }

  // ---- ② 没命中 → 检查通道是否已配置 ----
  if (!(cfg.enabled === 1 && cfg.access_id && cfg.access_key)) {
    return { status: VERIFY_STATUS.ERROR, fromCache: false, message: '学籍核验通道未配置或未启用', code: 'not_configured' };
  }

  // ---- ③ 真调 API ----
  let normalized;
  let rawText = '';
  try {
    const res = await postTianyuan({
      endpoint: cfg.endpoint,
      productCode: cfg.product_code,
      accessId: cfg.access_id,
      accessKey: cfg.access_key,
      payload: { name: String(name || '').trim(), id_card: idVal },
      timeoutMs: Number(cfg.timeout_ms) || 8000
    });
    rawText = res.body;
    let outer = {};
    try { outer = JSON.parse(res.body || '{}'); } catch (e) { outer = {}; }
    let inner = null;
    if (outer && outer.data) {
      try { inner = JSON.parse(decryptPayload(outer.data, cfg.access_key)); } catch (e) {
        try { inner = JSON.parse(Buffer.from(outer.data, 'base64').toString('utf8')); } catch (e2) { inner = null; }
      }
    }
    if (res.statusCode >= 400) {
      normalized = { status: VERIFY_STATUS.ERROR, apiCode: 'http_' + res.statusCode, message: '接口返回 HTTP ' + res.statusCode, tx: '' };
    } else {
      normalized = normalize(outer, inner);
    }
    if (!inner && !outer.code && !res.body) {
      normalized = { status: VERIFY_STATUS.ERROR, apiCode: 'empty_response', message: '接口返回为空', tx: '' };
    }
  } catch (e) {
    normalized = { status: VERIFY_STATUS.ERROR, apiCode: 'exception', message: String(e.message || e), tx: '' };
  }

  // ---- ④ 落库（只有明确结论才设复用有效期；异常不缓存，下次可重试） ----
  try {
    const now = new Date();
    const reusable = [VERIFY_STATUS.ENROLLED, VERIFY_STATUS.NOT_ENROLLED].indexOf(normalized.status) > -1;
    const expires = reusable
      ? new Date(now.getTime() + (Number(cfg.reuse_days) || 30) * 86400000)
      : null;
    const row = await StudentVerification.create({
      name: String(name || '').trim(),
      id_card_hmac: hmac,
      id_card_encrypted: encryptSecret(idVal),
      id_card_mask: maskIdCard(idVal),
      status: normalized.status,
      api_code: normalized.apiCode || '',
      api_message: normalized.message || '',
      transaction_id: normalized.tx || '',
      provider: cfg.provider || 'tianyuan',
      product_code: cfg.product_code,
      raw_response: { code: normalized.apiCode, message: normalized.message, raw: String(rawText || '').slice(0, 2000) },
      guest_id: guestId, event_id: eventId, registration_id: registrationId, group_no: groupNo || null,
      verified_at: now,
      expires_at: expires
    });
    return {
      status: normalized.status, fromCache: false, message: normalized.message || '',
      transactionId: normalized.tx || '', apiCode: normalized.apiCode || '',
      verificationId: row.id, verifiedAt: now, expiresAt: expires
    };
  } catch (e) {
    // 落库失败也不能吞掉核验结论（此时已花了钱）
    return {
      status: normalized.status, fromCache: false, message: normalized.message || '',
      transactionId: normalized.tx || '', apiCode: normalized.apiCode || '',
      verificationId: null, saveError: String(e.message || e)
    };
  }
}

/** 后台列表：核验流水（身份证只回掩码） */
async function listVerifications({ limit = 50, offset = 0, status = '', keyword = '' } = {}) {
  const { Op } = require('sequelize');
  const where = {};
  if (status) where.status = status;
  if (keyword) where.name = { [Op.like]: `%${String(keyword).trim()}%` };
  const { rows, count } = await StudentVerification.findAndCountAll({
    where,
    order: [['id', 'DESC']],
    limit: Math.min(Number(limit) || 50, 200),
    offset: Number(offset) || 0
  });
  return {
    total: count,
    list: rows.map(r => {
      const p = r.get({ plain: true });
      delete p.id_card_encrypted;
      delete p.id_card_hmac;
      delete p.raw_response;
      return p;
    })
  };
}

module.exports = {
  loadConfig, reload, isReady, getConfigMasked, saveConfig,
  verify, validateIdCard, maskIdCard, hmacIdCard,
  listVerifications, VERIFY_STATUS,
  // 供联调脚本自测（不对外暴露）
  _internals: { encryptPayload, decryptPayload, normalize, aesKey, idCardCheckBit }
};
