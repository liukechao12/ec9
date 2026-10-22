const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Checkin = sequelize.define('Checkin', {
  checkin_code_id: { type: DataTypes.INTEGER, allowNull: false },
  registration_id: { type: DataTypes.INTEGER, allowNull: false },
  guest_id: { type: DataTypes.INTEGER, allowNull: false },
  event_id: { type: DataTypes.INTEGER, allowNull: false },
  invitation_id: DataTypes.INTEGER,
  operator_id: DataTypes.INTEGER,
  operator_name: DataTypes.STRING(100),
  checkin_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  location_type: { type: DataTypes.TINYINT, comment: '签到地点类型：1-深圳，2-深圳+香港' },
  location: DataTypes.STRING(255),
  device_info: DataTypes.STRING(255),
  user_agent: DataTypes.STRING(500),
  ip_address: DataTypes.STRING(45)
}, {
  tableName: 'ec9_checkins',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = Checkin;
