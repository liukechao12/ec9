/**
 * 自动翻译服务（腾讯交互翻译 TMT / Tencent Translation Mart）
 *
 * 用途：后台填写活动名称/描述/地点时，写完简体 → 一键生成繁體与英文，
 *      生成后可人工修改再保存。
 *
 * 需要的配置（.env）：
 *   TENCENT_TMT_APPID=xxx
 *   TENCENT_TMT_SECRET=xxx
 *
 * 没配 Key 时：
 *   - translateBatch() 返回 { ok:false, reason:'not-configured' }
 *   - 前端按钮会提示「未配置翻译服务」，不会静默失败
 *
 * 接口文档：https://cloud.tencent.com/document/product/551/15619
 */

const https = require('https');
const crypto = require('crypto');

const API_HOST = 'tmt.tencentcloudapi.com';
const API_SERVICE = 'tmt';
const API_VERSION = '2018-03-21';
const ACTION_TEXT_TRANS = 'TextTranslate';

/** 我们的语种代号 → 腾讯的语种代号 */
const LANG_MAP = {
  'zh-CN': 'zh',
  'zh-TW': 'zh-TW',
  'en': 'en'
};

/**
 * 把腾讯 API 响应的 JSON 字符串还原成 JS 对象。
 * 腾讯返回的是扁平 JSON，形如 {"Response":{"TargetText":"...","RequestId":"..."}}
 */
function parseTencentJson(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    // 腾讯某些接口返回的是 JSONP 包裹
    const m = /\{[\s\S]*\}/.exec(str);
    if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
    return null;
  }
}

function isConfigured() {
  return !!(process.env.TENCENT_TMT_APPID && process.env.TENCENT_TMT_SECRET);
}

/** 构造签名（TC3-HMAC-SHA256）
 *
 *  ⚠️ 两个时间格式别搞混：
 *      X-TC-Timestamp 头部 → **Unix 秒级时间戳**（整数）
 *      CredentialScope 日期 → **UTC 日期字符串** YYYY-MM-DD
 *      二者不是同一个东西，算错会报 InvalidParameter。
 */
function sign(payload, isoTime, service, host) {
  const date = isoTime.slice(0, 10);
  const unixTs = Math.floor(Date.now() / 1000);
  const signedHeaders = 'content-type;host';
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const hashedPayload = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(unixTs), credentialScope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')].join('\n');

  const secretDate = crypto.createHmac('sha256', 'TC3' + process.env.TENCENT_TMT_SECRET)
    .update(date).digest();
  const secretService = crypto.createHmac('sha256', secretDate).update(service).digest();
  const secretKey = crypto.createHmac('sha256', secretService).update('tc3_request').digest();
  return crypto.createHmac('sha256', secretKey).update(stringToSign, 'utf8').digest('hex');
}

/**
 * 专有词纠错表。
 *
 * 机器翻译常犯的错：
 *   「VIP」→「vip」（大小写错）  「答谢会」→「Thank-offering Event」（用词怪）
 *   「业绩说明会」→「Performance Meeting」（应为 Briefing）
 * 占位符方案实测不可靠（数字占位会被吃掉或错位），改用**译后纠错**。
 *
 * 规则：key= 错误译法（不区分大小写），value= 正确译法。
 * 命中即整体替换，不做部分匹配，避免误伤。
 */
