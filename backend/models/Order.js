const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/** 订单状态机：pending_payment → paid；分支：closed 关单 / refunded 退款 */
const ORDER_STATUS = {
  PENDING_PAYMENT: 'pending_payment',
  PAID: 'paid',
  CLOSED: 'closed',
  REFUNDED: 'refunded'
};

const Order = sequelize.define('Order', {
  order_no: { type: DataTypes.STRING(64), allowNull: false, comment: '商户订单号' },
  registration_id: { type: DataTypes.INTEGER, allowNull: false },
  guest_id: { type: DataTypes.INTEGER, allowNull: false },
  event_id: { type: DataTypes.INTEGER, allowNull: false },
  session_id: { type: DataTypes.INTEGER, defaultValue: 0 },
  ticket_type_id: { type: DataTypes.INTEGER, defaultValue: 0 },
  quantity: { type: DataTypes.INTEGER, defaultValue: 1 },
  unit_price: { type: DataTypes.DECIMAL(10, 2), allowNull: false, comment: '锁定价' },
  total_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  coupon_id: { type: DataTypes.INTEGER, comment: '预留：优惠券 ID' },
  discount_amount: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0.00, comment: '预留：优惠金额' },
  final_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  status: { type: DataTypes.STRING(20), defaultValue: 'pending_payment' },
  expire_at: DataTypes.DATE,
  paid_at: DataTypes.DATE,
  closed_at: DataTypes.DATE,
  refunded_at: DataTypes.DATE,
  remark: DataTypes.STRING(500),
  // 多人代报订单：group_no 关联整单；price_detail 存每张票明细
  group_no: DataTypes.STRING(40),
  price_detail: DataTypes.JSON,
  discount_rate: { type: DataTypes.DECIMAL(4, 2), defaultValue: 1.00 },
  pay_token: { type: DataTypes.STRING(64), comment: '短信付款链接免登录凭证（不可枚举随机串）' }
}, {
  tableName: 'ec9_orders',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = { Order, ORDER_STATUS };
