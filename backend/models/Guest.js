const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Guest = sequelize.define('Guest', {
  name: { type: DataTypes.STRING(100), allowNull: false },
  phone: { type: DataTypes.STRING(255), comment: 'AES 加密存储' },
  phone_hmac: { type: DataTypes.STRING(64), comment: 'HMAC-SHA256 检索索引（不可逆）' },
  // EC8 后台兼容：EC8 代码按 phone_hash 读写，映射到同一物理列 phone_hmac
  phone_hash: { type: DataTypes.STRING(64), field: 'phone_hmac' },
  company: DataTypes.STRING(200),
  position: DataTypes.STRING(100),
  email: DataTypes.STRING(200),
  tags: DataTypes.JSON,
  source: DataTypes.STRING(50),
  bd_id: DataTypes.STRING(100),
  remark: DataTypes.TEXT,
  status: { type: DataTypes.SMALLINT, defaultValue: 1, comment: '0-已删除/无效，1-有效' },
  extra_fields: DataTypes.JSON,
  modification_history: DataTypes.JSON
}, {
  tableName: 'ec9_guests',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Guest;
