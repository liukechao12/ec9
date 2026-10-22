/**
 * EC9 支付配置服务
 *
 * 背景：微信支付资质（商户号 / API 密钥 / 回调域名）属于客户资产，
 *      过去只能写在 .env 里、改一次要重启一次服务，客户自己也改不了。
 *      现在落库 + 后台可改 + 改完热更新。
 *
 * 取值优先级：DB 配置 > .env 环境变量（DB 无记录时回退，保证老部署方式不炸）
 *
 * 对外接口只回掩码（api_key 等），明文只在进程内存里给 wechatPayService 用。
 */
const fs = require('fs');
const config = require('../config');
const { PaymentConfig } = require('../models');
const { encryptSecret, decryptSecret, maskSecret, MASK_PLACEHOLDER } = require('../utils/secretCrypto');

/** 内存缓存：wechatPayService 每次调用都读这里，保证改完立即生效 */
let cache = null;
let cacheSource = 'env';      // db | env
let loaded = false;

/** 允许后台修改的字段（白名单，防越权写入） */
const EDITABLE = [
  'mode', 'enabled', 'app_id', 'mch_id', 'sub_app_id', 'sub_mch_id',
  'sign_type', 'cert_path', 'cert_serial_no',
  'notify_url', 'refund_notify_url', 'order_expire_minutes', 'remark'
];

const MODES = ['mock', 'sandbox', 'real'];
const SIGN_TYPES = ['MD5', 'HMAC-SHA256'];

/** .env 兜底值（DB 没配时的默认） */
function fromEnv() {
  const w = config.wechatPay;
  return {
    channel: 'wechat',
    mode: w.mode || 'mock',
    enabled: 1,
    app_id: w.appId || '',
    mch_id: w.mchId || '',
    sub_app_id: '',
    sub_mch_id: '',
    api_key: w.apiKey || '',
    api_v3_key: '',
    sign_type: w.signType || 'MD5',
    cert_path: w.certPath || '',
    cert_serial_no: '',
    notify_url: w.notifyUrl || '/api/payment/notify',
    refund_notify_url: w.refundNotifyUrl || '',
    order_expire_minutes: 30,
    remark: ''
  };
}

/** 把 DB 记录（密文字段）解密成进程内可用的明文配置 */
function decryptRow(row) {
  const plain = row.get ? row.get({ plain: true }) : row;
  return {
    channel: plain.channel || 'wechat',
    mode: plain.mode || 'mock',
    enabled: Number(plain.enabled) === 1 ? 1 : 0,
    app_id: plain.app_id || '',
    mch_id: plain.mch_id || '',
    sub_app_id: plain.sub_app_id || '',
    sub_mch_id: plain.sub_mch_id || '',
    api_key: decryptSecret(plain.api_key_enc) || '',
    api_v3_key: decryptSecret(plain.api_v3_key_enc) || '',
    sign_type: plain.sign_type || 'MD5',
    cert_path: plain.cert_path || '',
    cert_serial_no: plain.cert_serial_no || '',
    notify_url: plain.notify_url || '/api/payment/notify',
    refund_notify_url: plain.refund_notify_url || '',
    order_expire_minutes: Number(plain.order_expire_minutes) || 30,
    remark: plain.remark || '',
    updated_at: plain.updated_at || null,
    updated_by: plain.updated_by || null
  };
}

/**
 * 启动/热更新时调用：从 DB 载入配置到内存
 * 失败（表不存在 / 连不上）不抛错，静默回退 env —— 支付链路不能因为配置读取失败就挂掉
 */
async function load() {
  try {
    const row = await PaymentConfig.findOne({ where: { channel: 'wechat' } });
    if (row) {
      cache = decryptRow(row);
      cacheSource = 'db';
    } else {
      cache = fromEnv();
      cacheSource = 'env';
    }
  } catch (e) {
    cache = fromEnv();
    cacheSource = 'env';
    console.warn('[payConfig] 读取支付配置失败，回退环境变量:', e.message);
  }
  loaded = true;
  return cache;
}

