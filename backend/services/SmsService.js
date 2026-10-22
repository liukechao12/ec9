const { SmsTemplate, SmsRule, SmsLog, Guest, Event, Invitation } = require('../models');
const { sendSms } = require('../utils/aliyunSmsClient');
const { hashPhone, decryptPhone } = require('../utils/phoneCrypto');

const MESSAGE_TYPES = {
  REG_SUCCESS: 'REG_SUCCESS',
  REG_APPROVED: 'REG_APPROVED',        // 报名审核通过（与「报名成功」区分，各自独立模板）
  CHECKIN_SUCCESS: 'CHECKIN_SUCCESS',
  PRE_EVENT_REMINDER: 'PRE_EVENT_REMINDER',
  EVENT_DAY_REMINDER: 'EVENT_DAY_REMINDER',
  DINNER_REMINDER: 'DINNER_REMINDER',
  HK_TRIP_REMINDER: 'HK_TRIP_REMINDER'
};

class SmsService {
  /** 支持的语种（与前端语言包一致） */
  static get LANGS() { return ['zh-CN', 'zh-TW', 'en']; }

  /** 默认语种：任何回退最终都会落到它 */
  static get DEFAULT_LANG() { return 'zh-CN'; }

  /**
   * 按语种挑选模板。
   * 短信正文由服务商侧模板决定，本地只存模板 CODE，
   * 所以多语言 = 同一业务类型在不同语种下绑定不同的服务商模板。
   *
   * 选取顺序：
   *   ① 当前语种 + 当前场景
   *   ② 当前语种 + COMMON 场景
   *   ③ 默认语种（zh-CN）+ 当前场景
   *   ④ 默认语种 + COMMON 场景
   *   ⑤ 任意启用的同类型模板（兜底，保证不发不出短信）
   */
  static async _findTemplate(messageType, scene, lang) {
    const wanted = [];
    for (const l of [lang, this.DEFAULT_LANG]) {
      if (l && wanted.indexOf(l) === -1) wanted.push(l);
    }
    for (const l of wanted) {
      let t = await SmsTemplate.findOne({
        where: { message_type: messageType, scene, lang: l, enabled: 1 }
      });
      if (t) return t;
      t = await SmsTemplate.findOne({
        where: { message_type: messageType, scene: 'COMMON', lang: l, enabled: 1 }
      });
      if (t) return t;
    }
    let t = await SmsTemplate.findOne({
      where: { message_type: messageType, scene, enabled: 1 }
    });
    if (!t) {
      t = await SmsTemplate.findOne({ where: { message_type: messageType, enabled: 1 } });
    }
    return t;
  }

  /**
   * 按「业务类型 + 场景 + 语种」选模板并发送。
   *
   * ⚠️ 这是多语言下唯一正确的发送入口。
   * 历史代码用硬编码模板 ID（SMS_TEMPLATE_MAP = {1:12, 2:13}）发送，
   * 那样锁死了语种 —— 英文环境也会发中文模板，且模板 ID 一变就失效。
   *
   * @param {string} messageType  业务类型，如 REG_SUCCESS
   * @param {object} context      { guestId, eventId, invitationId, lang }
   * @param {string} [sceneHint]  强制场景（如 PERFORMANCE），不传则按活动地点推导
   */
  static async sendByBusinessType(messageType, context = {}, sceneHint = null) {
    const { eventId, lang } = context;
    let scene = sceneHint;
    if (!scene) {
      // _resolveScene 只需event（按活动地点判断），这里只取活动即可
      const { event } = await this._loadContext(context);
      scene = this._resolveScene(null, event);
    }
    const normalizedLang = this.normalizeLang(lang);
    const template = await this._findTemplate(messageType, scene, normalizedLang);
    if (!template) {
      const msg = `未找到可用模板 messageType=${messageType}, scene=${scene}, lang=${normalizedLang}`;
      console.warn('[SmsService.sendByBusinessType] ' + msg);
      return { success: false, error: msg };
    }
    console.log(`[SmsService.sendByBusinessType] ${messageType}/${scene}/${normalizedLang} -> 模板#${template.id}`);
    return this.sendByTemplateId(template.id, context);
  }

