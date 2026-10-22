const express = require('express');
const router = express.Router();
const {
  Event, Invitation, Registration, Checkin, Guest, CheckinCode,
  Order, ORDER_STATUS, TicketType, fn, col
} = require('../models');
const { Op } = require('sequelize');
const { Sequelize } = require('sequelize');
const { sequelize } = require('../models');
const { authenticate } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');

// 获取活动统计概览（需要认证）
router.get('/events/:id/overview', authenticate, operationLog('statistics', '获取活动统计概览'), async (req, res) => {
  try {
    const eventId = req.params.id;
    
    const event = await Event.findByPk(eventId);
    if (!event) {
      return res.status(404).json({
        code: 404,
        message: '活动不存在'
      });
    }
    
    // 邀约统计
    const totalInvitations = await Invitation.count({
      where: { event_id: eventId, is_valid: 1 }
    });
    
    // 报名统计
    const totalRegistrations = await Registration.count({
      where: { event_id: eventId }
    });
    
    // 签到统计
    const totalCheckins = await Checkin.count({
      where: { event_id: eventId }
    });
    
    // 按地区统计签到
    const shenzhenCheckins = await Checkin.count({
      where: { event_id: eventId, location_type: 1 }
    });
    
    const shenzhenHongkongCheckins = await Checkin.count({
      where: { event_id: eventId, location_type: 2 }
    });
    
    // 报名率
    const registrationRate = totalInvitations > 0 
      ? ((totalRegistrations / totalInvitations) * 100).toFixed(2) 
      : '0.00';
    
    // 签到率
    const checkinRate = totalRegistrations > 0 
      ? ((totalCheckins / totalRegistrations) * 100).toFixed(2) 
      : '0.00';
    
    res.json({
      code: 200,
      message: '获取成功',
      data: {
        event: {
          id: event.id,
          name: event.name,
          start_time: event.start_time,
          end_time: event.end_time,
          location: event.location
        },
        invitations: {
          total: totalInvitations
        },
        registrations: {
          total: totalRegistrations,
          rate: registrationRate + '%'
        },
        checkins: {
          total: totalCheckins,
          rate: checkinRate + '%',
          byLocation: {
            shenzhen: shenzhenCheckins,
            shenzhenHongkong: shenzhenHongkongCheckins
          }
        }
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

// 获取报名趋势（按时间，需要认证）
router.get('/events/:id/registration-trend', authenticate, operationLog('statistics', '获取报名趋势'), async (req, res) => {
  try {
    const eventId = req.params.id;
    const { startDate, endDate } = req.query;
    
    const where = { event_id: eventId };
    if (startDate) {
      where.registration_time = { [Op.gte]: new Date(startDate) };
    }
    if (endDate) {
      where.registration_time = { 
        ...where.registration_time,
        [Op.lte]: new Date(endDate)
      };
    }
    
    const registrations = await Registration.findAll({
      where,
      attributes: [
        [Sequelize.fn('DATE', Sequelize.col('registration_time')), 'date'],
        [Sequelize.fn('COUNT', Sequelize.col('id')), 'count']
      ],
      group: [Sequelize.fn('DATE', Sequelize.col('registration_time'))],
      order: [[Sequelize.fn('DATE', Sequelize.col('registration_time')), 'ASC']]
    });
    
    res.json({
      code: 200,
      message: '获取成功',
      data: registrations
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// 获取签到趋势（按时间，需要认证）
router.get('/events/:id/checkin-trend', authenticate, operationLog('statistics', '获取签到趋势'), async (req, res) => {
  try {
    const eventId = req.params.id;
    const { startDate, endDate } = req.query;
    
    const where = { event_id: eventId };
    if (startDate) {
      where.checkin_time = { [Op.gte]: new Date(startDate) };
    }
    if (endDate) {
      where.checkin_time = { 
        ...where.checkin_time,
        [Op.lte]: new Date(endDate)
      };
    }
    
    const checkins = await Checkin.findAll({
      where,
      attributes: [
        [Sequelize.fn('DATE', Sequelize.col('checkin_time')), 'date'],
        [Sequelize.fn('COUNT', Sequelize.col('id')), 'count']
      ],
      group: [Sequelize.fn('DATE', Sequelize.col('checkin_time'))],
      order: [[Sequelize.fn('DATE', Sequelize.col('checkin_time')), 'ASC']]
    });
    
    res.json({
      code: 200,
      message: '获取成功',
      data: checkins
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// 获取来源BD统计（需要认证）
router.get('/events/:id/bd-statistics', authenticate, operationLog('statistics', '获取BD统计'), async (req, res) => {
  try {
    const eventId = req.params.id;
    
    const bdStats = await Invitation.findAll({
      where: { event_id: eventId, is_valid: 1 },
      attributes: [
        'source_bd',
        [Sequelize.fn('COUNT', Sequelize.col('id')), 'invitation_count'],
        [Sequelize.fn('SUM', Sequelize.literal('CASE WHEN registration_status = 1 THEN 1 ELSE 0 END')), 'registration_count']
      ],
      group: ['source_bd'],
      order: [[Sequelize.fn('COUNT', Sequelize.col('id')), 'DESC']]
    });
    
    res.json({
      code: 200,
      message: '获取成功',
      data: bdStats
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// 获取公司统计（需要认证）
router.get('/events/:id/company-statistics', authenticate, operationLog('statistics', '获取公司统计'), async (req, res) => {
  try {
    const eventId = req.params.id;
    
    // 直接用 SQL：Sequelize 的 include + group 组合在 PG 下会生成
    // 「missing FROM-clause entry for table invitations」，手写更稳
    const companyStats = await sequelize.query(
      `SELECT g.company AS company,
              COUNT(i.id)::int AS guest_count
         FROM ec9_guests g
         JOIN ec9_invitations i ON i.guest_id = g.id
        WHERE i.event_id = :eventId
          AND i.is_valid = 1
          AND COALESCE(g.company, '') <> ''
        GROUP BY g.company
        ORDER BY guest_count DESC
        LIMIT 20`,
      { replacements: { eventId }, type: require('sequelize').QueryTypes.SELECT }
    );
    
    res.json({
      code: 200,
      message: '获取成功',
      data: companyStats
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// 获取控制台总览统计（需要认证）
router.get('/dashboard', authenticate, operationLog('statistics', '获取控制台统计'), async (req, res) => {
  try {
    // 计算本月开始时间
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    monthStart.setHours(0, 0, 0, 0);
    
    // 计算本周开始时间（周一）
    const weekStart = new Date(now);
    const dayOfWeek = now.getDay();
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    weekStart.setDate(now.getDate() - daysToMonday);
    weekStart.setHours(0, 0, 0, 0);
    
    // 活动统计
    const totalEvents = await Event.count({
      where: { status: { [Op.ne]: 0 } } // 排除已删除的活动
    });
    const newEventsThisMonth = await Event.count({
      where: {
        created_at: { [Op.gte]: monthStart },
        status: { [Op.ne]: 0 }
      }
    });
    
    // 嘉宾统计
    const totalGuests = await Guest.count({
      where: { status: 1 } // 只统计有效的
    });
    const newGuestsThisMonth = await Guest.count({
      where: {
        created_at: { [Op.gte]: monthStart },
        status: 1
      }
    });
    
    // 邀约统计
    const totalInvitations = await Invitation.count({
      where: { is_valid: 1 }
    });
    const newInvitationsThisMonth = await Invitation.count({
      where: {
        created_at: { [Op.gte]: monthStart },
        is_valid: 1
      }
    });
    
    // 签到统计
    const totalCheckins = await Checkin.count();
    const newCheckinsThisWeek = await Checkin.count({
      where: {
        checkin_time: { [Op.gte]: weekStart }
      }
    });
    
    res.json({
      code: 200,
      message: '获取成功',
      data: {
        events: {
          total: totalEvents,
          newThisMonth: newEventsThisMonth
        },
        guests: {
          total: totalGuests,
          newThisMonth: newGuestsThisMonth
        },
        invitations: {
          total: totalInvitations,
          newThisMonth: newInvitationsThisMonth
        },
        checkins: {
          total: totalCheckins,
          newThisWeek: newCheckinsThisWeek
        }
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

// 获取按天统计的报名数据（日历格式，需要认证）
router.get('/daily-registrations', authenticate, operationLog('statistics', '获取按天报名统计'), async (req, res) => {
  try {
    const { event_id, year, month } = req.query;
    
    // 如果没有指定年月，使用当前年月
    const now = new Date();
    const targetYear = year ? parseInt(year) : now.getFullYear();
    const targetMonth = month ? parseInt(month) : now.getMonth() + 1;
    
    // 计算该月的开始和结束时间
    const startDate = new Date(targetYear, targetMonth - 1, 1);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(targetYear, targetMonth, 0, 23, 59, 59, 999);
    
    // 构建查询条件
    const where = {
      registration_time: {
        [Op.between]: [startDate, endDate]
      }
    };
    
    // 如果指定了活动ID，添加活动筛选
    if (event_id) {
      where.event_id = parseInt(event_id);
    }
    
    // 按天和活动ID统计报名人数
    const dailyStats = await Registration.findAll({
      where,
      attributes: [
        [Sequelize.fn('DATE', Sequelize.col('registration_time')), 'date'],
        'event_id',
        [Sequelize.fn('COUNT', Sequelize.col('id')), 'count']
      ],
      group: [
        Sequelize.fn('DATE', Sequelize.col('registration_time')),
        'event_id'
      ],
      order: [
        [Sequelize.fn('DATE', Sequelize.col('registration_time')), 'ASC'],
        ['event_id', 'ASC']
      ],
      raw: true
    });
    
    // 获取所有活动信息
    const events = await Event.findAll({
      where: { status: { [Op.ne]: 0 } },
      attributes: ['id', 'name'],
      order: [['id', 'ASC']]
    });
    
    // 将活动信息转换为Map
    const eventMap = {};
    events.forEach(event => {
      eventMap[event.id] = event.name;
    });
    
    // 按日期组织数据
    const dateEventMap = {};
    dailyStats.forEach(stat => {
      const dateStr = stat.date instanceof Date 
        ? stat.date.toISOString().split('T')[0] 
        : stat.date;
      const eventId = stat.event_id;
      
      if (!dateEventMap[dateStr]) {
        dateEventMap[dateStr] = {};
      }
      dateEventMap[dateStr][eventId] = parseInt(stat.count);
    });
    
    // 计算该月的所有日期
    const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
    const calendarData = [];
    
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(targetYear, targetMonth - 1, day);
      const dateStr = date.toISOString().split('T')[0];
      const dayOfWeek = date.getDay(); // 0 = 周日, 1 = 周一, ...
      
      // 获取该日期各活动的报名数据
      const eventCounts = dateEventMap[dateStr] || {};
      const eventData = events.map(event => ({
        eventId: event.id,
        eventName: event.name,
        count: eventCounts[event.id] || 0
      }));
      
      // 计算该日期总报名数
      const totalCount = Object.values(eventCounts).reduce((sum, count) => sum + count, 0);
      
      calendarData.push({
        date: dateStr,
        day: day,
        dayOfWeek: dayOfWeek,
        totalCount: totalCount,
        events: eventData
      });
    }
    
    // 计算月度总计
    const monthlyTotal = dailyStats.reduce((sum, stat) => sum + parseInt(stat.count), 0);
    
    res.json({
      code: 200,
      message: '获取成功',
      data: {
        year: targetYear,
        month: targetMonth,
        calendar: calendarData,
        total: monthlyTotal,
        events: events.map(e => ({ id: e.id, name: e.name }))
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

/**
 * ==================== EC9 新增：营收 / 订单 / 票种售卖统计 ====================
 * EC8 没有支付，故这些统计是 EC9 独有的。
 */

/**
 * GET /api/statistics/revenue?event_id=&start=&end=
 * 营收总览：订单数、实收、订单状态分布、按日营收趋势
 */
router.get('/revenue', authenticate, async (req, res) => {
  try {
    const { event_id, start, end } = req.query;
    const baseWhere = {};
    if (event_id) baseWhere.event_id = event_id;
    if (start || end) {
      const range = {};
      if (start) range[Op.gte] = new Date(start);
      if (end) range[Op.lte] = new Date(end);
      baseWhere.paid_at = range;
    }

    // 订单状态分布 + 各状态金额
    const byStatus = await Order.findAll({
      where: baseWhere,
      attributes: [
        'status',
        [fn('COUNT', col('id')), 'cnt'],
        [fn('SUM', col('quantity')), 'qty'],
        [fn('COALESCE', fn('SUM', col('final_amount')), 0), 'amount']
      ],
      group: ['status'],
      raw: true
    });

    const statusMap = {};
    byStatus.forEach(r => {
      statusMap[r.status] = {
        count: Number(r.cnt || 0),
        quantity: Number(r.qty || 0),
        amount: Number(r.amount || 0)
      };
    });

    const paid = statusMap[ORDER_STATUS.PAID] || { count: 0, quantity: 0, amount: 0 };
    const refunded = statusMap[ORDER_STATUS.REFUNDED] || { count: 0, quantity: 0, amount: 0 };

    // 按日营收趋势（只统计已支付）
    const trendWhere = Object.assign({}, baseWhere, { status: ORDER_STATUS.PAID });
    const trendRows = await Order.findAll({
      where: trendWhere,
      attributes: [
        [fn('TO_CHAR', col('paid_at'), 'YYYY-MM-DD'), 'day'],
        [fn('COUNT', col('id')), 'cnt'],
        [fn('COALESCE', fn('SUM', col('final_amount')), 0), 'amount']
      ],
      group: [fn('TO_CHAR', col('paid_at'), 'YYYY-MM-DD')],
      order: [[fn('TO_CHAR', col('paid_at'), 'YYYY-MM-DD'), 'ASC']],
      raw: true
    });

    res.json({
      code: 0,
      message: 'ok',
      data: {
        by_status: statusMap,
        paid_orders: paid.count,
        paid_quantity: paid.quantity,
        paid_revenue: paid.amount,
        refunded_orders: refunded.count,
        refunded_amount: refunded.amount,
        net_revenue: Number((paid.amount - refunded.amount).toFixed(2)),
        avg_order_value: paid.count > 0 ? Number((paid.amount / paid.count).toFixed(2)) : 0,
        trend: trendRows.map(r => ({
          day: r.day, count: Number(r.cnt), amount: Number(r.amount)
        }))
      }
    });
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message });
  }
});

/**
 * GET /api/statistics/ticket-sales?event_id=
 * 票种售卖：每个票种的总库存 / 已售 / 锁定 / 可售 / 售出金额
 */
router.get('/ticket-sales', authenticate, async (req, res) => {
  try {
    const { event_id } = req.query;
    const where = {};
    if (event_id) where.event_id = event_id;

    const tickets = await TicketType.findAll({ where, order: [['sort', 'ASC'], ['id', 'ASC']] });
    if (!tickets.length) {
      return res.json({ code: 0, message: 'ok', data: { list: [], total_revenue: 0, total_sold: 0 } });
    }

    const ids = tickets.map(t => t.id);

    // 已支付订单按票种聚合
    const paidRows = await Order.findAll({
      where: { ticket_type_id: { [Op.in]: ids }, status: ORDER_STATUS.PAID },
      attributes: [
        'ticket_type_id',
        [fn('COUNT', col('id')), 'orders'],
        [fn('COALESCE', fn('SUM', col('quantity')), 0), 'qty'],
        [fn('COALESCE', fn('SUM', col('final_amount')), 0), 'amount']
      ],
      group: ['ticket_type_id'],
      raw: true
    });
    const pMap = {};
    paidRows.forEach(r => {
      pMap[r.ticket_type_id] = {
        orders: Number(r.orders || 0),
        quantity: Number(r.qty || 0),
        amount: Number(r.amount || 0)
      };
    });

    // 待付款（已锁库存未成交）
    const pendingRows = await Order.findAll({
      where: { ticket_type_id: { [Op.in]: ids }, status: ORDER_STATUS.PENDING_PAYMENT },
      attributes: [
        'ticket_type_id',
        [fn('COALESCE', fn('SUM', col('quantity')), 0), 'qty']
      ],
      group: ['ticket_type_id'],
      raw: true
    });
    const pendMap = {};
    pendingRows.forEach(r => { pendMap[r.ticket_type_id] = Number(r.qty || 0); });

    const list = tickets.map(t => {
      const sold = pMap[t.id] || { orders: 0, quantity: 0, amount: 0 };
      const total = Number(t.stock_total || 0);
      return {
        id: t.id,
        name: t.name,
        session_id: t.session_id,
        price: Number(t.price),
        original_price: t.original_price === null ? null : Number(t.original_price),
        on_shelf: t.on_shelf,
        stock_total: total,
        stock_locked: Number(t.stock_locked || 0),
        stock_sold: Number(t.stock_sold || 0),
        stock_available: total - Number(t.stock_locked || 0) - Number(t.stock_sold || 0),
        paid_orders: sold.orders,
        paid_quantity: sold.quantity,
        revenue: sold.amount,
        pending_quantity: pendMap[t.id] || 0,
        sell_through_rate: total > 0 ? Number(((Number(t.stock_sold || 0) / total) * 100).toFixed(2)) : 0
      };
    });

    res.json({
      code: 0, message: 'ok',
      data: {
        list,
        total_revenue: Number(list.reduce((s, x) => s + x.revenue, 0).toFixed(2)),
        total_sold: list.reduce((s, x) => s + x.stock_sold, 0),
        total_stock: list.reduce((s, x) => s + x.stock_total, 0)
      }
    });
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message });
  }
});

/**
 * GET /api/statistics/registration-funnel?event_id=
 * 报名漏斗：提交 → 通过审核 → 已付 → 已签到
 */
router.get('/registration-funnel', authenticate, async (req, res) => {
  try {
    const { event_id } = req.query;
    const rWhere = {};
    if (event_id) rWhere.event_id = event_id;

    const total = await Registration.count({ where: rWhere });
    const byStatus = await Registration.findAll({
      where: rWhere,
      attributes: ['status', [fn('COUNT', col('id')), 'cnt']],
      group: ['status'],
      raw: true
    });
    const sMap = {};
    byStatus.forEach(r => { sMap[r.status] = Number(r.cnt || 0); });

    let checkinWhere = {};
    if (event_id) checkinWhere.event_id = event_id;
    const checkedIn = await Checkin.count({ where: checkinWhere });

    // 各环节转化率
    const submitted = total || 0;
    const approved = (sMap.approved || 0) + (sMap.paid || 0);
    const paid = sMap.paid || 0;
    const pct = (a, b) => (b > 0 ? Number(((a / b) * 100).toFixed(2)) : 0);

    res.json({
      code: 0, message: 'ok',
      data: {
        total: submitted,
        by_status: sMap,
        steps: [
          { key: 'submitted', label: '提交报名', count: submitted },
          { key: 'approved', label: '审核通过', count: approved, rate_of_prev: pct(approved, submitted) },
          { key: 'paid', label: '已付款', count: paid, rate_of_prev: pct(paid, approved) },
          { key: 'checkin', label: '已签到', count: checkedIn, rate_of_prev: pct(checkedIn, paid || submitted) }
        ]
      }
    });
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message });
  }
});

module.exports = router;

