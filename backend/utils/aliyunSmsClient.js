/**
 * 阿里云短信客户端封装
 *
 * ⚠️ 2026-10-14 改造：凭证不再从 .env 读，改从 smsConfigService（数据库，后台可改）。
 *    因此不能在模块加载时初始化客户端 —— 那时库还没连、配置也没载入，
 *    而且后台改完凭证后必须能立刻生效。这里改成「按配置指纹惰性重建」。
 */
const smsConfig = require('../services/smsConfigService');
const { sendSmsRpc } = require('./aliyunSmsRpc');

let DysmsClient = null;
let SendSmsRequest = null;
let clientFp = null;     // 当前客户端对应的配置指纹
let sdkMissing = false;

/** 配置指纹：凭证/endpoint/region 变了就重建客户端 */
function fingerprint(c) {
  return [c.access_key_id, c.access_key_secret, c.endpoint || '', c.region || ''].join('|');
}

function buildClient(c) {
  try {
    const Core = require('@alicloud/dysmsapi20170525');
    const OpenApi = require('@alicloud/openapi-client');
    const cfg = new OpenApi.Config({ accessKeyId: c.access_key_id, accessKeySecret: c.access_key_secret });
    cfg.endpoint = c.endpoint || `dysmsapi.aliyuncs.com`;
    DysmsClient = new Core.default(cfg);
    SendSmsRequest = Core.SendSmsRequest;
    return true;
  } catch (e) {
    sdkMissing = true;
    console.warn('阿里云短信SDK未安装或初始化失败，如需真实发短信请安装：@alicloud/dysmsapi20170525', e.message);
    return false;
  }
}

/**
 * 取客户端；凭证不全 / 未启用 / SDK 缺失时返回 null（调用方走 mock 或报错）
 */
function getClient() {
  const c = smsConfig.get();
  if (Number(c.enabled) !== 1 || !c.access_key_id || !c.access_key_secret) return null;
  const fp = fingerprint(c);
  if (clientFp === fp && DysmsClient) return DysmsClient;
  if (!buildClient(c)) return null;
  clientFp = fp;
  return DysmsClient;
}

async function sendSms({ PhoneNumbers, SignName, TemplateCode, TemplateParam }) {
  const client = getClient();
  if (!client || !SendSmsRequest) {
    // SDK 不在（生产 @alicloud 未安装）→ 回退自研 RPC，绝不能静默 mock：
    // 那样日志写着"发送成功"，实际一条都没发出去，排查时极易被误导。
    const c = smsConfig.get();
    if (Number(c.enabled) === 1 && c.access_key_id && c.access_key_secret && SignName && TemplateCode) {
      try {
        let parsed = null;
        if (TemplateParam) { try { parsed = JSON.parse(TemplateParam); } catch (e) { parsed = null; } }
        console.log('[AliyunRpc] sendSms（SDK 缺失，走自研 RPC）:', { PhoneNumbers, SignName, TemplateCode });
        return await sendSmsRpc({
          accessKeyId: c.access_key_id,
          accessKeySecret: c.access_key_secret,
          region: c.region,
          phone: PhoneNumbers,
          signName: SignName,
          templateCode: TemplateCode,
          templateParam: parsed
        });
      } catch (e) {
        return { Code: 'EXCEPTION', Message: e.message };
      }
    }
    // 真的没配通道（开发期）：仅打印日志，方便本地开发，也防止启动报错
    console.log('[MockSms] sendSms:', { PhoneNumbers, SignName, TemplateCode, TemplateParam });
    return { Code: 'OK', Message: 'Mock send success' };
  }

  const request = new SendSmsRequest({
    phoneNumbers: PhoneNumbers,
    signName: SignName,
    templateCode: TemplateCode,
    templateParam: TemplateParam
  });

  const resp = await client.sendSms(request);
  // 统一响应格式：优先使用 body，没有则取 resp 本身
  const response = resp.body || resp;
  if (response) {
    if (response.code && !response.Code) response.Code = response.code;
    if (response.message && !response.Message) response.Message = response.message;
  }
  return response;
}

module.exports = { sendSms, getClient, isSdkMissing: () => sdkMissing };
