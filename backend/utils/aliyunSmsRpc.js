/**
 * 阿里云短信 · 自研 RPC 客户端（不依赖任何 SDK）
 *
 * 为什么需要它：
 *   生产环境 @alicloud/dysmsapi20170525 并未安装（node_modules/@alicloud 是空目录），
 *   utils/aliyunSmsClient.js 那条依赖 SDK 的路走不通，会静默退化成 MockSms —— 日志里
 *   显示"发送成功"，实际一条短信都没发出去。验证码链路用的是另一套自研实现
 *   （verificationSmsService.sendViaAliyun），所以验证码能真发、业务短信不能。
 *
 * 这里把自研实现抽出来共用：业务短信在 SDK 缺失时回退到它，两条链路口径一致。
 *
 * 要点（踩过的坑）：
 *   - 阿里云 dysmsapi 已不接受 GET，必须 POST 表单（GET 返回 UnsupportedHTTPMethod）
 *   - 签名串固定以 "POST&%2F&" 开头，与实际请求方法保持一致
 *   - RFC3986 编码：! ' ( ) * 都要转义
 */
const crypto = require('crypto');
const https = require('https');

/** RFC3986 编码（阿里云 POP 要求，比 encodeURIComponent 更严格） */
function pct(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** 阿里云 POP 签名（HMAC-SHA1，RPC 风格） */
function aliyunSign(params, secret) {
  const sorted = Object.keys(params).sort()
    .map(k => pct(k) + '=' + pct(params[k]))
    .join('&');
  const stringToSign = 'POST&%2F&' + pct(sorted);
  return crypto.createHmac('sha1', secret + '&').update(stringToSign).digest('base64');
}

/**
 * 发送短信
 * @param {object} p
 * @param {string} p.accessKeyId
 * @param {string} p.accessKeySecret
 * @param {string} p.phone        明文手机号
 * @param {string} p.signName     短信签名（必须与云端报备逐字一致）
 * @param {string} p.templateCode 模板 CODE
 * @param {object} [p.templateParam] 模板变量；无变量模板请传 null，不要传空对象
 * @param {string} [p.region]
 * @returns {Promise<{Code:string, Message:string, RequestId?:string, BizId?:string}>}
 */
async function sendSmsRpc({ accessKeyId, accessKeySecret, phone, signName, templateCode, templateParam, region }) {
  const params = {
    AccessKeyId: accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomBytes(16).toString('hex'),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().slice(0, 19) + 'Z',
    Version: '2017-05-25',
    RegionId: region || 'cn-hangzhou',
    PhoneNumbers: phone,
    SignName: signName,
    TemplateCode: templateCode
  };
  // 无变量模板不能带 TemplateParam，否则可能被判 TEMPLATE_PARAMS_ILLEGAL
  if (templateParam && Object.keys(templateParam).length) {
    params.TemplateParam = JSON.stringify(templateParam);
  }
  params.Signature = aliyunSign(params, accessKeySecret);

  const body = Object.keys(params).sort()
    .map(k => pct(k) + '=' + pct(params[k]))
    .join('&');

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
          // 统一成 { Code, Message }，与 SDK 返回口径一致
          resolve({
            Code: json.Code || json.code || '',
            Message: json.Message || json.message || '',
            RequestId: json.RequestId || json.requestId,
            BizId: json.BizId || json.bizId,
            raw: json
          });
        } catch (e) {
          reject(new Error('短信返回解析失败: ' + buf.slice(0, 200)));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('短信请求超时')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { sendSmsRpc, pct, aliyunSign };
