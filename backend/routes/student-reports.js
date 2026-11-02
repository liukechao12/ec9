/**
 * 学生票《教育部学籍在线验证报告》后台接口（仅管理员）
 *
 *   GET  /api/student-reports                    报告列表（可按 group_no / status 筛选）
 *   GET  /api/student-reports/:id/file           鉴权读取报告文件（inline 预览，不暴露静态 URL）
 *   POST /api/student-reports/:id/review         人工复核：符合 / 不符合
 *
 * 文件存在 backend/private/student_reports 下，不在 public 静态目录里；
 * 报告含姓名、身份证号、院校等个人信息，必须经这里鉴权后才能读。
 * 上传不在这里 —— 报告随报名一起走 /api/registrations/submit-group 的 multipart。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');
const { StudentReport, REPORT_STATUS } = require('../models');

// 与「报名审核」的 /registrations/group/:groupNo/audit 保持一致：登录后台即可操作，
// 不额外要求 admin 角色（BD 也要能进审核工作台做复核）。
const loggedIn = [authenticate];
const PRIVATE_ROOT = path.resolve(__dirname, '../private/student_reports');

/** 对外视图：不暴露私有文件路径 */
function view(r) {
  const p = r.get ? r.get({ plain: true }) : r;
  delete p.file_path;
  return p;
}

router.get('/', ...loggedIn, operationLog('student_reports', '查看学籍报告列表'), async (req, res) => {
  try {
    const where = {};
    if (req.query.group_no) where.group_no = String(req.query.group_no);
    if (req.query.status) where.status = String(req.query.status);
    const list = await StudentReport.findAll({
      where,
      order: [['id', 'DESC']],
      limit: Math.min(Number(req.query.limit) || 200, 500)
    });
    res.json({ code: 0, message: 'ok', data: { list: list.map(view) } });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/:id/file', ...loggedIn, async (req, res) => {
  try {
    const r = await StudentReport.findByPk(req.params.id);
    if (!r) return res.status(404).json({ code: 404, message: '报告不存在' });
    const abs = path.resolve(__dirname, '..', String(r.file_path || ''));
    // 防路径穿越：只能读私有报告目录里的文件
    if (!abs.startsWith(PRIVATE_ROOT + path.sep)) {
      return res.status(403).json({ code: 403, message: '非法文件路径' });
    }
    if (!fs.existsSync(abs)) return res.status(404).json({ code: 404, message: '报告文件已丢失' });
    res.setHeader('Content-Type', r.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(r.file_name || 'report')}`);
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 人工复核：按报告中的「在线验证码」去学信网核对后标记结论
 * body: { action: 'approve'|'reject', verify_code?, review_note? }
 */
router.post('/:id/review', ...loggedIn, operationLog('student_reports', '人工复核学籍报告'), async (req, res) => {
  try {
    const { action, verify_code, review_note } = req.body || {};
    if (action !== 'approve' && action !== 'reject') {
      return res.status(400).json({ code: 400, message: 'action 必须是 approve 或 reject' });
    }
    const r = await StudentReport.findByPk(req.params.id);
    if (!r) return res.status(404).json({ code: 404, message: '报告不存在' });
    r.status = action === 'approve' ? REPORT_STATUS.APPROVED : REPORT_STATUS.REJECTED;
    r.verify_code = verify_code == null ? r.verify_code : String(verify_code).trim().slice(0, 80);
    r.review_note = review_note == null ? r.review_note : String(review_note).trim().slice(0, 500);
    r.reviewed_by = (req.admin && req.admin.username) || (req.user && req.user.username) || '';
    r.reviewed_at = new Date();
    await r.save();
    res.json({ code: 0, message: action === 'approve' ? '已标记「符合」' : '已标记「不符合」', data: view(r) });
  } catch (e) {
    res.status(400).json({ code: 400, message: e.message });
  }
});

module.exports = router;
module.exports.PRIVATE_ROOT = PRIVATE_ROOT;
