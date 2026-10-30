const express = require('express');
const router = express.Router();
const { Invitation, Event, Guest, Checkin, Ticket, Admin, TicketType, Session, Registration } = require('../models');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { generateQRCode } = require('../utils/qrcode');
const { authenticate } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');
const { decryptPhone } = require('../utils/phoneCrypto');
const XLSX = require('xlsx');
const groupOrderService = require('../services/groupOrderService');

// 生成邀请码
function generateInviteCode() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

/**
 * 审批通过 / 标记报名成功 → 同步报名记录状态
 * 订单服务要求 registrations.status === 'approved' 才允许建单，
 * 否则 H5 支付链路会卡在「报名状态不可创建订单：submitted」。
 */
async function syncRegistrationApproved(invitationId, eventId, guestId) {
  try {
    const where = invitationId
      ? { invitation_id: invitationId }
      : { event_id: eventId, guest_id: guestId };
    const regs = await Registration.findAll({ where });
    const open = ['submitted', 'pending_audit', 'rejected'];
    let n = 0;
    for (const reg of regs) {
      if (open.indexOf(reg.status) >= 0) {
        await reg.update({ status: 'approved', audited_at: new Date() });
        n++;
      }
    }
    if (n) console.log(`[状态同步] 邀约 ${invitationId} 审批通过 → ${n} 条报名记录置为 approved`);
    return n;
  } catch (e) {
    console.error('[状态同步] 同步报名状态失败:', e.message);
    return 0;
  }
}

/**
 * 审批核心：通过一条邀约
 * 供「单条批准 / 勾选批量 / 整批通过」三种入口复用，保证行为完全一致：
 *   状态 → 已报名(2)；同步报名记录 approved；免票自动出票、需付款建待支付单。
 * @param {object} invitation 邀约实例
 * @param {object} user 当前管理员 { username }
 * @param {{remark?:string, need_pay?:number|boolean, lang?:string}} opts
 *        need_pay 不传时沿用邀约原值（邀约缺省免票）
 * @returns {Promise<{ok:boolean, error?:string, free?:boolean, order?:object}>}
 */
async function approveInvitationCore(invitation, user, opts = {}) {
  const { remark, need_pay, lang } = opts || {};
  if (!invitation) return { ok: false, error: '邀约不存在' };
  if (Number(invitation.registration_status) === 2) return { ok: false, error: '该邀约已通过审批' };

  // 管理员可改「是否需要付款」；不传沿用邀约原值（缺省按邀约免票）
  const needPay = (need_pay === 0 || need_pay === '0' || need_pay === false) ? 0
    : (need_pay === 1 || need_pay === '1' || need_pay === true) ? 1
      : (Number(invitation.need_pay) === 1 ? 1 : 0);

  await invitation.update({
    registration_status: 2,  // 已接受
    approval_time: new Date(),
    approval_by: user.username,
    approval_remark: remark || null,
    registration_time: new Date(),
    need_pay: needPay
  });

  // 审核通过短信（按「业务类型+场景+语种」选模板，失败不阻塞审批）
  // 口径（昊哥 2026-10-30）：需付款 → 发「参会申请已审核通过，请尽快完成付款」；
  //                        免票（need_pay=0）→ 不发催款短信，仍走原「报名成功」模板
  try {
    const { SmsService } = require('../services/SmsService');
    const event = await Event.findByPk(invitation.event_id);
    let sceneHint = null;
    if (event && event.page_url && String(event.page_url).includes('performance')) sceneHint = 'PERFORMANCE';
    const result = await SmsService.sendByBusinessType(
      needPay === 1 ? SmsService.MESSAGE_TYPES.REG_APPROVED : SmsService.MESSAGE_TYPES.REG_SUCCESS,
      { guestId: invitation.guest_id, eventId: invitation.event_id, invitationId: invitation.id, lang: lang || null },
      sceneHint
    );
    if (!(result && result.success)) {
      console.warn(`[审批通过] 报名成功短信未送出，邀约 ${invitation.id}：${(result && (result.error || result.errorMessage)) || '未知错误'}`);
    }
  } catch (e) {
    console.error('[审批通过] 触发报名成功短信异常:', e.message);
  }

  // 报名记录置 approved（建单前置条件）
  await syncRegistrationApproved(invitation.id, invitation.event_id, invitation.guest_id);

  // 报名成功后补齐订单：免票自动出票；需付款建待支付单（购票人短信带付款链接）
  let orderInfo = null;
  try {
    const regs = await Registration.findAll({ where: { invitation_id: invitation.id }, order: [['id', 'DESC']] });
    const fallback = regs.length ? [] : await Registration.findAll({
      where: { event_id: invitation.event_id, guest_id: invitation.guest_id },
      order: [['id', 'DESC']]
    });
    for (const reg of regs.concat(fallback)) {
      const r = await groupOrderService.ensureGroupOrderAfterApprove(reg);
      if (r && r.ok && !r.skipped) { orderInfo = r; break; }
      if (r && !r.ok && !r.skipped) console.warn('[审批通过] 建单失败：', r.error);
    }
  } catch (e) {
    console.error('[审批通过] 建单异常（不阻塞审批）：', e.message);
  }

  await invitation.reload();
  return { ok: true, free: !!(orderInfo && orderInfo.free), order: orderInfo };
}

