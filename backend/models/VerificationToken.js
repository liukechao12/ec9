const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/** 验证凭证：校验通过签发，一次性，提交接口强制验票 */
const VerificationToken = sequelize.define('VerificationToken', {
  token: { type: DataTypes.STRING(128), allowNull: false },
  phone_hmac: { type: DataTypes.STRING(64), allowNull: false },
  purpose: { type: DataTypes.STRING(20), defaultValue: 'register' },
  used: { type: DataTypes.TINYINT, defaultValue: 0 },
  expires_at: { type: DataTypes.DATE, allowNull: false }
}, {
  tableName: 'ec9_verification_tokens',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = VerificationToken;
