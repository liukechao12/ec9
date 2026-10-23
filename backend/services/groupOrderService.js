/**
 * EC9 多人代报 + group 订单服务
 *
 * 流程（票务优化方案 2026-10-21）：
 *   1. 购票人手机验证后，一人填报多人信息（含本人），提交 → 整单 submitted
 *   2. 后台整单审核（一票否决）：approve → 全员 approved + 建单锁库存 + 购票人收付款链接短信
 *                             reject  → 全员 rejected（可修改后重新提交）
 *   3. 购票人付款（短信链接 pay_token 免登录，或 H5 内 x-verify-token）
 *   4. 支付成功 → 全员 paid + 每人独立入场码 + 全员订票成功短信
 *   5. 入场：各填报人凭自身手机签到
 *
 * 折扣（按整单付费票张数，学生票免费不占名额）：
 *   >=5 张 8 折；>=3 张 9 折；否则原价。学生票 ¥0 不进合计。
 */
const { Op } = require('sequelize');
const crypto = require('crypto');
const { Registration, REG_STATUS } = require('../models/Registration');
const { Order, ORDER_STATUS } = require('../models/Order');
const Guest = require('../models/Guest');
const TicketType = require('../models/TicketType');
const Event = require('../models/Event');
const CheckinCode = require('../models/CheckinCode');
const Invitation = require('../models/Invitation');
const { encryptPhone, hmacPhone, decryptPhone } = require('../utils/phoneCrypto');
const { validateSelection } = require('./ticketBinding');
const { sendBusinessSms } = require('./verificationSmsService');
const config = require('../config');

// ---------- 折扣 ----------
/** 整单付费票张数 → 折扣率 */
function calcDiscount(paidCount) {
  if (paidCount >= 5) return { rate: 0.8, label: '五张及以上8折' };
  if (paidCount >= 3) return { rate: 0.9, label: '三张9折' };
  return { rate: 1.0, label: '' };
}