/**
 * 审批核心：驳回一条邀约
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function rejectInvitationCore(invitation, user, opts = {}) {
  const { remark } = opts || {};
  if (!invitation) return { ok: false, error: '邀约不存在' };
  if (Number(invitation.registration_status) === 3) return { ok: false, error: '该邀约已被拒绝' };
  await invitation.update({
    registration_status: 3,  // 已拒绝
    approval_time: new Date(),
    approval_by: user.username,
    approval_remark: remark || null
  });
  await invitation.reload();
  return { ok: true };
}

// 根据活动信息生成邀约链接
function buildInviteUrl(event, inviteCode) {
  const config = require('../config');
  const baseUrl = config.frontend.baseUrl;

  if (event && event.page_url) {
    // 如果 page_url 是完整URL，直接使用；如果是相对路径，拼接baseUrl
    if (event.page_url.startsWith('http://') || event.page_url.startsWith('https://')) {
      const url = new URL(event.page_url);
      url.searchParams.set('code', inviteCode);
      return url.toString();
    } else {
      const separator = event.page_url.includes('?') ? '&' : '?';
      return `${baseUrl}${event.page_url}${separator}code=${inviteCode}`;
    }
  }

  // 默认格式：/invite/:code
  return `${baseUrl}/invite/${inviteCode}`;
}

// 获取所有邀请（需要认证）
router.get('/', authenticate, operationLog('invitations', '获取邀约列表'), async (req, res) => {
  try {
    const { page = 1, pageSize = 10, event_id, guest_id, registration_status, is_valid, search, source_bd, batch_no } = req.query;
    const offset = (page - 1) * pageSize;
    
    const where = {};
    if (event_id) where.event_id = event_id;
    if (guest_id) where.guest_id = guest_id;
    if (batch_no) where.batch_no = String(batch_no).trim();   // 只看该批次（从批次详情跳过来时用）
    if (registration_status !== undefined) where.registration_status = registration_status;
    if (is_valid !== undefined) where.is_valid = is_valid;

    const keyword = typeof search === 'string' ? search.trim() : '';
    if (keyword) {
      where[Op.or] = [
        { '$guest.name$': { [Op.like]: `%${keyword}%` } },
        { '$guest.company$': { [Op.like]: `%${keyword}%` } },
        { '$event.name$': { [Op.like]: `%${keyword}%` } }
      ];
    }
    
    // BD用户只能看到自己负责的邀约（通过source_bd字段过滤）
    if (req.user.role === 'bd') {
      where.source_bd = req.user.username;
    }

    // 管理员可按 BD 负责人筛选
    if (req.user.role === 'admin' && typeof source_bd === 'string' && source_bd.trim() !== '') {
      where.source_bd = source_bd.trim();
    }
    
    const { count, rows } = await Invitation.findAndCountAll({
      where,
      include: [
        { model: Event, as: 'event' },
        { model: Guest, as: 'guest' },
        { model: Checkin, as: 'checkin', required: false },
        { 
          model: Admin, 
          as: 'bd',
          attributes: ['id', 'username', 'name', 'contact'],
          required: false 
        }
      ],
      // 重要：带 include + limit 时，Sequelize 默认 subQuery 会导致关联字段过滤（$guest.name$等）不生效
      // 关闭 subQuery，确保 search 条件真正落到 SQL WHERE 上
      subQuery: false,
      distinct: true,
      limit: parseInt(pageSize),
      offset: parseInt(offset),
      order: [
        // 已报名(registration_status=2)排前面；用双引号以兼容 PG
        [Invitation.sequelize.literal('CASE WHEN "Invitation"."registration_status" = 2 THEN 0 ELSE 1 END'), 'ASC'],
        ['registration_time', 'DESC'],
        ['created_at', 'DESC']
      ]
    });
    
    // 获取统计数据（全部数据的统计，不受分页影响）
    // 状态定义：0-待回复，1-待审批，2-已接受，3-已拒绝
    const statsWhere = { ...where };
    const statsInclude = keyword
      ? [
          { model: Event, as: 'event', attributes: [], required: false },
          { model: Guest, as: 'guest', attributes: [], required: false }
        ]
      : undefined;

    const countWithFilters = async (extraWhere) => {
      const mergedWhere = { ...statsWhere, ...(extraWhere || {}) };
      if (statsInclude) {
        return await Invitation.count({ where: mergedWhere, include: statsInclude, distinct: true });
      }
      return await Invitation.count({ where: mergedWhere });
    };

    const stats = {
      total: await countWithFilters(),
      accepted: await countWithFilters({ registration_status: 2, is_valid: 1 }), // 已接受
      pending: await countWithFilters({ registration_status: 0, is_valid: 1 }), // 待回复
      pendingApproval: await countWithFilters({ registration_status: 1, is_valid: 1 }), // 待审批
      rejected: await countWithFilters({ registration_status: 3, is_valid: 1 }) // 已拒绝
    };
    
    // 确保返回的数据包含所有字段（包括source_bd和bd关联）
    // 解密嘉宾手机号
    const list = rows.map(row => {
      const rowData = row.toJSON();
      // 解密嘉宾手机号
      if (rowData.guest && rowData.guest.phone) {
        try {
          rowData.guest.phone_decrypted = decryptPhone(rowData.guest.phone);
        } catch (e) {
          console.warn('解密手机号失败:', e);
          rowData.guest.phone_decrypted = null;
        }
      }
      // 确保source_bd字段被包含
      return rowData;
    });
    
    res.json({
      code: 200,
      message: '获取成功',
      data: {
        list: list,
        total: count,
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        stats: stats
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

// 手动设置邀约为报名成功（需要认证，仅管理员）
router.post('/:id/mark-registered', authenticate, operationLog('invitations', '手动设置报名成功'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        code: 403,
        message: '权限不足，仅管理员可以操作'
      });
    }

    const { remark, need_pay } = req.body || {};
    const invitation = await Invitation.findByPk(req.params.id);

    if (!invitation) {
      return res.status(404).json({
        code: 404,
        message: '邀约不存在'
      });
    }

    // 手动报名成功时同样允许改「是否需要付款」；不传沿用原值
    const needPay2 = (need_pay === 0 || need_pay === '0' || need_pay === false) ? 0
      : (need_pay === 1 || need_pay === '1' || need_pay === true) ? 1
        : (Number(invitation.need_pay) === 1 ? 1 : 0);   // 不传沿用原值；缺省按「邀约免票」

    if (invitation.is_valid === 0 || invitation.is_valid === false) {
      return res.status(400).json({
        code: 400,
        message: '该邀约已无效，无法设置为报名成功'
      });
    }

    if (invitation.registration_status === 2) {
      return res.status(400).json({
        code: 400,
        message: '该邀约已是报名成功状态'
      });
    }

    await invitation.update({
      registration_status: 2,
      registration_time: new Date(),
      approval_time: new Date(),
      approval_by: req.user.username,
      approval_remark: remark || '管理员手动设置报名成功',
      need_pay: needPay2
    });

    // 同步报名记录状态（建单前置）
    await syncRegistrationApproved(invitation.id, invitation.event_id, invitation.guest_id);

    // 报名成功 → 补单（免票出票 / 需付款建待支付单）
    let orderInfo = null;
    try {
      const regs = await Registration.findAll({ where: { invitation_id: invitation.id }, order: [['id', 'DESC']] });
      for (const reg of regs) {
        const r = await groupOrderService.ensureGroupOrderAfterApprove(reg);
        if (r && r.ok && !r.skipped) { orderInfo = r; break; }
      }
    } catch (e) {
      console.error('[手动报名成功] 建单异常（不阻塞）：', e.message);
    }

    await invitation.reload({
      include: [
        { model: Event, as: 'event' },
        { model: Guest, as: 'guest' },
        {
          model: Admin,
          as: 'bd',
          attributes: ['id', 'username', 'name', 'contact'],
          required: false
        }
      ]
    });

    res.json({
      code: 200,
      message: orderInfo && orderInfo.free ? '已设为报名成功（免票，已自动出票）' : '已手动设置为报名成功',
      data: invitation,
      order: orderInfo
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '操作失败',
      error: error.message
    });
  }
});

/**
 * PUT /api/invitations/:id/need-pay   管理员改「是否需要付款」
 * body: { need_pay: 0|1 }
 * 已报名且已建待支付单的情况下改成免票 → 原单作废并直接出票
 */
