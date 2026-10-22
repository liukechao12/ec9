/**
 * EC9 种子数据 / 演示数据
 * 用法：cd backend && node ../database/seed.js
 * 幂等：已存在则跳过（按唯一键判断）
 */
const bcrypt = require('bcryptjs');

(async () => {
  const { sequelize, testConnection } = require('../config/database');
  const models = require('../models');
  const { Admin, Event, Session, TicketType, Guest, Invitation, Registration, Order,
    AutoAuditRule, SmsTemplate } = models;

  await testConnection();

  // ===== 1. 账号 =====
  const admins = [
    { username: 'admin', name: '系统管理员', role: 'admin' },
    { username: 'bd001', name: '张商务', role: 'bd' },
    { username: 'bd002', name: '李商务', role: 'bd' },
    { username: 'bd003', name: '王商务', role: 'bd' }
  ];
  for (const a of admins) {
    const [row, created] = await Admin.findOrCreate({
      where: { username: a.username },
      defaults: { ...a, password: bcrypt.hashSync(a.username + '123', 10) }
    });
    console.log(`${created ? '创建' : '跳过'} 账号 ${a.username}（${a.role}）`);
  }

  // ===== 2. 演示会议（i18n 结构化三语） =====
  const [event, eventCreated] = await Event.findOrCreate({
    where: { name: 'EC9 产品发布会' },
    defaults: {
      name: 'EC9 产品发布会',
      description: '年度产品发布与合作伙伴大会',
      location: '北京国家会议中心',
      address: '北京市朝阳区天辰东路7号',
      start_time: new Date('2026-11-06 09:30:00'),
      end_time: new Date('2026-11-06 18:00:00'),
      signup_start_time: new Date('2026-10-20 00:00:00'),
      signup_end_time: new Date('2026-11-05 23:59:00'),
      status: 1,
      audit_mode: 'hybrid',
      pay_expire_hours: 48,
      i18n: {
        name: {
          'zh-CN': 'EC9 产品发布会',
          'zh-TW': 'EC9 產品發佈會',
          'en': 'EC9 Product Launch Event'
        },
        description: {
          'zh-CN': '年度产品发布与合作伙伴大会',
          'zh-TW': '年度產品發佈與合作伙伴大會',
          'en': 'Annual Product Launch & Partner Conference'
        },
        location: {
          'zh-CN': '北京国家会议中心',
          'zh-TW': '北京國家會議中心',
          'en': 'China National Convention Center, Beijing'
        }
      }
    }
  });
  console.log(`${eventCreated ? '创建' : '跳过'} 会议「${event.name}」(id=${event.id})`);

  // ===== 3. 场次 =====
  const sessions = [
    { event_id: event.id, name: '上午主论坛', location: '一层宴会厅 A', stock_total: 200,
      start_time: new Date('2026-11-06 09:30:00'), end_time: new Date('2026-11-06 12:00:00'),
      i18n: { name: { 'zh-CN': '上午主论坛', 'zh-TW': '上午主轴壇', 'en': 'Morning Keynotes' } } },
    { event_id: event.id, name: '下午分论坛', location: '二层会议厅 B', stock_total: 150,
      start_time: new Date('2026-11-06 14:00:00'), end_time: new Date('2026-11-06 17:30:00'),
      i18n: { name: { 'zh-CN': '下午分论坛', 'zh-TW': '下午分軸壇', 'en': 'Afternoon Breakouts' } } }
  ];
  for (const s of sessions) {
    const [row, created] = await Session.findOrCreate({
      where: { event_id: s.event_id, name: s.name }, defaults: s
    });
    console.log(`${created ? '创建' : '跳过'} 场次「${s.name}」(id=${row.id})`);
  }

  // ===== 4. 票种 =====
  const tickets = [
    { event_id: event.id, session_id: 0, name: '免费票', price: 0.00, stock_total: 300, per_order_limit: 2,
      description: '标准参会席位',
      i18n: { name: { 'zh-CN': '免费票', 'zh-TW': '免費票', 'en': 'Free Pass' },
              description: { 'zh-CN': '标准参会席位', 'zh-TW': '標準參會席位', 'en': 'Standard attendee seat' } } },
    { event_id: event.id, session_id: 0, name: '标准票', price: 399.00, original_price: 599.00, stock_total: 100, per_order_limit: 3,
      description: '含午餐与资料礼包',
      i18n: { name: { 'zh-CN': '标准票', 'zh-TW': '標準票', 'en': 'Standard Ticket' },
              description: { 'zh-CN': '含午餐与资料礼包', 'zh-TW': '含午餐與資料禮包', 'en': 'Includes lunch and materials pack' } } },
    { event_id: event.id, session_id: 0, name: 'VIP 票', price: 1299.00, original_price: 1599.00, stock_total: 30, per_order_limit: 1,
      description: '前排席位 + 晚宴 + 专属接待',
      i18n: { name: { 'zh-CN': 'VIP 票', 'zh-TW': 'VIP 票', 'en': 'VIP Ticket' },
              description: { 'zh-CN': '前排席位 + 晚宴 + 专属接待', 'zh-TW': '前排席位 + 晚宴 + 專屬接待', 'en': 'Front-row seat + gala dinner + dedicated host' } } }
  ];
  for (const t of tickets) {
    const [row, created] = await TicketType.findOrCreate({
      where: { event_id: t.event_id, name: t.name }, defaults: t
    });
    console.log(`${created ? '创建' : '跳过'} 票种「${t.name}」¥${t.price} (id=${row.id})`);
  }

  // ===== 5. 短信模板（一语种一条；en/zh-TW 占位禁用，未报备自动回退中文） =====
  const templateDefs = [
    ['verification', 'default', '您的验证码是{{code}}，5分钟内有效，请勿泄露。', 'SMS_VERIFY_CODE'],
    ['audit_result', 'approved', '恭喜，您的报名已通过审核。{{detail}}', 'SMS_AUDIT_PASS'],
    ['audit_result', 'rejected', '很抱歉，您的报名未通过审核。原因：{{reason}}。可修改后重新提交。', 'SMS_AUDIT_REJECT'],
    ['payment_link', 'default', '您的报名已通过审核，请点击链接完成付款：{{pay_url}}（{{hours}}小时内有效）', 'SMS_PAY_LINK'],
    ['payment_success', 'default', '付款成功，您的参会门票已生成，签到码：{{checkin_code}}', 'SMS_PAY_SUCCESS'],
    ['checkin_reminder', 'default', '温馨提示：{{event_name}} 将于 {{start_time}} 开始，请携带签到码准时参会。', 'SMS_CHECKIN_REMIND']
  ];
  for (const [messageType, scene, content, codeHint] of templateDefs) {
    for (const lang of ['zh-CN', 'en', 'zh-TW']) {
      const [row, created] = await SmsTemplate.findOrCreate({
        where: { message_type: messageType, scene, lang },
        defaults: {
          message_type: messageType, scene, lang,
          content,
          template_code: lang === 'zh-CN' ? codeHint : `SMS_PENDING_${lang === 'en' ? 'EN' : 'ZHTW'}`,
          enabled: lang === 'zh-CN' ? 1 : 0
        }
      });
      if (created) console.log(`创建模板 ${messageType}/${scene}/${lang}`);
    }
  }

  // ===== 6. 自动审核规则示例 =====
  const [rule, ruleCreated] = await AutoAuditRule.findOrCreate({
    where: { event_id: event.id, name: 'BD 邀约的免费票自动通过' },
    defaults: {
      event_id: event.id,
      name: 'BD 邀约的免费票自动通过',
      conditions: { all: [
        { field: 'source', op: 'in', value: ['bd_invite'] },
        { field: 'paid', op: 'eq', value: false }
      ] },
      enabled: 1,
      priority: 10
    }
  });
  console.log(`${ruleCreated ? '创建' : '跳过'} 自动审核规则「${rule.name}」`);

  // ===== 7. 演示嘉宾 + 各状态报名样本 =====
  const { encryptPhone, hmacPhone } = require('../utils/phoneCrypto');
  const demoGuests = [
    { name: '陈嘉宾', phone: '13501010101', company: '示例科技', position: 'CTO', source: 'web' },
    { name: '刘来宾', phone: '13501010102', company: '示例集团', position: '总监', source: 'bd_invite', bd_id: 'bd001' },
    { name: '赵参会', phone: '13501010103', company: '示例传媒', position: '经理', source: 'bd_invite', bd_id: 'bd002' },
    { name: '王付款', phone: '13501010104', company: '示例互娱', position: '总经理', source: 'web' }
  ];
  for (const g of demoGuests) {
    const hmac = hmacPhone(g.phone);
    const [row, created] = await Guest.findOrCreate({
      where: { phone_hmac: hmac },
      defaults: { ...g, phone: encryptPhone(g.phone), phone_hmac: hmac }
    });
    console.log(`${created ? '创建' : '跳过'} 嘉宾「${g.name}」(id=${row.id})`);
  }

  const [guestA] = await Guest.findAll({ where: { phone_hmac: hmacPhone('13501010101') } });
  const [guestB] = await Guest.findAll({ where: { phone_hmac: hmacPhone('13501010102') } });
  const [guestD] = await Guest.findAll({ where: { phone_hmac: hmacPhone('13501010104') } });
  const [ticketFree] = await TicketType.findAll({ where: { event_id: event.id, name: '免费票' } });
  const [ticketStd] = await TicketType.findAll({ where: { event_id: event.id, name: '标准票' } });
  const [sessionAM] = await Session.findAll({ where: { event_id: event.id, name: '上午主论坛' } });

  const regSamples = [
    { guest: guestA, ticket: ticketFree, session: sessionAM, status: 'approved', form_data: { company: '示例科技', position: 'CTO' } },
    { guest: guestB, ticket: ticketStd, session: sessionAM, status: 'pending_audit', form_data: { company: '示例集团', position: '总监' } },
    { guest: guestD, ticket: ticketStd, session: sessionAM, status: 'approved', form_data: { company: '示例互娱', position: '总经理' } }
  ];
  for (const s of regSamples) {
    if (!s.guest || !s.ticket) continue;
    const [row, created] = await Registration.findOrCreate({
      where: { guest_id: s.guest.id, event_id: event.id },
      defaults: {
        event_id: event.id,
        session_id: s.session ? s.session.id : 0,
        ticket_type_id: s.ticket.id,
        guest_id: s.guest.id,
        status: s.status,
        form_data: s.form_data,
        submitted_at: new Date(),
        audited_at: s.status === 'approved' ? new Date() : null,
        source_bd: s.guest.bd_id || null
      }
    });
    console.log(`${created ? '创建' : '跳过'} 报名样本 status=${s.status} (id=${row.id})`);
  }

  // ===== 7.5 邀约样本（后台「邀约管理」要看得到东西，且 H5 报名入口依赖它）=====
  // ⚠️ 之前漏了这段：报名样本是「凭空造的报名记录」，邀约表一直是空的。
  //    结果：后台邀约管理打开是空表，H5 的 /by-phone 路径也没有可用邀约码。
  const inviteSamples = [
    { guest: guestA, code: 'DEMO-INV-A1', bd: null, status: 1 },
    { guest: guestB, code: 'DEMO-INV-B2', bd: null, status: 1 },
    { guest: guestD, code: 'DEMO-INV-D4', bd: null, status: 1 }
  ];
  for (const s of inviteSamples) {
    if (!s.guest) continue;
    const [row, created] = await Invitation.findOrCreate({
      where: { guest_id: s.guest.id, event_id: event.id },
      defaults: {
        event_id: event.id,
        guest_id: s.guest.id,
        invite_code: s.code,
        source_bd: s.bd,
        // 1=待审批 2=已接受 0=待回复，与 registrations 的 EC8 语义一致
        registration_status: s.status,
        is_valid: 1,
        created_at: new Date()
      }
    });
    console.log(`${created ? '创建' : '跳过'} 邀约样本 ${s.code} (id=${row.id})`);
  }

  // ===== 8. 演示订单（审核通过 → 建单锁库存；免费票 0 元 + 标准票 399 待付款）=====
  const orderService = require('../services/orderService');
  const approvedRegs = await Registration.findAll({
    where: { event_id: event.id, status: 'approved' }
  });
  for (const reg of approvedRegs) {
    const existing = await Order.findOne({ where: { registration_id: reg.id } });
    if (existing) { console.log(`跳过订单（已存在）: ${existing.order_no}`); continue; }
    const r = await orderService.createOrder(reg.id, { quantity: 1 });
    if (r.ok) {
      console.log(`创建订单 ${r.order.order_no} 金额 ¥${r.order.final_amount} 状态 ${r.order.status}`);
    } else {
      console.log(`建单失败(reg=${reg.id}): ${r.error}`);
    }
  }

  console.log('\nSEED_DONE');
  await sequelize.close();
  process.exit(0);
})().catch(e => { console.error('SEED_FAILED:', e); process.exit(1); });
