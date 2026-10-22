const jwt = require('jsonwebtoken');
const { Admin } = require('../models');
const config = require('../config');

/**
 * JWT认证中间件
 */
const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        code: 401,
        message: '未登录，请先登录'
      });
    }
    
    const decoded = jwt.verify(token, config.jwt.secret);
    const admin = await Admin.findByPk(decoded.id);
    
    if (!admin || admin.status === 0) {
      return res.status(401).json({
        code: 401,
        message: '用户不存在或已被禁用'
      });
    }
    
    // 单点登录验证：检查token版本号是否与数据库一致
    // 如果token中的版本号小于数据库中的版本号，说明该token已被新登录替换
    const tokenVersion = decoded.token_version || 0;
    const dbTokenVersion = admin.token_version || 0;
    
    if (tokenVersion < dbTokenVersion) {
      return res.status(401).json({
        code: 401,
        message: '您的账号已在其他设备登录，当前登录已失效，请重新登录'
      });
    }
    
    req.user = {
      id: admin.id,
      username: admin.username,
      name: admin.name,
      role: admin.role
    };
    
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({
        code: 401,
        message: 'Token无效或已过期'
      });
    }
    
    res.status(500).json({
      code: 500,
      message: '认证失败',
      error: error.message
    });
  }
};

/**
 * 权限检查中间件
 * @param {string[]} allowedRoles - 允许的角色列表
 */
const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        code: 401,
        message: '未登录'
      });
    }
    
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        code: 403,
        message: '权限不足'
      });
    }
    
    next();
  };
};

module.exports = {
  authenticate,
  authorize
};

