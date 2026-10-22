/**
 * EC9 支付全链路 HTTP 冒烟（WXPAY_MODE=mock）
 *
 * 前置：app.js 已在 7098 运行；数据库已执行 schema + seed。
 * 本脚本自建 fixture（不动种子数据，可重复执行）：
 *   A. 新嘉宾 + 已通过报名（标准票）→ createOrder → ¥399 待付款
 *   B. 新嘉宾 + 已通过报名（免费票）→ createOrder → ¥0
 *
 * 覆盖链路：
 *   无票 401 / 错主 403 / 下单拿二维码 / 轮询待付 / 模拟付款 / 出票(签到码)
 *   / 重复 mock 幂等 / 回调重放幂等 / 错误金额回调被拒 / 免费单直通
 *   / 服务端退款（wechat.refund + orderService.refundOrder）/ 库存回退验证
 */
const http = require('http');
const crypto = require('crypto');
const config = require('../config');
const {
  sequelize, Event, Session, TicketType, Guest, Registration,
  Order, ORDER_STATUS, Payment, CheckinCode, VerificationToken
} = require('../models');
const { encryptPhone, hmacPhone } = require('../utils/phoneCrypto');
const orderService = require('../services/orderService');
const wechat = require('../services/wechatPayService');

const BASE = { host: '127.0.0.1', port: config.server.port };
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  | ' + extra : ''}`); }
}

function countKeys(obj) {
  let n = 0;
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    if (v && typeof v === 'object') n += countKeys(v); else n++;
  }
  return n;
}

