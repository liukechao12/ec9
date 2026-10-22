const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const TicketType = sequelize.define('TicketType', {
  event_id: { type: DataTypes.INTEGER, allowNull: false },
  session_id: { type: DataTypes.INTEGER, defaultValue: 0, comment: '0=全部场次通用' },
  name: { type: DataTypes.STRING(200), allowNull: false, comment: '票种名称（简体，基准字段）' },
  i18n: { type: DataTypes.JSON, comment: '多语结构化存储：{name:{zh-CN,zh-TW,en},description:{…}}' },
  description: DataTypes.STRING(500),
  price: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0.00 },
  original_price: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
  stock_total: { type: DataTypes.INTEGER, defaultValue: 0 },
  stock_locked: { type: DataTypes.INTEGER, defaultValue: 0 },
  stock_sold: { type: DataTypes.INTEGER, defaultValue: 0 },
  per_order_limit: { type: DataTypes.INTEGER, defaultValue: 1 },
  on_shelf: { type: DataTypes.TINYINT, defaultValue: 1 },
  // 学生票：¥0 购买，入场时现场核验学生证/学籍（不线上上传）
  is_student: { type: DataTypes.TINYINT, defaultValue: 0, comment: '1=学生票（现场核验学籍）' },
  product_type: { type: DataTypes.STRING(20), defaultValue: 'ticket', comment: '预留：ticket / merch' },
  coupon_enabled: { type: DataTypes.TINYINT, defaultValue: 0, comment: '预留：是否可用券' },
  sort: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 }
}, {
  tableName: 'ec9_ticket_types',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = TicketType;
