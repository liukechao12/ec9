const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/** 报名状态机：submitted → pending_audit → approved → paid
 *  分支：rejected 驳回 / closed 超时关闭 / cancelled 取消 */
const REG_STATUS = {
  SUBMITTED: 'submitted',
  PENDING_AUDIT: 'pending_audit',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PAID: 'paid',
  CLOSED: 'closed',
  CANCELLED: 'cancelled'
};

const Registration = sequelize.define('Registration', {
  event_id: { type: DataTypes.INTEGER, allowNull: false },
  session_id: { type: DataTypes.INTEGER, defaultValue: 0 },
  ticket_type_id: { type: DataTypes.INTEGER, defaultValue: 0 },
  guest_id: { type: DataTypes.INTEGER, allowNull: false },
  invitation_id: DataTypes.INTEGER,
  // 多人代报：同一次提交的所有填报人共享一个 group_no（提交人手机号验证持有者=购票人）
  group_no: DataTypes.STRING(40),
  form_data: DataTypes.JSON,
  status: { type: DataTypes.STRING(20), defaultValue: 'submitted' },
  reject_reason: DataTypes.STRING(500),
  submitted_at: DataTypes.DATE,
  // EC8 兼容：EC8 后台按 registration_time 排序/展示（报名时间）
  registration_time: { type: DataTypes.DATE, comment: '报名时间（EC8 语义，与 submitted_at 同义）' },
  audited_at: DataTypes.DATE,
  source_bd: DataTypes.STRING(100),
  // H5 报名表单：关注方向（设计稿「关注方向」字段）
  focus: DataTypes.STRING(200),
  // 「全部论坛」标记：H5 上「全部论坛」和「未选」提交过来都是 session_id=0，
  // 光看 session_id 分不出来（导出名单会显示成未选），这个位才是真正的口径：
  //   session_all=1                → 全部论坛
  //   session_all=0 且 session_id>0 → 具体论坛
  //   两者皆为 0                    → 未选（只有直接打接口才会出现）
  session_all: { type: DataTypes.SMALLINT, defaultValue: 0, comment: '1=选了「全部论坛」' },
  extra_fields: DataTypes.JSON
}, {
  tableName: 'ec9_registrations',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = { Registration, REG_STATUS };
