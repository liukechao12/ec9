const cron = require('node-cron');
const { SmsRule, Guest, Invitation, Event } = require('../models');
const { SmsService } = require('./SmsService');
const { Op } = require('sequelize');

class ScheduledSmsService {
  constructor() {
    this.jobs = new Map(); // 存储所有定时任务
  }

  /**
   * 启动定时任务服务
   */
  start() {
    console.log('[定时短信服务] 启动定时任务检查...');
    
    // 每分钟检查一次是否有需要执行的定时任务
    cron.schedule('* * * * *', async () => {
      await this.checkAndExecuteScheduledTasks();
    });
    
    // 启动时立即检查一次
    this.checkAndExecuteScheduledTasks();
    
    // 加载所有启用的定时规则
    this.loadScheduledRules();
  }

  /**
   * 加载所有启用的定时规则
   */
  async loadScheduledRules() {
    try {
      const rules = await SmsRule.findAll({
        where: {
          trigger_type: 'SCHEDULED',
          enabled: 1
        }
      });

      console.log(`[定时短信服务] 加载了 ${rules.length} 条定时规则`);
      
      // 为每个规则创建或更新定时任务
      for (const rule of rules) {
        this.scheduleRule(rule);
      }
    } catch (error) {
      console.error('[定时短信服务] 加载规则失败:', error);
    }
  }

  /**
   * 为规则创建定时任务
   */
  scheduleRule(rule) {
    // 如果规则没有设置定时时间，跳过
    if (!rule.scheduled_time) {
      console.log(`[定时短信服务] 规则 ${rule.id} 未设置定时时间，跳过`);
      return;
    }

    // 如果任务已存在，先停止
    if (this.jobs.has(rule.id)) {
      this.jobs.get(rule.id).stop();
      this.jobs.delete(rule.id);
    }

    const scheduledTime = new Date(rule.scheduled_time);
    const now = new Date();

    // 如果定时时间已过期，跳过
    if (scheduledTime <= now) {
      console.log(`[定时短信服务] 规则 ${rule.id} 的定时时间已过期，跳过`);
      return;
    }

    // 计算距离执行时间的分钟数
    const minutesUntilExecution = Math.floor((scheduledTime - now) / (1000 * 60));

    // 如果超过24小时，使用cron表达式每天检查
    // 否则，使用setTimeout在指定时间执行
    if (minutesUntilExecution > 24 * 60) {
      // 超过24小时，使用cron每天检查
      const hour = scheduledTime.getHours();
      const minute = scheduledTime.getMinutes();
      const cronExpression = `${minute} ${hour} * * *`;
      
      const job = cron.schedule(cronExpression, async () => {
        const ruleCheck = await SmsRule.findByPk(rule.id);
        if (ruleCheck && ruleCheck.enabled === 1 && ruleCheck.scheduled_time) {
          const checkTime = new Date(ruleCheck.scheduled_time);
          const nowCheck = new Date();
          // 检查是否到了执行时间（允许1分钟误差）
          if (Math.abs(checkTime - nowCheck) < 60000) {
            await this.executeScheduledRule(ruleCheck);
            // 执行后停止任务（一次性任务）
            job.stop();
            this.jobs.delete(rule.id);
          }
        }
      }, {
        scheduled: false
      });
      
      job.start();
      this.jobs.set(rule.id, job);
      console.log(`[定时短信服务] 规则 ${rule.id} 已安排，将在 ${scheduledTime.toLocaleString('zh-CN')} 执行`);
    } else {
      // 24小时内，使用setTimeout
      const timeout = scheduledTime - now;
      const timeoutId = setTimeout(async () => {
        const ruleCheck = await SmsRule.findByPk(rule.id);
        if (ruleCheck && ruleCheck.enabled === 1) {
          await this.executeScheduledRule(ruleCheck);
        }
        this.jobs.delete(rule.id);
      }, timeout);
      
      this.jobs.set(rule.id, { stop: () => clearTimeout(timeoutId) });
      console.log(`[定时短信服务] 规则 ${rule.id} 已安排，将在 ${scheduledTime.toLocaleString('zh-CN')} 执行（${Math.floor(timeout / 1000 / 60)}分钟后）`);
    }
  }

