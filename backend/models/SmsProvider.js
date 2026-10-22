/**
 * EC9 短信通道配置（后台可改，热更新）
 *
 * 一张表存两件事：
 *   ① 通道凭证（accessKeyId / accessKeySecret）—— 进 config_encrypted，AES 加密
 *   ② 业务参数（签名、验证码模板 CODE、有效期、频率限制、日上限）—— 明文列
 *
 * 与支付配置一样：DB 优先，DB 无记录时回退 .env（老部署方式不炸）。
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const SmsProvider = sequelize.define('SmsProvider', {
  name: { type: DataTypes.STRING(50), allowNull: false, comment: 'aliyun / qiniu / tencent' },
  config_encrypted: { type: DataTypes.TEXT, comment: '通道凭证 JSON（AES 加密）' },
  enabled: { type: DataTypes.TINYINT, defaultValue: 0 },
  is_default: { type: DataTypes.TINYINT, defaultValue: 0 },
  remark: DataTypes.STRING(500),

  // ===== 后台可改（2026-10-14 从 .env 迁来）=====
  region: { type: DataTypes.STRING(30), defaultValue: 'cn-hangzhou', comment: '阿里云地域' },
  endpoint: { type: DataTypes.STRING(120), comment: 'SDK endpoint，可空用默认' },
  sign_name: { type: DataTypes.STRING(60), comment: '短信签名（需服务商审核通过）' },
  verify_template_code: { type: DataTypes.STRING(60), comment: '验证码短信模板 CODE' },
  code_expire_minutes: { type: DataTypes.INTEGER, defaultValue: 5, comment: '验证码有效期（分钟）' },
  code_resend_seconds: { type: DataTypes.INTEGER, defaultValue: 60, comment: '重发间隔（秒）' },
  code_max_attempts: { type: DataTypes.INTEGER, defaultValue: 5, comment: '单个验证码最大尝试次数' },
  code_daily_limit: { type: DataTypes.INTEGER, defaultValue: 10, comment: '单号码每日发送上限' }
}, {
  tableName: 'ec9_sms_providers',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = SmsProvider;
