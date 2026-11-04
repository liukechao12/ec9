/**
 * 学生票《教育部学籍在线验证报告》后台接口（登录后台即可）
 *
 *   GET  /api/student-reports                    报告列表（可按 group_no / status 筛选）
 *   GET  /api/student-reports/:id/file           鉴权读取报告文件（inline 预览，不暴露静态 URL）
 *   POST /api/student-reports/:id/review         人工复核：符合 / 不符合
 *   POST /api/student-reports/upload             管理员代传 / 补传（multipart，改版前老单或资料不合格时用）
 *
 * 文件存在 backend/private/student_reports 下，不在 public 静态目录里；
 * 报告含姓名、身份证号、院校等个人信息，必须经这里鉴权后才能读。
 * 正常报名上传走 /api/registrations/submit-group 的 multipart；这里只负责后台补传。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');
const { sequelize, Registration, StudentReport, REPORT_STATUS } = require('../models');

// 与「报名审核」的 /registrations/group/:groupNo/audit 保持一致：登录后台即可操作，
// 不额外要求 admin 角色（BD 也要能进审核工作台做复核）。
const loggedIn = [authenticate];
const PRIVATE_ROOT = path.resolve(__dirname, '../private/student_reports');

// ---------- 管理员代传 / 补传：与报名时上传共用同一套私有目录与命名规则 ----------
const reportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});
function acceptReportFile(req, res, next) {
  reportUpload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? '报告文件不能超过 10MB' : (err.message || '文件解析失败');
      return res.status(400).json({ code: 400, message: msg });
    }
    next();
  });
}
/** 只允许 PDF / JPG / PNG（选文件偶尔没有 mime，用扩展名兜底） */
function isAllowedReport(f) {
  const mime = String(f.mimetype || '').toLowerCase();
  if (['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'].includes(mime)) return true;
  const m = String(f.originalname || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return !!(m && ['pdf', 'jpg', 'jpeg', 'png'].includes(m[1]));
}
function saveReportFile(f) {
  fs.mkdirSync(PRIVATE_ROOT, { recursive: true });
  const m = String(f.originalname || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = m && ['pdf', 'jpg', 'jpeg', 'png'].includes(m[1]) ? m[1] : 'pdf';
  const fname = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(PRIVATE_ROOT, fname), f.buffer);
  return 'private/student_reports/' + fname;
}
function maskedPhoneOf(enc) {
  try {
    const { decryptPhone, maskPhone } = require('../utils/phoneCrypto');
    return enc ? maskPhone(decryptPhone(enc)) : '';
  } catch (e) { return ''; }
}

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

/**
 * POST /api/student-reports/upload —— 管理员代传 / 补传（multipart）
 * 字段：registration_id（必填，必须是学生票报名）、file（PDF/JPG/PNG ≤10MB）
 *
 * 口径：一个报名人只保留一条报告。已有报告则替换同一行 —— 换文件、状态回 pending、
 *      清空复核结论并删除旧文件，替换后必须重新按报告中的「在线验证码」人工复核。
 *      这保证 auditGroup 的「报告未全部符合就拦截」逻辑不用改。
 */
router.post('/upload', ...loggedIn, operationLog('student_reports', '管理员代传学籍报告'),
  acceptReportFile, async (req, res) => {
    let writtenRel = '';
    try {
      const regId = Number(req.body && req.body.registration_id);
      if (!Number.isInteger(regId) || regId <= 0) {
        return res.status(400).json({ code: 400, message: 'registration_id 无效' });
      }
      const f = req.file;
      if (!f) return res.status(400).json({ code: 400, message: '请选择报告文件' });
      if (!isAllowedReport(f)) {
        return res.status(400).json({ code: 400, message: '仅支持 PDF / JPG / PNG 格式的报告' });
      }

      const [rows] = await sequelize.query(`
        SELECT r.id, r.group_no, r.guest_id, r.event_id, r.extra_fields,
               g.name, g.phone, t.is_student
        FROM ec9_registrations r
        LEFT JOIN ec9_guests g ON g.id = r.guest_id
        LEFT JOIN ec9_ticket_types t ON t.id = r.ticket_type_id
        WHERE r.id = $1`, { bind: [regId] });
      if (!rows.length) return res.status(404).json({ code: 404, message: '报名记录不存在' });
      const reg = rows[0];
      if (Number(reg.is_student) !== 1) {
        return res.status(400).json({ code: 400, message: '该报名不是学生票，不能上传学籍报告' });
      }

      const existing = await StudentReport.findOne({
        where: { registration_id: regId }, order: [['id', 'DESC']]
      });
      const oldRel = existing ? String(existing.file_path || '') : '';

      writtenRel = saveReportFile(f);
      const patch = {
        registration_id: regId,
        group_no: reg.group_no || null,
        guest_id: reg.guest_id || null,
        event_id: reg.event_id || null,
        name: String(reg.name || '').slice(0, 100),
        phone_masked: maskedPhoneOf(reg.phone),
        file_path: writtenRel,
        file_name: String(f.originalname || 'report').slice(0, 255),
        mime: String(f.mimetype || '') || (writtenRel.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'),
        file_size: Number(f.size) || 0,
        status: REPORT_STATUS.PENDING,
        verify_code: null,
        review_note: null,
        reviewed_by: null,
        reviewed_at: null
      };

      let row;
      if (existing) {
        await existing.update(patch);
        row = existing;
        // 删掉被替换的旧文件（仅限私有报告目录内，防路径穿越）
        const oldAbs = path.resolve(__dirname, '..', oldRel);
        if (oldRel && oldAbs.startsWith(PRIVATE_ROOT + path.sep)) {
          try { fs.unlinkSync(oldAbs); } catch (e) { /* 旧文件已不存在则忽略 */ }
        }
      } else {
        row = await StudentReport.create(patch);
      }

      // 同步报名单上的 student_report_id（后台整单列表按它展示）。
      // 用模型更新，让 Sequelize 按 JSON 列类型正确序列化，避免原生 SQL 的 json/jsonb 类型推断问题。
      const regModel = await Registration.findByPk(regId);
      if (regModel) {
        let ef = regModel.extra_fields || {};
        if (typeof ef === 'string') { try { ef = JSON.parse(ef); } catch (e) { ef = {}; } }
        ef.student_report_id = row.id;
        await regModel.update({ extra_fields: ef });
      }

      res.json({
        code: 0,
        message: existing
          ? '已替换原报告，状态重置为「待复核」，请重新核验'
          : '补传成功，请按报告中的在线验证码人工复核',
        data: view(row)
      });
    } catch (e) {
      // 落库失败时清掉刚写的文件，避免留下孤儿文件
      if (writtenRel) {
        try { fs.unlinkSync(path.resolve(__dirname, '..', writtenRel)); } catch (err) { /* ignore */ }
      }
      res.status(400).json({ code: 400, message: e.message });
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
