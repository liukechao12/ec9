const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Invitation = sequelize.define('Invitation', {
  event_id: { type: DataTypes.INTEGER, allowNull: false },
  guest_id: { type: DataTypes.INTEGER, allowNull: false },
  invite_code: { type: DataTypes.STRING(32), allowNull: false },
  source_bd: DataTypes.STRING(100),
  approval_status: { type: DataTypes.TINYINT, defaultValue: 0, comment: '0 无需审批 1 待审批 2 已通过 3 已拒绝' },
  approval_time: DataTypes.DATE,
  approval_by: DataTypes.STRING(100),
  approval_remark: DataTypes.TEXT,
  registration_status: { type: DataTypes.TINYINT, defaultValue: 0, comment: '0 未报名 1 待审批 2 已报名 3 已拒绝' },
  registration_time: { type: DataTypes.DATE, comment: '报名时间（EC8 语义）' },
  is_valid: { type: DataTypes.TINYINT, defaultValue: 1 },
  extra_fields: DataTypes.JSON
}, {
  tableName: 'ec9_invitations',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Invitation;
