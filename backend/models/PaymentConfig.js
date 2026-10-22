/**
 * EC9 支付渠道配置
 *
 * 设计要点：
 *   - 一期只有微信支付（channel='wechat'），表结构与 channel 字段为支付宝二期预留
 *   - 敏感字段（api_key / api_v3_key）一律 AES 加密落库，字段名以 _enc 结尾
 *   - mode: mock（无资质开发）/ sandbox（沙箱）/ real（生产）
 *   - 后台「支付配置」页可改，改完立即热更新到内存，不用重启服务
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const PaymentConfig = sequelize.define('PaymentConfig', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  channel: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'wechat', comment: 'wechat / alipay(预留)' },
  mode: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'mock', comment: 'mock / sandbox / real' },
  enabled: { type: DataTypes.TINYINT, defaultValue: 1, comment: '0 停用 / 1 启用' },

  app_id: { type: DataTypes.STRING(64), comment: '公众号或小程序 appid' },
  mch_id: { type: DataTypes.STRING(32), comment: '商户号' },
  sub_app_id: { type: DataTypes.STRING(64), comment: '子商户 appid（服务商模式预留）' },
  sub_mch_id: { type: DataTypes.STRING(32), comment: '子商户号（服务商模式预留）' },

  api_key_enc: { type: DataTypes.TEXT, comment: 'API v2 密钥（AES 加密）' },
  api_v3_key_enc: { type: DataTypes.TEXT, comment: 'API v3 密钥（AES 加密，V3 接口预留）' },

  sign_type: { type: DataTypes.STRING(10), defaultValue: 'MD5', comment: 'V2 签名类型：MD5 / HMAC-SHA256' },
  cert_path: { type: DataTypes.STRING(255), comment: '退款用 API 证书（apiclient_cert.p12）绝对路径' },
  cert_serial_no: { type: DataTypes.STRING(64), comment: '证书序列号（V3 预留）' },

  notify_url: { type: DataTypes.STRING(255), comment: '支付结果回调地址' },
  refund_notify_url: { type: DataTypes.STRING(255), comment: '退款结果回调地址（可空）' },
  order_expire_minutes: { type: DataTypes.INTEGER, defaultValue: 30, comment: '订单未支付自动关单分钟数' },

  remark: { type: DataTypes.STRING(500) },
  updated_by: { type: DataTypes.INTEGER, comment: '最后修改人 admin id' }
}, {
  tableName: 'ec9_payment_configs',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { unique: true, fields: ['channel'], name: 'uk_pay_config_channel' }
  ]
});

module.exports = PaymentConfig;
