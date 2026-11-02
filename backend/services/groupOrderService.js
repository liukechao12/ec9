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
 * 折扣（2026-10-29 昊哥口径修订，只认标准票；档位后台可配）：
 *   付费的「标准票」达到 N 张 → 标准票按该档折扣结算；档位在后台「折扣规则」页配置
 *   （ec9_discount_rules：min_qty + rate，就高命中，默认 3张9折 / 5张8折）。
 *   学生票（¥0）、邀约免票不计张数也不进合计；尊享票等其它付费票种照原价，
 *   既不参与张数门槛，也不享受折扣。总价 = 标准票金额×折扣 + 其它票种金额（原价）。
 */
const { Op } = require('sequelize');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Registration, REG_STATUS } = require('../models/Registration');
const { Order, ORDER_STATUS } = require('../models/Order');
const Guest = require('../models/Guest');
const TicketType = require('../models/TicketType');
const Event = require('../models/Event');
const CheckinCode = require('../models/CheckinCode');
const Invitation = require('../models/Invitation');
const { StudentReport, REPORT_STATUS, RegistrationSession, Session } = require('../models');
const { encryptPhone, hmacPhone, decryptPhone, maskPhone } = require('../utils/phoneCrypto');
const { validateSelection } = require('./ticketBinding');
const { sendBusinessSms } = require('./verificationSmsService');
const { SmsService } = require('./SmsService');
const config = require('../config');

// ---------- 折扣 ----------
/**
 * 是否「标准票」—— 折扣口径的唯一定价对象（2026-10-29 昊哥口径）
 *
 * 判定顺序：**票种属性 is_standard 说了算**（1=标准票参与折扣，0=不参与），
 * 只有属性缺失（老数据 / 没走 Model 的裸对象）时才退回按名称猜，避免历史数据突然不打折。
 * 票种名遗留下来的正则仅用于兜底，新增/改名票种请到后台勾「是否标准票」，不要再依赖名字。
 */
