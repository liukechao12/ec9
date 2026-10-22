const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/** 短信模板：同一 (message_type, scene, lang) 唯一，一语种一条 */
const SmsTemplate = sequelize.define('SmsTemplate', {
  provider_id: DataTypes.INTEGER,
  message_type: { type: DataTypes.STRING(50), allowNull: false },
  scene: { type: DataTypes.STRING(50), defaultValue: 'default' },
  template_code: DataTypes.STRING(128),
  lang: { type: DataTypes.STRING(10), defaultValue: 'zh-CN' },
  content: DataTypes.TEXT,
  enabled: { type: DataTypes.TINYINT, defaultValue: 1 }
}, {
  tableName: 'ec9_sms_templates',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = SmsTemplate;
