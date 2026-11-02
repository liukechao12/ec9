/**
 * 学生票学籍核验通道配置（后台可改，热更新）
 *
 * 与短信/支付配置同一套做法：单行落库 + 后台可改 + 进程内缓存 + 对外只回掩码。
 * 凭证（access_key）进 config_encrypted 用 AES 加密，access_id 不是秘密，明文存。
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const StudentVerifyConfig = sequelize.define('StudentVerifyConfig', {
  name: { type: DataTypes.STRING(30), defaultValue: 'tianyuan', comment: '通道标识，单行 tianyuan' },
  provider: { type: DataTypes.STRING(30), defaultValue: 'tianyuan' },
  product_code: { type: DataTypes.STRING(40), defaultValue: 'IVYZX7J9', comment: '天远产品号' },
  endpoint: { type: DataTypes.STRING(200), defaultValue: 'https://api.tianyuanapi.com' },
  access_id: { type: DataTypes.STRING(120), defaultValue: '', comment: 'Access-Id（非秘密，明文）' },
  config_encrypted: { type: DataTypes.TEXT, comment: '{access_key} AES 加密' },
  enabled: { type: DataTypes.SMALLINT, defaultValue: 0, comment: '1=启用学籍核验' },
  reuse_days: { type: DataTypes.INTEGER, defaultValue: 30, comment: '明确结论（在籍/不在籍）复用天数' },
  reuse_unknown_days: { type: DataTypes.INTEGER, defaultValue: 7, comment: '「无法判断」复用天数（短期内重试大概率同结果）' },
  error_reuse_minutes: { type: DataTypes.INTEGER, defaultValue: 10, comment: '接口异常结果的复用分钟数（防接口挂掉时反复重试烧钱）' },
  timeout_ms: { type: DataTypes.INTEGER, defaultValue: 8000, comment: '接口超时（毫秒）' },
  on_not_enrolled: { type: DataTypes.STRING(20), defaultValue: 'reject', comment: 'reject 不允许买学生票 / manual 转人工' },
  on_unknown: { type: DataTypes.STRING(20), defaultValue: 'manual', comment: '接口异常或无法判断：manual 转人工 / reject 拒绝' },
  remark: DataTypes.STRING(500)
}, {
  tableName: 'ec9_student_verify_configs',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = StudentVerifyConfig;
