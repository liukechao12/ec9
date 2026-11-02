/**
 * 学生票学籍核验服务（天远 API · 学籍核验政务V1 / 产品号 IVYZX7J9）
 *
 * ── 省钱设计（昊哥明确要求）────────────────────────────
 *   同一人（姓名+身份证号）的核验结果落库并设有效期：
 *     在籍/不在籍  → 复用 reuse_days 天（默认 30 天）
 *     无法判断     → 复用 reuse_unknown_days 天（默认 7 天）
 *     接口异常     → 复用 error_reuse_minutes 分钟（默认 10 分钟，防接口挂掉时反复重试烧钱）
 *     身份证格式错 → 同接口异常（短 TTL）
 *   命中且未过期 → 直接复用，**不调 API**（只累加 reuse_count）；只有查不到或过期才真调一次。
 *   每次真实调用写一行流水（transaction_id 用于对账）。
 *   ⚠️ 「不管什么结果都要落库」是硬要求：成功/失败/异常/参数错一律写流水，
 *      唯一例外是通道压根没配（not_configured），那时根本没发起核验，写了没意义。
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

// 各通道的默认地址/产品号（后台可改 endpoint 覆盖）
const PROVIDER_DEFAULTS = {
  tianyuan: { endpoint: 'https://api.tianyuanapi.com', product_code: 'IVYZX7J9' },
  jumdata: { endpoint: 'https://api.jumdata.com', product_code: 'student_status' }
};

const DEFAULT_ROW = {
  name: 'tianyuan',
  provider: 'tianyuan',
  product_code: 'IVYZX7J9',
  endpoint: 'https://api.tianyuanapi.com',
  access_id: '',
  enabled: 0,
  reuse_days: 30,
  reuse_unknown_days: 7,
  error_reuse_minutes: 10,
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
      const prov = p.provider || 'tianyuan';
      const pd = PROVIDER_DEFAULTS[prov] || PROVIDER_DEFAULTS.tianyuan;
      cache = {
        id: p.id,
        name: p.name,
        provider: prov,
        product_code: p.product_code || pd.product_code,
        endpoint: p.endpoint || pd.endpoint,
        access_id: p.access_id || '',
        enabled: Number(p.enabled) === 1 ? 1 : 0,
        reuse_days: Number(p.reuse_days) || 30,
        reuse_unknown_days: p.reuse_unknown_days === undefined || p.reuse_unknown_days === null
          ? 7 : (Number(p.reuse_unknown_days) || 0),
        error_reuse_minutes: p.error_reuse_minutes === undefined || p.error_reuse_minutes === null
          ? 10 : (Number(p.error_reuse_minutes) || 0),
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
    reuse_unknown_days: Number(c.reuse_unknown_days) || 0,
    error_reuse_minutes: Number(c.error_reuse_minutes) || 0,
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
    'reuse_days', 'reuse_unknown_days', 'error_reuse_minutes',
    'timeout_ms', 'on_not_enrolled', 'on_unknown', 'remark'
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
    else if (['reuse_days', 'reuse_unknown_days', 'error_reuse_minutes', 'timeout_ms'].indexOf(k) > -1) {
      const n = Number(patch[k]);
      next[k] = Number.isFinite(n) && n >= 0 ? n : cur[k];
    }
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
    // 1000 = 查询为空（学籍库里查不到这个人）：不是接口故障，按「无法判断」转人工，
    // 且复用 7 天而不是 10 分钟 —— 查不到的人短期内再查还是查不到，别反复烧钱
    if (String(code) === '1000') {
      return { status: VERIFY_STATUS.UNKNOWN, apiCode: '1000', message: String(msg || '查询为空'), tx };
    }
    return { status: VERIFY_STATUS.ERROR, apiCode: String(code), message: String(msg), tx };
  }

  const pick = (o, keys) => {
    if (!o) return undefined;
    for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
    return undefined;
  };

  // 天远多数产品把业务字段包在 result 里：{"result":{"status":1}}
  // 逐个往下剥，直到找到含 status / resultCode 的那一层
  const layers = [];
  let cur = inner;
  for (let d = 0; d < 4 && cur && typeof cur === 'object'; d++) {
    layers.push(cur);
    cur = cur.result !== undefined && cur.result !== null && typeof cur.result === 'object'
      ? cur.result
      : (cur.data !== undefined && cur.data !== null && typeof cur.data === 'object' ? cur.data : null);
  }

  const st = layers.map(o => pick(o, ['status', 'Status'])).find(v => v !== undefined);
  if (st !== undefined) {
    if (String(st) === '1') return { status: VERIFY_STATUS.ENROLLED, apiCode: 'status=1', message: '在籍', tx };
    if (String(st) === '0') return { status: VERIFY_STATUS.NOT_ENROLLED, apiCode: 'status=0', message: '不在籍', tx };
  }

  const rc = layers.map(o => pick(o, ['resultCode', 'result_code', 'resultcode'])).find(v => v !== undefined);
  if (rc !== undefined) {
    if (String(rc) === '2') return { status: VERIFY_STATUS.ENROLLED, apiCode: 'resultCode=2', message: '在籍', tx };
    if (String(rc) === '1') return { status: VERIFY_STATUS.NOT_ENROLLED, apiCode: 'resultCode=1', message: '不在籍', tx };
    if (String(rc) === '0') return { status: VERIFY_STATUS.UNKNOWN, apiCode: 'resultCode=0', message: '无法判断', tx };
  }

  return { status: VERIFY_STATUS.UNKNOWN, apiCode: String(code ?? ''), message: String(msg || '返回格式未识别'), tx };
}

// ==================== 聚美智数通道（jumdata） ====================
/**
 * POST 聚美智数：application/x-www-form-urlencoded
 * 签名 sign = sha256(appId + appSecret + timestamp)，timestamp 为毫秒
 * productCode 固定 student_status；status 传 1 表示「查是否在籍」
 */
