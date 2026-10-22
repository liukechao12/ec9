const express = require('express');
const router = express.Router();
const { OperationLog, Admin } = require('../models');
const { Op } = require('sequelize');
const { authenticate, authorize } = require('../middleware/auth');

// 获取操作日志列表（需要管理员权限）
router.get('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { page = 1, pageSize = 20, admin_id, module, action, startDate, endDate } = req.query;
    const offset = (page - 1) * pageSize;
    
    const where = {};
    if (admin_id) where.admin_id = admin_id;
    if (module) where.module = module;
    if (action) where.action = { [Op.like]: `%${action}%` };
    
    if (startDate || endDate) {
      where.created_at = {};
      if (startDate) where.created_at[Op.gte] = new Date(startDate);
      if (endDate) where.created_at[Op.lte] = new Date(endDate);
    }
    
    const { count, rows } = await OperationLog.findAndCountAll({
      where,
      include: [
        {
          model: Admin,
          as: 'admin',
          attributes: ['id', 'username', 'name', 'role']
        }
      ],
      limit: parseInt(pageSize),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']]
    });
    
    res.json({
      code: 200,
      message: '获取成功',
      data: {
        list: rows,
        total: count,
        page: parseInt(page),
        pageSize: parseInt(pageSize)
      }
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// 获取操作日志详情
router.get('/:id(\\d+)', authenticate, authorize('admin'), async (req, res) => {
  try {
    const log = await OperationLog.findByPk(req.params.id, {
      include: [
        {
          model: Admin,
          as: 'admin',
          attributes: ['id', 'username', 'name', 'role']
        }
      ]
    });
    
    if (!log) {
      return res.status(404).json({
        code: 404,
        message: '日志不存在'
      });
    }
    
    res.json({
      code: 200,
      message: '获取成功',
      data: log
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// 获取操作统计
router.get('/statistics/summary', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const where = {};
    if (startDate || endDate) {
      where.created_at = {};
      if (startDate) where.created_at[Op.gte] = new Date(startDate);
      if (endDate) where.created_at[Op.lte] = new Date(endDate);
    }
    
    const totalLogs = await OperationLog.count({ where });
    
    const moduleStats = await OperationLog.findAll({
      where,
      attributes: [
        'module',
        [require('sequelize').literal('COUNT(*)'), 'count']
      ],
      group: ['module'],
      order: [[require('sequelize').literal('COUNT(*)'), 'DESC']]
    });
    
    const actionStats = await OperationLog.findAll({
      where,
      attributes: [
        'action',
        [require('sequelize').literal('COUNT(*)'), 'count']
      ],
      group: ['action'],
      order: [[require('sequelize').literal('COUNT(*)'), 'DESC']],
      limit: 10
    });
    
    const adminStats = await OperationLog.findAll({
      where,
      attributes: [
        'admin_id',
        [require('sequelize').literal('COUNT(*)'), 'count']
      ],
      // PG 下 select 了 admin 的字段就必须一并 group，否则报
      // 「column "admin.id" must appear in the GROUP BY clause」
      group: ['admin_id', 'admin.id', 'admin.username', 'admin.name'],
      order: [[require('sequelize').literal('COUNT(*)'), 'DESC']],
      limit: 10,
      include: [
        {
          model: Admin,
          as: 'admin',
          attributes: ['id', 'username', 'name']
        }
      ]
    });
    
    res.json({
      code: 200,
      message: '获取成功',
      data: {
        total: totalLogs,
        byModule: moduleStats,
        byAction: actionStats,
        byAdmin: adminStats
      }
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

module.exports = router;

