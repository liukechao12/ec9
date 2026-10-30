const express = require('express');
const router = express.Router();
const { Checkin, Invitation, Guest, Event, CheckinCode, Registration } = require('../models');
const { Op } = require('sequelize');
const { authenticate } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');

// 获取所有签到记录（需要认证）
router.get('/', authenticate, operationLog('checkins', '获取签到记录列表'), async (req, res) => {
  try {
    const { page = 1, pageSize = 10, event_id, location_type } = req.query;
    const offset = (page - 1) * pageSize;
    
    const where = {};
    if (event_id) where.event_id = event_id;
    if (location_type) where.location_type = location_type;
    
    // BD用户只能看到自己负责的参会人员的签到情况
    // 通过source_bd字段过滤
    const includeOptions = [
      { model: Event, as: 'event' },
      { model: Guest, as: 'guest' },
      { 
        model: Invitation, 
        as: 'invitation',
        where: req.user.role === 'bd' ? { source_bd: req.user.username } : {},
        required: true
      }
    ];
    
    const { count, rows } = await Checkin.findAndCountAll({
      where,
      include: includeOptions,
      limit: parseInt(pageSize),
      offset: parseInt(offset),
      order: [['checkin_time', 'DESC']],
      distinct: true // 避免count时重复计算
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

// 管理员代签到（需要认证，仅管理员）
router.post('/admin-checkin', authenticate, operationLog('checkins', '管理员代签到'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        code: 403,
        message: '权限不足，仅管理员可以操作'
      });
    }

    const { invitationIds, invitation_id, invitationId } = req.body || {};
    const ids = Array.isArray(invitationIds)
      ? invitationIds
      : [invitation_id || invitationId].filter(Boolean);

    const normalizedIds = [...new Set(ids.map(v => parseInt(v)).filter(v => Number.isFinite(v) && v > 0))];

    if (normalizedIds.length === 0) {
      return res.status(400).json({
        code: 400,
        message: '邀约ID不能为空'
      });
    }

    const invitations = await Invitation.findAll({
      where: { id: { [Op.in]: normalizedIds } }
    });

    const invitationById = new Map(invitations.map(inv => [inv.id, inv]));

    // ec9_checkins 的 registration_id / checkin_code_id 是 NOT NULL，
    // 代签到要按邀约反查报名与签到码，取不到就跳过（不能硬塞 0 污染数据）
    const invIds = [...invitationById.keys()];
    const regs = invIds.length
      ? await Registration.findAll({ where: { invitation_id: { [Op.in]: invIds } }, attributes: ['id', 'invitation_id'] })
      : [];
    const regByInv = new Map();
    regs.forEach(r => { if (!regByInv.has(r.invitation_id)) regByInv.set(r.invitation_id, r.id); });

    const codes = invIds.length
      ? await CheckinCode.findAll({ where: { registration_id: { [Op.in]: regs.map(r => r.id) } }, attributes: ['id', 'registration_id'] })
      : [];
    const codeByReg = new Map();
    codes.forEach(c => { if (!codeByReg.has(c.registration_id)) codeByReg.set(c.registration_id, c.id); });

    const existingCheckins = await Checkin.findAll({
      where: { invitation_id: { [Op.in]: normalizedIds } }
    });
    const checkedInIds = new Set(existingCheckins.map(c => c.invitation_id));

    const results = normalizedIds.map((id) => {
      const inv = invitationById.get(id);
      if (!inv) {
        return { invitation_id: id, success: false, reason: '邀约不存在' };
      }
      if (inv.is_valid === 0 || inv.is_valid === false) {
        return { invitation_id: id, success: false, reason: '邀约已无效' };
      }
      if (inv.registration_status !== 2) {
        return { invitation_id: id, success: false, reason: '未接受邀约，不能签到' };
      }
      if (checkedInIds.has(id)) {
        return { invitation_id: id, success: false, reason: '已签到' };
      }
      const regId = regByInv.get(id);
      if (!regId) {
        return { invitation_id: id, success: false, reason: '该邀约没有对应的报名记录' };
      }
      const codeId = codeByReg.get(regId);
      if (!codeId) {
        return { invitation_id: id, success: false, reason: '该报名没有签到码，需先生成签到码' };
      }
      return { invitation_id: id, success: true, registration_id: regId, checkin_code_id: codeId };
    });

    const toCreate = results
      .filter(r => r.success)
      .map(r => {
        const inv = invitationById.get(r.invitation_id);
        return {
          invitation_id: inv.id,
          event_id: inv.event_id,
          guest_id: inv.guest_id,
          registration_id: r.registration_id,
          checkin_code_id: r.checkin_code_id,
          checkin_time: new Date(),
          operator_id: req.user.id,
          operator_name: req.user.name,
          device_info: `admin:${req.user.username}`,
          user_agent: req.headers['user-agent'] || null,
          ip_address: req.ip || null
        };
      });

    let created = 0;
    if (toCreate.length > 0) {
      const createdRows = await Checkin.bulkCreate(toCreate, { ignoreDuplicates: true });
      created = Array.isArray(createdRows) ? createdRows.length : toCreate.length;
    }

    res.json({
      code: 200,
      message: '操作成功',
      data: {
        total: normalizedIds.length,
        created,
        results
      }
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '签到失败',
      error: error.message
    });
  }
});

// 通过手机号签到（H5签到接口）
router.post('/by-phone', async (req, res) => {
  try {
    const { phone, checkin_code, location, device_info, user_agent, ip_address } = req.body;
    
    if (!phone || !checkin_code) {
      return res.status(400).json({
        code: 400,
        message: '手机号和签到码不能为空'
      });
    }
    
    // 查找签到码
    const checkinCode = await CheckinCode.findOne({
      where: { code: checkin_code, is_active: 1 }
    });
    
    if (!checkinCode) {
      return res.status(404).json({
        code: 404,
        message: '签到码无效或已禁用'
      });
    }
    
    // 通过手机号查找嘉宾
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
        message: '未报名或手机号错误'
      });
    }
    
    // 查找该嘉宾的有效邀请（已报名状态）
    const invitation = await Invitation.findOne({
      where: {
        guest_id: guest.id,
        event_id: checkinCode.event_id,
        registration_status: 2, // 已报名
        is_valid: 1
      }
    });
    
    if (!invitation) {
      return res.status(404).json({
        code: 404,
        message: '未报名或手机号错误'
      });
    }
    
    // 检查是否已签到
    const existingCheckin = await Checkin.findOne({
      where: { invitation_id: invitation.id }
    });
    
    if (existingCheckin) {
      return res.status(400).json({
        code: 400,
        message: '您已经签到过了'
      });
    }
    
    // 创建签到记录
    const checkin = await Checkin.create({
      invitation_id: invitation.id,
      event_id: checkinCode.event_id,
      guest_id: guest.id,
      checkin_code_id: checkinCode.id,
      checkin_time: new Date(),
      location_type: checkinCode.code_type,
      location,
      device_info,
      user_agent,
      ip_address
    });
    
    // 触发登记成功短信
    try {
      const { SmsService, MESSAGE_TYPES } = require('../services/SmsService');
      await SmsService.sendMessage(MESSAGE_TYPES.CHECKIN_SUCCESS, { lang: SmsService.normalizeLang(req.body && req.body.lang),
        guestId: guest.id,
        eventId: checkinCode.event_id,
        invitationId: invitation.id
      });
    } catch (e) {
      console.error('触发登记成功短信失败:', e);
    }
    
    res.json({
      code: 200,
      message: '签到成功',
      data: {
        checkin,
        guest: {
          name: guest.name,
          company: guest.company
        },
        event: await Event.findByPk(checkinCode.event_id)
      }
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '签到失败',
      error: error.message
    });
  }
});