/** 同步获取当前生效配置（wechatPayService 用） */
function get() {
  if (!loaded || !cache) cache = fromEnv();
  return cache;
}

function source() {
  return cacheSource;
}

/** 脱敏后给前端：密钥只回掩码 + 是否已设置 */
function masked() {
  const c = get();
  return {
    channel: c.channel,
    mode: c.mode,
    enabled: c.enabled,
    app_id: c.app_id,
    mch_id: c.mch_id,
    sub_app_id: c.sub_app_id,
    sub_mch_id: c.sub_mch_id,
    sign_type: c.sign_type,
    cert_path: c.cert_path,
    cert_serial_no: c.cert_serial_no,
    notify_url: c.notify_url,
    refund_notify_url: c.refund_notify_url,
    order_expire_minutes: c.order_expire_minutes,
    remark: c.remark,
    updated_at: c.updated_at,
    // 密钥：只回掩码与「是否设置」，明文永不出网
    api_key_masked: c.api_key ? maskSecret(c.api_key) : '',
    api_key_set: !!c.api_key,
    api_v3_key_masked: c.api_v3_key ? maskSecret(c.api_v3_key) : '',
    api_v3_key_set: !!c.api_v3_key,
    source: cacheSource
  };
}

/**
 * 保存配置
 * @param {object} patch 前端提交字段；api_key / api_v3_key 传掩码或空表示「不改」
 * @param {number} adminId
 */
async function save(patch, adminId) {
  const cur = get();
  const next = { ...cur };

  for (const k of EDITABLE) {
    if (patch[k] === undefined) continue;
    let v = patch[k];
    if (k === 'mode') {
      v = String(v || '').trim();
      if (!MODES.includes(v)) throw new Error('无效的支付模式: ' + v);
    }
    if (k === 'sign_type') {
      v = String(v || '').trim();
      if (!SIGN_TYPES.includes(v)) throw new Error('无效的签名类型: ' + v);
    }
    if (k === 'enabled') v = Number(v) === 1 ? 1 : 0;
    if (k === 'order_expire_minutes') {
      v = parseInt(v, 10);
      if (Number.isNaN(v) || v < 1 || v > 1440) throw new Error('订单有效期需在 1~1440 分钟之间');
    }
    if (typeof v === 'string') v = v.trim();
    next[k] = v;
  }

  // 密钥：前端回传掩码 / 空 → 保持原值不动；否则更新
  // 掩码判定：等于当前值的掩码，或含 4 个以上连续星号（真实密钥不会出现星号）
  ['api_key', 'api_v3_key'].forEach((k) => {
    const v = patch[k];
    if (v === undefined || v === null || v === '' || v === MASK_PLACEHOLDER) return;
    if (typeof v === 'string' && (v === maskSecret(cur[k]) || /\*{4,}/.test(v))) return;
    next[k] = String(v);
  });

  // 生产模式必备项校验（mock 允许留空）
  if (next.mode === 'real') {
    const miss = [];
    if (!next.app_id) miss.push('app_id');
    if (!next.mch_id) miss.push('mch_id');
    if (!next.api_key) miss.push('api_key');
    if (!next.notify_url) miss.push('notify_url');
    if (miss.length) throw new Error('生产模式缺少必填项: ' + miss.join(', '));
  }
  if (next.mode === 'sandbox' && !next.mch_id) {
    throw new Error('沙箱模式需填写商户号');
  }

  const payload = {
    channel: 'wechat',
    mode: next.mode,
    enabled: next.enabled,
    app_id: next.app_id || null,
    mch_id: next.mch_id || null,
    sub_app_id: next.sub_app_id || null,
    sub_mch_id: next.sub_mch_id || null,
    api_key_enc: encryptSecret(next.api_key),
    api_v3_key_enc: encryptSecret(next.api_v3_key),
    sign_type: next.sign_type,
    cert_path: next.cert_path || null,
    cert_serial_no: next.cert_serial_no || null,
    notify_url: next.notify_url || null,
    refund_notify_url: next.refund_notify_url || null,
    order_expire_minutes: next.order_expire_minutes,
    remark: next.remark || null,
    updated_by: adminId || null
  };

  let row = await PaymentConfig.findOne({ where: { channel: 'wechat' } });
  if (row) {
    await row.update(payload);
  } else {
    row = await PaymentConfig.create(payload);
  }

  await load();   // 热更新内存
  return { row, config: get() };
}