  /** 把任意输入规整成合法语种，非法值回退默认语种 */
  static normalizeLang(v) {
    return this.LANGS.indexOf(v) >= 0 ? v : this.DEFAULT_LANG;
  }

  /**
   * 统一发送入口
   * @param {string} messageType 业务短信类型
   * @param {object} context { guestId, eventId, invitationId, phone, ruleId, lang }
   */
  static async sendMessage(messageType, context = {}) {
    const { guestId, eventId, invitationId, phone, ruleId } = context;

    // 加载上下文
    const { guest, event, invitation } = await this._loadContext({
      guestId,
      eventId,
      invitationId
    });

    const resolvedPhone = await this._resolvePhone(guest, phone);
    if (!resolvedPhone) {
      console.warn('SmsService.sendMessage: 未找到手机号，跳过发送', {
        hasGuest: !!guest,
        hasPhone: !!phone,
        guestPhone: guest ? guest.phone : null
      });
      // 即使没有手机号，也记录日志以便追踪问题
      // 使用占位值，因为数据库 phone 字段不允许 NULL
      await SmsLog.create({
        message_type: messageType,
        template_id: null,
        rule_id: ruleId || null,
        guest_id: guest ? guest.id : null,
        event_id: event ? event.id : null,
        phone: 'UNKNOWN', // 使用占位值，因为数据库不允许 NULL
        scene: this._resolveScene(guest, event),
        request_params: {},
        response_raw: null,
        status: 0,
        error_code: 'NO_PHONE',
        error_message: '未找到手机号，无法发送短信'
      });
      return;
    }

    const scene = this._resolveScene(guest, event);
    const lang = context.lang || this.DEFAULT_LANG;

    // 查找模板：同语种优先（场景→COMMON），回退中文，最后任意启用的模板
    const template = await this._findTemplate(messageType, scene, lang);
    if (!template) {
      console.warn(`SmsService.sendMessage: 未找到可用模板 messageType=${messageType}, scene=${scene}`);
      return;
    }

    const templateParams = await this._buildTemplateParams(messageType, {
      guest,
      event,
      invitation
    });

    // 根据模板的 params_schema 过滤参数，只传递模板需要的参数
    let filteredParams = templateParams;
    let paramsSchema = template.params_schema;
    
    // 处理 Sequelize 返回的 JSON 字段（可能是字符串或对象）
    if (paramsSchema) {
      if (typeof paramsSchema === 'string') {
        try {
          paramsSchema = JSON.parse(paramsSchema);
        } catch (e) {
          console.warn('解析 params_schema 失败:', e.message);
          paramsSchema = null;
        }
      }
      
      if (Array.isArray(paramsSchema) && paramsSchema.length > 0) {
        filteredParams = {};
        for (const paramName of paramsSchema) {
          if (templateParams.hasOwnProperty(paramName)) {
            filteredParams[paramName] = templateParams[paramName];
          }
        }
        console.log('参数过滤:', {
          original: Object.keys(templateParams),
          filtered: Object.keys(filteredParams),
          schema: paramsSchema
        });
      }
    }

    let resp;
    let status = 0; // 默认失败，只有真正成功才设为1
    let errorCode = null;
    let errorMessage = null;
    try {
      resp = await sendSms({
        PhoneNumbers: resolvedPhone,
        SignName: template.sign_name,
        TemplateCode: template.aliyun_template_code,
        TemplateParam: JSON.stringify(filteredParams)
      });

      // 只有返回 OK 才算成功
      // 处理不同的响应格式：Code/code, Message/message
      const respCode = resp?.Code || resp?.code || resp?.body?.Code || resp?.body?.code;
      const respMessage = resp?.Message || resp?.message || resp?.body?.Message || resp?.body?.message;
      
      if (respCode === 'OK') {
        status = 1;
      } else {
        status = 0;
        errorCode = respCode || 'UNKNOWN_ERROR';
        errorMessage = respMessage || '未知错误';
      }
    } catch (e) {
      status = 0;
      errorCode = 'EXCEPTION';
      errorMessage = e.message;
    }

    // 写日志
    await SmsLog.create({
      message_type: messageType,
      template_id: template.id,
      rule_id: ruleId || null,
      guest_id: guest ? guest.id : null,
      event_id: event ? event.id : null,
      phone: resolvedPhone,
      scene,
      request_params: filteredParams,
      response_raw: resp || null,
      status,
      error_code: errorCode,
      error_message: errorMessage
    });
  }

