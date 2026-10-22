const express = require('express');
const router = express.Router();
const { Event, Invitation, Checkin } = require('../models');
const { authenticate } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');
const config = require('../config');
const { localize, setI18nField, I18N_FIELDS } = require('../utils/i18nData');

/**
 * 组装 i18n 树。
 *
 * 入参形态（前端传的）：
 *   i18n: {
 *     name: { 'zh-TW': '…', en: '…' },        // 简体不用放这里
 *     description: { 'zh-TW': '…', en: '…' }
 *   }
 * 出参（存库的）：
 *   { name: { 'zh-CN': '…', 'zh-TW': '…', en: '…' }, … }
 *
 * 简体从原字段取（name/description/location 本来就是简体基准列），
 * 这样即使 i18n 整棵树丢了，简体也不会丢。
 */
function buildI18nTree(i18nIn, base) {
  const tree = {};
  const src = (i18nIn && typeof i18nIn === 'object') ? i18nIn : {};
  I18N_FIELDS.forEach(f => {
    const node = src[f] && typeof src[f] === 'object' ? src[f] : {};
    setI18nField(tree, f, base ? base[f] : '', node);
  });
  return Object.keys(tree).length ? tree : null;
}

/**
 * 公开接口：按当前语言返回活动信息（给 H5 / 嘉宾端用）。
 *
 * 为什么不用后台的 GET /events：
 *   后台要拿到**原始字段**才能编辑（name / name_tw / name_en 都要给），
 *   这里则需要「按当前语言解析后的展示值」。两者用途不同，故分开。
 *
 * 语言来源优先级：?lang= 查询参数 > 请求头 Accept-Language > 默认简体
 */
function resolveLang(req) {
  const q = req.query && req.query.lang;
  if (q && ['zh-CN', 'zh-TW', 'en'].indexOf(q) >= 0) return q;
  const h = req.headers && (req.headers['accept-language'] || '');
  const nav = String(h).toLowerCase();
  if (nav.indexOf('zh-tw') === 0 || nav.indexOf('zh-hk') === 0 || nav.indexOf('zh-hant') === 0) return 'zh-TW';
  if (nav.indexOf('en') === 0) return 'en';
  return 'zh-CN';
}

// 公开：按语言取活动（无需登录）
router.get('/public', async (req, res) => {
  try {
    const lang = resolveLang(req);
    const { id, status } = req.query;
    const where = {};
    if (id) where.id = id;
    else where.status = status !== undefined ? status : 1;
    const events = await Event.findAll({
      where,
      order: [['created_at', 'DESC']]
    });
    res.json({
      code: 200,
      message: '获取成功',
      data: {
        lang,
        list: events.map(e => localize(e, lang, I18N_FIELDS))
      }
    });
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取失败', error: error.message });
  }
});

