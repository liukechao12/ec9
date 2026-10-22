/**
 * EC9 微信支付服务（V2，Native 扫码）
 *
 * 三模式（WXPAY_MODE）：
 *   mock   本地模拟：无资质开发期全链路可跑（下单返回假 code_url，
 *          /api/payment/mock-pay 模拟用户扫码付款 → 直接触发支付成功处理）
 *   sandbox 微信沙箱：先 getsignkey 拿沙箱密钥，链路与生产一致
 *   real   生产：需要商户资质 + API 密钥 + apiclient_cert.p12（退款）
 *
 * 安全：
 *   - 回调验签在服务端完成，不信任前端任何"支付成功"通知
 *   - 回调金额与订单金额核对，不一致拒绝
 *   - 幂等：同一 out_trade_no 重复通知只处理一次（markPaid 内部幂等）
 */
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const config = require('../config');
const payConfig = require('./payConfigService');
const xml = require('../utils/xml');

const WX_HOST = 'api.mch.weixin.qq.com';

/** 沙箱签名缓存 */
let sandboxKeyCache = null;

function nonceStr() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * V2 签名：参数排序拼接 + &key=商户密钥
 * signType: MD5（默认）或 HMAC-SHA256，微信两种都支持，需与后台配置的签名类型一致
 */
function sign(params, key, signType) {
  const str = Object.keys(params).filter(k => k !== 'sign' && params[k] !== undefined && params[k] !== '')
    .sort().map(k => `${k}=${params[k]}`).join('&') + `&key=${key}`;
  const type = String(signType || 'MD5').toUpperCase();
  if (type === 'HMAC-SHA256') {
    return crypto.createHmac('sha256', key).update(str).digest('hex').toUpperCase();
  }
  return crypto.createHash('md5').update(str).digest('hex').toUpperCase();
}

