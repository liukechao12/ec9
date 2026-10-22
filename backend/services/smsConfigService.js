/**
 * EC9 短信配置服务（后台可改，热更新）
 *
 * 背景：短信通道凭证与验证码参数原先全在 .env（ALIYUN_ACCESS_KEY_ID / SMS_*），
 *      改一次要重启、客户自己也改不了。与支付配置同一套做法：落库 + 后台可改 + 热更新。
 *
 * 取值优先级：DB（name='aliyun' 且启用）> .env（DB 无记录时回退）
 *
 * 对外接口只回掩码，AccessKey Secret 明文只在进程内存里给发送客户端用。
 */
const config = require('../config');
const { SmsProvider } = require('../models');
const { encryptSecret, decryptSecret, maskSecret } = require('../utils/secretCrypto');

let cache = null;
let cacheSource = 'env';
let loaded = false;

/** 可后台修改的字段白名单 */
const EDITABLE = [
  'enabled', 'region', 'endpoint', 'sign_name', 'verify_template_code',
  'code_expire_minutes', 'code_resend_seconds', 'code_max_attempts', 'code_daily_limit', 'remark'
];

const DEFAULT_ROW = {
  name: 'aliyun',
  enabled: 0,
  region: 'cn-hangzhou',
  endpoint: '',
  sign_name: '',
  verify_template_code: '',
  access_key_id: '',
  access_key_secret: '',
  code_expire_minutes: 5,
  code_resend_seconds: 60,
  code_max_attempts: 5,
  code_daily_limit: 10,
  remark: ''
};

function fromEnv() {
  const s = config.sms;
  return {
    ...DEFAULT_ROW,
    enabled: s.accessKeyId && s.accessKeySecret ? 1 : 0,
    region: s.region || 'cn-hangzhou',
    sign_name: s.verificationCodeSign || '',
    verify_template_code: s.verificationCodeTemplate || '',
    access_key_id: s.accessKeyId || '',
    access_key_secret: s.accessKeySecret || '',
    code_expire_minutes: s.codeExpireMinutes || 5,
    code_resend_seconds: s.codeResendSeconds || 60,
    code_max_attempts: s.codeMaxAttempts || 5,
    code_daily_limit: s.codeDailyLimit || 10
  };
}

function decryptRow(row) {
  const p = row.get ? row.get({ plain: true }) : row;
  let cred = null;
  try {
    const raw = decryptSecret(p.config_encrypted);
    if (raw) cred = JSON.parse(raw);
  } catch (e) { /* 凭证损坏 → 当作没配 */ }
  return {
    id: p.id,
    name: p.name,
    enabled: Number(p.enabled) === 1 ? 1 : 0,
    region: p.region || 'cn-hangzhou',
    endpoint: p.endpoint || '',
    sign_name: p.sign_name || '',
    verify_template_code: p.verify_template_code || '',
    access_key_id: (cred && cred.accessKeyId) || '',
    access_key_secret: (cred && cred.accessKeySecret) || '',
    code_expire_minutes: Number(p.code_expire_minutes) || 5,
    code_resend_seconds: Number(p.code_resend_seconds) || 60,
    code_max_attempts: Number(p.code_max_attempts) || 5,
    code_daily_limit: Number(p.code_daily_limit) || 10,
    remark: p.remark || '',
    updated_at: p.updated_at || null
  };
}

async function load() {
  try {
    const row = await SmsProvider.findOne({ where: { name: 'aliyun' } });
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
    console.warn('[smsConfig] 读取短信配置失败，回退环境变量:', e.message);
  }
  loaded = true;
  return cache;
}

function get() {
  if (!loaded || !cache) cache = fromEnv();
  return cache;
}

function source() { return cacheSource; }

/** 通道是否可用（有凭证且启用） */
function ready() {
  const c = get();
  return Number(c.enabled) === 1 && !!c.access_key_id && !!c.access_key_secret;
}