/**
 * 配置自检：不发起真实请求，只做参数与文件可用性检查
 * @returns {{ok:boolean, mode:string, issues:Array<{level:string,message:string}>}}
 */
function selfTest() {
  const c = get();
  const issues = [];

  /**
   * issue 统一结构：{ level, code, params, message }
   *   code   → 前端按 ec9.payCfg.issue.<code> 取译文，切语言才能跟着变
   *   message → 中文兜底（接口直接调用者也能看懂；前端取不到译文时用）
   */
  const add = (level, code, message, params) => {
    issues.push({ level, code, params: params || [], message });
  };

  if (c.mode === 'mock') {
    add('info', 'modeMock', '当前为模拟模式：下单返回假 code_url，不产生真实交易，适合开发联调');
  }

  if (c.mode !== 'mock') {
    if (!c.app_id) add('error', 'missingAppId', '缺少 appid');
    if (!c.mch_id) add('error', 'missingMchId', '缺少商户号');
    if (!c.api_key) add('error', 'missingApiKey', '缺少 API 密钥');
    if (!c.notify_url) add('error', 'missingNotifyUrl', '缺少支付回调地址');
    if (c.app_id && !/^wx[a-z0-9]{10,}$/i.test(c.app_id)) {
      add('warn', 'appIdFormat', 'appid 格式看起来不像微信 appid（通常以 wx 开头）', [c.app_id]);
    }
    if (c.mch_id && !/^\d{6,12}$/.test(c.mch_id)) {
      add('warn', 'mchIdFormat', '商户号应为 6~12 位数字，当前为：{0}', [c.mch_id]);
    }
    if (c.api_key && c.api_key.length !== 32) {
      add('warn', 'apiKeyLength', 'API v2 密钥一般为 {0} 位，当前 {1} 位', ['32', String(c.api_key.length)]);
    }
  }

  if (c.notify_url && !/^https?:\/\//i.test(c.notify_url)) {
    add('info', 'notifyRelative', '回调地址是相对路径，下单时会自动拼接站点域名：{0}', [c.notify_url]);
  }
  if (c.notify_url && /^https?:\/\//i.test(c.notify_url) && !/^https:/i.test(c.notify_url)) {
    add('warn', 'notifyNotHttps', '回调地址不是 https，微信生产环境要求 https');
  }

  if (c.cert_path) {
    if (!fs.existsSync(c.cert_path)) {
      add('warn', 'certMissing', '证书文件不存在，退款将不可用：{0}', [c.cert_path]);
    } else {
      add('ok', 'certOk', 'API 证书文件可读');
    }
  } else if (c.mode === 'real') {
    add('warn', 'certUnset', '未配置 API 证书，退款功能不可用（下单不受影响）');
  }

  if (Number(c.enabled) !== 1) {
    add('warn', 'disabled', '支付渠道当前为停用状态');
  }

  const hasError = issues.some(i => i.level === 'error');
  return {
    ok: !hasError,
    mode: c.mode,
    enabled: Number(c.enabled) === 1,
    source: cacheSource,
    issues
  };
}

module.exports = {
  load, get, save, masked, selfTest, source,
  MODES, SIGN_TYPES
};