function httpsRequest(url, body, { pfx = null, passphrase = '', timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      timeout,
      headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body) }
    };
    if (pfx) {
      opts.pfx = fs.readFileSync(pfx);
      opts.passphrase = passphrase || payConfig.get().mch_id;
    }
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => { req.destroy(new Error('微信支付请求超时')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 沙箱密钥（sandbox 模式专用，带缓存） */
async function getSandboxKey() {
  if (sandboxKeyCache) return sandboxKeyCache;
  const params = {
    mch_id: payConfig.get().mch_id,
    nonce_str: nonceStr()
  };
  const wxCfg = payConfig.get();
  params.sign = sign(params, wxCfg.api_key, wxCfg.sign_type);
  const res = await httpsRequest(`https://${WX_HOST}/sandboxnew/pay/getsignkey`, xml.build(params));
  const data = xml.parse(res.body);
  if (data.return_code !== 'SUCCESS') throw new Error('沙箱密钥获取失败: ' + (data.return_msg || ''));
  sandboxKeyCache = data.sandbox_signkey;
  return sandboxKeyCache;
}

/** 当前生效的签名密钥 */
async function effectiveKey() {
  if (payConfig.get().mode === 'sandbox') return getSandboxKey();
  return payConfig.get().api_key;
}

/**
 * Native 统一下单
 * @returns {Promise<{ok:boolean, codeUrl?:string, prepayId?:string, error?:string, mock?:boolean}>}
 */
async function unifiedOrder({ orderNo, body, totalFeeFen, ip, productId = orderNo }) {
  const wx = payConfig.get();

  if (wx.mode === 'mock') {
    return {
      ok: true, mock: true,
      codeUrl: `weixin://wxpay/mock/${orderNo}`,
      prepayId: 'MOCK' + crypto.randomBytes(8).toString('hex')
    };
  }

  try {
    const key = await effectiveKey();
    const params = {
      appid: wx.app_id,
      mch_id: wx.mch_id,
      device_info: 'WEB',
      nonce_str: nonceStr(),
      body: String(body).slice(0, 128),
      out_trade_no: orderNo,
      total_fee: String(totalFeeFen),
      spbill_create_ip: ip || '127.0.0.1',
      notify_url: wx.notify_url.startsWith('http') ? wx.notify_url : (config.frontend.baseUrl + wx.notify_url),
      trade_type: 'NATIVE',
      product_id: String(productId).slice(0, 32)
    };
    params.sign = sign(params, key, wx.sign_type);

    const res = await httpsRequest(`https://${WX_HOST}/pay/unifiedorder`, xml.build(params));
    const data = xml.parse(res.body);
    if (data.return_code !== 'SUCCESS') return { ok: false, error: data.return_msg || '统一下单失败' };
    if (data.result_code !== 'SUCCESS') return { ok: false, error: `${data.err_code}: ${data.err_code_des || ''}` };
    return { ok: true, codeUrl: data.code_url, prepayId: data.prepay_id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 回调报文验签 + 结构化
 * @returns {{ok:boolean, error?:string, data?:object}}
 */
async function verifyNotify(xmlBody) {
  const wx = payConfig.get();
  let data;
  try {
    data = xml.parse(xmlBody);
  } catch (e) {
    return { ok: false, error: '回调报文解析失败' };
  }
  if (!data || !data.out_trade_no) return { ok: false, error: '回调报文缺少订单号' };
  // 任何模式都先校验通信状态
  if (data.return_code !== 'SUCCESS') {
    return { ok: false, error: '回调通信状态非成功: ' + (data.return_msg || data.return_code) };
  }
  if (wx.mode === 'mock') {
    // mock 模式不做签名核对（本地模拟链路）
    return { ok: true, data };
  }
  try {
    const key = await effectiveKey();
    const expect = sign(data, key, payConfig.get().sign_type);
    if (data.sign !== expect) return { ok: false, error: '回调验签失败' };
    if (data.result_code && data.result_code !== 'SUCCESS') {
      return { ok: false, error: '回调业务状态非成功' };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 查询订单（对账 / 补偿） */
async function queryOrder(outTradeNo) {
  const wx = payConfig.get();
  if (wx.mode === 'mock') {
    return { ok: true, mock: true, tradeState: 'NOTPAY', data: { out_trade_no: outTradeNo } };
  }
  try {
    const key = await effectiveKey();
    const params = {
      appid: wx.app_id,
      mch_id: wx.mch_id,
      nonce_str: nonceStr(),
      out_trade_no: outTradeNo
    };
    params.sign = sign(params, key, wx.sign_type);
    const res = await httpsRequest(`https://${WX_HOST}/pay/orderquery`, xml.build(params));
    const data = xml.parse(res.body);
    if (data.return_code !== 'SUCCESS') return { ok: false, error: data.return_msg || '查询失败' };
    return {
      ok: true,
      data,
      tradeState: data.trade_state || 'UNKNOWN',
      transactionId: data.transaction_id || null,
      prepayId: data.prepay_id || null
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 申请退款（需 API 证书；mock 模式直接成功）
 */
async function refund({ outTradeNo, totalFeeFen, refundFeeFen, refundNo, reason = '' }) {
  const wx = payConfig.get();
  if (wx.mode === 'mock') {
    return { ok: true, mock: true, data: { out_trade_no: outTradeNo, refund_fee: String(refundFeeFen) } };
  }
  if (wx.mode !== 'real' || !wx.cert_path) {
    return { ok: false, error: '退款需要生产资质与 API 证书（当前模式: ' + wx.mode + '）' };
  }
  try {
    const key = await effectiveKey();
    const params = {
      appid: wx.app_id,
      mch_id: wx.mch_id,
      nonce_str: nonceStr(),
      out_trade_no: outTradeNo,
      out_refund_no: refundNo,
      total_fee: String(totalFeeFen),
      refund_fee: String(refundFeeFen),
      refund_desc: String(reason || '退款').slice(0, 80)
    };
    if (wx.refund_notify_url) params.notify_url = wx.refund_notify_url;
    params.sign = sign(params, key, wx.sign_type);
    const res = await httpsRequest(`https://${WX_HOST}/secapi/pay/refund`, xml.build(params), { pfx: wx.cert_path });
    const data = xml.parse(res.body);
    if (data.return_code !== 'SUCCESS') return { ok: false, error: data.return_msg || '退款失败' };
    if (data.result_code !== 'SUCCESS') return { ok: false, error: `${data.err_code}: ${data.err_code_des || ''}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 关闭订单（微信侧关单，释放微信支付冻结） */
async function closeWxOrder(outTradeNo) {
  const wx = payConfig.get();
  if (wx.mode === 'mock') return { ok: true, mock: true };
  try {
    const key = await effectiveKey();
    const params = { appid: wx.app_id, mch_id: wx.mch_id, nonce_str: nonceStr(), out_trade_no: outTradeNo };
    params.sign = sign(params, key, wx.sign_type);
    const res = await httpsRequest(`https://${WX_HOST}/pay/closeorder`, xml.build(params));
    const data = xml.parse(res.body);
    return { ok: data.return_code === 'SUCCESS', data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 回调成功应答（固定报文） */
function notifySuccess() {
  return '<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>';
}

function notifyFail(msg) {
  return xml.build({ return_code: 'FAIL', return_msg: msg || 'FAIL' });
}

module.exports = { sign, nonceStr, unifiedOrder, verifyNotify, queryOrder, refund, closeWxOrder, notifySuccess, notifyFail };
