// 获取URL参数
function getUrlParam(name) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(name);
}

// 从路径或URL参数中获取邀约码
function getInviteCode() {
    // 优先从URL参数中获取（支持活动绑定页面）
    const urlParam = getUrlParam('code');
    if (urlParam) {
        return urlParam;
    }
    
    // 如果URL参数中没有，则从路径中获取（兼容旧格式）
    const path = window.location.pathname;
    const match = path.match(/\/invite\/([^\/]+)/);
    return match ? match[1] : null;
}

// API基础URL
const API_BASE = '/api';

// 页面元素
const elements = {
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    errorText: document.getElementById('error-text'),
    invitePage: document.getElementById('invite-page'),
    ticketPage: document.getElementById('ticket-page'),
    phoneInput: document.getElementById('phone-input'),
    phoneError: document.getElementById('phone-error'),
    verifyBtn: document.getElementById('verify-btn'),
    guestInfo: document.getElementById('guest-info'),
    guestName: document.getElementById('guest-name'),
    guestCompany: document.getElementById('guest-company'),
    confirmBtn: document.getElementById('confirm-btn'),
    eventName: document.getElementById('event-name'),
    eventTime: document.getElementById('event-time'),
    eventLocation: document.getElementById('event-location'),
    ticketEventName: document.getElementById('ticket-event-name'),
    ticketGuestName: document.getElementById('ticket-guest-name'),
    ticketGuestCompany: document.getElementById('ticket-guest-company'),
    ticketCode: document.getElementById('ticket-code'),
    qrCodeImg: document.getElementById('qr-code-img')
};

// 全局变量
let inviteCode = null;
let invitationData = null;
let guestData = null;

// 初始化
async function init() {
    try {
        // 获取邀约码
        inviteCode = getInviteCode();
        if (!inviteCode) {
            showError('邀约码无效，请检查链接是否正确');
            return;
        }

        // 加载邀约信息
        await loadInvitation();
        
        // 绑定事件
        bindEvents();
        
        // 显示邀约页面
        showInvitePage();
    } catch (error) {
        console.error('初始化失败:', error);
        showError(error.message || '加载失败，请稍后重试');
    }
}

// 加载邀约信息
async function loadInvitation() {
    try {
        const response = await fetch(`${API_BASE}/invitations/code/${inviteCode}`);
        const result = await response.json();
        
        if (result.code !== 200 && result.code !== 0) {
            throw new Error(result.message || '获取邀约信息失败');
        }
        
        invitationData = result.data;
        
        // 检查邀约是否有效
        if (!invitationData.is_valid) {
            throw new Error('此邀约已失效');
        }
        
        // 检查是否已报名
        if (invitationData.registration_status === 1) {
            // 已报名，直接显示门票
            await loadTicket();
            return;
        }
        
        // 填充活动信息
        if (invitationData.event) {
            elements.eventName.textContent = invitationData.event.name || '活动名称';
            elements.eventTime.textContent = formatDateTime(invitationData.event.start_time);
            elements.eventLocation.textContent = invitationData.event.location || '-';
        }
    } catch (error) {
        console.error('加载邀约信息失败:', error);
        throw error;
    }
}

// 绑定事件
function bindEvents() {
    // 手机号输入验证
    elements.phoneInput.addEventListener('input', validatePhoneInput);
    
    // 验证按钮
    elements.verifyBtn.addEventListener('click', verifyPhone);
    
    // 确认报名按钮
    elements.confirmBtn.addEventListener('click', confirmRegistration);
}

// 验证手机号输入格式
function validatePhoneInput() {
    const phone = elements.phoneInput.value.trim();
    const phoneRegex = /^1[3-9]\d{9}$/;
    
    if (phone.length === 0) {
        elements.verifyBtn.disabled = true;
        hideError();
        return;
    }
    
    if (!phoneRegex.test(phone)) {
        elements.verifyBtn.disabled = true;
        showPhoneError('请输入正确的11位手机号');
        return;
    }
    
    elements.verifyBtn.disabled = false;
    hideError();
    hidePhoneError();
}

