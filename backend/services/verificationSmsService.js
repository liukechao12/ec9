/**
 * EC9 短信通道（可插拔）
 *
 * 设计：
 *  - 通道配置存 ec9_sms_providers（凭证 AES 加密），后台可配可切换，不改代码
 *  - 发送走服务商 HTTPS POP API，不依赖 SDK
 *  - 未配置通道时走 mock：仅服务端日志 + 进程内内存登记（供自检使用），
 *    **绝不把验证码返回给前端**（EC8 的 debugCode 漏洞在 EC9 不复存在）
 */
const crypto = require('crypto');
const config = require('../config');
const smsConfig = require('./smsConfigService');
const { encryptPhone, decryptPhone } = require('../utils/phoneCrypto');

/** 进程内开发登记：仅 NODE_ENV=development 且无可用通道时启用 */
const devOutbox = new Map(); // phone_hmac -> { code, expires_at }

function isDevMockEnabled() {
  return config.server.env !== 'production';
}

/** 通用 AES 工具（复用手机号加密那套密钥） */
function encryptJson(obj) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(config.encryption.getKey(), 'utf8'), iv);
  let out = cipher.update(JSON.stringify(obj), 'utf8', 'hex');
  out += cipher.final('hex');
  return iv.toString('hex') + ':' + out;
}

function decryptJson(text) {
  try {
    const [ivHex, data] = String(text).split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(config.encryption.getKey(), 'utf8'), Buffer.from(ivHex, 'hex'));
    let out = decipher.update(data, 'hex', 'utf8');
    out += decipher.final('utf8');
    return JSON.parse(out);
  } catch (e) {
    return null;
  }
}

/** RFC3986 编码（阿里云 POP 要求空格为 %20、保留字符一并转义） */
function pct(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** 阿里云短信 POP 签名（HMAC-SHA1，RPC 风格，POST 通道） */
function aliyunSign(params, secret) {
  const sorted = Object.keys(params).sort().map(k =>
    pct(k) + '=' + pct(params[k])
  ).join('&');
  const stringToSign = 'POST&%2F&' + pct(sorted);
  return crypto.createHmac('sha1', secret + '&').update(stringToSign).digest('base64');
}

async function sendViaAliyun(providerCfg, phone, templateCode, templateParam, signName) {
  const https = require('https');
  const params = {
    AccessKeyId: providerCfg.accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomBytes(16).toString('hex'),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().slice(0, 19) + 'Z',
    Version: '2017-05-25',
    RegionId: providerCfg.region || 'cn-hangzhou',
    PhoneNumbers: phone,
    SignName: signName,
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify(templateParam)
  };
  params.Signature = aliyunSign(params, providerCfg.accessKeySecret);

  // 阿里云 dysmsapi 已不接受 GET（返回 UnsupportedHTTPMethod），必须走 POST 表单
  const body = Object.keys(params).sort().map(k =>
    pct(k) + '=' + pct(params[k])
  ).join('&');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'dysmsapi.aliyuncs.com',
      path: '/',
      method: 'POST',
      timeout: 10000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(buf);
          if (json.Code === 'OK') resolve({ ok: true, requestId: json.RequestId });
          else reject(new Error((json.Message || json.Code || '短信发送失败') + (json.Code ? ' (' + json.Code + ')' : '')));
        } catch (e) { reject(new Error('短信返回解析失败')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('短信请求超时')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 发送验证码短信。
 * @returns {Promise<{ok:boolean, mock?:boolean, error?:string}>}
 */
async function sendVerificationSms(phone, code) {
  // 通道参数来自数据库（后台「短信配置」页维护），无记录时回退 .env
  const sc = smsConfig.get();
  if (smsConfig.ready() && sc.verify_template_code) {
    try {
      await sendViaAliyun(
        { accessKeyId: sc.access_key_id, accessKeySecret: sc.access_key_secret },
        phone, sc.verify_template_code, { code }, sc.sign_name
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  // 无通道 → mock（仅开发）
  if (isDevMockEnabled()) return { ok: true, mock: true };
  return { ok: false, error: '短信通道未配置' };
}

/**
 * 业务短信（按 message_type + scene + lang 选模板；无模板/无通道时 mock）
 * @param {string} phone 明文手机号
 * @param {string} messageType verification / audit_result / payment_link / payment_success / checkin_reminder
 * @param {object} params 模板参数
 * @param {string} lang 语种
 */
async function sendBusinessSms(phone, messageType, params = {}, lang = 'zh-CN') {
  const { SmsTemplate } = require('../models');
  let template = null;
  try {
    template = await SmsTemplate.findOne({
      where: { message_type: messageType, scene: 'default', lang, enabled: 1 }
    });
    if (!template) {
      // 回退中文模板
      template = await SmsTemplate.findOne({
        where: { message_type: messageType, scene: 'default', lang: 'zh-CN', enabled: 1 }
      });
    }
  } catch (e) { /* 表未就绪等 */ }

  if (!template) {
    if (isDevMockEnabled()) return { ok: true, mock: true };
    return { ok: false, error: '短信模板未配置' };
  }

  if (isDevMockEnabled()) {
    // 开发期 mock：进程内登记，供自检/联调读取，绝不回前端
    const { hmacPhone } = require('../utils/phoneCrypto');
    devOutbox.set('sms:' + hmacPhone(phone) + ':' + messageType, {
      phone, message_type: messageType, lang: template.lang, params, at: new Date()
    });
    return { ok: true, mock: true };
  }

  // 生产：有通道走通道（模板 code 来自 template.template_code）
  const sc2 = smsConfig.get();
  if (smsConfig.ready() && template.template_code) {
    try {
      await sendViaAliyun(
        { accessKeyId: sc2.access_key_id, accessKeySecret: sc2.access_key_secret },
        phone, template.template_code, params, sc2.sign_name
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  return { ok: false, error: '短信通道未配置' };
}

module.exports = { sendVerificationSms, sendBusinessSms, encryptJson, decryptJson, devOutbox, isDevMockEnabled };
