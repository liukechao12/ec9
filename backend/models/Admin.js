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

// 是否已为 bcrypt 密文（避免二次加密）
function isBcryptHash(v) {
  return typeof v === 'string' && /^\$2[aby]\$\d{2}\$/.test(v);
}

// 密码落库前统一加密。
// 背景：原先只有 scripts/seed.js 手动 hashSync，后台「新建BD」「Excel导入BD」直接透传明文，
// 导致建出来的账号 bcrypt.compare 永远失败 = 建完就登不上。这里统一兜底。
Admin.beforeCreate(async (admin) => {
  if (admin.password && !isBcryptHash(admin.password)) {
    admin.password = await bcrypt.hash(String(admin.password), 10);
  }
});

Admin.beforeUpdate(async (admin) => {
  // Sequelize 只在字段被改动时才放进 changed()，未改动则无需处理
  if (admin.changed && admin.changed('password')) {
    const v = admin.password;
    if (v && !isBcryptHash(v)) {
      admin.password = await bcrypt.hash(String(v), 10);
    }
  }
});

module.exports = Admin;