router.put('/:id/need-pay', authenticate, operationLog('invitations', '修改邀约是否需付款'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ code: 403, message: '权限不足，仅管理员可以修改' });
    }
    const raw = req.body ? req.body.need_pay : undefined;
    const needPay = (raw === 0 || raw === '0' || raw === false) ? 0 : 1;
    const invitation = await Invitation.findByPk(req.params.id);
    if (!invitation) return res.status(404).json({ code: 404, message: '邀约不存在' });

    await invitation.update({ need_pay: needPay });
    console.log(`[邀约] #${invitation.id} need_pay → ${needPay}（${needPay ? '需付款' : '免票'}），操作人 ${req.user.username}`);

    // 已报名（registration_status=2）的邀约：立即把新口径落到订单上
    let orderInfo = null;
    if (Number(invitation.registration_status) === 2) {
      try {
        const regs = await Registration.findAll({ where: { invitation_id: invitation.id }, order: [['id', 'DESC']] });
        for (const reg of regs) {
          const r = await groupOrderService.ensureGroupOrderAfterApprove(reg);
          if (r && r.ok && !r.skipped) { orderInfo = r; break; }
          if (r && !r.ok && !r.skipped) console.warn('[改付款口径] 同步订单失败：', r.error);
        }
      } catch (e) {
        console.error('[改付款口径] 同步订单异常（不阻塞）：', e.message);
      }
    }

    await invitation.reload();
    res.json({
      code: 200,
      message: needPay ? '已设为需付款' : '已设为免票',
      data: invitation,
      order: orderInfo
    });
  } catch (error) {
    res.status(500).json({ code: 500, message: '操作失败', error: error.message });
  }
});

