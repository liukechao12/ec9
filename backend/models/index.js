/**
 * EC9 模型汇总
 */
const { DataTypes, Op, Sequelize } = require('sequelize');
const Admin = require('./Admin');
const Event = require('./Event');
const Session = require('./Session');
const TicketType = require('./TicketType');
const Guest = require('./Guest');
const Invitation = require('./Invitation');
const { Registration, REG_STATUS } = require('./Registration');
const { Order, ORDER_STATUS } = require('./Order');
const Payment = require('./Payment');
const Approval = require('./Approval');
const AutoAuditRule = require('./AutoAuditRule');
const CheckinCode = require('./CheckinCode');
const Checkin = require('./Checkin');
const SmsProvider = require('./SmsProvider');
const SmsTemplate = require('./SmsTemplate');
const SmsLog = require('./SmsLog');
const VerificationCode = require('./VerificationCode');
const VerificationToken = require('./VerificationToken');
const OperationLog = require('./OperationLog');
const LegalDoc = require('./LegalDoc');
const PaymentConfig = require('./PaymentConfig');

// 关联定义（放在最后，避免循环依赖）
require('./associations');

module.exports = {
  // Sequelize 工具（EC8 后台代码大量使用 Op.in / Op.like / Sequelize.Op）
  Op, Sequelize, DataTypes,
  // 聚合函数（新模块做统计时需要 fn('COUNT', col('id')) 这类用法）
  fn: Sequelize.fn,
  col: Sequelize.col,
  literal: Sequelize.literal,
  where: Sequelize.where,

  sequelize: require('../config/database').sequelize,
  Admin, Event, Session, TicketType, Guest, Invitation,
  Registration, REG_STATUS,
  Order, ORDER_STATUS,
  Payment, Approval, AutoAuditRule,
  CheckinCode, Checkin,
  SmsProvider, SmsTemplate, SmsLog,
  VerificationCode, VerificationToken,
  OperationLog, LegalDoc, PaymentConfig,

  // ==================== EC8 兼容别名 ====================
  // EC8 后台用 Ticket（门票）；EC9 升级为 TicketType（票种+场次+库存），
  // 此处别名让从 EC8 搬来的路由/前端代码无需改动即可跑通。
  // ⚠️ 语义差异：EC9 的订单锁定在 Order 上，TicketType 只提供票种与库存数据。
  Ticket: TicketType,
  // EC8 的 SmsRule（短信定时规则）→ EC9 由 AutoAuditRule + SmsProvider 承担
  SmsRule: AutoAuditRule
};