// ---------- 学生票学籍报告文件 ----------
// 报告含姓名/身份证号/院校，存私有目录，只能经 /api/student-reports/:id/file 鉴权读取。
const REPORT_DIR = path.resolve(__dirname, '../private/student_reports');
function saveReportFile(f) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const m = String(f.originalname || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = m && ['pdf', 'jpg', 'jpeg', 'png'].includes(m[1]) ? m[1] : 'pdf';
  const fname = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(REPORT_DIR, fname), f.buffer);
  return 'private/student_reports/' + fname;
}
/** 只允许 PDF / JPG / PNG（微信里选文件偶尔没有 mime，用扩展名兜底） */
function isAllowedReport(f) {
  const mime = String(f.mimetype || '').toLowerCase();
  if (['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'].includes(mime)) return true;
  const m = String(f.originalname || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return !!(m && ['pdf', 'jpg', 'jpeg', 'png'].includes(m[1]));
}

const STD_NAME_RE = /标准|標準|standard/i;
function isStandardType(t) {
  if (!t) return false;
  if (Number(t.is_student) === 1) return false;   // 学生票永不算标准票
  if (t.is_standard !== undefined && t.is_standard !== null && String(t.is_standard) !== '') {
    return Number(t.is_standard) === 1;
  }
  return STD_NAME_RE.test(String(t.name || ''));   // 兜底：属性缺失才看名字
}

// 折扣档位：由后台配置（ec9_discount_rules），实现统一放在 services/discountRules.js。
// 那边零业务依赖，public-data 下发档位时引它不会被短信/支付这些重模块拖累；
// pickTier / calcDiscount 是后端扣钱与前端展示共用的同一份口径，务必改一处即两处生效。
const {
  DEFAULT_TIERS, rateToZhe, pickTier, calcDiscount, fetchDiscountRules
} = require('./discountRules');

/**
 * 按票种分摊折扣 —— 纯函数，便于单测
 *
 * 折扣只吃标准票金额：final = Σ(每票种金额 × (标准票 ? rate : 1))
 * 其它付费票种（尊享票等）既不计入门槛也不打折，一律原价。
 *
 * @param {Array<{price:number,is_free:boolean,is_standard:boolean,ticket_type_id?:number,ticket_name?:string}>} list
 * @param {{rules?:Array}} [opts] 传 { rules: 后台配置的档位 }；不传则用内置默认
 * @returns {{paid_count,total_amount,discount_rate,discount_label,discount_amount,final_amount,std_count}}
 */
function applyDiscount(list, opts) {
  let paidCount = 0, rawTotal = 0, stdCount = 0;
  const r2 = (v) => Math.round(v * 100) / 100;
  for (const it of list) {
    const p = Number(it.price) || 0;
    if (it.is_free || p === 0) continue;      // 邀约免票 / ¥0 票种：不计张数也不计钱
    paidCount++; rawTotal += p;
    if (it.is_standard) stdCount++;
  }
  rawTotal = r2(rawTotal);
  const { rate, label } = calcDiscount(stdCount, opts && opts.rules);

  // 按票种分桶打折后求和（与 H5 ticket.html 的逐票种小计同一种取整方式，
  // 避免「先合计再打折」和「分行取整」在小数票价上差 1 分）
  const buckets = new Map();
  for (const it of list) {
    const p = Number(it.price) || 0;
    if (it.is_free || p === 0) continue;
    const key = String(it.ticket_type_id != null ? it.ticket_type_id : (it.ticket_name || 'x'));
    if (!buckets.has(key)) buckets.set(key, { std: !!it.is_standard, amt: 0 });
    buckets.get(key).amt += p;
  }
  let finalAmount = 0;
  for (const b of buckets.values()) finalAmount = r2(finalAmount + r2(b.amt * (b.std ? rate : 1)));

  return {
    paid_count: paidCount, std_count: stdCount,
    total_amount: rawTotal,
    discount_rate: rate, discount_label: label,
    discount_amount: r2(rawTotal - finalAmount),
    final_amount: finalAmount
  };
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
async function syncInvitationOnRegister({ eventId, guestId, isInvited, invitationId, at, groupNo }) {
  try {
    if (isInvited && invitationId) {
      const inv = await Invitation.findByPk(invitationId);
      if (inv) {
        // 邀约嘉宾默认免票：历史行 need_pay 为 NULL 的这里补 0
        await inv.update({
          registration_status: 2, registration_time: at,
          ...(inv.need_pay == null ? { need_pay: 0 } : {})
        });
        return inv.id;
      }
    }
    if (isInvited && !invitationId) {
      const inv = await Invitation.findOne({ where: { event_id: eventId, guest_id: guestId, is_valid: 1 } });
      if (inv) {
        await inv.update({
          registration_status: 2, registration_time: at,
          ...(inv.need_pay == null ? { need_pay: 0 } : {})
        });
        return inv.id;
      }
    }
    // 不在邀约名单：建一条待审批的邀约记录（幂等：同一活动+嘉宾只建一条）
    // batch_no = 团单号：一次提交多人 ⇒ 同 group_no ⇒ 天然一批，后台可整批审核
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
        need_pay: 1,              // 非邀约人：需付款购票
        batch_no: groupNo || null,
        extra_fields: { auto_created: true }   // 标记：本条由「非邀约人报名」自动生成
      });
    } else if (inv.registration_status !== 2) {
      // 未被审批通过过的，重提时回到待审批（同时刷新批次号，保证同团单仍是一批）
      await inv.update({
        registration_status: 1, registration_time: at,
        ...(groupNo ? { batch_no: groupNo } : {})
      });
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
    if (phone) map.set(phone, {
      invitation_id: inv.id,
      source_bd: inv.source_bd || '',
      need_pay: needPayOf(inv),      // 邀约默认免票；管理员显式改成需付款的才付费
      ticket_type_id: Number(inv.ticket_type_id) || 0   // 赠票票种：选它免费（0=未指定）
    });
  }
  return map;
}

/**
 * 免费口径（2026-11-02 修订，昊哥拍板）：
 *   ① 票种本身 ¥0（学生票/免费票）                 → 免费
 *   ② 邀约管理给这个人指定了票种，且他选的就是那张 → 免费
 *   ③ 管理员特批 need_pay=0                        → 免费（无门槛全免，与票种无关）
 *   其余（不在名单 / 名单内但没指定票 / 指定票但选了别的票）→ 照票面价付费。
 *
 * @param {object} inv      邀约命中信息 {need_pay:boolean, ticket_type_id:number}
 * @param {number} selId    这个人选的票种 id
 * @param {number} price    票面价
 * @returns {boolean}
 */
function isFreeFor(inv, selId, price) {
  if (!(Number(price) > 0)) return true;                       // ① ¥0 票种
  if (!inv) return false;
  if (Number(inv.ticket_type_id) > 0 && Number(selId) === Number(inv.ticket_type_id)) return true;  // ② 赠票
  if (inv.need_pay === false || Number(inv.need_pay) === 0) return true;                            // ③ 特批免票
  return false;
}

/**
 * 取邀约的「是否需要付款」
 * 缺省语义（2026-10-23）：真邀约 → 免票(0)；报名自动生成的待审批记录 → 需付款(1)
 */
const needPayOf = (inv) => {
  if (inv == null) return true;
  if (inv.need_pay != null) return Number(inv.need_pay) !== 0;
  return !!(inv.extra_fields && inv.extra_fields.auto_created);
};

/**
 * 按 guest_id 查邀约（审核期用：管理员可能刚刚在邀约管理里改过 need_pay，
 * 这里重新读库，保证审批时的计价跟管理员最新设置一致）
 * @returns {Promise<Map<number, {invitation_id:number, need_pay:boolean}>>}
 */
