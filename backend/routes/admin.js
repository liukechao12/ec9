const express = require('express');
const router = express.Router();
const { Admin } = require('../models');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticate, authorize } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');
const config = require('../config');

// 管理员登录
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({
        code: 400,
        message: '用户名和密码不能为空'
      });
    }
    
    const admin = await Admin.findOne({
      where: { username, status: 1 }
    });
    
    if (!admin) {
      return res.status(401).json({
        code: 401,
        message: '用户名或密码错误'
      });
    }
    
    const isValid = await admin.validatePassword(password);
    if (!isValid) {
      return res.status(401).json({
        code: 401,
        message: '用户名或密码错误'
      });
    }
    
    // 更新最后登录信息和token版本号（实现单点登录：新登录会使旧token失效）
    const newTokenVersion = (admin.token_version || 0) + 1;
    await admin.update({
      last_login_time: new Date(),
      last_login_ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
      token_version: newTokenVersion
    });
    
    // 生成JWT token
    // 确保 expiresIn 是正确的格式（秒数）
    // 如果配置是数字，直接使用；否则转换为数字或使用默认值7天
    let expiresIn = config.jwt.expiresIn;
    if (typeof expiresIn !== 'number') {
      // 如果是字符串，尝试解析（如 '7d', '604800' 等）
      if (typeof expiresIn === 'string') {
        // 支持 '7d', '24h' 等格式
        if (expiresIn.includes('d')) {
          expiresIn = parseInt(expiresIn) * 24 * 60 * 60;
        } else if (expiresIn.includes('h')) {
          expiresIn = parseInt(expiresIn) * 60 * 60;
        } else {
          expiresIn = parseInt(expiresIn) || 604800; // 默认7天
        }
      } else {
        expiresIn = 604800; // 默认7天（604800秒）
      }
    }
    
    // 确保最小值为1小时，防止设置过短
    if (expiresIn < 3600) {
      expiresIn = 604800; // 如果小于1小时，强制使用7天
    }
    
    // 在JWT中包含token_version，用于单点登录验证
    const token = jwt.sign(
      { 
        id: admin.id, 
        username: admin.username, 
        role: admin.role,
        token_version: newTokenVersion  // 包含token版本号
      },
      config.jwt.secret,
      { expiresIn }
    );
    
    res.json({
      code: 200,
      message: '登录成功',
      data: {
        token,
        admin: {
          id: admin.id,
          username: admin.username,
          name: admin.name,
          role: admin.role
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '登录失败',
      error: error.message
    });
  }
});

// 获取当前管理员信息（使用authenticate中间件，自动包含单点登录验证）
router.get('/me', authenticate, async (req, res) => {
  try {
    const admin = await Admin.findByPk(req.user.id);
    
    if (!admin) {
      return res.status(404).json({
        code: 404,
        message: '管理员不存在'
      });
    }
    
    res.json({
      code: 200,
      message: '获取成功',
      data: {
        id: admin.id,
        username: admin.username,
        name: admin.name,
        role: admin.role
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

// 创建管理员（需要管理员权限）
router.post('/', authenticate, authorize('admin'), operationLog('admin', '创建管理员'), async (req, res) => {
  try {
    const { username, password, name, role = 'admin' } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({
        code: 400,
        message: '用户名和密码不能为空'
      });
    }
    
    const existingAdmin = await Admin.findOne({ where: { username } });
    if (existingAdmin) {
      return res.status(400).json({
        code: 400,
        message: '用户名已存在'
      });
    }
    
    const admin = await Admin.create({
      username,
      password,
      name,
      role
    });
    
    res.status(201).json({
      code: 201,
      message: '创建成功',
      data: {
        id: admin.id,
        username: admin.username,
        name: admin.name,
        role: admin.role
      }
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '创建失败',
      error: error.message
    });
  }
});

// 获取所有管理员（需要认证）
router.get('/', authenticate, operationLog('admin', '获取管理员列表'), async (req, res) => {
  try {
    const admins = await Admin.findAll({
      attributes: ['id', 'username', 'name', 'role', 'status', 'last_login_time', 'created_at'],
      order: [['created_at', 'DESC']]
    });
    
    res.json({
      code: 200,
      message: '获取成功',
      data: admins
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// 修改当前登录用户密码（需要认证）
router.put('/change-password', authenticate, operationLog('admin', '修改密码'), async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    
    if (!oldPassword || !newPassword) {
      return res.status(400).json({
        code: 400,
        message: '旧密码和新密码不能为空'
      });
    }
    
    if (newPassword.length < 6) {
      return res.status(400).json({
        code: 400,
        message: '新密码长度不能少于6位'
      });
    }
    
    // 获取当前用户
    const admin = await Admin.findByPk(req.user.id);
    
    if (!admin) {
      return res.status(404).json({
        code: 404,
        message: '用户不存在'
      });
    }
    
    // 验证旧密码
    const isValid = await admin.validatePassword(oldPassword);
    if (!isValid) {
      return res.status(401).json({
        code: 401,
        message: '旧密码错误'
      });
    }
    
    // 更新密码（会在模型hook中自动加密）
    await admin.update({
      password: newPassword
    });
    
    res.json({
      code: 200,
      message: '密码修改成功'
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '修改失败',
      error: error.message
    });
  }
});

module.exports = router;

