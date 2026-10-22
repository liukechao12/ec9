/**
 * EC9 支付路由
 *
 *   POST /api/payment/native          H5 下单（返回二维码 code_url + 图片）
 *   POST /api/payment/notify          微信支付回调（原样 XML，服务端验签）
 *   GET  /api/payment/query/:orderNo  H5 轮询订单状态
 *   POST /api/payment/refund          后台退款（管理员）
 *   POST /api/payment/mock-pay/:no    模拟扫码付款（仅 WXPAY_MODE=mock）
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const QRCode = require('qrcode');
const config = require('../config');
const payConfig = require('../services/payConfigService');
const { Order, ORDER_STATUS, Payment, Guest } = require('../models');
const { requireVerified, requireVerifiedReusable } = require('../middleware/requireVerified');
const { authenticate, authorize } = require('../middleware/auth');
const wechat = require('../services/wechatPayService');
const orderService = require('../services/orderService');

/** 校验订单归属当前验证手机号 */
async function assertOrderOwnership(order, req) {
  const guest = await Guest.findByPk(order.guest_id);
  if (!guest) return { ok: false, error: '嘉宾不存在' };
  if (req.verifiedPhoneHmac && guest.phone_hmac !== req.verifiedPhoneHmac) {
    return { ok: false, error: '订单与当前验证手机号不匹配' };
  }
  return { ok: true, guest };
}

/**
 * 支付成功处理（回调 / mock 共用）：幂等 + 金额核对 + 状态流转
 */
async function handlePaySuccess(data) {
  const outTradeNo = data.out_trade_no;
  const totalFeeFen = parseInt(data.total_fee, 10);

  const order = await Order.findOne({ where: { order_no: outTradeNo } });
  if (!order) return { ok: false, error: '订单不存在' };

  // 金额核对优先于幂等：金额不符一律拒（防伪造/错金额入账，已支付订单也不例外）
  const orderFen = orderService.yuanToFen(order.final_amount);
  if (!Number.isNaN(totalFeeFen) && totalFeeFen !== orderFen) {
    return { ok: false, error: `金额不符：微信 ${totalFeeFen} 分 vs 订单 ${orderFen} 分` };
  }

  let payment = await Payment.findOne({ where: { out_trade_no: outTradeNo } });
  if (payment && payment.status === 'success') {
    return { ok: true, idempotent: true };
  }

  if (!payment) {
    payment = await Payment.create({
      order_id: order.id,
      channel: 'wechat',
      out_trade_no: outTradeNo,
      amount: order.final_amount,
      status: 'success',
      notify_raw: data,
      paid_at: new Date()
    });
  } else {
    payment.status = 'success';
    payment.transaction_id = data.transaction_id || payment.transaction_id;
    payment.prepay_id = data.prepay_id || payment.prepay_id;
    payment.notify_raw = data;
    payment.paid_at = new Date();
    await payment.save();
  }

  const result = await orderService.markPaid(order.id, {
    transaction_id: data.transaction_id,
    prepay_id: data.prepay_id,
    paid_at: new Date()
  });
  return result;
}

/**
 * POST /native —— H5 发起支付
 * body: { order_no }
 * 鉴权：verification_token（手机号须与订单嘉宾一致）
 */