async function findInvitedByGuestIds(guestIds, eventId) {
  const map = new Map();
  const ids = (guestIds || []).filter(Boolean).map(Number);
  if (!ids.length) return map;
  const invs = await Invitation.findAll({
    where: { event_id: eventId, guest_id: { [Op.in]: ids }, is_valid: 1 }
  });
  // 审核期口径放宽：报名时自动生成的「待审批」邀约，一旦被管理员批准（registration_status=2）
  // 就是一条真邀约，它上面的 need_pay 要参与计价（管理员批准时选了免票，这里就得免票）
  const genuine = invs.filter(inv =>
    !(inv.extra_fields && inv.extra_fields.auto_created) || Number(inv.registration_status) === 2);
  for (const inv of genuine) {
    if (!map.has(inv.guest_id)) {
      map.set(inv.guest_id, {
        invitation_id: inv.id,
        need_pay: needPayOf(inv),
        ticket_type_id: Number(inv.ticket_type_id) || 0
      });
    }
  }
  return map;
}

/**
 * 标准票票种 id —— 邀约嘉宾一律「标准票」（免票），与购票人选的票种无关
 * 匹配优先级：在售且名称含「标准/Standard」的非学生票 → 首个在售非学生票 → 首个在售票种
 */
async function standardTicketId() {
  const list = await TicketType.findAll({
    where: { on_shelf: 1 }, order: [['sort', 'ASC'], ['id', 'ASC']]
  });
  // 同上：属性优先，名称兜底
  const flagged = list.find(t => Number(t.is_standard) === 1 && Number(t.is_student) !== 1);
  if (flagged) return flagged.id;
  const std = list.find(t => Number(t.is_student) !== 1 && /标准|standard/i.test(String(t.name || '')));
  if (std) return std.id;
  const normal = list.find(t => Number(t.is_student) !== 1 && Number(t.price) > 0);
  if (normal) return normal.id;
  return list.length ? list[0].id : 0;
}

/**
 * 纯估价（无副作用）：H5 提交前实时显示
 *
 * 免费口径（2026-11-02 三次修订，昊哥拍板）：
 *   ① 票种本身 ¥0（学生票 / 免费票）                  → 永远免票
 *   ② 邀约管理给这个人指定了票种，且他选的就是那张     → 免票（赠票）
 *   ③ 管理员在邀约管理里特批 need_pay=0               → 免票（无门槛，与票种无关）
 *   ④ 其余（不在名单 / 名单内没指定票 / 指定票但选了别的）→ 照票种价付费
 * 即：免不免票看「邀约有没有给他指定票 + 他是不是选了那张票」，
 *     不再「名单内一律免票」；需要某人无门槛免票就用 need_pay=0 特批。
 * @param {Array<{ticket_type_id:number, phone?:string, guest_id?:number, is_invited?:boolean, need_pay?:boolean}>} members
 */
async function quoteGroup(eventId, members) {
  const invited = await findInvited(members.map(m => m.phone).filter(Boolean), eventId);
  const invitedByGuest = await findInvitedByGuestIds(members.map(m => m.guest_id), eventId);
  const ticketIds = [...new Set(members.map(m => Number(m.ticket_type_id)).filter(Boolean))];
  const tickets = await TicketType.findAll({ where: { id: { [Op.in]: ticketIds } } });
  const tmap = new Map(tickets.map(t => [t.id, t]));

  const items = [];
  for (const m of members) {
    const tt = tmap.get(Number(m.ticket_type_id));
    if (!tt) return { ok: false, error: `票种不存在：${m.ticket_type_id}` };
    if (tt.on_shelf != 1) return { ok: false, error: `票种已下架：${tt.name}` };

    // 命中邀约（手机号 / guest_id / 调用方显式传入，三种口径任一）
    const byPhone = m.phone ? invited.get(String(m.phone)) : null;
    const byGuest = m.guest_id ? invitedByGuest.get(Number(m.guest_id)) : null;
    const inv = byPhone || byGuest || null;
    const isInvited = !!m.is_invited || !!inv;

    const price = Number(tt.price) || 0;
    // 免费口径：调用方显式 need_pay 优先（后台审批时的人工裁定），
    // 否则走邀约口径 —— ¥0 票种 / 选了邀约指定的赠票 / 管理员特批免票
    let isFree;
    if (typeof m.need_pay === 'boolean') isFree = !m.need_pay;
    else if (m.need_pay != null) isFree = Number(m.need_pay) === 0;
    else isFree = isFreeFor(inv, Number(m.ticket_type_id), price);
    if (price === 0) isFree = true;
    const payable = isFree ? 0 : price;
    items.push({
      ticket_type_id: tt.id, ticket_name: tt.name,
      price: payable,
      is_free: isFree,
      is_invited: isInvited,
      need_pay: !isFree,
      is_student: Number(tt.is_student) === 1,
      is_standard: isStandardType(tt)   // 折扣口径：只有标准票参与
    });
  }
  // 折扣档位来自后台配置（ec9_discount_rules），只吃付费标准票，其余票种原价
  const pay = applyDiscount(items, { rules: await fetchDiscountRules(eventId) });
  return {
    ok: true,
    items, paid_count: pay.paid_count, std_count: pay.std_count, total_count: members.length,
    discount_rate: pay.discount_rate, discount_label: pay.discount_label,
    total_amount: pay.total_amount,
    discount_amount: pay.discount_amount,
    final_amount: pay.final_amount
  };
}

