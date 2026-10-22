const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const OperationLog = sequelize.define('OperationLog', {
  admin_id: DataTypes.INTEGER,
  admin_name: DataTypes.STRING(100),
  role: DataTypes.STRING(20),
  action: { type: DataTypes.STRING(100), allowNull: false },
  module: DataTypes.STRING(50),
  target_type: DataTypes.STRING(50),
  target_id: DataTypes.STRING(100),
  detail: DataTypes.TEXT,
  ip: DataTypes.STRING(45)
}, {
  tableName: 'ec9_operation_logs',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = OperationLog;
