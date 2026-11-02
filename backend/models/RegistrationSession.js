const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/**
 * 报名选择的论坛（多选）
 *
 * 论坛从单选改成多选后，一个人的选择装不进 ec9_registrations.session_id 一个字段，
 * 拆到这张关联表：一人对多行。
 *
 * ⚠️ 口径（改这块前必读）：
 *   session_all = 1                 → 全部论坛（展示直接写「全部论坛」，不逐条枚举）
 *   session_all = 0 + 本表有行       → 选了若干个具体论坛
 *   session_all = 0 + 本表无行       → 未选（或选的论坛已被删，待业务确认）
 * ec9_registrations.session_id 只作兼容回退（新提交写所选第一个，全选时写 0），
 * 展示/统计/导出一律以「本表 + session_all」为准，别只读 session_id。
 */
const RegistrationSession = sequelize.define('RegistrationSession', {
  registration_id: { type: DataTypes.INTEGER, allowNull: false },
  session_id: { type: DataTypes.INTEGER, allowNull: false }
}, {
  tableName: 'ec9_registration_sessions',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = { RegistrationSession };