const clip = (v, n) => (v == null ? '' : String(v).slice(0, n));

/**
 * 多人代报提交
 * @param {Object} p
 * @param {string} p.buyerPhone  购票人（已手机验证）
 * @param {number} p.eventId
 * @param {Array}  p.members  [{name, phone, company, position, inviter, focus, ticket_type_id,
 *                              session_ids?: number[], session_all?: 0|1, session_id?: number}]
 *                            论坛是**多选**：session_ids 是所选全部论坛；session_all=1 表示全选
 *                            （此时 session_ids 可不传，后端按该活动启用场次展开）。
 *                            session_id 仅作老客户端兼容（只认第一个）。
 * @returns {ok, group_no, quote, registrations:[{registration_id, name, phone}]}
 */
/**
 * 归一化一个人所选的论坛（多选）
 * 老客户端只传 session_id（单选），新客户端传 session_ids + session_all。
 * @returns {{ all: boolean, ids: number[] }}
 */
function pickSessions(m) {
  const all = Number(m.session_all) === 1;
  const raw = Array.isArray(m.session_ids) ? m.session_ids : [];
  let ids = raw.map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0);
  // 老客户端没有 session_ids 时退回 session_id
  if (!ids.length && !all && Number(m.session_id) > 0) ids = [Number(m.session_id)];
  return { all, ids: Array.from(new Set(ids)) };
}

