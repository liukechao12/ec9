const express = require('express');
const router = express.Router();
const { SmsTemplate, SmsRule, SmsLog } = require('../models');
const { authenticate } = require('../middleware/auth');
const operationLog = require('../middleware/operationLog');
const { SmsService } = require('../services/SmsService');

// 短信模板列表
router.get('/templates', authenticate, operationLog('sms_templates', '获取短信模板列表'), async (req, res) => {
  try {
    const { lang } = req.query;
    const where = {};
    if (lang && lang !== 'ALL') where.lang = lang;
    const list = await SmsTemplate.findAll({ where, order: [['id', 'DESC']] });
    res.json({
      code: 200,
      message: '获取成功',
      data: list
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// 创建模板
router.post('/templates', authenticate, operationLog('sms_templates', '创建短信模板'), async (req, res) => {
  try {
    const { name, message_type, scene, aliyun_template_code, sign_name, params_schema, enabled, remark, lang } = req.body;
    
    // 参数验证
    if (!name || !message_type || !aliyun_template_code || !sign_name) {
      return res.status(400).json({
        code: 400,
        message: '模板名称、短信类型、阿里云模板CODE和签名不能为空'
      });
    }

    // 语种校验 + 同类型同场景同语种唯一
    const finalLang = SmsService.LANGS.indexOf(lang) >= 0 ? lang : SmsService.DEFAULT_LANG;
    const finalScene = (scene || 'COMMON').trim();
    const dup = await SmsTemplate.findOne({
      where: { message_type: message_type.trim(), scene: finalScene, lang: finalLang }
    });
    if (dup) {
      return res.status(400).json({
        code: 400,
        message: `该短信类型在该场景下已存在「${finalLang}」语种模板，请直接修改原模板`
      });
    }
    
    // 处理params_schema：如果是数组，直接使用；如果是字符串，尝试解析
    let processedParamsSchema = null;
    if (params_schema) {
      if (Array.isArray(params_schema)) {
        processedParamsSchema = params_schema;
      } else if (typeof params_schema === 'string') {
        try {
          processedParamsSchema = JSON.parse(params_schema);
        } catch (e) {
          return res.status(400).json({
            code: 400,
            message: '参数结构格式错误，必须是有效的JSON数组'
          });
        }
      } else {
        processedParamsSchema = params_schema;
      }
    }
    
    // 创建模板
    const template = await SmsTemplate.create({
      name: name.trim(),
      message_type: message_type.trim(),
      scene: finalScene,
      lang: finalLang,
      aliyun_template_code: aliyun_template_code.trim(),
      sign_name: sign_name.trim(),
      params_schema: processedParamsSchema,
      enabled: enabled !== undefined ? (enabled === 1 || enabled === true ? 1 : 0) : 1,
      remark: remark ? remark.trim() : null
    });
    
    res.json({
      code: 200,
      message: '创建成功',
      data: template
    });
  } catch (error) {
    console.error('创建短信模板失败:', error);
    res.status(500).json({
      code: 500,
      message: '创建失败',
      error: require('../config').server.env === 'development' ? error.message : '服务器错误，请稍后重试'
    });
  }
});

// 更新模板
router.put('/templates/:id', authenticate, operationLog('sms_templates', '更新短信模板'), async (req, res) => {
  try {
    const template = await SmsTemplate.findByPk(req.params.id);
    if (!template) {
      return res.status(404).json({
        code: 404,
        message: '模板不存在'
      });
    }
    
    const { name, message_type, scene, aliyun_template_code, sign_name, params_schema, enabled, remark, lang } = req.body;
    
    // 语种变更时校验唯一（同类型 + 同场景 + 同语种不能重复）
    if (lang !== undefined || message_type !== undefined || scene !== undefined) {
      const newLang = SmsService.LANGS.indexOf(lang) >= 0 ? lang : template.lang;
      const newType = message_type !== undefined ? message_type.trim() : template.message_type;
      const newScene = scene !== undefined ? scene : template.scene;
      const dup = await SmsTemplate.findOne({
        where: { message_type: newType, scene: newScene, lang: newLang }
      });
      if (dup && dup.id !== template.id) {
        return res.status(400).json({
          code: 400,
          message: `该短信类型在该场景下已存在「${newLang}」语种模板`
        });
      }
    }

    // 处理params_schema
    let processedParamsSchema = undefined;
    if (params_schema !== undefined) {
      if (Array.isArray(params_schema)) {
        processedParamsSchema = params_schema;
      } else if (typeof params_schema === 'string') {
        try {
          processedParamsSchema = JSON.parse(params_schema);
        } catch (e) {
          return res.status(400).json({
            code: 400,
            message: '参数结构格式错误，必须是有效的JSON数组'
          });
        }
      } else {
        processedParamsSchema = params_schema;
      }
    }
    
    // 构建更新对象
    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (message_type !== undefined) updateData.message_type = message_type.trim();
    if (scene !== undefined) updateData.scene = scene;
    if (lang !== undefined && SmsService.LANGS.indexOf(lang) >= 0) updateData.lang = lang;
    if (aliyun_template_code !== undefined) updateData.aliyun_template_code = aliyun_template_code.trim();
    if (sign_name !== undefined) updateData.sign_name = sign_name.trim();
    if (processedParamsSchema !== undefined) updateData.params_schema = processedParamsSchema;
    if (enabled !== undefined) updateData.enabled = enabled === 1 || enabled === true ? 1 : 0;
    if (remark !== undefined) updateData.remark = remark ? remark.trim() : null;
    
    await template.update(updateData);
    res.json({
      code: 200,
      message: '更新成功',
      data: template
    });
  } catch (error) {
    console.error('更新短信模板失败:', error);
    res.status(500).json({
      code: 500,
      message: '更新失败',
      error: require('../config').server.env === 'development' ? error.message : '服务器错误，请稍后重试'
    });
  }
});

// 删除模板
router.delete('/templates/:id', authenticate, operationLog('sms_templates', '删除短信模板'), async (req, res) => {
  try {
    const template = await SmsTemplate.findByPk(req.params.id);
    if (!template) {
      return res.status(404).json({
        code: 404,
        message: '模板不存在'
      });
    }
    await template.destroy();
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

// 规则列表
router.get('/rules', authenticate, operationLog('sms_rules', '获取短信规则列表'), async (req, res) => {
  try {
    const list = await SmsRule.findAll({
      order: [['id', 'DESC']]
    });
    res.json({
      code: 200,
      message: '获取成功',
      data: list
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// 创建规则
router.post('/rules', authenticate, operationLog('sms_rules', '创建短信规则'), async (req, res) => {
  try {
    const rule = await SmsRule.create(req.body);
    
    // 如果是定时规则，更新定时任务
    if (rule.trigger_type === 'SCHEDULED' && rule.enabled === 1) {
      const scheduledSmsService = require('../services/ScheduledSmsService');
      scheduledSmsService.updateRuleSchedule(rule.id);
    }
    
    res.json({
      code: 200,
      message: '创建成功',
      data: rule
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '创建失败',
      error: error.message
    });
  }
});

// 更新规则
router.put('/rules/:id', authenticate, operationLog('sms_rules', '更新短信规则'), async (req, res) => {
  try {
    const rule = await SmsRule.findByPk(req.params.id);
    if (!rule) {
      return res.status(404).json({
        code: 404,
        message: '规则不存在'
      });
    }
    
    const oldTriggerType = rule.trigger_type;
    const oldEnabled = rule.enabled;
    
    await rule.update(req.body);
    
    // 重新加载规则以获取最新数据
    await rule.reload();
    
    // 如果规则类型或启用状态改变，更新定时任务
    const scheduledSmsService = require('../services/ScheduledSmsService');
    if (oldTriggerType === 'SCHEDULED' || rule.trigger_type === 'SCHEDULED') {
      if (rule.trigger_type === 'SCHEDULED' && rule.enabled === 1) {
        scheduledSmsService.updateRuleSchedule(rule.id);
      } else {
        scheduledSmsService.stopRuleSchedule(rule.id);
      }
    }
    
    res.json({
      code: 200,
      message: '更新成功',
      data: rule
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '更新失败',
      error: error.message
    });
  }
});

// 删除规则
router.delete('/rules/:id', authenticate, operationLog('sms_rules', '删除短信规则'), async (req, res) => {
  try {
    const rule = await SmsRule.findByPk(req.params.id);
    if (!rule) {
      return res.status(404).json({
        code: 404,
        message: '规则不存在'
      });
    }
    
    // 如果是定时规则，停止定时任务
    if (rule.trigger_type === 'SCHEDULED') {
      const scheduledSmsService = require('../services/ScheduledSmsService');
      scheduledSmsService.stopRuleSchedule(rule.id);
    }
    
    await rule.destroy();
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

// 短信日志列表
router.get('/logs', authenticate, operationLog('sms_logs', '获取短信日志'), async (req, res) => {
  try {
    const { page = 1, pageSize = 20, message_type, event_id, guest_id } = req.query;
    const where = {};
    if (message_type) where.message_type = message_type;
    if (event_id) where.event_id = event_id;
    if (guest_id) where.guest_id = guest_id;

    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
    const { count, rows } = await SmsLog.findAndCountAll({
      where,
      order: [['id', 'DESC']],
      limit: parseInt(pageSize, 10),
      offset
    });

    res.json({
      code: 200,
      message: '获取成功',
      data: {
        list: rows,
        total: count,
        page: parseInt(page, 10),
        pageSize: parseInt(pageSize, 10)
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

// 通用短信发送接口（可直接传入模板CODE和参数，H5公开接口）
router.post('/send-direct', authenticate, async (req, res) => {
  try {
    const { phone, template_code, sign_name, params } = req.body;
    
    if (!phone || !template_code || !sign_name) {
      return res.status(400).json({
        code: 400,
        message: '手机号、模板CODE和签名不能为空'
      });
    }
    
    // 验证手机号格式
    if (phone.length !== 11 || !/^1[3-9]\d{9}$/.test(phone)) {
      return res.status(400).json({
        code: 400,
        message: '请输入正确的手机号'
      });
    }
    
    const { sendSms } = require('../utils/aliyunSmsClient');
    
    // 发送短信
    const resp = await sendSms({
      PhoneNumbers: phone,
      SignName: sign_name,
      TemplateCode: template_code,
      TemplateParam: params ? JSON.stringify(params) : '{}'
    });
    
    // 检查响应
    const respCode = resp?.Code || resp?.code || resp?.body?.Code || resp?.body?.code;
    const respMessage = resp?.Message || resp?.message || resp?.body?.Message || resp?.body?.message;
    
    if (respCode === 'OK') {
      res.json({
        code: 200,
        message: '短信发送成功',
        data: {
          phone: phone
        }
      });
    } else {
      res.status(400).json({
        code: 400,
        message: `短信发送失败：${respMessage || '未知错误'}`,
        error_code: respCode || 'UNKNOWN_ERROR'
      });
    }
  } catch (error) {
    console.error('发送短信失败:', error);
    res.status(500).json({
      code: 500,
      message: '发送失败',
      error: error.message
    });
  }
});

// 手动触发发送短信
router.post('/send', authenticate, operationLog('sms', '手动发送短信'), async (req, res) => {
  try {
    const { message_type, guest_id, event_id, invitation_id, phone } = req.body;
    if (!message_type) {
      return res.status(400).json({
        code: 400,
        message: 'message_type 不能为空'
      });
    }

    // 发送短信并获取结果
    await SmsService.sendMessage(message_type, { lang: SmsService.normalizeLang(req.body && req.body.lang),
      guestId: guest_id,
      eventId: event_id,
      invitationId: invitation_id,
      phone
    });

    // 等待一下，确保日志已写入
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // 查询最新的发送日志来判断是否成功
    const latestLog = await SmsLog.findOne({
      where: {
        message_type
      },
      order: [['created_at', 'DESC']],
      limit: 1
    });

    if (latestLog) {
      // 检查发送状态
      if (latestLog.status === 1 && !latestLog.error_code) {
        res.json({
          code: 200,
          message: '短信发送成功',
          data: {
            log_id: latestLog.id,
            status: 'success'
          }
        });
      } else {
        // 如果error_message和error_code都为空，尝试从response_raw中解析
        let errorMsg = latestLog.error_message || latestLog.error_code || '发送失败';
        let errorCode = latestLog.error_code;
        
        // 如果日志中没有错误信息，尝试从response_raw解析
        if (!latestLog.error_message && !latestLog.error_code && latestLog.response_raw) {
          try {
            const responseData = typeof latestLog.response_raw === 'string' 
              ? JSON.parse(latestLog.response_raw) 
              : latestLog.response_raw;
            errorCode = responseData.Code || responseData.body?.Code || 'UNKNOWN_ERROR';
            errorMsg = responseData.Message || responseData.body?.Message || responseData.body?.message || '发送失败';
          } catch (e) {
            // 解析失败，使用默认值
          }
        }
        
        res.status(400).json({
          code: 400,
          message: `短信发送失败：${errorMsg}`,
          data: {
            log_id: latestLog.id,
            status: 'failed',
            error_code: errorCode,
            error_message: errorMsg
          }
        });
      }
    } else {
      // 如果没有日志，可能是手机号解析失败
      res.status(400).json({
        code: 400,
        message: '短信发送失败：未找到手机号或发送未执行'
      });
    }
  } catch (error) {
    console.error('发送短信接口错误:', error);
    res.status(500).json({
      code: 500,
      message: '发送失败',
      error: error.message
    });
  }
});

// 按规则自动判断并发送（传入嘉宾ID和活动ID）
router.post('/send-auto', authenticate, operationLog('sms', '自动按规则发送短信'), async (req, res) => {
  try {
    const { guest_id, event_id, message_type } = req.body;
    if (!guest_id || !event_id) {
      return res.status(400).json({
        code: 400,
        message: 'guest_id 和 event_id 不能为空'
      });
    }

    // 查找启用的规则：限定当前活动 或 通用规则
    const where = {
      enabled: 1
    };
    if (message_type) {
      where.message_type = message_type;
    }

    const allRules = await SmsRule.findAll({ where });
    const rules = allRules.filter((rule) => {
      // event_id 有值则要求相等；为NULL则视为通用规则
      if (rule.event_id && Number(rule.event_id) !== Number(event_id)) {
        return false;
      }
      return true;
    });

    if (!rules.length) {
      return res.json({
        code: 200,
        message: '没有匹配到任何规则，未发送短信',
        data: {
          sent: 0,
          rules: []
        }
      });
    }

    let sentCount = 0;
    const ruleResults = [];

    // 这里暂时不解析 conditions，主要用于手动测试发送+发送次数控制
    // 前端可以看到每条规则是否命中以及是否实际发送
    for (const rule of rules) {
      const result = {
        rule_id: rule.id,
        name: rule.name,
        message_type: rule.message_type,
        event_id: rule.event_id,
        max_send_times: rule.max_send_times,
        matched: true,
        sent: false,
        reason: ''
      };

      // 检查次数限制
      const hasQuota = await SmsService._hasRemainingQuota(rule, guest_id, event_id);
      if (!hasQuota) {
        result.reason = '已达到最大发送次数';
        ruleResults.push(result);
        // eslint-disable-next-line no-continue
        continue;
      }

      await SmsService.sendMessage(rule.message_type, { lang: SmsService.normalizeLang(req.body && req.body.lang),
        guestId: guest_id,
        eventId: event_id,
        ruleId: rule.id
      });
      sentCount += 1;
      result.sent = true;
      result.reason = '已发送';
      ruleResults.push(result);
    }

    res.json({
      code: 200,
      message: sentCount > 0 ? '已根据规则发送短信' : '规则存在但已达到发送上限，未发送短信',
      data: {
        sent: sentCount,
        rules: ruleResults
      }
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '发送失败',
      error: error.message
    });
  }
});

// 发送报名成功短信（根据活动ID选择模板）
router.post('/send-registration-success', authenticate, async (req, res) => {
  try {
    const { guest_id, event_id, invitation_id } = req.body;
    
    if (!guest_id || !event_id) {
      return res.status(400).json({
        code: 400,
        message: 'guest_id 和 event_id 不能为空'
      });
    }

    // 根据活动ID选择模板ID
    // 活动1 -> 模板12，活动2 -> 模板13
    const templateIdMap = {
      1: 12,
      2: 13
    };
    
    const templateId = templateIdMap[event_id];
    if (!templateId) {
      return res.status(400).json({
        code: 400,
        message: `活动ID ${event_id} 未配置短信模板`
      });
    }

    // 发送短信
    const result = await SmsService.sendByTemplateId(templateId, {
      guestId: guest_id,
      eventId: event_id,
      invitationId: invitation_id
    });

    if (result.success) {
      res.json({
        code: 200,
        message: '报名成功短信发送成功',
        data: {
          template_id: result.templateId,
          event_id: event_id
        }
      });
    } else {
      res.status(400).json({
        code: 400,
        message: `报名成功短信发送失败：${result.error || result.errorMessage || '未知错误'}`,
        error: result.error || result.errorMessage
      });
    }
  } catch (error) {
    console.error('发送报名成功短信失败:', error);
    res.status(500).json({
      code: 500,
      message: '发送失败',
      error: error.message
    });
  }
});

module.exports = router;


