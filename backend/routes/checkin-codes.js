const express = require('express');
const router = express.Router();
const { CheckinCode, Event } = require('../models');
const crypto = require('crypto');
const { generateCheckinQRCode } = require('../utils/qrcode');
const { authenticate } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');

// 生成签到码
function generateCheckinCode() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

// 获取所有签到码（需要认证）
router.get('/', authenticate, operationLog('checkin-codes', '获取签到码列表'), async (req, res) => {
  try {
    const { event_id } = req.query;
    const where = {};
    if (event_id) where.event_id = event_id;
    
    const codes = await CheckinCode.findAll({
      where,
      include: [{ model: Event, as: 'event' }],
      order: [['created_at', 'DESC']]
    });
    
    res.json({
      code: 200,
      message: '获取成功',
      data: codes
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// 创建签到码（需要认证）
router.post('/', authenticate, operationLog('checkin-codes', '创建签到码'), async (req, res) => {
  try {
    const { event_id, code_type, created_by } = req.body;
    
    if (!event_id || !code_type) {
      return res.status(400).json({
        code: 400,
        message: '活动ID和签到码类型不能为空'
      });
    }
    
    if (code_type !== 1 && code_type !== 2) {
      return res.status(400).json({
        code: 400,
        message: '签到码类型错误：1-深圳专用，2-深圳+香港通用'
      });
    }
    
    // 生成唯一签到码
    let code = generateCheckinCode();
    let exists = await CheckinCode.findOne({ where: { code } });
    while (exists) {
      code = generateCheckinCode();
      exists = await CheckinCode.findOne({ where: { code } });
    }
    
    const checkinCode = await CheckinCode.create({
      event_id,
      code,
      code_type,
      created_by
    });
    
    // 生成二维码图片
    try {
      const qrCode = await generateCheckinQRCode(code);
      await checkinCode.update({
        qr_code_url: qrCode.url,
        qr_code_data: qrCode.data
      });
    } catch (error) {
      console.error('生成签到码二维码失败:', error);
    }
    
    // 重新获取包含二维码的签到码信息
    await checkinCode.reload();
    
    res.status(201).json({
      code: 201,
      message: '创建成功',
      data: checkinCode
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '创建失败',
      error: error.message
    });
  }
});

// 更新签到码状态（需要认证）
router.put('/:id/status', authenticate, operationLog('checkin-codes', '更新签到码状态'), async (req, res) => {
  try {
    const { is_active } = req.body;
    const checkinCode = await CheckinCode.findByPk(req.params.id);
    
    if (!checkinCode) {
      return res.status(404).json({
        code: 404,
        message: '签到码不存在'
      });
    }
    
    await checkinCode.update({ is_active });
    
    res.json({
      code: 200,
      message: '更新成功',
      data: checkinCode
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '更新失败',
      error: error.message
    });
  }
});

// 删除签到码
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const checkinCode = await CheckinCode.findByPk(req.params.id);
    if (!checkinCode) {
      return res.status(404).json({
        code: 404,
        message: '签到码不存在'
      });
    }
    
    await checkinCode.destroy();
    res.json({
      code: 200,
      message: '删除成功'
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '删除失败',
      error: error.message
    });
  }
});

// 重新生成签到码二维码（需要认证）
router.post('/:id/regenerate-qrcode', authenticate, operationLog('checkin-codes', '重新生成签到码二维码'), async (req, res) => {
  try {
    const checkinCode = await CheckinCode.findByPk(req.params.id);
    
    if (!checkinCode) {
      return res.status(404).json({
        code: 404,
        message: '签到码不存在'
      });
    }
    
    // 重新生成二维码
    const qrCode = await generateCheckinQRCode(checkinCode.code);
    await checkinCode.update({
      qr_code_url: qrCode.url,
      qr_code_data: qrCode.data
    });
    
    await checkinCode.reload();
    
    res.json({
      code: 200,
      message: '二维码重新生成成功',
      data: {
        checkinCode,
        qr_code_url: qrCode.url,
        qr_code_data: qrCode.data
      }
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '重新生成二维码失败',
      error: error.message
    });
  }
});

module.exports = router;

