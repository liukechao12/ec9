const express = require('express');
const router = express.Router();
const multer = require('multer');
const { Admin, OperationLog } = require('../models');
const { authenticate, authorize } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');
const { Op } = require('sequelize');
const { parseBdExcel, generateImportReport } = require('../utils/excel');

// 配置multer用于文件上传
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-excel' // .xls
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('只支持Excel文件（.xlsx, .xls）'));
    }
  }
});

// 获取所有管理员/BD列表（需要管理员权限）
router.get('/', authenticate, authorize('admin'), operationLog('admins', '获取管理员列表'), async (req, res) => {
  try {
    const { page = 1, pageSize = 10, role, status, keyword } = req.query;
    const offset = (page - 1) * pageSize;
    
    const where = {};
    if (role) where.role = role;
    if (status !== undefined) where.status = parseInt(status);
    if (keyword) {
      where[Op.or] = [
        { username: { [Op.like]: `%${keyword}%` } },
        { name: { [Op.like]: `%${keyword}%` } },
        { contact: { [Op.like]: `%${keyword}%` } }
      ];
    }
    
    const { count, rows } = await Admin.findAndCountAll({
      where,
      attributes: { exclude: ['password'] }, // 不返回密码
      limit: parseInt(pageSize),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']]
    });
    
    // 确保返回的数据包含所有字段（包括contact）
    const list = rows.map(row => row.toJSON());
    
    res.json({
      code: 200,
      message: '获取成功',
      data: {
        list: list,
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

// 获取单个管理员/BD信息
router.get('/:id(\\d+)', authenticate, authorize('admin'), operationLog('admins', '获取管理员详情'), async (req, res) => {
  try {
    const admin = await Admin.findByPk(req.params.id, {
      attributes: { exclude: ['password'] }
    });
    
    if (!admin) {
      return res.status(404).json({
        code: 404,
        message: '管理员不存在'
      });
    }
    
    res.json({
      code: 200,
      message: '获取成功',
      data: admin
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// 创建BD用户（需要管理员权限）
router.post('/', authenticate, authorize('admin'), operationLog('admins', '创建BD用户'), async (req, res) => {
  try {
    const { username, password, name, contact, role = 'bd', status = 1 } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({
        code: 400,
        message: '用户名和密码不能为空'
      });
    }
    
    // 检查用户名是否已存在
    const existingAdmin = await Admin.findOne({
      where: { username }
    });
    
    if (existingAdmin) {
      return res.status(400).json({
        code: 400,
        message: '用户名已存在'
      });
    }
    
    // 创建BD用户
    const admin = await Admin.create({
      username,
      password, // 会在模型hook中自动加密
      name,
      contact,
      role,
      status
    });
    
    // 不返回密码
    const adminData = admin.toJSON();
    delete adminData.password;
    
    res.json({
      code: 200,
      message: '创建成功',
      data: adminData
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '创建失败',
      error: error.message
    });
  }
});

// 更新BD用户信息（需要管理员权限）
router.put('/:id', authenticate, authorize('admin'), operationLog('admins', '更新BD用户'), async (req, res) => {
  try {
    const { name, contact, password, status, role } = req.body;
    
    const admin = await Admin.findByPk(req.params.id);
    
    if (!admin) {
      return res.status(404).json({
        code: 404,
        message: '管理员不存在'
      });
    }
    
    // 不允许修改管理员角色为admin（防止权限提升）
    if (role && role === 'admin' && admin.role !== 'admin') {
      return res.status(403).json({
        code: 403,
        message: '无权将用户提升为管理员'
      });
    }
    
    // 更新字段
    if (name !== undefined) admin.name = name;
    if (contact !== undefined) admin.contact = contact || null; // 允许设置为null或空字符串
    if (password) admin.password = password; // 会在模型hook中自动加密
    if (status !== undefined) admin.status = parseInt(status);
    if (role && admin.role !== 'admin') admin.role = role; // 只有非管理员才能修改角色
    
    await admin.save();
    
    // 重新查询以确保获取最新数据（包括所有字段）
    const updatedAdmin = await Admin.findByPk(req.params.id, {
      attributes: { exclude: ['password'] }
    });
    
    res.json({
      code: 200,
      message: '更新成功',
      data: updatedAdmin
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '更新失败',
      error: error.message
    });
  }
});

// 删除BD用户（需要管理员权限）
router.delete('/:id', authenticate, authorize('admin'), operationLog('admins', '删除BD用户'), async (req, res) => {
  try {
    const admin = await Admin.findByPk(req.params.id);
    
    if (!admin) {
      return res.status(404).json({
        code: 404,
        message: '管理员不存在'
      });
    }
    
    // 不允许删除管理员
    if (admin.role === 'admin') {
      return res.status(403).json({
        code: 403,
        message: '不能删除管理员账户'
      });
    }
    
    await admin.destroy();
    
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

// 获取所有BD用户（用于下拉选择）
router.get('/list/bd', authenticate, operationLog('admins', '获取BD列表'), async (req, res) => {
  try {
    const bds = await Admin.findAll({
      where: {
        role: 'bd',
        status: 1
      },
      attributes: ['id', 'username', 'name', 'contact'],
      order: [['created_at', 'DESC']]
    });
    
    res.json({
      code: 200,
      message: '获取成功',
      data: bds
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// Excel导入BD用户（需要管理员权限）
router.post('/import', authenticate, authorize('admin'), upload.single('file'), operationLog('admins', 'Excel导入BD用户'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        code: 400,
        message: '请上传Excel文件'
      });
    }
    
    // 解析Excel
    let excelData;
    try {
      excelData = parseBdExcel(req.file.buffer);
    } catch (error) {
      return res.status(400).json({
        code: 400,
        message: 'Excel解析失败',
        error: error.message
      });
    }
    
    if (excelData.length === 0) {
      return res.status(400).json({
        code: 400,
        message: 'Excel文件中没有有效数据'
      });
    }
    
    const results = [];
    const defaultPassword = req.body.defaultPassword || '123456'; // 默认密码，可以从请求中获取
    
    for (const row of excelData) {
      const { username, password, name, contact, row: rowNum } = row;
      
      // 验证必填字段
      if (!username) {
        results.push({
          row: rowNum,
          username,
          name,
          contact,
          success: false,
          message: '用户名为空'
        });
        continue;
      }
      
      // 检查用户名是否已存在
      const existing = await Admin.findOne({ where: { username } });
      
      if (existing) {
        results.push({
          row: rowNum,
          username,
          name,
          contact,
          success: false,
          message: '用户名已存在'
        });
        continue;
      }
      
      try {
        // 使用提供的密码或默认密码
        const finalPassword = password || defaultPassword;
        
        const admin = await Admin.create({
          username,
          password: finalPassword, // 会在模型hook中自动加密
          name: name || null,
          contact: contact || null,
          role: 'bd',
          status: 1
        });
        
        results.push({
          row: rowNum,
          username,
          name,
          contact,
          success: true,
          id: admin.id,
          message: '导入成功'
        });
      } catch (error) {
        results.push({
          row: rowNum,
          username,
          name,
          contact,
          success: false,
          message: error.message
        });
      }
    }
    
    const report = generateImportReport(results);
    
    res.json({
      code: 200,
      message: '导入完成',
      data: report
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '导入失败',
      error: error.message
    });
  }
});

module.exports = router;

