const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Event = sequelize.define('Event', {
  name: { type: DataTypes.STRING(200), allowNull: false, comment: '会议名称（简体，基准字段）' },
  description: DataTypes.TEXT,
  i18n: { type: DataTypes.JSON, comment: '多语结构化存储：{name:{zh-CN,zh-TW,en},description:{…},location:{…}}，加语种不改表结构' },
  cover_image: DataTypes.STRING(500),
  location: DataTypes.STRING(200),
  address: DataTypes.STRING(500),
  start_time: DataTypes.DATE,
  end_time: DataTypes.DATE,
  signup_start_time: DataTypes.DATE,
  signup_end_time: DataTypes.DATE,
  page_url: {
    type: DataTypes.STRING(120),
    allowNull: true,
    comment: '绑定的嘉宾侧页面：/pages/register /pages/invite /pages/checkin /pages/performance'
  },
  status: { type: DataTypes.SMALLINT, defaultValue: 1, comment: '0-已取消，1-进行中，2-已结束' },
  audit_mode: { type: DataTypes.STRING(20), defaultValue: 'manual', comment: 'auto 全自动 / manual 人工 / hybrid 混合' },
  pay_expire_hours: { type: DataTypes.INTEGER, defaultValue: 48 },
  extra_fields: DataTypes.JSON
}, {
  tableName: 'ec9_events',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Event;