// 根据手机号 + 活动签到（无签到码，活动独立地址使用）
router.post('/event-checkin', async (req, res) => {
  try {
    const { phone, event_id, location, device_info, user_agent, ip_address } = req.body;
    
    if (!phone || !event_id) {
      return res.status(400).json({
        code: 400,
        message: '手机号和活动ID不能为空'
      });
    }
    
    // 查找嘉宾
    // ⚠️ EC9 的 phone_hmac 是 HMAC-SHA256（带 PHONE_HMAC_KEY），
    //    不是 EC8 的无盐 sha256，用错会永远查不到人。
    const { hmacPhone } = require('../utils/phoneCrypto');
    const phoneHmac = hmacPhone(phone);
    const guest = await Guest.findOne({ where: { phone_hmac: phoneHmac, status: 1 } });
    if (!guest) {
      return res.status(404).json({ code: 404, message: '未报名或手机号错误' });
    }
    
    // ⚠️ EC9 主链路是「自主报名」：报名落在 ec9_registrations，多数参会人**根本没有邀约记录**。
    //    旧逻辑只查 ec9_invitations，自主报名成功的人一律被判「未报名或手机号错误」。
    //    现在以报名记录为准（status=paid 才算报名成功），邀约仅作老链路兼容回退。
    let reg = await Registration.findOne({
      where: { guest_id: guest.id, event_id, status: 'paid' }
    });

    // 兼容老邀约链路：有邀约且已报名成功时，用邀约反查报名记录
    let invitation = null;
    if (!reg) {
      invitation = await Invitation.findOne({
        where: { guest_id: guest.id, event_id, is_valid: 1 }
      });
      if (!invitation) {
        return res.status(404).json({ code: 404, message: '未报名或手机号错误' });
      }
      // 必须报名成功才能签到
      if (invitation.registration_status !== 2) {
        return res.status(403).json({ code: 403, message: '未报名成功，不能签到' });
      }
      reg = await Registration.findOne({ where: { invitation_id: invitation.id } });
    }

    // 检查是否已签到（首次签到 vs 重复签到要区分，前端据此显示不同结果卡）
    // 自主报名没有邀约，所以优先按报名记录查
    let checkin = await Checkin.findOne({
      where: reg ? { registration_id: reg.id } : { invitation_id: invitation.id }
    });
    const already = !!checkin;

    if (!checkin) {
      const code = reg
        ? await CheckinCode.findOne({ where: { registration_id: reg.id } })
        : null;
      if (!reg || !code) {
        return res.status(400).json({
          code: 400,
          message: '该嘉宾没有签到码，请走签到码签到通道'
        });
      }

      // 创建签到记录（自主报名没有邀约，invitation_id 允许为 null）
      checkin = await Checkin.create({
        invitation_id: invitation ? invitation.id : null,
        registration_id: reg.id,
        checkin_code_id: code.id,
        event_id,
        guest_id: guest.id,
        checkin_time: new Date(),
        location,
        device_info,
        user_agent,
        ip_address
      });
      
      // 触发登记成功短信（忽略失败）
      try {
        const { SmsService, MESSAGE_TYPES } = require('../services/SmsService');
        await SmsService.sendMessage(MESSAGE_TYPES.CHECKIN_SUCCESS, { lang: SmsService.normalizeLang(req.body && req.body.lang),
          guestId: guest.id,
          eventId: event_id,
          invitationId: invitation ? invitation.id : undefined
        });
      } catch (e) {
        console.error('触发登记成功短信失败:', e);
      }
    }
    
    // 票种：EC9 的 Ticket 是票种表（无 invitation_id），只能按报名记录上的 ticket_type_id 取
    let ticket_info = null;
    if (reg && reg.ticket_type_id) {
      const { TicketType } = require('../models');
      const tt = await TicketType.findByPk(reg.ticket_type_id);
      if (tt) ticket_info = { ticket_name: tt.name };
    }
    
    res.json({
      code: 200,
      message: already ? '您已签到' : '签到成功',
      data: {
        status: already ? 'already' : 'checked_in',
        already,
        checkin,
        ticket: ticket_info,
        guest: { name: guest.name, company: guest.company }
      }
    });
  } catch (error) {
    console.error('[event-checkin] error:', error);
    res.status(500).json({
      code: 500,
      message: '签到失败',
      error: error.message
    });
  }
});

