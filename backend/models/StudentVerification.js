/**
 * 学生票学籍核验流水
 *
 * 每次真实调用 API 写一行；命中复用（未过期）不新增行，只更新关联字段。
 * 身份证号一律 EID 加密存储，检索靠 HMAC，对外只回掩码。
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/** 核验结论 */
const VERIFY_STATUS = {
  ENROLLED: 'enrolled',        // 在籍（是学生）
  NOT_ENROLLED: 'not_enrolled',// 不在籍（不是学生）
  UNKNOWN: 'unknown',          // 接口返回「无法判断」
  ERROR: 'error'               // 接口异常/超时/参数错（同样落库，短 TTL，避免反复重试烧钱）
};

const StudentVerification = sequelize.define('StudentVerification', {
  name: { type: DataTypes.STRING(100), defaultValue: '' },
  id_card_hmac: { type: DataTypes.STRING(64), defaultValue: '', comment: 'HMAC(name|id_card)，复用查重索引' },
  id_card_encrypted: { type: DataTypes.TEXT, comment: 'AES 密文（iv:cipher）' },
  id_card_mask: { type: DataTypes.STRING(30), comment: '掩码，如 1101**********1234' },
  status: { type: DataTypes.STRING(20), defaultValue: VERIFY_STATUS.UNKNOWN },
  api_code: DataTypes.STRING(60),
  api_message: DataTypes.STRING(500),
  transaction_id: DataTypes.STRING(80),
  provider: { type: DataTypes.STRING(30), defaultValue: 'tianyuan' },
  product_code: DataTypes.STRING(40),
  raw_response: DataTypes.JSON,
  guest_id: DataTypes.INTEGER,
  event_id: DataTypes.INTEGER,
  registration_id: DataTypes.INTEGER,
  group_no: DataTypes.STRING(40),
  verified_at: DataTypes.DATE,
  expires_at: { type: DataTypes.DATE, comment: '复用截止，过期重新调 API' },
  reuse_count: { type: DataTypes.INTEGER, defaultValue: 0, comment: '被复用的次数（命中缓存不新增行，只累加）' }
}, {
  tableName: 'ec9_student_verifications',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = { StudentVerification, VERIFY_STATUS };
