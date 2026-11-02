const express = require('express');
const router = express.Router();
const { Registration, Invitation, Guest, Event, Ticket, TicketType } = require('../models');
const { SmsService, MESSAGE_TYPES } = require('../services/SmsService');
const crypto = require('crypto');
const { generateTicketQRCode } = require('../utils/qrcode');
const { authenticate } = require('../middleware/auth');
const { requireVerifiedReusable } = require('../middleware/requireVerified');
const operationLog = require('../middleware/operationLog');
const { hashPhone, encryptPhone } = require('../utils/phoneCrypto');
const { validateSelection, pickLang, toSid } = require('../services/ticketBinding');
const { calcDiscount, fetchDiscountRules } = require('../services/discountRules');
const { isStandardType } = require('../services/groupOrderService');

// 学生票《教育部学籍在线验证报告》随报名一起 multipart 上传。
// 用内存存储：文件只有在报名真正落库成功后才由 service 写盘，避免校验失败留下孤儿文件。
const multer = require('multer');
const reportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 }
});
function uploadReports(req, res, next) {
  reportUpload.any()(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? '学籍报告文件不能超过 10MB'
        : '文件上传失败：' + (err.message || '未知错误');
      return res.status(400).json({ code: 400, message: msg });
    }
    next();
  });
}

/**
 * 从请求里取「门票 + 场次」并按规则 A 校验。
 *
 * 两个字段都是可选的：
 *   - 都不传 → 沿用 EC8 老流程（先报名，票种与场次由后台指派）
 *   - 传了 → 立刻校验，场次票必须同时选对应场次，否则 400
 *
 * @returns {{ok:true, ticketTypeId:number, sessionId:number} | {ok:false, status:number, message:string, errorCode:string}}
 */
async function readSelection(req, eventId, { requireTicket = false } = {}) {
  const b = req.body || {};
  const lang = b.lang || (req.query && req.query.lang) || null;
  const ticketTypeId = toSid(b.ticket_type_id, 0);
  const sessionId = toSid(b.session_id, 0);

  if (!ticketTypeId && !sessionId && !requireTicket) {
    return { ok: true, ticketTypeId: 0, sessionId: 0 };
  }

  const r = await validateSelection({ ticketTypeId, sessionId, eventId, requireTicket });
  if (!r.ok) {
    return {
      ok: false, status: 400,
      message: pickLang(r.error, lang),
      errorCode: r.code
    };
  }
  return { ok: true, ticketTypeId, sessionId: r.sessionId };
}

/**
 * 写入 / 更新报名记录里的「门票 + 场次」。
 *
 * 只在用户**显式选了**时才覆盖：
 *   - 传了 → 覆盖 session_id / ticket_type_id
 *   - 没传 → 保留库里的原值（后台可能已预先指派过票种）
 */
function applySelectionPatch(payload, sel) {
  if (sel.ticketTypeId) payload.ticket_type_id = sel.ticketTypeId;
  if (sel.sessionId) payload.session_id = sel.sessionId;
  return payload;
}

/** 论坛展示名：「全部论坛」与「未选」在库里都是 session_id=0，靠 session_all 分开 */
const SESSION_ALL_LABEL = '全部论坛';
const SESSION_NONE_LABEL = '未选';

/**
 * 报名记录 → 论坛展示名（多选，多个用「 / 」连接）
 *
 * 口径：session_all=1 → 全部论坛（不逐条枚举）；否则取关联表里所选的若干个。
 * ⚠️ 不要只读 session_id —— 它现在只是兼容回退（写所选第一个）。
 *
 * @param {object} reg   需含 session_all；多选 id 由 attachSessionPicks() 挂到 reg.__sessionIds
 * @param {object} sMap  { sessionId: name }，一次性建好避免 N+1
 */
function sessionLabelOf(reg, sMap) {
  if (!reg) return SESSION_NONE_LABEL;
  if (Number(reg.session_all) === 1) return SESSION_ALL_LABEL;
  const ids = Array.isArray(reg.__sessionIds)
    ? reg.__sessionIds
    : (Number(reg.session_id) > 0 ? [Number(reg.session_id)] : []);
  const names = ids.map(id => (sMap && sMap[id]) || null).filter(Boolean);
  return names.length ? names.join(' / ') : SESSION_NONE_LABEL;
}

/**
 * 批量报名 → 从关联表 ec9_registration_sessions 取每人所选论坛，
 * 挂到 reg.__sessionIds 上（避免 N+1）。必须在 buildSessionMap 之前调用。
 */
async function attachSessionPicks(regs) {
  const list = Array.isArray(regs) ? regs.filter(r => r && r.id) : [];
  if (!list.length) return;
  const { RegistrationSession } = require('../models');
  const rows = await RegistrationSession.findAll({
    where: { registration_id: list.map(r => Number(r.id)) },
    attributes: ['registration_id', 'session_id']
  });
  const map = new Map();
  rows.forEach(x => {
    const k = Number(x.registration_id);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(Number(x.session_id));
  });
  list.forEach(r => { r.__sessionIds = map.get(Number(r.id)) || []; });
}

/** 批量报名 → { sessionId: name }，只查一次库 */
async function buildSessionMap(regs) {
  const { Session } = require('../models');
  const ids = new Set();
  (Array.isArray(regs) ? regs : []).forEach(r => {
    const sid = Number(r.session_id) || 0;
    if (sid > 0) ids.add(sid);
    (r.__sessionIds || []).forEach(x => ids.add(Number(x)));
  });
  if (!ids.size) return {};
  const rows = await Session.findAll({ where: { id: [...ids] }, attributes: ['id', 'name'] });
  const map = {};
  rows.forEach(s => { map[s.id] = s.name; });
  return map;
}

/** 报名表单扩展字段（H5 提交）：关注方向 focus、论坛/场次已由 session_id 承载 */
function applyFormPatch(payload, body) {
  if (body && body.focus !== undefined && body.focus !== null) {
    payload.focus = String(body.focus).slice(0, 200);
  }
  return payload;
}

/**
 * 按数据库列宽截断字符串，防 PG 22001（value too long）把接口打成 500。
 * 列宽：guests.name/position 100、guests.company 200、invitations.source_bd 100。
 * H5 端已加 maxlength 挡一道，这里是给直接打接口的客户端兜底。
 */
function clipField(v, max) {
  if (v == null || v === '') return v;
  return String(v).slice(0, max);
}

/**
 * GET /mine —— 凭手机号凭证查「我的报名」（H5 状态分流用）
 *
 * 前端凭 x-verify-token 查询本人报名，按返回值决定去哪一页：
 *   无报名      → 报名页
 *   submitted / pending_audit → 待审核页
 *   rejected    → 驳回页
 *   approved + 无订单/待支付 → 支付页
 *   paid        → 电子票页
 *
 * query: event_id（可选，不传取最近一条）
 */
