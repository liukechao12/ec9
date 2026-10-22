const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Approval = sequelize.define('Approval', {
  target_type: { type: DataTypes.STRING(20), allowNull: false, comment: 'registration / invitation' },
  target_id: { type: DataTypes.INTEGER, allowNull: false },
  event_id: DataTypes.INTEGER,
  action: { type: DataTypes.STRING(20), allowNull: false, comment: 'approve/reject/auto_approve/price_override' },
  operator_id: DataTypes.INTEGER,
  operator_name: DataTypes.STRING(100),
  reason: DataTypes.STRING(500),
  price_before: DataTypes.DECIMAL(10, 2),
  price_after: DataTypes.DECIMAL(10, 2)
}, {
  tableName: 'ec9_approvals',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = Approval;