function req(method, path, { body, raw, token } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let payload = null;
    if (raw !== undefined) {
      payload = raw;
      headers['Content-Type'] = 'text/xml';
      headers['Content-Length'] = Buffer.byteLength(raw);
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) headers['x-verify-token'] = token;
    const r = http.request({ ...BASE, path, method, headers }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch (e) { /* xml/plain */ }
        resolve({ status: res.statusCode, body: parsed, text: buf });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function mintToken(phone) {
  const token = 'SMK' + crypto.randomBytes(16).toString('hex');
  await VerificationToken.create({
    token, phone_hmac: hmacPhone(phone), purpose: 'register',
    expires_at: new Date(Date.now() + 3600000)
  });
  return token;
}

function notifyXml(outTradeNo, totalFeeFen, txnId) {
  return '<xml>' +
    '<appid><![CDATA[wxtestapp]]></appid>' +
    '<mch_id><![CDATA[1900000001]]></mch_id>' +
    '<out_trade_no><![CDATA[' + outTradeNo + ']]></out_trade_no>' +
    '<total_fee>' + totalFeeFen + '</total_fee>' +
    '<transaction_id><![CDATA[' + txnId + ']]></transaction_id>' +
    '<nonce_str><![CDATA[' + crypto.randomBytes(6).toString('hex') + ']]></nonce_str>' +
    '<return_code><![CDATA[SUCCESS]]></return_code>' +
    '<result_code><![CDATA[SUCCESS]]></result_code>' +
    '</xml>';
}

(async () => {
  console.log('== EC9 支付全链路 HTTP 冒烟 ==');
  if (config.wechatPay.mode !== 'mock') {
    console.error('WXPAY_MODE 非 mock，终止（避免打真实渠道）');
    process.exit(1);
  }

  // ===== fixture =====
  const [event] = await Event.findAll({ limit: 1 });
  const [session] = await Session.findAll({ where: { event_id: event.id }, limit: 1 });
  const tickets = await TicketType.findAll({ where: { event_id: event.id } });
  const ticketStd = tickets.find(t => Number(t.price) > 0);
  const ticketFree = tickets.find(t => Number(t.price) === 0);
  check('fixture: 会议/场次/付费票/免费票齐全', !!event && !!session && !!ticketStd && !!ticketFree);

  const ts = String(Date.now()).slice(-6);
  const phonePay = '138' + ts + '01';
  const phoneFree = '138' + ts + '02';
  const phoneOther = '138' + ts + '03';

  async function makeGuestAndOrder(phone, ticket) {
    const guest = await Guest.create({
      name: '冒烟-' + phone.slice(-4), phone: encryptPhone(phone), phone_hmac: hmacPhone(phone),
      company: 'SmokeInc', position: 'QA', source: 'web'
    });
    const reg = await Registration.create({
      event_id: event.id, session_id: session.id, ticket_type_id: ticket.id, guest_id: guest.id,
      status: 'approved', form_data: { company: 'SmokeInc' },
      submitted_at: new Date(), audited_at: new Date()
    });
    const r = await orderService.createOrder(reg.id, { quantity: 1 });
    return { guest, reg, order: r.ok ? r.order : null, err: r.error };
  }

  const stdTicketSoldBefore = Number(ticketStd.stock_sold);
  const A = await makeGuestAndOrder(phonePay, ticketStd);
  check('fixture: 标准票待付款订单建成', !!A.order && A.order.status === ORDER_STATUS.PENDING_PAYMENT && Number(A.order.final_amount) === Number(ticketStd.price),
    A.err || (A.order && A.order.status + '/' + A.order.final_amount));
  const B = await makeGuestAndOrder(phoneFree, ticketFree);
  check('fixture: 免费票 0 元订单建成', !!B.order && Number(B.order.final_amount) === 0, B.err);

  // ===== 1. 基础 =====
  const health = await req('GET', '/api/health');
  check('health 200', health.status === 200 && health.body.code === 0);
  const i18n = await req('GET', '/i18n/zh-CN.json');
  check('i18n zh-CN 包可加载', i18n.status === 200 && countKeys(i18n.body) > 500, 'keys=' + countKeys(i18n.body));
  const i18nEn = await req('GET', '/i18n/en.json');
  check('i18n en 包可加载', i18nEn.status === 200 && countKeys(i18nEn.body) > 500, 'keys=' + countKeys(i18nEn.body));

  // ===== 2. 鉴权门 =====
  const noToken = await req('POST', '/api/payment/native', { body: { order_no: A.order.order_no } });
  check('下单无凭证 → 401', noToken.status === 401, 'status=' + noToken.status);
  const wrongOwner = await req('POST', '/api/payment/native', {
    body: { order_no: A.order.order_no }, token: await mintToken(phoneOther)
  });
  check('下单错主凭证 → 403', wrongOwner.status === 403, 'status=' + wrongOwner.status);

  // ===== 3. 下单 → 轮询 → 模拟付款 → 出票 =====
  const native = await req('POST', '/api/payment/native', {
    body: { order_no: A.order.order_no }, token: await mintToken(phonePay)
  });
  check('下单成功返回二维码', native.status === 200 && native.body.code === 0 &&
    String(native.body.data.code_url || '').startsWith('weixin://') && native.body.data.mock === true,
    JSON.stringify(native.body).slice(0, 200));

  const q1 = await req('GET', '/api/payment/query/' + A.order.order_no, { token: await mintToken(phonePay) });
  check('轮询：待付款', q1.status === 200 && q1.body.data.status === ORDER_STATUS.PENDING_PAYMENT && Number(q1.body.data.final_amount) === Number(ticketStd.price),
    JSON.stringify(q1.body).slice(0, 200));

  const mockPay = await req('POST', '/api/payment/mock-pay/' + A.order.order_no, { token: await mintToken(phonePay) });
  check('模拟扫码付款成功', mockPay.status === 200 && mockPay.body.code === 0, JSON.stringify(mockPay.body).slice(0, 200));

  const q2 = await req('GET', '/api/payment/query/' + A.order.order_no, { token: await mintToken(phonePay) });
  check('轮询：已付款 + 签到码已出', q2.status === 200 && q2.body.data.status === ORDER_STATUS.PAID && !!q2.body.data.checkin_code,
    JSON.stringify(q2.body).slice(0, 200));

  // ===== 4. 幂等 =====
  const mockPay2 = await req('POST', '/api/payment/mock-pay/' + A.order.order_no, { token: await mintToken(phonePay) });
  check('重复 mock 付款幂等', mockPay2.status === 200 && mockPay2.body.data.idempotent === true, JSON.stringify(mockPay2.body).slice(0, 200));

  const payRows = await Payment.findAll({ where: { out_trade_no: A.order.order_no } });
  check('支付流水仅 1 条（无重复入账）', payRows.length === 1, 'rows=' + payRows.length);

  const replay = await req('POST', '/api/payment/notify', {
    raw: notifyXml(A.order.order_no, orderService.yuanToFen(A.order.final_amount), 'MOCKR' + crypto.randomBytes(4).toString('hex'))
  });
  check('回调重放 → SUCCESS 且订单仍已付', /<return_code><!\[CDATA\[SUCCESS\]\]><\/return_code>/.test(replay.text) &&
    (await A.order.reload()).status === ORDER_STATUS.PAID, replay.text.slice(0, 160));

  const badAmount = await req('POST', '/api/payment/notify', {
    raw: notifyXml(A.order.order_no, 100, 'MOCKB' + crypto.randomBytes(4).toString('hex'))
  });
  check('错误金额回调被拒（FAIL）', /FAIL/.test(badAmount.text) && (await A.order.reload()).status === ORDER_STATUS.PAID,
    badAmount.text.slice(0, 160));

  // ===== 5. 免费单直通 =====
  const freeNative = await req('POST', '/api/payment/native', {
    body: { order_no: B.order.order_no }, token: await mintToken(phoneFree)
  });
  check('0 元订单跳过支付通道直通', freeNative.status === 200 && freeNative.body.data.status === 'paid' && !!freeNative.body.data.checkin_code,
    JSON.stringify(freeNative.body).slice(0, 200));

  // ===== 6. 服务端退款 + 库存回退 =====
  await A.order.reload();
  const soldAfterPay = Number((await ticketStd.reload()).stock_sold);
  check('付款后库存 sold +1', soldAfterPay === stdTicketSoldBefore + 1, `before=${stdTicketSoldBefore} after=${soldAfterPay}`);

  const wxRefund = await wechat.refund({
    outTradeNo: A.order.order_no,
    totalFeeFen: orderService.yuanToFen(A.order.final_amount),
    refundFeeFen: orderService.yuanToFen(A.order.final_amount),
    refundNo: 'RF' + A.order.order_no,
    reason: '冒烟退款'
  });
  check('微信退款通道调用成功', wxRefund.ok === true, wxRefund.error);

  const refundResult = await orderService.refundOrder(A.order.id, '冒烟退款');
  check('订单状态机流转至已退款', refundResult.ok === true && (await A.order.reload()).status === ORDER_STATUS.REFUNDED,
    refundResult.error);

  const soldAfterRefund = Number((await ticketStd.reload()).stock_sold);
  check('退款后库存 sold 回退', soldAfterRefund === stdTicketSoldBefore, `before=${stdTicketSoldBefore} after=${soldAfterRefund}`);

  const payRow = await Payment.findOne({ where: { out_trade_no: A.order.order_no } });
  payRow.status = 'refunded'; payRow.refunded_at = new Date(); await payRow.save();
  check('支付流水标记已退款', payRow.status === 'refunded');

  console.log(`\nSMOKE_DONE  pass=${pass} fail=${fail}`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('SMOKE_ERROR:', e); process.exit(1); });