router.get('/mine', requireVerifiedReusable, async (req, res) => {
  try {
    const phoneHmac = req.verifiedPhoneHmac;
    if (!phoneHmac) return res.status(401).json({ code: 401, message: '请先完成手机号验证' });

    const guest = await Guest.findOne({ where: { phone_hmac: phoneHmac, status: 1 } });
    if (!guest) return res.json({ code: 0, message: 'ok', data: { registered: false } });

    const where = { guest_id: guest.id };
    if (req.query.event_id) where.event_id = Number(req.query.event_id);

    const { TicketType, Session, Order, CheckinCode } = require('../models');
    const reg = await Registration.findOne({
      where,
      order: [['id', 'DESC']],
      include: [
        { model: TicketType, as: 'ticketType', required: false },
        { model: Session, as: 'session', required: false }
      ]
    });
    if (!reg) return res.json({ code: 0, message: 'ok', data: { registered: false } });

    // 取订单：优先已支付，其次最近的待付款
    // （不用 order:id DESC 一把梭 —— 历史上可能有关单/超时/重复建的残留单，
    //   取错单会把「已付款」的人误判成待付款。）
    const orders = await Order.findAll({ where: { registration_id: reg.id }, order: [['id', 'DESC']] });
    const order = orders.find(o => o.status === 'paid') || orders[0] || null;
    let checkinCode = null;
    if (reg.status === 'paid' || (order && order.status === 'paid')) {
      const cc = await CheckinCode.findOne({ where: { registration_id: reg.id } });
      checkinCode = cc ? cc.code : null;
    }

    // 多人代报：附整单信息（购票人视角看全员，填报人只看得到自己在的整单概况）
    let group = null;
    if (reg.group_no) {
      const groupOrder = await Order.findOne({ where: { group_no: reg.group_no }, order: [['id', 'DESC']] });
      const members = await Registration.findAll({
        where: { group_no: reg.group_no },
        order: [['id', 'ASC']],
        include: [
          { model: TicketType, as: 'ticketType', required: false },
          { model: Guest, as: 'guest', required: false }
        ]
      });
      await attachSessionPicks(members);
      const groupSMap = await buildSessionMap(members);
      group = {
        group_no: reg.group_no,
        is_buyer: !!(reg.extra_fields && reg.extra_fields.is_buyer),
        member_count: members.length,
        members: members.map(m => ({
          registration_id: m.id,
          name: m.guest ? m.guest.name : null,
          ticket_name: m.ticketType ? m.ticketType.name : null,
          session_all: Number(m.session_all) === 1 ? 1 : 0,
          session_ids: m.__sessionIds || [],
          session_name: sessionLabelOf(m, groupSMap),
          price: m.ticketType ? Number(m.ticketType.price) : null,
          is_student: m.ticketType ? Number(m.ticketType.is_student) === 1 : false,
          status: m.status,
          is_buyer: !!(m.extra_fields && m.extra_fields.is_buyer)
        })),
        order: groupOrder ? {
          order_no: groupOrder.order_no,
          status: groupOrder.status,
          total_amount: Number(groupOrder.total_amount),
          discount_amount: Number(groupOrder.discount_amount),
          discount_rate: Number(groupOrder.discount_rate),
          final_amount: Number(groupOrder.final_amount),
          paid: groupOrder.status === 'paid'
        } : null
      };
    }

    await attachSessionPicks([reg]);
    const regSMap = await buildSessionMap([reg]);

    res.json({
      code: 0,
      message: 'ok',
      data: {
        registered: true,
        registration_id: reg.id,
        event_id: reg.event_id,
        status: reg.status,
        ticket_type_id: reg.ticket_type_id,
        ticket_name: reg.ticketType ? reg.ticketType.name : null,
        price: reg.ticketType ? Number(reg.ticketType.price) : null,
        session_id: reg.session_id,
        // 论坛是多选：session_ids 是所选全部；session_all=1 表示全选
        // （session_id 只剩兼容回退，别拿它当口径）
        session_all: Number(reg.session_all) === 1 ? 1 : 0,
        session_ids: reg.__sessionIds || [],
        session_name: sessionLabelOf(reg, regSMap),
        focus: reg.focus || null,
        name: guest.name,
        company: guest.company,
        position: guest.position,
        submitted_at: reg.registration_time || reg.submitted_at,
        order_no: order ? order.order_no : null,
        order_status: order ? order.status : null,
        paid: !!(order && order.status === 'paid'),
        checkin_code: checkinCode,
        group
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 发送报名成功短信。
 *
 * ⚠️ 原实现用硬编码模板 ID（活动 1→12、2→13，业绩说明会→22），
 * 那样**锁死了语种** —— 英文环境也会发中文模板，且模板 ID 一变就失效。
 * 现改为按「业务类型 + 场景 + 语种」查表，三语自动选对应模板。
 */
async function sendRegistrationSuccessSms(guestId, eventId, invitationId = null, lang = null) {
  try {
    // 业绩说明会系活动用 PERFORMANCE 场景，其余按活动地点推导
    let sceneHint = null;
    const event = await Event.findByPk(eventId);
    if (event && event.page_url && String(event.page_url).includes('performance')) {
      sceneHint = 'PERFORMANCE';
    }

    const result = await SmsService.sendByBusinessType(
      SmsService.MESSAGE_TYPES.REG_SUCCESS,
      { guestId, eventId, invitationId, lang },
      sceneHint
    );

    if (result.success) {
      console.log(`[发送报名成功短信] 成功，活动ID: ${eventId}, 语种: ${lang || 'zh-CN'}`);
    } else {
      console.error(`[发送报名成功短信] 失败，活动ID: ${eventId}, 错误: ${result.error || result.errorMessage}`);
    }
    return result;
  } catch (error) {
    console.error('[发送报名成功短信] 异常:', error);
    return { success: false, error: error.message };
  }
}

// 生成邀请码
function generateInviteCode() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

// 2025业绩说明会开放报名接口（无需邀请码，提交后待审批，审批通过发22号短信）
router.post('/submit-performance', async (req, res) => {
  try {
    const { phone, name, company, position } = req.body;
    if (!phone || phone.length !== 11 || !/^1[3-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ code: 400, message: '请输入正确的11位手机号' });
    }
    if (!name || !company || !position) {
      return res.status(400).json({ code: 400, message: '姓名、单位名称、职位不能为空' });
    }
    const eventList = await Event.findAll({
      where: { status: 1 },
      order: [['id', 'DESC']]
    });
    const perfEvent = eventList.find(e => e.page_url && e.page_url.includes('performance'));
    if (!perfEvent) {
      return res.status(400).json({ code: 400, message: '未找到2025业绩说明会活动，请在后台创建活动并设置绑定页面为 /pages/performance' });
    }
    const phoneHash = hashPhone(phone);
    let guest = await Guest.findOne({ where: { phone_hash: phoneHash } });
    if (!guest) {
      guest = await Guest.create({
        name, company, position,
        phone: encryptPhone(phone),
        phone_hash: phoneHash,
        status: 1
      });
    } else {
      await guest.update({ name, company, position });
    }
    let invitation = await Invitation.findOne({
      where: { guest_id: guest.id, event_id: perfEvent.id, is_valid: 1 }
    });
    let needApproval = true;
    if (!invitation) {
      let inviteCode = generateInviteCode();
      while (await Invitation.findOne({ where: { invite_code: inviteCode } })) {
        inviteCode = generateInviteCode();
      }
      invitation = await Invitation.create({
        event_id: perfEvent.id,
        guest_id: guest.id,
        invite_code: inviteCode,
        registration_status: 1, // 待审批
        registration_time: new Date(),
        is_valid: 1
      });
      await Registration.create({
        invitation_id: invitation.id,
        event_id: perfEvent.id,
        guest_id: guest.id,
        registration_time: new Date()
      });
    } else if (invitation.registration_status === 2) {
      needApproval = false;
    } else {
      await invitation.update({
        registration_status: 1,
        registration_time: new Date()
      });
      let reg = await Registration.findOne({ where: { invitation_id: invitation.id } });
      if (!reg) {
        await Registration.create({
          invitation_id: invitation.id,
          event_id: perfEvent.id,
          guest_id: guest.id,
          registration_time: new Date()
        });
      }
    }
    res.json({
      code: 200,
      message: needApproval ? '提交成功，等待管理员审核' : '报名成功',
      data: { needApproval }
    });
  } catch (error) {
    console.error('[submit-performance] 错误:', error);
    res.status(500).json({ code: 500, message: '报名失败', error: error.message });
  }
});

// H5报名接口（通过手机号，不需要认证）
router.post('/by-phone', async (req, res) => {
  try {
    const { phone, invite_code } = req.body;
    
    if (!phone || !invite_code) {
      return res.status(400).json({
        code: 400,
        message: '手机号和邀约码不能为空'
      });
    }
    
    // 查找邀约
    const invitation = await Invitation.findOne({
      where: { invite_code, is_valid: 1 },
      include: [{ model: Event, as: 'event' }]
    });
    
    if (!invitation) {
      return res.status(404).json({
        code: 404,
        message: '邀约码无效'
      });
    }
    
    // 验证手机号（通过哈希匹配）
    // ⚠️ EC9 的 phone_hmac 是 HMAC-SHA256（带 PHONE_HMAC_KEY），
    //    不是 EC8 的无盐 sha256，用错会永远校验不过。
    const phoneHash = hashPhone(phone);
    const guest = await Guest.findOne({
      where: { phone_hash: phoneHash, status: 1 }
    });
    
    if (!guest || guest.id !== invitation.guest_id) {
      return res.status(404).json({
        code: 404,
        message: '未邀请或手机号不匹配'
      });
    }

    // 规则 A：场次票必须同时选对应场次
    const sel = await readSelection(req, invitation.event_id);
    if (!sel.ok) {
      return res.status(sel.status).json({ code: sel.status, message: sel.message, errorCode: sel.errorCode });
    }
    
    // 检查是否已报名
    if (invitation.registration_status === 1) {
      // 已报名，返回门票信息
      const ticket = await Ticket.findOne({
        where: { invitation_id: invitation.id }
      });
      
      return res.json({
        code: 200,
        message: '您已报名',
        data: {
          guest: {
            name: guest.name,
            company: guest.company
          },
          event: invitation.event,
          ticket: ticket ? {
            ticket_code: ticket.ticket_code,
            qr_code_url: ticket.qr_code_url
          } : null
        }
      });
    }
    
    // 创建报名记录
    const registration = await Registration.create({
      invitation_id: invitation.id,
      event_id: invitation.event_id,
      guest_id: guest.id,
      session_id: sel.sessionId,
      ticket_type_id: sel.ticketTypeId,
      registration_time: new Date(),
      source_bd: invitation.source_bd
    });
    
    // 更新邀请状态（报名状态：0-未报名，1-已报名）
    const fromStatus = invitation.registration_status;
    await invitation.update({
      registration_status: 1,
      registration_time: new Date()
    });
    
    // ⚠️ EC8 在这里直接 Ticket.create 生成门票 —— EC9 的 Ticket 别名指向
    //    TicketType（票种），往里塞门票记录必然 500。
    //    EC9 的出票改在「支付成功后」由 orderService.markPaid 生成 CheckinCode，
    //    所以这里只完成报名登记，票面信息后置。
    let ticket = null;

    // 触发报名成功短信（根据活动ID选择模板）
    try {
      await sendRegistrationSuccessSms(guest.id, invitation.event_id, invitation.id);
    } catch (e) {
      console.error('触发报名成功短信失败:', e);
    }
    
    res.json({
      code: 200,
      message: '报名成功',
      data: {
        guest: {
          name: guest.name,
          company: guest.company
        },
        event: invitation.event,
        ticket: null,
        registration_id: registration.id,
        // 提示前端：EC9 需凭此报名去建单支付，支付完成后才会出票
        need_pay: Number(sel.ticketTypeId) > 0
      }
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '报名失败',
      error: error.message
    });
  }
});

// H5提交报名信息接口（更新嘉宾信息、记录住宿选择、更新报名状态）
router.post('/submit', async (req, res) => {
  try {
    const { invite_code, name, company, position, hotel_12_29, hotel_12_30, skip_approval } = req.body;
    
    if (!invite_code) {
      return res.status(400).json({
        code: 400,
        message: '邀请码不能为空'
      });
    }
    
    // 查找邀约
    const invitation = await Invitation.findOne({
      where: { invite_code, is_valid: 1 },
      include: [{ model: Guest, as: 'guest' }]
    });
    
    if (!invitation) {
      return res.status(404).json({
        code: 404,
        message: '邀请码无效'
      });
    }

    // 规则 A：场次票必须同时选对应场次
    const sel = await readSelection(req, invitation.event_id);
    if (!sel.ok) {
      return res.status(sel.status).json({ code: sel.status, message: sel.message, errorCode: sel.errorCode });
    }
    
    // 检查审批状态：如果已拒绝，不能报名
    if (invitation.registration_status === 3) {
      return res.status(403).json({
        code: 403,
        message: '该邀约已被拒绝，不能报名。如需重新申请，请联系管理员删除原邀约记录。'
      });
    }
    
    // 检查嘉宾是否存在，如果不存在则自动创建
    let guest = invitation.guest;
    if (!guest) {
      // 需要从请求中获取手机号（如果前端传了的话）
      // 如果没有传手机号，这里无法创建嘉宾（因为手机号是必填的）
      // 实际上，如果邀约存在，guest_id应该已经存在，这种情况不应该发生
      // 但为了安全，我们还是处理一下
      return res.status(404).json({
        code: 404,
        message: '嘉宾信息不存在，无法报名'
      });
    }
    
    // 记录信息修改历史（只记录姓名、公司、职位）
    const changes = {};
    const originalName = guest.name;
    const originalCompany = guest.company || '';
    const originalPosition = guest.position || '';
    
    if (name && name !== originalName) {
      changes.name = { old: originalName, new: name };
    }
    if (company && company !== originalCompany) {
      changes.company = { old: originalCompany, new: company };
    }
    if (position && position !== originalPosition) {
      changes.position = { old: originalPosition, new: position };
    }
    
    // 如果有修改，更新嘉宾信息并记录历史
    if (Object.keys(changes).length > 0) {
      const updateData = {};
      if (name && name !== originalName) updateData.name = name;
      if (company && company !== originalCompany) updateData.company = company;
      if (position && position !== originalPosition) updateData.position = position;
      
      // 记录修改历史
      const history = guest.modification_history || [];
      history.push({
        modified_at: new Date().toISOString(),
        modified_by: 'system',
        modified_source: 'h5_registration',
        changes
      });
      updateData.modification_history = history;
      
      await guest.update(updateData);
      console.log('[报名提交] 嘉宾信息已更新:', updateData);
    }
    
    // 重新加载嘉宾数据（如果已更新）
    if (Object.keys(changes).length > 0) {
      await guest.reload();
    }
    
    const hasChanges = Object.keys(changes).length > 0;
    
    // 准备住宿选择数据
    const accommodationData = {
      hotel_12_29: hotel_12_29 === 'yes' || hotel_12_29 === true,
      hotel_12_30: hotel_12_30 === 'yes' || hotel_12_30 === true
    };

    // 同步住宿选择到邀约表，便于后台审批查看
    await invitation.update({
      accommodation: accommodationData
    });
    
    // 检查是否已存在报名记录
    let registration = await Registration.findOne({
      where: { invitation_id: invitation.id }
    });
    
    if (registration) {
      // 更新现有报名记录（更新住宿信息到extra_fields）
      let extraFields = registration.extra_fields || {};
      if (typeof extraFields === 'string') {
        try {
          extraFields = JSON.parse(extraFields);
        } catch (e) {
          extraFields = {};
        }
      }
      extraFields.accommodation = accommodationData;
      await registration.update(applySelectionPatch({ extra_fields: extraFields }, sel));
    } else {
      // 创建新的报名记录
      registration = await Registration.create(applySelectionPatch({
        invitation_id: invitation.id,
        event_id: invitation.event_id,
        guest_id: guest.id,
        registration_time: new Date(),
        source_bd: invitation.source_bd,
        extra_fields: { accommodation: accommodationData }
      }, sel));
    }
    
    // 根据当前状态更新报名状态
    // 状态定义：0-待回复，1-待审批，2-已接受，3-已拒绝
    const fromStatus = invitation.registration_status;
    let needApproval = false;
    
    if (skip_approval) {
      // skip_approval=true：报名即成功，无审批、无短信
      await invitation.update({
        registration_status: 2,  // 已接受
        registration_time: new Date()
      });
      needApproval = false;
    } else if (invitation.registration_status === 0) {
      // 待回复状态，检查信息是否有变更
      if (hasChanges) {
        await invitation.update({
          registration_status: 1,  // 待审批
          registration_time: new Date()
        });
        needApproval = true;
      } else {
        await invitation.update({
          registration_status: 2,  // 已接受
          registration_time: new Date()
        });
        try {
          await sendRegistrationSuccessSms(guest.id, invitation.event_id, invitation.id);
        } catch (e) {
          console.error('触发报名成功短信失败:', e);
        }
        needApproval = false;
      }
    } else if (invitation.registration_status === 1) {
      needApproval = true;
    } else if (invitation.registration_status === 2) {
      needApproval = false;
    }
    
    res.json({
      code: 200,
      message: needApproval ? '提交成功，等待管理员审核' : '报名成功',
      data: {
        needApproval,
        hasChanges,
        registration: {
          id: registration.id,
          registration_time: registration.registration_time
        },
        accommodation: accommodationData
      }
    });
  } catch (error) {
    console.error('[报名提交] 错误:', error);
    res.status(500).json({
      code: 500,
      message: '报名失败',
      error: error.message
    });
  }
});

// 获取所有报名记录（需要认证）
router.get('/', authenticate, operationLog('registrations', '获取报名记录列表'), async (req, res) => {
  try {
    const { page = 1, pageSize = 10, event_id } = req.query;
    const offset = (page - 1) * pageSize;
    
    const where = {};
    if (event_id) where.event_id = event_id;
    
    const { count, rows } = await Registration.findAndCountAll({
      where,
      include: [
        { model: Event, as: 'event' },
        { model: Guest, as: 'guest' },
        { model: Invitation, as: 'invitation' }
      ],
      limit: parseInt(pageSize),
      offset: parseInt(offset),
      order: [['registration_time', 'DESC']]
    });
    
    res.json({
      code: 200,
      message: '获取成功',
      data: {
        list: rows,
        total: count,
        page: parseInt(page),
        pageSize: parseInt(pageSize)
      }
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// H5通过手机号提交报名信息接口（新用户注册或已有用户更新信息）
router.post('/submit-by-phone', async (req, res) => {
  try {
    let { phone, name, company, position, inviter, event_id, hotel_12_29, hotel_12_30, focus } = req.body;
    // 按数据库列宽截断，防 PG 22001（value too long）把接口打成 500：
    // guests.name/position 100、guests.company 200、invitations.source_bd 100。
    // H5 端已加 maxlength 挡一道，这里是给直连接口的客户端兜底。
    name = clipField(name, 100);
    company = clipField(company, 200);
    position = clipField(position, 100);
    inviter = clipField(inviter, 100);
    
    // 验证必填字段
    if (!phone || phone.length !== 11 || !/^1[3-9]\d{9}$/.test(phone)) {
      return res.status(400).json({
        code: 400,
        message: '请输入正确的手机号'
      });
    }
    
    if (!name || !company || !position) {
      return res.status(400).json({
        code: 400,
        message: '姓名、公司、职务不能为空'
      });
    }

    if (!event_id) {
      return res.status(400).json({
        code: 400,
        message: '活动ID不能为空'
      });
    }
    
    // 验证活动是否存在
    const event = await Event.findByPk(event_id);
    if (!event) {
      return res.status(404).json({
        code: 404,
        message: '活动不存在'
      });
    }

    // 规则 A：场次票必须同时选对应场次
    const sel = await readSelection(req, event.id);
    if (!sel.ok) {
      return res.status(sel.status).json({ code: sel.status, message: sel.message, errorCode: sel.errorCode });
    }
    
    // 通过手机号哈希查找嘉宾（不限制status，避免唯一约束冲突）
    const phoneHash = hashPhone(phone);
    let guest = await Guest.findOne({
      where: { phone_hash: phoneHash }
    });
    
    // 如果嘉宾存在但状态不是1，恢复其状态
    if (guest && guest.status !== 1) {
      await guest.update({ status: 1 });
      console.log('[通过手机号注册] 恢复已删除的嘉宾状态:', guest.id);
    }
    
    // 查找该手机号在该活动下的邀约
    let invitation = null;
    if (guest) {
      invitation = await Invitation.findOne({
        where: {
          guest_id: guest.id,
          event_id: event_id,
          is_valid: 1
        },
        include: [{ model: Guest, as: 'guest' }]
      });
    }
    
    let needApproval = false;
    let hasChanges = false;
    
    if (invitation) {
      // 情况1: 手机号在邀约中
      console.log('[通过手机号注册] 找到邀约，检查信息是否有变更');
      
      // 检查信息是否有变更
      const originalName = guest.name || '';
      const originalCompany = guest.company || '';
      const originalPosition = guest.position || '';
      
      if (name !== originalName || company !== originalCompany || position !== originalPosition) {
        hasChanges = true;
        needApproval = true;
        
        // 记录修改历史
        const changes = {};
        if (name !== originalName) changes.name = { old: originalName, new: name };
        if (company !== originalCompany) changes.company = { old: originalCompany, new: company };
        if (position !== originalPosition) changes.position = { old: originalPosition, new: position };
        
        const history = guest.modification_history || [];
        history.push({
          modified_at: new Date().toISOString(),
          modified_by: 'system',
          modified_source: 'h5_registration_by_phone',
          changes
        });
        
        // 更新嘉宾信息（但状态保持待审核）
        await guest.update({
          name: name,
          company: company,
          position: position,
          modification_history: history
        });
        
        // 准备住宿选择数据
        const accommodationData = {
          hotel_12_29: hotel_12_29 === 'yes' || hotel_12_29 === true,
          hotel_12_30: hotel_12_30 === 'yes' || hotel_12_30 === true
        };
        
        // 更新邀约状态为待审批，同时记录住宿信息
        await invitation.update({
          registration_status: 1, // 待审批
          registration_time: new Date(),
          accommodation: accommodationData
        });
        
        // 创建或更新报名记录
        let registration = await Registration.findOne({
          where: { invitation_id: invitation.id }
        });
        
        if (registration) {
          let extraFields = registration.extra_fields || {};
          if (typeof extraFields === 'string') {
            try {
              extraFields = JSON.parse(extraFields);
            } catch (e) {
              extraFields = {};
            }
          }
          extraFields.accommodation = accommodationData;
          await registration.update(applyFormPatch(applySelectionPatch({ extra_fields: extraFields }, sel), req.body));
        } else {
          await Registration.create(applyFormPatch(applySelectionPatch({
            invitation_id: invitation.id,
            event_id: event_id,
            guest_id: guest.id,
            registration_time: new Date(),
            extra_fields: { accommodation: accommodationData }
          }, sel), req.body));
        }
        
        console.log('[通过手机号注册] 信息有变更，设置为待审核状态');
      } else {
        // 信息无变更，直接报名成功
        hasChanges = false;
        needApproval = false;
        
        // 检查是否已报名
        if (invitation.registration_status !== 2) {
          const fromStatus = invitation.registration_status;
          
          // 更新报名状态
          await invitation.update({
            registration_status: 2, // 已接受
            registration_time: new Date()
          });
          
          // 创建或更新报名记录
          let registration = await Registration.findOne({
            where: { invitation_id: invitation.id }
          });
          
          const accommodationData = {
            hotel_12_29: hotel_12_29 === 'yes' || hotel_12_29 === true,
            hotel_12_30: hotel_12_30 === 'yes' || hotel_12_30 === true
          };
      // 同步住宿选择到邀约表
      await invitation.update({ accommodation: accommodationData });
          
          if (registration) {
        let extraFields = registration.extra_fields || {};
            if (typeof extraFields === 'string') {
              try {
                extraFields = JSON.parse(extraFields);
              } catch (e) {
                extraFields = {};
              }
            }
            extraFields.accommodation = accommodationData;
            await registration.update(applyFormPatch(applySelectionPatch({ extra_fields: extraFields }, sel), req.body));
          } else {
            registration = await Registration.create(applyFormPatch(applySelectionPatch({
              invitation_id: invitation.id,
              event_id: event_id,
              guest_id: guest.id,
              registration_time: new Date(),
              extra_fields: { accommodation: accommodationData }
            }, sel), req.body));
          }
          
          // 触发报名成功短信（根据活动ID选择模板）
          if (fromStatus !== 2) {
            try {
              await sendRegistrationSuccessSms(guest.id, event_id, invitation.id);
            } catch (e) {
              console.error('触发报名成功短信失败:', e);
            }
          }
          
          console.log('[通过手机号注册] 信息无变更，直接报名成功');
        }
      }
    } else {
      // 情况2: 手机号不在邀约中，需要创建新邀约和嘉宾
      console.log('[通过手机号注册] 手机号不在邀约中，创建新邀约和嘉宾');
      
      needApproval = true;
      
      // 如果嘉宾不存在，创建新嘉宾
      if (!guest) {
        const encryptedPhone = encryptPhone(phone);
        guest = await Guest.create({
          name: name,
          phone: encryptedPhone,
          phone_hash: phoneHash,
          company: company,
          position: position,
          status: 1
        });
        console.log('[通过手机号注册] 创建新嘉宾:', guest.id);
      } else {
        // 嘉宾存在但不在邀约中，更新信息（但状态保持待审核）
        await guest.update({
          name: name,
          company: company,
          position: position
        });
        console.log('[通过手机号注册] 更新嘉宾信息:', guest.id);
      }
      
      // 生成邀请码
      let inviteCode = generateInviteCode();
      // 确保邀请码唯一
      while (await Invitation.findOne({ where: { invite_code: inviteCode } })) {
        inviteCode = generateInviteCode();
      }
      
      // 创建报名记录
      const accommodationData = {
        hotel_12_29: hotel_12_29 === 'yes' || hotel_12_29 === true,
        hotel_12_30: hotel_12_30 === 'yes' || hotel_12_30 === true
      };
      
      // 创建新邀约，状态为待审批，同时记录住宿信息
      invitation = await Invitation.create({
        event_id: event_id,
        guest_id: guest.id,
        invite_code: inviteCode,
        source_bd: inviter || null,
        registration_status: 1, // 待审批
        registration_time: new Date(),
        is_valid: 1,
        accommodation: accommodationData
      });
      
      await Registration.create(applyFormPatch(applySelectionPatch({
        invitation_id: invitation.id,
        event_id: event_id,
        guest_id: guest.id,
        registration_time: new Date(),
        extra_fields: { accommodation: accommodationData }
      }, sel), req.body));
      
      console.log('[通过手机号注册] 创建新邀约，状态为待审核:', invitation.id);
    }
    
    // 确保 invitation 存在
    if (!invitation) {
      return res.status(500).json({
        code: 500,
        message: '提交失败：邀约记录创建失败'
      });
    }
    
    // 重新加载 invitation 以获取最新数据
    await invitation.reload();
    
    res.json({
      code: 200,
      message: needApproval ? '提交成功，等待管理员审核' : '报名成功',
      data: {
        needApproval,
        hasChanges,
        invitation: {
          id: invitation.id,
          invite_code: invitation.invite_code,
          registration_status: invitation.registration_status
        }
      }
    });
  } catch (error) {
    console.error('[通过手机号注册] 错误:', error);
    console.error('[通过手机号注册] 错误堆栈:', error.stack);
    res.status(500).json({
      code: 500,
      message: '提交失败',
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// ==================== 多人代报（group） ====================
const groupOrderService = require('../services/groupOrderService');

/**
 * POST /api/registrations/submit-group
 * 多人代报提交（购票人手机验证后，一次填报多人，可混票种）
 *
 * 两种 Content-Type 都支持（老客户端 JSON 不能选学生票，会自动被拦）：
 *   application/json         body: { event_id, buyer_phone, members: [...] }
 *   multipart/form-data      body: 同上但 members 是 JSON 字符串，
 *                            文件字段 report_<成员下标>（选学生票必传，PDF/JPG/PNG ≤10MB）
 * header: x-verify-token（购票人凭证）
 */
router.post('/submit-group', uploadReports, requireVerifiedReusable, async (req, res) => {
  try {
    const isMulti = !!req.is('multipart/form-data');
    let event_id, members, buyer_phone;
    if (isMulti) {
      const b = req.body || {};
      event_id = b.event_id;
      buyer_phone = b.buyer_phone;
      try { members = JSON.parse(b.members || '[]'); } catch (e) { members = []; }
    } else {
      ({ event_id, members, buyer_phone } = req.body || {});
    }
    if (!event_id) return res.status(400).json({ code: 400, message: '活动ID不能为空' });
    // 购票人手机号必须与验证凭证一致（防冒名）
    if (!buyer_phone || !/^1[3-9]\d{9}$/.test(String(buyer_phone))) {
      return res.status(400).json({ code: 400, message: '缺少购票人手机号' });
    }
    const { hmacPhone } = require('../utils/phoneCrypto');
    if (hmacPhone(String(buyer_phone)) !== req.verifiedPhoneHmac) {
      return res.status(401).json({ code: 401, message: '购票人手机号与验证凭证不一致' });
    }

    // 报告文件按成员下标归位；忽略其它字段名的文件
    const reportFiles = (req.files || [])
      .filter(f => /^report_\d+$/.test(f.fieldname))
      .map(f => ({
        index: Number(f.fieldname.slice(7)),
        originalname: f.originalname || 'report',
        mimetype: f.mimetype || '',
        size: f.size,
        buffer: f.buffer
      }));

    const result = await groupOrderService.createGroup({
      buyerPhone: String(buyer_phone), eventId: Number(event_id), members, reportFiles
    });
    if (!result.ok) return res.status(400).json({ code: 400, message: result.error });
    res.json({
      code: 0, message: 'ok',
      data: {
        group_no: result.group_no,
        quote: result.quote,
        registrations: result.registrations,
        // 全免单（全员邀约 / 全员免费票）：提交即自动通过并出票
        auto_approved: !!result.auto_approved,
        paid: !!result.paid,
        order: result.order || null
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * GET /api/registrations/group/:groupNo
 * 查整单状态（购票人 x-verify-token，或管理员 token）
 */
router.get('/group/:groupNo', async (req, res) => {
  try {
    const g = await groupOrderService.getGroup(req.params.groupNo);
    if (!g.ok) return res.status(404).json({ code: 404, message: g.error });
    // 鉴权：管理员 OR 购票人凭证
    const auth = req.headers['authorization'];
    let isAdmin = false;
    if (auth && auth.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const payload = jwt.verify(auth.slice(7), require('../config').jwt.secret);
        const admin = await require('../models').Admin.findByPk(payload.id);
        isAdmin = !!(admin && admin.status === 1);
      } catch (e) { /* 非管理员凭证，走购票人校验 */ }
    }
    if (!isAdmin) {
      const buyerReg = g.buyer;
      const submitterPhone = buyerReg && buyerReg.extra_fields ? buyerReg.extra_fields.submitter_phone : null;
      const token = req.headers['x-verify-token'];
      // 免登录通道：短信付款链接场景，凭订单 pay_token 查整单
      const payTokenQ = req.query.pay_token;
      let payTokenOk = false;
      if (payTokenQ && g.order && g.order.pay_token && String(payTokenQ) === String(g.order.pay_token)) {
        payTokenOk = true;
      }
      if (!payTokenOk && (!token || !submitterPhone)) {
        return res.status(401).json({ code: 401, message: '请先完成手机号验证' });
      }
      if (!payTokenOk) {
        const { peekToken } = require('../services/verificationService');
        const chk = await peekToken(token, 'register', submitterPhone);
        if (!chk.ok) return res.status(401).json({ code: 401, message: chk.error });
      }
    }
    const pdMap = new Map();
    (g.order && Array.isArray(g.order.price_detail) ? g.order.price_detail : []).forEach(d => {
      pdMap.set(Number(d.registration_id), d);
    });
    await attachSessionPicks(g.registrations);
    const gSessionMap = await buildSessionMap(g.registrations);
    res.json({
      code: 0, message: 'ok',
      data: {
        group_no: req.params.groupNo,
        event_id: g.event_id,
        // 购票人 / 管理员已通过鉴权，回传 pay_token 供 H5「待付款页」直连订单支付页
        pay_token: (g.order && g.order.pay_token) ? String(g.order.pay_token) : '',
        registrations: g.registrations.map(r => {
          const ef = r.extra_fields || {};
          const tt = r.ticketType;
          const ttPrice = Number(tt && tt.price) || 0;
          const isStudent = Number(tt && tt.is_student) === 1;
          // 实际应付口径：有订单看 price_detail（邀约免票/免费票=0）；没订单按提交时快照推算
          const pd = pdMap.get(r.id);
          const needPay = pd ? !pd.is_free : (ef.need_pay === false ? false : !(isStudent || ttPrice === 0));
          const payable = pd ? Number(pd.price || 0) : (needPay ? ttPrice : 0);
          return {
          registration_id: r.id, status: r.status, reject_reason: r.reject_reason,
          is_invited: !!ef.is_invited,
          audit_exempt: !!ef.audit_exempt,
          need_pay: !!needPay,
          payable_price: payable,
          name: r.guest ? r.guest.name : null, company: r.guest ? r.guest.company : null,
          position: r.guest ? r.guest.position : null,
          ticket_name: r.ticketType ? r.ticketType.name : null,
          price: r.ticketType ? Number(r.ticketType.price) : null,
          is_student: r.ticketType ? Number(r.ticketType.is_student) === 1 : false,
          session_all: Number(r.session_all) === 1 ? 1 : 0,
          session_ids: r.__sessionIds || [],
          session_name: sessionLabelOf(r, gSessionMap),
          focus: r.focus, is_buyer: !!ef.is_buyer
          };
        }),
        order: g.order ? {
          order_no: g.order.order_no, status: g.order.status,
          total_amount: Number(g.order.total_amount),
          discount_amount: Number(g.order.discount_amount),
          discount_rate: Number(g.order.discount_rate),
          final_amount: Number(g.order.final_amount),
          price_detail: g.order.price_detail
        } : null
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * POST /api/registrations/group/:groupNo/audit   管理员整单审核（一票否决）
 * body: { action: 'approve'|'reject', reason? }
 */
router.post('/group/:groupNo/audit', authenticate, operationLog('registrations', '整单审核'), async (req, res) => {
  try {
    const { action, reason } = req.body;
    const operator = req.admin ? req.admin.username : (req.user ? req.user.username : null);
    const result = await groupOrderService.auditGroup({
      groupNo: req.params.groupNo, action, reason, operator
    });
    if (!result.ok) return res.status(400).json({ code: 400, message: result.error });
    res.json({ code: 0, message: 'ok', data: result });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * POST /api/registrations/group/:groupNo/quote   购票人改票种后实时估价
 * body: { members: [{ ticket_type_id }] }（仅估价，不落库）
 */
router.post('/group/quote', async (req, res) => {
  try {
    const { event_id, members } = req.body;
    const q = await groupOrderService.quoteGroup(Number(event_id), members || []);
    if (!q.ok) return res.status(400).json({ code: 400, message: q.error });
    res.json({ code: 0, message: 'ok', data: q });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * GET /api/registrations/group-list   管理员：多人代报整单列表（审核工作台数据源）
 * query: status?(submitted/approved/rejected/paid) keyword?(组号/姓名/手机)
 */
router.get('/group-list', authenticate, async (req, res) => {
  try {
    const { Op } = require('sequelize');
    const where = { group_no: { [Op.ne]: null } };
    const regs = await Registration.findAll({
      where,
      order: [['id', 'DESC']],
      limit: 2000,
      include: [
        { model: Guest, as: 'guest', required: false },
        { model: TicketType, as: 'ticketType', required: false }
      ]
    });
    // 论坛名一次性取好（否则整单列表会 N+1 把 PG 打爆）
    await attachSessionPicks(regs);
    const sMap = await buildSessionMap(regs);
    // 按 group_no 聚合
    const groups = new Map();
    for (const r of regs) {
      if (!groups.has(r.group_no)) {
        groups.set(r.group_no, {
          group_no: r.group_no, event_id: r.event_id, status: r.status,
          submitted_at: r.registration_time || r.submitted_at,
          submitter_phone: (r.extra_fields && r.extra_fields.submitter_phone) || '',
          members: []
        });
      }
      const g = groups.get(r.group_no);
      g.members.push({
        registration_id: r.id, name: r.guest ? r.guest.name : '',
        company: r.guest ? r.guest.company : '', position: r.guest ? r.guest.position : '',
        phone_masked: (function () {
          try {
            const { decryptPhone, maskPhone } = require('../utils/phoneCrypto');
            return r.guest && r.guest.phone ? maskPhone(decryptPhone(r.guest.phone)) : '';
          } catch (err) { return ''; }
        })(),
        ticket_name: r.ticketType ? r.ticketType.name : '',
        price: r.ticketType ? Number(r.ticketType.price) : 0,
        is_student: r.ticketType ? Number(r.ticketType.is_student) === 1 : false,
        student_report_id: (r.extra_fields && r.extra_fields.student_report_id) || null,
        session_all: Number(r.session_all) === 1 ? 1 : 0,
        session_ids: r.__sessionIds || [],
        session_name: sessionLabelOf(r, sMap),
        is_std: isStandardType(r.ticketType),
        focus: r.focus, status: r.status, reject_reason: r.reject_reason,
        is_invited: !!(r.extra_fields && r.extra_fields.is_invited),
        audit_exempt: !!(r.extra_fields && r.extra_fields.audit_exempt),
        is_buyer: !!(r.extra_fields && r.extra_fields.is_buyer)
      });
    }
    let list = Array.from(groups.values());

    // 学生票学籍报告：一次批量取全挂到整单上，避免列表 N+1 把 PG 打爆。
    // 私有文件路径不外泄，后台预览走 /api/student-reports/:id/file 鉴权接口。
    const groupNos = Array.from(groups.keys());
    const { StudentReport } = require('../models');
    const reports = groupNos.length ? await StudentReport.findAll({
      where: { group_no: { [Op.in]: groupNos } },
      order: [['id', 'DESC']],
      limit: 5000
    }) : [];
    const reportsByGroup = new Map();
    for (const r of reports) {
      const k = r.group_no || '';
      if (!reportsByGroup.has(k)) reportsByGroup.set(k, []);
      const p = r.get ? r.get({ plain: true }) : r;
      delete p.file_path;
      reportsByGroup.get(k).push(p);
    }

    // 折扣档位按活动缓存（后台可配 ec9_discount_rules）：整单列表可能跨多个活动，每种只查一次库
    const ruleCache = new Map();
    const rulesOf = async (eid) => {
      const k = Number(eid) || 1;
      if (!ruleCache.has(k)) ruleCache.set(k, await fetchDiscountRules(k));
      return ruleCache.get(k);
    };

    // 整单状态聚合：多人一次提交 = 一起审核，只有「全部通过」和「全部驳回」两种结果
    // 口径：有 submitted → 待审核；全 rejected → 已驳回；全 paid → 已支付；其余 → 待支付
    for (const g of list) {
      g.reports = reportsByGroup.get(g.group_no) || [];
      g.has_student = g.members.some(m => m.is_student);
      const sts = g.members.map(m => m.status);
      g.status = sts.includes('submitted') ? 'submitted'
        : (sts.every(s => s === 'rejected') ? 'rejected'
          : (sts.every(s => s === 'paid') ? 'paid' : 'approved'));
      g.total_count = g.members.length;
      g.invited_count = g.members.filter(m => m.is_invited).length;
      // 需付款人数：邀约免票不计，其余都算（免费票种会在计价时归零）
      g.paid_count = g.members.filter(m => !m.is_invited).length;
      // 折扣只认「付费的标准票」张数：学生票/尊享票/邀约免票都不进门槛（2026-10-29 口径）
      const stdN = g.members.filter(m => m.is_std && !m.is_invited && Number(m.price) > 0).length;
      g.discount_rate = calcDiscount(stdN, await rulesOf(g.event_id)).rate;
    }

    // 状态筛选放在聚合之后（聚合前按单人状态过滤会把整单拆散）
    if (req.query.status) list = list.filter(g => g.status === req.query.status);

    const kw = String(req.query.keyword || '').trim();
    if (kw) {
      list = list.filter(g =>
        g.group_no.indexOf(kw) > -1 ||
        g.submitter_phone.indexOf(kw) > -1 ||
        g.members.some(m => (m.name || '').indexOf(kw) > -1));
    }
    res.json({ code: 0, message: 'ok', data: { list } });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * GET /api/registrations/export   管理员：导出报名名单 Excel（一人一行）
 *
 * 后台「报名审核」是按整单看的，但名单是给人用的（现场核对、发资料），
 * 所以导出按人铺开，一行一个人。
 *
 * ⚠️ 论坛列是这次单独加 session_all 的原因：「全部论坛」和「未选」存到库里
 *    都是 session_id=0，不记这一位就只能显示成「未选」，名单等于废一半。
 *
 * query: event_id? status?(submitted/approved/paid/rejected) keyword?(组号/姓名/手机/公司) group_no?
 */
router.get('/export', authenticate, operationLog('registrations', '导出报名名单Excel'), async (req, res) => {
  try {
    const { Op } = require('sequelize');
    const { event_id, status, keyword, group_no } = req.query || {};
    const where = { group_no: { [Op.ne]: null } };
    if (event_id) where.event_id = Number(event_id) || 0;
    if (group_no) where.group_no = String(group_no);

    const regs = await Registration.findAll({
      where,
      order: [['id', 'ASC']],
      limit: 20000,
      include: [
        { model: Guest, as: 'guest', required: false },
        { model: TicketType, as: 'ticketType', required: false }
      ]
    });

    // 论坛名 / 活动名一次取全，避免逐行查库
    await attachSessionPicks(regs);
    const sMap = await buildSessionMap(regs);
    const evMap = {};
    const evs = await Event.findAll({ attributes: ['id', 'name'] });
    evs.forEach(e => { evMap[e.id] = e.name; });

    // 整单聚合：筛选口径与后台一致（有 submitted → 待审核；全 rejected → 已驳回；全 paid → 已支付）
    const groups = new Map();
    for (const r of regs) {
      if (!groups.has(r.group_no)) groups.set(r.group_no, { sts: [] });
      groups.get(r.group_no).sts.push(r.status);
    }
    const groupStatus = (sts) => sts.includes('submitted') ? 'submitted'
      : (sts.every(s => s === 'rejected') ? 'rejected'
        : (sts.every(s => s === 'paid') ? 'paid' : 'approved'));

    const { decryptPhone } = require('../utils/phoneCrypto');
    const phoneOf = (r) => {
      if (!r.guest || !r.guest.phone) return '';
      try { return decryptPhone(r.guest.phone) || ''; } catch (e) { return ''; }
    };

    const kw = String(keyword || '').trim();
    const kwHit = new Set();
    if (kw) {
      for (const r of regs) {
        if ((r.group_no || '').indexOf(kw) > -1
          || phoneOf(r).indexOf(kw) > -1
          || String(r.guest && r.guest.name || '').indexOf(kw) > -1
          || String(r.guest && r.guest.company || '').indexOf(kw) > -1) {
          kwHit.add(r.group_no);
        }
      }
    }

    // 关键词按整单命中：一个人命中就把整单都导出来，别把同一单的人拆散
    const keep = new Set();
    groups.forEach((g, gno) => {
      if (status && groupStatus(g.sts) !== status) return;
      if (kw && !kwHit.has(gno)) return;
      keep.add(gno);
    });

    const STATUS_CN = {
      submitted: '待审核', pending_audit: '待审核', approved: '待支付',
      paid: '已支付', rejected: '已驳回', closed: '已关闭', cancelled: '已取消'
    };
    const p2 = (n) => String(n).padStart(2, '0');
    const fmt = (d) => {
      if (!d) return '';
      const t = new Date(d);
      return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}:${p2(t.getSeconds())}`;
    };

    const data = [];
    for (const r of regs) {
      if (!keep.has(r.group_no)) continue;
      const phone = phoneOf(r);
      const ef = r.extra_fields || {};
      data.push({
        报名单号: r.group_no || '',
        活动: evMap[r.event_id] || '',
        姓名: (r.guest && r.guest.name) || '',
        手机号: phone,
        公司: (r.guest && r.guest.company) || '',
        职务: (r.guest && r.guest.position) || '',
        票种: r.ticketType ? r.ticketType.name : '',
        票价: r.ticketType ? Number(r.ticketType.price) : 0,
        论坛: sessionLabelOf(r, sMap),
        关注方向: r.focus || '',
        邀请人: r.source_bd || '',
        成员身份: ef.is_buyer ? '购票人' : '同行人',
        邀约免票: ef.is_invited ? '是' : '否',
        报名状态: STATUS_CN[r.status] || r.status || '',
        提交时间: fmt(r.registration_time || r.submitted_at)
      });
    }

    const XLSX = require('xlsx');
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '报名名单');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', `attachment; filename="registrations_${Date.now()}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buffer);
  } catch (e) {
    console.error('导出报名名单失败:', e);
    res.status(500).json({ code: 500, message: '导出失败', error: e.message });
  }
});

/**
 * POST /api/registrations/check-invited
 * 填资料时逐人预判结果：
 *   邀约管理给这个人指定了票种 → 他选那张票就免费（赠票），选别的照价付；
 *   名单内但没指定票 / 不在名单 → 照所选票种付费（名单内免审核，不在名单需审核）。
 * 返回 invited{phone:bool}、need_pay{phone:bool}、ticket_type{phone:id|0}、ticket_name{phone:string}、standard_ticket_id
 * 需要 x-verify-token，防匿名枚举；单次最多 10 个（与单次代报上限一致）
 */
router.post('/check-invited', requireVerifiedReusable, async (req, res) => {
  try {
    const { phones, event_id } = req.body || {};
    if (!Array.isArray(phones) || !phones.length) {
      return res.json({ code: 0, message: 'ok', data: { invited: {} } });
    }
    if (phones.length > 10) return res.status(400).json({ code: 400, message: '单次最多查询 10 个手机号' });
    const map = await groupOrderService.findInvited(phones.map(String), Number(event_id) || 1);
    const invited = {}, needPay = {}, ticketType = {}, ticketName = {};
    // 赠票票种名：H5 要显示「已为您预留 XX 票（免费）」
    const ttIds = [...new Set([...map.values()].map(v => Number(v.ticket_type_id)).filter(Boolean))];
    let ttMap = new Map();
    if (ttIds.length) {
      const rows = await require('../models').TicketType.findAll({ where: { id: { [require('sequelize').Op.in]: ttIds } } });
      ttMap = new Map(rows.map(t => [Number(t.id), String(t.name || '')]));
    }
    for (const p of phones) {
      const hit = map.get(String(p));
      invited[String(p)] = !!hit;
      // 名单内：指定了赠票 → 选那张才免（这里先按「会选赠票」报免票，实际以提交时为准）；
      //        没指定 → 照价付费。不在名单：需付款（且要审批）
      const giftId = hit ? Number(hit.ticket_type_id) || 0 : 0;
      needPay[String(p)] = hit ? (!giftId && !!hit.need_pay) : true;
      ticketType[String(p)] = giftId;
      ticketName[String(p)] = giftId ? (ttMap.get(giftId) || '') : '';
    }
    const stdId = await groupOrderService.standardTicketId();
    res.json({
      code: 0, message: 'ok',
      data: { invited, need_pay: needPay, ticket_type: ticketType, ticket_name: ticketName, standard_ticket_id: stdId || 0 }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

module.exports = router;