  /**
   * 检查并执行到期的定时任务
   */
  async checkAndExecuteScheduledTasks() {
    try {
      const now = new Date();
      
      // 查找所有启用的定时规则，且定时时间已到（允许1分钟误差）
      const rules = await SmsRule.findAll({
        where: {
          trigger_type: 'SCHEDULED',
          enabled: 1,
          scheduled_time: {
            [Op.lte]: new Date(now.getTime() + 60000), // 当前时间+1分钟
            [Op.gte]: new Date(now.getTime() - 60000) // 当前时间-1分钟
          }
        }
      });

      if (rules.length > 0) {
        console.log(`[定时短信服务] 发现 ${rules.length} 条到期的定时规则，开始执行...`);
        
        for (const rule of rules) {
          await this.executeScheduledRule(rule);
        }
      }
    } catch (error) {
      console.error('[定时短信服务] 检查定时任务失败:', error);
    }
  }

  /**
   * 执行定时规则
   */
  async executeScheduledRule(rule) {
    try {
      console.log(`[定时短信服务] 开始执行规则 ${rule.id}: ${rule.name}`);
      
      // 根据条件查找符合条件的嘉宾
      const guests = await this.findTargetGuests(rule);
      
      if (guests.length === 0) {
        console.log(`[定时短信服务] 规则 ${rule.id} 没有找到符合条件的嘉宾`);
        return;
      }

      console.log(`[定时短信服务] 规则 ${rule.id} 找到 ${guests.length} 位符合条件的嘉宾`);

      let sentCount = 0;
      for (const guest of guests) {
        try {
          // 检查发送次数限制
          const hasQuota = await SmsService._hasRemainingQuota(rule, guest.id, rule.event_id);
          if (!hasQuota) {
            console.log(`[定时短信服务] 嘉宾 ${guest.id} 已达到最大发送次数，跳过`);
            continue;
          }

          // 发送短信
          await SmsService.sendMessage(rule.message_type, {
            guestId: guest.id,
            eventId: rule.event_id,
            ruleId: rule.id
          });
          
          sentCount++;
          console.log(`[定时短信服务] 已为嘉宾 ${guest.id} 发送短信`);
        } catch (error) {
          console.error(`[定时短信服务] 为嘉宾 ${guest.id} 发送短信失败:`, error);
        }
      }

      console.log(`[定时短信服务] 规则 ${rule.id} 执行完成，共发送 ${sentCount} 条短信`);
    } catch (error) {
      console.error(`[定时短信服务] 执行规则 ${rule.id} 失败:`, error);
    }
  }

  /**
   * 根据规则条件查找目标嘉宾
   */
  async findTargetGuests(rule) {
    try {
      // 如果规则指定了活动ID，查找该活动的邀约
      if (rule.event_id) {
        const invitations = await Invitation.findAll({
          where: {
            event_id: rule.event_id,
            is_valid: 1,
            registration_status: { [Op.in]: [1, 2] } // 待审批或已接受
          },
          include: [{
            model: Guest,
            as: 'guest',
            where: { status: 1 },
            required: true
          }]
        });
        
        // 去重（同一个嘉宾可能有多个邀约）
        const guestMap = new Map();
        invitations.forEach(inv => {
          if (inv.guest && !guestMap.has(inv.guest.id)) {
            guestMap.set(inv.guest.id, inv.guest);
          }
        });
        
        return Array.from(guestMap.values());
      } else {
        // 通用规则，查找所有有效嘉宾
        const guests = await Guest.findAll({
          where: { status: 1 }
        });
        
        return guests;
      }
    } catch (error) {
      console.error('[定时短信服务] 查找目标嘉宾失败:', error);
      return [];
    }
  }

  /**
   * 更新规则的定时任务
   */
  async updateRuleSchedule(ruleId) {
    try {
      const rule = await SmsRule.findByPk(ruleId);
      if (!rule) {
        return;
      }

      // 如果任务已存在，先停止
      if (this.jobs.has(ruleId)) {
        this.jobs.get(ruleId).stop();
        this.jobs.delete(ruleId);
      }

      // 如果规则是启用的定时规则，创建新任务
      if (rule.trigger_type === 'SCHEDULED' && rule.enabled === 1) {
        this.scheduleRule(rule);
      }
    } catch (error) {
      console.error(`[定时短信服务] 更新规则 ${ruleId} 的定时任务失败:`, error);
    }
  }

  /**
   * 停止规则的定时任务
   */
  stopRuleSchedule(ruleId) {
    if (this.jobs.has(ruleId)) {
      this.jobs.get(ruleId).stop();
      this.jobs.delete(ruleId);
      console.log(`[定时短信服务] 已停止规则 ${ruleId} 的定时任务`);
    }
  }
}

// 导出单例
const scheduledSmsService = new ScheduledSmsService();

module.exports = scheduledSmsService;