// 获取所有活动（需要认证）
router.get('/', authenticate, operationLog('events', '获取活动列表'), async (req, res) => {
  try {
    const { page = 1, pageSize = 10, status } = req.query;
    const offset = (page - 1) * pageSize;
    
    const where = {};
    if (status !== undefined) {
      where.status = status;
    }
    
    const { count, rows } = await Event.findAndCountAll({
      where,
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

// 获取单个活动详情
// ⚠️ 静态路径必须放在 '/:id' 之前，否则会被动态路由吃掉
/**
 * 自动翻译接口（后台填活动时用）
 *
 * POST /api/events/translate
 *   { text: '简体中文原文', targets: ['zh-TW','en'] }
 *   → { code:200, data:{ results:{ 'zh-TW':'…', en:'…' } } }
 *
 * 繁体翻译走「简→繁」，英文走「简→英」，各自独立请求。
 */
router.post('/translate', authenticate, async (req, res) => {
  const { text, targets } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ code: 400, message: '待翻译内容不能为空' });
  }
  try {
    const { translateBatch, isConfigured } = require('../services/translateService');
    if (!isConfigured()) {
      return res.status(503).json({
        code: 503,
        message: '翻译服务未配置',
        hint: '需要在 .env 配置 TENCENT_TMT_APPID 与 TENCENT_TMT_SECRET'
      });
    }
    const r = await translateBatch(text, targets);
    if (!r.ok) {
      return res.status(502).json({
        code: 502,
        message: '翻译失败',
        errors: r.errors
      });
    }
    res.json({ code: 200, message: '翻译成功', data: { results: r.results } });
  } catch (error) {
    res.status(500).json({ code: 500, message: '翻译服务异常', error: error.message });
  }
});

/** 翻译服务是否可用（前端按钮据此决定是否可点） */
router.get('/translate/status', authenticate, (req, res) => {
  const { isConfigured } = require('../services/translateService');
  res.json({ code: 200, data: { configured: isConfigured() } });
});

router.get('/:id(\\d+)', authenticate, async (req, res) => {
  try {
    const event = await Event.findByPk(req.params.id, {
      include: [
        {
          model: Invitation,
          as: 'invitations',
          include: ['guest']
        }
      ]
    });
    
    if (!event) {
      return res.status(404).json({
        code: 404,
        message: '活动不存在'
      });
    }
    
    res.json({
      code: 200,
      message: '获取成功',
      data: event
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// 创建活动（需要认证）
router.post('/', authenticate, operationLog('events', '创建活动'), async (req, res) => {
  try {
    const { name, description, start_time, end_time, location, page_url, status, extra_fields } = req.body;
    const i18nIn = req.body.i18n;
    
    // 验证必填字段
    if (!name || !start_time || !end_time) {
      return res.status(400).json({
        code: 400,
        message: '活动名称、开始时间和结束时间不能为空'
      });
    }
    
    // 处理extra_fields，确保是有效的JSON
    let processedExtraFields = null;
    if (extra_fields) {
      if (typeof extra_fields === 'string') {
        try {
          processedExtraFields = JSON.parse(extra_fields);
        } catch (e) {
          processedExtraFields = extra_fields;
        }
      } else if (typeof extra_fields === 'object') {
        processedExtraFields = extra_fields;
      }
    }
    
    const event = await Event.create({
      name,
      description,
      start_time,
      end_time,
      location,
      page_url,
      status: status !== undefined ? status : 1,
      extra_fields: processedExtraFields,
      i18n: buildI18nTree(i18nIn, { name, description, location })
    });
    
    res.status(201).json({
      code: 201,
      message: '创建成功',
      data: event
    });
  } catch (error) {
    console.error('创建活动错误:', error);
    res.status(500).json({
      code: 500,
      message: '创建失败',
      error: error.message,
      stack: config.server.env === 'development' ? error.stack : undefined
    });
  }
});

// 更新活动（需要认证）
router.put('/:id', authenticate, operationLog('events', '更新活动'), async (req, res) => {
  try {
    const { name, description, start_time, end_time, location, page_url, status, extra_fields } = req.body;
    const i18nIn = req.body.i18n;
    
    const event = await Event.findByPk(req.params.id);
    
    if (!event) {
      return res.status(404).json({
        code: 404,
        message: '活动不存在'
      });
    }
    
    // 处理extra_fields
    let processedExtraFields = event.extra_fields;
    if (extra_fields !== undefined) {
      if (extra_fields === null) {
        processedExtraFields = null;
      } else if (typeof extra_fields === 'string') {
        try {
          processedExtraFields = JSON.parse(extra_fields);
        } catch (e) {
          processedExtraFields = extra_fields;
        }
      } else if (typeof extra_fields === 'object') {
        processedExtraFields = extra_fields;
      }
    }
    
    await event.update({
      name: name || event.name,
      description: description !== undefined ? description : event.description,
      start_time: start_time || event.start_time,
      end_time: end_time || event.end_time,
      location: location !== undefined ? location : event.location,
      page_url: page_url !== undefined ? page_url : event.page_url,
      status: status !== undefined ? status : event.status,
      extra_fields: processedExtraFields,
      i18n: buildI18nTree(i18nIn, {
        name: name || event.name,
        description: description !== undefined ? description : event.description,
        location: location !== undefined ? location : event.location
      })
    });
    
    res.json({
      code: 200,
      message: '更新成功',
      data: event
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '更新失败',
      error: error.message
    });
  }
});

// 删除活动（需要认证）
router.delete('/:id', authenticate, operationLog('events', '删除活动'), async (req, res) => {
  try {
    const event = await Event.findByPk(req.params.id);
    if (!event) {
      return res.status(404).json({
        code: 404,
        message: '活动不存在'
      });
    }
    
    await event.destroy();
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

// 获取活动统计信息
router.get('/:id/statistics', authenticate, async (req, res) => {
  try {
    const event = await Event.findByPk(req.params.id);
    if (!event) {
      return res.status(404).json({
        code: 404,
        message: '活动不存在'
      });
    }
    
    const invitationCount = await Invitation.count({
      where: { event_id: event.id }
    });
    
    const checkinCount = await Checkin.count({
      where: { event_id: event.id }
    });
    
    res.json({
      code: 200,
      message: '获取成功',
      data: {
        event: event,
        invitationCount,
        checkinCount,
        checkinRate: invitationCount > 0 ? ((checkinCount / invitationCount) * 100).toFixed(2) : 0
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

