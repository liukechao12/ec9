const { DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');
const { sequelize } = require('../config/database');

const Admin = sequelize.define('Admin', {
  username: { type: DataTypes.STRING(50), allowNull: false, unique: true },
  password: { type: DataTypes.STRING(255), allowNull: false },
  name: DataTypes.STRING(50),
  role: { type: DataTypes.STRING(20), defaultValue: 'bd' },
  contact: DataTypes.STRING(100),
  lang: { type: DataTypes.STRING(10), defaultValue: 'zh-CN' },
  token_version: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 },
  last_login_time: { type: DataTypes.DATE, comment: '最后登录时间（EC8 语义）' },
  last_login_at: DataTypes.DATE,
  last_login_ip: DataTypes.STRING(45)
}, {
  tableName: 'ec9_admins',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

// 实例方法：验证密码（后台登录路由调用）
Admin.prototype.validatePassword = async function (password) {
  return bcrypt.compare(password, this.password);
};

module.exports = Admin;