  /**
   * 状态变更触发入口（例如：报名状态从 待确认/已修改/待审核 -> 报名成功）
   */
  static async onStatusChange({ guestId, eventId, fromStatus, toStatus }) {
    const rules = await SmsRule.findAll({
      where: {
        trigger_type: 'STATUS_CHANGE',
        enabled: 1
      }
    });

    for (const rule of rules) {
      // 规则限定活动：event_id 不为空时只对指定活动生效
      if (rule.event_id && Number(rule.event_id) !== Number(eventId)) {
        continue;
      }

      const conditions = rule.conditions || {};
      if (conditions.from_status && Array.isArray(conditions.from_status)) {
        if (!conditions.from_status.includes(fromStatus)) continue;
      }
      if (conditions.to_status && conditions.to_status !== toStatus) {
        continue;
      }

      // 检查发送次数是否超限
      const hasQuota = await this._hasRemainingQuota(rule, guestId, eventId);
      if (!hasQuota) continue;

      await this.sendMessage(rule.message_type, {
        guestId,
        eventId,
        ruleId: rule.id
      });
    }
  }

  /**
   * 定时任务入口：供外部调度调用
   */
  static async runScheduledTasks() {
    const rules = await SmsRule.findAll({
      where: {
        trigger_type: 'SCHEDULED',
        enabled: 1
      }
    });

    for (const rule of rules) {
      const targets = await this._findTargetsByRule(rule);
      for (const t of targets) {
        await this.sendMessage(rule.message_type, {
          guestId: t.guest_id,
          eventId: t.event_id,
          invitationId: t.invitation_id,
          ruleId: rule.id
        });
      }
    }
  }

  // ================= 内部辅助方法 =================

  static async _loadContext({ guestId, eventId, invitationId }) {
    let guest = null;
    let event = null;
    let invitation = null;

    if (invitationId) {
      invitation = await Invitation.findByPk(invitationId);
      if (invitation) {
        if (!eventId) eventId = invitation.event_id;
        if (!guestId) guestId = invitation.guest_id;
      }
    }
    // 如果没有 invitationId 但有 guestId 和 eventId，尝试查找邀约
    if (!invitation && guestId && eventId) {
      invitation = await Invitation.findOne({
        where: {
          guest_id: guestId,
          event_id: eventId,
          is_valid: 1
        },
        order: [['created_at', 'DESC']] // 取最新的邀约
      });
    }
    // 加载活动信息
    if (eventId) {
      event = await Event.findByPk(eventId);
    }
    // 加载嘉宾信息
    if (guestId) {
      guest = await Guest.findByPk(guestId);
    }

    return { guest, event, invitation };
  }

  /**
   * 检查某条规则在指定嘉宾+活动下是否还有发送额度
   */
  static async _hasRemainingQuota(rule, guestId, eventId) {
    if (!rule.max_send_times || rule.max_send_times <= 0) {
      // 未配置或<=0 表示不限制发送次数
      return true;
    }
    const count = await SmsLog.count({
      where: {
        rule_id: rule.id,
        guest_id: guestId || null,
        event_id: eventId || null
      }
    });
    return count < rule.max_send_times;
  }

  static async _resolvePhone(guest, fallbackPhone) {
    // 如果直接提供了手机号，优先使用
    if (fallbackPhone) return fallbackPhone;
    if (!guest) return null;
    // 尝试从加密字段中还原明文手机号
    try {
      const phone = decryptPhone(guest.phone);
      if (phone && phone.length >= 11) {
        return phone;
      }
      console.warn('解密后的手机号格式不正确:', phone);
      return null;
    } catch (e) {
      console.warn('解密手机号失败:', e.message);
      return null;
    }
  }

