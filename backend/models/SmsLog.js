const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const SmsLog = sequelize.define('SmsLog', {
  provider_id: DataTypes.INTEGER,
  phone: DataTypes.STRING(255),
  template_id: DataTypes.INTEGER,
  message_type: DataTypes.STRING(50),
  scene: DataTypes.STRING(50),
  lang: { type: DataTypes.STRING(10), defaultValue: 'zh-CN' },
  content: DataTypes.TEXT,
  status: { type: DataTypes.STRING(20), defaultValue: 'pending' },
  error: DataTypes.STRING(500),
  retry_count: { type: DataTypes.INTEGER, defaultValue: 0 },
  sent_at: DataTypes.DATE
}, {
  tableName: 'ec9_sms_logs',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = SmsLog;