router.post('/native', requireVerifiedReusable, async (req, res) => {
  try {
    const { order_no } = req.body || {};
    if (!order_no) return res.status(400).json({ code: 400, message: '缺少 order_no' });

    const order = await Order.findOne({ where: { order_no } });
    if (!order) return res.status(404).json({ code: 404, message: '订单不存在' });

    const own = await assertOrderOwnership(order, req);
    if (!own.ok) return res.status(403).json({ code: 403, message: own.error });

    if (order.status === ORDER_STATUS.PAID) {
      return res.json({ code: 0, message: '订单已支付', data: { status: 'paid', paid_at: order.paid_at } });
    }
    if (order.status !== ORDER_STATUS.PENDING_PAYMENT) {
      return res.status(400).json({ code: 400, message: `订单状态不可支付：${order.status}` });
    }

    // 0 元订单：直接置为已付（口径：跳过支付通道）
    if (Number(order.final_amount) <= 0) {
      const result = await orderService.markPaid(order.id, { paid_at: new Date() });
      if (!result.ok) return res.status(500).json({ code: 500, message: result.error });
      return res.json({ code: 0, message: '免费订单已确认', data: { status: 'paid', checkin_code: result.checkinCode } });
    }

    // 已有进行中的支付记录则复用
    let payment = await Payment.findOne({ where: { out_trade_no: order_no } });
    if (!payment) {
      payment = await Payment.create({
        order_id: order.id,
        channel: 'wechat',
        out_trade_no: order_no,
        amount: order.final_amount,
        status: 'created'
      });
    }

    const guest = own.guest;
    const payResult = await wechat.unifiedOrder({
      orderNo: order.order_no,
      body: `EC9会议报名-${order.order_no}`,
      totalFeeFen: orderService.yuanToFen(order.final_amount),
      ip: req.ip,
      productId: order.order_no
    });
    if (!payResult.ok) {
      return res.status(500).json({ code: 500, message: payResult.error || '下单失败' });
    }

    let qrImage = null;
    if (payResult.codeUrl) {
      try { qrImage = await QRCode.toDataURL(payResult.codeUrl, { width: 260, margin: 1 }); } catch (e) { /* 前端可自行渲染 */ }
    }

    res.json({
      code: 0,
      message: 'ok',
      data: {
        order_no: order.order_no,
        amount: Number(order.final_amount),
        code_url: payResult.codeUrl,
        qr_image: qrImage,
        expire_at: order.expire_at,
        mock: !!payResult.mock
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * POST /notify —— 微信回调（raw body，服务端验签，幂等）
 * 注意：此路由必须在 body-parser.json 之前挂 raw 中间件（见 app.js）
 */
router.post('/notify', async (req, res) => {
  try {
    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
    const verified = await wechat.verifyNotify(raw);
    if (!verified.ok) {
      console.warn('[支付回调] 验签失败:', verified.error);
      return res.type('text/xml').send(wechat.notifyFail(verified.error));
    }
    const data = verified.data;
    if (data.return_code !== 'SUCCESS' || (data.result_code && data.result_code !== 'SUCCESS')) {
      return res.type('text/xml').send(wechat.notifySuccess()); // 已收到，但非成功支付
    }
    const result = await handlePaySuccess(data);
    if (!result.ok) {
      console.error('[支付回调] 处理失败:', result.error);
      return res.type('text/xml').send(wechat.notifyFail(result.error));
    }
    console.log(`[支付回调] 成功: ${data.out_trade_no} txn=${data.transaction_id || '-'}`);
    res.type('text/xml').send(wechat.notifySuccess());
  } catch (e) {
    console.error('[支付回调] 异常:', e.message);
    res.type('text/xml').send(wechat.notifyFail(e.message));
  }
});

/**
 * POST /jsapi —— 手机端 JSAPI 下单（H5 在微信内调起支付）
 * body: { order_no, openid? }
 *
 * 当前服务端微信下单只实现了 NATIVE（扫码）。JSAPI 需要公众号 appid + 用户 openid，
 * 在拿到 openid 之前这里按「契约 + 可降级」实现：
 *   - 已配置 jsapi（service 支持且带 openid） → 返回 jsapi_params，前端直接调起支付
 *   - mock 模式                                → 返回 { mock:true }，前端显示「模拟支付」
 *   - 其余                                    → 400，前端回落 NATIVE 二维码
 */
router.post('/jsapi', requireVerifiedReusable, async (req, res) => {
  try {
    const { order_no, openid } = req.body || {};
    if (!order_no) return res.status(400).json({ code: 400, message: '缺少 order_no' });

    const order = await Order.findOne({ where: { order_no } });
    if (!order) return res.status(404).json({ code: 404, message: '订单不存在' });

    const own = await assertOrderOwnership(order, req);
    if (!own.ok) return res.status(403).json({ code: 403, message: own.error });

    if (order.status === ORDER_STATUS.PAID) {
      return res.json({ code: 0, message: '订单已支付', data: { status: 'paid', paid_at: order.paid_at } });
    }
    if (order.status !== ORDER_STATUS.PENDING_PAYMENT) {
      return res.status(400).json({ code: 400, message: `订单状态不可支付：${order.status}` });
    }

    // 0 元订单：直接置为已付
    if (Number(order.final_amount) <= 0) {
      const result = await orderService.markPaid(order.id, { paid_at: new Date() });
      if (!result.ok) return res.status(500).json({ code: 500, message: result.error });
      return res.json({ code: 0, message: '免费订单已确认', data: { status: 'paid', checkin_code: result.checkinCode } });
    }

    // 真实 JSAPI：需要 openid
    if (openid && typeof wechat.unifiedOrderJsapi === 'function') {
      const payResult = await wechat.unifiedOrderJsapi({
        orderNo: order.order_no,
        body: `EC9会议报名-${order.order_no}`,
        totalFeeFen: orderService.yuanToFen(order.final_amount),
        ip: req.ip,
        openid
      });
      if (payResult.ok && payResult.jsapi_params) {
        return res.json({ code: 0, message: 'ok', data: { order_no: order.order_no, jsapi_params: payResult.jsapi_params } });
      }
      return res.status(400).json({ code: 400, message: payResult.error || 'JSAPI 下单失败' });
    }

    // mock 模式：让前端走模拟支付
    const cfg = require('../services/payConfigService');
    if (cfg.get().mode === 'mock') {
      return res.json({ code: 0, message: 'ok', data: { order_no: order.order_no, mock: true, jsapi_ready: false } });
    }

    // 其余：前端回落 NATIVE 二维码
    return res.status(400).json({ code: 400, message: 'JSAPI 未配置（缺少 openid），请使用扫码支付' });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * GET /query/:orderNo —— H5 轮询
 */
router.get('/query/:orderNo', requireVerifiedReusable, async (req, res) => {
  try {
    const order = await Order.findOne({ where: { order_no: req.params.orderNo } });
    if (!order) return res.status(404).json({ code: 404, message: '订单不存在' });
    const own = await assertOrderOwnership(order, req);
    if (!own.ok) return res.status(403).json({ code: 403, message: own.error });

    let checkinCode = null;
    if (order.status === ORDER_STATUS.PAID) {
      const { CheckinCode } = require('../models');
      const cc = await CheckinCode.findOne({ where: { registration_id: order.registration_id } });
      checkinCode = cc ? cc.code : null;
    }
    res.json({
      code: 0,
      message: 'ok',
      data: {
        order_no: order.order_no,
        status: order.status,
        final_amount: Number(order.final_amount),
        paid_at: order.paid_at,
        expire_at: order.expire_at,
        checkin_code: checkinCode
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * POST /refund —— 后台退款（管理员）
 * body: { order_no, reason }
 */
router.post('/refund', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { order_no, reason } = req.body || {};
    if (!order_no) return res.status(400).json({ code: 400, message: '缺少 order_no' });

    const order = await Order.findOne({ where: { order_no } });
    if (!order) return res.status(404).json({ code: 404, message: '订单不存在' });
    if (order.status !== ORDER_STATUS.PAID) {
      return res.status(400).json({ code: 400, message: `订单状态不允许退款：${order.status}` });
    }

    const refundNo = 'RF' + order.order_no + String(crypto.randomInt(10, 99));
    const payResult = await wechat.refund({
      outTradeNo: order.order_no,
      totalFeeFen: orderService.yuanToFen(order.final_amount),
      refundFeeFen: orderService.yuanToFen(order.final_amount),
      refundNo,
      reason: reason || '后台退款'
    });
    if (!payResult.ok) {
      return res.status(500).json({ code: 500, message: payResult.error || '退款失败' });
    }

    const result = await orderService.refundOrder(order.id, reason || '后台退款');
    if (!result.ok) return res.status(500).json({ code: 500, message: result.error });

    const payment = await Payment.findOne({ where: { out_trade_no: order.order_no } });
    if (payment) {
      payment.status = 'refunded';
      payment.refunded_at = new Date();
      await payment.save();
    }

    res.json({ code: 0, message: '退款成功', data: { order_no: order.order_no, refund_no: refundNo, mock: !!payResult.mock } });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * POST /mock-pay/:orderNo —— 模拟扫码付款（仅 mock 模式，开发联调用）
 */
router.post('/mock-pay/:orderNo', requireVerifiedReusable, async (req, res) => {
  try {
    if (payConfig.get().mode !== 'mock') {
      return res.status(403).json({ code: 403, message: '仅 mock 模式可用' });
    }
    const order = await Order.findOne({ where: { order_no: req.params.orderNo } });
    if (!order) return res.status(404).json({ code: 404, message: '订单不存在' });
    const own = await assertOrderOwnership(order, req);
    if (!own.ok) return res.status(403).json({ code: 403, message: own.error });

    const result = await handlePaySuccess({
      out_trade_no: order.order_no,
      total_fee: String(orderService.yuanToFen(order.final_amount)),
      transaction_id: 'MOCK' + crypto.randomBytes(8).toString('hex'),
      nonce_str: crypto.randomBytes(8).toString('hex'),
      mock: true
    });
    if (!result.ok) return res.status(500).json({ code: 500, message: result.error });
    res.json({ code: 0, message: '模拟支付成功', data: { order_no: order.order_no, idempotent: !!result.idempotent } });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ==================== 多人代报：pay_token 免登录支付通道 ====================
// 短信付款链接场景：购票人从短信打开链接，无验证码凭证，用订单上的 pay_token 鉴权。

function assertPayToken(order, req) {
  const token = (req.body && req.body.pay_token) || req.query.pay_token;
  if (!order.pay_token || !token || String(token) !== String(order.pay_token)) {
    return { ok: false, error: '付款链接无效或已失效' };
  }
  return { ok: true };
}

/** GET /group/:orderNo?pay_token= —— 付款页信息 + 轮询 */
router.get('/group/:orderNo', async (req, res) => {
  try {
    const order = await Order.findOne({ where: { order_no: req.params.orderNo } });
    if (!order || !order.group_no) return res.status(404).json({ code: 404, message: '订单不存在' });
    const pt = assertPayToken(order, req);
    if (!pt.ok) return res.status(403).json({ code: 403, message: pt.error });

    res.json({
      code: 0, message: 'ok',
      data: {
        order_no: order.order_no,
        group_no: order.group_no,
        status: order.status,
        total_amount: Number(order.total_amount),
        discount_amount: Number(order.discount_amount),
        discount_rate: Number(order.discount_rate),
        final_amount: Number(order.final_amount),
        price_detail: order.price_detail,
        expire_at: order.expire_at,
        paid_at: order.paid_at
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/** POST /group/:orderNo/pay  body:{pay_token, openid?} —— 短信链接发起支付 */
router.post('/group/:orderNo/pay', async (req, res) => {
  try {
    const order = await Order.findOne({ where: { order_no: req.params.orderNo } });
    if (!order || !order.group_no) return res.status(404).json({ code: 404, message: '订单不存在' });
    const pt = assertPayToken(order, req);
    if (!pt.ok) return res.status(403).json({ code: 403, message: pt.error });

    if (order.status === ORDER_STATUS.PAID) {
      return res.json({ code: 0, message: '订单已支付', data: { status: 'paid', paid_at: order.paid_at } });
    }
    if (order.status !== ORDER_STATUS.PENDING_PAYMENT) {
      return res.status(400).json({ code: 400, message: `订单状态不可支付：${order.status}` });
    }

    // 0 元订单（全学生票）：直接置为已付
    if (Number(order.final_amount) <= 0) {
      const result = await orderService.markPaid(order.id, { paid_at: new Date() });
      if (!result.ok) return res.status(500).json({ code: 500, message: result.error });
      return res.json({ code: 0, message: '免费订单已确认', data: { status: 'paid' } });
    }

    const { openid } = req.body || {};
    if (openid && typeof wechat.unifiedOrderJsapi === 'function') {
      const payResult = await wechat.unifiedOrderJsapi({
        orderNo: order.order_no,
        body: `EC9会议报名-${order.order_no}`,
        totalFeeFen: orderService.yuanToFen(order.final_amount),
        ip: req.ip,
        openid
      });
      if (payResult.ok && payResult.jsapi_params) {
        return res.json({ code: 0, message: 'ok', data: { order_no: order.order_no, jsapi_params: payResult.jsapi_params } });
      }
      return res.status(400).json({ code: 400, message: payResult.error || 'JSAPI 下单失败' });
    }

    const cfg = require('../services/payConfigService');
    if (cfg.get().mode === 'mock') {
      return res.json({ code: 0, message: 'ok', data: { order_no: order.order_no, mock: true, jsapi_ready: false } });
    }
    return res.status(400).json({ code: 400, message: 'JSAPI 未配置（缺少 openid），请使用扫码支付' });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/** POST /group/:orderNo/mock-pay  body:{pay_token} —— 短信链接模拟支付（mock 模式） */
router.post('/group/:orderNo/mock-pay', async (req, res) => {
  try {
    if (payConfig.get().mode !== 'mock') {
      return res.status(403).json({ code: 403, message: '仅 mock 模式可用' });
    }
    const order = await Order.findOne({ where: { order_no: req.params.orderNo } });
    if (!order || !order.group_no) return res.status(404).json({ code: 404, message: '订单不存在' });
    const pt = assertPayToken(order, req);
    if (!pt.ok) return res.status(403).json({ code: 403, message: pt.error });

    const result = await handlePaySuccess({
      out_trade_no: order.order_no,
      total_fee: String(orderService.yuanToFen(order.final_amount)),
      transaction_id: 'MOCK' + crypto.randomBytes(8).toString('hex'),
      nonce_str: crypto.randomBytes(8).toString('hex'),
      mock: true
    });
    if (!result.ok) return res.status(500).json({ code: 500, message: result.error });
    res.json({ code: 0, message: '模拟支付成功', data: { order_no: order.order_no, idempotent: !!result.idempotent } });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

module.exports = router;