const TERM_FIXES = [
  // 大小写纠正：机器翻译爱把缩写改成小写
  [/\bvip\b/gi, 'VIP'],
  [/\bapi\b/gi, 'API'],
  [/\bpdf\b/gi, 'PDF'],
  [/\bh5\b/gi, 'H5'],
  [/\bcrm\b/gi, 'CRM'],
  [/\bec8\b/gi, 'EC8'],
  [/\bec9\b/gi, 'EC9'],
  [/\bsms\b/gi, 'SMS'],
  [/\bwechat\b/gi, 'WeChat'],
  [/\bapp\b/gi, 'App'],
  // 用词纠正
  [/Performance\s+Meeting/gi, 'Performance Briefing'],
  [/Thank-offering\s+Event/gi, 'Client Appreciation Event'],
  [/Guest\s+Appreciation\s+Dinner/gi, 'VIP Client Gala'],
  [/Open\s+Registration\s*\(/gi, 'Open Registration ('],
  [/Intercontinental\s+Shenzhen\s+hotel/gi, 'Intercontinental Shenzhen Hotel'],
  [/Technolog(y|ical)\s+Open\s+Day/gi, 'Tech Open Day'],
  [/Keynotes?\s+and\s+workshops?\s+will\s+be\s+held\s+simultaneously/gi,
   'Keynotes and workshops run in parallel']
];

/** 对译文做术语纠错 */
function fixTerms(text) {
  let out = String(text || '');
  TERM_FIXES.forEach(([re, fix]) => { out = out.replace(re, fix); });
  // 规整多余空格（纠错后可能留下）
  out = out.replace(/\s{2,}/g, ' ').trim();
  return out;
}

/**
 * 调腾讯文本翻译。
 * @param {string} text
 * @param {string} from  'zh-CN' | 'zh-TW' | 'en'
 * @param {string} to
 * @returns {Promise<{ok:boolean, text?:string, error?:string, reason?:string}>}
 */
function translateOne(text, from, to) {
  return new Promise(resolve => {
    if (!isConfigured()) {
      return resolve({ ok: false, reason: 'not-configured' });
    }
    const content = String(text || '').trim();
    if (!content) return resolve({ ok: false, reason: 'empty' });

    const srcLang = LANG_MAP[from] || 'zh';
    const tgtLang = LANG_MAP[to] || 'en';
    if (srcLang === tgtLang) return resolve({ ok: true, text: content });

    const masked = content;

    // 腾讯单次请求有长度上限，超长分批
    if (content.length > 5000) {
      return resolve({ ok: false, reason: 'too-long', error: '内容超过 5000 字，请分段翻译' });
    }

    const payload = JSON.stringify({
      SourceText: masked,
      Source: srcLang,
      Target: tgtLang,
      ProjectId: 0
    });

    const now = new Date();
    const unixTs = Math.floor(now.getTime() / 1000);          // 头部要Unix 秒
    const isoTime = now.toISOString().replace(/\.\d{3}Z$/, 'Z'); // 签名用 ISO
    const signature = sign(payload, isoTime, API_SERVICE, API_HOST);

    const req = https.request({
      hostname: API_HOST,
      path: '/',
      method: 'POST',
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Host': API_HOST,
        'X-TC-Action': ACTION_TEXT_TRANS,
        'X-TC-Version': API_VERSION,
        'X-TC-Timestamp': String(unixTs),
        'X-TC-Region': process.env.TENCENT_TMT_REGION || 'ap-guangzhou',
        'Authorization': `TC3-HMAC-SHA256 Credential=${process.env.TENCENT_TMT_APPID}/${isoTime.slice(0, 10)}/${API_SERVICE}/tc3_request, SignedHeaders=content-type;host, Signature=${signature}`
      }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        const json = parseTencentJson(buf);
        if (!json) return resolve({ ok: false, error: '返回格式无法解析', raw: buf.slice(0, 200) });
        const r = json.Response || {};
        if (r.Error) {
          return resolve({ ok: false, error: `${r.Error.Code || ''} ${r.Error.Message || '翻译失败'}` });
        }
        if (r.TargetText == null || r.TargetText === '') {
          return resolve({ ok: false, error: '翻译结果为空' });
        }
        resolve({ ok: true, text: fixTerms(r.TargetText) });
      });
    });

    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '请求超时' }); });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

/**
 * 批量翻译一个对象的多个语种。
 * @param {string} text       简体原文
 * @param {string[]} targets  目标语种，如 ['zh-TW','en']
 * @returns {Promise<{ok, results:{'zh-TW':'…',en:'…'}, errors:[]}>}
 */
async function translateBatch(text, targets) {
  const content = String(text || '').trim();
  const list = (targets && targets.length) ? targets : ['zh-TW', 'en'];
  if (!content) return { ok: false, reason: 'empty', results: {}, errors: ['内容为空'] };
  if (!isConfigured()) return { ok: false, reason: 'not-configured', results: {}, errors: ['翻译服务未配置'] };

  const results = {};
  const errors = [];
  // 串行 + 间隔。免费额度限4 QPS，这里保守取 350ms 间隔（约 2.8 QPS）。
  for (const t of list) {
    const r = await translateOne(content, 'zh-CN', t);
    if (r.ok) results[t] = r.text;
    else if (r.error && r.error.includes('RequestLimitExceeded')) {
      // 命中限流：等一下再重试一次
      await new Promise(res => setTimeout(res, 1200));
      const retry = await translateOne(content, 'zh-CN', t);
      if (retry.ok) results[t] = retry.text;
      else errors.push(`${t}: ${retry.error || retry.reason}`);
    } else {
      errors.push(`${t}: ${r.error || r.reason}`);
    }
    await new Promise(res => setTimeout(res, 350));
  }
  return { ok: Object.keys(results).length > 0, results, errors };
}

module.exports = { translateOne, translateBatch, isConfigured, fixTerms, TERM_FIXES, LANG_MAP };