// 获取邀约中出现过的BD负责人（source_bd）去重列表（需要认证）
router.get('/source-bds', authenticate, operationLog('invitations', '获取邀约BD负责人列表'), async (req, res) => {
  try {
    const where = {
      source_bd: {
        [Op.and]: [
          { [Op.ne]: null },
          { [Op.ne]: '' }
        ]
      }
    };

    // BD 用户只允许看到自己（避免暴露其他BD/历史负责人）
    if (req.user.role === 'bd') {
      where.source_bd = req.user.username;
    }

    const rows = await Invitation.findAll({
      attributes: [[Invitation.sequelize.fn('DISTINCT', Invitation.sequelize.col('source_bd')), 'source_bd']],
      where,
      raw: true,
      order: [[Invitation.sequelize.col('source_bd'), 'ASC']]
    });

    const list = rows
      .map(r => (r && r.source_bd !== undefined && r.source_bd !== null) ? String(r.source_bd).trim() : '')
      .filter(v => v && v !== 'null' && v !== 'undefined');

    res.json({
      code: 200,
      message: '获取成功',
      data: {
        list
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

// 导出邀约为Excel（需要认证）
router.get('/export', authenticate, operationLog('invitations', '导出邀约Excel'), async (req, res) => {
  try {
    const { event_id, guest_id, registration_status, is_valid, source_bd } = req.query;
    const where = {};
    if (event_id) where.event_id = event_id;
    if (guest_id) where.guest_id = guest_id;
    if (registration_status !== undefined) where.registration_status = registration_status;
    if (is_valid !== undefined) where.is_valid = is_valid;

    // BD用户只能导出自己负责的邀约
    if (req.user.role === 'bd') {
      where.source_bd = req.user.username;
    }

    // 管理员可按 BD 负责人筛选导出
    if (req.user.role === 'admin' && typeof source_bd === 'string' && source_bd.trim() !== '') {
      where.source_bd = source_bd.trim();
    }

    const invitations = await Invitation.findAll({
      where,
      include: [
        { model: Event, as: 'event' },
        { model: Guest, as: 'guest' }
      ],
      order: [['created_at', 'DESC']]
    });

    // 构造导出数据
    const data = invitations.map(inv => {
      let phone = '';
      if (inv.guest && inv.guest.phone) {
        try {
          phone = decryptPhone(inv.guest.phone) || '';
        } catch (e) {
          phone = '';
        }
      }
      const accommodation = inv.accommodation ? JSON.stringify(inv.accommodation) : '';
      const seats = inv.seats ? JSON.stringify(inv.seats) : '';
      const statusTextMap = {
        0: '待回复',
        1: '待审批',
        2: '已接受',
        3: '已拒绝'
      };
      return {
        邀约ID: inv.id,
        嘉宾姓名: inv.guest?.name || '',
        手机号: phone,
        公司: inv.guest?.company || '',
        职位: inv.guest?.position || '',
        活动ID: inv.event_id || '',
        活动名称: inv.event?.name || '',
        活动地点: inv.event?.location || '',
        报名状态: statusTextMap[inv.registration_status] || inv.registration_status || '',
        是否需付款: Number(inv.need_pay) === 0 ? '免票' : '需付款',
        邀约码: inv.invite_code || '',
        住宿分配: accommodation,
        座位分配: seats,
        创建时间: inv.created_at ? inv.created_at.toISOString() : '',
        报名时间: inv.registration_time ? inv.registration_time.toISOString() : ''
      };
    });

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '邀约');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const fileName = `invitations_${Date.now()}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buffer);
  } catch (error) {
    console.error('导出邀约失败:', error);
    res.status(500).json({
      code: 500,
      message: '导出失败',
      error: error.message
    });
  }
});

// 获取指定活动已存在有效邀约的嘉宾ID列表（用于前端过滤，避免重复邀约）
router.get('/existing-guest-ids', authenticate, operationLog('invitations', '获取已邀约嘉宾ID列表'), async (req, res) => {
  try {
    const { event_id } = req.query;

    if (!event_id) {
      return res.status(400).json({
        code: 400,
        message: '活动ID不能为空'
      });
    }

    const rows = await Invitation.findAll({
      where: { event_id, is_valid: 1 },
      attributes: ['guest_id'],
      group: ['guest_id'],
      raw: true
    });

    res.json({
      code: 200,
      message: '获取成功',
      data: {
        guest_ids: rows.map(r => r.guest_id)
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

// 获取单个邀请详情（需要认证）
router.get('/:id(\\d+)', authenticate, operationLog('invitations', '获取邀约详情'), async (req, res) => {
  try {
    const { Admin } = require('../models');
    const invitation = await Invitation.findByPk(req.params.id, {
      include: [
        { model: Event, as: 'event' },
        { model: Guest, as: 'guest' },
        { model: Checkin, as: 'checkin' },
        { 
          model: Admin, 
          as: 'bd',
          attributes: ['id', 'username', 'name', 'contact'],
          required: false 
        }
      ]
    });
    
    if (!invitation) {
      return res.status(404).json({
        code: 404,
        message: '邀请不存在'
      });
    }
    
    // 权限检查：管理员可以查看所有邀约，BD用户只能查看自己负责的邀约
    if (req.user.role === 'bd' && invitation.source_bd !== req.user.username) {
      return res.status(403).json({
        code: 403,
        message: '无权访问此邀约'
      });
    }
    // 管理员（role === 'admin'）可以查看所有邀约，无需额外检查
    
    // 确保返回的数据包含所有字段（包括bd关联）
    const invitationData = invitation.toJSON();
    
    // 解密嘉宾手机号
    if (invitationData.guest && invitationData.guest.phone) {
      try {
        invitationData.guest.phone_decrypted = decryptPhone(invitationData.guest.phone);
      } catch (e) {
        console.warn('解密手机号失败:', e);
        invitationData.guest.phone_decrypted = null;
      }
    }
    
    // 补票种 / 场次信息（嘉宾看邀请函时想知道自己是什么票）
    try {
      const reg = invitationData.registration;
      const ttId = Number(invitationData.ticket_type_id || (reg && reg.ticket_type_id) || 0);
      if (ttId) {
        const tt = await TicketType.findByPk(ttId);
        if (tt) { invitationData.ticket_type_name = tt.name; invitationData.ticket_price = tt.price; }
      }
      const sessId = Number(invitationData.session_id || (reg && reg.session_id) || 0);
      if (sessId) {
        const ss = await Session.findByPk(sessId);
        if (ss) { invitationData.session_name = ss.name; }
      }
    } catch (e) { /* 票种信息取不到不影响主流程 */ }

    res.json({
      code: 200,
      message: '获取成功',
      data: invitationData
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// 修改邀约绑定的活动（需要认证）
// 修改后会清空住宿和座位分配，并重新生成邀约链接/二维码
router.put('/:id/change-event', authenticate, operationLog('invitations', '修改邀约活动'), async (req, res) => {
  try {
    const { event_id } = req.body;

    if (!event_id) {
      return res.status(400).json({
        code: 400,
        message: '新活动ID不能为空'
      });
    }

    const invitation = await Invitation.findByPk(req.params.id, {
      include: [
        { model: Event, as: 'event' },
        { model: Guest, as: 'guest' }
      ]
    });

    if (!invitation) {
      return res.status(404).json({
        code: 404,
        message: '邀约不存在'
      });
    }

    // BD 权限检查：只能修改自己负责的邀约
    if (req.user.role === 'bd' && invitation.source_bd !== req.user.username) {
      return res.status(403).json({
        code: 403,
        message: '无权修改该邀约'
      });
    }

    // 检查新活动是否存在
    const newEvent = await Event.findByPk(event_id);
    if (!newEvent) {
      return res.status(404).json({
        code: 404,
        message: '新活动不存在'
      });
    }

    // 重新生成邀约链接
    const inviteUrl = buildInviteUrl(newEvent, invitation.invite_code);

    // 更新邀约：修改活动、清空住宿和座位、更新链接，二维码重置
    await invitation.update({
      event_id,
      accommodation: null,
      seats: null,
      invite_url: inviteUrl,
      qr_code_url: null
    });

    // 同步更新报名记录中的活动ID与住宿信息
    const { Registration } = require('../models');
    const registration = await Registration.findOne({
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
      if (extraFields.accommodation) {
        delete extraFields.accommodation;
      }
      await registration.update({
        event_id,
        extra_fields: extraFields
      });
    }

    // 生成新的二维码（异步，不阻塞响应）
    setImmediate(async () => {
      try {
        const qrCode = await generateQRCode(inviteUrl, `invite_${invitation.invite_code}`);
        await Invitation.update(
          { qr_code_url: qrCode.url },
          { where: { id: invitation.id } }
        );
      } catch (e) {
        console.error('[修改邀约活动] 生成二维码失败:', e);
      }
    });

    // 重新加载包含关联数据
    await invitation.reload({
      include: [
        { model: Event, as: 'event' },
        { model: Guest, as: 'guest' }
      ]
    });

    res.json({
      code: 200,
      message: '活动修改成功，住宿与座位信息已清空，请重新分配',
      data: invitation
    });
  } catch (error) {
    console.error('[修改邀约活动] 失败:', error);
    res.status(500).json({
      code: 500,
      message: '修改失败',
      error: error.message
    });
  }
});

// 验证手机号是否在系统中（H5公开接口）
router.post('/verify-phone', async (req, res) => {
  try {
    const { phone, event_id } = req.body;
    
    if (!phone) {
      return res.status(400).json({
        code: 400,
        message: '手机号不能为空'
      });
    }
    
    // 通过手机号哈希查找嘉宾
    // ⚠️ EC9 的 phone_hmac 是 HMAC-SHA256（带 PHONE_HMAC_KEY），
    //    不是 EC8 的无盐 sha256，用错会永远查不到人。
    const { hmacPhone } = require('../utils/phoneCrypto');
    const phoneHash = hmacPhone(phone);
    const guest = await Guest.findOne({
      where: { phone_hash: phoneHash, status: 1 }
    });
    
    if (!guest) {
      return res.status(404).json({
        code: 404,
        message: '手机号未在系统中登记，请联系管理员'
      });
    }
    
    // 查找该嘉宾的所有有效邀请
    const invitations = await Invitation.findAll({
      where: {
        guest_id: guest.id,
        is_valid: 1
      },
      include: [
        {
          model: Event,
          as: 'event',
          attributes: ['id', 'name', 'location']
        },
        {
          model: Admin,
          as: 'bd',
          attributes: ['id', 'username', 'name', 'contact'],
          required: false
        }
      ],
      order: [['created_at', 'DESC']]
    });
    
    // 提取活动信息
    const events = invitations.map(inv => ({
      id: inv.event?.id,
      name: inv.event?.name,
      location: inv.event?.location
    }));
    
    // 如果提供了event_id，检查该活动下的报名状态
    let registrationStatus = null;
    let approvalStatus = null;
    let isRegistered = false;
    let inviterName = null;
    let inviterUsername = null;

    if (event_id) {
      const currentEventInvitation = invitations.find(inv => inv.event_id === parseInt(event_id));
      if (currentEventInvitation) {
        registrationStatus = currentEventInvitation.registration_status;
        // 已报名：registration_status = 2
        isRegistered = currentEventInvitation.registration_status === 2;

        inviterName = currentEventInvitation.bd?.name || currentEventInvitation.source_bd || null;
        inviterUsername = currentEventInvitation.bd?.username || currentEventInvitation.source_bd || null;
      }
    }

    // 如果未指定event_id或该活动下没有邀约，使用最新一条邀约作为邀请人来源
    if (!inviterName && invitations && invitations.length > 0) {
      const latestInvitation = invitations[0];
      inviterName = latestInvitation.bd?.name || latestInvitation.source_bd || null;
      inviterUsername = latestInvitation.bd?.username || latestInvitation.source_bd || null;
    }
    
    // 尝试解密手机号，供前端预填（如果需要）
    let guestPhone = null;
    try {
      if (guest.phone) {
        guestPhone = decryptPhone(guest.phone);
      }
    } catch (e) {
      console.warn('[verify-phone] 解密手机号失败:', e.message);
    }

    res.json({
      code: 200,
      message: '验证成功',
      data: {
        guest_id: guest.id,
        guest_name: guest.name,
        guest_company: guest.company,
        guest_position: guest.position,
        guest_phone: guestPhone,
        inviter_name: inviterName,
        inviter_username: inviterUsername,
        events: events,
        // 如果提供了event_id，返回该活动下的报名状态
        ...(event_id && {
          is_registered: isRegistered,
          registration_status: registrationStatus
        })
      }
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '验证失败',
      error: error.message
    });
  }
});

// 通过邀请码获取邀请信息
router.get('/code/:code', async (req, res) => {
  try {
    const invitation = await Invitation.findOne({
      where: { invite_code: req.params.code },
      include: [
        { model: Event, as: 'event' },
        { model: Guest, as: 'guest' },
        { model: Checkin, as: 'checkin' },
        // ⚠️ 原写法 include { model: Ticket, as: 'ticket' } 直接 500：
        //    Invitation 与 TicketType 之间没有定义关联（EC8 的 Ticket 语义已拆分），
        //    票种信息改为从报名记录反查。
        { model: Registration, as: 'registration', required: false },
        { model: Admin, as: 'bd', attributes: ['id', 'username', 'name', 'contact'] }
      ]
    });
    
    if (!invitation) {
      return res.status(404).json({
        code: 404,
        message: '邀请码无效'
      });
    }
    
    // 检查邀请是否有效
    if (invitation.is_valid !== 1) {
      return res.status(404).json({
        code: 404,
        message: '邀请码已失效'
      });
    }
    
    // 将邀请信息转换为 JSON 对象
    const invitationData = invitation.toJSON();
    
    // 如果包含嘉宾信息，解密手机号
    if (invitationData.guest && invitationData.guest.phone) {
      const { decryptPhone } = require('../utils/phoneCrypto');
      const decryptedPhone = decryptPhone(invitationData.guest.phone);
      if (decryptedPhone) {
        // 将解密后的手机号添加到 guest 对象中
        invitationData.guest.phone_decrypted = decryptedPhone;
      }
    }
    
    res.json({
      code: 200,
      message: '获取成功',
      data: invitationData
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// 创建邀请（需要认证）
router.post('/', authenticate, operationLog('invitations', '创建邀约'), async (req, res) => {
  try {
    let { event_id, guest_id, source_bd, created_by, need_pay } = req.body;
    
    // BD用户创建邀约时，自动设置source_bd为自己
    if (req.user.role === 'bd') {
      source_bd = req.user.username;
    }

    // 是否需要付款：2026-10-23 口径 —— 邀约嘉宾一律免票，新建邀约默认「免票(0)」；
    // 管理员仍可显式改成「需付款(1)」（特殊情形：邀约嘉宾也要买票）
    const needPay = (need_pay === 1 || need_pay === '1' || need_pay === true) ? 1 : 0;
    
    // 检查该嘉宾在该活动是否已有邀约记录（无论状态，只要is_valid=1）
    const existingInvitation = await Invitation.findOne({
      where: { event_id, guest_id, is_valid: 1 }
    });
    
    if (existingInvitation) {
      return res.status(400).json({
        code: 400,
        message: '该嘉宾在该活动已有邀约记录，不能重复创建。如需重新申请，请先删除原邀约记录。'
      });
    }
    
    // 生成唯一邀请码
    let invite_code = generateInviteCode();
    let exists = await Invitation.findOne({ where: { invite_code } });
    while (exists) {
      invite_code = generateInviteCode();
      exists = await Invitation.findOne({ where: { invite_code } });
    }
    
    // 获取活动信息，使用活动的页面地址
    const event = await Event.findByPk(event_id);
    const config = require('../config');
    const baseUrl = config.frontend.baseUrl;
    
    // 如果活动有绑定的页面地址，使用活动页面地址 + 邀约码参数
    // 否则使用默认的 /invite/:code 格式
    let invite_url;
    if (event && event.page_url) {
      // 如果 page_url 是完整URL，直接使用；如果是相对路径，拼接baseUrl
      if (event.page_url.startsWith('http://') || event.page_url.startsWith('https://')) {
        // 完整URL，添加邀约码参数
        const url = new URL(event.page_url);
        url.searchParams.set('code', invite_code);
        invite_url = url.toString();
      } else {
        // 相对路径，拼接baseUrl和邀约码参数
        const separator = event.page_url.includes('?') ? '&' : '?';
        invite_url = `${baseUrl}${event.page_url}${separator}code=${invite_code}`;
      }
    } else {
      // 默认格式：/invite/:code
      invite_url = `${baseUrl}/invite/${invite_code}`;
    }
    
    // 后台创建的邀约，固定为"已同意"状态
    const invitation = await Invitation.create({
      event_id,
      guest_id,
      invite_code,
      source_bd,
      invite_url,
      created_by,
      need_pay: needPay,
      registration_status: 0,  // 待回复（后台创建的都是待回复）
      is_valid: 1
    });
    
    // 生成二维码图片（使用生成的邀约链接）
    try {
      const qrCode = await generateQRCode(invite_url, `invite_${invite_code}`);
      await invitation.update({ qr_code_url: qrCode.url });
    } catch (error) {
      console.error('生成邀约二维码失败:', error);
    }
    
    // 重新获取包含二维码URL的邀约信息
    await invitation.reload();
    
    res.status(201).json({
      code: 201,
      message: '创建成功',
      data: invitation
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '创建失败',
      error: error.message
    });
  }
});

// 批量创建邀请（需要认证）
router.post('/batch', authenticate, operationLog('invitations', '批量创建邀约'), async (req, res) => {
  try {
    let { event_id, guest_ids, source_bd, created_by, need_pay } = req.body;
    
    // BD用户批量创建邀约时，自动设置source_bd为自己
    if (req.user.role === 'bd') {
      source_bd = req.user.username;
    }

    // 批量创建同样默认「免票」（邀约嘉宾不掏钱），管理员可后续逐条改成需付款
    const needPay = (need_pay === 1 || need_pay === '1' || need_pay === true) ? 1 : 0;

    // 一次添加多人 = 同一批：整批可在「批次」视图里一起审核
    const batchNo = 'B' + Date.now() + crypto.randomBytes(3).toString('hex').toUpperCase();
    
    if (!Array.isArray(guest_ids) || guest_ids.length === 0) {
      return res.status(400).json({
        code: 400,
        message: '嘉宾ID列表不能为空'
      });
    }
    
    // 获取活动信息，使用活动的页面地址
    const event = await Event.findByPk(event_id);
    const config = require('../config');
    const baseUrl = config.frontend.baseUrl;
    const invitations = [];
    
    // 生成邀约链接的辅助函数
    const generateInviteUrl = (inviteCode) => {
      if (event && event.page_url) {
        // 如果活动有绑定的页面地址，使用活动页面地址 + 邀约码参数
        if (event.page_url.startsWith('http://') || event.page_url.startsWith('https://')) {
          // 完整URL，添加邀约码参数
          const url = new URL(event.page_url);
          url.searchParams.set('code', inviteCode);
          return url.toString();
        } else {
          // 相对路径，拼接baseUrl和邀约码参数
          const separator = event.page_url.includes('?') ? '&' : '?';
          return `${baseUrl}${event.page_url}${separator}code=${inviteCode}`;
        }
      } else {
        // 默认格式：/invite/:code
        return `${baseUrl}/invite/${inviteCode}`;
      }
    };
    
    for (const guest_id of guest_ids) {
      // 检查是否已存在有效邀请
      const existing = await Invitation.findOne({
        where: { event_id, guest_id, is_valid: 1 }
      });
      
      if (existing) {
        continue; // 跳过已存在的邀请
      }
      
      // 生成唯一邀请码
      let invite_code = generateInviteCode();
      let exists = await Invitation.findOne({ where: { invite_code } });
      while (exists) {
        invite_code = generateInviteCode();
        exists = await Invitation.findOne({ where: { invite_code } });
      }
      
      const invite_url = generateInviteUrl(invite_code);
      
      invitations.push({
        event_id,
        guest_id,
        invite_code,
        source_bd,
        invite_url,
        created_by,
        need_pay: needPay,
        batch_no: batchNo,
        registration_status: 0,
        is_valid: 1
      });
    }
    
    const created = await Invitation.bulkCreate(invitations);
    
    // 批量生成二维码（异步，不阻塞响应）
    setImmediate(async () => {
      for (const invitation of created) {
        try {
          // 使用生成的邀约链接生成二维码
          const inviteUrl = invitation.invite_url || generateInviteUrl(invitation.invite_code);
          const qrCode = await generateQRCode(inviteUrl, `invite_${invitation.invite_code}`);
          await Invitation.update(
            { qr_code_url: qrCode.url },
            { where: { id: invitation.id } }
          );
        } catch (error) {
          console.error(`生成邀约二维码失败 (${invitation.invite_code}):`, error);
        }
      }
    });
    
    res.status(201).json({
      code: 201,
      message: '批量创建成功',
      data: {
        created: created.length,
        total: guest_ids.length,
        batch_no: batchNo,
        message: '二维码正在生成中，请稍后刷新查看'
      }
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '批量创建失败',
      error: error.message
    });
  }
});

// 删除/标记邀请为无效（用于嘉宾变更，需要认证）
router.put('/:id/invalidate', authenticate, operationLog('invitations', '标记邀约为无效'), async (req, res) => {
  try {
    const invitation = await Invitation.findByPk(req.params.id);
    
    if (!invitation) {
      return res.status(404).json({
        code: 404,
        message: '邀请不存在'
      });
    }
    
    // 权限检查：管理员可以操作所有邀约，BD用户只能操作自己负责的邀约
    if (req.user.role === 'bd' && invitation.source_bd !== req.user.username) {
      return res.status(403).json({
        code: 403,
        message: '无权操作此邀约'
      });
    }
    // 管理员（role === 'admin'）可以操作所有邀约，无需额外检查
    
    await invitation.update({ is_valid: 0 });
    
    res.json({
      code: 200,
      message: '标记为无效成功',
      data: invitation
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '操作失败',
      error: error.message
    });
  }
});

// 标记邀请为有效（用于恢复无效的邀约，需要认证）
router.put('/:id/validate', authenticate, operationLog('invitations', '标记邀约为有效'), async (req, res) => {
  try {
    const invitation = await Invitation.findByPk(req.params.id);
    
    if (!invitation) {
      return res.status(404).json({
        code: 404,
        message: '邀请不存在'
      });
    }
    
    // 权限检查：管理员可以操作所有邀约，BD用户只能操作自己负责的邀约
    if (req.user.role === 'bd' && invitation.source_bd !== req.user.username) {
      return res.status(403).json({
        code: 403,
        message: '无权操作此邀约'
      });
    }
    // 管理员（role === 'admin'）可以操作所有邀约，无需额外检查
    
    await invitation.update({ is_valid: 1 });
    
    res.json({
      code: 200,
      message: '标记为有效成功',
      data: invitation
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '操作失败',
      error: error.message
    });
  }
});

// 删除邀请（需要认证）
router.delete('/:id', authenticate, operationLog('invitations', '删除邀约'), async (req, res) => {
  try {
    const invitation = await Invitation.findByPk(req.params.id);
    if (!invitation) {
      return res.status(404).json({
        code: 404,
        message: '邀请不存在'
      });
    }
    
    // 权限检查：管理员可以删除所有邀约，BD用户只能删除自己负责的邀约
    if (req.user.role === 'bd' && invitation.source_bd !== req.user.username) {
      return res.status(403).json({
        code: 403,
        message: '无权删除此邀约'
      });
    }
    // 管理员（role === 'admin'）可以删除所有邀约，无需额外检查
    
    await invitation.destroy();
    res.json({
      code: 200,
      message: '删除成功'
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '删除失败',
      error: error.message
    });
  }
});

// 重新生成邀约二维码（需要认证）
router.post('/:id/regenerate-qrcode', authenticate, operationLog('invitations', '重新生成邀约二维码'), async (req, res) => {
  try {
    const invitation = await Invitation.findByPk(req.params.id, {
      include: [{ model: Event, as: 'event' }]
    });
    
    if (!invitation) {
      return res.status(404).json({
        code: 404,
        message: '邀请不存在'
      });
    }
    
    // 使用邀约链接生成二维码（如果邀约链接已存在，直接使用；否则重新生成）
    const inviteUrl = invitation.invite_url || (() => {
      const config = require('../config');
    const baseUrl = config.frontend.baseUrl;
      const event = invitation.event;
      if (event && event.page_url) {
        if (event.page_url.startsWith('http://') || event.page_url.startsWith('https://')) {
          const url = new URL(event.page_url);
          url.searchParams.set('code', invitation.invite_code);
          return url.toString();
        } else {
          const separator = event.page_url.includes('?') ? '&' : '?';
          return `${baseUrl}${event.page_url}${separator}code=${invitation.invite_code}`;
        }
      } else {
        return `${baseUrl}/invite/${invitation.invite_code}`;
      }
    })();
    
    // 重新生成二维码
    const qrCode = await generateQRCode(inviteUrl, `invite_${invitation.invite_code}`);
    await invitation.update({ qr_code_url: qrCode.url });
    
    await invitation.reload();
    
    res.json({
      code: 200,
      message: '二维码重新生成成功',
      data: {
        invitation,
        qr_code_url: qrCode.url,
        qr_code_data: qrCode.data
      }
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '重新生成二维码失败',
      error: error.message
    });
  }
});

// 批准邀约（需要认证，仅管理员）
router.post('/:id/approve', authenticate, operationLog('invitations', '批准邀约'), async (req, res) => {
  try {
    // 检查权限：仅管理员可以审批
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        code: 403,
        message: '权限不足，仅管理员可以审批'
      });
    }
    
    const { remark, need_pay } = req.body;
    const invitation = await Invitation.findByPk(req.params.id);

    if (!invitation) {
      return res.status(404).json({
        code: 404,
        message: '邀约不存在'
      });
    }

    const smsLang = (req.body && req.body.lang) ? req.body.lang
      : (req.headers && req.headers['accept-language'] ? String(req.headers['accept-language']).slice(0, 5) : null);
    const r = await approveInvitationCore(invitation, req.user, { remark, need_pay, lang: smsLang });
    if (!r.ok) return res.status(400).json({ code: 400, message: r.error });

    res.json({
      code: 200,
      message: r.free ? '审批通过（免票，已自动出票）' : '审批通过',
      data: invitation,
      order: r.order
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '审批失败',
      error: error.message
    });
  }
});

// 拒绝邀约（需要认证，仅管理员）
router.post('/:id/reject', authenticate, operationLog('invitations', '拒绝邀约'), async (req, res) => {
  try {
    // 检查权限：仅管理员可以审批
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        code: 403,
        message: '权限不足，仅管理员可以审批'
      });
    }
    
    const { remark } = req.body;
    if (!remark) {
      return res.status(400).json({
        code: 400,
        message: '拒绝原因不能为空'
      });
    }
    
    const invitation = await Invitation.findByPk(req.params.id);

    if (!invitation) {
      return res.status(404).json({
        code: 404,
        message: '邀约不存在'
      });
    }

    const r = await rejectInvitationCore(invitation, req.user, { remark });
    if (!r.ok) return res.status(400).json({ code: 400, message: r.error });

    res.json({
      code: 200,
      message: '已拒绝',
      data: invitation
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '操作失败',
      error: error.message
    });
  }
});

/* ==================================================================
   批次：一次添加多人 / 一次提交多人 = 同一批，可整批审核
   说明：审核入口已统一收敛到邀约管理，「报名审核」页不再单独使用。
   ================================================================== */

// 批次列表（需要认证，仅管理员）
router.get('/batches', authenticate, operationLog('invitations', '获取邀约批次列表'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ code: 403, message: '权限不足，仅管理员可查看批次' });
    }
    const { event_id, only_pending } = req.query;
    const where = [`i.batch_no IS NOT NULL AND i.batch_no <> ''`];
    if (event_id) where.push(`i.event_id = ${Number(event_id)}`);

    const rows = await Invitation.sequelize.query(`
      SELECT i.batch_no,
             MAX(i.event_id) AS event_id,
             count(*) AS total,
             count(*) FILTER (WHERE i.registration_status = 0) AS not_registered,
             count(*) FILTER (WHERE i.registration_status = 1) AS pending,
             count(*) FILTER (WHERE i.registration_status = 2) AS approved,
             count(*) FILTER (WHERE i.registration_status = 3) AS rejected,
             count(*) FILTER (WHERE COALESCE(i.need_pay, 1) = 1) AS need_pay_count,
             MIN(i.created_at) AS created_at,
             MAX(i.source_bd) AS source_bd,
             bool_or(COALESCE(i.extra_fields->>'auto_created', 'false') = 'true') AS from_registration
      FROM ec9_invitations i
      WHERE ${where.join(' AND ')}
      GROUP BY i.batch_no
      ORDER BY MIN(i.created_at) DESC
    `, { type: require('sequelize').QueryTypes.SELECT });

    let list = rows;
    if (only_pending === '1' || only_pending === 'true') {
      // 「待处理」= 还有待审批的人，或还没报名的人（后台批量创建的批次就是待回复，同样要能整批处理）
      list = rows.filter(r => Number(r.pending) > 0 || Number(r.not_registered) > 0);
    }
    // BD 只能看自己的批次
    if (req.user.role === 'bd') list = list.filter(r => r.source_bd === req.user.username);

    const events = await Event.findAll({ attributes: ['id', 'name'] });
    const emap = new Map(events.map(e => [e.id, e.name]));
    list = list.map(r => ({ ...r, event_name: emap.get(r.event_id) || '-' }));

    res.json({ code: 200, message: '获取成功', data: { list } });
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取批次失败', error: error.message });
  }
});

// 批次明细：这批有谁、各自票种/是否付款/当前状态
router.get('/batches/:batchNo', authenticate, operationLog('invitations', '获取邀约批次明细'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ code: 403, message: '权限不足，仅管理员可查看批次' });
    }
    const batchNo = String(req.params.batchNo || '').trim();
    const invs = await Invitation.findAll({
      where: { batch_no: batchNo },
      include: [{ model: Guest, as: 'guest' }, { model: Event, as: 'event' }],
      order: [['id', 'ASC']]
    });
    if (!invs.length) return res.status(404).json({ code: 404, message: '批次不存在或已清空' });

    const invIds = invs.map(i => i.id);
    const regs = await Registration.findAll({
      where: { invitation_id: { [Op.in]: invIds } },
      include: [{ model: TicketType, as: 'ticketType' }],
      order: [['id', 'DESC']]
    });
    const regMap = new Map();
    for (const r of regs) if (!regMap.has(r.invitation_id)) regMap.set(r.invitation_id, r);

    const list = invs.map(inv => {
      const o = inv.toJSON();
      const reg = regMap.get(inv.id);
      let phone = null;
      if (o.guest && o.guest.phone) {
        try { phone = decryptPhone(o.guest.phone); } catch (e) { phone = null; }
      }
      return {
        invitation_id: inv.id,
        guest_id: inv.guest_id,
        name: (o.guest && o.guest.name) || '-',
        company: (o.guest && o.guest.company) || '-',
        position: (o.guest && o.guest.position) || '-',
        phone,
        event_id: inv.event_id,
        event_name: (o.event && o.event.name) || '-',
        registration_status: inv.registration_status,
        need_pay: Number(inv.need_pay) !== 0,
        source_bd: inv.source_bd || '-',
        approval_remark: inv.approval_remark || '',
        registration_id: reg ? reg.id : null,
        group_no: reg ? reg.group_no : null,
        reg_status: reg ? reg.status : null,
        ticket_name: reg && reg.ticketType ? reg.ticketType.name : null,
        ticket_price: reg && reg.ticketType ? Number(reg.ticketType.price) : null
      };
    });

    const groupNos = [...new Set(list.map(x => x.group_no).filter(Boolean))];
    let order = null;
    if (groupNos.length === 1) {
      const { Order } = require('../models');
      order = await Order.findOne({ where: { group_no: groupNos[0] }, order: [['id', 'DESC']] });
      if (order) order = {
        order_no: order.order_no, status: order.status,
        final_amount: Number(order.final_amount), discount_rate: Number(order.discount_rate)
      };
    }

    res.json({
      code: 200, message: '获取成功',
      data: {
        batch_no: batchNo,
        event_id: invs[0].event_id,
        source_bd: invs[0].source_bd || '-',
        created_at: invs[0].created_at,
        total: list.length,
        pending: list.filter(x => x.registration_status === 1).length,
        approved: list.filter(x => x.registration_status === 2).length,
        rejected: list.filter(x => x.registration_status === 3).length,
        order, list
      }
    });
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取批次明细失败', error: error.message });
  }
});

// 整批审核：这批人一起通过 / 一起驳回
router.post('/batches/:batchNo/audit', authenticate, operationLog('invitations', '整批审核邀约'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ code: 403, message: '权限不足，仅管理员可以审批' });
    }
    const { action, remark, need_pay } = req.body || {};
    if (action !== 'approve' && action !== 'reject') {
      return res.status(400).json({ code: 400, message: 'action 只能是 approve 或 reject' });
    }
    if (action === 'reject' && !remark) {
      return res.status(400).json({ code: 400, message: '整批驳回必须填写原因' });
    }
    const batchNo = String(req.params.batchNo || '').trim();
    const invs = await Invitation.findAll({ where: { batch_no: batchNo }, order: [['id', 'ASC']] });
    if (!invs.length) return res.status(404).json({ code: 404, message: '批次不存在或已清空' });

    const results = [];
    for (const inv of invs) {
      if (action === 'approve') {
        if (Number(inv.registration_status) === 2) { results.push({ id: inv.id, skipped: true, reason: '已通过' }); continue; }
        const r = await approveInvitationCore(inv, req.user, { remark, need_pay });
        results.push(r.ok ? { id: inv.id, ok: true, free: !!r.free } : { id: inv.id, ok: false, reason: r.error });
      } else {
        if (Number(inv.registration_status) === 3) { results.push({ id: inv.id, skipped: true, reason: '已拒绝' }); continue; }
        const r = await rejectInvitationCore(inv, req.user, { remark });
        results.push(r.ok ? { id: inv.id, ok: true } : { id: inv.id, ok: false, reason: r.error });
      }
    }
    const okN = results.filter(r => r.ok).length;
    const failN = results.filter(r => r.ok === false).length;

    res.json({
      code: 200,
      message: action === 'approve'
        ? `整批通过完成：成功 ${okN} 人${failN ? `，失败 ${failN} 人` : ''}`
        : `整批驳回完成：成功 ${okN} 人${failN ? `，失败 ${failN} 人` : ''}`,
      data: { batch_no: batchNo, total: invs.length, ok: okN, failed: failN, results }
    });
  } catch (error) {
    res.status(500).json({ code: 500, message: '整批审核失败', error: error.message });
  }
});

// 勾选批量审核（可跨批次，任意多条）
router.post('/bulk-audit', authenticate, operationLog('invitations', '批量审核邀约'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ code: 403, message: '权限不足，仅管理员可以审批' });
    }
    const { ids, action, remark, need_pay } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ code: 400, message: '请先勾选要审核的邀约' });
    }
    if (action !== 'approve' && action !== 'reject') {
      return res.status(400).json({ code: 400, message: 'action 只能是 approve 或 reject' });
    }
    if (action === 'reject' && !remark) {
      return res.status(400).json({ code: 400, message: '批量驳回必须填写原因' });
    }
    const invs = await Invitation.findAll({ where: { id: { [Op.in]: ids.map(Number).filter(n => n > 0) } }, order: [['id', 'ASC']] });

    const results = [];
    for (const inv of invs) {
      if (action === 'approve') {
        if (Number(inv.registration_status) === 2) { results.push({ id: inv.id, skipped: true, reason: '已通过' }); continue; }
        const r = await approveInvitationCore(inv, req.user, { remark, need_pay });
        results.push(r.ok ? { id: inv.id, ok: true, free: !!r.free } : { id: inv.id, ok: false, reason: r.error });
      } else {
        if (Number(inv.registration_status) === 3) { results.push({ id: inv.id, skipped: true, reason: '已拒绝' }); continue; }
        const r = await rejectInvitationCore(inv, req.user, { remark });
        results.push(r.ok ? { id: inv.id, ok: true } : { id: inv.id, ok: false, reason: r.error });
      }
    }
    const okN = results.filter(r => r.ok).length;
    const failN = results.filter(r => r.ok === false).length;

    res.json({
      code: 200,
      message: action === 'approve'
        ? `批量通过完成：成功 ${okN} 人${failN ? `，失败 ${failN} 人` : ''}`
        : `批量驳回完成：成功 ${okN} 人${failN ? `，失败 ${failN} 人` : ''}`,
      data: { total: invs.length, ok: okN, failed: failN, results }
    });
  } catch (error) {
    res.status(500).json({ code: 500, message: '批量审核失败', error: error.message });
  }
});

// 获取待审批邀约列表（需要认证，仅管理员）
router.get('/pending', authenticate, operationLog('invitations', '获取待审批列表'), async (req, res) => {
  try {
    // 检查权限：仅管理员可以查看
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        code: 403,
        message: '权限不足，仅管理员可以查看'
      });
    }
    
    const { page = 1, pageSize = 10, event_id } = req.query;
    const offset = (page - 1) * pageSize;
    
    const where = {
      approval_status: 1,  // 待审批
      is_valid: 1
    };
    
    if (event_id) where.event_id = event_id;
    
    const { count, rows } = await Invitation.findAndCountAll({
      where,
      include: [
        { model: Event, as: 'event' },
        { model: Guest, as: 'guest' },
        { 
          model: Admin, 
          as: 'bd',
          attributes: ['id', 'username', 'name', 'contact'],
          required: false 
        }
      ],
      limit: parseInt(pageSize),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']]
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

// 分配住宿房间（需要认证）
// 支持两种提交方式：
// 1) JSON对象 accommodation: { room: '1208', hotel: 'XX酒店' }
// 2) 简单字符串 room / room_no: '1208' （后台会自动包装为 { room: '1208' }）
router.put('/:id/accommodation', authenticate, operationLog('invitations', '分配住宿'), async (req, res) => {
  try {
    const { accommodation, room, room_no, hotel } = req.body;
    
    const invitation = await Invitation.findByPk(req.params.id);
    
    if (!invitation) {
      return res.status(404).json({
        code: 404,
        message: '邀约不存在'
      });
    }
    
    // 规范化输入：优先使用 accommodation 对象；如果没有则用 room/room_no/hotel 构造
    let incoming = accommodation;
    if (!incoming) {
      // 如果提供了 room 或 room_no，则自动封装
      if (room || room_no || hotel) {
        incoming = {};
        if (room || room_no) incoming.room = room || room_no;
        if (hotel) incoming.hotel = hotel;
      }
    }
    
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({
        code: 400,
        message: '住宿信息格式错误（可直接填写房间号 room）'
      });
    }
    
    // 如果传入的是完整的 accommodation 对象（有多个key），则完全替换；否则合并
    const existingAccommodation = invitation.accommodation || {};
    let updatedAccommodation;
    
    // 判断：如果 incoming 有多个key，或者明确是完整对象，则完全替换
    const incomingKeys = Object.keys(incoming);
    if (incomingKeys.length > 1 || req.body.replace_all) {
      // 完全替换
      updatedAccommodation = incoming;
    } else {
      // 合并：新数据覆盖旧数据中相同的key
      updatedAccommodation = {
        ...existingAccommodation,
        ...incoming
      };
    }
    
    await invitation.update({
      accommodation: updatedAccommodation
    });
    
    await invitation.reload();
    
    res.json({
      code: 200,
      message: '住宿分配成功',
      data: invitation
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '分配失败',
      error: error.message
    });
  }
});

// 分配座位号（需要认证）
// 支持两种提交方式：
// 1) JSON对象 seats: { main: '07桌02' }
// 2) 简单字符串 seat / seat_no: '07桌02' （后台会自动包装为 { main: '07桌02' }）
router.put('/:id/seats', authenticate, operationLog('invitations', '分配座位'), async (req, res) => {
  try {
    const { seats, seat, seat_no } = req.body;
    
    const invitation = await Invitation.findByPk(req.params.id);
    
    if (!invitation) {
      return res.status(404).json({
        code: 404,
        message: '邀约不存在'
      });
    }
    
    // 规范化输入
    let incoming = seats;
    if (!incoming) {
      if (seat || seat_no) {
        incoming = { main: seat || seat_no };
      }
    }
    
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({
        code: 400,
        message: '座位信息格式错误（可直接填写座位号 seat）'
      });
    }
    
    // 如果传入的是完整的 seats 对象（有多个key），则完全替换；否则合并
    const existingSeats = invitation.seats || {};
    let updatedSeats;
    
    // 判断：如果 incoming 有多个key，或者明确是完整对象，则完全替换
    const incomingKeys = Object.keys(incoming);
    if (incomingKeys.length > 1 || req.body.replace_all) {
      // 完全替换
      updatedSeats = incoming;
    } else {
      // 合并：新数据覆盖旧数据中相同的key
      updatedSeats = {
        ...existingSeats,
        ...incoming
      };
    }
    
    await invitation.update({
      seats: updatedSeats
    });
    
    await invitation.reload();
    
    res.json({
      code: 200,
      message: '座位分配成功',
      data: invitation
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '分配失败',
      error: error.message
    });
  }
});

module.exports = router;