function postJumdata({ endpoint, accessId, accessKey, payload, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const ts = Date.now();
    const sign = crypto.createHash('sha256')
      .update(String(accessId) + String(accessKey) + String(ts)).digest('hex');
    const body = new URLSearchParams({
      appId: String(accessId),
      timestamp: String(ts),
      sign,
      productCode: 'student_status',
      name: String(payload.name || ''),
      idcard: String(payload.id_card || ''),
      status: '1'
    }).toString();
    const u = new URL(`${String(endpoint).replace(/\/+$/, '')}/student-status/query`);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
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

/** 聚美智数返回归一（明文 JSON，无需解密） */
function normalizeJumdata(o) {
  const code = o && o.code !== undefined ? o.code : null;
  const msg = (o && (o.msg || o.message)) || '';
  const tx = (o && (o.taskNo || o.transaction_id)) || '';
  if (String(code) === '200') {
    const r = o && o.data && o.data.result;
    if (String(r) === '1') return { status: VERIFY_STATUS.ENROLLED, apiCode: '200', message: '在籍', tx };
    if (String(r) === '2') return { status: VERIFY_STATUS.NOT_ENROLLED, apiCode: '200', message: '不在籍', tx };
    return { status: VERIFY_STATUS.UNKNOWN, apiCode: '200', message: '返回结果未识别', tx };
  }
  // 201 查无记录：不是接口故障，按「无法判断」处理（复用 7 天，别反复查）
  if (String(code) === '201') {
    return { status: VERIFY_STATUS.UNKNOWN, apiCode: '201', message: String(msg || '查无记录'), tx };
  }
  // 501 数据源维护 / 502 网络不稳 / 606 超限 / 609 过频 / 610 超时 → 值得重试
  const retryable = ['501', '502', '606', '609', '610'].indexOf(String(code)) > -1;
  return { status: VERIFY_STATUS.ERROR, apiCode: String(code ?? ''), message: String(msg || '接口异常'), tx, retryable };
}

// ==================== 落库 ====================
/**
 * 按结论算「复用截止时间」
 *   明确结论（在籍/不在籍）→ 复用 reuse_days 天
 *   无法判断             → 复用 reuse_unknown_days 天
 *   异常/参数错           → 复用 error_reuse_minutes 分钟（短，只防重复烧钱）
 * 返回 null 表示「不复用」（下次重新核验）
 */
function computeExpires(status, cfg, now) {
  if (status === VERIFY_STATUS.ENROLLED || status === VERIFY_STATUS.NOT_ENROLLED) {
    return new Date(now.getTime() + (Number(cfg.reuse_days) || 30) * 86400000);
  }
  if (status === VERIFY_STATUS.UNKNOWN) {
    const days = (cfg.reuse_unknown_days === undefined || cfg.reuse_unknown_days === null)
      ? 7 : (Number(cfg.reuse_unknown_days) || 0);
    return days > 0 ? new Date(now.getTime() + days * 86400000) : null;
  }
  const mins = (cfg.error_reuse_minutes === undefined || cfg.error_reuse_minutes === null)
    ? 10 : (Number(cfg.error_reuse_minutes) || 0);
  return mins > 0 ? new Date(now.getTime() + mins * 60000) : null;
}

/**
 * 统一落库：不管结论是「在籍 / 不在籍 / 无法判断 / 接口异常 / 身份证格式错」都写一行流水。
 * 写失败不能吞掉结论（钱已经花了），所以只记录 saveError。
 */
async function persist(row) {
  try {
    const rec = await StudentVerification.create(row);
    return { row: rec, saveError: '' };
  } catch (e) {
    return { row: null, saveError: String(e.message || e) };
  }
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
  const idVal = chk.ok ? chk.value : String(idCard || '').trim().toUpperCase();
  const hmac = hmacIdCard(name, idVal);
  const cfg = await loadConfig();
  const nameVal = String(name || '').trim();

  // ---- ① 先查库：命中未过期结果直接复用，不花钱（任何结论都可复用，TTL 按结论长短不同） ----
  if (!force) {
    try {
      const hit = await StudentVerification.findOne({
        where: { id_card_hmac: hmac },
        order: [['verified_at', 'DESC']]
      });
      if (hit) {
        const exp = hit.expires_at ? new Date(hit.expires_at).getTime() : 0;
        if (exp > Date.now()) {
          // 补关联（同一人换个活动/订单时把链路串起来）+ 记一次复用
          const patch = { reuse_count: (Number(hit.reuse_count) || 0) + 1 };
          if (guestId && !hit.guest_id) patch.guest_id = guestId;
          if (eventId && !hit.event_id) patch.event_id = eventId;
          if (registrationId && !hit.registration_id) patch.registration_id = registrationId;
          if (groupNo && !hit.group_no) patch.group_no = groupNo;
          await hit.update(patch).catch(() => {});
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

  // ---- ② 没命中 → 检查通道是否已配置（唯一不落库的分支：压根没发起核验） ----
  if (!(cfg.enabled === 1 && cfg.access_id && cfg.access_key)) {
    return { status: VERIFY_STATUS.ERROR, fromCache: false, message: '学籍核验通道未配置或未启用', code: 'not_configured' };
  }

  // ---- ③ 身份证格式错：也落库留痕（短 TTL，防同一错号反复进到这里） ----
  if (!chk.ok) {
    const now = new Date();
    const saved = await persist({
      name: nameVal,
      id_card_hmac: hmac,
      id_card_encrypted: encryptSecret(idVal),
      id_card_mask: maskIdCard(idVal),
      status: VERIFY_STATUS.ERROR,
      api_code: 'bad_id_card',
      api_message: chk.error,
      transaction_id: '',
      provider: cfg.provider || 'tianyuan',
      product_code: cfg.product_code,
      raw_response: { code: 'bad_id_card', message: chk.error, api_called: false },
      guest_id: guestId, event_id: eventId, registration_id: registrationId, group_no: groupNo || null,
      verified_at: now,
      expires_at: computeExpires(VERIFY_STATUS.ERROR, cfg, now)
    });
    return {
      status: VERIFY_STATUS.ERROR, fromCache: false, message: chk.error, code: 'bad_id_card',
      verificationId: saved.row ? saved.row.id : null, saveError: saved.saveError || undefined
    };
  }

  // ---- ④ 真调 API ----
  // 天远错误码 1001 = 接口异常（官方建议重试），这里最多 3 次尝试（首调 + 2 次重试）；
  // 失败请求不计费，重试不会多花钱。其余错误码（1003 参数错 / 1007 余额不足等）不重试。
  let normalized;
  let rawText = '';
  const MAX_TRY = 3;
  for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
    try {
      const isJumdata = cfg.provider === 'jumdata';
      const res = isJumdata
        ? await postJumdata({
          endpoint: cfg.endpoint,
          accessId: cfg.access_id,
          accessKey: cfg.access_key,
          payload: { name: nameVal, id_card: idVal },
          timeoutMs: Number(cfg.timeout_ms) || 8000
        })
        : await postTianyuan({
          endpoint: cfg.endpoint,
          productCode: cfg.product_code,
          accessId: cfg.access_id,
          accessKey: cfg.access_key,
          payload: { name: nameVal, id_card: idVal },
          timeoutMs: Number(cfg.timeout_ms) || 8000
        });
      rawText = res.body;
      let outer = {};
      try { outer = JSON.parse(res.body || '{}'); } catch (e) { outer = {}; }
      if (res.statusCode >= 400) {
        normalized = { status: VERIFY_STATUS.ERROR, apiCode: 'http_' + res.statusCode, message: '接口返回 HTTP ' + res.statusCode, tx: '' };
      } else if (isJumdata) {
        normalized = normalizeJumdata(outer);
      } else {
        let inner = null;
        if (outer && outer.data) {
          try { inner = JSON.parse(decryptPayload(outer.data, cfg.access_key)); } catch (e) {
            try { inner = JSON.parse(Buffer.from(outer.data, 'base64').toString('utf8')); } catch (e2) { inner = null; }
          }
        }
        normalized = normalize(outer, inner);
      }
      if (!outer.code && !res.body) {
        normalized = { status: VERIFY_STATUS.ERROR, apiCode: 'empty_response', message: '接口返回为空', tx: '' };
      }
      normalized.attempts = attempt;
      // 天远 1001（接口异常）或聚美标记 retryable 的临时故障才重试；
      // 其余结论（含成功 / 查无记录 / 参数错 / 余额不足 / IP 未白名单）不重试，避免白烧钱
      if (normalized.apiCode !== '1001' && !normalized.retryable) break;
      if (attempt < MAX_TRY) await new Promise(r => setTimeout(r, 600 * attempt));
    } catch (e) {
      normalized = { status: VERIFY_STATUS.ERROR, apiCode: 'exception', message: String(e.message || e), tx: '', attempts: attempt };
      if (attempt < MAX_TRY) await new Promise(r => setTimeout(r, 600 * attempt));
      else break;
    }
  }

  // ---- ⑤ 落库：任何结论都写一行（在籍/不在籍/无法判断/异常），TTL 按结论长短不同 ----
  const now = new Date();
  const expires = computeExpires(normalized.status, cfg, now);
  const saved = await persist({
    name: nameVal,
    id_card_hmac: hmac,
    id_card_encrypted: encryptSecret(idVal),
    id_card_mask: maskIdCard(idVal),
    status: normalized.status,
    api_code: normalized.apiCode || '',
    api_message: normalized.message || '',
    transaction_id: normalized.tx || '',
    provider: cfg.provider || 'tianyuan',
    product_code: cfg.product_code,
    raw_response: { code: normalized.apiCode, message: normalized.message, raw: String(rawText || '').slice(0, 2000), api_called: true },
    guest_id: guestId, event_id: eventId, registration_id: registrationId, group_no: groupNo || null,
    verified_at: now,
    expires_at: expires
  });
  // 落库失败也不能吞掉核验结论（此时已花了钱）
  return {
    status: normalized.status, fromCache: false, message: normalized.message || '',
    transactionId: normalized.tx || '', apiCode: normalized.apiCode || '',
    verificationId: saved.row ? saved.row.id : null, verifiedAt: now, expiresAt: expires,
    attempts: normalized.attempts || 1,
    saveError: saved.saveError || undefined
  };
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
  _internals: { encryptPayload, decryptPayload, normalize, normalizeJumdata, aesKey, idCardCheckBit, postJumdata }
};