function genGroupNo() {
  return 'G' + Date.now() + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function genPayToken() {
  return crypto.randomBytes(24).toString('hex');
}

function genCheckinCode() {
  return 'EC9' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function genInviteCode() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

/**
 * 报名落库后同步「邀约管理」记录 —— 对齐 EC8 口径，让后台邀约表里能看到每一次报名：
 *   命中邀约名单  → 原邀约置为「已报名(2)」，报名直接成功、免审核
 *   不在邀约名单  → 新建一条邀约，状态「待审批(1)」，管理员在邀约管理里审批
 * registration_status 语义（models/Invitation.js）：0 未报名 1 待审批 2 已报名 3 已拒绝
 */
async function syncInvitationOnRegister({ eventId, guestId, isInvited, invitationId, at }) {
  try {
    if (isInvited && invitationId) {
      const inv = await Invitation.findByPk(invitationId);
      if (inv) {
        await inv.update({ registration_status: 2, registration_time: at });
        return inv.id;
      }
    }
    if (isInvited && !invitationId) {
      const inv = await Invitation.findOne({ where: { event_id: eventId, guest_id: guestId, is_valid: 1 } });
      if (inv) {
        await inv.update({ registration_status: 2, registration_time: at });
        return inv.id;
      }
    }
    // 不在邀约名单：建一条待审批的邀约记录（幂等：同一活动+嘉宾只建一条）
    let inv = await Invitation.findOne({ where: { event_id: eventId, guest_id: guestId } });
    if (!inv) {
      let code = genInviteCode();
      while (await Invitation.findOne({ where: { invite_code: code } })) code = genInviteCode();
      inv = await Invitation.create({
        event_id: eventId,
        guest_id: guestId,
        invite_code: code,
        registration_status: 1,   // 待审批
        registration_time: at,
        is_valid: 1,
        extra_fields: { auto_created: true }   // 标记：本条由「非邀约人报名」自动生成
      });
    } else if (inv.registration_status !== 2) {
      // 未被审批通过过的，重提时回到待审批
      await inv.update({ registration_status: 1, registration_time: at });
    }
    return inv.id;
  } catch (e) {
    console.error('[groupOrder] 同步邀约记录失败:', e.message);
    return null;
  }
}

/** 审核结果回写邀约表：通过 → 2 已报名；驳回 → 3 已拒绝 */
async function syncInvitationOnAudit(registration, action, at) {
  try {
    const invId = registration.invitation_id;
    if (!invId) return;
    const inv = await Invitation.findByPk(invId);
    if (!inv) return;
    await inv.update({
      registration_status: action === 'reject' ? 3 : 2,
      approval_status: action === 'reject' ? 3 : 2,
      approval_time: at,
      approval_remark: action === 'reject' ? (registration.reject_reason || null) : null
    });
  } catch (e) {
    console.error('[groupOrder] 回写邀约审核状态失败:', e.message);
  }
}

/**
 * 判断手机号是否在「邀约名单」内（该活动下有有效邀约记录）
 * @param {string[]} phones 明文手机号
 * @returns {Promise<Map<string, {invitation_id:number, source_bd:string}>>}
 */
async function findInvited(phones, eventId) {
  const map = new Map();
  if (!phones || !phones.length) return map;
  const hmacs = phones.map(p => hmacPhone(String(p)));
  const guests = await Guest.findAll({ where: { phone_hmac: { [Op.in]: hmacs } } });
  if (!guests.length) return map;
  const invs = await Invitation.findAll({
    where: {
      event_id: eventId,
      guest_id: { [Op.in]: guests.map(g => g.id) },
      is_valid: 1
    }
  });
  const gid2phone = new Map(guests.map(g => [g.id, g.phone_hmac]));
  const hmac2phone = new Map();
  phones.forEach(p => hmac2phone.set(hmacPhone(String(p)), String(p)));
  // 排除「报名时自动生成的待审批邀约」（extra_fields.auto_created）——那不是真邀约，
  // 否则非邀约人提交后二次估价会误判为命中名单、白白免票免审
  const genuine = invs.filter(inv => !(inv.extra_fields && inv.extra_fields.auto_created));
  for (const inv of genuine) {
    const hmac = gid2phone.get(inv.guest_id);
    const phone = hmac2phone.get(hmac);
    if (phone) map.set(phone, { invitation_id: inv.id, source_bd: inv.source_bd || '' });
  }
  return map;
}

/**
 * 纯估价（无副作用）：H5 提交前实时显示
 * 免费口径：学生票（¥0）**与邀约名单内的人**（免票），均不计入付费张数
 * @param {Array<{ticket_type_id:number, is_invited?:boolean}>} members
 */
async function quoteGroup(eventId, members) {
  const invited = await findInvited(members.map(m => m.phone).filter(Boolean), eventId);
  const ticketIds = [...new Set(members.map(m => Number(m.ticket_type_id)).filter(Boolean))];
  const tickets = await TicketType.findAll({ where: { id: { [Op.in]: ticketIds } } });
  const tmap = new Map(tickets.map(t => [t.id, t]));

  const items = [];
  let paidCount = 0, rawTotal = 0;
  for (const m of members) {
    const tt = tmap.get(Number(m.ticket_type_id));
    if (!tt) return { ok: false, error: `票种不存在：${m.ticket_type_id}` };
    if (tt.on_shelf != 1) return { ok: false, error: `票种已下架：${tt.name}` };
    const isInvited = !!(m.is_invited || (m.phone && invited.has(String(m.phone))));
    const isFree = isInvited || Number(tt.price) === 0;
    if (!isInvited && !(Number(tt.price) === 0)) { paidCount++; rawTotal += Number(tt.price); }
    items.push({
      ticket_type_id: tt.id, ticket_name: tt.name,
      price: isInvited ? 0 : Number(tt.price),
      is_free: isFree,
      is_invited: isInvited,
      is_student: Number(tt.is_student) === 1
    });
  }
  const { rate, label } = calcDiscount(paidCount);
  const finalAmount = Math.round(rawTotal * rate * 100) / 100;
  return {
    ok: true,
    items, paid_count: paidCount, total_count: members.length,
    discount_rate: rate, discount_label: label,
    total_amount: Math.round(rawTotal * 100) / 100,
    discount_amount: Math.round((rawTotal - finalAmount) * 100) / 100,
    final_amount: finalAmount
  };
}

const clip = (v, n) => (v == null ? '' : String(v).slice(0, n));

/**
 * 多人代报提交
 * @param {Object} p
 * @param {string} p.buyerPhone  购票人（已手机验证）
 * @param {number} p.eventId
 * @param {Array}  p.members  [{name, phone, company, position, inviter, focus, session_id, ticket_type_id}]
 * @returns {ok, group_no, quote, registrations:[{registration_id, name, phone}]}
 */
async function createGroup({ buyerPhone, eventId, members }) {
  if (!Array.isArray(members) || members.length < 1) return { ok: false, error: '至少填报一位报名人' };
  if (members.length > 10) return { ok: false, error: '单次最多代报 10 人' };

  const event = await Event.findByPk(eventId);
  if (!event) return { ok: false, error: '活动不存在' };

  // 逐人校验
  const seen = new Set();
  for (const m of members) {
    if (!m.name || !String(m.name).trim()) return { ok: false, error: '姓名不能为空' };
    if (!m.phone || !/^1[3-9]\d{9}$/.test(String(m.phone))) return { ok: false, error: `手机号格式错误：${m.phone}` };
    if (seen.has(m.phone)) return { ok: false, error: `手机号重复：${m.phone}` };
    seen.add(m.phone);
  }

  const quote = await quoteGroup(eventId, members);
  if (!quote.ok) return quote;

  // 规则 A：限场次票种必须同时选对应场次（每人独立校验）
  for (const m of members) {
    const sel = await validateSelection({
      ticketTypeId: Number(m.ticket_type_id) || 0,
      sessionId: Number(m.session_id) || 0,
      eventId,
      requireTicket: true
    });
    if (!sel.ok) return { ok: false, error: `${m.name}：${sel.error}` };
  }

  const groupNo = genGroupNo();
  const now = new Date();
  const created = [];
  const invitedMap = await findInvited(members.map(m => String(m.phone)), eventId);

  for (const m of members) {
    const phone = String(m.phone);
    const ph = hmacPhone(phone);
    let guest = await Guest.findOne({ where: { phone_hmac: ph } });
    if (!guest) {
      guest = await Guest.create({
        name: clip(m.name, 100),
        phone: encryptPhone(phone),
        phone_hmac: ph,
        company: clip(m.company, 200),
        position: clip(m.position, 100),
        status: 1
      });
    } else if (guest.status !== 1) {
      await guest.update({ status: 1 });
    } else {
      // 已有嘉宾：用本次填报更新档案（以最新提交为准）
      await guest.update({
        name: clip(m.name, 100),
        company: clip(m.company, 200),
        position: clip(m.position, 100)
      });
    }

    const isInvited = invitedMap.has(phone);
    // 同步邀约管理：命中名单 → 邀约置「已报名(2)」；不在名单 → 建「待审批(1)」邀约
    const invId = await syncInvitationOnRegister({
      eventId, guestId: guest.id, isInvited,
      invitationId: isInvited ? invitedMap.get(phone).invitation_id : null,
      at: now
    });
    // 邀约名单内：免审核直接通过 + 免票（audit_exempt 标记，驳回重提时仍免审）
    const reg = await Registration.create({
      event_id: eventId,
      session_id: Number(m.session_id) || 0,
      ticket_type_id: Number(m.ticket_type_id) || 0,
      guest_id: guest.id,
      invitation_id: invId || (isInvited ? invitedMap.get(phone).invitation_id : null),
      group_no: groupNo,
      status: isInvited ? REG_STATUS.APPROVED : REG_STATUS.SUBMITTED,
      focus: clip(m.focus, 200),
      source_bd: clip(m.inviter, 100),
      submitted_at: now,
      registration_time: now,
      audited_at: isInvited ? now : null,
      extra_fields: {
        submitter_phone: buyerPhone,
        is_buyer: phone === String(buyerPhone),
        is_invited: isInvited,
        audit_exempt: isInvited
      }
    });
    created.push({
      registration_id: reg.id,
      guest_id: guest.id,
      name: clip(m.name, 100),
      phone,
      ticket_type_id: Number(m.ticket_type_id),
      is_buyer: phone === String(buyerPhone),
      is_invited: isInvited,
      status: reg.status
    });
  }

  // 邀约名单内的人免票：重新估价（此时 is_invited 已落库，用手机号二次确认）
  const finalQuote = await quoteGroup(eventId, created.map(c => ({ phone: c.phone, ticket_type_id: c.ticket_type_id, is_invited: c.is_invited })));
  if (!finalQuote.ok) return finalQuote;

  // 整单无付费票（全员邀约 / 全员学生票）→ 自动确认：免审核、免支付，直接出票
  if (Number(finalQuote.final_amount) === 0) {
    const auto = await autoConfirmFreeGroup({ groupNo, eventId, quote: finalQuote, buyerPhone });
    return {
      ok: true, group_no: groupNo, quote: finalQuote, registrations: created,
      auto_approved: true, paid: auto.ok, pay_url: null, order: auto.order || null
    };
  }

  return { ok: true, group_no: groupNo, quote: finalQuote, registrations: created, auto_approved: false };
}

/**
 * 全免单自动确认：整单 approved → 建 0 元单 → markPaid（全员入场码 + 全员短信）
 * （邀约嘉宾不花钱、不用审核，提交即出票）
 */
async function autoConfirmFreeGroup({ groupNo, eventId, quote, buyerPhone }) {
  const regs = await Registration.findAll({ where: { group_no: groupNo }, order: [['id', 'ASC']] });
  if (!regs.length) return { ok: false, error: '报名单不存在' };
  for (const r of regs) {
    r.status = REG_STATUS.APPROVED;
    r.audited_at = r.audited_at || new Date();
    await r.save();
  }
  const buyerReg = regs.find(r => r.extra_fields && r.extra_fields.is_buyer) || regs[0];
  const orderNo = 'EC9' + Date.now() + String((orderSeq++) % 100).padStart(2, '0');
  const order = await Order.create({
    order_no: orderNo,
    registration_id: buyerReg.id,
    guest_id: buyerReg.guest_id,
    event_id: eventId,
    session_id: buyerReg.session_id || 0,
    ticket_type_id: buyerReg.ticket_type_id || 0,
    quantity: regs.length,
    unit_price: 0,
    total_amount: 0,
    discount_amount: 0,
    final_amount: 0,
    status: ORDER_STATUS.PAID,
    paid_at: new Date(),
    expire_at: new Date(Date.now() + 24 * 3600 * 1000),
    group_no: groupNo,
    price_detail: regs.map(r => ({
      registration_id: r.id, guest_id: r.guest_id, ticket_type_id: r.ticket_type_id,
      ticket_name: (quote.items.find(x => x.ticket_type_id === r.ticket_type_id) || {}).ticket_name || '',
      price: 0, is_free: true, session_id: r.session_id
    })),
    discount_rate: 1.00,
    pay_token: genPayToken(),
    remark: `邀约/免费票自动确认 ${regs.length} 人`
  });
  const codes = await markGroupPaid(order);
  try { await sendGroupPaidSms(order); } catch (e) {}
  return { ok: true, order: { order_no: orderNo, final_amount: 0 }, codes };
}

/** 查整单 */
async function getGroup(groupNo) {
  const regs = await Registration.findAll({
    where: { group_no: groupNo },
    order: [['id', 'ASC']],
    include: [
      { model: Guest, as: 'guest', attributes: ['id', 'name', 'company', 'position'] },
      { model: TicketType, as: 'ticketType', attributes: ['id', 'name', 'price', 'is_student'] }
    ]
  });
  if (!regs.length) return { ok: false, error: '报名单不存在' };
  const buyerReg = regs.find(r => r.extra_fields && r.extra_fields.is_buyer) || regs[0];
  const order = await Order.findOne({ where: { group_no: groupNo }, order: [['id', 'DESC']] });
  return { ok: true, registrations: regs, buyer: buyerReg, order, event_id: regs[0].event_id };
}

/**
 * 整单审核（一票否决）
 * @returns 审核后整单状态；approve 时附带订单与付款链接信息
 */
async function auditGroup({ groupNo, action, reason, operator }) {
  const g = await getGroup(groupNo);
  if (!g.ok) return g;
  const { registrations: regs, event_id } = g;
  // 邀约名单内的人免审核（提交时已直接 approved，带 audit_exempt 标记），
  // 审核动作只作用于「需审核」的成员
  const isExempt = (r) => !!(r.extra_fields && r.extra_fields.audit_exempt);
  const needAudit = regs.filter(r => !isExempt(r));
  const bad = needAudit.filter(r => !['submitted', 'pending_audit', 'rejected'].includes(r.status));
  if (bad.length) return { ok: false, error: `整单存在不可审核的记录（${bad[0].status}），请刷新` };
  if (!needAudit.length) return { ok: false, error: '本单全员在邀约名单内，已自动通过，无需审核' };

  const event = await Event.findByPk(event_id);
  const eventName = event ? event.name : 'EC9 大会';
  const buyerPhone = (regs.find(r => r.extra_fields && r.extra_fields.is_buyer) || regs[0]).extra_fields.submitter_phone;

  if (action === 'reject') {
    // 一票否决：仅驳回需审核的成员；邀约名单内的人本来就直接通过，不受影响
    for (const r of needAudit) {
      r.status = REG_STATUS.REJECTED;
      r.reject_reason = clip(reason, 500);
      r.audited_at = new Date();
      await r.save();
      await syncInvitationOnAudit(r, 'reject', r.audited_at);   // 邀约表 → 已拒绝(3)
    }
    return {
      ok: true, action: 'rejected', group_no: groupNo,
      rejected_count: needAudit.length,
      exempt_count: regs.length - needAudit.length
    };
  }
  if (action !== 'approve') return { ok: false, error: 'action 必须是 approve/reject' };

  // approve：需审成员 approved（邀约成员早已 approved）→ 建单锁库存
  const members = [];
  for (const r of needAudit) {
    r.status = REG_STATUS.APPROVED;
    r.audited_at = new Date();
    r.reject_reason = null;
    await r.save();
    await syncInvitationOnAudit(r, 'approve', r.audited_at);    // 邀约表 → 已报名(2)
  }
  for (const r of regs) {
    members.push({
      registration_id: r.id, guest_id: r.guest_id,
      ticket_type_id: r.ticket_type_id, session_id: r.session_id
    });
  }

  // 计价：邀约名单内的人免票（传 is_invited 让 quoteGroup 排除）
  const quote = await quoteGroup(event_id, regs.map(r => ({
    ticket_type_id: r.ticket_type_id,
    is_invited: !!(r.extra_fields && r.extra_fields.is_invited)
  })));
  if (!quote.ok) return quote;

  // 按票种锁库存（邀约免票 / 学生免费票不占库存）
  const perType = new Map();
  members.forEach(m => {
    const it = quote.items.find(x => x.ticket_type_id === m.ticket_type_id) || {};
    if (it.is_free) return;
    perType.set(m.ticket_type_id, (perType.get(m.ticket_type_id) || 0) + 1);
  });
  for (const [ttId, n] of perType) {
    const tt = await TicketType.findByPk(ttId);
    if (!tt) return { ok: false, error: `票种不存在：${ttId}` };
    if (tt.stock_total - tt.stock_locked - tt.stock_sold < n) {
      return { ok: false, error: `库存不足：${tt.name}` };
    }
  }

  const buyerReg = g.buyer;
  const orderNo = 'EC9' + Date.now() + String(orderSeq++).padStart(2, '0');
  const payToken = genPayToken();
  const order = await Order.create({
    order_no: orderNo,
    registration_id: buyerReg.id,
    guest_id: buyerReg.guest_id,
    event_id,
    session_id: buyerReg.session_id || 0,
    ticket_type_id: buyerReg.ticket_type_id || 0,
    quantity: regs.length,
    unit_price: quote.total_amount,           // group 单：unit_price 存折前合计
    total_amount: quote.total_amount,
    discount_amount: quote.discount_amount,
    final_amount: quote.final_amount,
    status: ORDER_STATUS.PENDING_PAYMENT,
    expire_at: new Date(Date.now() + 24 * 3600 * 1000),
    group_no: groupNo,
    // price_detail 与 quote.items 同序（均按 regs 顺序遍历），按下标取，避免同票种混单错位
    price_detail: members.map((m, i) => {
      const it = quote.items[i] || {};
      return {
        registration_id: m.registration_id,
        guest_id: m.guest_id,
        ticket_type_id: m.ticket_type_id,
        ticket_name: it.ticket_name || '',
        price: it.price || 0,
        is_free: !!it.is_free,
        is_invited: !!(regs[i] && regs[i].extra_fields && regs[i].extra_fields.is_invited),
        session_id: m.session_id
      };
    }),
    discount_rate: quote.discount_rate,
    pay_token: payToken,
    remark: `多人代报 ${regs.length} 人`
  });

  for (const [ttId, n] of perType) {
    const tt = await TicketType.findByPk(ttId);
    await tt.increment('stock_locked', { by: n });
  }

  // 购票人短信：含付款链接
  const payUrl = `${(config.frontend || {}).baseUrl || ''}/h5/ec9/pay.html?group_no=${groupNo}&order_no=${orderNo}&pay_token=${payToken}`;
  try {
    await sendBusinessSms(buyerPhone, 'AUDIT_APPROVED_PAY', {
      event: eventName, count: regs.length,
      amount: quote.final_amount.toFixed(2),
      url: payUrl
    }, 'zh-CN');
  } catch (e) { console.warn('[auditGroup] 购票人短信失败（不阻塞）:', e.message); }

  return {
    ok: true, action: 'approved', group_no: groupNo,
    order: { order_no: orderNo, final_amount: quote.final_amount, pay_token: payToken },
    pay_url: payUrl
  };
}

let orderSeq = 0;

/**
 * group 订单支付成功：全员 paid + 每人入场码 + 全员短信
 * （由 orderService.markPaid 在 group 单时调用）
 */
async function markGroupPaid(order, { transaction: t = null } = {}) {
  const regs = await Registration.findAll({ where: { group_no: order.group_no }, transaction: t });
  const results = [];

  for (const r of regs) {
    r.status = REG_STATUS.PAID;
    await r.save({ transaction: t });

    let code = await CheckinCode.findOne({ where: { registration_id: r.id }, transaction: t });
    if (!code) {
      code = await CheckinCode.create({
        registration_id: r.id,
        guest_id: r.guest_id,
        event_id: r.event_id,
        code: genCheckinCode(),
        status: 'active',
        generated_at: new Date()
      }, { transaction: t });
    } else if (code.status !== 'active') {
      code.status = 'active';
      await code.save({ transaction: t });
    }
    results.push({ registration_id: r.id, guest_id: r.guest_id, checkin_code: code.code });
  }
  return results;
}

/** 全员订票成功短信（事务提交后调用） */
async function sendGroupPaidSms(order) {
  const regs = await Registration.findAll({ where: { group_no: order.group_no } });
  const event = await Event.findByPk(order.event_id);
  const eventName = event ? event.name : 'EC9 大会';
  for (const r of regs) {
    try {
      const guest = await Guest.findByPk(r.guest_id);
      if (!guest || !guest.phone) continue;
      const phone = decryptPhone(guest.phone);
      const cc = await CheckinCode.findOne({ where: { registration_id: r.id } });
      await sendBusinessSms(phone, 'REG_SUCCESS', {
        event: eventName, code: cc ? cc.code : ''
      }, 'zh-CN');
    } catch (e) { console.warn('[sendGroupPaidSms] 短信失败（不阻塞）:', e.message); }
  }
}

/** group 订单关单：按 price_detail 逐票种释放锁库存 */
async function releaseGroupStock(order, { transaction: t = null } = {}) {
  if (!order.group_no || !order.price_detail) return;
  const perType = new Map();
  (order.price_detail || []).forEach(d => {
    if (!d.is_free) perType.set(d.ticket_type_id, (perType.get(d.ticket_type_id) || 0) + 1);
  });
  for (const [ttId, n] of perType) {
    const tt = await TicketType.findByPk(ttId, { transaction: t });
    if (tt) await tt.decrement('stock_locked', { by: n, transaction: t });
  }
}

/** group 订单支付成功时的库存流转：locked → sold（按 price_detail） */
async function sellGroupStock(order, { transaction: t = null } = {}) {
  if (!order.group_no || !order.price_detail) return;
  const perType = new Map();
  (order.price_detail || []).forEach(d => {
    if (!d.is_free) perType.set(d.ticket_type_id, (perType.get(d.ticket_type_id) || 0) + 1);
  });
  for (const [ttId, n] of perType) {
    const tt = await TicketType.findByPk(ttId, { transaction: t });
    if (tt) {
      await tt.increment('stock_sold', { by: n, transaction: t });
      await tt.decrement('stock_locked', { by: n, transaction: t });
    }
  }
}

module.exports = {
  calcDiscount, quoteGroup, createGroup, getGroup, auditGroup, findInvited,
  markGroupPaid, sendGroupPaidSms, releaseGroupStock, sellGroupStock, genCheckinCode
};
