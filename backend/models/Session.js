const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Session = sequelize.define('Session', {
  event_id: { type: DataTypes.INTEGER, allowNull: false },
  name: { type: DataTypes.STRING(200), allowNull: false, comment: '场次名称（简体，基准字段）' },
  i18n: { type: DataTypes.JSON, comment: '多语结构化存储：{name:{zh-CN,zh-TW,en}}' },
  start_time: DataTypes.DATE,
  end_time: DataTypes.DATE,
  location: DataTypes.STRING(200),
  stock_total: { type: DataTypes.INTEGER, defaultValue: 0 },
  stock_locked: { type: DataTypes.INTEGER, defaultValue: 0 },
  stock_sold: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 },
  sort: { type: DataTypes.INTEGER, defaultValue: 0 }
}, {
  tableName: 'ec9_sessions',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Session;
