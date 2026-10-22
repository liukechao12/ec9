const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/** 短信验证码：哈希存储不存明文，频率/次数/有效期全在服务端控制 */
const VerificationCode = sequelize.define('VerificationCode', {
  phone_hmac: { type: DataTypes.STRING(64), allowNull: false },
  code_hash: { type: DataTypes.STRING(64), allowNull: false },
  purpose: { type: DataTypes.STRING(20), defaultValue: 'register' },
  ip: DataTypes.STRING(45),
  attempts: { type: DataTypes.INTEGER, defaultValue: 0 },
  max_attempts: { type: DataTypes.INTEGER, defaultValue: 5 },
  expires_at: { type: DataTypes.DATE, allowNull: false },
  consumed_at: DataTypes.DATE
}, {
  tableName: 'ec9_verification_codes',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = VerificationCode;