// 获取签到统计（需要认证）
router.get('/statistics', authenticate, operationLog('checkins', '获取签到统计'), async (req, res) => {
  try {
    const { event_id } = req.query;
    
    if (!event_id) {
      return res.status(400).json({
        code: 400,
        message: '活动ID不能为空'
      });
    }
    
    // BD用户只能统计自己负责的参会人员的签到情况
    const invitationWhere = req.user.role === 'bd' ? { source_bd: req.user.username } : {};
    
    const totalCheckins = await Checkin.count({
      where: { event_id },
      include: [
        {
          model: Invitation,
          as: 'invitation',
          where: invitationWhere,
          required: true
        }
      ],
      distinct: true
    });
    
    const shenzhenCheckins = await Checkin.count({
      where: { event_id, location_type: 1 },
      include: [
        {
          model: Invitation,
          as: 'invitation',
          where: invitationWhere,
          required: true
        }
      ],
      distinct: true
    });
    
    const shenzhenHongkongCheckins = await Checkin.count({
      where: { event_id, location_type: 2 },
      include: [
        {
          model: Invitation,
          as: 'invitation',
          where: invitationWhere,
          required: true
        }
      ],
      distinct: true
    });
    
    // 按地区分组统计
    const regionStats = await Checkin.findAll({
      attributes: [
        'location_type',
        [require('sequelize').fn('COUNT', require('sequelize').col('Checkin.id')), 'count']
      ],
      where: { event_id },
      include: [
        {
          model: Invitation,
          as: 'invitation',
          where: invitationWhere,
          required: true,
          attributes: []
        }
      ],
      group: ['location_type'],
      raw: true
    });
    
    res.json({
      code: 200,
      message: '获取成功',
      data: {
        total: totalCheckins,
        shenzhen: shenzhenCheckins,
        shenzhenHongkong: shenzhenHongkongCheckins,
        regionStats
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

module.exports = router;


