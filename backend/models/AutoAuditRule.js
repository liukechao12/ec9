const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/**
 * 自动审核规则。
 * conditions 结构（JSON，后台可配置，不写死在代码）：
 * {
 *   "all": [
 *     { "field": "source",        "op": "in",  "value": ["bd_invite"] },
 *     { "field": "paid",          "op": "eq",  "value": false },
 *     { "field": "ticket_type_id","op": "in",  "value": [1,2] },
 *     { "field": "bd_id",         "op": "in",  "value": ["bd001"] },
 *     { "field": "invite_code",   "op": "eq",  "value": "ABC123" }
 *   ]
 * }
 * 全部命中 → 自动通过；任一不命中 → 转人工。
 */
const AutoAuditRule = sequelize.define('AutoAuditRule', {
  event_id: { type: DataTypes.INTEGER, allowNull: false },
  name: { type: DataTypes.STRING(200), allowNull: false },
  conditions: { type: DataTypes.JSON, allowNull: false },
  enabled: { type: DataTypes.TINYINT, defaultValue: 1 },
  priority: { type: DataTypes.INTEGER, defaultValue: 0 }
}, {
  tableName: 'ec9_auto_audit_rules',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = AutoAuditRule;
