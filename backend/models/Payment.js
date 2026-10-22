const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Payment = sequelize.define('Payment', {
  order_id: { type: DataTypes.INTEGER, allowNull: false },
  channel: { type: DataTypes.STRING(20), defaultValue: 'wechat' },
  out_trade_no: { type: DataTypes.STRING(64), allowNull: false },
  transaction_id: DataTypes.STRING(64),
  prepay_id: DataTypes.STRING(128),
  amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  status: { type: DataTypes.STRING(20), defaultValue: 'created' },
  notify_raw: DataTypes.JSON,
  paid_at: DataTypes.DATE,
  refunded_at: DataTypes.DATE
}, {
  tableName: 'ec9_payments',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Payment;