  static _resolveScene(guest, event) {
    // 根据活动或嘉宾的地域信息判断香港/深圳
    // 这里暂时简单根据event.location字段包含“香港”/“深圳”判断，不满足时走COMMON
    if (event && event.location) {
      if (event.location.includes('香港')) return 'HONGKONG';
      if (event.location.includes('深圳')) return 'SHENZHEN';
    }
    return 'COMMON';
  }

  static async _buildTemplateParams(messageType, { guest, event, invitation }) {
    const base = {
      name: guest ? guest.name : '',
      company: guest ? guest.company : '',
      event_name: event ? event.name : '',
      event_location: event ? event.location : '',
      // 其他通用字段可按需补充
    };

    switch (messageType) {
      case MESSAGE_TYPES.REG_SUCCESS:
        return {
          ...base
        };
      case MESSAGE_TYPES.REG_APPROVED:
        // 审核通过通知，参数与报名成功一致；如模板需额外字段（如审核人）在此追加
        return {
          ...base
        };
      case MESSAGE_TYPES.CHECKIN_SUCCESS:
        return {
          ...base
        };
      case MESSAGE_TYPES.PRE_EVENT_REMINDER:
        return {
          ...base
        };
      case MESSAGE_TYPES.EVENT_DAY_REMINDER:
        return {
          ...base
        };
      case MESSAGE_TYPES.DINNER_REMINDER:
        return {
          ...base
        };
      case MESSAGE_TYPES.HK_TRIP_REMINDER:
        return {
          ...base
        };
      case 'VIP_WELCOME':
        // 模板参数：time, place, mettingnames
        // time: 活动时间
        // place: 活动地点
        // mettingnames: 活动名称（会议名称）
        return {
          ...base,
          time: event ? (event.start_time ? new Date(event.start_time).toLocaleString('zh-CN', { 
            year: 'numeric', 
            month: '2-digit', 
            day: '2-digit', 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: false
          }).replace(/\//g, '-') : '') : '',
          place: event ? (event.location || '') : '',
          mettingnames: event ? (event.name || '') : ''
        };
      default:
        return base;
    }
  }

  /**
   * 根据规则查找需要发送的目标嘉宾/活动（这里只留一个简单占位实现，后续可按业务细化）
   */
  static async _findTargetsByRule(rule) {
    const { message_type: messageType } = rule;
    const conditions = rule.conditions || {};

    // 这里只实现一个最基础的“会前/当天”示例，具体可根据你的实际业务再完善
    if (messageType === MESSAGE_TYPES.PRE_EVENT_REMINDER || messageType === MESSAGE_TYPES.EVENT_DAY_REMINDER) {
      // 简化：这里直接返回空数组，后续你可以根据 Registration / Invitation 表实现精准筛选
      return [];
    }

    // 默认不返回任何目标，避免误发
    return [];
  }

  /**
   * 根据模板ID直接发送短信（用于报名成功等场景）
   * @param {number} templateId 模板ID
   * @param {object} context { guestId, eventId, invitationId, phone }
   */
  static async sendByTemplateId(templateId, context = {}) {
    const { guestId, eventId, invitationId, phone } = context;

    console.log(`[SmsService.sendByTemplateId] 开始发送短信，模板ID: ${templateId}, guestId: ${guestId}, eventId: ${eventId}, invitationId: ${invitationId}`);

    // 加载上下文
    const { guest, event, invitation } = await this._loadContext({
      guestId,
      eventId,
      invitationId
    });

    console.log(`[SmsService.sendByTemplateId] 上下文加载完成，guest: ${guest ? guest.id : 'null'}, event: ${event ? event.id : 'null'}, invitation: ${invitation ? invitation.id : 'null'}`);

    const resolvedPhone = await this._resolvePhone(guest, phone);
    if (!resolvedPhone) {
      console.warn('[SmsService.sendByTemplateId] 未找到手机号，跳过发送', {
        hasGuest: !!guest,
        hasPhone: !!phone,
        guestPhone: guest ? guest.phone : null
      });
      return { success: false, error: '未找到手机号' };
    }

    console.log(`[SmsService.sendByTemplateId] 手机号解析成功: ${resolvedPhone.substring(0, 3)}****${resolvedPhone.substring(7)}`);

    // 查找指定ID的模板
    const template = await SmsTemplate.findByPk(templateId);
    if (!template) {
      console.warn(`[SmsService.sendByTemplateId] 模板不存在 templateId=${templateId}`);
      return { success: false, error: '模板不存在' };
    }

    console.log(`[SmsService.sendByTemplateId] 模板查找成功，模板名称: ${template.name}, 启用状态: ${template.enabled}`);

    if (template.enabled !== 1) {
      console.warn(`[SmsService.sendByTemplateId] 模板未启用 templateId=${templateId}`);
      return { success: false, error: '模板未启用' };
    }

    const templateParams = await this._buildTemplateParams(template.message_type, {
      guest,
      event,
      invitation
    });

    // 根据模板的 params_schema 过滤参数
    let filteredParams = templateParams;
    let paramsSchema = template.params_schema;
    
    if (paramsSchema) {
      if (typeof paramsSchema === 'string') {
        try {
          paramsSchema = JSON.parse(paramsSchema);
        } catch (e) {
          console.warn('解析 params_schema 失败:', e.message);
          paramsSchema = null;
        }
      }
      
      if (Array.isArray(paramsSchema) && paramsSchema.length > 0) {
        filteredParams = {};
        for (const paramName of paramsSchema) {
          if (templateParams.hasOwnProperty(paramName)) {
            filteredParams[paramName] = templateParams[paramName];
          }
        }
      }
    }

    let resp;
    let status = 0;
    let errorCode = null;
    let errorMessage = null;
    try {
      console.log(`[SmsService.sendByTemplateId] 准备发送短信，模板CODE: ${template.aliyun_template_code}, 签名: ${template.sign_name}, 参数:`, filteredParams);
      
      resp = await sendSms({
        PhoneNumbers: resolvedPhone,
        SignName: template.sign_name,
        TemplateCode: template.aliyun_template_code,
        TemplateParam: JSON.stringify(filteredParams)
      });

      const respCode = resp?.Code || resp?.code || resp?.body?.Code || resp?.body?.code;
      const respMessage = resp?.Message || resp?.message || resp?.body?.Message || resp?.body?.message;
      
      console.log(`[SmsService.sendByTemplateId] 短信发送响应，Code: ${respCode}, Message: ${respMessage}`);
      
      if (respCode === 'OK') {
        status = 1;
        console.log(`[SmsService.sendByTemplateId] 短信发送成功，模板ID: ${templateId}`);
      } else {
        status = 0;
        errorCode = respCode || 'UNKNOWN_ERROR';
        errorMessage = respMessage || '未知错误';
        console.error(`[SmsService.sendByTemplateId] 短信发送失败，模板ID: ${templateId}, 错误码: ${errorCode}, 错误信息: ${errorMessage}`);
      }
    } catch (e) {
      status = 0;
      errorCode = 'EXCEPTION';
      errorMessage = e.message;
      console.error(`[SmsService.sendByTemplateId] 短信发送异常，模板ID: ${templateId}`, e);
      console.error(`[SmsService.sendByTemplateId] 异常堆栈:`, e.stack);
    }

    // 写日志
    const scene = this._resolveScene(guest, event);
    await SmsLog.create({
      message_type: template.message_type,
      template_id: template.id,
      rule_id: null,
      guest_id: guest ? guest.id : null,
      event_id: event ? event.id : null,
      phone: resolvedPhone,
      scene,
      request_params: filteredParams,
      response_raw: resp || null,
      status,
      error_code: errorCode,
      error_message: errorMessage
    });

    return { 
      success: status === 1, 
      status, 
      errorCode, 
      errorMessage,
      templateId: template.id
    };
  }
}

module.exports = {
  SmsService,
  MESSAGE_TYPES
};

// 供路由层使用：SmsService.MESSAGE_TYPES.REG_SUCCESS
SmsService.MESSAGE_TYPES = MESSAGE_TYPES;


