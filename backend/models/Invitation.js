const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Invitation = sequelize.define('Invitation', {
  event_id: { type: DataTypes.INTEGER, allowNull: false },
  guest_id: { type: DataTypes.INTEGER, allowNull: false },
  invite_code: { type: DataTypes.STRING(32), allowNull: false },
  source_bd: DataTypes.STRING(100),
  approval_status: { type: DataTypes.TINYINT, defaultValue: 0, comment: '0 无需审批 1 待审批 2 已通过 3 已拒绝' },
  approval_time: DataTypes.DATE,
  approval_by: DataTypes.STRING(100),
  approval_remark: DataTypes.TEXT,
  registration_status: { type: DataTypes.TINYINT, defaultValue: 0, comment: '0 未报名 1 待审批 2 已报名 3 已拒绝' },
  registration_time: { type: DataTypes.DATE, comment: '报名时间（EC8 语义）' },
  // 是否需要付款：1 需付款（默认） 0 免票
  // 语义：票种本身 ¥0（学生票/免费票）永远是免票；此处只决定「票种有价时这个人是否还要掏钱」。
  // 管理员在审批（批准/手动报名成功）时可改成 0，改后该邀约人报名即出票、不产生订单。
  need_pay: { type: DataTypes.TINYINT, defaultValue: 1, comment: '1 需付款 0 免票（管理员审批时可改）' },
  is_valid: { type: DataTypes.TINYINT, defaultValue: 1 },
  extra_fields: DataTypes.JSON
}, {
  tableName: 'ec9_invitations',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Invitation;