// 验证手机号（与后台数据比对）
async function verifyPhone() {
    const phone = elements.phoneInput.value.trim();
    
    if (!phone) {
        showPhoneError('请输入手机号');
        return;
    }
    
    // 禁用按钮，显示加载状态
    elements.verifyBtn.disabled = true;
    elements.verifyBtn.textContent = '验证中...';
    
    try {
        // 调用报名接口进行验证（如果已报名会返回门票信息）
        const response = await fetch(`${API_BASE}/registrations/by-phone`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                phone: phone,
                invite_code: inviteCode
            })
        });
        
        const result = await response.json();
        
        if (result.code === 404 && result.message === '未邀请或手机号不匹配') {
            showPhoneError('未邀请或手机号不匹配');
            elements.verifyBtn.disabled = false;
            elements.verifyBtn.textContent = '验证手机号';
            return;
        }
        
        if (result.code === 200 || result.code === 0) {
            // 如果已报名，直接显示门票
            if (result.message === '您已报名') {
                await showTicket(result.data);
                return;
            }
            
            // 验证成功，显示嘉宾信息
            guestData = result.data.guest;
            showGuestInfo(guestData);
        } else {
            throw new Error(result.message || '验证失败');
        }
    } catch (error) {
        console.error('验证手机号失败:', error);
        showPhoneError(error.message || '验证失败，请稍后重试');
        elements.verifyBtn.disabled = false;
        elements.verifyBtn.textContent = '验证手机号';
    }
}

// 显示嘉宾信息
function showGuestInfo(guest) {
    elements.guestName.textContent = guest.name || '-';
    elements.guestCompany.textContent = guest.company || '-';
    elements.guestInfo.style.display = 'block';
    
    // 滚动到嘉宾信息区域
    elements.guestInfo.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// 确认报名
async function confirmRegistration() {
    const phone = elements.phoneInput.value.trim();
    
    if (!phone) {
        showPhoneError('请输入手机号');
        return;
    }
    
    // 禁用按钮
    elements.confirmBtn.disabled = true;
    elements.confirmBtn.textContent = '报名中...';
    
    try {
        const response = await fetch(`${API_BASE}/registrations/by-phone`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                phone: phone,
                invite_code: inviteCode
            })
        });
        
        const result = await response.json();
        
        if (result.code !== 200 && result.code !== 0) {
            throw new Error(result.message || '报名失败');
        }
        
        // 显示门票
        await showTicket(result.data);
    } catch (error) {
        console.error('报名失败:', error);
        alert(error.message || '报名失败，请稍后重试');
        elements.confirmBtn.disabled = false;
        elements.confirmBtn.textContent = '确认报名';
    }
}

// 加载门票信息（已报名情况）
async function loadTicket() {
    try {
        // 通过邀约码获取门票信息
        const response = await fetch(`${API_BASE}/invitations/code/${inviteCode}`);
        const result = await response.json();
        
        if (result.code !== 200 && result.code !== 0) {
            throw new Error(result.message || '获取门票信息失败');
        }
        
        const invitation = result.data;

        // 获取门票详情
        // ⚠️ EC9 的 /api/invitations/code/:code 不返回 ticket 对象，
        //    票码在 ec9_checkin_codes 里，接口以 checkin 字段带出。
        //    这里兼容两种结构（ticket / checkin），缺数据时降级为「只显示活动+嘉宾信息」，
        //    而不是直接报错把嘉宾挡在门外（2026-10-15 改）。
        const tk = invitation.ticket || invitation.checkin || null;
        if (tk) {
            await showTicket({
                guest: invitation.guest ? {
                    name: invitation.guest.name,
                    company: invitation.guest.company
                } : null,
                event: invitation.event,
                ticket: {
                    ticket_code: tk.ticket_code || tk.code || '',
                    qr_code_url: tk.qr_code_url || '',
                    qr_code_data: tk.qr_code_data || ''
                }
            });
        } else {
            // 已报名但还没生成票码（审核中/未支付）：把活动与嘉宾信息先展示出来，
            // 票码位置给一句说明，不弹错误页。
            await showTicket({
                guest: invitation.guest ? {
                    name: invitation.guest.name,
                    company: invitation.guest.company
                } : null,
                event: invitation.event,
                ticket: { ticket_code: '', qr_code_url: '', qr_code_data: '' },
                pending: true
            });
        }
    } catch (error) {
        console.error('加载门票失败:', error);
        showError(error.message || '加载门票信息失败');
    }
}

