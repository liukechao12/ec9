const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const CheckinCode = sequelize.define('CheckinCode', {
  registration_id: { type: DataTypes.INTEGER, allowNull: false },
  guest_id: { type: DataTypes.INTEGER, allowNull: false },
  event_id: { type: DataTypes.INTEGER, allowNull: false },
  code: { type: DataTypes.STRING(64), allowNull: false },
  status: { type: DataTypes.STRING(20), defaultValue: 'active' },
  generated_at: DataTypes.DATE,
  used_at: DataTypes.DATE
}, {
  tableName: 'ec9_checkin_codes',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = CheckinCode;
