/**
 * 学生票《教育部学籍在线验证报告》上传与人工复核记录
 *
 * 口径（2026-11-02 起）：所有学籍核验 API 均不可用，改为学生报名时上传报告，
 * 管理员按报告中的「在线验证码」去学信网人工复核，标记「符合 / 不符合」。
 *
 * 文件存在 backend/private/student_reports 下（不在 public 静态目录），
 * 只能经 routes/student-reports.js 的鉴权接口读取，避免报告里的身份证号裸奔。
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const REPORT_STATUS = {
  PENDING: 'pending',      // 待人工复核
  APPROVED: 'approved',    // 符合（报告有效且在籍）
  REJECTED: 'rejected'     // 不符合
};

const StudentReport = sequelize.define('StudentReport', {
  registration_id: DataTypes.INTEGER,
  group_no: DataTypes.STRING(40),
  guest_id: DataTypes.INTEGER,
  event_id: DataTypes.INTEGER,
  name: { type: DataTypes.STRING(100), defaultValue: '' },
  phone_masked: DataTypes.STRING(30),
  // 相对 backend 根目录的私有路径，如 private/student_reports/xxx.pdf
  file_path: { type: DataTypes.STRING(300), allowNull: false },
  file_name: { type: DataTypes.STRING(255), defaultValue: '' },
  mime: { type: DataTypes.STRING(80), defaultValue: '' },
  file_size: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: { type: DataTypes.STRING(20), defaultValue: REPORT_STATUS.PENDING },
  // 人工复核时由管理员按报告填写（选填），便于复查与导出
  verify_code: DataTypes.STRING(80),
  review_note: DataTypes.STRING(500),
  reviewed_by: DataTypes.STRING(80),
  reviewed_at: DataTypes.DATE
}, {
  tableName: 'ec9_student_reports',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = { StudentReport, REPORT_STATUS };