/** 脱敏输出（Secret 永不外传） */
function masked() {
  const c = get();
  return {
    name: c.name,
    enabled: c.enabled,
    region: c.region,
    endpoint: c.endpoint,
    sign_name: c.sign_name,
    verify_template_code: c.verify_template_code,
    access_key_id: c.access_key_id,
    access_key_secret_masked: c.access_key_secret ? maskSecret(c.access_key_secret) : '',
    access_key_secret_set: !!c.access_key_secret,
    code_expire_minutes: c.code_expire_minutes,
    code_resend_seconds: c.code_resend_seconds,
    code_max_attempts: c.code_max_attempts,
    code_daily_limit: c.code_daily_limit,
    remark: c.remark,
    updated_at: c.updated_at,
    source: cacheSource,
    ready: ready()
  };
}

async function save(patch, adminId) {
  const cur = get();
  const next = { ...cur };

  for (const k of EDITABLE) {
    if (patch[k] === undefined) continue;
    let v = patch[k];
    if (k === 'enabled') v = Number(v) === 1 ? 1 : 0;
    if (['code_expire_minutes', 'code_resend_seconds', 'code_max_attempts', 'code_daily_limit'].includes(k)) {
      v = parseInt(v, 10);
      if (Number.isNaN(v) || v < 1) throw new Error('参数必须为正整数: ' + k);
    }
    if (typeof v === 'string') v = v.trim();
    next[k] = v;
  }

  // 凭证：留空 / 回传掩码 = 不修改
  if (patch.access_key_id !== undefined) next.access_key_id = String(patch.access_key_id || '');
  if (patch.access_key_secret !== undefined && patch.access_key_secret !== '') {
    const v = String(patch.access_key_secret);
    if (!(v === maskSecret(cur.access_key_secret) || /\*{4,}/.test(v))) next.access_key_secret = v;
  }

  if (next.code_expire_minutes > 60) throw new Error('验证码有效期不能超过 60 分钟');
  if (next.code_daily_limit > 100) throw new Error('每日上限不能超过 100 条');

  const payload = {
    name: 'aliyun',
    enabled: next.enabled,
    region: next.region || 'cn-hangzhou',
    endpoint: next.endpoint || null,
    sign_name: next.sign_name || null,
    verify_template_code: next.verify_template_code || null,
    config_encrypted: encryptSecret(JSON.stringify({
      accessKeyId: next.access_key_id || '',
      accessKeySecret: next.access_key_secret || ''
    })),
    code_expire_minutes: next.code_expire_minutes,
    code_resend_seconds: next.code_resend_seconds,
    code_max_attempts: next.code_max_attempts,
    code_daily_limit: next.code_daily_limit,
    remark: next.remark || null,
    is_default: 1
  };

  let row = await SmsProvider.findOne({ where: { name: 'aliyun' } });
  if (row) await row.update(payload);
  else row = await SmsProvider.create(payload);

  await load();
  return { row, config: get() };
}

/**
 * 配置自检：只检查参数完整性，不发真实短信
 */
function selfTest() {
  const c = get();
  const issues = [];
  const add = (level, code, message, params) => issues.push({ level, code, params: params || [], message });

  if (Number(c.enabled) !== 1) {
    add('warn', 'disabled', '短信通道当前为停用状态，不会真正发送（开发期可忽略）');
  }
  if (!c.access_key_id) add('error', 'missingAkId', '缺少 AccessKey ID');
  if (!c.access_key_secret) add('error', 'missingAkSecret', '缺少 AccessKey Secret');
  if (!c.sign_name) add('warn', 'missingSign', '未配置短信签名，发送会被服务商拒绝');
  if (!c.verify_template_code) add('warn', 'missingVerifyTpl', '未配置验证码模板 CODE，手机号验证短信无法发送');
  if (c.access_key_id && !/^LTAI/i.test(c.access_key_id)) {
    add('info', 'akIdFormat', 'AccessKey ID 通常以 LTAI 开头，当前值看起来不像：{0}', [c.access_key_id]);
  }
  if (c.sign_name && /云玺/.test(c.sign_name)) {
    add('warn', 'staleSign', '签名仍是旧主体「云玺科技」，客户侧需换成实际报备的签名');
  }
  if (c.access_key_id && c.access_key_secret && Number(c.enabled) === 1 && c.sign_name && c.verify_template_code) {
    add('ok', 'allGood', '通道参数齐全，可发起真实发送');
  }

  return {
    ok: !issues.some(i => i.level === 'error'),
    enabled: Number(c.enabled) === 1,
    source: cacheSource,
    ready: ready(),
    issues
  };
}

module.exports = {
  load, get, save, masked, selfTest, source, ready
};