async function createGroup({ buyerPhone, eventId, members, reportFiles = [] }) {
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

  // 论坛多选：全选时后端按该活动启用场次展开，不依赖前端传全
  const enabledSessions = await Session.findAll({
    where: { event_id: eventId, status: 1 },
    order: [['sort', 'ASC'], ['id', 'ASC']]
  });
  const enabledIds = enabledSessions.map(s => Number(s.id));

  // 邀约名单：命中即「免审核」，但票种按本人所选 —— 不再一律强制标准票。
  // 赠票口径（2026-11-02）：邀约管理里给这个人指定了票种 → 他选那张免费；选别的照价付费。
  const invitedMap = await findInvited(members.map(m => String(m.phone)), eventId);
  const stdTicketId = await standardTicketId();
  // 票面价：用于「是否选到赠票」的免费判定
  const ticketRows = await TicketType.findAll();
  const priceMap = new Map(ticketRows.map(t => [Number(t.id), Number(t.price) || 0]));
  const norm = members.map(m => {
    const invited = invitedMap.has(String(m.phone));
    const pick = pickSessions(m);
    const selId = Number(m.ticket_type_id) || 0;
    return {
      ...m,
      is_invited: invited,
      // 全选 → 展开成所有启用场次；否则用所选列表（已去重）
      session_pick: pick.all ? enabledIds.slice() : pick.ids,
      session_all: pick.all ? 1 : 0,
      // 本人没选票种的老客户端（邀约人原本被强制标准票）→ 回退标准票，行为不变
      ticket_type_id: selId || (invited && stdTicketId ? stdTicketId : 0)
    };
  });

  const quote = await quoteGroup(eventId, norm);
  if (!quote.ok) return quote;

  // 规则 A：限场次票种必须选对应场次（多选口径：所选列表里必须包含它）
  for (const m of norm) {
    const sel = await validateSelection({
      ticketTypeId: Number(m.ticket_type_id) || 0,
      sessionId: (m.session_pick && m.session_pick[0]) || 0,
      sessionIds: m.session_pick || [],
      eventId,
      requireTicket: true
    });
    if (!sel.ok) return { ok: false, error: `${m.name}：${sel.error}` };
  }

  const groupNo = genGroupNo();
  const now = new Date();
  const created = [];

  // ===== 学生票：《教育部学籍在线验证报告》上传 + 人工复核（2026-11-02 起）=====
  // 所有学籍核验 API 均不可用（天远 1001 / 聚美智数不可用），改为报名时上传报告，
  // 管理员按报告里的「在线验证码」去学信网人工复核，标记「符合」后整单才能通过。
  // ⚠️ 含学生票的整单一律留在「待审核」，绝不自动确认出票——否则人工复核来不及。
  const studentTicketIds = new Set(
    ticketRows.filter(t => Number(t.is_student) === 1).map(t => Number(t.id))
  );
  const filesByIndex = new Map((reportFiles || []).map(f => [Number(f.index), f]));
  for (let i = 0; i < norm.length; i++) {
    const m = norm[i];
    if (!studentTicketIds.has(Number(m.ticket_type_id))) continue;
    const f = filesByIndex.get(i);
    if (!f || !f.buffer || !f.buffer.length) {
      return { ok: false, error: `${m.name}：学生票需上传《教育部学籍在线验证报告》` };
    }
    if (!isAllowedReport(f)) {
      return { ok: false, error: `${m.name}：学籍报告仅支持 PDF / JPG / PNG 格式` };
    }
    if (Number(f.size) > 10 * 1024 * 1024) {
      return { ok: false, error: `${m.name}：学籍报告文件不能超过 10MB` };
    }
  }
  const hasStudent = norm.some(m => studentTicketIds.has(Number(m.ticket_type_id)));
  const forceAudit = hasStudent;   // 含学生票 → 整单进待审核，等人工复核

  for (let mi = 0; mi < norm.length; mi++) {
    const m = norm[mi];
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
    const inv = isInvited ? invitedMap.get(phone) : null;
    // 票种按本人所选（老客户端没传时 norm 里已回退标准票）
    const effTicketId = Number(m.ticket_type_id) || (isInvited && stdTicketId ? stdTicketId : 0);
    // 免费判定：¥0 票种 / 选了邀约管理给这个人指定的赠票 / 管理员特批免票
    const invNeedPay = !isFreeFor(inv, effTicketId, priceMap.get(effTicketId) || 0);
    // 同步邀约管理：命中名单 → 邀约置「已报名(2)」；不在名单 → 建「待审批(1)」邀约
    const invId = await syncInvitationOnRegister({
      eventId, guestId: guest.id, isInvited, groupNo,
      invitationId: isInvited ? invitedMap.get(phone).invitation_id : null,
      at: now
    });
    // 邀约名单内：免审核直接通过（audit_exempt 标记，驳回重提时仍免审）
    const reg = await Registration.create({
      event_id: eventId,
      // ⚠️ session_id 从此只作兼容回退（写所选第一个，全选时写 0）；
      //    真正的论坛口径在 ec9_registration_sessions + session_all 上
      session_id: (m.session_pick && m.session_pick[0]) || 0,
      session_all: Number(m.session_all) === 1 ? 1 : 0,
      ticket_type_id: effTicketId,
      guest_id: guest.id,
      invitation_id: invId || (isInvited ? invitedMap.get(phone).invitation_id : null),
      group_no: groupNo,
      status: (isInvited && !forceAudit) ? REG_STATUS.APPROVED : REG_STATUS.SUBMITTED,
      focus: clip(m.focus, 200),
      source_bd: clip(m.inviter, 100),
      submitted_at: now,
      registration_time: now,
      audited_at: (isInvited && !forceAudit) ? now : null,
      extra_fields: {
        submitter_phone: buyerPhone,
        is_buyer: phone === String(buyerPhone),
        is_invited: isInvited,
        audit_exempt: isInvited && !forceAudit,
        need_pay: invNeedPay,
        // 邀约管理给这个人指定的赠票票种（选它免费）；未指定为 null
        invited_ticket_id: (inv && Number(inv.ticket_type_id) > 0) ? Number(inv.ticket_type_id) : null,
        // 本次是否正好选到了赠票（免费出票的直接证据，便于对账）
        used_invited_ticket: !!(inv && Number(inv.ticket_type_id) > 0 && Number(inv.ticket_type_id) === effTicketId)
      }
    });

    // 论坛多选落关联表（一人多行）。失败不回滚报名——论坛可以在后台补选，
    // 但报名本身不能因为关联表写入失败就丢掉。
    const picked = Array.isArray(m.session_pick) ? m.session_pick : [];
    if (picked.length) {
      try {
        await RegistrationSession.bulkCreate(
          picked.map(sid => ({ registration_id: reg.id, session_id: sid })),
          { ignoreDuplicates: true }
        );
      } catch (e) { /* 忽略：口径以 session_all / 后台补选为准 */ }
    }

    // 学生票：报名落库成功后才把报告写盘并建记录（避免校验失败留下孤儿文件）。
    // 报告默认 pending，等管理员按报告中的在线验证码人工复核；未标「符合」整单不给通过。
    const rf = filesByIndex.get(mi);
    if (rf && studentTicketIds.has(Number(effTicketId))) {
      try {
        const relPath = saveReportFile(rf);
        const sr = await StudentReport.create({
          registration_id: reg.id,
          group_no: groupNo,
          guest_id: guest.id,
          event_id: eventId,
          name: clip(m.name, 100),
          phone_masked: maskPhone(phone),
          file_path: relPath,
          file_name: clip(String(rf.originalname || 'report'), 255),
          mime: String(rf.mimetype || '') || (relPath.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'),
          file_size: Number(rf.size) || 0,
          status: REPORT_STATUS.PENDING
        });
        const ef = reg.extra_fields || {};
        ef.student_report_id = sr.id;
        await reg.update({ extra_fields: ef });
      } catch (e) {
        return { ok: false, error: `${m.name}：学籍报告保存失败，请重新上传后重试（${e.message}）` };
      }
    }

    created.push({
      registration_id: reg.id,
      guest_id: guest.id,
      name: clip(m.name, 100),
      phone,
      ticket_type_id: effTicketId,
      is_buyer: phone === String(buyerPhone),
      is_invited: isInvited,
      need_pay: invNeedPay,
      status: reg.status
    });
  }

  // 二次估价（此时 is_invited / need_pay 已落库，手机号 + guest_id 双重确认）
  const finalQuote = await quoteGroup(eventId, created.map(c => ({
    phone: c.phone, guest_id: c.guest_id, ticket_type_id: c.ticket_type_id,
    is_invited: c.is_invited, need_pay: c.need_pay
  })));
  if (!finalQuote.ok) return finalQuote;

  // 整单无付费票（全员免票邀约 / 全员免费票）→ 自动确认：免审核、免支付，直接出票
  // ⚠️ 含学生票例外：必须等人工复核报告「符合」，绝不能提交即出票
  if (Number(finalQuote.final_amount) === 0 && !forceAudit) {
    const auto = await autoConfirmFreeGroup({ groupNo, eventId, quote: finalQuote, buyerPhone });
    return {
      ok: true, group_no: groupNo, quote: finalQuote, registrations: created,
      auto_approved: true, paid: auto.ok, pay_url: null, order: auto.order || null
    };
  }

  // 全员在邀约名单内（不需要审批）但有人要付款 → 报名已成功，直接建待支付单，进入付款
  const needAudit = created.filter(c => !c.is_invited);
  if (!needAudit.length && !forceAudit) {
    const ord = await createGroupOrder({ groupNo, eventId, quote: finalQuote, buyerPhone });
    if (!ord.ok) return ord;
    // 全员在邀约名单内 → 提交即通过，订单已建，通知每位成员「审核通过请付款」（失败不阻塞）
    await sendGroupApprovedSms(groupNo, eventId, created);
    return {
      ok: true, group_no: groupNo, quote: finalQuote, registrations: created,
      auto_approved: true, paid: false, pending_payment: true,
      order: ord.order, pay_url: ord.pay_url
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
      // is_standard 必须带上：折扣判定以属性为准，漏了就会退化成按名称匹配
      { model: TicketType, as: 'ticketType', attributes: ['id', 'name', 'price', 'is_student', 'is_standard'] }
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
  if (!needAudit.length) {
    // 全员邀约：提交时已直接报名成功。若他们要付款，订单在提交时就建好了，这里回传即可
    if (g.order && g.order.status === ORDER_STATUS.PENDING_PAYMENT) {
      return {
        ok: true, action: 'approved', group_no: groupNo, already: true,
        order: { order_no: g.order.order_no, final_amount: Number(g.order.final_amount), pay_token: g.order.pay_token },
        pay_url: payUrlOf(groupNo, g.order.order_no, g.order.pay_token)
      };
    }
    return { ok: false, error: '本单全员在邀约名单内，已自动通过，无需审核' };
  }

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

  // ===== 学生票硬卡：报告必须全部人工复核「符合」才允许整单通过 =====
  // 报告在 /api/student-reports/:id/review 里按「在线验证码」人工核对后标记。
  // 没复核 / 标记不符合 → 一律拦下，避免没核就白出 ¥0 学生票。
  const studentRegs = regs.filter(r => Number(r.ticketType && r.ticketType.is_student) === 1);
  if (studentRegs.length) {
    const reports = await StudentReport.findAll({
      where: { registration_id: { [Op.in]: studentRegs.map(r => r.id) } },
      order: [['id', 'DESC']]
    });
    const approvedIds = new Set(
      reports.filter(x => x.status === REPORT_STATUS.APPROVED).map(x => Number(x.registration_id))
    );
    const missing = studentRegs.filter(r => !approvedIds.has(r.id));
    if (missing.length) {
      const rejected = reports.find(x => x.status === REPORT_STATUS.REJECTED);
      return {
        ok: false,
        error: rejected
          ? `有 ${missing.length} 位学生票报名人的学籍报告复核未「符合」（其中「${rejected.name}」已标记不符合），请核实后再处理`
          : `本单有 ${missing.length} 位学生票报名人的《教育部学籍在线验证报告》尚未人工复核「符合」，请先在「报名审核」页复核后再通过`
      };
    }
  }

  // approve：需审成员 approved（邀约成员早已 approved）→ 建单锁库存
  for (const r of needAudit) {
    r.status = REG_STATUS.APPROVED;
    r.audited_at = new Date();
    r.reject_reason = null;
    await r.save();
    await syncInvitationOnAudit(r, 'approve', r.audited_at);    // 邀约表 → 已报名(2)
  }

  // 计价：按邀约上的 need_pay 决定谁掏钱（管理员可能刚在邀约管理里改过，故重新读库）
  const quote = await quoteGroup(event_id, regs.map(r => ({
    ticket_type_id: r.ticket_type_id,
    guest_id: r.guest_id,
    is_invited: !!(r.extra_fields && r.extra_fields.is_invited)
  })));
  if (!quote.ok) return quote;

  const ord = await createGroupOrder({ groupNo, eventId: event_id, quote, buyerPhone, remark: `多人代报 ${regs.length} 人` });
  if (!ord.ok) return ord;
  // 后台审批通过、订单已建 → 通知每位成员「审核通过请付款」（含邀约免审成员，失败不阻塞）
  await sendGroupApprovedSms(groupNo, event_id, regs);
  return { ok: true, action: 'approved', group_no: groupNo, order: ord.order, pay_url: ord.pay_url };
}

/**
 * 为整单建「待支付」订单（锁库存 + 购票人付款链接短信）
 * 幂等：该团已有待支付单时直接复用，不重复建单
 * @param {Object} p
 * @param {string} p.groupNo
 * @param {number} p.eventId
 * @param {Object} p.quote  quoteGroup 结果（items 与 regs 同序）
 * @param {string} [p.buyerPhone]
 * @param {string} [p.remark]
 */
async function createGroupOrder({ groupNo, eventId, quote, buyerPhone, remark }) {
  const g = await getGroup(groupNo);
  if (!g.ok) return g;
  const { registrations: regs } = g;
  const buyerReg = g.buyer;
  const phone = buyerPhone || (buyerReg && buyerReg.extra_fields ? buyerReg.extra_fields.submitter_phone : null);

  // 已有待支付单 → 直接复用（管理员重复点通过 / 提交时已建过单）
  const exist = await Order.findOne({
    where: { group_no: groupNo, status: ORDER_STATUS.PENDING_PAYMENT },
    order: [['id', 'DESC']]
  });
  if (exist) {
    return {
      ok: true, reused: true,
      order: { order_no: exist.order_no, final_amount: Number(exist.final_amount), pay_token: exist.pay_token },
      pay_url: payUrlOf(groupNo, exist.order_no, exist.pay_token)
    };
  }

  const members = regs.map(r => ({
    registration_id: r.id, guest_id: r.guest_id,
    ticket_type_id: r.ticket_type_id, session_id: r.session_id
  }));

  // 按票种锁库存（邀约免票 / 学生免费票不占库存）
  const perType = new Map();
  members.forEach((m, i) => {
    const it = quote.items[i] || {};
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

  const event = await Event.findByPk(eventId);
  const eventName = event ? event.name : 'EC9 大会';
  const orderNo = 'EC9' + Date.now() + String(orderSeq++).padStart(2, '0');
  const payToken = genPayToken();
  const order = await Order.create({
    order_no: orderNo,
    registration_id: buyerReg.id,
    guest_id: buyerReg.guest_id,
    event_id: eventId,
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
    remark: remark || `多人代报 ${regs.length} 人`
  });

  for (const [ttId, n] of perType) {
    const tt = await TicketType.findByPk(ttId);
    await tt.increment('stock_locked', { by: n });
  }

  // 购票人短信：含付款链接
  const payUrl = payUrlOf(groupNo, orderNo, payToken);
  if (phone) {
    try {
      await sendBusinessSms(phone, 'AUDIT_APPROVED_PAY', {
        event: eventName, count: regs.length,
        amount: quote.final_amount.toFixed(2),
        url: payUrl
      }, 'zh-CN');
    } catch (e) { console.warn('[createGroupOrder] 购票人短信失败（不阻塞）:', e.message); }
  }

  return {
    ok: true, group_no: groupNo,
    order: { order_no: orderNo, final_amount: quote.final_amount, pay_token: payToken },
    pay_url: payUrl
  };
}

let orderSeq = 0;

/** 付款链接（免登录 pay_token） */
function payUrlOf(groupNo, orderNo, payToken) {
  return `${(config.frontend || {}).baseUrl || ''}/h5/ec9/pay.html?group_no=${groupNo}&order_no=${orderNo}&pay_token=${payToken}`;
}

/**
 * 管理员在「邀约管理」里批准/手动报名成功后调用：
 * 该报名所在的整单若全员已通过，就补建订单 —— 免票的直接出票，需付款的建待支付单。
 * 幂等：已有待支付单则直接复用。
 * @param {Object} reg Registration 实例
 */
async function ensureGroupOrderAfterApprove(reg) {
  if (!reg || !reg.group_no) return { ok: false, skipped: true, error: '非团报（group）记录，跳过建单' };
  const groupNo = reg.group_no;
  const g = await getGroup(groupNo);
  if (!g.ok) return g;
  const regs = g.registrations;
  const notReady = regs.filter(r => !['approved', 'paid'].includes(r.status));
  if (notReady.length) {
    return { ok: false, skipped: true, error: `团内还有 ${notReady.length} 人未通过审核，暂不建单` };
  }

  // 重新计价（管理员可能在邀约管理里刚把某人改成免票，这里读最新 need_pay）
  const quote = await quoteGroup(g.event_id, regs.map(r => ({
    ticket_type_id: r.ticket_type_id,
    guest_id: r.guest_id,
    is_invited: !!(r.extra_fields && r.extra_fields.is_invited)
  })));
  if (!quote.ok) return quote;

  // 管理员改成免票 → 原有待支付单作废（关单 + 释放锁库存），直接出票
  if (Number(quote.final_amount) === 0) {
    if (g.order && g.order.status === ORDER_STATUS.PENDING_PAYMENT) {
      await releaseGroupStock(g.order);
      await g.order.update({ status: ORDER_STATUS.CLOSED, remark: '管理员改为免票，原待支付单作废' });
      console.log(`[ensureGroupOrder] 邀约改免票 → 待支付单 ${g.order.order_no} 已作废`);
    }
    const auto = await autoConfirmFreeGroup({ groupNo, eventId: g.event_id, quote, buyerPhone: null });
    return { ok: true, free: true, group_no: groupNo, paid: auto.ok, order: auto.order || null, pay_url: null };
  }

  const ord = await createGroupOrder({ groupNo, eventId: g.event_id, quote, buyerPhone: null, remark: `邀约审批通过 ${regs.length} 人` });
  if (!ord.ok) return ord;
  return { ok: true, free: false, group_no: groupNo, paid: false, order: ord.order, pay_url: ord.pay_url };
}

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

/**
 * 审核通过短信 —— 每个参会成员各 1 条（模板：参会申请已审核通过，请尽快完成付款）
 *
 * 触发口径（昊哥 2026-10-30）：只要整单进入「待支付」，无论后台审批通过还是提交时自动通过，
 * 都给每个参会成员各发一条。订单建好之后才发，避免提前催款却无处可付。
 *
 * ⚠️ 应付 0 元的免票单不调用本函数 —— 它不需要付款，发了反而是误导。
 *
 * 模板 CODE 走 SmsService 的「业务类型 + 场景 + 语种」查表（REG_APPROVED），
 * 不写死在代码里，后台「短信模板」页可换；查不到模板只会打 warn，不阻塞报名。
 *
 * @param {string} groupNo  团号（仅日志用）
 * @param {number} eventId  活动 ID
 * @param {Array}  regs     成员列表，元素需带 guest_id
 */
async function sendGroupApprovedSms(groupNo, eventId, regs) {
  const list = (regs || []).filter(r => r && r.guest_id);
  if (!list.length) return;
  for (const r of list) {
    try {
      const res = await SmsService.sendByBusinessType(
        SmsService.MESSAGE_TYPES.REG_APPROVED,
        { guestId: r.guest_id, eventId, lang: 'zh-CN' }
      );
      if (!(res && res.success)) {
        console.warn(`[sendGroupApprovedSms] 团 ${groupNo} 成员 guest#${r.guest_id} 短信未送出：${(res && (res.error || res.errorMessage)) || '未知错误'}`);
      }
    } catch (e) {
      console.warn(`[sendGroupApprovedSms] 团 ${groupNo} 成员 guest#${r.guest_id} 异常（不阻塞）:`, e.message);
    }
  }
}

/** 全员订票成功短信（事务提交后调用）
 *
 * 模板 SMS_512532136（EC9-报名成功2，无变量纯文本）。
 * 与「审核通过」短信同口径走 SmsService：按「业务类型 + 场景 + 语种」查表，
 * 这样能写进 ec9_sms_logs 便于追溯，且复用已修好的真实发送通道。
 */
async function sendGroupPaidSms(order) {
  const regs = await Registration.findAll({ where: { group_no: order.group_no } });
  for (const r of regs) {
    if (!r || !r.guest_id) continue;
    try {
      const res = await SmsService.sendByBusinessType(
        SmsService.MESSAGE_TYPES.REG_SUCCESS,
        { guestId: r.guest_id, eventId: order.event_id, lang: 'zh-CN' }
      );
      if (!(res && res.success)) {
        console.warn(`[sendGroupPaidSms] 团 ${order.group_no} 成员 guest#${r.guest_id} 短信未送出：${(res && (res.error || res.errorMessage)) || '未知错误'}`);
      }
    } catch (e) {
      console.warn(`[sendGroupPaidSms] 团 ${order.group_no} 成员 guest#${r.guest_id} 异常（不阻塞）:`, e.message);
    }
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
  calcDiscount, applyDiscount, isStandardType,
  pickTier, rateToZhe, fetchDiscountRules, DEFAULT_TIERS, quoteGroup, createGroup, getGroup, auditGroup, findInvited, findInvitedByGuestIds, standardTicketId,
  createGroupOrder, ensureGroupOrderAfterApprove, payUrlOf,
  markGroupPaid, sendGroupPaidSms, sendGroupApprovedSms, releaseGroupStock, sellGroupStock, genCheckinCode
};
