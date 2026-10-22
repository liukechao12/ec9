// API配置
const API_BASE_URL = window.location.origin + '/api';

// 页面状态
let checkinCode = '';
let checkinCodeData = null;
let eventData = null;

// 工具函数：显示/隐藏元素
function show(id) {
    document.getElementById(id).style.display = 'block';
}

function hide(id) {
    document.getElementById(id).style.display = 'none';
}

// 工具函数：显示错误
function showError(message) {
    document.getElementById('error-text').textContent = message;
    hide('loading');
    hide('checkin-page');
    hide('success-page');
    hide('duplicate-page');
    show('error');
}

// 工具函数：格式化时间
function formatDateTime(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
}

// 工具函数：获取地点类型文本
function getLocationTypeText(type) {
    switch(type) {
        case 1: return (window.t ? window.t('h5Checkin.shenzhenOnly') : '深圳专用');
        case 2: return (window.t ? window.t('h5Checkin.shenzhenHongKong') : '深圳+香港通用');
        default: return '-';
    }
}

// 初始化页面
async function init() {
    try {
        // 从URL获取签到码
        const pathParts = window.location.pathname.split('/');
        checkinCode = pathParts[pathParts.length - 1];
        
        if (!checkinCode) {
            showError('无效的签到码');
            return;
        }

        // 获取签到码信息
        const response = await fetch(`${API_BASE_URL}/checkin-codes`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const result = await response.json();
        
        if (result.code !== 200 && result.code !== 0) {
            showError('获取签到信息失败');
            return;
        }

        // 查找当前签到码
        checkinCodeData = result.data.find(item => item.code === checkinCode);
        
        if (!checkinCodeData) {
            showError('签到码不存在');
            return;
        }

        if (!checkinCodeData.is_active) {
            showError('签到码已禁用');
            return;
        }

        // 获取活动信息
        const eventResponse = await fetch(`${API_BASE_URL}/events/${checkinCodeData.event_id}`);
        const eventResult = await eventResponse.json();
        
        if (eventResult.code !== 200 && eventResult.code !== 0) {
            showError('获取活动信息失败');
            return;
        }

        eventData = eventResult.data;

        // 显示活动信息
        document.getElementById('event-name').textContent = eventData.name || '活动签到';
        document.getElementById('event-time').textContent = formatDateTime(eventData.start_time);
        document.getElementById('event-location').textContent = eventData.location || '-';
        document.getElementById('location-type').textContent = getLocationTypeText(checkinCodeData.code_type);

        // 显示签到页面
        hide('loading');
        show('checkin-page');

        // 初始化事件监听
        setupEventListeners();

    } catch (error) {
        console.error('初始化失败:', error);
        showError('加载失败，请重试');
    }
}

// 设置事件监听
function setupEventListeners() {
    const phoneInput = document.getElementById('phone-input');
    const checkinBtn = document.getElementById('checkin-btn');
    const phoneError = document.getElementById('phone-error');

    // 监听手机号输入
    phoneInput.addEventListener('input', function() {
        const phone = this.value.trim();
        
        // 清除错误提示
        phoneError.style.display = 'none';
        
        // 验证手机号格式
        if (phone.length === 11 && /^1[3-9]\d{9}$/.test(phone)) {
            checkinBtn.disabled = false;
        } else {
            checkinBtn.disabled = true;
        }
    });

    // 监听签到按钮点击
    checkinBtn.addEventListener('click', handleCheckin);

    // 支持回车键签到
    phoneInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && !checkinBtn.disabled) {
            handleCheckin();
        }
    });
}

// 处理签到
async function handleCheckin() {
    const phoneInput = document.getElementById('phone-input');
    const checkinBtn = document.getElementById('checkin-btn');
    const phoneError = document.getElementById('phone-error');
    const phone = phoneInput.value.trim();

    // 验证手机号
    if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
        phoneError.textContent = '请输入正确的手机号';
        phoneError.style.display = 'block';
        return;
    }

    // 禁用按钮，防止重复提交
    checkinBtn.disabled = true;
    checkinBtn.textContent = '签到中...';

    try {
        // 获取设备信息
        const deviceInfo = {
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            screenWidth: screen.width,
            screenHeight: screen.height
        };

        // 发送签到请求
        const response = await fetch(`${API_BASE_URL}/checkins/by-phone`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                phone: phone,
                checkin_code: checkinCode,
                location: eventData.location,
                device_info: JSON.stringify(deviceInfo),
                user_agent: navigator.userAgent,
                ip_address: '' // 由后端从请求中获取
            })
        });

        const result = await response.json();

        if (result.code === 200 || result.code === 0) {
            // 签到成功
            showSuccessPage(result.data);
        } else if (result.code === 400 && result.message.includes('已经签到')) {
            // 重复签到
            showDuplicatePage(result.message);
        } else {
            // 签到失败
            phoneError.textContent = result.message || '签到失败，请重试';
            phoneError.style.display = 'block';
            checkinBtn.disabled = false;
            checkinBtn.textContent = '确认签到';
        }

    } catch (error) {
        console.error('签到失败:', error);
        phoneError.textContent = '网络错误，请重试';
        phoneError.style.display = 'block';
        checkinBtn.disabled = false;
        checkinBtn.textContent = '确认签到';
    }
}

// 显示签到成功页面
function showSuccessPage(data) {
    document.getElementById('success-event-name').textContent = eventData.name;
    document.getElementById('success-guest-name').textContent = data.guest.name;
    document.getElementById('success-guest-company').textContent = data.guest.company;
    document.getElementById('success-checkin-time').textContent = formatDateTime(data.checkin.checkin_time);
    document.getElementById('success-location-type').textContent = getLocationTypeText(data.checkin.location_type);

    hide('checkin-page');
    show('success-page');
}

// 显示重复签到页面
async function showDuplicatePage(message) {
    // 尝试获取签到记录
    try {
        const phoneInput = document.getElementById('phone-input');
        const phone = phoneInput.value.trim();

        // 这里简化处理，直接显示提示
        // 实际应该从后端获取签到记录详情
        document.getElementById('duplicate-guest-name').textContent = '-';
        document.getElementById('duplicate-guest-company').textContent = '-';
        document.getElementById('duplicate-checkin-time').textContent = '-';
        document.getElementById('duplicate-location-type').textContent = getLocationTypeText(checkinCodeData.code_type);

    } catch (error) {
        console.error('获取签到记录失败:', error);
    }

    hide('checkin-page');
    show('duplicate-page');
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);
