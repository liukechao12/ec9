const express = require('express');
const router = express.Router();
const multer = require('multer');
const { Guest, Invitation, Event, Admin, sequelize } = require('../models');
const { Op } = require('sequelize');
const { encryptPhone, hashPhone, decryptPhone } = require('../utils/phoneCrypto');
const { parseExcel, validatePhone, generateImportReport } = require('../utils/excel');
const { authenticate } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');

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

// 获取所有嘉宾（需要认证）
router.get('/', authenticate, operationLog('guests', '获取嘉宾列表'), async (req, res) => {
  try {
    const { page = 1, pageSize = 10, keyword, status } = req.query;
    const offset = (page - 1) * pageSize;
    
    const where = {};
    // 默认只查询有效状态的嘉宾
    if (status !== undefined) {
      where.status = status;
    } else {
      where.status = 1; // 默认只显示有效的嘉宾
    }
    
    if (keyword) {
      where[Op.or] = [
        { name: { [Op.like]: `%${keyword}%` } },
        { company: { [Op.like]: `%${keyword}%` } },
        { position: { [Op.like]: `%${keyword}%` } }
      ];
    }
    
    // BD用户只能看到自己负责的嘉宾（通过邀约的source_bd字段关联）
    let includeOptions = [];
    if (req.user.role === 'bd') {
      includeOptions = [{
        model: Invitation,
        as: 'invitations',
        where: { source_bd: req.user.username, is_valid: 1 },
        required: true,
        attributes: ['source_bd', 'created_at']
      }];
    } else {
      // 非BD用户也需要关联邀约以获取source_bd信息
      includeOptions = [{
        model: Invitation,
        as: 'invitations',
        where: { is_valid: 1 },
        required: false,
        attributes: ['source_bd', 'created_at']
      }];
    }
    
    // 添加BD信息关联（通过bd_id关联到Admin的username）
    const allIncludes = [
      ...includeOptions,
      {
        model: Admin,
        as: 'bd',
        attributes: ['id', 'username', 'name'],
        required: false
      }
    ];
    
    // 查询嘉宾列表
    // 注意：如果position或tags字段不存在，Sequelize会报错
    // 使用try-catch处理字段不存在的情况
    let count, rows;
    try {
      const result = await Guest.findAndCountAll({
        where,
        include: allIncludes,
        attributes: ['id', 'name', 'phone', 'phone_hash', 'company', 'position', 'bd_id', 'status', 'remark', 'tags', 'extra_fields', 'created_at', 'updated_at'],
        limit: parseInt(pageSize),
        offset: parseInt(offset),
        order: [['created_at', 'DESC']],
        distinct: true // 避免count时重复计算
      });
      count = result.count;
      rows = result.rows;
    } catch (error) {
      // 如果字段不存在，使用明确指定的字段列表
      if (error.message && error.message.includes('Unknown column')) {
        console.warn('检测到数据库字段缺失，使用兼容模式查询:', error.message);
        const result = await Guest.findAndCountAll({
          where,
          include: allIncludes,
          attributes: ['id', 'name', 'phone', 'phone_hash', 'company', 'bd_id', 'status', 'remark', 'extra_fields', 'created_at', 'updated_at'],
          limit: parseInt(pageSize),
          offset: parseInt(offset),
          order: [['created_at', 'DESC']],
          distinct: true
        });
        count = result.count;
        rows = result.rows;
        // 为每个记录添加默认值
        rows.forEach(guest => {
          if (!guest.position) guest.position = null;
          if (!guest.tags) guest.tags = null;
        });
      } else {
        throw error;
      }
    }
    
    // 处理BD信息：优先使用邀约中的source_bd，如果bd_id关联失败
    // 收集所有需要查询的source_bd
    const sourceBdSet = new Set();
    for (const guest of rows) {
      // 获取最新的邀约（按创建时间排序）
      if (guest.invitations && guest.invitations.length > 0) {
        // 按创建时间排序，获取最新的邀约
        const sortedInvitations = guest.invitations.sort((a, b) => {
          const timeA = new Date(a.created_at || 0);
          const timeB = new Date(b.created_at || 0);
          return timeB - timeA;
        });
        const latestInvitation = sortedInvitations[0];
        const sourceBd = latestInvitation?.source_bd;
        
        // 如果bd关联为空，使用邀约中的source_bd
        if (!guest.bd && sourceBd) {
          sourceBdSet.add(sourceBd);
        }
      }
    }
    
    // 批量查询Admin用户
    const bdAdmins = {};
    if (sourceBdSet.size > 0) {
      const admins = await Admin.findAll({
        where: { username: { [Op.in]: Array.from(sourceBdSet) } },
        attributes: ['id', 'username', 'name']
      });
      admins.forEach(admin => {
        bdAdmins[admin.username] = admin;
      });
    }
    
    // 为每个嘉宾设置BD信息
    for (const guest of rows) {
      // 解密手机号供前端显示
      try {
        const plainPhone = guest.phone ? decryptPhone(guest.phone) : null;
        guest.phone = plainPhone;
        guest.setDataValue('phone_decrypted', plainPhone);
      } catch (e) {
        console.warn('解密手机号失败:', e);
      }
      // 获取最新的邀约
      if (guest.invitations && guest.invitations.length > 0) {
        const sortedInvitations = guest.invitations.sort((a, b) => {
          const timeA = new Date(a.created_at || 0);
          const timeB = new Date(b.created_at || 0);
          return timeB - timeA;
        });
        const latestInvitation = sortedInvitations[0];
        const sourceBd = latestInvitation?.source_bd;
        
        // 如果bd关联为空，使用邀约中的source_bd
        if (!guest.bd && sourceBd) {
          if (bdAdmins[sourceBd]) {
            guest.bd = bdAdmins[sourceBd];
          } else {
            // 如果找不到对应的Admin，至少保留source_bd作为bd_id
            guest.bd_id = sourceBd;
          }
        }
      }
    }
    
    // 统计各类标签的嘉宾数量（从extra_fields中读取）
    // 标签存储在extra_fields中，格式：{ "VIP": true, "技术": true, "高管": true }
    // 统计数据基于当前搜索条件
    let vipCount = 0;
    let techCount = 0;
    let execCount = 0;
    let totalAllGuests = 0; // 所有有效嘉宾总数（不受搜索影响）
    
    try {
      // 查询所有有效嘉宾的总数（不受搜索影响）
      totalAllGuests = await Guest.count({
        where: { status: 1 }
      });
      
      // 查询符合当前搜索条件的嘉宾的extra_fields
      const stats = await Guest.findAll({
        where, // 使用包含搜索条件的 where
        attributes: ['extra_fields'],
        raw: true
      });
      
      stats.forEach(guest => {
        if (guest.extra_fields) {
          try {
            const extraFields = typeof guest.extra_fields === 'string' 
              ? JSON.parse(guest.extra_fields) 
              : guest.extra_fields;
            
            if (typeof extraFields === 'object' && extraFields !== null) {
              // 检查VIP标签
              if (extraFields['VIP'] === true || extraFields['VIP'] === 'true' || extraFields['VIP'] === 1) {
                vipCount++;
              }
              // 检查技术标签
              if (extraFields['技术'] === true || extraFields['技术'] === 'true' || extraFields['技术'] === 1) {
                techCount++;
              }
              // 检查高管标签
              if (extraFields['高管'] === true || extraFields['高管'] === 'true' || extraFields['高管'] === 1) {
                execCount++;
              }
            }
          } catch (parseError) {
            // 忽略解析错误
            console.warn('解析extra_fields失败:', parseError.message);
          }
        }
      });
    } catch (e) {
      console.warn('标签统计查询失败:', e.message);
    }
    
    // 调试日志：输出统计数据
    console.log('标签统计数据:', { vip: vipCount, tech: techCount, exec: execCount });
    
    // 将Sequelize实例转换为JSON，确保extra_fields等JSON字段被正确序列化
    const guestList = rows.map(guest => {
      const guestData = guest.toJSON ? guest.toJSON() : guest.get ? guest.get({ plain: true }) : guest;
      
      // 确保extra_fields是对象格式
      if (guestData.extra_fields && typeof guestData.extra_fields === 'string') {
        try {
          guestData.extra_fields = JSON.parse(guestData.extra_fields);
        } catch (e) {
          console.warn('解析extra_fields失败:', e);
          guestData.extra_fields = null;
        }
      }
      
      return guestData;
    });
    
    const responseData = {
      code: 200,
      message: '获取成功',
      data: {
        list: guestList,
        total: count, // 搜索结果数量（受搜索关键词影响）
        totalAll: totalAllGuests, // 所有有效嘉宾总数（不受搜索影响）
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        stats: {
          vip: vipCount,
          tech: techCount,
          exec: execCount
        }
      }
    };
    
    // 调试日志：输出返回的统计数据
    console.log('返回的统计数据:', JSON.stringify(responseData.data.stats, null, 2));
    
    res.json(responseData);
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// 获取单个嘉宾详情（需要认证）

/**
 * GET /api/guests/export —— 导出嘉宾 Excel
 *
 * 之前只有邀约、订单能导出，嘉宾库是后台最常用的名单来源却导不出来，
 * 销售只能靠列表页肉眼抄。这里按列表页同样的筛选条件导出，
 * BD 角色只能导出自己名下（source_bd）的嘉宾。
 */
router.get('/export', authenticate, operationLog('guests', '导出嘉宾Excel'), async (req, res) => {
  try {
    const { keyword, event_id, status, source_bd, source } = req.query;
    const where = {};
    if (status !== undefined && status !== '') where.status = status;
    if (source) where.source = source;
    if (keyword) {
      where[Op.or] = [
        { name: { [Op.like]: `%${keyword}%` } },
        { company: { [Op.like]: `%${keyword}%` } },
        { position: { [Op.like]: `%${keyword}%` } }
      ];
    }
    // 嘉宾归属记在 bd_id（存的是 admins.username），可按负责人筛选
    if (source_bd) where.bd_id = source_bd;

    const include = [];
    if (event_id) {
      include.push({
        model: Invitation, as: 'invitations', required: true,
        where: { event_id: Number(event_id) }
      });
    }

    const guests = await Guest.findAll({ where, include, order: [['created_at', 'DESC']] });

    // 负责人展示名：bd_id 存的是 username，一次性拉 admin 建映射
    const adminMap = {};
    const owners = await Admin.findAll({ attributes: ['id', 'username', 'name'] });
    owners.forEach(a => { adminMap[a.username] = a.name || a.username; });

    const data = guests.map(g => {
      let phone = '';
      try { phone = g.phone ? (decryptPhone(g.phone) || '') : ''; } catch (e) { phone = ''; }
      return {
        嘉宾ID: g.id,
        姓名: g.name || '',
        手机号: phone,
        公司: g.company || '',
        职位: g.position || '',
        来源: g.source || '',
        负责人: adminMap[g.bd_id] || g.bd_id || '',
        状态: Number(g.status) === 1 ? '正常' : '已删除',
        创建时间: g.created_at ? new Date(g.created_at).toISOString().slice(0, 19).replace('T', ' ') : ''
      };
    });

    const XLSX = require('xlsx');
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '嘉宾');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', `attachment; filename="guests_${Date.now()}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buffer);
  } catch (error) {
    console.error('导出嘉宾失败:', error);
    res.status(500).json({ code: 500, message: '导出失败', error: error.message });
  }
});

router.get('/:id(\\d+)', authenticate, operationLog('guests', '获取嘉宾详情'), async (req, res) => {
  try {
    const includeOptions = [{
      model: Invitation,
      as: 'invitations',
      include: [{ model: Event, as: 'event' }]
    }];
    
    // BD用户只能查看自己负责的嘉宾
    if (req.user.role === 'bd') {
      includeOptions[0].where = { source_bd: req.user.username };
      includeOptions[0].required = true;
    }
    
    let guest;
    try {
      guest = await Guest.findByPk(req.params.id, {
        include: includeOptions,
        attributes: ['id', 'name', 'phone', 'phone_hash', 'company', 'position', 'bd_id', 'status', 'remark', 'tags', 'extra_fields', 'created_at', 'updated_at']
      });
    } catch (includeError) {
      // 如果include查询失败，尝试不使用include查询
      console.warn('Include查询失败，尝试直接查询:', includeError.message);
      guest = await Guest.findByPk(req.params.id, {
        attributes: ['id', 'name', 'phone', 'phone_hash', 'company', 'position', 'bd_id', 'status', 'remark', 'tags', 'extra_fields', 'created_at', 'updated_at']
      });
    }
    
    if (!guest) {
      return res.status(404).json({
        code: 404,
        message: '嘉宾不存在'
      });
    }
    
    // BD用户权限检查：如果嘉宾没有任何邀约，或者所有邀约都不是该BD负责的，则无权查看
    if (req.user.role === 'bd') {
      const hasAccess = guest.invitations && guest.invitations.length > 0;
      if (!hasAccess) {
        return res.status(403).json({
          code: 403,
          message: '无权访问此嘉宾'
        });
      }
    }
    
    // 将Sequelize实例转换为JSON，确保extra_fields等JSON字段被正确序列化
    let guestData;
    try {
      // 优先使用toJSON方法
      if (typeof guest.toJSON === 'function') {
        guestData = guest.toJSON();
      } else if (typeof guest.get === 'function') {
        guestData = guest.get({ plain: true });
      } else {
        // 最后尝试JSON序列化
        guestData = JSON.parse(JSON.stringify(guest));
      }
    } catch (e) {
      console.error('数据序列化失败:', e);
      // 如果序列化失败，尝试使用raw查询
      const rawGuest = await Guest.findByPk(req.params.id, {
        attributes: ['id', 'name', 'phone', 'phone_hash', 'company', 'position', 'bd_id', 'status', 'remark', 'tags', 'extra_fields', 'created_at', 'updated_at'],
        raw: true
      });
      guestData = rawGuest;
    }
    
    // 确保extra_fields是对象格式
    if (guestData && guestData.extra_fields !== null && guestData.extra_fields !== undefined) {
      if (typeof guestData.extra_fields === 'string') {
        try {
          guestData.extra_fields = JSON.parse(guestData.extra_fields);
        } catch (e) {
          console.warn('解析extra_fields失败:', e);
          guestData.extra_fields = null;
        }
      }
    }
    
    // 确保返回的数据结构正确
    if (!guestData) {
      return res.status(500).json({
        code: 500,
        message: '嘉宾数据序列化失败'
      });
    }
    
    res.json({
      code: 200,
      message: '获取成功',
      data: guestData
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// 创建嘉宾（支持单个和批量，需要认证）
router.post('/', authenticate, operationLog('guests', '创建嘉宾'), async (req, res) => {
  try {
    const { name, phone, company, bd_id, remark, guests } = req.body;
    
    // 批量导入
    if (guests && Array.isArray(guests)) {
      const results = [];
      for (const guestData of guests) {
        const { name, phone, company, bd_id, remark } = guestData;
        
        if (!name || !phone) {
          results.push({ name, phone, success: false, message: '姓名和手机号不能为空' });
          continue;
        }
        
        const phoneHash = hashPhone(phone);
        // 先检查是否存在任何状态的记录（包括已删除的）
        const existingAny = await Guest.findOne({ where: { phone_hash: phoneHash } });
        
        if (existingAny) {
          // 如果存在有效状态的记录，返回错误
          if (existingAny.status === 1) {
            results.push({ name, phone, success: false, message: '手机号已存在' });
            continue;
          }
          // 如果存在已删除状态的记录，恢复并更新它
          try {
            await existingAny.update({
              name,
              phone: encryptPhone(phone),
              phone_hash: phoneHash,
              company,
              position: guestData.position || null,
              bd_id,
              remark,
              tags: guestData.tags || null,
              extra_fields: guestData.extra_fields || null,
              status: 1
            });
            results.push({ name, phone, success: true, id: existingAny.id });
          } catch (error) {
            results.push({ name, phone, success: false, message: error.message });
          }
          continue;
        }
        
        try {
          const guest = await Guest.create({
            name,
            phone: encryptPhone(phone),
            phone_hash: phoneHash,
            company,
            position: guestData.position || null,
            bd_id,
            remark,
            tags: guestData.tags || null,
            extra_fields: guestData.extra_fields || null,
            status: 1
          });
          results.push({ name, phone, success: true, id: guest.id });
        } catch (error) {
          results.push({ name, phone, success: false, message: error.message });
        }
      }
      
      return res.status(201).json({
        code: 201,
        message: '批量导入完成',
        data: results
      });
    }
    
    // 单个创建
    if (!name || !phone) {
      return res.status(400).json({
        code: 400,
        message: '姓名和手机号不能为空'
      });
    }
    
    const phoneHash = hashPhone(phone);
    // 先检查是否存在任何状态的记录（包括已删除的）
    const existingAny = await Guest.findOne({ where: { phone_hash: phoneHash } });
    
    let guest;
    if (existingAny) {
      // 如果存在有效状态的记录，返回错误
      if (existingAny.status === 1) {
        return res.status(400).json({
          code: 400,
          message: '手机号已存在'
        });
      }
      // 如果存在已删除状态的记录，恢复并更新它
      await existingAny.update({
        name,
        phone: encryptPhone(phone),
        phone_hash: phoneHash,
        company,
        position: req.body.position || null,
        bd_id,
        remark,
        tags: req.body.tags || null,
        extra_fields: req.body.extra_fields || null,
        status: 1
      });
      guest = existingAny;
    } else {
      // 不存在任何记录，创建新记录
      guest = await Guest.create({
        name,
        phone: encryptPhone(phone),
        phone_hash: phoneHash,
        company,
        position: req.body.position || null,
        bd_id,
        remark,
        tags: req.body.tags || null,
        extra_fields: req.body.extra_fields || null,
        status: 1
      });
    }
    
    // 将Sequelize实例转换为JSON，确保extra_fields等JSON字段被正确序列化
    const guestData = guest.toJSON ? guest.toJSON() : guest.get ? guest.get({ plain: true }) : guest;
    
    // 确保extra_fields是对象格式
    if (guestData.extra_fields && typeof guestData.extra_fields === 'string') {
      try {
        guestData.extra_fields = JSON.parse(guestData.extra_fields);
      } catch (e) {
        console.warn('解析extra_fields失败:', e);
        guestData.extra_fields = null;
      }
    }
    
    res.status(201).json({
      code: 201,
      message: '创建成功',
      data: guestData
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '创建失败',
      error: error.message
    });
  }
});

// 更新嘉宾（需要认证）
router.put('/:id', authenticate, operationLog('guests', '更新嘉宾'), async (req, res) => {
  try {
    const guest = await Guest.findByPk(req.params.id, {
      include: [{
        model: Invitation,
        as: 'invitations',
        attributes: ['source_bd']
      }]
    });
    
    if (!guest) {
      return res.status(404).json({
        code: 404,
        message: '嘉宾不存在'
      });
    }
    
    // BD用户只能更新自己负责的嘉宾
    if (req.user.role === 'bd') {
      const hasAccess = guest.invitations && guest.invitations.some(inv => inv.source_bd === req.user.username);
      if (!hasAccess) {
        return res.status(403).json({
          code: 403,
          message: '无权更新此嘉宾'
        });
      }
    }
    
    const updateData = {};
    if (req.body.name) updateData.name = req.body.name;
    if (req.body.company) updateData.company = req.body.company;
    if (req.body.position !== undefined) updateData.position = req.body.position || null;
    if (req.body.bd_id !== undefined) updateData.bd_id = req.body.bd_id || null;
    if (req.body.remark !== undefined) updateData.remark = req.body.remark;
    if (req.body.tags !== undefined) updateData.tags = req.body.tags;
    if (req.body.status !== undefined) updateData.status = req.body.status;
    
    // 处理extra_fields（包括标签）
    if (req.body.extra_fields !== undefined) {
      // 如果extra_fields是对象，直接使用
      if (typeof req.body.extra_fields === 'object' && req.body.extra_fields !== null) {
        updateData.extra_fields = req.body.extra_fields;
        // 调试日志：记录接收到的extra_fields
        console.log('更新extra_fields:', JSON.stringify(req.body.extra_fields, null, 2));
        console.log('extra_fields键:', Object.keys(req.body.extra_fields));
      } else if (req.body.extra_fields === null) {
        // 如果明确设置为null，则清空
        updateData.extra_fields = null;
      } else {
        // 如果是字符串，尝试解析
        try {
          updateData.extra_fields = JSON.parse(req.body.extra_fields);
        } catch (e) {
          console.warn('解析extra_fields失败:', e);
          updateData.extra_fields = req.body.extra_fields;
        }
      }
    }
    
    // 如果更新手机号，需要重新加密
    if (req.body.phone) {
      updateData.phone = encryptPhone(req.body.phone);
      updateData.phone_hash = hashPhone(req.body.phone);
    }
    
    // 调试日志：记录要更新的数据
    console.log('更新数据:', JSON.stringify(updateData, null, 2));
    
    await guest.update(updateData);
    
    // 调试日志：验证更新后的数据
    const verifyGuest = await Guest.findByPk(req.params.id, { raw: true });
    console.log('更新后的extra_fields:', JSON.stringify(verifyGuest.extra_fields, null, 2));
    
    // 重新查询以获取最新的数据（包括extra_fields）
    const updatedGuest = await Guest.findByPk(req.params.id, {
      attributes: ['id', 'name', 'phone', 'phone_hash', 'company', 'position', 'bd_id', 'status', 'remark', 'tags', 'extra_fields', 'created_at', 'updated_at']
    });
    
    // 将Sequelize实例转换为JSON，确保extra_fields等JSON字段被正确序列化
    const guestData = updatedGuest ? (updatedGuest.toJSON ? updatedGuest.toJSON() : updatedGuest.get ? updatedGuest.get({ plain: true }) : updatedGuest) : null;
    
    // 确保extra_fields是对象格式
    if (guestData && guestData.extra_fields && typeof guestData.extra_fields === 'string') {
      try {
        guestData.extra_fields = JSON.parse(guestData.extra_fields);
      } catch (e) {
        console.warn('解析extra_fields失败:', e);
        guestData.extra_fields = null;
      }
    }
    
    res.json({
      code: 200,
      message: '更新成功',
      data: guestData
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '更新失败',
      error: error.message
    });
  }
});

// 删除嘉宾（标记为无效，用于嘉宾变更，需要认证）
router.delete('/:id', authenticate, operationLog('guests', '删除嘉宾'), async (req, res) => {
  try {
    const guest = await Guest.findByPk(req.params.id, {
      include: [{
        model: Invitation,
        as: 'invitations',
        attributes: ['id', 'invite_code', 'event_id', 'source_bd', 'is_valid']
      }]
    });
    
    if (!guest) {
      return res.status(404).json({
        code: 404,
        message: '嘉宾不存在'
      });
    }
    
    // BD用户只能删除自己负责的嘉宾
    if (req.user.role === 'bd') {
      const hasAccess = guest.invitations && guest.invitations.some(inv => inv.source_bd === req.user.username);
      if (!hasAccess) {
        return res.status(403).json({
          code: 403,
          message: '无权删除此嘉宾'
        });
      }
    }
    
    // 检查是否有有效的邀约记录
    const validInvitations = guest.invitations && guest.invitations.filter(inv => inv.is_valid === 1);
    
    if (validInvitations && validInvitations.length > 0) {
      const invitationCount = validInvitations.length;
      return res.status(400).json({
        code: 400,
        message: `该嘉宾还有 ${invitationCount} 个有效邀约，请先删除邀约后再删除嘉宾`,
        data: {
          invitationCount,
          invitations: validInvitations.map(inv => ({
            id: inv.id,
            invite_code: inv.invite_code,
            event_id: inv.event_id
          }))
        }
      });
    }
    
    // 标记为无效而不是真正删除
    await guest.update({ status: 0 });
    
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

// Excel导入嘉宾（需要认证）
router.post('/import', authenticate, upload.fields([{ name: 'file', maxCount: 1 }, { name: 'excel', maxCount: 1 }]), operationLog('guests', 'Excel导入嘉宾'), async (req, res) => {
  try {
    const uploadedFile = (req.files && (req.files.file?.[0] || req.files.excel?.[0])) || req.file;
    if (!uploadedFile) {
      return res.status(400).json({
        code: 400,
        message: '请上传Excel文件'
      });
    }
    
    // 解析Excel
    let excelData;
    try {
      excelData = parseExcel(uploadedFile.buffer);
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
    
    for (const row of excelData) {
      const { name, phone, company, bd_id, remark, row: rowNum } = row;
      const inviterBdId = bd_id && String(bd_id).trim() ? String(bd_id).trim() : null;
      
      // 验证手机号格式
      if (!validatePhone(phone)) {
        results.push({
          row: rowNum,
          name,
          phone,
          company,
          success: false,
          message: '手机号格式不正确'
        });
        continue;
      }
      
      // 检查手机号是否已存在（包括已删除状态的记录）
      const phoneHash = hashPhone(phone);
      const existingAny = await Guest.findOne({ where: { phone_hash: phoneHash } });
      
      if (existingAny) {
        // 如果存在有效状态的记录，返回错误
        if (existingAny.status === 1) {
          results.push({
            row: rowNum,
            name,
            phone,
            company,
            success: false,
            message: '手机号已存在'
          });
          continue;
        }
        // 如果存在已删除状态的记录，恢复并更新它
        try {
          await existingAny.update({
            name,
            phone: encryptPhone(phone),
            phone_hash: phoneHash,
            company,
            position: row.position || null,
            remark,
            tags: row.tags || null,
            ...(inviterBdId ? { bd_id: inviterBdId } : {}),
            status: 1
          });
          results.push({
            row: rowNum,
            name,
            phone,
            company,
            success: true,
            id: existingAny.id,
            message: '导入成功（已恢复已删除的嘉宾）'
          });
        } catch (error) {
          results.push({
            row: rowNum,
            name,
            phone,
            company,
            success: false,
            message: error.message
          });
        }
        continue;
      }
      
      try {
        const guest = await Guest.create({
          name,
          phone: encryptPhone(phone),
          phone_hash: phoneHash,
          company,
          position: row.position || null,
          remark,
          tags: row.tags || null,
          bd_id: inviterBdId,
          status: 1
        });
        
        results.push({
          row: rowNum,
          name,
          phone,
          company,
          success: true,
          id: guest.id,
          message: '导入成功'
        });
      } catch (error) {
        results.push({
          row: rowNum,
          name,
          phone,
          company,
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

// 获取嘉宾修改历史（需要认证）
router.get('/:id/modification-history', authenticate, operationLog('guests', '获取修改历史'), async (req, res) => {
  try {
    const guest = await Guest.findByPk(req.params.id);
    
    if (!guest) {
      return res.status(404).json({
        code: 404,
        message: '嘉宾不存在'
      });
    }
    
    const history = guest.modification_history || [];
    
    res.json({
      code: 200,
      message: '获取成功',
      data: {
        guest_id: guest.id,
        guest_name: guest.name,
        history: history.reverse() // 最新的在前
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