// 显示门票
async function showTicket(data) {
    // 填充门票信息
    if (data.event) {
        elements.ticketEventName.textContent = data.event.name || '活动名称';
    }
    
    if (data.guest) {
        elements.ticketGuestName.textContent = data.guest.name || '-';
        elements.ticketGuestCompany.textContent = data.guest.company || '-';
    }
    
    if (data.ticket) {
        elements.ticketCode.textContent = data.ticket.ticket_code || '-';

        // 加载二维码
        if (data.ticket.qr_code_url) {
            // 如果是相对路径，转换为绝对路径
            let qrUrl = data.ticket.qr_code_url;
            if (qrUrl.startsWith('/')) {
                qrUrl = window.location.origin + qrUrl;
            }
            elements.qrCodeImg.src = qrUrl;
            elements.qrCodeImg.onerror = function() {
                console.error('二维码加载失败');
                elements.qrCodeImg.alt = '二维码加载失败';
            };
        } else if (data.ticket.qr_code_data) {
            // 如果有base64数据，直接使用
            elements.qrCodeImg.src = data.ticket.qr_code_data;
        }
    }

    // 已报名但票码未生成（审核中 / 未支付）：把二维码位置换成说明文字，
    // 不要留一张空白破图（2026-10-15 加）。
    if (data.pending) {
        const box = elements.qrCodeImg ? elements.qrCodeImg.parentElement : null;
        if (box) {
            const tip = document.createElement('p');
            tip.className = 'qr-pending-tip';
            tip.setAttribute('data-i18n', 'h5.ticket.pending');
            tip.textContent = (window.t && window.t('h5.ticket.pending')) || '票码将在报名审核通过后生成，请稍后刷新本页面';
            box.appendChild(tip);
        }
    }
    
    // 显示门票页面
    showTicketPage();
}

// 显示错误
function showError(message) {
    elements.loading.style.display = 'none';
    elements.invitePage.style.display = 'none';
    elements.ticketPage.style.display = 'none';
    elements.error.style.display = 'block';
    elements.errorText.textContent = message;
}

// 显示手机号错误
function showPhoneError(message) {
    elements.phoneError.textContent = message;
    elements.phoneError.style.display = 'block';
    elements.phoneInput.style.borderColor = '#dc3545';
}

// 隐藏手机号错误
function hidePhoneError() {
    elements.phoneError.style.display = 'none';
    elements.phoneInput.style.borderColor = '#e9ecef';
}

// 隐藏错误
function hideError() {
    elements.phoneError.style.display = 'none';
    elements.phoneInput.style.borderColor = '#e9ecef';
}

// 显示邀约页面
function showInvitePage() {
    elements.loading.style.display = 'none';
    elements.error.style.display = 'none';
    elements.ticketPage.style.display = 'none';
    elements.invitePage.style.display = 'block';
}

// 显示门票页面
function showTicketPage() {
    elements.loading.style.display = 'none';
    elements.error.style.display = 'none';
    elements.invitePage.style.display = 'none';
    elements.ticketPage.style.display = 'block';
    
    // 滚动到顶部
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 格式化日期时间
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

// 保存门票（截图功能）
function saveTicket() {
    // 提示用户截图保存
    if (confirm('请使用手机截图功能保存门票图片')) {
        // 可以尝试使用html2canvas库进行截图
        // 这里先使用简单的提示
        alert('请使用手机截图功能保存此页面');
    }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);

