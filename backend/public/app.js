// 多语言兜底：i18n.js 未加载时 t() 直接返回原文，页面照常可用
if (typeof window.t !== 'function') {
    window.t = function (k, p, f) { return f != null ? f : k; };
}

// API基础URL
const API_BASE = '/api';
let currentToken = localStorage.getItem('token');
let currentUser = null;

// 页面标题映射
const pageTitles = {
    dashboard: '控制台',
    events: '活动管理',
    sessions: '场次管理',
    'ticket-types': '票种管理',
    orders: '订单管理',
    'reg-audit': '报名审核',
    payments: '支付流水',
    'pay-config': '支付配置',
    'sms-config': '短信配置',
    guests: '嘉宾管理',
    invitations: '邀约管理',
    checkins: '签到管理',
    statistics: '统计报表',
    'bd-management': 'BD管理',
    sms: '短信中心',
    logs: '操作日志'
};

async function initInvitationBdFilter() {
    const select = document.getElementById('invitationBdFilter');
    const list = document.getElementById('invitationBdFilterList');
    const isAdmin = currentUser && currentUser.role === 'admin';
    if (!select) return;

    if (!isAdmin) {
        select.style.display = 'none';
        return;
    }

    select.style.display = 'inline-block';
    if (!select.dataset.bound) {
        select.dataset.bound = '1';
        let t = null;
        select.addEventListener('input', function () {
            if (t) clearTimeout(t);
            t = setTimeout(() => loadInvitations(1, currentInvitationPageSize), 300);
        });
        select.addEventListener('change', function () {
            loadInvitations(1, currentInvitationPageSize);
        });
    }

    if (invitationBdFilterLoaded) return;
    invitationBdFilterLoaded = true;

    try {
        const data = await apiRequest('/admins?page=1&pageSize=1000&role=bd&status=1');
        invitationBdFilterOptions = data.data?.list || [];

        try {
            const sourceRes = await apiRequest('/invitations/source-bds');
            invitationSourceBdOptions = sourceRes.data?.list || [];
        } catch (e) {
            invitationSourceBdOptions = [];
        }

        if (list) {
            list.innerHTML = '';
            const seen = new Set();

            invitationBdFilterOptions.forEach(bd => {
                const username = bd && bd.username ? String(bd.username).trim() : '';
                if (!username) return;
                const name = bd && bd.name ? String(bd.name).trim() : '';
                const label = name ? `${name} (${username})` : username;
                if (seen.has(label)) return;
                seen.add(label);
                const opt = document.createElement('option');
                opt.value = label;
                list.appendChild(opt);
            });

            (invitationSourceBdOptions || []).forEach(v => {
                const val = v !== undefined && v !== null ? String(v).trim() : '';
                if (!val || val === 'null' || val === 'undefined') return;
                if (seen.has(val)) return;
                seen.add(val);
                const opt = document.createElement('option');
                opt.value = val;
                list.appendChild(opt);
            });
        }
    } catch (e) {
        if (list) list.innerHTML = '';
    }
}

function getInvitationBdFilterUsername() {
    const input = document.getElementById('invitationBdFilter');
    if (!input) return '';
    const raw = String(input.value || '').trim();
    if (!raw) return '';

    const sourceExact = (invitationSourceBdOptions || []).some(v => {
        const s = v !== undefined && v !== null ? String(v).trim() : '';
        return s && s === raw;
    });
    if (sourceExact) {
        return raw;
    }

    const m = raw.match(/\(([^)]+)\)\s*$/);
    if (m && m[1]) {
        return String(m[1]).trim();
    }

    const direct = raw;
    if (/^[a-zA-Z0-9_.-]+$/.test(direct)) {
        return direct;
    }

    const exactNameMatches = (invitationBdFilterOptions || []).filter(bd => {
        const n = bd && bd.name ? String(bd.name).trim() : '';
        return n && n === direct;
    });
    if (exactNameMatches.length === 1) {
        return String(exactNameMatches[0].username || '').trim();
    }

    const includesMatches = (invitationBdFilterOptions || []).filter(bd => {
        const n = bd && bd.name ? String(bd.name).trim() : '';
        return n && n.includes(direct);
    });
    if (includesMatches.length === 1) {
        return String(includesMatches[0].username || '').trim();
    }

    return raw;
}

function bindInvitationSearch() {
    const invitationSearchInput = document.getElementById('invitationSearch');
    if (!invitationSearchInput || invitationSearchInput.dataset.bound) {
        return;
    }

    invitationSearchInput.dataset.bound = '1';

    // 回车立即搜索
    invitationSearchInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (invitationSearchTimeout) {
                clearTimeout(invitationSearchTimeout);
            }
            currentInvitationSearchKeyword = this.value.trim();
            loadInvitations(1, currentInvitationPageSize);
        }
    });

    // 输入防抖搜索；清空则立即重置
    invitationSearchInput.addEventListener('input', function() {
        const keyword = this.value.trim();

        if (keyword === currentInvitationSearchKeyword) {
            return;
        }

        currentInvitationSearchKeyword = keyword;

        if (invitationSearchTimeout) {
            clearTimeout(invitationSearchTimeout);
        }

        if (!keyword) {
            loadInvitations(1, currentInvitationPageSize);
            return;
        }

        invitationSearchTimeout = setTimeout(() => {
            loadInvitations(1, currentInvitationPageSize);
        }, 500);
    });
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    applySidebarCollapseFromStorage();
    if (currentToken) {
        checkAuth();
    } else {
        showLoginPage();
    }

    // 绑定邀约搜索（部分场景下未进入 switchPage 也需要生效）
    bindInvitationSearch();
    
    // 登录表单
    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);
    
    // 导航菜单
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const page = item.dataset.page;
            switchPage(page);
        });
    });
    
    // 初始化标签复选框样式（延迟执行，确保DOM已加载）
    setTimeout(() => {
        initTagCheckboxStyles();
    }, 100);
});

function applySidebarCollapseFromStorage() {
    const collapsed = localStorage.getItem('sidebarCollapsed') === '1';
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    const btn = document.getElementById('sidebarToggleBtn');
    if (btn) {
        btn.title = collapsed ? '展开侧边栏' : '收缩侧边栏';
    }
}

function toggleSidebarCollapse() {
    const willCollapse = !document.body.classList.contains('sidebar-collapsed');
    document.body.classList.toggle('sidebar-collapsed', willCollapse);
    localStorage.setItem('sidebarCollapsed', willCollapse ? '1' : '0');
    const btn = document.getElementById('sidebarToggleBtn');
    if (btn) {
        btn.title = willCollapse ? '展开侧边栏' : '收缩侧边栏';
    }
}

// 显示登录页面
function showLoginPage() {
    document.getElementById('loginPage').classList.remove('hidden');
    document.getElementById('mainPage').classList.add('hidden');
}

// 显示主页面
function showMainPage() {
    document.getElementById('loginPage').classList.add('hidden');
    document.getElementById('mainPage').classList.remove('hidden');
    updateUserInfo();
    loadDashboard();
}

// 更新用户信息
function updateUserInfo() {
    if (currentUser) {
        const name = currentUser.name || currentUser.username || '管理员';
        document.getElementById('userInfo').textContent = name;
        const initial = name.charAt(0).toUpperCase();
        document.getElementById('userInitial').textContent = initial;
    }
}

// 根据用户角色更新菜单可见性
function updateMenuVisibility() {
    if (!currentUser) return;
    
    const isAdmin = currentUser.role === 'admin';
    const isBD = currentUser.role === 'bd';

    // 邀约管理：管理员代签到按钮和选择列
    const adminCheckinBtn = document.getElementById('adminCheckinBtn');
    if (adminCheckinBtn) {
        adminCheckinBtn.style.display = isAdmin ? 'inline-flex' : 'none';
    }
    const invitationSelectHeader = document.getElementById('invitationSelectHeader');
    if (invitationSelectHeader) {
        invitationSelectHeader.style.display = isAdmin ? 'table-cell' : 'none';
    }
    if (!isAdmin) {
        resetInvitationSelectionUI();
    }
    
    // BD管理菜单（只有管理员可见）
    const bdNav = document.getElementById('bdManagementNav');
    if (bdNav) {
        bdNav.style.display = isAdmin ? 'flex' : 'none';
    }
    
    // BD用户只能看到：嘉宾管理、邀约管理、签到管理
    const menuItems = {
        'dashboard': isAdmin, // 控制台
        'events': isAdmin, // 活动管理
        'guests': true, // 嘉宾管理（BD可见）
        'invitations': true, // 邀约管理（BD可见）
        'checkins': true, // 签到管理（BD可见）
        'statistics': isAdmin, // 统计报表
        'sms': isAdmin, // 短信中心
        'logs': isAdmin // 操作日志
    };
    
    Object.keys(menuItems).forEach(page => {
        const menuItem = document.querySelector(`.nav-item[data-page="${page}"]`);
        if (menuItem) {
            menuItem.style.display = menuItems[page] ? 'flex' : 'none';
        }
    });
}

// 登录
async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorDiv = document.getElementById('loginError');
    
    try {
        const response = await fetch(`${API_BASE}/admin/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (data.code === 200) {
            currentToken = data.data.token;
            currentUser = data.data.admin;
            localStorage.setItem('token', currentToken);
            localStorage.setItem('user', JSON.stringify(currentUser));
            updateUserInfo();
            // 根据用户角色显示/隐藏菜单
            updateMenuVisibility();
            showMainPage();
        } else {
            if (errorDiv) {
                errorDiv.textContent = data.message || '登录失败';
            }
        }
    } catch (error) {
        if (errorDiv) {
            errorDiv.textContent = '网络错误，请稍后重试';
        }
    }
}

// 检查认证
async function checkAuth() {
    try {
        const response = await fetch(`${API_BASE}/admin/me`, {
            headers: {
                'Authorization': `Bearer ${currentToken}`
            }
        });
        
        const data = await response.json();
        
        if (data.code === 200) {
            currentUser = data.data;
            updateUserInfo();
            // 根据用户角色显示/隐藏菜单
            updateMenuVisibility();
            showMainPage();
        } else {
            showLoginPage();
        }
    } catch (error) {
        showLoginPage();
    }
}

// 显示用户菜单
function showUserMenu() {
    const menu = document.getElementById('userMenu');
    if (menu) {
        menu.classList.toggle('hidden');
        // 点击外部关闭菜单
        setTimeout(() => {
            document.addEventListener('click', function closeMenu(e) {
                if (!menu.contains(e.target) && !document.getElementById('userAvatar').contains(e.target)) {
                    menu.classList.add('hidden');
                    document.removeEventListener('click', closeMenu);
                }
            });
        }, 0);
    }
}

// 显示修改密码模态框
function showChangePasswordModal() {
    document.getElementById('changePasswordModal').classList.remove('hidden');
    document.getElementById('changePasswordForm').reset();
    document.getElementById('userMenu').classList.add('hidden');
}

// 关闭修改密码模态框
function closeChangePasswordModal() {
    document.getElementById('changePasswordModal').classList.add('hidden');
    document.getElementById('changePasswordForm').reset();
}

// 处理修改密码
async function handleChangePassword(e) {
    e.preventDefault();
    
    const oldPassword = document.getElementById('oldPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    
    if (!oldPassword || !newPassword || !confirmPassword) {
        alert('请填写完整信息');
        return;
    }
    
    if (newPassword.length < 6) {
        alert('新密码长度不能少于6位');
        return;
    }
    
    if (newPassword !== confirmPassword) {
        alert('两次输入的新密码不一致');
        return;
    }
    
    if (oldPassword === newPassword) {
        alert('新密码不能与当前密码相同');
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/admin/change-password`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                oldPassword,
                newPassword
            })
        });
        
        const data = await response.json();
        
        if (data.code === 200) {
            alert('密码修改成功，请重新登录');
            closeChangePasswordModal();
            handleLogout();
        } else {
            alert(data.message || '修改失败');
        }
    } catch (error) {
        console.error('修改密码失败:', error);
        alert('修改失败，请稍后重试');
    }
}

// 退出登录
function handleLogout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    currentToken = null;
    currentUser = null;
    showLoginPage();
}

// 切换页面
function switchPage(pageName) {
    // 隐藏所有页面
    document.querySelectorAll('.content-page').forEach(page => {
        page.classList.add('hidden');
    });
    
    // 显示目标页面
    document.getElementById(pageName).classList.remove('hidden');
    
    // 更新页面标题（走 t()：中文原文经 zhIndex 反查成当前语言，
    // 不依赖 MutationObserver —— 标题是 textContent 赋值，Observer 补不到）
    document.getElementById('pageTitle').textContent =
        (typeof t === 'function' ? t(pageTitles[pageName] || '控制台') : (pageTitles[pageName] || '控制台'));
    
    // 更新导航状态
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.page === pageName) {
            item.classList.add('active');
        }
    });
    
    // 加载对应数据（BD用户只能访问特定页面）
    const isAdmin = currentUser && currentUser.role === 'admin';
    const isBD = currentUser && currentUser.role === 'bd';
    
    switch(pageName) {
        case 'dashboard':
            if (isAdmin) {
                loadDashboard();
            } else if (isBD) {
                // BD用户默认跳转到嘉宾管理
                setTimeout(() => switchPage('guests'), 0);
            }
            break;
        case 'events':
            if (isAdmin) {
                loadEvents();
            } else if (isBD) {
                setTimeout(() => switchPage('guests'), 0);
            }
            break;
        // ===== EC9 新增模块（场次/票种/订单/支付流水）=====
        // 这四个模块的业务数据属于会议本身，与 BD 的嘉宾邀约职责无关，
        // 所以对 BD 也开放（只读+基本操作），不做 isAdmin 拦截。
        case 'sessions':
            if (typeof loadSessions === 'function') loadSessions();
            break;
        case 'ticket-types':
            if (typeof loadTicketTypes === 'function') loadTicketTypes();
            break;
        case 'orders':
            if (typeof loadOrders === 'function') loadOrders(1, 20);
            break;
        case 'payments':
            if (typeof loadPayments === 'function') loadPayments(1, 20);
            break;
        case 'reg-audit':
            if (typeof loadRegAudit === 'function') loadRegAudit();
            break;
        case 'guests':
            loadGuests();
            break;
        case 'invitations':
            loadInvitations();
            // 添加筛选器事件监听
            const registrationStatusFilter = document.getElementById('registrationStatusFilter');
            if (registrationStatusFilter) {
                registrationStatusFilter.addEventListener('change', () => {
                    loadInvitations(1, currentInvitationPageSize);
                });
            }
            initInvitationBdFilter();
            bindInvitationSearch();
            break;
        case 'checkins':
            loadCheckins();
            break;
        case 'pay-config':
            // 支付资质属敏感配置，仅管理员可见；BD 直接送回嘉宾页
            if (isAdmin) {
                if (typeof loadPayConfig === 'function') loadPayConfig();
            } else if (isBD) {
                setTimeout(() => switchPage('guests'), 0);
            }
            break;
        case 'statistics':
            if (isAdmin) {
                initStatisticsPage();
            } else if (isBD) {
                setTimeout(() => switchPage('guests'), 0);
            }
            break;
        case 'bd-management':
            if (isAdmin) {
                loadBds();
            } else if (isBD) {
                setTimeout(() => switchPage('guests'), 0);
            }
            break;
        case 'sms':
            if (isAdmin) {
                loadSmsCenter();
            } else if (isBD) {
                setTimeout(() => switchPage('guests'), 0);
            }
            break;
        case 'sms-config':
            // 短信凭证属敏感配置，仅管理员；BD 送回嘉宾页
            if (isAdmin) {
                if (typeof loadSmsConfig === 'function') loadSmsConfig();
            } else if (isBD) {
                setTimeout(() => switchPage('guests'), 0);
            }
            break;
        case 'logs':
            if (isAdmin) {
                loadLogs();
            } else if (isBD) {
                setTimeout(() => switchPage('guests'), 0);
            }
            break;
    }
}

// API请求封装
async function apiRequest(url, options = {}) {
    const defaultOptions = {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentToken}`
        }
    };
    
    const response = await fetch(`${API_BASE}${url}`, {
        ...defaultOptions,
        ...options,
        headers: {
            ...defaultOptions.headers,
            ...options.headers
        }
    });
    
    // 如果是 401 错误，检查是否是 token 过期
    if (response.status === 401) {
        const result = await response.json();
        // 只在真正的认证失败时才登出，给用户一次机会
        if (result.message && result.message.includes('过期')) {
            alert('登录已过期，请重新登录');
        } else {
            alert('认证失败，请重新登录');
        }
        handleLogout();
        throw new Error('未登录');
    }
    
    return response.json();
}

// 加载控制台数据
async function loadDashboard() {
    try {
        const [stats, events] = await Promise.all([
            apiRequest('/statistics/dashboard'),
            apiRequest('/events')
        ]);
        
        // 更新总数
        if (stats.code === 200 && stats.data) {
            document.getElementById('totalEvents').textContent = stats.data.events?.total || 0;
            document.getElementById('totalGuests').textContent = stats.data.guests?.total || 0;
            document.getElementById('totalInvitations').textContent = stats.data.invitations?.total || 0;
            document.getElementById('totalCheckins').textContent = stats.data.checkins?.total || 0;
            
            // 更新增量数字
            updateTrendText('totalEvents', stats.data.events?.newThisMonth || 0, '本月');
            updateTrendText('totalGuests', stats.data.guests?.newThisMonth || 0, '本月');
            updateTrendText('totalInvitations', stats.data.invitations?.newThisMonth || 0, '本月');
            updateTrendText('totalCheckins', stats.data.checkins?.newThisWeek || 0, '本周');
        } else {
            // 如果统计接口失败，使用原有方式
            const [guests, invitations, checkins] = await Promise.all([
                apiRequest('/guests'),
                apiRequest('/invitations'),
                apiRequest('/checkins')
            ]);
            
            document.getElementById('totalEvents').textContent = events.data?.total || 0;
            document.getElementById('totalGuests').textContent = guests.data?.total || 0;
            document.getElementById('totalInvitations').textContent = invitations.data?.total || 0;
            document.getElementById('totalCheckins').textContent = checkins.data?.total || 0;
        }
        
        // 加载近期活动
        loadRecentEvents(events.data?.list || []);
    } catch (error) {
        console.error('加载控制台数据失败:', error);
        // 如果统计接口失败，使用原有方式
        try {
            const [guests, invitations, checkins] = await Promise.all([
                apiRequest('/guests'),
                apiRequest('/invitations'),
                apiRequest('/checkins')
            ]);
            
            document.getElementById('totalEvents').textContent = 0;
            document.getElementById('totalGuests').textContent = guests.data?.total || 0;
            document.getElementById('totalInvitations').textContent = invitations.data?.total || 0;
            document.getElementById('totalCheckins').textContent = checkins.data?.total || 0;
        } catch (e) {
            console.error('加载基础数据失败:', e);
        }
    }
}

// 更新趋势文本
function updateTrendText(elementId, count, period) {
    // 直接通过ID更新对应的趋势文本
    const trendElementId = 'trend' + elementId.replace('total', '');
    const trendElement = document.getElementById(trendElementId);
    if (trendElement) {
        trendElement.textContent = `+${count} ${period}`;
    }
}

// 加载近期活动
function loadRecentEvents(events) {
    const tbody = document.getElementById('recentEventsTableBody');
    tbody.innerHTML = '';
    
    // 只显示前4个活动
    const recentEvents = events.slice(0, 4);
    
    recentEvents.forEach(event => {
        const tr = document.createElement('tr');
        
        // 计算签到率
        const guestCount = event.guest_count || 0;
        const checkinCount = event.checkin_count || 0;
        const checkinRate = guestCount > 0 ? Math.round((checkinCount / guestCount) * 100) : 0;
        
        tr.innerHTML = `
            <td>
                <div style="display: flex; align-items: center; gap: 12px;">
                    <div style="width: 40px; height: 40px; border-radius: 10px; background: #DBEAFE; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                            <rect x="3" y="4" width="18" height="16" rx="2" stroke="#155DFC" stroke-width="2"/>
                            <path d="M3 8H21" stroke="#155DFC" stroke-width="2"/>
                            <path d="M8 2V6" stroke="#155DFC" stroke-width="2" stroke-linecap="round"/>
                            <path d="M16 2V6" stroke="#155DFC" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </div>
                    <span>${ec9I18n(event, 'name')}</span>
                </div>
            </td>
            <td>
                <span class="status-badge ${getEventStatusClass(event.status)}">${getEventStatusText(event.status)}</span>
            </td>
            <td>${guestCount}</td>
            <td>${checkinCount}</td>
            <td>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <div style="flex: 1; height: 8px; background: #E5E7EB; border-radius: 9999px; overflow: hidden;">
                        <div style="width: ${checkinRate}%; height: 100%; background: #155DFC; border-radius: 9999px;"></div>
                    </div>
                    <span>${checkinRate}%</span>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// 加载活动列表
async function loadEvents() {
    try {
        const data = await apiRequest('/events');
        const tbody = document.getElementById('eventsTableBody');
        tbody.innerHTML = '';
        
        if (data.data?.list) {
            data.data.list.forEach(event => {
                const tr = document.createElement('tr');
                const startDate = formatDateShort(event.start_time);
                const guestCount = event.guest_count || 0;
                const checkinCount = event.checkin_count || 0;
                
                // 显示扩展字段（如果有）
                let extraFieldsHtml = '';
                if (event.extra_fields && typeof event.extra_fields === 'object') {
                    const extraFields = Object.entries(event.extra_fields).slice(0, 2); // 只显示前2个
                    extraFieldsHtml = extraFields.map(([key, value]) => {
                        // 如果是富文本，提取纯文本内容
                        let displayValue = value;
                        if (typeof value === 'string' && value.includes('<')) {
                            // 简单的HTML标签移除
                            const tempDiv = document.createElement('div');
                            tempDiv.innerHTML = value;
                            displayValue = tempDiv.textContent || tempDiv.innerText || value;
                        }
                        // 限制显示长度
                        if (displayValue.length > 100) {
                            displayValue = displayValue.substring(0, 100) + '...';
                        }
                        return `<span style="font-size: 12px; color: #6B7280;">${key}: ${displayValue}</span>`;
                    }).join(' | ');
                }
                
                tr.innerHTML = `
                    <td>
                        <div style="display: flex; flex-direction: column; gap: 4px;">
                            <div style="display: flex; align-items: center; gap: 12px;">
                                <div style="width: 40px; height: 40px; border-radius: 10px; background: #DBEAFE; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                                        <rect x="3" y="4" width="18" height="16" rx="2" stroke="#155DFC" stroke-width="2"/>
                                        <path d="M3 8H21" stroke="#155DFC" stroke-width="2"/>
                                        <path d="M8 2V6" stroke="#155DFC" stroke-width="2" stroke-linecap="round"/>
                                        <path d="M16 2V6" stroke="#155DFC" stroke-width="2" stroke-linecap="round"/>
                                    </svg>
                                </div>
                                <span>${ec9I18n(event, 'name')}</span>
                            </div>
                            ${extraFieldsHtml ? `<div style="padding-left: 52px; font-size: 12px; color: #6B7280;">${extraFieldsHtml}</div>` : ''}
                        </div>
                    </td>
                    <td>${startDate}</td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <path d="M8 2.67C5.43 2.67 3.33 4.77 3.33 7.33C3.33 11.17 8 15.33 8 15.33C8 15.33 12.67 11.17 12.67 7.33C12.67 4.77 10.57 2.67 8 2.67Z" stroke="#99A1AF" stroke-width="1.33"/>
                                <circle cx="8" cy="7.33" r="2" stroke="#99A1AF" stroke-width="1.33"/>
                            </svg>
                            <span>${event.location || '-'}</span>
                        </div>
                    </td>
                    <td>
                        <span class="status-badge ${getEventStatusClass(event.status)}">${getEventStatusText(event.status)}</span>
                    </td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <path d="M2.67 4.67L2.67 13.33L13.33 13.33" stroke="#99A1AF" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            <span>${checkinCount} / ${guestCount}</span>
                        </div>
                    </td>
                    <td>
                        <div style="display: flex; gap: 8px;">
                            <button class="btn btn-sm btn-outline" onclick="showEventModal(${event.id})">编辑</button>
                            <button class="btn btn-sm btn-outline" onclick="deleteEvent(${event.id})" style="color: #EF4444; border-color: #EF4444;">删除</button>
                        </div>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
    } catch (error) {
        console.error('加载活动列表失败:', error);
    }
}

// 嘉宾列表分页变量
let currentGuestPage = 1;
let currentGuestPageSize = 10;

// 加载嘉宾列表
async function loadGuests(page = currentGuestPage, pageSize = currentGuestPageSize, keyword = '') {
    try {
        currentGuestPage = page;
        currentGuestPageSize = pageSize;
        
        // 构建查询参数
        let url = `/guests?page=${page}&pageSize=${pageSize}`;
        if (keyword && keyword.trim()) {
            url += `&keyword=${encodeURIComponent(keyword.trim())}`;
        }
        
        const data = await apiRequest(url);
        const tbody = document.getElementById('guestsTableBody');
        tbody.innerHTML = '';
        
        // 更新统计
        // 总嘉宾数显示当前搜索结果数
        const total = data.data?.total || 0;
        document.getElementById('totalGuestsMini').textContent = total;
        
        // 更新标签统计（从后端返回的统计数据）
        console.log('接收到的完整数据:', data);
        console.log('接收到的统计数据:', data.data?.stats);
        
        const vipElement = document.getElementById('vipGuests');
        const techElement = document.getElementById('techGuests');
        const execElement = document.getElementById('execGuests');
        
        if (!vipElement || !techElement || !execElement) {
            console.error('统计元素未找到:', { vipElement, techElement, execElement });
        }
        
        if (data.data?.stats) {
            const stats = data.data.stats;
            console.log('VIP统计:', stats.vip, '技术统计:', stats.tech, '高管统计:', stats.exec);
            
            // 确保值是数字类型
            const vipCount = Number(stats.vip) || 0;
            const techCount = Number(stats.tech) || 0;
            const execCount = Number(stats.exec) || 0;
            
            if (vipElement) vipElement.textContent = vipCount;
            if (techElement) techElement.textContent = techCount;
            if (execElement) execElement.textContent = execCount;
            
            console.log('已更新统计数据到DOM:', { vip: vipCount, tech: techCount, exec: execCount });
        } else {
            // 如果没有统计数据，显示0
            console.warn('未收到统计数据，data.data:', data.data);
            if (vipElement) vipElement.textContent = 0;
            if (techElement) techElement.textContent = 0;
            if (execElement) execElement.textContent = 0;
        }
        
        if (data.data?.list) {
            data.data.list.forEach(guest => {
                const tr = document.createElement('tr');
                const initial = guest.name ? guest.name.charAt(0) : '?';
                const phone = guest.phone || '-';
                const email = guest.email || '-';
                
                tr.innerHTML = `
                    <td>
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <div style="width: 40px; height: 40px; border-radius: 50%; background: #DBEAFE; display: flex; align-items: center; justify-content: center; color: #155DFC; font-size: 16px; font-weight: 400;">${initial}</div>
                            <span>${guest.name}</span>
                        </div>
                    </td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <rect x="2.67" y="4" width="10.67" height="8" rx="1.33" stroke="#99A1AF" stroke-width="1.33"/>
                            </svg>
                            <span>${guest.company || '-'}</span>
                        </div>
                    </td>
                    <td>${guest.position || '-'}</td>
                    <td>
                        <div style="display: flex; flex-direction: column; gap: 4px; max-width: 150px;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink: 0;">
                                    <circle cx="6" cy="6" r="5" stroke="#99A1AF" stroke-width="1"/>
                                </svg>
                                <span style="color: #364153; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${phone}">${phone}</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink: 0;">
                                    <rect x="1" y="1" width="10" height="10" rx="1" stroke="#99A1AF" stroke-width="1"/>
                                </svg>
                                <span style="color: #364153; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${email}">${email}</span>
                            </div>
                        </div>
                    </td>
                    <td>
                        <span style="color: #6B7280; font-size: 14px;">${guest.bd ? (guest.bd.name || guest.bd.username) : (guest.bd_id || '-')}</span>
                    </td>
                    <td>
                        <div style="display: flex; flex-direction: column; gap: 4px;">
                            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                                ${(() => {
                                    const tags = [];
                                    // 从extra_fields中读取标签
                                    let extraFields = guest.extra_fields;
                                    
                                    // 如果extra_fields是字符串，尝试解析为JSON
                                    if (typeof extraFields === 'string') {
                                        try {
                                            extraFields = JSON.parse(extraFields);
                                        } catch (e) {
                                            console.warn('解析extra_fields失败:', e);
                                            extraFields = null;
                                        }
                                    }
                                    
                                    if (extraFields && typeof extraFields === 'object') {
                                        // 检查VIP标签（支持布尔值true、字符串'true'、数字1）
                                        if (extraFields['VIP'] === true || extraFields['VIP'] === 'true' || extraFields['VIP'] === 1) {
                                            tags.push('VIP');
                                        }
                                        // 检查技术标签
                                        if (extraFields['技术'] === true || extraFields['技术'] === 'true' || extraFields['技术'] === 1) {
                                            tags.push('技术');
                                        }
                                        // 检查高管标签
                                        if (extraFields['高管'] === true || extraFields['高管'] === 'true' || extraFields['高管'] === 1) {
                                            tags.push('高管');
                                        }
                                        // 其他标签
                                        if (extraFields['其他标签']) {
                                            const otherTags = String(extraFields['其他标签']).split(',').map(t => t.trim()).filter(t => t);
                                            tags.push(...otherTags);
                                        }
                                    }
                                    
                                    if (tags.length === 0) return '-';
                                    
                                    return tags.map(tag => {
                                        let bgColor = '#F3F4F6';
                                        let textColor = '#6B7280';
                                        if (tag === 'VIP') {
                                            bgColor = '#FEF9C2';
                                            textColor = '#A65F00';
                                        } else if (tag === '技术') {
                                            bgColor = '#DBEAFE';
                                            textColor = '#1447E6';
                                        } else if (tag === '高管') {
                                            bgColor = '#FEE2E2';
                                            textColor = '#DC2626';
                                        }
                                        return `<span style="padding: 4.5px 8px; background: ${bgColor}; color: ${textColor}; border-radius: 4px; font-size: 14px;">${tag}</span>`;
                                    }).join('');
                                })()}
                            </div>
                        </div>
                    </td>
                    <td>
                        <div style="display: flex; gap: 8px;">
                            <button class="btn btn-sm btn-outline" onclick="showGuestModal(${guest.id})">编辑</button>
                            <button class="btn btn-sm btn-outline" onclick="deleteGuest(${guest.id})" style="color: #EF4444; border-color: #EF4444;">删除</button>
                        </div>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        } else {
            // 如果没有数据，显示空状态
            const tbody = document.getElementById('guestsTableBody');
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 40px; color: #6B7280;">暂无嘉宾数据</td></tr>`;
            }
        }
        
        // 渲染分页
        renderGuestPagination(data.data?.total || 0, data.data?.page || page, data.data?.pageSize || pageSize);
    } catch (error) {
        console.error('加载嘉宾列表失败:', error);
        // 显示错误提示
        const tbody = document.getElementById('guestsTableBody');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 40px; color: #EF4444;">${window.t('admin.loadFailedWith', [error.message || window.t('admin.unknownError')])}<br><button onclick="loadGuests()" style="margin-top: 10px; padding: 8px 16px; background: #155DFC; color: white; border: none; border-radius: 6px; cursor: pointer;">重试</button></td></tr>`;
        }
        // 重置统计数据
        document.getElementById('totalGuestsMini').textContent = 0;
        document.getElementById('vipGuests').textContent = 0;
        document.getElementById('techGuests').textContent = 0;
        document.getElementById('execGuests').textContent = 0;
    }
}

// 渲染嘉宾分页
function renderGuestPagination(total, page, pageSize) {
    const pagination = document.getElementById('guestPagination');
    if (!pagination) return;
    
    const totalPages = Math.ceil(total / pageSize);
    
    if (totalPages <= 1 && total === 0) {
        pagination.innerHTML = '';
        return;
    }
    
    let html = '<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; padding: 20px 0;">';
    
    // 左侧：分页信息
    html += `<div style="display: flex; align-items: center; gap: 16px; color: #6B7280; font-size: 14px;">
        <span>共 <strong style="color: #101828;">${total}</strong> 条记录</span>
        <span>第 <strong style="color: #101828;">${page}</strong> / <strong style="color: #101828;">${totalPages}</strong> 页</span>
    </div>`;
    
    // 中间：分页控件
    html += '<div style="display: flex; align-items: center; gap: 8px;">';
    
    // 上一页
    if (page > 1) {
        html += `<button class="btn btn-sm btn-outline" onclick="loadGuests(${page - 1}, ${pageSize})" style="min-width: 80px;"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="margin-right: 4px;"><path d="M10 12L6 8L10 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>上一页</button>`;
    } else {
        html += '<button class="btn btn-sm btn-outline" disabled style="min-width: 80px; opacity: 0.5;"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="margin-right: 4px;"><path d="M10 12L6 8L10 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>上一页</button>';
    }
    
    // 页码
    const startPage = Math.max(1, page - 2);
    const endPage = Math.min(totalPages, page + 2);
    
    if (startPage > 1) {
        html += `<button class="btn btn-sm ${1 === page ? 'btn-primary' : 'btn-outline'}" onclick="loadGuests(1, ${pageSize})" style="min-width: 36px;">1</button>`;
        if (startPage > 2) {
            html += '<span style="padding: 0 4px; color: #9CA3AF;">...</span>';
        }
    }
    
    for (let i = startPage; i <= endPage; i++) {
        if (i === page) {
            html += `<button class="btn btn-sm btn-primary" style="min-width: 36px;">${i}</button>`;
        } else {
            html += `<button class="btn btn-sm btn-outline" onclick="loadGuests(${i}, ${pageSize})" style="min-width: 36px;">${i}</button>`;
        }
    }
    
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            html += '<span style="padding: 0 4px; color: #9CA3AF;">...</span>';
        }
        html += `<button class="btn btn-sm ${totalPages === page ? 'btn-primary' : 'btn-outline'}" onclick="loadGuests(${totalPages}, ${pageSize})" style="min-width: 36px;">${totalPages}</button>`;
    }
    
    // 下一页
    if (page < totalPages) {
        html += `<button class="btn btn-sm btn-outline" onclick="loadGuests(${page + 1}, ${pageSize})" style="min-width: 80px;">下一页<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="margin-left: 4px;"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
    } else {
        html += '<button class="btn btn-sm btn-outline" disabled style="min-width: 80px; opacity: 0.5;">下一页<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="margin-left: 4px;"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
    }
    
    html += '</div>';
    
    // 右侧：每页显示数量选择
    html += `<div style="display: flex; align-items: center; gap: 8px;">
        <label style="color: #6B7280; font-size: 14px; white-space: nowrap;">每页：</label>
        <select onchange="changeGuestPageSize(this.value)" style="padding: 6px 12px; border: 1px solid #D1D5DB; border-radius: 6px; font-size: 14px; background: white; cursor: pointer; min-width: 80px;">
            <option value="10" ${pageSize === 10 ? 'selected' : ''}>10 条</option>
            <option value="20" ${pageSize === 20 ? 'selected' : ''}>20 条</option>
            <option value="50" ${pageSize === 50 ? 'selected' : ''}>50 条</option>
            <option value="100" ${pageSize === 100 ? 'selected' : ''}>100 条</option>
        </select>
    </div>`;
    
    html += '</div>';
    
    pagination.innerHTML = html;
}

// 改变每页显示数量
function changeGuestPageSize(newSize) {
    loadGuests(1, parseInt(newSize));
}

// 搜索嘉宾（带防抖）
let searchTimeout = null;
let currentSearchKeyword = '';

async function searchGuests() {
    const keyword = document.getElementById('guestSearch').value.trim();
    
    // 如果关键词没有变化，不执行搜索
    if (keyword === currentSearchKeyword) {
        return;
    }
    
    currentSearchKeyword = keyword;
    
    // 清除之前的定时器
    if (searchTimeout) {
        clearTimeout(searchTimeout);
    }
    
    // 如果搜索框为空，立即重置列表
    if (!keyword) {
        loadGuests(1, currentGuestPageSize, '');
        return;
    }
    
    // 防抖：延迟500ms后执行搜索
    searchTimeout = setTimeout(() => {
        // 重置到第一页并执行搜索
        loadGuests(1, currentGuestPageSize, keyword);
    }, 500);
}

// 支持回车键搜索和清空功能
document.addEventListener('DOMContentLoaded', function() {
    const guestSearchInput = document.getElementById('guestSearch');
    if (guestSearchInput) {
        // 回车键立即搜索
        guestSearchInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                // 清除防抖定时器，立即执行搜索
                if (searchTimeout) {
                    clearTimeout(searchTimeout);
                }
                const keyword = this.value.trim();
                currentSearchKeyword = keyword;
                loadGuests(1, currentGuestPageSize, keyword);
            }
        });
        
        // 监听输入变化，实时更新currentSearchKeyword（用于防抖判断）
        guestSearchInput.addEventListener('input', function() {
            const keyword = this.value.trim();
            if (!keyword) {
                // 如果清空搜索框，立即重置
                if (searchTimeout) {
                    clearTimeout(searchTimeout);
                }
                currentSearchKeyword = '';
                loadGuests(1, currentGuestPageSize, '');
            }
        });
    }
});

// 邀约列表分页变量
let currentInvitationPage = 1;
let currentInvitationPageSize = 10;
let invitationSearchTimeout = null;
let currentInvitationSearchKeyword = '';
let invitationBdFilterLoaded = false;
let invitationBdFilterOptions = [];
let invitationSourceBdOptions = [];

let selectedInvitationIds = new Set();
// 记住每条勾选邀约的报名状态：批量通过只吃「待审批(1)」，代签到只吃「已报名(2)」
let selectedInvitationStatus = new Map();
let currentBatchNo = '';          // 当前打开的批次号
let invTab = 'list';              // 邀约管理：list=按人看 / batch=按批次审

function resetInvitationSelectionUI() {
    selectedInvitationIds = new Set();
    selectedInvitationStatus = new Map();
    const selectAll = document.getElementById('invitationSelectAll');
    if (selectAll) {
        selectAll.checked = false;
        selectAll.indeterminate = false;
    }
    updateAdminCheckinButtonState();
    updateInvBulkAuditButtons();
}

/** 批量通过/驳回按钮：有勾选就亮，并提示本批次可审条数 */
function updateInvBulkAuditButtons() {
    const pay = pendingSelectedIds();
    const ap = document.getElementById('invBulkApproveBtn');
    const rj = document.getElementById('invBulkRejectBtn');
    if (ap) {
        ap.disabled = pay.length === 0;
        ap.style.opacity = ap.disabled ? '0.5' : '1';
        ap.style.cursor = ap.disabled ? 'not-allowed' : 'pointer';
        ap.textContent = pay.length ? `批量通过(${pay.length})` : '批量通过';
    }
    if (rj) {
        rj.disabled = pay.length === 0;
        rj.style.opacity = rj.disabled ? '0.5' : '1';
        rj.style.cursor = rj.disabled ? 'not-allowed' : 'pointer';
        rj.textContent = pay.length ? `批量驳回(${pay.length})` : '批量驳回';
    }
}

/** 已勾选且状态为「待审批(1)」的邀约 id */
function pendingSelectedIds() {
    return Array.from(selectedInvitationIds).filter(id => selectedInvitationStatus.get(id) === 1);
}

/* ==================================================================
   邀约管理：按人看 / 按批次审
   ================================================================== */
function switchInvTab(tab) {
    invTab = tab === 'batch' ? 'batch' : 'list';
    const lw = document.getElementById('invListWrap');
    const bw = document.getElementById('invBatchWrap');
    const tl = document.getElementById('invTabList');
    const tb = document.getElementById('invTabBatch');
    if (lw) lw.classList.toggle('hidden', invTab !== 'list');
    if (bw) bw.classList.toggle('hidden', invTab !== 'batch');
    if (tl) { tl.className = invTab === 'list' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline'; }
    if (tb) { tb.className = invTab === 'batch' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline'; }
    if (invTab === 'list') loadInvitations();
    else loadInvitationBatches();
}

async function loadInvitationBatches() {
    const body = document.getElementById('invBatchBody');
    const empty = document.getElementById('invBatchEmpty');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:24px;color:#6B7280;">加载中...</td></tr>';
    try {
        const onlyPending = document.getElementById('invBatchOnlyPending')?.checked;
        const res = await apiRequest(`/invitations/batches${onlyPending ? '?only_pending=1' : ''}`);
        const list = (res && res.data && res.data.list) || [];
        if (!list.length) {
            body.innerHTML = '';
            if (empty) empty.classList.remove('hidden');
            return;
        }
        if (empty) empty.classList.add('hidden');
        const srcText = r => r.from_registration ? '报名提交' : '后台添加';
        body.innerHTML = list.map(r => {
            const canAudit = Number(r.pending) > 0;
            return `<tr>
                <td>
                    <div style="font-family:monospace;font-size:12px;" title="${r.batch_no}">${r.batch_no}</div>
                    <span style="font-size:11px;padding:1px 7px;border-radius:9px;background:${r.from_registration ? '#DBEAFE' : '#F3F4F6'};color:${r.from_registration ? '#155DFC' : '#4B5563'};white-space:nowrap;">${srcText(r)}</span>
                </td>
                <td style="white-space:nowrap;">${r.event_name || '-'}</td>
                <td style="white-space:nowrap;">${r.source_bd || '-'}</td>
                <td style="text-align:center;">${r.total}</td>
                <td style="color:${Number(r.pending) ? '#D97706' : '#6B7280'};font-weight:${Number(r.pending) ? '600' : '400'};text-align:center;">${r.pending}</td>
                <td style="color:#00B42A;text-align:center;">${r.approved}</td>
                <td style="color:#EF4444;text-align:center;">${r.rejected}</td>
                <td style="white-space:nowrap;">${formatDateShort(r.created_at)}</td>
                <td style="white-space:nowrap;">
                    <div style="display:flex; gap:6px;">
                        <button class="btn btn-sm btn-outline" onclick="viewBatch('${r.batch_no}')">查看</button>
                        ${canAudit ? `
                        <button class="btn btn-sm btn-primary" onclick="auditBatch('${r.batch_no}','approve')">整批通过</button>
                        <button class="btn btn-sm btn-outline" onclick="auditBatch('${r.batch_no}','reject')">整批驳回</button>` : ''}
                    </div>
                </td>
            </tr>`;
        }).join('');
    } catch (e) {
        body.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:24px;color:#EF4444;">加载失败：${e.message || ''}</td></tr>`;
    }
}

async function viewBatch(batchNo) {
    const modal = document.getElementById('batchDetailModal');
    const bodyEl = document.getElementById('batchDetailBody');
    const sumEl = document.getElementById('batchDetailSummary');
    const titleEl = document.getElementById('batchDetailTitle');
    const orderEl = document.getElementById('batchDetailOrder');
    if (!modal || !bodyEl) return;
    currentBatchNo = batchNo;
    if (titleEl) titleEl.textContent = '批次详情 · ' + batchNo;
    bodyEl.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px;color:#6B7280;">加载中...</td></tr>';
    modal.classList.remove('hidden');
    try {
        const res = await apiRequest(`/invitations/batches/${encodeURIComponent(batchNo)}`);
        const d = res && res.data;
        if (!d) throw new Error('批次不存在');
        const stText = s => ({ 0: '待回复', 1: '待审批', 2: '已报名', 3: '已拒绝' })[s] || s;
        if (sumEl) {
            sumEl.innerHTML = `共 <b>${d.total}</b> 人 · 待审批 <b style="color:#D97706">${d.pending}</b> · 已通过 <b style="color:#00B42A">${d.approved}</b> · 已驳回 <b style="color:#EF4444">${d.rejected}</b> · BD：${d.source_bd || '-'} · 创建：${formatDateShort(d.created_at)}`;
        }
        bodyEl.innerHTML = (d.list || []).map(x => `<tr>
            <td>${x.name || '-'}</td>
            <td>${x.company || '-'}</td>
            <td>${x.position || '-'}</td>
            <td style="font-family:monospace;font-size:12px">${x.phone || '-'}</td>
            <td>${x.ticket_name || (x.registration_id ? '-' : '未报名')}</td>
            <td>${x.ticket_price == null ? '-' : '¥' + Number(x.ticket_price).toFixed(2)}</td>
            <td>${x.need_pay ? '<span style="color:#D97706">需付款</span>' : '<span style="color:#00B42A">免票</span>'}</td>
            <td>${stText(x.registration_status)}</td>
            <td style="max-width:160px" title="${x.approval_remark || ''}">${x.approval_remark || '-'}</td>
        </tr>`).join('');
        if (orderEl) {
            orderEl.innerHTML = d.order
                ? `本批订单：<b style="font-family:monospace">${d.order.order_no}</b> · 金额 <b>¥${Number(d.order.final_amount).toFixed(2)}</b>· ${d.order.discount_rate < 1 ? (Number(d.order.discount_rate) * 10).toFixed(1) + '折 · ' : ''}状态 ${d.order.status}`
                : '<span style="color:#6B7280">本批暂无订单（全员免票或未审核）</span>';
        }
    } catch (e) {
        bodyEl.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:24px;color:#EF4444;">加载失败：${e.message || ''}</td></tr>`;
    }
}

function closeBatchDetailModal() {
    const modal = document.getElementById('batchDetailModal');
    if (modal) modal.classList.add('hidden');
    currentBatchNo = '';
}

async function auditCurrentBatch(action) {
    if (!currentBatchNo) return;
    await auditBatch(currentBatchNo, action, true);
}

async function auditBatch(batchNo, action, fromModal) {
    let remark = '';
    let needPay = undefined;
    if (fromModal) {
        const rEl = document.getElementById('batchAuditRemark');
        const pEl = document.getElementById('batchAuditNeedPay');
        remark = (rEl && rEl.value || '').trim();
        needPay = pEl && pEl.value !== '' ? parseInt(pEl.value, 10) : undefined;
    }
    if (action === 'reject') {
        remark = remark || prompt('整批驳回原因（这批人全部驳回）：');
        if (!remark) return;
    }
    const tip = action === 'approve'
        ? `确认整批通过？这批人将全部通过审核（要付款的会立即生成待支付订单并发付款短信）。`
        : `确认整批驳回？这批人将全部被驳回。`;
    if (!confirm(tip)) return;
    try {
        const body = { action };
        if (remark) body.remark = remark;
        if (needPay !== undefined) body.need_pay = needPay;
        const res = await apiRequest(`/invitations/batches/${encodeURIComponent(batchNo)}/audit`, {
            method: 'POST', body: JSON.stringify(body)
        });
        alert(res.message || '操作完成');
        if (fromModal) {
            closeBatchDetailModal();
            const rEl = document.getElementById('batchAuditRemark');
            if (rEl) rEl.value = '';
        }
        loadInvitationBatches();
        loadInvitations();
    } catch (e) {
        alert('操作失败: ' + (e.message || '未知错误'));
    }
}

/** 名单页：勾选多条 → 批量通过 / 批量驳回（可跨批次） */
async function bulkAuditSelected(action) {
    if (!currentUser || currentUser.role !== 'admin') {
        alert('权限不足，仅管理员可以审批');
        return;
    }
    const ids = pendingSelectedIds();
    if (!ids.length) {
        alert('请先勾选「待审批」状态的邀约（已通过/已拒绝的不会重复处理）');
        return;
    }
    let remark = '';
    if (action === 'reject') {
        remark = prompt(`批量驳回 ${ids.length} 人，请填写原因：`);
        if (!remark) return;
    }
    if (!confirm(`确认批量${action === 'approve' ? '通过' : '驳回'} ${ids.length} 条邀约？`)) return;
    try {
        const res = await apiRequest('/invitations/bulk-audit', {
            method: 'POST',
            body: JSON.stringify({ ids, action, remark })
        });
        alert(res.message || '操作完成');
        resetInvitationSelectionUI();
        loadInvitations();
        if (invTab === 'batch') loadInvitationBatches();
    } catch (e) {
        alert('操作失败: ' + (e.message || '未知错误'));
    }
}

function updateAdminCheckinButtonState() {
    const btn = document.getElementById('adminCheckinBtn');
    if (!btn) return;
    btn.disabled = selectedInvitationIds.size === 0;
    btn.style.opacity = btn.disabled ? '0.5' : '1';
    btn.style.cursor = btn.disabled ? 'not-allowed' : 'pointer';
}

function toggleInvitationSelection(invitationId, checked, registrationStatus) {
    if (!currentUser || currentUser.role !== 'admin') {
        return;
    }
    const id = parseInt(invitationId);
    if (!Number.isFinite(id) || id <= 0) {
        return;
    }
    if (checked) {
        selectedInvitationIds.add(id);
        if (registrationStatus !== undefined && registrationStatus !== null) {
            selectedInvitationStatus.set(id, parseInt(registrationStatus));
        }
    } else {
        selectedInvitationIds.delete(id);
        selectedInvitationStatus.delete(id);
    }

    const selectable = Array.from(document.querySelectorAll('#invitationsTableBody .invitation-select')).filter(el => !el.disabled);
    const checkedSelectable = selectable.filter(el => el.checked);
    const selectAll = document.getElementById('invitationSelectAll');
    if (selectAll) {
        if (selectable.length === 0) {
            selectAll.checked = false;
            selectAll.indeterminate = false;
        } else if (checkedSelectable.length === 0) {
            selectAll.checked = false;
            selectAll.indeterminate = false;
        } else if (checkedSelectable.length === selectable.length) {
            selectAll.checked = true;
            selectAll.indeterminate = false;
        } else {
            selectAll.checked = false;
            selectAll.indeterminate = true;
        }
    }

    updateAdminCheckinButtonState();
    updateInvBulkAuditButtons();
}

function toggleSelectAllInvitations(checked) {
    if (!currentUser || currentUser.role !== 'admin') {
        return;
    }
    const checkboxes = Array.from(document.querySelectorAll('#invitationsTableBody .invitation-select')).filter(el => !el.disabled);
    checkboxes.forEach(cb => {
        cb.checked = checked;
        const id = parseInt(cb.dataset.id);
        if (Number.isFinite(id) && id > 0) {
            if (checked) {
                selectedInvitationIds.add(id);
                if (cb.dataset.st !== undefined) selectedInvitationStatus.set(id, parseInt(cb.dataset.st));
            } else {
                selectedInvitationIds.delete(id);
                selectedInvitationStatus.delete(id);
            }
        }
    });

    const selectAll = document.getElementById('invitationSelectAll');
    if (selectAll) {
        selectAll.indeterminate = false;
    }
    updateAdminCheckinButtonState();
    updateInvBulkAuditButtons();
}

async function adminCheckinSelectedInvitations() {
    if (!currentUser || currentUser.role !== 'admin') {
        alert('权限不足，仅管理员可以操作');
        return;
    }

    // 勾选框已放开（待审批也能勾），这里只吃「已报名(2)」的，避免误签未通过的人
    const ids = Array.from(selectedInvitationIds).filter(id => selectedInvitationStatus.get(id) === 2);
    if (ids.length === 0) {
        alert('请先勾选「已报名」状态的邀约（待审批的必须先审批通过才能签到）');
        return;
    }

    const ok = confirm(`${window.t('admin.confirmBatchCheckin', [ids.length])}`);
    if (!ok) return;

    try {
        const result = await apiRequest('/checkins/admin-checkin', {
            method: 'POST',
            body: JSON.stringify({ invitationIds: ids })
        });

        if (result.code !== 200) {
            alert(result.message || '签到失败');
            return;
        }

        const created = result.data?.created || 0;
        const failures = (result.data?.results || []).filter(r => !r.success);
        const failureText = failures.length > 0
            ? `${window.t('admin.failureCountBlock', [failures.length])}` + failures.map(f => `- ${f.invitation_id}: ${f.reason || window.t('admin.statusFailed')}`).join('\n')
            : '';

        alert(`已处理 ${result.data?.total || ids.length} 条，成功签到 ${created} 条。${failureText}`);
        resetInvitationSelectionUI();
        loadInvitations(currentInvitationPage, currentInvitationPageSize);
    } catch (error) {
        console.error('管理员代签到失败:', error);
        alert(error.message || '签到失败，请稍后重试');
    }
}

// 加载邀约列表
async function loadInvitations(page = currentInvitationPage, pageSize = currentInvitationPageSize) {
    try {
        resetInvitationSelectionUI();
        currentInvitationPage = page;
        currentInvitationPageSize = pageSize;
        
        let url = `/invitations?page=${page}&pageSize=${pageSize}`;

        // 添加搜索关键字
        const invitationSearch = document.getElementById('invitationSearch');
        const searchKeyword = (invitationSearch ? invitationSearch.value.trim() : '').trim();
        if (searchKeyword) {
            url += `&search=${encodeURIComponent(searchKeyword)}`;
        }
        
        // 添加状态筛选
        const registrationStatusFilter = document.getElementById('registrationStatusFilter');
        if (registrationStatusFilter && registrationStatusFilter.value) {
            url += `&registration_status=${registrationStatusFilter.value}`;
        }

        const sourceBd = (currentUser && currentUser.role === 'admin') ? getInvitationBdFilterUsername() : '';
        if (sourceBd) {
            url += `&source_bd=${encodeURIComponent(sourceBd)}`;
        }
        
        const data = await apiRequest(url);
        const tbody = document.getElementById('invitationsTableBody');
        tbody.innerHTML = '';

        const isAdmin = currentUser && currentUser.role === 'admin';

        // 更新统计（需要重新获取全部数据统计，或者从后端返回）
        const total = data.data?.total || 0;
        document.getElementById('totalInvitationsMini').textContent = total;
        
        let accepted = 0, pending = 0, pendingApproval = 0, rejected = 0;
        
        if (data.data?.list) {
            data.data.list.forEach(inv => {
                const tr = document.createElement('tr');
                const initial = inv.guest?.name ? inv.guest.name.charAt(0) : '?';
                const registrationStatus = inv.registration_status || 0;
                const isValid = inv.is_valid !== undefined ? inv.is_valid : 1;
                const isCheckedIn = !!inv.checkin;
                const modificationHistory = inv.guest?.modification_history;
                const isGuestModified = hasRealModification(modificationHistory);
                const nameStyle = isGuestModified ? 'color: #EF4444; font-weight: 600;' : '';
                const nameTitle = isGuestModified ? formatModificationHistory(modificationHistory) : '';
                
                // 统计状态（优先检查 is_valid）
                // 状态定义：0-待回复，1-待审批，2-已接受，3-已拒绝
                if (isValid === 0 || isValid === false) {
                    // 无效状态不参与其他统计
                } else if (registrationStatus === 0) {
                    pending++; // 待回复
                } else if (registrationStatus === 1) {
                    pendingApproval++; // 待审批
                } else if (registrationStatus === 2) {
                    accepted++; // 已接受
                } else if (registrationStatus === 3) {
                    rejected++; // 已拒绝
                }
                
                // 获取BD联系人信息（列表只显示姓名，不显示联系方式）
                let bdContact = '管理员';
                
                try {
                    // 优先使用关联查询的BD信息
                    if (inv.bd && typeof inv.bd === 'object' && inv.bd !== null) {
                        // 列表显示BD姓名（不显示联系方式）
                        if (inv.bd.name && String(inv.bd.name).trim() !== '' && String(inv.bd.name).trim() !== 'null') {
                            bdContact = String(inv.bd.name).trim();
                        } 
                        // 如果没有姓名，显示BD用户名
                        else if (inv.bd.username && String(inv.bd.username).trim() !== '' && String(inv.bd.username).trim() !== 'null') {
                            bdContact = String(inv.bd.username).trim();
                        }
                    }
                    
                    // 如果BD关联查询失败或没有数据，但source_bd有值，显示source_bd
                    if (bdContact === '管理员' && inv.source_bd) {
                        const sourceBd = String(inv.source_bd).trim();
                        if (sourceBd !== '' && sourceBd !== 'null' && sourceBd !== 'undefined') {
                            bdContact = sourceBd;
                        }
                    }
                } catch (e) {
                    console.error('获取BD联系人信息失败:', e, inv);
                    // 如果出错，至少尝试显示source_bd
                    if (inv.source_bd) {
                        bdContact = String(inv.source_bd).trim() || '管理员';
                    }
                }
                
                // 勾选框放开：只屏蔽「已无效」的行。
                // 待审批 / 已报名都能勾：批量通过只吃待审批的，代签到只吃已报名的，各取所需。
                let selectDisabled = false;
                let selectTitle = '';
                if (isValid === 0 || isValid === false) {
                    selectDisabled = true;
                    selectTitle = '邀约已无效';
                }

                tr.innerHTML = `
                    ${isAdmin ? `
                    <td style="text-align: center;">
                        <input class="invitation-select" type="checkbox" data-id="${inv.id}" data-st="${registrationStatus}" ${selectDisabled ? 'disabled' : ''} ${selectTitle ? `title=\"${selectTitle}\"` : ''} onchange="toggleInvitationSelection(${inv.id}, this.checked, ${registrationStatus})" />
                    </td>
                    ` : ''}
                    <td>
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <div style="width: 40px; height: 40px; border-radius: 50%; background: #DBEAFE; display: flex; align-items: center; justify-content: center; color: #155DFC; font-size: 16px; font-weight: 400;">${initial}</div>
                            <span style="${nameStyle}" ${nameTitle ? `title="${nameTitle}"` : ''}>${inv.guest?.name || '-'}</span>
                        </div>
                    </td>
                    <td>${inv.guest?.company || '-'}</td>
                    <td>${(inv.guest && inv.guest.position !== undefined && inv.guest.position !== null && String(inv.guest.position).trim() !== '' && String(inv.guest.position).trim() !== 'null' && String(inv.guest.position).trim() !== 'undefined') ? String(inv.guest.position).trim() : '-'}</td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <rect x="2.67" y="4" width="10.67" height="8" rx="1.33" stroke="#99A1AF" stroke-width="1.33"/>
                            </svg>
                            <span>${ec9I18n(inv.event, 'name') || '-'}</span>
                        </div>
                    </td>
                    <td>${bdContact}</td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <circle cx="8" cy="8" r="6.67" stroke="#99A1AF" stroke-width="1.33"/>
                                <path d="M8 4V8L10.67 10.67" stroke="#99A1AF" stroke-width="1.33" stroke-linecap="round"/>
                            </svg>
                            <span>${formatDateShort(inv.created_at)}</span>
                        </div>
                    </td>
                    <td>
                        <span class="status-badge ${getInvitationStatusClass(registrationStatus, isValid)}">${getInvitationStatusText(registrationStatus, isValid)}</span>
                    </td>
                    <td>
                        ${renderNeedPayCell(inv)}
                    </td>
                    <td>
                        <div style="display: flex; gap: 8px;">
                            <button class="btn btn-sm btn-outline" onclick="viewInvitation(${inv.id})">详情</button>
                            ${registrationStatus === 1 ? `
                                <button class="btn btn-sm btn-primary" onclick="approveInvitation(${inv.id})" title="批准">批准</button>
                            ` : ''}
                            ${(currentUser && currentUser.role === 'admin' && isValid !== 0 && registrationStatus !== 2) ? `
                                <button class="btn btn-sm btn-outline" onclick="markInvitationRegistered(${inv.id})" title="手动设为报名成功">报名成功</button>
                            ` : ''}
                            <button class="btn btn-sm btn-outline" onclick="sendSmsToInvitation(${inv.id})" title="发送短信">
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="display: inline-block; vertical-align: middle;">
                                    <path d="M1 3L7 7L13 3M1 3H13V11C13 11.5523 12.5523 12 12 12H2C1.44772 12 1 11.5523 1 11V3Z" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            ${inv.qr_code_url ? `
                                <button class="btn btn-sm btn-outline" onclick="downloadQRCode('${inv.qr_code_url}', '${inv.invite_code}')" title="下载二维码">
                                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="display: inline-block; vertical-align: middle;">
                                        <path d="M7 1V9M7 9L4 6M7 9L10 6" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"/>
                                        <path d="M1 11V12.33C1 12.7 1.3 13 1.67 13H12.33C12.7 13 13 12.7 13 12.33V11" stroke="currentColor" stroke-width="1.33" stroke-linecap="round"/>
                                    </svg>
                                </button>
                            ` : ''}
                            <button class="btn btn-sm btn-outline" onclick="deleteInvitation(${inv.id})" style="color: #EF4444; border-color: #EF4444;" title="删除">删除</button>
                        </div>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
        
        // 更新统计（使用后端返回的统计数据）
        if (data.data?.stats) {
            document.getElementById('acceptedInvitations').textContent = data.data.stats.accepted || 0;
            document.getElementById('pendingInvitations').textContent = data.data.stats.pending || 0;
            document.getElementById('pendingApprovalInvitations').textContent = data.data.stats.pendingApproval || 0;
            document.getElementById('rejectedInvitations').textContent = data.data.stats.rejected || 0;
            document.getElementById('totalInvitationsMini').textContent = data.data.stats.total || 0;
        } else {
            // 如果没有统计数据，使用当前页的统计作为占位
            document.getElementById('acceptedInvitations').textContent = accepted;
            document.getElementById('pendingInvitations').textContent = pending;
            document.getElementById('pendingApprovalInvitations').textContent = 0;
            document.getElementById('rejectedInvitations').textContent = rejected;
        }
        
        // 渲染分页
        renderInvitationPagination(data.data?.total || 0, data.data?.page || page, data.data?.pageSize || pageSize);

        // 翻页/筛选后清空勾选（避免跨页残留），并按角色显示批量审核按钮
        resetInvitationSelectionUI();
        const showBulk = !!(currentUser && currentUser.role === 'admin');
        const ap = document.getElementById('invBulkApproveBtn');
        const rj = document.getElementById('invBulkRejectBtn');
        if (ap) ap.style.display = showBulk ? '' : 'none';
        if (rj) rj.style.display = showBulk ? '' : 'none';
    } catch (error) {
        console.error('加载邀约列表失败:', error);
        const tbody = document.getElementById('invitationsTableBody');
        const colspan = (currentUser && currentUser.role === 'admin') ? 10 : 9;   // 含新增的「付款」列
        tbody.innerHTML = `<tr><td colspan="${colspan}" style="text-align: center; padding: 40px; color: #EF4444;">${window.t('admin.loadFailedWith', [error.message || window.t('admin.unknownError')])}<br><button onclick="loadInvitations()" style="margin-top: 10px; padding: 8px 16px; background: #155DFC; color: white; border: none; border-radius: 6px; cursor: pointer;">重试</button></td></tr>`;
    }
}

// 导出邀约Excel
async function exportInvitations() {
    try {
        let url = `/invitations/export`;
        const registrationStatusFilter = document.getElementById('registrationStatusFilter');
        const params = new URLSearchParams();
        if (registrationStatusFilter && registrationStatusFilter.value) {
            params.set('registration_status', registrationStatusFilter.value);
        }
        const sourceBd = (currentUser && currentUser.role === 'admin') ? getInvitationBdFilterUsername() : '';
        if (sourceBd) {
            params.set('source_bd', sourceBd);
        }
        if (Array.from(params.keys()).length > 0) {
            url += `?${params.toString()}`;
        }
        const res = await fetch(`${API_BASE}${url}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${currentToken || ''}`
            }
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || '导出失败');
        }
        const blob = await res.blob();
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `invitations_${new Date().toISOString().slice(0,10)}.xlsx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(downloadUrl);
    } catch (error) {
        console.error('导出邀约失败:', error);
        alert(error.message || '导出失败，请稍后重试');
    }
}

// 渲染邀约分页
function renderInvitationPagination(total, page, pageSize) {
    const pagination = document.getElementById('invitationPagination');
    if (!pagination) return;
    
    const totalPages = Math.ceil(total / pageSize);
    
    if (totalPages <= 1) {
        pagination.innerHTML = '';
        return;
    }
    
    let html = '<div style="display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;">';
    html += '<div style="display: flex; align-items: center; gap: 8px;">';
    
    // 上一页按钮
    if (page > 1) {
        html += `<button class="btn btn-sm btn-outline" onclick="loadInvitations(${page - 1}, ${pageSize})" style="min-width: 80px;"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="margin-right: 4px;"><path d="M10 12L6 8L10 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>上一页</button>`;
    } else {
        html += `<button class="btn btn-sm btn-outline" disabled style="min-width: 80px; opacity: 0.5;"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="margin-right: 4px;"><path d="M10 12L6 8L10 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>上一页</button>`;
    }
    
    // 页码按钮
    if (totalPages <= 7) {
        // 如果总页数少于等于7，显示所有页码
        for (let i = 1; i <= totalPages; i++) {
            html += `<button class="btn btn-sm ${i === page ? 'btn-primary' : 'btn-outline'}" onclick="loadInvitations(${i}, ${pageSize})" style="min-width: 36px;">${i}</button>`;
        }
    } else {
        // 显示第一页
        html += `<button class="btn btn-sm ${1 === page ? 'btn-primary' : 'btn-outline'}" onclick="loadInvitations(1, ${pageSize})" style="min-width: 36px;">1</button>`;
        
        // 计算显示的页码范围
        let start = Math.max(2, page - 1);
        let end = Math.min(totalPages - 1, page + 1);
        
        if (start > 2) {
            html += `<span style="padding: 0 8px; color: #6B7280;">...</span>`;
        }
        
        for (let i = start; i <= end; i++) {
            html += `<button class="btn btn-sm ${i === page ? 'btn-primary' : 'btn-outline'}" onclick="loadInvitations(${i}, ${pageSize})" style="min-width: 36px;">${i}</button>`;
        }
        
        if (end < totalPages - 1) {
            html += `<span style="padding: 0 8px; color: #6B7280;">...</span>`;
        }
        
        // 显示最后一页
        html += `<button class="btn btn-sm ${totalPages === page ? 'btn-primary' : 'btn-outline'}" onclick="loadInvitations(${totalPages}, ${pageSize})" style="min-width: 36px;">${totalPages}</button>`;
    }
    
    // 下一页按钮
    if (page < totalPages) {
        html += `<button class="btn btn-sm btn-outline" onclick="loadInvitations(${page + 1}, ${pageSize})" style="min-width: 80px;">下一页<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="margin-left: 4px;"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
    } else {
        html += `<button class="btn btn-sm btn-outline" disabled style="min-width: 80px; opacity: 0.5;">下一页<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="margin-left: 4px;"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
    }
    
    html += '</div>';
    
    // 每页条数选择
    html += `
        <div style="display: flex; align-items: center; gap: 8px; font-size: 14px; color: #6B7280;">
            <span>每页显示：</span>
            <select onchange="changeInvitationPageSize(this.value)" style="padding: 6px 12px; border: 1px solid #D1D5DB; border-radius: 6px; font-size: 14px; background: white; cursor: pointer; min-width: 80px;">
                <option value="10" ${pageSize === 10 ? 'selected' : ''}>10 条</option>
                <option value="20" ${pageSize === 20 ? 'selected' : ''}>20 条</option>
                <option value="50" ${pageSize === 50 ? 'selected' : ''}>50 条</option>
                <option value="100" ${pageSize === 100 ? 'selected' : ''}>100 条</option>
            </select>
            <span>${window.t('admin.totalCount', [total])}</span>
        </div>
    `;
    
    html += '</div>';
    pagination.innerHTML = html;
}

// 修改邀约每页条数
function changeInvitationPageSize(newSize) {
    loadInvitations(1, parseInt(newSize));
}

// 加载签到列表
async function loadCheckins() {
    try {
        const data = await apiRequest('/checkins');
        const tbody = document.getElementById('checkinsTableBody');
        tbody.innerHTML = '';
        
        // 更新统计
        const total = data.data?.total || 0;
        document.getElementById('totalCheckinsMini').textContent = total;
        
        const today = new Date().toISOString().split('T')[0];
        let todayCount = 0;
        let weekCount = 0;
        let onsiteCount = 0;
        
        if (data.data?.list) {
            data.data.list.forEach(checkin => {
                const tr = document.createElement('tr');
                const initial = checkin.guest?.name ? checkin.guest.name.charAt(0) : '?';
                const checkinDate = checkin.checkin_time ? checkin.checkin_time.split('T')[0] : '';
                const checkinDateTime = formatDateTime(checkin.checkin_time);
                
                // 统计
                if (checkinDate === today) todayCount++;
                if (isThisWeek(checkin.checkin_time)) weekCount++;
                if (checkin.location_type === 1) onsiteCount++;
                
                tr.innerHTML = `
                    <td>
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <div style="width: 40px; height: 40px; border-radius: 50%; background: #DBEAFE; display: flex; align-items: center; justify-content: center; color: #155DFC; font-size: 16px; font-weight: 400;">${initial}</div>
                            <span>${checkin.guest?.name || '-'}</span>
                        </div>
                    </td>
                    <td>${checkin.guest?.company || '-'}</td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <rect x="2.67" y="4" width="10.67" height="8" rx="1.33" stroke="#99A1AF" stroke-width="1.33"/>
                            </svg>
                            <span>${ec9I18n(checkin.event, 'name') || '-'}</span>
                        </div>
                    </td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <circle cx="8" cy="8" r="6.67" stroke="#99A1AF" stroke-width="1.33"/>
                                <path d="M8 4V8L10.67 10.67" stroke="#99A1AF" stroke-width="1.33" stroke-linecap="round"/>
                            </svg>
                            <span>${checkinDateTime}</span>
                        </div>
                    </td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <path d="M8 2.67C5.43 2.67 3.33 4.77 3.33 7.33C3.33 11.17 8 15.33 8 15.33C8 15.33 12.67 11.17 12.67 7.33C12.67 4.77 10.57 2.67 8 2.67Z" stroke="#99A1AF" stroke-width="1.33"/>
                                <circle cx="8" cy="7.33" r="2" stroke="#99A1AF" stroke-width="1.33"/>
                            </svg>
                            <span>${checkin.remark || window.t('admin.defaultEntrance')}</span>
                        </div>
                    </td>
                    <td>
                        <span class="status-badge status-active">现场</span>
                    </td>
                    <td>
                        <button class="btn-icon" onclick="viewCheckin(${checkin.id})" title="查看详情">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <path d="M8 3C4.67 3 1.82 5.07 1 8C1.82 10.93 4.67 13 8 13C11.33 13 14.18 10.93 15 8C14.18 5.07 11.33 3 8 3Z" stroke="currentColor" stroke-width="1.33"/>
                                <circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.33"/>
                            </svg>
                        </button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
            
            // 渲染时间线
            renderCheckinTimeline(data.data?.list || []);
        }
        
        document.getElementById('todayCheckins').textContent = todayCount;
        document.getElementById('weekCheckins').textContent = weekCount;
        document.getElementById('onsiteCheckins').textContent = onsiteCount;
    } catch (error) {
        console.error('加载签到列表失败:', error);
    }
}

// 渲染签到时间线
function renderCheckinTimeline(checkins) {
    const container = document.getElementById('checkinTimeline');
    container.innerHTML = '';
    
    // 按时间倒序，只显示前6条
    const sorted = checkins
        .filter(c => c.checkin_time)
        .sort((a, b) => new Date(b.checkin_time) - new Date(a.checkin_time))
        .slice(0, 6);
    
    sorted.forEach((checkin, index) => {
        const item = document.createElement('div');
        item.className = 'timeline-item';
        const dateTime = formatDateTime(checkin.checkin_time);
        
        item.innerHTML = `
            <div class="timeline-dot"></div>
            <div class="timeline-content">
                <div class="timeline-header">
                    <div>
                        <div class="timeline-title">${window.t('admin.checkedInDone', [checkin.guest?.name || '-'])}</div>
                        <div class="timeline-desc">${ec9I18n(checkin.event, 'name') || '-'}</div>
                    </div>
                    <div class="timeline-time">${dateTime}</div>
                </div>
                <div class="timeline-meta">
                    <div class="timeline-meta-item">
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                            <path d="M6 1C3.24 1 1 3.24 1 6C1 9.5 6 11 6 11C6 11 11 9.5 11 6C11 3.24 8.76 1 6 1Z" stroke="#4A5565" stroke-width="1"/>
                            <circle cx="6" cy="6" r="1.5" stroke="#4A5565" stroke-width="1"/>
                        </svg>
                        <span>${checkin.remark || window.t('admin.defaultEntrance')}</span>
                    </div>
                </div>
            </div>
        `;
        container.appendChild(item);
    });
}

// 加载操作日志
async function loadLogs() {
    try {
        const data = await apiRequest('/operation-logs');
        const tbody = document.getElementById('logsTableBody');
        tbody.innerHTML = '';
        
        // 更新统计
        const total = data.data?.total || 0;
        document.getElementById('totalLogs').textContent = total;
        
        let success = 0, failed = 0, today = 0;
        const todayStr = new Date().toISOString().split('T')[0];
        
        if (data.data?.list) {
            data.data.list.forEach(log => {
                const tr = document.createElement('tr');
                const logDate = log.created_at ? log.created_at.split('T')[0] : '';
                const logTime = formatDateTime(log.created_at);
                
                // 统计
                if (logDate === todayStr) today++;
                // 假设所有操作都是成功的（实际应该从API返回状态）
                success++;
                
                tr.innerHTML = `
                    <td>
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <div style="width: 32px; height: 32px; border-radius: 50%; background: #DBEAFE; display: flex; align-items: center; justify-content: center;">
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                    <circle cx="8" cy="8" r="7.5" stroke="#155DFC" stroke-width="1"/>
                                </svg>
                            </div>
                            <span>${log.admin_name || log.admin?.name || window.t('admin.defaultAdmin')}</span>
                        </div>
                    </td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <path d="M2.67 2.67H13.33V13.33H2.67V2.67Z" stroke="#99A1AF" stroke-width="1.33"/>
                            </svg>
                            <span>${log.action}</span>
                        </div>
                    </td>
                    <td>${log.target_type ? `${log.target_type} #${log.target_id}` : log.description || '-'}</td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <circle cx="8" cy="8" r="6.67" stroke="#99A1AF" stroke-width="1.33"/>
                                <path d="M8 4V8L10.67 10.67" stroke="#99A1AF" stroke-width="1.33" stroke-linecap="round"/>
                            </svg>
                            <span>${logTime}</span>
                        </div>
                    </td>
                    <td>
                        <span style="color: #4A5565; font-size: 14px;">${log.ip_address || '192.168.1.100'}</span>
                    </td>
                    <td>
                        <span class="status-badge status-active">成功</span>
                    </td>
                `;
                tbody.appendChild(tr);
            });
            
            // 渲染时间线
            renderLogTimeline(data.data?.list || []);
        }
        
        document.getElementById('successLogs').textContent = success;
        document.getElementById('failedLogs').textContent = failed;
        document.getElementById('todayLogs').textContent = today;
    } catch (error) {
        console.error('加载操作日志失败:', error);
    }
}

// 渲染操作日志时间线
function renderLogTimeline(logs) {
    const container = document.getElementById('logTimeline');
    container.innerHTML = '';
    
    // 按时间倒序，只显示前7条
    const sorted = logs
        .filter(l => l.created_at)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 7);
    
    sorted.forEach((log, index) => {
        const item = document.createElement('div');
        item.className = 'timeline-item';
        const dateTime = formatDateTime(log.created_at);
        
        item.innerHTML = `
            <div class="timeline-dot" style="background: #00A63E;"></div>
            <div class="timeline-content">
                <div class="timeline-header">
                    <div>
                        <div class="timeline-title">
                            <span style="font-weight: 500;">${log.admin_name || window.t('admin.defaultAdmin')}</span>
                            <span>${log.action}</span>
                        </div>
                        <div class="timeline-desc">${log.target_type ? `${log.target_type} #${log.target_id}` : log.description || '-'}</div>
                    </div>
                    <div class="timeline-time">${dateTime}</div>
                </div>
                <div class="timeline-meta">
                    <div class="timeline-meta-item">
                        <span>IP: ${log.ip_address || '192.168.1.100'}</span>
                    </div>
                    <div class="timeline-status">成功</div>
                </div>
            </div>
        `;
        container.appendChild(item);
    });
}

// 加载活动列表（用于统计）
async function loadEventList() {
    try {
        const data = await apiRequest('/events');
        const select = document.getElementById('eventSelect');
        select.innerHTML = '<option value="">全部活动</option>';
        
        if (data.data?.list) {
            data.data.list.forEach(event => {
                const option = document.createElement('option');
                option.value = event.id;
                option.textContent = event.name;
                select.appendChild(option);
            });
        }
    } catch (error) {
        console.error('加载活动列表失败:', error);
    }
}

// 加载统计
// 初始化统计页面
async function initStatisticsPage() {
    // 初始化活动选择器
    try {
        const events = await apiRequest('/events');
        // ⚠️ /events 返回的是分页结构 {list, total, page, pageSize}，不是数组
        //    （控制台 loadRecentEvents 已按 data.list 取，这里曾漏改导致 TypeError）
        if (events.code === 200 && events.data) {
            const eventSelect = document.getElementById('eventSelect');
            eventSelect.innerHTML = '<option value="">全部活动</option>';
            (events.data.list || []).forEach(event => {
                const option = document.createElement('option');
                option.value = event.id;
                option.textContent = event.name;
                eventSelect.appendChild(option);
            });
        }
    } catch (error) {
        console.error('加载活动列表失败:', error);
    }
    
    // 初始化月份选择器
    const monthSelect = document.getElementById('monthSelect');
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    
    // 生成最近12个月的选项
    monthSelect.innerHTML = '<option value="">选择月份</option>';
    for (let i = 0; i < 12; i++) {
        const date = new Date(currentYear, currentMonth - 1 - i, 1);
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const option = document.createElement('option');
        option.value = `${year}-${String(month).padStart(2, '0')}`;
        option.textContent = `${window.t('admin.yearMonth', [year, month])}`;
        if (i === 0) {
            option.selected = true;
        }
        monthSelect.appendChild(option);
    }
    
    // 加载统计数据
    loadStatistics();
}

async function loadStatistics() {
    const eventId = document.getElementById('eventSelect')?.value || '';
    const monthValue = document.getElementById('monthSelect')?.value || '';
    
    const content = document.getElementById('statisticsContent');
    content.innerHTML = '<div style="text-align: center; padding: 40px;"><div class="spinner"></div><p>加载中...</p></div>';
    
    try {
        // 解析年月
        let year, month;
        if (monthValue) {
            const [y, m] = monthValue.split('-');
            year = parseInt(y);
            month = parseInt(m);
        } else {
            const now = new Date();
            year = now.getFullYear();
            month = now.getMonth() + 1;
        }
        
        // 构建API请求URL
        let apiUrl = `/statistics/daily-registrations?year=${year}&month=${month}`;
        if (eventId) {
            apiUrl += `&event_id=${eventId}`;
        }
        
        const data = await apiRequest(apiUrl);
        
        if (data.code === 200) {
            renderCalendarView(data.data);
        } else {
            content.innerHTML = `<p style="text-align: center; padding: 40px; color: #EF4444;">${data.message || window.t('admin.loadFailed')}</p>`;
        }
    } catch (error) {
        console.error('加载统计失败:', error);
        content.innerHTML = `<p style="text-align: center; padding: 40px; color: #EF4444;">加载失败，请稍后重试</p>`;
    }
}

function renderCalendarView(data) {
    const content = document.getElementById('statisticsContent');
    const { year, month, calendar, total, events } = data;
    
    // 星期标题
    const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
    const weekDayNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    
    // 计算该月第一天是星期几
    const firstDay = calendar[0]?.dayOfWeek || 0;
    
    // 活动颜色映射（为每个活动分配不同颜色）
    const eventColors = [
        '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', 
        '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6366F1'
    ];
    const eventColorMap = {};
    events.forEach((event, index) => {
        eventColorMap[event.id] = eventColors[index % eventColors.length];
    });
    
    // 生成日历HTML
    let calendarHTML = `
        <div style="background: white; border-radius: 16px; padding: 32px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px;">
                <div>
                    <h3 style="margin: 0; font-size: 24px; font-weight: 700; color: #111827; margin-bottom: 8px;">${window.t('admin.yearMonthStats', [year, month])}</h3>
                    <p style="margin: 0; font-size: 14px; color: #6B7280;">按活动分类的每日报名数据</p>
                </div>
                <div style="display: flex; align-items: baseline; gap: 8px; background: #F0F9FF; padding: 16px 24px; border-radius: 12px; border: 1px solid #BAE6FD;">
                    <div style="font-size: 14px; color: #0369A1; font-weight: 500;">本月总计：</div>
                    <div style="font-size: 32px; font-weight: 700; color: #0284C7;">${total}</div>
                    <div style="font-size: 14px; color: #0369A1;">人</div>
                </div>
            </div>
            
            <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 12px;">
                <!-- 星期标题 -->
                ${weekDays.map((day, index) => `
                    <div style="
                        text-align: center; 
                        padding: 16px 8px; 
                        font-weight: 700; 
                        color: ${index === 0 || index === 6 ? '#EF4444' : '#374151'}; 
                        font-size: 15px; 
                        background: ${index === 0 || index === 6 ? '#FEF2F2' : '#F9FAFB'}; 
                        border-radius: 10px;
                        border: 1px solid ${index === 0 || index === 6 ? '#FEE2E2' : '#E5E7EB'};
                    ">
                        ${day}
                    </div>
                `).join('')}
                
                <!-- 空白填充（月初） -->
                ${Array(firstDay).fill(0).map(() => `
                    <div style="
                        aspect-ratio: 1; 
                        background: #FAFBFC; 
                        border-radius: 12px;
                        border: 1px solid #F3F4F6;
                    "></div>
                `).join('')}
                
                <!-- 日期格子 -->
                ${calendar.map(day => {
                    const isToday = isTodayDate(day.date);
                    const hasData = day.totalCount > 0;
                    const dateObj = new Date(day.date);
                    const monthDay = dateObj.getDate();
                    const weekDayName = weekDayNames[day.dayOfWeek];
                    const fullDate = `${window.t('admin.yearMonthDayWeek', [year, month, monthDay, weekDayName])}`;
                    
                    // 筛选出有报名的活动
                    const activeEvents = day.events.filter(e => e.count > 0);
                    
                    return `
                        <div style="
                            min-height: 140px;
                            background: ${isToday ? '#EFF6FF' : hasData ? '#FFFFFF' : '#FAFBFC'};
                            border: 2px solid ${isToday ? '#3B82F6' : hasData ? '#E5E7EB' : '#F3F4F6'};
                            border-radius: 12px;
                            padding: 12px;
                            display: flex;
                            flex-direction: column;
                            transition: all 0.2s;
                            position: relative;
                            ${isToday ? 'box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);' : ''}
                        ">
                            <!-- 日期和星期 -->
                            <div style="
                                display: flex;
                                flex-direction: column;
                                align-items: center;
                                margin-bottom: 8px;
                                padding-bottom: 8px;
                                border-bottom: 1px solid ${isToday ? '#BFDBFE' : '#F3F4F6'};
                            ">
                                <div style="
                                    font-size: 20px;
                                    font-weight: 700;
                                    color: ${isToday ? '#3B82F6' : hasData ? '#111827' : '#9CA3AF'};
                                    line-height: 1.2;
                                ">${monthDay}</div>
                                <div style="
                                    font-size: 11px;
                                    color: ${isToday ? '#60A5FA' : '#6B7280'};
                                    margin-top: 2px;
                                    font-weight: 500;
                                ">${weekDays[day.dayOfWeek]}</div>
                            </div>
                            
                            <!-- 活动数据 -->
                            <div style="flex: 1; display: flex; flex-direction: column; gap: 6px; overflow-y: auto;">
                                ${activeEvents.length > 0 ? activeEvents.map(event => {
                                    const color = eventColorMap[event.eventId] || '#6B7280';
                                    return `
                                        <div style="
                                            background: ${color}15;
                                            border-left: 3px solid ${color};
                                            padding: 6px 8px;
                                            border-radius: 6px;
                                            display: flex;
                                            justify-content: space-between;
                                            align-items: center;
                                        ">
                                            <div style="
                                                font-size: 11px;
                                                color: #374151;
                                                font-weight: 500;
                                                flex: 1;
                                                overflow: hidden;
                                                text-overflow: ellipsis;
                                                white-space: nowrap;
                                                margin-right: 4px;
                                            " title="${event.eventName}">${event.eventName}</div>
                                            <div style="
                                                font-size: 14px;
                                                font-weight: 700;
                                                color: ${color};
                                                min-width: 24px;
                                                text-align: right;
                                            ">${event.count}</div>
                                        </div>
                                    `;
                                }).join('') : `
                                    <div style="
                                        text-align: center;
                                        color: #9CA3AF;
                                        font-size: 11px;
                                        padding: 8px 0;
                                    ">无报名</div>
                                `}
                            </div>
                            
                            <!-- 总计（如果有数据） -->
                            ${hasData ? `
                                <div style="
                                    margin-top: 8px;
                                    padding-top: 8px;
                                    border-top: 1px solid ${isToday ? '#BFDBFE' : '#F3F4F6'};
                                    text-align: center;
                                ">
                                    <div style="
                                        font-size: 12px;
                                        color: #6B7280;
                                        margin-bottom: 2px;
                                    ">合计</div>
                                    <div style="
                                        font-size: 18px;
                                        font-weight: 700;
                                        color: ${isToday ? '#3B82F6' : '#111827'};
                                    ">${day.totalCount}</div>
                                </div>
                            ` : ''}
                        </div>
                    `;
                }).join('')}
            </div>
            
            <!-- 活动图例 -->
            ${events.length > 0 ? `
                <div style="
                    margin-top: 32px; 
                    padding-top: 24px; 
                    border-top: 2px solid #E5E7EB;
                ">
                    <div style="
                        font-size: 16px; 
                        color: #111827; 
                        font-weight: 600; 
                        margin-bottom: 16px;
                    ">活动图例</div>
                    <div style="
                        display: grid; 
                        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); 
                        gap: 12px;
                    ">
                        ${events.map(event => {
                            const color = eventColorMap[event.id] || '#6B7280';
                            return `
                                <div style="
                                    display: flex;
                                    align-items: center;
                                    gap: 12px;
                                    padding: 12px;
                                    background: #F9FAFB;
                                    border-radius: 8px;
                                    border: 1px solid #E5E7EB;
                                ">
                                    <div style="
                                        width: 20px;
                                        height: 20px;
                                        background: ${color};
                                        border-radius: 4px;
                                        flex-shrink: 0;
                                    "></div>
                                    <div style="
                                        font-size: 14px;
                                        color: #374151;
                                        font-weight: 500;
                                        flex: 1;
                                        overflow: hidden;
                                        text-overflow: ellipsis;
                                        white-space: nowrap;
                                    " title="${event.name}">${event.name}</div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            ` : ''}
        </div>
    `;
    
    content.innerHTML = calendarHTML;
}

// 判断是否是今天
function isTodayDate(dateStr) {
    const today = new Date();
    const date = new Date(dateStr);
    return date.getFullYear() === today.getFullYear() &&
           date.getMonth() === today.getMonth() &&
           date.getDate() === today.getDate();
}

// 根据数量计算强度（0-5）
function getIntensity(count) {
    if (count === 0) return 0;
    if (count <= 5) return 1;
    if (count <= 10) return 2;
    if (count <= 20) return 3;
    if (count <= 50) return 4;
    return 5;
}

// 根据强度返回颜色
function getColorByIntensity(intensity) {
    const colors = {
        0: '#F9FAFB',  // 无数据
        1: '#DBEAFE',  // 1-5人
        2: '#93C5FD',  // 6-10人
        3: '#60A5FA',  // 11-20人
        4: '#3B82F6',  // 21-50人
        5: '#2563EB'   // 50+人
    };
    return colors[intensity] || colors[0];
}

// 工具函数
function formatDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleString('zh-CN');
}

function formatDateShort(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleDateString('zh-CN');
}

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

function maskPhone(phone) {
    if (!phone || phone.length < 11) return phone;
    return phone.substring(0, 3) + '****' + phone.substring(7);
}

function isThisWeek(dateString) {
    if (!dateString) return false;
    const date = new Date(dateString);
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return date >= weekAgo && date <= now;
}

// 将后端的 modification_history 展开为统一的变更项列表
// 支持两种结构：
// 1) 旧结构：[{ field, from, to, timestamp }, ...]
// 2) 新结构：[{ modified_at, modified_by, modified_source, changes: { name: {old,new}, company:{old,new} } }, ...]
function extractModificationItems(history) {
    if (!history) return [];

    const normalize = (v) => {
        if (v === null || v === undefined) return '';
        return String(v).trim();
    };

    const rawItems = Array.isArray(history)
        ? history
        : (typeof history === 'object' ? Object.values(history) : []);

    const result = [];

    rawItems.forEach(entry => {
        if (!entry) return;

        // 新结构：带 changes 的记录
        if (entry.changes && typeof entry.changes === 'object') {
            const time = entry.modified_at || entry.timestamp || entry.time || entry.updated_at || '';
            Object.keys(entry.changes).forEach(key => {
                const change = entry.changes[key] || {};
                const from = normalize(change.old ?? change.from ?? change.oldValue ?? '');
                const to = normalize(change.new ?? change.to ?? change.newValue ?? '');
                result.push({
                    field: key,
                    from,
                    to,
                    time
                });
            });
        } else {
            // 旧结构：单条记录
            const field = entry.field || entry.key || '字段未知';
            const from = normalize(entry.from ?? entry.oldValue ?? '');
            const to = normalize(entry.to ?? entry.newValue ?? '');
            const time = entry.timestamp || entry.time || entry.updated_at || '';
            result.push({ field, from, to, time });
        }
    });

    return result;
}

// 格式化嘉宾修改历史为 tooltip / 展示文本
function formatModificationHistory(history) {
    const items = extractModificationItems(history);
    if (!items.length) return '';

    const lines = items
        .filter(item => {
            const from = (item.from || '').trim();
            const to = (item.to || '').trim();
            if (from === to) return false;
            // 新增：如果原值为空、新值非空，认为是“新增录入”，不算修改
            if (!from && to) return false;
            if (!from && !to) return false;
            return true;
        })
        .map(item => {
            const timeText = item.time ? ` (${formatDateTime(item.time)})` : '';
            const fromText = item.from || '（空）';
            const toText = item.to || '（空）';
            return `${item.field}: ${fromText} -> ${toText}${timeText}`;
        });

    return lines.join('\\n');
}

// 在详情中渲染修改历史
function renderModificationHistory(history) {
    const items = extractModificationItems(history);
    if (!items.length) return '';

    const filtered = items.filter(item => {
        const from = (item.from || '').trim();
        const to = (item.to || '').trim();
        if (from === to) return false;
        // 新增：如果原值为空、新值非空，认为是“新增录入”，不算修改
        if (!from && to) return false;
        if (!from && !to) return false;
        return true;
    });

    if (!filtered.length) return '';

    return `
        <ul style="margin: 0; padding-left: 16px; color: #6B7280;">
            ${filtered.map(item => {
                const timeText = item.time ? `（${formatDateTime(item.time)}）` : '';
                const fromText = item.from || '（空）';
                const toText = item.to || '（空）';
                return `<li>${item.field}: ${fromText} → ${toText}${timeText}</li>`;
            }).join('')}
        </ul>
    `;
}

// 判断是否存在真实的修改记录（过滤掉空、相同值）
function hasRealModification(history) {
    const items = extractModificationItems(history);
    if (!items.length) return false;
    const filtered = items.filter(item => {
        const from = (item.from || '').trim();
        const to = (item.to || '').trim();
        if (from === to) return false;
        // 新增：如果原值为空、新值非空，认为是“新增录入”，不算修改
        if (!from && to) return false;
        if (!from && !to) return false;
        return true;
    });
    return filtered.length > 0;
}

function getEventStatusText(status) {
    const statusMap = {
        0: '未开始',
        1: '进行中',
        2: '已结束'
    };
    return statusMap[status] || '未知';
}

function getEventStatusClass(status) {
    const classMap = {
        0: 'status-pending',
        1: 'status-active',
        2: 'status-inactive'
    };
    return classMap[status] || '';
}

// 获取审批状态文本
function getApprovalStatusText(approvalStatus) {
    const statusMap = {
        0: '已同意',
        1: '待审批',
        2: '已通过',
        3: '已拒绝'
    };
    return statusMap[approvalStatus] || '未知';
}

// 获取审批状态样式类
function getApprovalStatusClass(approvalStatus) {
    const classMap = {
        0: 'status-active',    // 已同意 - 绿色
        1: 'status-warning',  // 待审批 - 黄色
        2: 'status-active',   // 已通过 - 绿色
        3: 'status-danger'    // 已拒绝 - 红色
    };
    return classMap[approvalStatus] || 'status-warning';
}

function getInvitationStatusText(registrationStatus, isValid) {
    // 优先检查 is_valid，如果无效，显示"邀约链接无效"
    if (isValid === 0 || isValid === false) {
        return '邀约链接无效';
    }
    
    // 状态定义：0-待回复，1-待审批，2-已接受，3-已拒绝
    const statusMap = {
        0: '待回复',
        1: '待审批',
        2: '已接受',
        3: '已拒绝'
    };
    return statusMap[registrationStatus] || '待回复';
}

function getInvitationStatusClass(registrationStatus, isValid) {
    // 优先检查 is_valid，如果无效，使用灰色样式
    if (isValid === 0 || isValid === false) {
        return 'status-disabled';
    }
    
    // 状态定义：0-待回复，1-待审批，2-已接受，3-已拒绝
    const classMap = {
        0: 'status-warning',  // 待回复 - 黄色
        1: 'status-warning',  // 待审批 - 黄色
        2: 'status-active',   // 已接受 - 绿色
        3: 'status-danger'    // 已拒绝 - 红色
    };
    return classMap[registrationStatus] || 'status-warning';
}

// ==================== 活动管理模态框 ====================

let currentEventId = null;
let eventExtraFieldIndex = 0;

function showEventModal(eventId = null) {
    currentEventId = eventId;
    const modal = document.getElementById('eventModal');
    const form = document.getElementById('eventForm');
    const title = document.getElementById('eventModalTitle');
    
    // 重置表单
    form.reset();
    fillEventI18n(null);
    document.getElementById('eventExtraFields').innerHTML = '';
    eventExtraFieldIndex = 0;
    
    if (eventId) {
        // 编辑模式
        title.textContent = '编辑活动';
        loadEventData(eventId);
    } else {
        // 创建模式
        title.textContent = '创建活动';
        // 设置默认时间（当前时间）
        const now = new Date();
        now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
        document.getElementById('eventStartTime').value = now.toISOString().slice(0, 16);
        const endTime = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 默认2小时后
        document.getElementById('eventEndTime').value = endTime.toISOString().slice(0, 16);
    }
    
    modal.classList.remove('hidden');
}

/* ============================================================
 * 活动多语内容：一个 JSON 字段
 *   { name:{ 'zh-TW':…, en:… }, description:{…}, location:{…} }
 * 简体存在 name / description / location 原字段，i18n 里只存译文。
 * ============================================================ */
const EVENT_I18N_FIELDS = ['name', 'description', 'location'];

/** 字段 -> 繁/英输入框 id */
const EVENT_I18N_INPUTS = {
  name:      { 'zh-TW': 'i18nNameTw',      en: 'i18nNameEn' },
  description:{ 'zh-TW': 'i18nDescTw',      en: 'i18nDescEn' },
  location:  { 'zh-TW': 'i18nLocationTw',  en: 'i18nLocationEn' }
};
/** 字段 -> 「已填写」状态标签 id */
const EVENT_I18N_STATE = {
  name:      { 'zh-TW': 'stateNameTw',     en: 'stateNameEn' },
  description:{ 'zh-TW': 'stateDescTw',    en: 'stateDescEn' },
  location:  { 'zh-TW': 'stateLocationTw', en: 'stateLocationEn' }
};

/** 从表单收集 i18n 树 */
function collectEventI18n() {
  const out = {};
  EVENT_I18N_FIELDS.forEach(f => {
    const node = {};
    ['zh-TW', 'en'].forEach(lang => {
      const el = document.getElementById(EVENT_I18N_INPUTS[f][lang]);
      const v = el ? el.value.trim() : '';
      if (v) node[lang] = v;
    });
    if (Object.keys(node).length) out[f] = node;
  });
  return Object.keys(out).length ? out : null;
}

/** 用 i18n 树回填输入框 */
function fillEventI18n(tree) {
  const t = (tree && typeof tree === 'object') ? tree : {};
  EVENT_I18N_FIELDS.forEach(f => {
    const node = t[f] && typeof t[f] === 'object' ? t[f] : {};
    ['zh-TW', 'en'].forEach(lang => {
      const el = document.getElementById(EVENT_I18N_INPUTS[f][lang]);
      if (el) el.value = node[lang] || '';
      updateI18nState(f, lang);
    });
  });
}

/** 更新「已填写」标记 */
function updateI18nState(field, lang) {
  const el = document.getElementById(EVENT_I18N_STATE[field][lang]);
  if (!el) return;
  const input = document.getElementById(EVENT_I18N_INPUTS[field][lang]);
  const filled = input && input.value.trim() !== '';
  el.textContent = filled ? (window.t ? window.t('admin.translateDone') : '已填写') : '';
  el.classList.toggle('filled', !!filled);
}

/** 取某个字段的简体原文 */
function eventSourceText(field) {
  const map = { name: 'eventName', description: 'eventDescription', location: 'eventLocation' };
  const el = document.getElementById(map[field]);
  return el ? el.value.trim() : '';
}

/** 调后端翻译 */
async function callTranslate(text, targets) {
  const res = await fetch(`${API_BASE}/events/translate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${currentToken}`
    },
    body: JSON.stringify({ text, targets })
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json.message || (window.t ? window.t('admin.translateApiFailed') : '翻译失败');
    throw new Error(json.hint ? `${msg}（${json.hint}）` : msg);
  }
  return json.data.results || {};
}

/** 翻译单个字段的两种语言 */
async function translateField(field) {
  const text = eventSourceText(field);
  if (!text) {
    alert(window.t ? window.t('admin.translateNoSource') : '请先填写简体中文内容');
    return;
  }
  const btns = document.querySelectorAll(`.btn-translate-one[data-field="${field}"]`);
  btns.forEach(b => b.disabled = true);
  try {
    const results = await callTranslate(text, ['zh-TW', 'en']);
    Object.keys(results).forEach(lang => {
      const el = document.getElementById(EVENT_I18N_INPUTS[field][lang]);
      if (el) el.value = results[lang];
      updateI18nState(field, lang);
    });
  } catch (e) {
    const code = String(e.message || '');
    const msg = (code.includes('未配置'))
      ? (window.t ? window.t('admin.translateNotConfigured') : '翻译服务未配置，请联系管理员')
      : (window.t ? window.t('admin.translateFailed') : '翻译失败，请稍后重试或手动填写');
    alert(msg + '\n' + code);
  } finally {
    btns.forEach(b => b.disabled = false);
  }
}

/** 一键翻译全部（只译简体非空的字段） */
async function translateAllFields() {
  const targets = EVENT_I18N_FIELDS.filter(f => eventSourceText(f));
  if (!targets.length) {
    alert(window.t ? window.t('admin.translateNoSource') : '请先填写简体中文内容');
    return;
  }
  const btn = document.getElementById('btnTranslateAll');
  if (btn) {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = window.t ? window.t('admin.translating') : '翻译中…';
    try {
      for (const field of targets) {
        const text = eventSourceText(field);
        const results = await callTranslate(text, ['zh-TW', 'en']);
        Object.keys(results).forEach(lang => {
          const el = document.getElementById(EVENT_I18N_INPUTS[field][lang]);
          // 已有译文不覆盖，避免把人工改过的内容冲掉
          if (el && !el.value.trim()) el.value = results[lang];
          updateI18nState(field, lang);
        });
      }
    } catch (e) {
      const code = String(e.message || '');
      const msg = (code.includes('未配置'))
        ? (window.t ? window.t('admin.translateNotConfigured') : '翻译服务未配置，请联系管理员')
        : (window.t ? window.t('admin.translateFailed') : '翻译失败，请稍后重试或手动填写');
      alert(msg + '\n' + code);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }
}

function closeEventModal() {
    document.getElementById('eventModal').classList.add('hidden');
    document.getElementById('eventForm').reset();
    document.getElementById('eventExtraFields').innerHTML = '';
    currentEventId = null;
    eventExtraFieldIndex = 0;
}

// 设置扩展所属输入类型
function setEventBelongType(type) {
    const textContainer = document.getElementById('eventBelongTextContainer');
    const richContainer = document.getElementById('eventBelongRichContainer');
    const textBtn = document.getElementById('eventBelongTypeText');
    const richBtn = document.getElementById('eventBelongTypeRich');
    const typeInput = document.getElementById('eventBelongType');
    
    if (!textContainer || !richContainer || !textBtn || !richBtn || !typeInput) return;
    
    if (type === 'text') {
        textContainer.style.display = 'block';
        richContainer.style.display = 'none';
        textBtn.classList.add('btn-primary');
        textBtn.classList.remove('btn-outline');
        richBtn.classList.remove('btn-primary');
        richBtn.classList.add('btn-outline');
        typeInput.value = 'text';
    } else {
        textContainer.style.display = 'none';
        richContainer.style.display = 'block';
        richBtn.classList.add('btn-primary');
        richBtn.classList.remove('btn-outline');
        textBtn.classList.remove('btn-primary');
        textBtn.classList.add('btn-outline');
        typeInput.value = 'rich';
    }
}

// 格式化富文本（用于扩展属性字段）
function formatRichTextForField(fieldId, command, value = null) {
    const fieldItem = document.getElementById(fieldId);
    if (!fieldItem) return;
    const editor = fieldItem.querySelector('.field-value-rich');
    if (!editor) return;
    editor.focus();
    document.execCommand(command, false, value);
}

// 初始化富文本编辑框的placeholder效果（用于扩展属性字段）
function initRichEditorPlaceholderForField(editor) {
    if (!editor) return;
    
    const placeholder = editor.getAttribute('data-placeholder') || '字段值';
    
    // 设置初始placeholder
    if (!editor.textContent.trim()) {
        editor.setAttribute('data-placeholder', placeholder);
        editor.classList.add('rich-editor-empty');
    }
    
    // 监听焦点事件
    editor.addEventListener('focus', function() {
        if (!this.textContent.trim()) {
            this.classList.add('rich-editor-empty');
        } else {
            this.classList.remove('rich-editor-empty');
        }
    });
    
    // 监听失焦事件
    editor.addEventListener('blur', function() {
        if (!this.textContent.trim()) {
            this.classList.add('rich-editor-empty');
        } else {
            this.classList.remove('rich-editor-empty');
        }
    });
    
    // 监听输入事件
    editor.addEventListener('input', function() {
        if (!this.textContent.trim()) {
            this.classList.add('rich-editor-empty');
        } else {
            this.classList.remove('rich-editor-empty');
        }
    });
}

async function loadEventData(eventId) {
    try {
        const data = await apiRequest(`/events/${eventId}`);
        const event = data.data;
        
        document.getElementById('eventName').value = event.name || '';
        document.getElementById('eventDescription').value = event.description || '';
        document.getElementById('eventLocation').value = event.location || '';
        fillEventI18n(event.i18n);
        document.getElementById('eventPageUrl').value = event.page_url || '';
        document.getElementById('eventStatus').value = event.status || 1;
        
        // 格式化时间
        if (event.start_time) {
            const startTime = new Date(event.start_time);
            startTime.setMinutes(startTime.getMinutes() - startTime.getTimezoneOffset());
            document.getElementById('eventStartTime').value = startTime.toISOString().slice(0, 16);
        }
        if (event.end_time) {
            const endTime = new Date(event.end_time);
            endTime.setMinutes(endTime.getMinutes() - endTime.getTimezoneOffset());
            document.getElementById('eventEndTime').value = endTime.toISOString().slice(0, 16);
        }
        
        // 加载扩展字段（富文本）
        if (event.extra_fields && typeof event.extra_fields === 'object') {
            for (const [key, value] of Object.entries(event.extra_fields)) {
                if (key !== '扩展所属_类型') {
                    addEventExtraField(key, value);
                }
            }
        }
    } catch (error) {
        console.error('加载活动数据失败:', error);
        alert('加载活动数据失败');
    }
}

async function handleEventSubmit(e) {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    const data = {
        name: formData.get('name'),
        description: formData.get('description'),
        start_time: formData.get('start_time'),
        end_time: formData.get('end_time'),
        location: formData.get('location'),
        page_url: formData.get('page_url'),
        status: parseInt(formData.get('status')),
        // 多语内容：一个 JSON 字段搞定（简体不用放，原字段就是简体）
        i18n: collectEventI18n()
    };
    
    // 收集扩展字段（富文本）
    const extraFields = {};
    const extraFieldsContainer = document.getElementById('eventExtraFields');
    const fieldItems = extraFieldsContainer.querySelectorAll('.extra-field-item');
    fieldItems.forEach(item => {
        const key = item.querySelector('.field-name').value.trim();
        const richEditor = item.querySelector('.field-value-rich');
        const value = richEditor ? richEditor.innerHTML.trim() : '';
        if (key && value) {
            extraFields[key] = value;
        }
    });
    
    if (Object.keys(extraFields).length > 0) {
        data.extra_fields = extraFields;
    }
    
    try {
        let response;
        if (currentEventId) {
            // 更新
            response = await fetch(`${API_BASE}/events/${currentEventId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentToken}`
                },
                body: JSON.stringify(data)
            });
        } else {
            // 创建
            response = await fetch(`${API_BASE}/events`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentToken}`
                },
                body: JSON.stringify(data)
            });
        }
        
        const result = await response.json();
        
        if (result.code === 200 || result.code === 201) {
            alert(currentEventId ? '更新成功' : '创建成功');
            closeEventModal();
            loadEvents();
        } else {
            alert(result.message || '操作失败');
        }
    } catch (error) {
        console.error('提交失败:', error);
        alert('操作失败，请稍后重试');
    }
}

function addEventExtraField(key = '', value = '') {
    const container = document.getElementById('eventExtraFields');
    const fieldId = `event_extra_${eventExtraFieldIndex++}`;
    
    const fieldItem = document.createElement('div');
    fieldItem.className = 'extra-field-item';
    fieldItem.innerHTML = `
        <div class="field-header">
            <input type="text" class="field-name" placeholder="字段名" value="${key}" style="flex: 1; padding: 8px; border: 1px solid #D1D5DB; border-radius: 6px;">
            <button type="button" class="remove-btn" onclick="removeEventExtraField('${fieldId}')">×</button>
        </div>
        <div class="field-value-wrapper">
            <div class="field-value-rich" contenteditable="true" data-placeholder="字段值" style="min-height: 80px; padding: 8px; border: 1px solid #D1D5DB; border-radius: 6px; background: #fff; overflow-y: auto; outline: none;">${value}</div>
            <div class="rich-text-toolbar" style="margin-top: 4px; display: flex; gap: 4px; flex-wrap: wrap;">
                <button type="button" class="btn btn-outline btn-sm" onclick="formatRichTextForField('${fieldId}', 'bold')" style="font-size: 10px; padding: 2px 6px;">粗体</button>
                <button type="button" class="btn btn-outline btn-sm" onclick="formatRichTextForField('${fieldId}', 'italic')" style="font-size: 10px; padding: 2px 6px;">斜体</button>
                <button type="button" class="btn btn-outline btn-sm" onclick="formatRichTextForField('${fieldId}', 'underline')" style="font-size: 10px; padding: 2px 6px;">下划线</button>
                <button type="button" class="btn btn-outline btn-sm" onclick="formatRichTextForField('${fieldId}', 'insertUnorderedList')" style="font-size: 10px; padding: 2px 6px;">列表</button>
                <button type="button" class="btn btn-outline btn-sm" onclick="formatRichTextForField('${fieldId}', 'insertOrderedList')" style="font-size: 10px; padding: 2px 6px;">有序列表</button>
                <button type="button" class="btn btn-outline btn-sm" onclick="formatRichTextForField('${fieldId}', 'justifyLeft')" style="font-size: 10px; padding: 2px 6px;">左对齐</button>
                <button type="button" class="btn btn-outline btn-sm" onclick="formatRichTextForField('${fieldId}', 'justifyCenter')" style="font-size: 10px; padding: 2px 6px;">居中</button>
                <button type="button" class="btn btn-outline btn-sm" onclick="formatRichTextForField('${fieldId}', 'justifyRight')" style="font-size: 10px; padding: 2px 6px;">右对齐</button>
            </div>
        </div>
    `;
    fieldItem.id = fieldId;
    container.appendChild(fieldItem);
    
    // 初始化富文本编辑框的placeholder
    const richEditor = fieldItem.querySelector('.field-value-rich');
    if (richEditor) {
        initRichEditorPlaceholderForField(richEditor);
    }
}

function removeEventExtraField(fieldId) {
    const field = document.getElementById(fieldId);
    if (field) {
        field.remove();
    }
}

// ==================== 嘉宾管理模态框 ====================

let currentGuestId = null;
let guestExtraFieldIndex = 0;

function showGuestModal(guestId = null) {
    currentGuestId = guestId;
    const modal = document.getElementById('guestModal');
    const form = document.getElementById('guestForm');
    const title = document.getElementById('guestModalTitle');
    const historyDiv = document.getElementById('guestModificationHistory');
    
    // 重置表单
    form.reset();
    document.getElementById('guestExtraFields').innerHTML = '';
    guestExtraFieldIndex = 0;
    
    // 初始化标签复选框的样式更新
    initTagCheckboxStyles();
    
    if (guestId) {
        // 编辑模式
        title.textContent = '编辑嘉宾';
        // 编辑模式下，手机号不是必填的
        document.getElementById('guestPhone').removeAttribute('required');
        document.getElementById('phoneRequired').style.display = 'none';
        // 显示修改历史
        if (historyDiv) historyDiv.style.display = 'block';
        loadGuestData(guestId);
    } else {
        // 创建模式
        title.textContent = '添加嘉宾';
        // 创建模式下，手机号是必填的
        document.getElementById('guestPhone').setAttribute('required', 'required');
        document.getElementById('phoneRequired').style.display = 'inline';
        // 隐藏修改历史
        if (historyDiv) historyDiv.style.display = 'none';
    }
    
    modal.classList.remove('hidden');
}

// 初始化标签复选框样式更新
function initTagCheckboxStyles() {
    const checkboxes = ['tagVIP', 'tagTech', 'tagExecutive'];
    checkboxes.forEach(id => {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            // 移除旧的监听器（如果存在）
            const newCheckbox = checkbox.cloneNode(true);
            checkbox.parentNode.replaceChild(newCheckbox, checkbox);
            
            // 添加新的监听器
            newCheckbox.addEventListener('change', function() {
                const item = this.closest('.tag-checkbox-item');
                if (this.checked) {
                    item?.classList.add('checked');
                } else {
                    item?.classList.remove('checked');
                }
            });
        }
    });
}

function closeGuestModal() {
    document.getElementById('guestModal').classList.add('hidden');
    document.getElementById('guestForm').reset();
    // 清空标签
    const tagVIP = document.getElementById('tagVIP');
    const tagTech = document.getElementById('tagTech');
    const tagExecutive = document.getElementById('tagExecutive');
    tagVIP.checked = false;
    tagTech.checked = false;
    tagExecutive.checked = false;
    tagVIP.closest('.tag-checkbox-item')?.classList.remove('checked');
    tagTech.closest('.tag-checkbox-item')?.classList.remove('checked');
    tagExecutive.closest('.tag-checkbox-item')?.classList.remove('checked');
    document.getElementById('guestCustomTags').value = '';
    // 清空扩展字段
    document.getElementById('guestExtraFields').innerHTML = '';
    // 重置手机号必填状态
    document.getElementById('guestPhone').setAttribute('required', 'required');
    document.getElementById('phoneRequired').style.display = 'inline';
    currentGuestId = null;
}

async function loadGuestData(guestId) {
    try {
        const data = await apiRequest(`/guests/${guestId}`);
        const guest = data.data;
        
        document.getElementById('guestName').value = guest.name || '';
        // 注意：手机号是加密的，编辑时不能显示明文，需要特殊处理
        // 这里暂时留空，或者需要后端提供解密接口
        document.getElementById('guestPhone').value = '';
        document.getElementById('guestPhone').placeholder = '手机号已加密，如需修改请输入新手机号';
        document.getElementById('guestCompany').value = guest.company || '';
        document.getElementById('guestPosition').value = guest.position || '';
        document.getElementById('guestBdId').value = guest.bd_id || '';
        document.getElementById('guestRemark').value = guest.remark || '';
        
        // 加载修改历史
        await loadGuestModificationHistory(guestId);
        
        // 加载标签（从extra_fields中读取）
        // 清空所有标签复选框
        const tagVIP = document.getElementById('tagVIP');
        const tagTech = document.getElementById('tagTech');
        const tagExecutive = document.getElementById('tagExecutive');
        const tagVIPItem = tagVIP.closest('.tag-checkbox-item');
        const tagTechItem = tagTech.closest('.tag-checkbox-item');
        const tagExecutiveItem = tagExecutive.closest('.tag-checkbox-item');
        
        tagVIP.checked = false;
        tagTech.checked = false;
        tagExecutive.checked = false;
        tagVIPItem?.classList.remove('checked');
        tagTechItem?.classList.remove('checked');
        tagExecutiveItem?.classList.remove('checked');
        document.getElementById('guestCustomTags').value = '';
        
        if (guest.extra_fields && typeof guest.extra_fields === 'object') {
            // 检查是否有标签字段
            if (guest.extra_fields['VIP'] === true || guest.extra_fields['VIP'] === 'true') {
                tagVIP.checked = true;
                tagVIPItem?.classList.add('checked');
            }
            if (guest.extra_fields['技术'] === true || guest.extra_fields['技术'] === 'true') {
                tagTech.checked = true;
                tagTechItem?.classList.add('checked');
            }
            if (guest.extra_fields['高管'] === true || guest.extra_fields['高管'] === 'true') {
                tagExecutive.checked = true;
                tagExecutiveItem?.classList.add('checked');
            }
            
            // 加载其他扩展字段（排除标签字段）
            const tagKeys = ['VIP', '技术', '高管'];
            for (const [key, value] of Object.entries(guest.extra_fields)) {
                if (!tagKeys.includes(key)) {
                    addGuestExtraField(key, value);
                }
            }
        }
    } catch (error) {
        console.error('加载嘉宾数据失败:', error);
        alert('加载嘉宾数据失败');
    }
}

// 加载嘉宾修改历史
async function loadGuestModificationHistory(guestId) {
    try {
        const data = await apiRequest(`/guests/${guestId}/modification-history`);
        const history = data.data?.history || [];
        const content = document.getElementById('guestModificationHistoryContent');
        
        if (history.length === 0) {
            content.innerHTML = '<div style="font-size: 12px; color: #9CA3AF; text-align: center;">暂无修改记录</div>';
            return;
        }
        
        let html = '';
        history.forEach((record, index) => {
            const changes = record.changes || {};
            const changeItems = Object.keys(changes).map(key => {
                const change = changes[key];
                return `
                    <div style="font-size: 12px; margin-bottom: 4px;">
                        <span style="color: #6B7280;">${key === 'name' ? '姓名' : key === 'company' ? '公司' : key === 'position' ? '职位' : key}：</span>
                        <span style="text-decoration: line-through; color: #9CA3AF;">${change.old || '-'}</span>
                        <span style="margin: 0 4px; color: #6B7280;">→</span>
                        <span style="color: #155DFC; font-weight: 500;">${change.new || '-'}</span>
                    </div>
                `;
            }).join('');
            
            html += `
                <div style="margin-bottom: 16px; padding-bottom: 16px; border-bottom: ${index < history.length - 1 ? '1px solid #E5E7EB' : 'none'};">
                    <div style="font-size: 11px; color: #9CA3AF; margin-bottom: 8px;">
                        ${formatDateTime(record.modified_at)} | 
                        ${record.modified_by === 'system' ? '系统' : record.modified_by} | 
                        ${record.modified_source === 'h5_registration' ? 'H5报名' : record.modified_source === 'admin_panel' ? '后台管理' : record.modified_source}
                    </div>
                    ${changeItems}
                </div>
            `;
        });
        
        content.innerHTML = html;
    } catch (error) {
        console.error('加载修改历史失败:', error);
        const content = document.getElementById('guestModificationHistoryContent');
        if (content) {
            content.innerHTML = '<div style="font-size: 12px; color: #EF4444; text-align: center;">加载失败</div>';
        }
    }
}

async function handleGuestSubmit(e) {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    const data = {
        name: formData.get('name'),
        company: formData.get('company'),
        position: formData.get('position'),
        bd_id: formData.get('bd_id') || null,
        remark: formData.get('remark')
    };
    
    // 如果手机号有输入，则更新
    const phone = formData.get('phone');
    if (phone && phone.trim()) {
        data.phone = phone.trim();
    }
    
    // 收集扩展字段（包括标签）
    const extraFields = {};
    
    // 添加标签到扩展字段
    if (document.getElementById('tagVIP').checked) {
        extraFields['VIP'] = true;
    }
    if (document.getElementById('tagTech').checked) {
        extraFields['技术'] = true;
    }
    if (document.getElementById('tagExecutive').checked) {
        extraFields['高管'] = true;
    }
    
    // 添加自定义标签（作为扩展字段）
    const customTags = document.getElementById('guestCustomTags').value;
    if (customTags && customTags.trim()) {
        const customTagsArray = customTags.split(',').map(tag => tag.trim()).filter(tag => tag);
        if (customTagsArray.length > 0) {
            extraFields['其他标签'] = customTagsArray.join(', ');
        }
    }
    
    // 收集其他扩展字段
    const extraFieldsContainer = document.getElementById('guestExtraFields');
    const fieldItems = extraFieldsContainer.querySelectorAll('.extra-field-item');
    fieldItems.forEach(item => {
        const key = item.querySelector('.field-name').value.trim();
        const value = item.querySelector('.field-value').value.trim();
        if (key && value) {
            extraFields[key] = value;
        }
    });
    
    // 总是添加extra_fields，即使为空对象（用于清空标签）
    // 这样可以确保更新时能正确清除未选中的标签
    data.extra_fields = extraFields;
    
    try {
        let response;
        if (currentGuestId) {
            // 更新
            response = await fetch(`${API_BASE}/guests/${currentGuestId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentToken}`
                },
                body: JSON.stringify(data)
            });
        } else {
            // 创建
            const phone = formData.get('phone');
            if (!phone || !phone.trim()) {
                alert('请输入手机号');
                document.getElementById('guestPhone').focus();
                return;
            }
            data.phone = phone.trim();
            response = await fetch(`${API_BASE}/guests`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentToken}`
                },
                body: JSON.stringify(data)
            });
        }
        
        const result = await response.json();
        
        if (result.code === 200 || result.code === 201) {
            alert(currentGuestId ? '更新成功' : '创建成功');
            closeGuestModal();
            loadGuests();
        } else {
            alert(result.message || '操作失败');
        }
    } catch (error) {
        console.error('提交失败:', error);
        alert('操作失败，请稍后重试');
    }
}

function addGuestExtraField(key = '', value = '') {
    const container = document.getElementById('guestExtraFields');
    const fieldId = `guest_extra_${guestExtraFieldIndex++}`;
    
    const fieldItem = document.createElement('div');
    fieldItem.className = 'extra-field-item';
    fieldItem.innerHTML = `
        <input type="text" class="field-name" placeholder="字段名" value="${key}" style="min-width: 120px;">
        <input type="text" class="field-value" placeholder="字段值" value="${value}">
        <button type="button" class="remove-btn" onclick="removeGuestExtraField('${fieldId}')">×</button>
    `;
    fieldItem.id = fieldId;
    container.appendChild(fieldItem);
}

function removeGuestExtraField(fieldId) {
    const field = document.getElementById(fieldId);
    if (field) {
        field.remove();
    }
}

// ==================== 其他模态框（占位） ====================

// 显示导入模态框
function showImportModal() {
    // 创建导入模态框HTML
    const modalHtml = `
        <div id="importModal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>导入嘉宾</h2>
                    <span class="close" onclick="closeImportModal()">&times;</span>
                </div>
                <div class="modal-body">
                    <div class="import-section">
                        <div class="import-tips">
                            <h3>📋 导入说明</h3>
                            <ul>
                                <li>支持 .xlsx 和 .xls 格式的Excel文件</li>
                                <li>文件大小不超过 5MB</li>
                                <li>Excel表格应包含以下列：姓名、公司、手机号、职位（可选）、备注（可选）</li>
                                <li>手机号必须是11位数字</li>
                            </ul>
                        </div>
                        <div class="file-upload-area">
                            <input type="file" id="excelFileInput" accept=".xlsx,.xls" style="display: none;">
                            <button class="btn btn-primary" onclick="document.getElementById('excelFileInput').click()">
                                选择Excel文件
                            </button>
                            <p id="selectedFileName" class="selected-file"></p>
                        </div>
                        <div id="uploadProgress" class="upload-progress" style="display: none;">
                            <div class="progress-bar">
                                <div id="progressBar" class="progress-fill"></div>
                            </div>
                            <p id="progressText">上传中...</p>
                        </div>
                        <div id="importResult" class="import-result" style="display: none;">
                            <h3 id="resultTitle"></h3>
                            <div id="resultContent"></div>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeImportModal()">关闭</button>
                    <button id="uploadBtn" class="btn btn-primary" onclick="uploadExcelFile()" disabled>开始导入</button>
                </div>
            </div>
        </div>
    `;
    
    // 添加模态框到页面
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // 监听文件选择
    document.getElementById('excelFileInput').addEventListener('change', handleFileSelect);
    
    // 显示模态框
    document.getElementById('importModal').style.display = 'flex';
}

// 关闭导入模态框
function closeImportModal() {
    const modal = document.getElementById('importModal');
    if (modal) {
        modal.remove();
    }
}

// 处理文件选择
function handleFileSelect(event) {
    const file = event.target.files[0];
    const uploadBtn = document.getElementById('uploadBtn');
    const selectedFileName = document.getElementById('selectedFileName');
    
    if (file) {
        selectedFileName.textContent = `${window.t('admin.fileSelected', [file.name, (file.size / 1024).toFixed(2)])}`;
        uploadBtn.disabled = false;
    } else {
        selectedFileName.textContent = '';
        uploadBtn.disabled = true;
    }
}

// 上传Excel文件
async function uploadExcelFile() {
    const fileInput = document.getElementById('excelFileInput');
    const file = fileInput.files[0];
    
    if (!file) {
        alert('请选择文件');
        return;
    }
    
    const uploadBtn = document.getElementById('uploadBtn');
    const uploadProgress = document.getElementById('uploadProgress');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const importResult = document.getElementById('importResult');
    
    // 禁用上传按钮
    uploadBtn.disabled = true;
    uploadBtn.textContent = '导入中...';
    
    // 显示进度条
    uploadProgress.style.display = 'block';
    importResult.style.display = 'none';
    progressBar.style.width = '0%';
    progressText.textContent = '正在上传...';
    
    try {
        // 创建FormData
        const formData = new FormData();
        formData.append('excel', file);
        
        // 模拟进度
        let progress = 0;
        const progressInterval = setInterval(() => {
            progress += 10;
            if (progress <= 90) {
                progressBar.style.width = progress + '%';
            }
        }, 200);
        
        // 发送请求
        const response = await fetch(`${API_BASE}/guests/import`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${currentToken}`
            },
            body: formData
        });
        
        clearInterval(progressInterval);
        progressBar.style.width = '100%';
        
        const result = await response.json();
        
        // 隐藏进度条
        uploadProgress.style.display = 'none';
        
        if (result.code === 200) {
            // 导入成功
            showImportResult(result.data);
            
            // 刷新嘉宾列表
            setTimeout(() => {
                loadGuests();
            }, 2000);
        } else {
            throw new Error(result.message || '导入失败');
        }
        
    } catch (error) {
        console.error('导入失败:', error);
        uploadProgress.style.display = 'none';
        alert('导入失败: ' + error.message);
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = '开始导入';
    }
}

// 显示导入结果
function showImportResult(data) {
    const importResult = document.getElementById('importResult');
    const resultTitle = document.getElementById('resultTitle');
    const resultContent = document.getElementById('resultContent');
    
    const { success, failed, errors } = data;
    
    resultTitle.innerHTML = `
        <span style="color: ${failed === 0 ? '#10b981' : '#f59e0b'}">
            导入完成
        </span>
    `;
    
    let html = `
        <div class="result-summary">
            <div class="result-item success">
                <span class="label">成功:</span>
                <span class="value">${window.t('admin.countItems', [success])}</span>
            </div>
            <div class="result-item failed">
                <span class="label">失败:</span>
                <span class="value">${window.t('admin.countItems', [failed])}</span>
            </div>
        </div>
    `;
    
    if (errors && errors.length > 0) {
        html += `
            <div class="error-list">
                <h4>失败详情:</h4>
                <ul>
                    ${errors.map(err => `<li>${window.t('admin.rowError', [err.row, err.error])}</li>`).join('')}
                </ul>
            </div>
        `;
    }
    
    resultContent.innerHTML = html;
    importResult.style.display = 'block';
}

// ==================== 邀约管理模态框 ====================

let currentInvitationId = null;
let allEvents = [];
let allGuests = [];
let batchInvitationExistingGuestIds = new Set();
let batchInvitationSelectedBd = '';

function resetBatchInvitationSelection() {
    document.getElementById('selectedGuestCount').textContent = '0';
    document.getElementById('batchInvitationSourceBd').value = '';
}

function getGuestBdUsername(guest) {
    return guest?.bd?.username || guest?.bd_id || '';
}

function getGuestBdDisplay(guest) {
    const username = guest?.bd?.username || guest?.bd_id || '';
    const name = guest?.bd?.name || '';
    if (name && username) return `${name}（${username}）`;
    return name || username || '';
}

function applyBatchGuestFilters() {
    let guests = allGuests;

    // 过滤已邀约嘉宾
    if (batchInvitationExistingGuestIds && batchInvitationExistingGuestIds.size > 0) {
        guests = guests.filter(g => !batchInvitationExistingGuestIds.has(parseInt(g.id)));
    }

    // 按BD筛选
    if (batchInvitationSelectedBd) {
        guests = guests.filter(g => getGuestBdUsername(g) === batchInvitationSelectedBd);
    }

    renderBatchGuestList(guests);
}

function populateBatchBdFilterOptions() {
    const select = document.getElementById('batchInvitationBdFilter');
    if (!select) return;

    const bdMap = new Map();
    allGuests.forEach(g => {
        const username = getGuestBdUsername(g);
        if (!username) return;
        const display = getGuestBdDisplay(g) || username;
        if (!bdMap.has(username)) bdMap.set(username, display);
    });

    const sorted = Array.from(bdMap.entries()).sort((a, b) => a[1].localeCompare(b[1], 'zh-Hans-CN'));

    select.innerHTML = '<option value="">全部BD</option>';
    sorted.forEach(([username, display]) => {
        const option = document.createElement('option');
        option.value = username;
        option.textContent = display;
        select.appendChild(option);
    });
}

// 显示创建邀约模态框（单个）
async function showInvitationModal() {
    const modal = document.getElementById('invitationModal');
    const form = document.getElementById('invitationForm');
    
    // 重置表单
    form.reset();
    document.getElementById('invitationSourceBd').value = '';
    
    // 加载活动和嘉宾列表
    await loadEventsForSelect();
    await loadGuestsForSelect();
    
    modal.classList.remove('hidden');
}

function closeInvitationModal() {
    document.getElementById('invitationModal').classList.add('hidden');
}

// 显示批量创建邀约模态框
async function showBatchInvitationModal() {
    const modal = document.getElementById('batchInvitationModal');
    const form = document.getElementById('batchInvitationForm');
    
    // 重置表单
    form.reset();
    document.getElementById('batchGuestList').innerHTML = '';
    resetBatchInvitationSelection();
    batchInvitationExistingGuestIds = new Set();
    batchInvitationSelectedBd = '';
    
    // 加载活动和嘉宾列表
    await loadEventsForSelect('batchInvitationEventId');
    await loadGuestsForBatchSelect();

    // 初始化BD筛选下拉
    populateBatchBdFilterOptions();
    const bdFilterSelect = document.getElementById('batchInvitationBdFilter');
    if (bdFilterSelect) {
        bdFilterSelect.onchange = function () {
            batchInvitationSelectedBd = this.value || '';
            resetBatchInvitationSelection();
            applyBatchGuestFilters();
        };
    }

    // 监听活动选择变化，过滤已邀约嘉宾
    const eventSelect = document.getElementById('batchInvitationEventId');
    eventSelect.onchange = async function () {
        const eventId = parseInt(this.value);

        // 清空选择
        resetBatchInvitationSelection();
        batchInvitationExistingGuestIds = new Set();

        if (!eventId) {
            applyBatchGuestFilters();
            return;
        }

        try {
            const resp = await apiRequest(`/invitations/existing-guest-ids?event_id=${eventId}`);
            const ids = resp.data?.guest_ids || [];
            batchInvitationExistingGuestIds = new Set(ids.map(id => parseInt(id)));
        } catch (error) {
            console.error('获取已邀约嘉宾失败:', error);
            batchInvitationExistingGuestIds = new Set();
        }

        applyBatchGuestFilters();
    };
    
    modal.classList.remove('hidden');
}

function closeBatchInvitationModal() {
    document.getElementById('batchInvitationModal').classList.add('hidden');
}

// 加载活动列表到下拉框
async function loadEventsForSelect(selectId = 'invitationEventId') {
    try {
        const data = await apiRequest('/events?pageSize=1000');
        const select = document.getElementById(selectId);
        select.innerHTML = '<option value="">请选择活动</option>';
        
        if (data.data?.list) {
            allEvents = data.data.list;
            data.data.list.forEach(event => {
                const option = document.createElement('option');
                option.value = event.id;
                option.textContent = event.name;
                select.appendChild(option);
            });
        }
    } catch (error) {
        console.error('加载活动列表失败:', error);
    }
}

// 加载嘉宾列表到下拉框
async function loadGuestsForSelect() {
    try {
        const data = await apiRequest('/guests?pageSize=1000');
        const select = document.getElementById('invitationGuestId');
        select.innerHTML = '<option value="">请选择嘉宾</option>';
        
        if (data.data?.list) {
            allGuests = data.data.list;
            data.data.list.forEach(guest => {
                const option = document.createElement('option');
                option.value = guest.id;
                option.textContent = `${guest.name}${guest.company ? ' - ' + guest.company : ''}`;
                // 存储BD信息到data属性
                if (guest.bd) {
                    option.dataset.bdUsername = guest.bd.username || '';
                    option.dataset.bdName = guest.bd.name || '';
                } else if (guest.bd_id) {
                    option.dataset.bdUsername = guest.bd_id;
                }
                select.appendChild(option);
            });
            
            // 添加选择变化监听，自动填充BD字段
            select.addEventListener('change', function() {
                const selectedOption = this.options[this.selectedIndex];
                const bdInput = document.getElementById('invitationSourceBd');
                if (selectedOption && selectedOption.dataset.bdUsername) {
                    // 优先使用BD的username，如果没有则使用bd_id
                    bdInput.value = selectedOption.dataset.bdUsername;
                } else {
                    bdInput.value = '';
                }
            });
        }
    } catch (error) {
        console.error('加载嘉宾列表失败:', error);
    }
}

// 加载嘉宾列表到批量选择
async function loadGuestsForBatchSelect() {
    try {
        const data = await apiRequest('/guests?pageSize=1000');
        
        if (data.data?.list) {
            allGuests = data.data.list;
            populateBatchBdFilterOptions();
            applyBatchGuestFilters();
        }
    } catch (error) {
        console.error('加载嘉宾列表失败:', error);
    }
}

function renderBatchGuestList(guests) {
    const container = document.getElementById('batchGuestList');
    container.innerHTML = '';

    guests.forEach(guest => {
        const item = document.createElement('div');
        item.style.cssText = 'display: flex; align-items: center; gap: 12px; padding: 8px; background: white; border-radius: 6px; border: 1px solid #E5E7EB;';
        const bdUsername = getGuestBdUsername(guest);
        const bdDisplay = getGuestBdDisplay(guest);
        item.innerHTML = `
            <input type="checkbox" id="guest_${guest.id}" value="${guest.id}" data-bd-username="${bdUsername}" onchange="updateSelectedGuestCount(); updateBatchBdField()" style="width: 18px; height: 18px; cursor: pointer;">
            <label for="guest_${guest.id}" style="flex: 1; cursor: pointer; margin: 0;">
                <div style="font-weight: 500;">${guest.name}</div>
                <div style="font-size: 12px; color: #6B7280;">${guest.company || '未填写公司'}${bdDisplay ? ` · BD：${bdDisplay}` : ''}</div>
            </label>
        `;
        container.appendChild(item);
    });
}

// 更新已选择嘉宾数量
function updateSelectedGuestCount() {
    const checkboxes = document.querySelectorAll('#batchGuestList input[type="checkbox"]:checked');
    document.getElementById('selectedGuestCount').textContent = checkboxes.length;
}

// 更新批量创建邀约的BD字段
function updateBatchBdField() {
    const checkboxes = document.querySelectorAll('#batchGuestList input[type="checkbox"]:checked');
    const bdInput = document.getElementById('batchInvitationSourceBd');
    
    if (checkboxes.length === 0) {
        bdInput.value = '';
        return;
    }
    
    // 收集所有选中嘉宾的BD信息
    const bdUsernames = Array.from(checkboxes)
        .map(cb => cb.dataset.bdUsername)
        .filter(bd => bd && bd.trim() !== '');
    
    if (bdUsernames.length === 0) {
        // 如果都没有BD，保持为空
        bdInput.value = '';
        return;
    }
    
    // 如果所有选中的嘉宾都有相同的BD，自动填充
    const uniqueBds = [...new Set(bdUsernames)];
    if (uniqueBds.length === 1) {
        bdInput.value = uniqueBds[0];
    } else {
        // 如果有不同的BD，使用第一个（用户可以根据需要修改）
        bdInput.value = uniqueBds[0];
        // 可选：提示用户有多个不同的BD
        // console.log('注意：选择的嘉宾有不同的BD，已自动填充第一个BD');
    }
}

// 提交创建邀约
async function handleInvitationSubmit(e) {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    const needPaySel = document.getElementById('invitationNeedPay');
    const data = {
        event_id: parseInt(formData.get('event_id')),
        guest_id: parseInt(formData.get('guest_id')),
        source_bd: formData.get('source_bd') || null,
        created_by: currentUser?.username || 'admin',
        // 新建邀约默认「免票」（邀约嘉宾不掏钱）；管理员可选需付款
        need_pay: needPaySel ? (parseInt(needPaySel.value, 10) === 1 ? 1 : 0) : 0
    };
    
    try {
        const response = await fetch(`${API_BASE}/invitations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify(data)
        });
        
        const result = await response.json();
        
        if (result.code === 201) {
            alert('创建成功！二维码正在生成中，请稍后刷新查看。');
            closeInvitationModal();
            loadInvitations();
        } else {
            alert(result.message || '创建失败');
        }
    } catch (error) {
        console.error('创建失败:', error);
        alert('创建失败，请稍后重试');
    }
}

// 提交批量创建邀约
async function handleBatchInvitationSubmit(e) {
    e.preventDefault();
    
    const eventId = parseInt(document.getElementById('batchInvitationEventId').value);
    const checkboxes = document.querySelectorAll('#batchGuestList input[type="checkbox"]:checked');
    const guestIds = Array.from(checkboxes).map(cb => parseInt(cb.value));
    const sourceBd = document.getElementById('batchInvitationSourceBd').value || null;
    
    if (guestIds.length === 0) {
        alert('请至少选择一位嘉宾');
        return;
    }
    
    const batchNeedPaySel = document.getElementById('batchInvitationNeedPay');
    const data = {
        event_id: eventId,
        guest_ids: guestIds,
        source_bd: sourceBd,
        created_by: currentUser?.username || 'admin',
        need_pay: batchNeedPaySel ? (parseInt(batchNeedPaySel.value, 10) === 1 ? 1 : 0) : 0
    };
    
    try {
        const response = await fetch(`${API_BASE}/invitations/batch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify(data)
        });
        
        const result = await response.json();
        
        if (result.code === 201) {
            const bn = result.data && result.data.batch_no;
            alert(`批量创建成功！已创建 ${result.data.created} 个邀约，共 ${result.data.total} 个。${result.data.message}`
                + (bn ? `\n\n批次号：${bn}\n可在「按批次审核」里整批通过/驳回。` : ''));
            closeBatchInvitationModal();
            loadInvitations();
        } else {
            alert(result.message || '批量创建失败');
        }
    } catch (error) {
        console.error('批量创建失败:', error);
        alert('批量创建失败，请稍后重试');
    }
}

// 查看邀约详情
async function viewInvitation(id) {
    currentInvitationId = id;
    const modal = document.getElementById('invitationDetailModal');
    const content = document.getElementById('invitationDetailContent');
    const invalidateBtn = document.getElementById('invalidateInvitationBtn');
    
    content.innerHTML = '<div class="loading">加载中...</div>';
    modal.classList.remove('hidden');
    
    try {
        const data = await apiRequest(`/invitations/${id}`);
        const invitation = data.data;
        
        // 调试：输出BD信息（开发时使用，生产环境可注释）
        // console.log('邀约详情BD信息:', { 
        //     source_bd: invitation.source_bd, 
        //     bd: invitation.bd,
        //     bdType: typeof invitation.bd,
        //     bdIsNull: invitation.bd === null,
        //     bdIsUndefined: invitation.bd === undefined
        // });
        
        let qrCodeHtml = '';
        if (invitation.qr_code_url) {
            const qrUrl = invitation.qr_code_url.startsWith('/') 
                ? window.location.origin + invitation.qr_code_url 
                : invitation.qr_code_url;
            qrCodeHtml = `
                <div style="text-align: center; margin-top: 20px;">
                    <div style="font-size: 14px; color: #6B7280; margin-bottom: 12px;">邀约二维码</div>
                    <img src="${qrUrl}" alt="二维码" style="max-width: 200px; border: 1px solid #E5E7EB; border-radius: 8px; padding: 8px; background: white;">
                    <div style="margin-top: 12px;">
                        <a href="${qrUrl}" download="invite_${invitation.invite_code}.png" class="btn btn-sm btn-outline">下载二维码</a>
                    </div>
                </div>
            `;
        }
        
        const registrationStatus = invitation.registration_status !== undefined ? invitation.registration_status : 0;
        const isAdmin = currentUser && currentUser.role === 'admin';
        const modificationHistory = invitation.guest?.modification_history;
        const isGuestModified = hasRealModification(modificationHistory);
        const guestNameStyle = isGuestModified ? 'color: #EF4444; font-weight: 600;' : '';
        const guestPosition = (invitation.guest && invitation.guest.position !== undefined && invitation.guest.position !== null)
            ? String(invitation.guest.position).trim()
            : '';
        const guestPositionHtml = (guestPosition && guestPosition !== 'null' && guestPosition !== 'undefined')
            ? `<div style="font-size: 14px; color: #6B7280; margin-top: 4px;">${window.t('admin.positionValue', [guestPosition])}</div>`
            : '';
        const modificationHistoryHtml = isGuestModified ? `
            <div style="margin-top: 8px; font-size: 12px; color: #6B7280;">
                <div style="font-weight: 600; margin-bottom: 6px;">信息变更记录：</div>
                ${renderModificationHistory(modificationHistory)}
            </div>
        ` : '';
        
        // 审批信息区域（仅当状态为待审批或已拒绝时显示）
        let approvalHtml = '';
        if (registrationStatus === 1 || registrationStatus === 3) {
            approvalHtml = `
                <div style="border: 1px solid #E5E7EB; border-radius: 8px; padding: 16px; background: #F9FAFB;">
                    <div style="font-size: 14px; font-weight: 500; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
                        <span>审批信息</span>
                        <span class="status-badge ${getInvitationStatusClass(registrationStatus, invitation.is_valid)}">${getInvitationStatusText(registrationStatus, invitation.is_valid)}</span>
                    </div>
                    ${invitation.approval_by ? `
                        <div style="font-size: 12px; color: #6B7280; margin-bottom: 4px;">${window.t('admin.approverValue', [invitation.approval_by])}</div>
                    ` : ''}
                    ${invitation.approval_time ? `
                        <div style="font-size: 12px; color: #6B7280; margin-bottom: 4px;">${window.t('admin.approvedAtValue', [formatDateTime(invitation.approval_time)])}</div>
                    ` : ''}
                    ${invitation.approval_remark ? `
                        <div style="font-size: 12px; color: #6B7280; margin-top: 8px; padding-top: 8px; border-top: 1px solid #E5E7EB;">${window.t('admin.remarkValue', [invitation.approval_remark])}</div>
                    ` : ''}
                    ${isAdmin && registrationStatus === 1 ? `
                        <div style="margin-top: 12px; display: flex; gap: 8px;">
                            <button class="btn btn-sm btn-primary" onclick="approveInvitation(${invitation.id})">批准</button>
                            <button class="btn btn-sm" style="background: #EF4444; color: white; border: none;" onclick="rejectInvitation(${invitation.id})">拒绝</button>
                        </div>
                    ` : ''}
                </div>
            `;
        }
        
        // 住宿分配区域
        let accommodationHtml = '';
        if (invitation.accommodation && typeof invitation.accommodation === 'object') {
            const accommodation = invitation.accommodation;
            const accommodationKeys = Object.keys(accommodation);
            if (accommodationKeys.length > 0) {
                accommodationHtml = `
                    <div style="border: 1px solid #E5E7EB; border-radius: 8px; padding: 16px; background: #F9FAFB;">
                        <div style="font-size: 14px; font-weight: 500; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
                            <span>住宿分配</span>
                            <button class="btn btn-sm btn-outline" onclick="showAccommodationModal(${invitation.id})">编辑</button>
                        </div>
                        ${accommodationKeys.map(key => {
                            const item = accommodation[key];
                            // 兼容新旧格式：新格式是 { room: "1205", hotel: "XX" }，旧格式是 { room_number: "1205", hotel_name: "XX", room_type: "标准间" }
                            const roomNumber = item.room || item.room_number || '-';
                            const hotelName = item.hotel || item.hotel_name || key;
                            const roomType = item.room_type || '-';
                            const checkinDate = item.checkin_date;
                            const checkoutDate = item.checkout_date;
                            
                            return `
                                <div style="margin-bottom: 12px; padding: 12px; background: white; border-radius: 6px; border: 1px solid #E5E7EB;">
                                    <div style="font-size: 13px; font-weight: 500; margin-bottom: 6px;">${hotelName}</div>
                                    <div style="font-size: 12px; color: #6B7280;">${window.t('admin.roomNumberValue', [roomNumber])}</div>
                                    ${roomType !== '-' ? `<div style="font-size: 12px; color: #6B7280;">${window.t('admin.roomTypeValue', [roomType])}</div>` : ''}
                                    ${checkinDate ? `<div style="font-size: 12px; color: #6B7280;">${window.t('admin.checkInDateRange', [checkinDate, checkoutDate ? ' - ' + checkoutDate : ''])}</div>` : ''}
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
            } else {
                accommodationHtml = `
                    <div style="border: 1px solid #E5E7EB; border-radius: 8px; padding: 16px; background: #F9FAFB;">
                        <div style="font-size: 14px; font-weight: 500; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
                            <span>住宿分配</span>
                            <button class="btn btn-sm btn-outline" onclick="showAccommodationModal(${invitation.id})">分配</button>
                        </div>
                        <div style="font-size: 12px; color: #9CA3AF;">暂未分配住宿</div>
                    </div>
                `;
            }
        } else {
            accommodationHtml = `
                <div style="border: 1px solid #E5E7EB; border-radius: 8px; padding: 16px; background: #F9FAFB;">
                    <div style="font-size: 14px; font-weight: 500; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
                        <span>住宿分配</span>
                        <button class="btn btn-sm btn-outline" onclick="showAccommodationModal(${invitation.id})">分配</button>
                    </div>
                    <div style="font-size: 12px; color: #9CA3AF;">暂未分配住宿</div>
                </div>
            `;
        }
        
        // 座位分配区域
        let seatsHtml = '';
        if (invitation.seats && typeof invitation.seats === 'object') {
            const seats = invitation.seats;
            const seatKeys = Object.keys(seats);
            if (seatKeys.length > 0) {
                seatsHtml = `
                    <div style="border: 1px solid #E5E7EB; border-radius: 8px; padding: 16px; background: #F9FAFB;">
                        <div style="font-size: 14px; font-weight: 500; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
                            <span>座位分配</span>
                            <button class="btn btn-sm btn-outline" onclick="showSeatsModal(${invitation.id})">编辑</button>
                        </div>
                        ${seatKeys.map(key => {
                            const seat = seats[key];
                            // 兼容新旧格式：新格式是 { seat: "07桌02" }，旧格式是 { venue_name: "XX", venue_area: "A区", seat_number: "A-01-02" }
                            const seatNumber = seat.seat || seat.seat_number || '-';
                            const venueName = seat.venue_name || key;
                            const venueArea = seat.venue_area;
                            
                            return `
                                <div style="margin-bottom: 12px; padding: 12px; background: white; border-radius: 6px; border: 1px solid #E5E7EB;">
                                    <div style="font-size: 13px; font-weight: 500; margin-bottom: 6px;">${venueName}</div>
                                    ${venueArea ? `<div style="font-size: 12px; color: #6B7280;">${window.t('admin.venueAreaValue', [venueArea])}</div>` : ''}
                                    <div style="font-size: 12px; color: #6B7280;">${window.t('admin.seatNumberValue', [seatNumber])}</div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
            } else {
                seatsHtml = `
                    <div style="border: 1px solid #E5E7EB; border-radius: 8px; padding: 16px; background: #F9FAFB;">
                        <div style="font-size: 14px; font-weight: 500; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
                            <span>座位分配</span>
                            <button class="btn btn-sm btn-outline" onclick="showSeatsModal(${invitation.id})">分配</button>
                        </div>
                        <div style="font-size: 12px; color: #9CA3AF;">暂未分配座位</div>
                    </div>
                `;
            }
        } else {
            seatsHtml = `
                <div style="border: 1px solid #E5E7EB; border-radius: 8px; padding: 16px; background: #F9FAFB;">
                    <div style="font-size: 14px; font-weight: 500; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
                        <span>座位分配</span>
                        <button class="btn btn-sm btn-outline" onclick="showSeatsModal(${invitation.id})">分配</button>
                    </div>
                    <div style="font-size: 12px; color: #9CA3AF;">暂未分配座位</div>
                </div>
            `;
        }
        
        content.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 20px;">
                <div>
                    <div style="font-size: 12px; color: #6B7280; margin-bottom: 8px;">嘉宾信息</div>
                    <div style="font-size: 16px; font-weight: 500; ${guestNameStyle}">${invitation.guest?.name || '-'}</div>
                    <div style="font-size: 14px; color: #6B7280; margin-top: 4px;">${invitation.guest?.company || '-'}</div>
                    ${guestPositionHtml}
                    ${invitation.guest?.phone_decrypted ? `
                        <div style="font-size: 14px; color: #6B7280; margin-top: 4px;">${window.t('admin.phoneValue', [invitation.guest.phone_decrypted])}</div>
                    ` : ''}
                    ${modificationHistoryHtml}
                </div>
                
                <div>
                    <div style="font-size: 12px; color: #6B7280; margin-bottom: 8px;">活动信息</div>
                    <div style="display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap;">
                        <div style="flex: 1; min-width: 220px;">
                            <div style="font-size: 16px; font-weight: 500;">${ec9I18n(invitation.event, 'name') || '-'}</div>
                            <div style="font-size: 14px; color: #6B7280; margin-top: 4px;">${formatDateTime(invitation.event?.start_time)}</div>
                        </div>
                        <div style="display: flex; gap: 8px; align-items: center; flex: 1; min-width: 260px;">
                            <select id="invitationEventEditSelect" class="dropdown-select" style="flex: 1; min-width: 200px;"></select>
                            <button class="btn btn-outline btn-sm" onclick="changeInvitationEvent(${invitation.id})">修改活动</button>
                        </div>
                    </div>
                    <div style="font-size: 12px; color: #EF4444; margin-top: 6px;">修改活动后，将清空已分配的住宿与座位信息，请重新分配。</div>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                    <div>
                        <div style="font-size: 12px; color: #6B7280; margin-bottom: 8px;">邀约码</div>
                        <div style="font-size: 14px; font-family: monospace; background: #F9FAFB; padding: 8px; border-radius: 6px;">${invitation.invite_code}</div>
                    </div>
                    <div>
                        <div style="font-size: 12px; color: #6B7280; margin-bottom: 8px;">报名状态</div>
                        <div><span class="status-badge ${getInvitationStatusClass(invitation.registration_status, invitation.is_valid)}">${getInvitationStatusText(invitation.registration_status, invitation.is_valid)}</span></div>
                    </div>
                    <div>
                        <div style="font-size: 12px; color: #6B7280; margin-bottom: 8px;">是否需要付款</div>
                        <div>${renderNeedPayCell(invitation)}</div>
                    </div>
                </div>
                
                ${approvalHtml}
                
                <div>
                    <div style="font-size: 12px; color: #6B7280; margin-bottom: 8px;">邀约链接</div>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <input type="text" value="${invitation.invite_url || ''}" readonly style="flex: 1; padding: 8px; border: 1px solid #D1D5DB; border-radius: 6px; font-size: 12px; background: #F9FAFB;">
                        <button class="btn btn-sm btn-outline" onclick="copyInviteUrl('${invitation.invite_url || ''}')">复制</button>
                    </div>
                </div>
                
                <div>
                    <div style="font-size: 12px; color: #6B7280; margin-bottom: 8px;">BD联系人</div>
                    <div style="font-size: 14px;">
                        ${(invitation.bd && invitation.bd !== null && typeof invitation.bd === 'object') ? `
                            <div style="margin-bottom: 6px;">
                                <span style="color: #6B7280;">姓名：</span>
                                <span style="font-weight: 500;">${invitation.bd.name || invitation.bd.username || invitation.source_bd || '-'}</span>
                            </div>
                            <div>
                                <span style="color: #6B7280;">联系方式：</span>
                                <span style="font-weight: 500;">${(invitation.bd.contact && String(invitation.bd.contact).trim() !== '' && String(invitation.bd.contact).trim() !== 'null') ? invitation.bd.contact : '<span style="color: #9CA3AF; font-size: 12px;">未设置</span>'}</span>
                            </div>
                        ` : invitation.source_bd ? `
                            <div style="margin-bottom: 6px;">
                                <span style="color: #6B7280;">BD：</span>
                                <span style="font-weight: 500;">${invitation.source_bd}</span>
                            </div>
                            <div style="color: #9CA3AF; font-size: 12px;">未关联BD信息（请检查BD用户是否存在）</div>
                        ` : `
                            <div style="color: #9CA3AF;">管理员</div>
                        `}
                    </div>
                </div>
                
                ${accommodationHtml}
                
                ${seatsHtml}
                
                <div>
                    <div style="font-size: 12px; color: #6B7280; margin-bottom: 8px;">创建时间</div>
                    <div style="font-size: 14px;">${formatDateTime(invitation.created_at)}</div>
                </div>
                
                ${invitation.registration_time ? `
                <div>
                    <div style="font-size: 12px; color: #6B7280; margin-bottom: 8px;">报名时间</div>
                    <div style="font-size: 14px;">${formatDateTime(invitation.registration_time)}</div>
                </div>
                ` : ''}
                
                ${qrCodeHtml}
            </div>
        `;

        // 填充活动下拉（用于修改绑定的活动）
        await populateInvitationEventSelect(invitation);
        
        // 显示/隐藏标记无效/有效按钮和发送短信按钮
        const validateBtn = document.getElementById('validateInvitationBtn');
        if (invitation.is_valid === 1) {
            // 有效时显示"标记为无效"按钮
            invalidateBtn.style.display = 'block';
            if (validateBtn) validateBtn.style.display = 'none';
        } else {
            // 无效时显示"标记为有效"按钮
            invalidateBtn.style.display = 'none';
            if (validateBtn) validateBtn.style.display = 'block';
        }
        
        // 显示发送短信按钮（如果有嘉宾和活动信息）
        const sendSmsBtn = document.getElementById('sendSmsToInvitationBtn');
        if (sendSmsBtn && invitation.guest_id && invitation.event_id) {
            sendSmsBtn.style.display = 'block';
        } else if (sendSmsBtn) {
            sendSmsBtn.style.display = 'none';
        }
    } catch (error) {
        console.error('加载邀约详情失败:', error);
        content.innerHTML = '<div style="color: #EF4444;">加载失败，请稍后重试</div>';
    }
}

// 填充邀约详情中的活动下拉
async function populateInvitationEventSelect(invitation) {
    try {
        if (!allEvents || allEvents.length === 0) {
            const data = await apiRequest('/events?pageSize=1000');
            allEvents = data.data?.list || [];
        }
        const select = document.getElementById('invitationEventEditSelect');
        if (!select) return;
        select.innerHTML = `<option value=\"\">${window.t('admin.selectEvent')}</option>`;
        allEvents.forEach(evt => {
            const opt = document.createElement('option');
            opt.value = evt.id;
            opt.textContent = evt.name;
            select.appendChild(opt);
        });
        select.value = invitation.event_id || '';
    } catch (error) {
        console.error('填充活动下拉失败:', error);
    }
}

// 修改邀约绑定的活动
async function changeInvitationEvent(invitationId) {
    const select = document.getElementById('invitationEventEditSelect');
    if (!select || !select.value) {
        alert('请选择新的活动');
        return;
    }
    const newEventId = parseInt(select.value, 10);
    if (!newEventId) {
        alert('请选择有效的活动');
        return;
    }
    const confirmed = confirm('修改活动后将清空已分配的住宿与座位信息，确定继续吗？');
    if (!confirmed) return;

    try {
        const res = await apiRequest(`/invitations/${invitationId}/change-event`, {
            method: 'PUT',
            body: JSON.stringify({ event_id: newEventId })
        });
        alert(res.message || '修改成功，住宿与座位信息已清空，请重新分配');
        viewInvitation(invitationId);
        loadInvitations(currentInvitationPage, currentInvitationPageSize);
    } catch (error) {
        console.error('修改活动失败:', error);
        alert(error.message || '修改失败，请稍后重试');
    }
}

function closeInvitationDetailModal() {
    document.getElementById('invitationDetailModal').classList.add('hidden');
    currentInvitationId = null;
}

// 复制邀约链接
function copyInviteUrl(url) {
    navigator.clipboard.writeText(url).then(() => {
        alert('链接已复制到剪贴板');
    }).catch(() => {
        // 降级方案
        const input = document.createElement('input');
        input.value = url;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        alert('链接已复制到剪贴板');
    });
}

// 删除邀约
async function deleteInvitation(id) {
    if (!confirm('确定要删除这个邀约吗？删除后相关数据将无法恢复。')) {
        return;
    }
    
    try {
        const result = await apiRequest(`/invitations/${id}`, {
            method: 'DELETE'
        });
        
        if (result.code === 200) {
            alert('删除成功');
            loadInvitations();
        } else {
            alert(result.message || '删除失败');
        }
    } catch (error) {
        console.error('删除失败:', error);
        alert('删除失败，请稍后重试');
    }
}

// 发送短信给邀约
async function sendSmsToInvitation(invitationId) {
    try {
        // 获取邀约信息
        const invitationData = await apiRequest(`/invitations/${invitationId}`);
        const invitation = invitationData.data;
        
        if (!invitation || !invitation.guest_id || !invitation.event_id) {
            alert('邀约信息不完整，无法发送短信');
            return;
        }
        
        // 获取短信模板列表
        const templatesData = await apiRequest('/sms/templates');
        const templates = templatesData.data || [];
        
        if (templates.length === 0) {
            alert('没有可用的短信模板，请先创建短信模板');
            return;
        }
        
        // 创建发送短信模态框
        showSendSmsModal({
            invitationId: invitation.id,
            guestId: invitation.guest_id,
            eventId: invitation.event_id,
            guestName: invitation.guest?.name || '未知',
            eventName: invitation.event?.name || '未知',
            invitation: invitation,
            templates: templates
        });
        
    } catch (error) {
        console.error('获取邀约信息失败:', error);
        alert('获取邀约信息失败，请稍后重试');
    }
}

// 显示发送短信模态框
function showSendSmsModal(options) {
    const { invitationId, guestId, eventId, guestName, eventName, invitation, templates } = options;
    
    // 创建模态框HTML
    const modalHtml = `
        <div id="sendSmsModal" class="modal">
            <div class="modal-content" style="max-width: 600px;">
                <div class="modal-header">
                    <h2>发送短信</h2>
                    <span class="close" onclick="closeSendSmsModal()">&times;</span>
                </div>
                <div class="modal-body">
                    <div style="margin-bottom: 20px;">
                        <div style="font-size: 12px; color: #6B7280; margin-bottom: 8px;">嘉宾</div>
                        <div style="font-size: 14px; font-weight: 500;">${guestName}</div>
                    </div>
                    <div style="margin-bottom: 20px;">
                        <div style="font-size: 12px; color: #6B7280; margin-bottom: 8px;">活动</div>
                        <div style="font-size: 14px; font-weight: 500;">${eventName}</div>
                    </div>
                    <div class="form-group">
                        <label>选择短信模板 <span class="required">*</span></label>
                        <select id="smsTemplateSelect" class="input" required>
                            <option value="">请选择短信模板</option>
                            ${templates.map(t => `
                                <option value="${t.message_type}" data-template-id="${t.id}">
                                    ${t.name} (${t.message_type})
                                </option>
                            `).join('')}
                        </select>
                    </div>
                    <div id="smsTemplateInfo" style="margin-top: 12px; padding: 12px; background: #F9FAFB; border-radius: 6px; display: none;">
                        <div style="font-size: 12px; color: #6B7280; margin-bottom: 8px; font-weight: 500;">模板信息</div>
                        <div id="smsTemplateDetails" style="font-size: 13px; color: #374151; margin-bottom: 12px;"></div>
                        <div style="border-top: 1px solid #E5E7EB; padding-top: 12px; margin-top: 12px;">
                            <div style="font-size: 12px; color: #6B7280; margin-bottom: 8px; font-weight: 500;">参数预览</div>
                            <div id="smsTemplateParams" style="font-size: 13px; color: #374151;"></div>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeSendSmsModal()">取消</button>
                    <button class="btn btn-primary" id="sendSmsConfirmBtn">发送</button>
                </div>
            </div>
        </div>
    `;
    
    // 添加模态框到页面
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // 存储选项数据供后续使用
    window.sendSmsModalOptions = options;
    
    // 显示模态框
    document.getElementById('sendSmsModal').style.display = 'flex';
    
    // 绑定发送按钮点击事件
    document.getElementById('sendSmsConfirmBtn').addEventListener('click', function() {
        confirmSendSms(invitationId, guestId, eventId);
    });
    
    // 监听模板选择变化
    document.getElementById('smsTemplateSelect').addEventListener('change', async function() {
        const selectedOption = this.options[this.selectedIndex];
        const templateId = selectedOption.dataset.templateId;
        const template = templates.find(t => t.id == templateId);
        
        const infoDiv = document.getElementById('smsTemplateInfo');
        const detailsDiv = document.getElementById('smsTemplateDetails');
        const paramsDiv = document.getElementById('smsTemplateParams');
        
        if (template) {
            // 显示模板基本信息
            let details = `<div style="margin-bottom: 6px;"><strong>类型：</strong>${template.message_type}</div>`;
            details += `<div style="margin-bottom: 6px;"><strong>场景：</strong>${template.scene}</div>`;
            details += `<div><strong>${window.t('admin.signatureLabel')}</strong>${template.sign_name}</div>`;
            if (template.remark) {
                details += `<div style="margin-top: 6px;"><strong>备注：</strong>${template.remark}</div>`;
            }
            detailsDiv.innerHTML = details;
            
            // 获取并显示参数预览
            try {
                const params = await buildSmsTemplateParams(template, options);
                if (params && Object.keys(params).length > 0) {
                    let paramsHtml = '';
                    const paramLabels = {
                        'name': '参会者',
                        'time': '活动时间',
                        'place': '活动地点',
                        'url': '邀约链接',
                        'company': '公司',
                        'event_name': '活动名称',
                        'event_location': '活动地点'
                    };
                    
                    for (const [key, value] of Object.entries(params)) {
                        const label = paramLabels[key] || key;
                        paramsHtml += `<div style="margin-bottom: 8px;">
                            <div style="font-size: 12px; color: #6B7280; margin-bottom: 2px;">${label} (${key})</div>
                            <div style="font-size: 13px; color: #111827; word-break: break-all; padding: 6px; background: #FFFFFF; border-radius: 4px; border: 1px solid #E5E7EB;">
                                ${value || '<span style="color: #9CA3AF;">（空）</span>'}
                            </div>
                        </div>`;
                    }
                    paramsDiv.innerHTML = paramsHtml;
                } else {
                    paramsDiv.innerHTML = '<div style="color: #9CA3AF; font-size: 12px;">暂无参数数据</div>';
                }
            } catch (error) {
                console.error('获取参数预览失败:', error);
                paramsDiv.innerHTML = '<div style="color: #EF4444; font-size: 12px;">获取参数失败</div>';
            }
            
            infoDiv.style.display = 'block';
        } else {
            infoDiv.style.display = 'none';
        }
    });
}

// 构建短信模板参数预览
async function buildSmsTemplateParams(template, options) {
    const { invitation, guestId, eventId } = options || window.sendSmsModalOptions || {};
    
    // 获取活动信息
    let event = null;
    if (eventId) {
        try {
            const eventData = await apiRequest(`/events/${eventId}`);
            event = eventData.data;
        } catch (error) {
            console.error('获取活动信息失败:', error);
        }
    }
    
    // 获取嘉宾信息
    let guest = null;
    if (guestId) {
        try {
            const guestData = await apiRequest(`/guests/${guestId}`);
            guest = guestData.data;
        } catch (error) {
            console.error('获取嘉宾信息失败:', error);
        }
    }
    
    // 构建参数
    const params = {};
    
    // 基础参数
    if (guest) {
        params.name = guest.name || '';
        params.company = guest.company || '';
    }
    
    if (event) {
        params.event_name = event.name || '';
        params.event_location = event.location || '';
        
        // 格式化活动时间
        if (event.start_time) {
            const date = new Date(event.start_time);
            params.time = date.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
        } else {
            params.time = '';
        }
        
        params.place = event.location || '';
    }
    
    // 邀约链接
    if (invitation && invitation.invite_url) {
        params.url = invitation.invite_url;
    } else if (invitation && invitation.invite_code) {
        const baseUrl = window.location.origin;
        if (event && event.page_url) {
            const separator = event.page_url.includes('?') ? '&' : '?';
            params.url = `${baseUrl}${event.page_url}${separator}code=${invitation.invite_code}`;
        } else {
            params.url = `${baseUrl}/invite/${invitation.invite_code}`;
        }
    } else {
        params.url = '';
    }
    
    // 根据模板的 params_schema 过滤参数
    if (template.params_schema && Array.isArray(template.params_schema)) {
        const filteredParams = {};
        template.params_schema.forEach(key => {
            if (params.hasOwnProperty(key)) {
                filteredParams[key] = params[key];
            }
        });
        return filteredParams;
    }
    
    return params;
}

// 关闭发送短信模态框
function closeSendSmsModal() {
    const modal = document.getElementById('sendSmsModal');
    if (modal) {
        modal.remove();
    }
    // 清理存储的选项数据
    if (window.sendSmsModalOptions) {
        delete window.sendSmsModalOptions;
    }
}

// 确认发送短信
async function confirmSendSms(invitationId, guestId, eventId) {
    const templateSelect = document.getElementById('smsTemplateSelect');
    const messageType = templateSelect.value;
    
    if (!messageType) {
        alert('请选择短信模板');
        return;
    }
    
    if (!confirm('确定要发送短信吗？')) {
        return;
    }
    
    const sendBtn = document.getElementById('sendSmsConfirmBtn');
    if (sendBtn) {
        sendBtn.disabled = true;
        sendBtn.textContent = '发送中...';
    }
    
    try {
        console.log('发送短信请求:', {
            message_type: messageType,
            guest_id: guestId,
            event_id: eventId,
            invitation_id: invitationId
        });
        
        const result = await apiRequest('/sms/send', {
            method: 'POST',
            body: JSON.stringify({
                message_type: messageType,
                guest_id: guestId,
                event_id: eventId,
                invitation_id: invitationId
            })
        });
        
        console.log('发送短信响应:', result);
        
        if (result.code === 200) {
            alert('短信发送成功！');
            closeSendSmsModal();
            // 刷新邀约列表
            if (typeof loadInvitations === 'function') {
                loadInvitations();
            }
        } else {
            // 显示详细的错误信息
            const errorMsg = result.message || result.error || '短信发送失败';
            alert(`${window.t('admin.smsSendFailedDetail', [errorMsg])}`);
        }
    } catch (error) {
        console.error('发送短信失败:', error);
        alert('发送短信失败：' + (error.message || '请稍后重试'));
    } finally {
        const sendBtn = document.getElementById('sendSmsConfirmBtn');
        if (sendBtn) {
            sendBtn.disabled = false;
            sendBtn.textContent = '发送';
        }
    }
}

// 标记邀约为无效
async function invalidateInvitation() {
    if (!currentInvitationId) return;
    
    if (!confirm('确定要标记此邀约为无效吗？标记后该邀约将无法使用。')) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/invitations/${currentInvitationId}/invalidate`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${currentToken}`
            }
        });
        
        const result = await response.json();
        
        if (result.code === 200) {
            alert('已标记为无效');
            closeInvitationDetailModal();
            loadInvitations();
        } else {
            alert(result.message || '操作失败');
        }
    } catch (error) {
        console.error('标记失败:', error);
        alert('操作失败，请稍后重试');
    }
}

// 标记邀约为有效
async function validateInvitation() {
    if (!currentInvitationId) return;
    
    if (!confirm('确定要标记此邀约为有效吗？标记后该邀约将可以正常使用。')) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/invitations/${currentInvitationId}/validate`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${currentToken}`
            }
        });
        
        const result = await response.json();
        
        if (result.code === 200) {
            alert('已标记为有效');
            closeInvitationDetailModal();
            loadInvitations();
        } else {
            alert(result.message || '操作失败');
        }
    } catch (error) {
        console.error('标记失败:', error);
        alert('操作失败，请稍后重试');
    }
}

// 管理员：手动设置报名成功
async function markInvitationRegistered(id) {
    if (!currentUser || currentUser.role !== 'admin') {
        alert('权限不足，仅管理员可以操作');
        return;
    }

    if (!confirm('确定要将该邀约手动设置为“报名成功”吗？')) {
        return;
    }

    const remark = prompt('请输入备注（可选）：');

    try {
        await apiRequest(`/invitations/${id}/mark-registered`, {
            method: 'POST',
            body: JSON.stringify({ remark: remark || '' })
        });
        alert('已设置为报名成功');
        loadInvitations(currentInvitationPage, currentInvitationPageSize);
        if (currentInvitationId === id) {
            viewInvitation(id);
        }
    } catch (error) {
        alert('操作失败: ' + (error.message || '未知错误'));
    }
}

// 邀约「是否需要付款」单元格（管理员可直接切换）
function renderNeedPayCell(inv) {
    const needPay = Number(inv.need_pay) !== 0;
    const isAdmin = currentUser && currentUser.role === 'admin';
    const badge = needPay
        ? '<span class="status-badge" style="background:#FEF3C7;color:#92400E;">需付款</span>'
        : '<span class="status-badge" style="background:#DCFCE7;color:#166534;">免票</span>';
    const toggle = isAdmin
        ? `<button class="btn btn-sm btn-outline" style="margin-left:6px;padding:2px 8px;" onclick="toggleInvitationNeedPay(${inv.id}, ${needPay ? 1 : 0})" title="${needPay ? '改为免票' : '改为需付款'}">${needPay ? '改免票' : '改需付款'}</button>`
        : '';
    return badge + toggle;
}

// 管理员改邀约是否需付款
async function toggleInvitationNeedPay(id, current) {
    const to = Number(current) !== 0 ? 0 : 1;
    if (!confirm(to === 0 ? '确定把该邀约改成「免票」吗？已建的待支付单会作废并直接出票。' : '确定把该邀约改成「需付款」吗？')) {
        return;
    }
    try {
        const res = await apiRequest(`/invitations/${id}/need-pay`, {
            method: 'PUT',
            body: JSON.stringify({ need_pay: to })
        });
        alert(res.message || '已更新');
        loadInvitations();
    } catch (error) {
        alert('操作失败: ' + (error.message || '未知错误'));
    }
}

// 批准邀约（可同时决定是否需要付款）
let pendingApproveInvitationId = null;

async function approveInvitation(id) {
    // 预填邀约当前的付款口径（邀约默认免票）
    let currentNeedPay = 0;
    try {
        const d = await apiRequest(`/invitations/${id}`);
        currentNeedPay = Number(d?.data?.need_pay) === 1 ? 1 : 0;
    } catch (e) { /* 读不到就用默认「免票」 */ }

    pendingApproveInvitationId = id;
    const modal = document.getElementById('invApproveModal');
    if (!modal) {   // 兜底：没有弹窗时退回原来的 prompt 流程
        if (!confirm('确定要批准该邀约吗？')) return;
        const remark = prompt('请输入审批备注（可选）：');
        try {
            await apiRequest(`/invitations/${id}/approve`, {
                method: 'POST', body: JSON.stringify({ remark: remark || '' })
            });
            alert('邀约已批准'); loadInvitations();
        } catch (error) { alert('操作失败: ' + (error.message || '未知错误')); }
        return;
    }
    document.getElementById('invApproveNeedPay').value = String(currentNeedPay);
    document.getElementById('invApproveRemark').value = '';
    const okBtn = document.getElementById('invApproveOk');
    okBtn.onclick = submitApproveInvitation;
    modal.classList.remove('hidden');
}

function closeInvApproveModal() {
    const modal = document.getElementById('invApproveModal');
    if (modal) modal.classList.add('hidden');
    pendingApproveInvitationId = null;
}

async function submitApproveInvitation() {
    const id = pendingApproveInvitationId;
    if (!id) return;
    const needPay = parseInt(document.getElementById('invApproveNeedPay').value, 10) || 0;
    const remark = (document.getElementById('invApproveRemark').value || '').trim();
    const btn = document.getElementById('invApproveOk');
    btn.disabled = true;
    try {
        const res = await apiRequest(`/invitations/${id}/approve`, {
            method: 'POST',
            body: JSON.stringify({ remark: remark, need_pay: needPay })
        });
        closeInvApproveModal();
        let msg = res.message || '邀约已批准';
        const ord = res.order;
        if (ord && ord.free) msg += '\n（免票，已自动出票）';
        else if (ord && ord.order) msg += `\n已生成待支付订单 ${ord.order.order_no}，金额 ¥${Number(ord.order.final_amount).toFixed(2)}，付款链接已短信通知购票人`;
        alert(msg);
        loadInvitations();
        if (currentInvitationId === id) viewInvitation(id);
    } catch (error) {
        alert('操作失败: ' + (error.message || '未知错误'));
    } finally {
        btn.disabled = false;
    }
}

// 拒绝邀约
async function rejectInvitation(id) {
    const remark = prompt('请输入拒绝原因（必填）：');
    if (!remark || !remark.trim()) {
        alert('拒绝原因不能为空');
        return;
    }
    
    if (!confirm('确定要拒绝该邀约吗？拒绝后不能重新申请。')) {
        return;
    }
    
    try {
        await apiRequest(`/invitations/${id}/reject`, {
            method: 'POST',
            body: JSON.stringify({ remark: remark.trim() })
        });
        alert('邀约已拒绝');
        loadInvitations();
        if (currentInvitationId === id) {
            viewInvitation(id); // 刷新详情
        }
    } catch (error) {
        alert('操作失败: ' + (error.message || '未知错误'));
    }
}

// 显示住宿分配模态框
function showAccommodationModal(invitationId) {
    // 创建一个简单的浮层表单，支持多条房间输入（每行一个，格式：房间号 或 自定义key:房间号）
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;z-index:9999;';
    
    const modal = document.createElement('div');
    modal.style.cssText = 'background:white;padding:20px;width:360px;max-width:90%;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,0.2);font-size:14px;';
    modal.innerHTML = `
        <div style="font-size:16px;font-weight:600;margin-bottom:10px;">分配住宿</div>
        <div style="color:#4B5563;font-size:13px;margin-bottom:6px;">每行一个房间号；可选格式：<code>key:房间号</code> 用来自定义标签</div>
        <textarea id="acc-rooms" style="width:100%;height:120px;padding:8px;border:1px solid #E5E7EB;border-radius:6px;" placeholder="示例：\n1205\nroom2:1206"></textarea>
        <div style="margin:10px 0 6px;color:#4B5563;font-size:13px;">酒店名称（可选，整批适用）</div>
        <input id="acc-hotel" style="width:100%;padding:8px;border:1px solid #E5E7EB;border-radius:6px;" placeholder="如：深圳XX酒店" />
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
            <button id="acc-cancel" class="btn btn-sm btn-outline">取消</button>
            <button id="acc-save" class="btn btn-sm btn-primary">保存</button>
        </div>
    `;
    
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    const close = () => overlay.remove();
    modal.querySelector('#acc-cancel').onclick = close;
    modal.querySelector('#acc-save').onclick = async () => {
        const lines = modal.querySelector('#acc-rooms').value.split('\n').map(l => l.trim()).filter(Boolean);
        const hotel = modal.querySelector('#acc-hotel').value.trim();
        if (!lines.length) {
            alert('请至少填写一个房间号');
            return;
        }
        // 组装对象
        const accommodation = {};
        lines.forEach((line, idx) => {
            const hasKey = line.includes(':');
            const [keyPart, valPart] = hasKey ? line.split(':') : [null, line];
            const key = hasKey ? keyPart.trim() : `room${idx + 1}`;
            const room = hasKey ? valPart.trim() : valPart.trim();
            accommodation[key] = hotel ? { room, hotel } : { room };
        });
        try {
            await apiRequest(`/invitations/${invitationId}/accommodation`, {
                method: 'PUT',
                body: JSON.stringify({ accommodation })
            });
            alert('住宿分配成功');
            if (currentInvitationId === invitationId) viewInvitation(invitationId);
            close();
        } catch (error) {
            alert('操作失败: ' + (error.message || '未知错误'));
        }
    };
}

// 分配座位采用同样的浮层方式，支持多条座位

// 显示座位分配模态框（支持多条座位号）
function showSeatsModal(invitationId) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;z-index:9999;';
    
    const modal = document.createElement('div');
    modal.style.cssText = 'background:white;padding:20px;width:360px;max-width:90%;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,0.2);font-size:14px;';
    modal.innerHTML = `
        <div style="font-size:16px;font-weight:600;margin-bottom:10px;">分配座位</div>
        <div style="color:#4B5563;font-size:13px;margin-bottom:6px;">每行一个座位号；可选格式：<code>key:座位号</code> 用来自定义标签</div>
        <textarea id="seat-lines" style="width:100%;height:120px;padding:8px;border:1px solid #E5E7EB;border-radius:6px;" placeholder="示例：\n07桌02\nvip:08桌01"></textarea>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
            <button id="seat-cancel" class="btn btn-sm btn-outline">取消</button>
            <button id="seat-save" class="btn btn-sm btn-primary">保存</button>
        </div>
    `;
    
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    const close = () => overlay.remove();
    modal.querySelector('#seat-cancel').onclick = close;
    modal.querySelector('#seat-save').onclick = async () => {
        const lines = modal.querySelector('#seat-lines').value.split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) {
            alert('请至少填写一个座位号');
            return;
        }
        // 组装座位对象
        const seats = {};
        lines.forEach((line, idx) => {
            const hasKey = line.includes(':');
            const [keyPart, valPart] = hasKey ? line.split(':') : [null, line];
            const key = hasKey ? keyPart.trim() : `seat${idx + 1}`;
            const seatValue = hasKey ? valPart.trim() : valPart.trim();
            // 使用 seat 字段存储座位号
            seats[key] = { seat: seatValue };
        });
        try {
            await apiRequest(`/invitations/${invitationId}/seats`, {
                method: 'PUT',
                body: JSON.stringify({ seats })
            });
            alert('座位分配成功');
            if (currentInvitationId === invitationId) viewInvitation(invitationId);
            close();
        } catch (error) {
            alert('操作失败: ' + (error.message || '未知错误'));
        }
    };
}

// 下载二维码
function downloadQRCode(url, code) {
    const qrUrl = url.startsWith('/') ? window.location.origin + url : url;
    const link = document.createElement('a');
    link.href = qrUrl;
    link.download = `invite_${code}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// ==================== 删除功能 ====================

async function deleteEvent(id) {
    if (!confirm('确定要删除这个活动吗？删除后相关数据将无法恢复。')) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/events/${id}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${currentToken}`
            }
        });
        
        const result = await response.json();
        
        if (result.code === 200) {
            alert('删除成功');
            loadEvents();
        } else {
            alert(result.message || '删除失败');
        }
    } catch (error) {
        console.error('删除失败:', error);
        alert('删除失败，请稍后重试');
    }
}

async function deleteGuest(id) {
    if (!confirm('确定要删除这个嘉宾吗？删除后相关数据将无法恢复。')) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/guests/${id}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${currentToken}`
            }
        });
        
        const data = await response.json();
        
        if (data.code === 200) {
            alert('删除成功');
            loadGuests();
        } else if (data.code === 400 && data.data && data.data.invitationCount > 0) {
            // 如果有邀约，显示详细提示
            const invitationList = data.data.invitations.map(inv => 
                `${window.t('admin.inviteCodeWithEvent', [inv.invite_code, inv.event_id])}`
            ).join('\n');
            alert(`无法删除：该嘉宾还有 ${data.data.invitationCount} 个有效邀约，请先删除邀约后再删除嘉宾。\n\n邀约列表：\n${invitationList}`);
        } else {
            alert(data.message || '删除失败');
        }
    } catch (error) {
        console.error('删除失败:', error);
        alert('删除失败，请稍后重试');
    }
}

function viewEvent(id) {
    showEventModal(id);
}

function viewGuest(id) {
    showGuestModal(id);
}

// viewInvitation 函数已在上面定义（第2206行），不需要重复定义

// viewCheckin 函数已在上面定义（第3189行），不需要重复定义

// ==================== 短信中心 ====================

async function loadSmsCenter() {
    try {
        console.log('开始加载短信中心数据...');
        const [templatesRes, rulesRes, logsRes, eventsRes, guestsRes] = await Promise.all([
            apiRequest('/sms/templates'),
            apiRequest('/sms/rules'),
            apiRequest('/sms/logs?page=1&pageSize=50'),
            apiRequest('/events?pageSize=1000'),
            apiRequest('/guests?pageSize=1000')
        ]);

        const templates = templatesRes.data || [];
        const rules = rulesRes.data || [];
        const logs = logsRes.data?.list || [];

        console.log('短信中心数据加载完成:', {
            templates: templates.length,
            rules: rules.length,
            logs: logs.length
        });

        // 更新统计
        const templateCountEl = document.getElementById('smsTemplateCount');
        const ruleCountEl = document.getElementById('smsRuleCount');
        const logCountEl = document.getElementById('smsLogCount');
        
        if (templateCountEl) templateCountEl.textContent = templates.length;
        if (ruleCountEl) ruleCountEl.textContent = rules.length;
        if (logCountEl) logCountEl.textContent = logs.length;

        // 缓存数据
        window.smsTemplatesCache = templates;
        window.smsRulesCache = rules;
        window.smsEventsCache = eventsRes.data?.list || [];

        // 渲染数据
        renderSmsTemplates(templates);
        renderSmsRules(rules);
        renderSmsLogs(logs);
        fillSmsEventGuestSelect(window.smsEventsCache, guestsRes.data?.list || []);
        
        console.log('短信中心数据渲染完成');
    } catch (error) {
        console.error('加载短信中心数据失败:', error);
        alert('加载短信中心数据失败：' + (error.message || '请稍后重试'));
    }
}

function switchSmsTab(tabId) {
    document.querySelectorAll('.sms-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    document.querySelectorAll('.sms-tab-panel').forEach(panel => {
        if (panel.id === tabId) {
            panel.classList.remove('hidden');
        } else {
            panel.classList.add('hidden');
        }
    });
}

/** 语种代码 -> 本地化名称（短信模板列表用） */
function smsLangLabel(l) {
    const map = {
        'zh-CN': window.t('common.simplifiedChinese'),
        'zh-TW': window.t('common.traditionalChinese'),
        'en': window.t('common.english')
    };
    return map[l] || l || '-';
}

function renderSmsTemplates(templates) {
    const tbody = document.getElementById('smsTemplateTableBody');
    tbody.innerHTML = '';
    templates.forEach(t => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${t.id}</td>
            <td>${t.name}</td>
            <td>${t.message_type}</td>
            <td>${t.scene}</td>
            <td>${smsLangLabel(t.lang)}</td>
            <td>${t.aliyun_template_code}</td>
            <td>${t.sign_name}</td>
            <td>${t.enabled ? window.t('admin.yesNo_yes') : window.t('admin.yesNo_no')}</td>
            <td>
                <button class="btn btn-sm btn-outline" onclick="editSmsTemplate(${t.id})">编辑</button>
                <button class="btn btn-sm btn-outline" style="color:#EF4444;border-color:#EF4444;" onclick="deleteSmsTemplate(${t.id})">删除</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function renderSmsRules(rules) {
    const tbody = document.getElementById('smsRuleTableBody');
    if (!tbody) {
        console.error('找不到短信规则表格tbody元素');
        return;
    }
    
    tbody.innerHTML = '';
    
    if (!rules || rules.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="9" style="text-align: center; color: #6B7280; padding: 20px;">暂无规则</td>';
        tbody.appendChild(tr);
        return;
    }
    
    rules.forEach(r => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${r.id}</td>
            <td>${r.name || '-'}</td>
            <td>${r.message_type || '-'}</td>
            <td>${r.event_id || '-'}</td>
            <td>${r.template_id || '-'}</td>
            <td>${r.trigger_type || '-'}${r.trigger_type === 'SCHEDULED' && r.scheduled_time ? `<br><span style="font-size: 11px; color: #6B7280;">${formatDateTime(r.scheduled_time)}</span>` : ''}</td>
            <td>${r.max_send_times || '-'}</td>
            <td>${r.enabled ? window.t('admin.yesNo_yes') : window.t('admin.yesNo_no')}</td>
            <td>
                <button class="btn btn-sm btn-outline" onclick="editSmsRule(${r.id})">编辑</button>
                <button class="btn btn-sm btn-outline" style="color:#EF4444;border-color:#EF4444;" onclick="deleteSmsRule(${r.id})">删除</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function renderSmsLogs(logs) {
    const tbody = document.getElementById('smsLogTableBody');
    tbody.innerHTML = '';
    logs.forEach(l => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${l.id}</td>
            <td>${l.message_type}</td>
            <td>${l.event_id || '-'}</td>
            <td>${l.guest_id || '-'}</td>
            <td>${l.phone}</td>
            <td>${l.scene || '-'}</td>
            <td>${l.status === 1 ? window.t('admin.statusSuccess') : window.t('admin.statusFailed')}</td>
            <td>${formatDateTime(l.sent_at || l.created_at)}</td>
        `;
        tbody.appendChild(tr);
    });
}

function fillSmsEventGuestSelect(events, guests) {
    const eventSelect = document.getElementById('smsEventSelect');
    const guestSelect = document.getElementById('smsGuestSelect');
    eventSelect.innerHTML = '<option value="">请选择活动</option>';
    guestSelect.innerHTML = '<option value="">请选择嘉宾</option>';
    // 只展示未结束的活动（例如 status !== 2）
    events.filter(e => e.status !== 2).forEach(e => {
        const opt = document.createElement('option');
        opt.value = e.id;
        opt.textContent = e.name;
        eventSelect.appendChild(opt);
    });
    guests.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = `${g.name}${g.company ? ' - ' + g.company : ''}`;
        guestSelect.appendChild(opt);
    });
}

async function createSmsTemplate() {
    openSmsTemplateModal();
}

async function editSmsTemplate(id) {
    const templates = window.smsTemplatesCache || [];
    const tpl = templates.find(t => t.id === id);
    if (!tpl) {
        alert('未找到模板');
        return;
    }
    openSmsTemplateModal(tpl);
}

async function deleteSmsTemplate(id) {
    if (!confirm('确定要删除该模板吗？')) return;
    try {
        await apiRequest(`/sms/templates/${id}`, {
            method: 'DELETE'
        });
        alert('删除成功');
        loadSmsCenter();
    } catch (e) {
        alert('删除失败：' + e.message);
    }
}

function openSmsTemplateModal(tpl = null) {
    const modal = document.getElementById('smsTemplateModal');
    const title = document.getElementById('smsTemplateModalTitle');
    const idInput = document.getElementById('smsTemplateId');
    const nameInput = document.getElementById('smsTemplateName');
    const typeInput = document.getElementById('smsTemplateMessageType');
    const sceneSelect = document.getElementById('smsTemplateScene');
    const langSelect = document.getElementById('smsTemplateLang');
    const codeInput = document.getElementById('smsTemplateCode');
    const signInput = document.getElementById('smsTemplateSignName');
    const paramsInput = document.getElementById('smsTemplateParamsSchema');
    const enabledSelect = document.getElementById('smsTemplateEnabled');

    // 使用未结束活动列表填充下拉（加一个通用选项）
    const events = window.smsEventsCache || [];
    sceneSelect.innerHTML = '<option value="COMMON">通用（不关联具体活动）</option>';
    events.filter(e => e.status !== 2).forEach(e => {
        const opt = document.createElement('option');
        // 场景保存为活动名称，方便肉眼识别
        opt.value = e.name;
        opt.textContent = e.name;
        sceneSelect.appendChild(opt);
    });

    if (tpl) {
        title.textContent = '编辑短信模板';
        idInput.value = tpl.id;
        nameInput.value = tpl.name || '';
        typeInput.value = tpl.message_type || '';
        // 如果是通用模板，使用 COMMON；否则按名称匹配活动
        if (!tpl.scene || tpl.scene === 'COMMON') {
            sceneSelect.value = 'COMMON';
        } else {
            sceneSelect.value = tpl.scene;
        }
        langSelect.value = tpl.lang || 'zh-CN';
        codeInput.value = tpl.aliyun_template_code || '';
        signInput.value = tpl.sign_name || '';
        paramsInput.value = tpl.params_schema ? JSON.stringify(tpl.params_schema) : '';
        enabledSelect.value = tpl.enabled ? '1' : '0';
    } else {
        title.textContent = '新增短信模板';
        idInput.value = '';
        nameInput.value = '';
        typeInput.value = '';
        sceneSelect.value = 'COMMON';
        langSelect.value = 'zh-CN';
        codeInput.value = '';
        signInput.value = '';
        paramsInput.value = '';
        enabledSelect.value = '1';
    }

    modal.classList.remove('hidden');
}

function closeSmsTemplateModal() {
    document.getElementById('smsTemplateModal').classList.add('hidden');
}

async function handleSmsTemplateSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('smsTemplateId').value;
    const name = document.getElementById('smsTemplateName').value.trim();
    const messageType = document.getElementById('smsTemplateMessageType').value.trim();
    const scene = document.getElementById('smsTemplateScene').value;
    const code = document.getElementById('smsTemplateCode').value.trim();
    const signName = document.getElementById('smsTemplateSignName').value.trim();
    const paramsText = document.getElementById('smsTemplateParamsSchema').value.trim();
    const enabledVal = document.getElementById('smsTemplateEnabled').value;
    const lang = (document.getElementById('smsTemplateLang') || {}).value || 'zh-CN';

    if (!name || !messageType || !scene || !code || !signName) {
        alert('请填写必填字段：名称、短信类型、场景/活动、模板CODE、签名');
        return;
    }

    let paramsSchema = null;
    if (paramsText) {
        try {
            paramsSchema = JSON.parse(paramsText);
        } catch (err) {
            alert('参数说明不是合法的 JSON，请检查格式');
            return;
        }
    }

    const payload = {
        name,
        message_type: messageType,
        scene,
        lang,
        aliyun_template_code: code,
        sign_name: signName,
        enabled: enabledVal === '1' ? 1 : 0
    };
    if (paramsSchema) {
        payload.params_schema = paramsSchema;
    }

    try {
        if (id) {
            await apiRequest(`/sms/templates/${id}`, {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
        } else {
            await apiRequest('/sms/templates', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        }
        alert('保存成功');
        closeSmsTemplateModal();
        loadSmsCenter();
    } catch (err) {
        alert('保存失败：' + err.message);
    }
}

async function createSmsRule() {
    openSmsRuleModal();
}

async function editSmsRule(id) {
    const rules = window.smsRulesCache || [];
    const rule = rules.find(r => r.id === id);
    if (!rule) {
        alert('未找到规则');
        return;
    }
    openSmsRuleModal(rule);
}

async function deleteSmsRule(id) {
    if (!confirm('确定要删除该规则吗？')) return;
    try {
        await apiRequest(`/sms/rules/${id}`, {
            method: 'DELETE'
        });
        alert('删除成功');
        loadSmsCenter();
    } catch (e) {
        alert('删除失败：' + e.message);
    }
}

function toggleScheduledTimeInput() {
    const triggerType = document.getElementById('smsRuleTriggerType').value;
    const scheduledTimeGroup = document.getElementById('scheduledTimeGroup');
    const scheduledTimeInput = document.getElementById('smsRuleScheduledTime');
    
    if (triggerType === 'SCHEDULED') {
        scheduledTimeGroup.style.display = 'block';
        scheduledTimeInput.required = true;
    } else {
        scheduledTimeGroup.style.display = 'none';
        scheduledTimeInput.required = false;
        scheduledTimeInput.value = '';
    }
}

function openSmsRuleModal(rule = null) {
    const modal = document.getElementById('smsRuleModal');
    const title = document.getElementById('smsRuleModalTitle');
    const idInput = document.getElementById('smsRuleId');
    const nameInput = document.getElementById('smsRuleName');
    const typeSelect = document.getElementById('smsRuleMessageType');
    const triggerSelect = document.getElementById('smsRuleTriggerType');
    const eventSelect = document.getElementById('smsRuleEventId');
    const tplIdInput = document.getElementById('smsRuleTemplateId');
    const maxTimesInput = document.getElementById('smsRuleMaxSendTimes');
    const enabledSelect = document.getElementById('smsRuleEnabled');
    const conditionsInput = document.getElementById('smsRuleConditions');
    const scheduledTimeInput = document.getElementById('smsRuleScheduledTime');

    if (rule) {
        title.textContent = '编辑短信规则';
        idInput.value = rule.id;
        nameInput.value = rule.name || '';
        typeSelect.value = rule.message_type || 'REG_SUCCESS';
        triggerSelect.value = rule.trigger_type || 'STATUS_CHANGE';
        
        // 设置定时时间
        if (rule.scheduled_time) {
            const date = new Date(rule.scheduled_time);
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            scheduledTimeInput.value = `${year}-${month}-${day}T${hours}:${minutes}`;
        } else {
            scheduledTimeInput.value = '';
        }
        
        // 触发显示/隐藏定时时间输入框
        toggleScheduledTimeInput();
        // 填充活动下拉（仅未结束活动）
        const events = window.smsEventsCache || [];
        eventSelect.innerHTML = '<option value="">全部活动（通用规则）</option>';
        events.filter(e => e.status !== 2).forEach(e => {
            const opt = document.createElement('option');
            opt.value = e.id;
            opt.textContent = e.name;
            eventSelect.appendChild(opt);
        });
        // 如果规则绑定的活动已经结束，仍然保留一个选项方便查看/修改
        if (rule.event_id && !events.some(e => e.id === rule.event_id)) {
            const opt = document.createElement('option');
            opt.value = rule.event_id;
            opt.textContent = `${window.t('admin.eventIdOffline', [rule.event_id])}`;
            eventSelect.appendChild(opt);
        }
        eventSelect.value = rule.event_id || '';
        tplIdInput.value = rule.template_id || '';
        maxTimesInput.value = rule.max_send_times || '';
        enabledSelect.value = rule.enabled ? '1' : '0';
        conditionsInput.value = rule.conditions ? JSON.stringify(rule.conditions) : '';
    } else {
        title.textContent = '新增短信规则';
        idInput.value = '';
        nameInput.value = '';
        typeSelect.value = 'REG_SUCCESS';
        triggerSelect.value = 'STATUS_CHANGE';
        const events = window.smsEventsCache || [];
        eventSelect.innerHTML = '<option value="">全部活动（通用规则）</option>';
        events.filter(e => e.status !== 2).forEach(e => {
            const opt = document.createElement('option');
            opt.value = e.id;
            opt.textContent = e.name;
            eventSelect.appendChild(opt);
        });
        tplIdInput.value = '';
        maxTimesInput.value = '1';
        enabledSelect.value = '1';
        conditionsInput.value = '';
        scheduledTimeInput.value = '';
        toggleScheduledTimeInput();
    }

    modal.classList.remove('hidden');
}

function closeSmsRuleModal() {
    document.getElementById('smsRuleModal').classList.add('hidden');
}

async function handleSmsRuleSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('smsRuleId').value;
    const name = document.getElementById('smsRuleName').value.trim();
    const messageType = document.getElementById('smsRuleMessageType').value;
    const triggerType = document.getElementById('smsRuleTriggerType').value;
    const eventIdStr = document.getElementById('smsRuleEventId').value.trim();
    const tplIdStr = document.getElementById('smsRuleTemplateId').value.trim();
    const maxTimesStr = document.getElementById('smsRuleMaxSendTimes').value.trim();
    const enabledVal = document.getElementById('smsRuleEnabled').value;
    const conditionsText = document.getElementById('smsRuleConditions').value.trim();
    const scheduledTimeStr = document.getElementById('smsRuleScheduledTime').value.trim();

    if (!name) {
        alert('请输入规则名称');
        return;
    }
    if (!tplIdStr) {
        alert('请输入模板ID');
        return;
    }
    
    // 如果是定时任务，必须设置定时时间
    if (triggerType === 'SCHEDULED' && !scheduledTimeStr) {
        alert('定时任务必须设置发送时间');
        return;
    }

    let conditions = null;
    if (conditionsText) {
        try {
            conditions = JSON.parse(conditionsText);
        } catch (err) {
            alert('条件配置不是合法的 JSON，请检查格式');
            return;
        }
    }

    const payload = {
        name,
        message_type: messageType,
        trigger_type: triggerType,
        template_id: parseInt(tplIdStr, 10),
        enabled: enabledVal === '1' ? 1 : 0
    };
    if (eventIdStr) {
        payload.event_id = parseInt(eventIdStr, 10);
    } else {
        payload.event_id = null;
    }
    if (maxTimesStr) {
        payload.max_send_times = parseInt(maxTimesStr, 10);
    }
    if (conditions) {
        payload.conditions = conditions;
    }
    // 如果是定时任务，设置定时时间
    if (triggerType === 'SCHEDULED' && scheduledTimeStr) {
        payload.scheduled_time = new Date(scheduledTimeStr).toISOString();
    } else {
        payload.scheduled_time = null;
    }

    try {
        if (id) {
            await apiRequest(`/sms/rules/${id}`, {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
        } else {
            await apiRequest('/sms/rules', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        }
        alert('保存成功');
        closeSmsRuleModal();
        loadSmsCenter();
    } catch (err) {
        alert('保存失败：' + err.message);
    }
}

async function sendSmsByRules() {
    const eventId = document.getElementById('smsEventSelect').value;
    const guestId = document.getElementById('smsGuestSelect').value;
    const messageType = document.getElementById('smsMessageTypeInput').value.trim();
    const resultDiv = document.getElementById('smsSendResult');

    if (!eventId || !guestId) {
        alert('请选择活动和嘉宾');
        return;
    }

    try {
        const body = {
            event_id: parseInt(eventId, 10),
            guest_id: parseInt(guestId, 10)
        };
        if (messageType) {
            body.message_type = messageType;
        }
        const res = await apiRequest('/sms/send-auto', {
            method: 'POST',
            body: JSON.stringify(body)
        });
        const data = res.data || {};
        const rules = data.rules || [];
        let text = `${window.t('admin.ruleAttemptSummary', [rules.length, data.sent || 0])}`;
        if (rules.length) {
            text += rules.map(r => {
                return window.t('admin.ruleDetailFormat', [
                    r.rule_id, r.name, r.message_type,
                    r.event_id || '-', r.max_send_times || '-', r.reason
                ]);
            }).join('\n');
        } else {
            text += window.t('admin.noRuleMatched');
        }
        resultDiv.textContent = text;
        loadSmsCenter();
    } catch (e) {
        resultDiv.textContent = window.t('admin.sendFailedWith', [e.message]);
    }
}

// ==================== BD管理 ====================
let currentBdPage = 1;
let currentBdPageSize = 10;

// 加载BD列表
async function loadBds() {
    try {
        const keyword = document.getElementById('bdSearch')?.value || '';
        const params = new URLSearchParams({
            page: currentBdPage,
            pageSize: currentBdPageSize,
            role: 'bd'
        });
        if (keyword) params.append('keyword', keyword);
        
        const response = await fetch(`${API_BASE}/admins?${params}`, {
            headers: {
                'Authorization': `Bearer ${currentToken}`
            }
        });
        
        const data = await response.json();
        
        if (data.code === 200) {
            renderBdTable(data.data.list);
            renderBdPagination(data.data.total, data.data.page, data.data.pageSize);
        } else {
            alert(data.message || '加载失败');
        }
    } catch (error) {
        alert('加载失败：' + error.message);
    }
}

// 渲染BD表格
function renderBdTable(bds) {
    const tbody = document.getElementById('bdTableBody');
    tbody.innerHTML = '';
    
    if (!bds || bds.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 40px;">暂无数据</td></tr>';
        return;
    }
    
    bds.forEach(bd => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${bd.id}</td>
            <td>${bd.username}</td>
            <td>${bd.name || '-'}</td>
            <td>${bd.contact || '-'}</td>
            <td><span class="status-badge ${bd.role === 'bd' ? 'status-info' : ''}">${bd.role === 'bd' ? 'BD' : bd.role === 'operator' ? '运营' : bd.role}</span></td>
            <td><span class="status-badge ${bd.status === 1 ? 'status-success' : 'status-danger'}">${bd.status === 1 ? window.t('admin.statusEnabled') : window.t('admin.statusDisabled')}</span></td>
            <td>${bd.last_login_time ? formatDate(bd.last_login_time) : '-'}</td>
            <td>${formatDate(bd.created_at)}</td>
            <td>
                <div style="display: flex; gap: 8px;">
                    <button class="btn btn-sm btn-outline" onclick="editBd(${bd.id})">编辑</button>
                    ${bd.role !== 'admin' ? `<button class="btn btn-sm btn-danger" onclick="deleteBd(${bd.id})">删除</button>` : ''}
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// 渲染BD分页
function renderBdPagination(total, page, pageSize) {
    const pagination = document.getElementById('bdPagination');
    if (!pagination) return;
    
    const totalPages = Math.ceil(total / pageSize);
    if (totalPages <= 1) {
        pagination.innerHTML = '';
        return;
    }
    
    let html = '<div class="pagination-controls">';
    
    // 上一页
    html += `<button class="btn btn-sm ${page <= 1 ? 'disabled' : ''}" onclick="changeBdPage(${page - 1})" ${page <= 1 ? 'disabled' : ''}>上一页</button>`;
    
    // 页码
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= page - 2 && i <= page + 2)) {
            html += `<button class="btn btn-sm ${i === page ? 'btn-primary' : ''}" onclick="changeBdPage(${i})">${i}</button>`;
        } else if (i === page - 3 || i === page + 3) {
            html += '<span>...</span>';
        }
    }
    
    // 下一页
    html += `<button class="btn btn-sm ${page >= totalPages ? 'disabled' : ''}" onclick="changeBdPage(${page + 1})" ${page >= totalPages ? 'disabled' : ''}>下一页</button>`;
    
    html += `</div><div class="pagination-info">${window.t('admin.paginationInfo', [total, page, totalPages])}</div>`;
    
    pagination.innerHTML = html;
}

// 切换BD页面
function changeBdPage(page) {
    currentBdPage = page;
    loadBds();
}

// 显示BD模态框
function showBdModal(id = null) {
    const modal = document.getElementById('bdModal');
    const form = document.getElementById('bdForm');
    const title = document.getElementById('bdModalTitle');
    const passwordLabel = document.getElementById('bdPasswordLabel');
    const passwordInput = document.getElementById('bdPassword');
    
    form.reset();
    document.getElementById('bdId').value = '';
    
    if (id) {
        title.textContent = '编辑BD';
        passwordLabel.innerHTML = '密码 <span style="color: #6B7280; font-weight: normal;">(留空不修改)</span>';
        passwordInput.removeAttribute('required');
        loadBdDetail(id);
    } else {
        title.textContent = '添加BD';
        passwordLabel.innerHTML = '密码 <span class="required">*</span>';
        passwordInput.setAttribute('required', 'required');
    }
    
    modal.classList.remove('hidden');
}

// 加载BD详情
async function loadBdDetail(id) {
    try {
        const response = await fetch(`${API_BASE}/admins/${id}`, {
            headers: {
                'Authorization': `Bearer ${currentToken}`
            }
        });
        
        const data = await response.json();
        
        if (data.code === 200) {
            const bd = data.data;
            document.getElementById('bdId').value = bd.id;
            document.getElementById('bdUsername').value = bd.username;
            document.getElementById('bdUsername').disabled = true; // 用户名不可修改
            document.getElementById('bdName').value = bd.name || '';
            document.getElementById('bdContact').value = bd.contact || '';
            document.getElementById('bdRole').value = bd.role;
            document.getElementById('bdStatus').value = bd.status;
        } else {
            alert(data.message || '加载失败');
        }
    } catch (error) {
        alert('加载失败：' + error.message);
    }
}

// 关闭BD模态框
function closeBdModal() {
    document.getElementById('bdModal').classList.add('hidden');
    document.getElementById('bdForm').reset();
    document.getElementById('bdUsername').disabled = false;
}

// 编辑BD
function editBd(id) {
    showBdModal(id);
}

// 删除BD
async function deleteBd(id) {
    if (!confirm('确定要删除这个BD吗？')) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/admins/${id}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${currentToken}`
            }
        });
        
        const data = await response.json();
        
        if (data.code === 200) {
            alert('删除成功');
            loadBds();
        } else {
            alert(data.message || '删除失败');
        }
    } catch (error) {
        alert('删除失败：' + error.message);
    }
}

// 显示BD导入模态框
function showBdImportModal() {
    document.getElementById('bdImportModal').classList.remove('hidden');
    document.getElementById('bdImportFile').value = '';
    document.getElementById('bdDefaultPassword').value = '123456';
    document.getElementById('bdImportResult').style.display = 'none';
}

// 关闭BD导入模态框
function closeBdImportModal() {
    document.getElementById('bdImportModal').classList.add('hidden');
    document.getElementById('bdImportFile').value = '';
    document.getElementById('bdImportResult').style.display = 'none';
}

// 处理BD导入
async function handleBdImport() {
    const fileInput = document.getElementById('bdImportFile');
    const defaultPassword = document.getElementById('bdDefaultPassword').value.trim() || '123456';
    const resultDiv = document.getElementById('bdImportResult');
    const resultContent = document.getElementById('bdImportResultContent');
    
    if (!fileInput.files || fileInput.files.length === 0) {
        alert('请选择Excel文件');
        return;
    }
    
    const file = fileInput.files[0];
    
    // 验证文件类型
    const validTypes = [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
        'application/vnd.ms-excel' // .xls
    ];
    
    if (!validTypes.includes(file.type)) {
        alert('只支持Excel文件（.xlsx, .xls）');
        return;
    }
    
    // 创建FormData
    const formData = new FormData();
    formData.append('file', file);
    formData.append('defaultPassword', defaultPassword);
    
    // 显示加载状态
    resultDiv.style.display = 'block';
    resultContent.innerHTML = '<div style="color: #6B7280;">正在导入，请稍候...</div>';
    
    try {
        const response = await fetch(`${API_BASE}/admins/import`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${currentToken}`
            },
            body: formData
        });
        
        const data = await response.json();
        
        if (data.code === 200) {
            const report = data.data;
            
            let html = `
                <div style="margin-bottom: 12px;">
                    <div style="display: flex; gap: 24px; margin-bottom: 8px;">
                        <div><strong>总计：</strong>${report.total}</div>
                        <div style="color: #10B981;"><strong>成功：</strong>${report.success}</div>
                        <div style="color: #EF4444;"><strong>失败：</strong>${report.failed}</div>
                        <div><strong>成功率：</strong>${report.successRate}</div>
                    </div>
                </div>
            `;
            
            if (report.details && report.details.length > 0) {
                html += '<div style="max-height: 300px; overflow-y: auto; border: 1px solid #E5E7EB; border-radius: 6px; padding: 12px;">';
                html += '<table style="width: 100%; font-size: 13px;">';
                html += '<thead><tr style="border-bottom: 1px solid #E5E7EB;"><th style="text-align: left; padding: 8px;">行号</th><th style="text-align: left; padding: 8px;">用户名</th><th style="text-align: left; padding: 8px;">姓名</th><th style="text-align: left; padding: 8px;">结果</th></tr></thead>';
                html += '<tbody>';
                
                report.details.forEach(item => {
                    const statusColor = item.success ? '#10B981' : '#EF4444';
                    const statusText = item.success ? '✓ 成功' : `✗ ${item.message}`;
                    html += `
                        <tr style="border-bottom: 1px solid #F3F4F6;">
                            <td style="padding: 8px;">${item.row}</td>
                            <td style="padding: 8px;">${item.username || '-'}</td>
                            <td style="padding: 8px;">${item.name || '-'}</td>
                            <td style="padding: 8px; color: ${statusColor};">${statusText}</td>
                        </tr>
                    `;
                });
                
                html += '</tbody></table></div>';
            }
            
            resultContent.innerHTML = html;
            
            // 刷新BD列表
            if (report.success > 0) {
                setTimeout(() => {
                    loadBds();
                }, 1000);
            }
        } else {
            resultContent.innerHTML = `<div style="color: #EF4444;">${window.t('admin.importFailedWith', [data.message || window.t('admin.unknownError')])}</div>`;
        }
    } catch (error) {
        console.error('导入失败:', error);
        resultContent.innerHTML = `<div style="color: #EF4444;">${window.t('admin.importFailedWith', [error.message])}</div>`;
    }
}

// 提交BD表单
async function handleBdSubmit(e) {
    e.preventDefault();
    
    const id = document.getElementById('bdId').value;
    const username = document.getElementById('bdUsername').value.trim();
    const password = document.getElementById('bdPassword').value;
    const name = document.getElementById('bdName').value.trim();
    const contact = document.getElementById('bdContact').value.trim();
    const role = document.getElementById('bdRole').value;
    const status = parseInt(document.getElementById('bdStatus').value);
    
    if (!username) {
        alert('请输入用户名');
        return;
    }
    
    if (!id && !password) {
        alert('请输入密码');
        return;
    }
    
    try {
        const url = id ? `${API_BASE}/admins/${id}` : `${API_BASE}/admins`;
        const method = id ? 'PUT' : 'POST';
        
        const body = {
            name,
            contact,
            role,
            status
        };
        
        if (password) {
            body.password = password;
        }
        
        if (!id) {
            body.username = username;
        }
        
        const response = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify(body)
        });
        
        const data = await response.json();
        
        if (data.code === 200 || data.code === 201) {
            alert(id ? '更新成功' : '创建成功');
            closeBdModal();
            loadBds();
        } else {
            alert(data.message || '操作失败');
        }
    } catch (error) {
        alert('操作失败：' + error.message);
    }
}

// BD搜索（延迟搜索）
let bdSearchTimeout;
document.addEventListener('DOMContentLoaded', () => {
    const bdSearch = document.getElementById('bdSearch');
    if (bdSearch) {
        bdSearch.addEventListener('input', (e) => {
            clearTimeout(bdSearchTimeout);
            bdSearchTimeout = setTimeout(() => {
                currentBdPage = 1;
                loadBds();
            }, 500);
        });
    }
});

// ==================== 签到详情查看 ====================

// 查看签到详情
async function viewCheckin(checkinId) {
    try {
        // 获取签到记录详情
        const data = await apiRequest(`/checkins`);
        const checkin = data.data?.list?.find(c => c.id === checkinId);
        
        if (!checkin) {
            alert('签到记录不存在');
            return;
        }
        
        // 创建详情模态框
        const locationTypeText = checkin.location_type === 1 ? '深圳专用' : '深圳+香港通用';
        const deviceInfo = checkin.device_info ? JSON.parse(checkin.device_info) : {};
        
        const modalHtml = `
            <div id="checkinDetailModal" class="modal">
                <div class="modal-content">
                    <div class="modal-header">
                        <h2>签到详情</h2>
                        <span class="close" onclick="closeCheckinDetailModal()">&times;</span>
                    </div>
                    <div class="modal-body">
                        <div class="detail-section">
                            <h3>嘉宾信息</h3>
                            <div class="detail-grid">
                                <div class="detail-item">
                                    <span class="detail-label">姓名</span>
                                    <span class="detail-value">${checkin.guest?.name || '-'}</span>
                                </div>
                                <div class="detail-item">
                                    <span class="detail-label">公司</span>
                                    <span class="detail-value">${checkin.guest?.company || '-'}</span>
                                </div>
                                <div class="detail-item">
                                    <span class="detail-label">职位</span>
                                    <span class="detail-value">${checkin.guest?.position || '-'}</span>
                                </div>
                            </div>
                        </div>
                        
                        <div class="detail-section">
                            <h3>活动信息</h3>
                            <div class="detail-grid">
                                <div class="detail-item">
                                    <span class="detail-label">活动名称</span>
                                    <span class="detail-value">${ec9I18n(checkin.event, 'name') || '-'}</span>
                                </div>
                                <div class="detail-item">
                                    <span class="detail-label">活动地点</span>
                                    <span class="detail-value">${checkin.event?.location || '-'}</span>
                                </div>
                                <div class="detail-item">
                                    <span class="detail-label">活动时间</span>
                                    <span class="detail-value">${formatDateTime(checkin.event?.start_time)}</span>
                                </div>
                            </div>
                        </div>
                        
                        <div class="detail-section">
                            <h3>签到信息</h3>
                            <div class="detail-grid">
                                <div class="detail-item">
                                    <span class="detail-label">签到时间</span>
                                    <span class="detail-value">${formatDateTime(checkin.checkin_time)}</span>
                                </div>
                                <div class="detail-item">
                                    <span class="detail-label">签到类型</span>
                                    <span class="detail-value">${locationTypeText}</span>
                                </div>
                                <div class="detail-item">
                                    <span class="detail-label">签到地点</span>
                                    <span class="detail-value">${checkin.location || checkin.event?.location || '-'}</span>
                                </div>
                            </div>
                        </div>
                        
                        <div class="detail-section">
                            <h3>设备信息</h3>
                            <div class="detail-grid">
                                <div class="detail-item full-width">
                                    <span class="detail-label">用户代理</span>
                                    <span class="detail-value" style="word-break: break-all;">${checkin.user_agent || '-'}</span>
                                </div>
                                <div class="detail-item">
                                    <span class="detail-label">平台</span>
                                    <span class="detail-value">${deviceInfo.platform || '-'}</span>
                                </div>
                                <div class="detail-item">
                                    <span class="detail-label">屏幕尺寸</span>
                                    <span class="detail-value">${deviceInfo.screenWidth && deviceInfo.screenHeight ? `${deviceInfo.screenWidth}x${deviceInfo.screenHeight}` : '-'}</span>
                                </div>
                                <div class="detail-item">
                                    <span class="detail-label">IP地址</span>
                                    <span class="detail-value">${checkin.ip_address || '-'}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-secondary" onclick="closeCheckinDetailModal()">关闭</button>
                    </div>
                </div>
            </div>
        `;
        
        // 添加模态框到页面
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        
        // 显示模态框
        document.getElementById('checkinDetailModal').style.display = 'flex';
        
    } catch (error) {
        console.error('获取签到详情失败:', error);
        alert('获取签到详情失败');
    }
}

// 关闭签到详情模态框
function closeCheckinDetailModal() {
    const modal = document.getElementById('checkinDetailModal');
    if (modal) {
        modal.remove();
    }
}

/* ==================== 报名审核（多人代报整单） ==================== */
let regAuditCache = [];

async function loadRegAudit() {
    const status = document.getElementById('regAuditStatus').value;
    const keyword = document.getElementById('regAuditKeyword').value.trim();
    const body = document.getElementById('regAuditBody');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="9">加载中…</td></tr>';
    try {
        const res = await apiRequest(`/registrations/group-list?status=${encodeURIComponent(status)}&keyword=${encodeURIComponent(keyword)}`);
        regAuditCache = (res.data && res.data.list) || [];
        if (!regAuditCache.length) {
            body.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#999">暂无数据</td></tr>';
            return;
        }
        const stMap = { submitted: '<span style="color:#E8A33D">待审核</span>', approved: '<span style="color:#3056D4">待支付</span>', paid: '<span style="color:#00B42A">已支付</span>', rejected: '<span style="color:#E34D59">已驳回</span>' };
        body.innerHTML = regAuditCache.map((g, i) => {
            const names = g.members.map(m => m.name + (m.is_buyer ? '(购票人)' : '') + (m.is_invited ? '<span style="color:#00B42A;font-size:11px">[邀约免票]</span>' : '<span style="color:#E8A33D;font-size:11px">[需购票]</span>')).join('、');
            const tickets = [...new Set(g.members.map(m => m.ticket_name))].join('/');
            const canAudit = g.status === 'submitted';
            // 多人一起审核：只有「全部通过」和「全部驳回」两种结果；满3张9折、满5张8折
            const disc = (g.paid_count >= 5) ? '满5张8折' : (g.paid_count >= 3 ? '满3张9折' : '');
            const cntTip = disc ? `<br><span style="font-size:11px;color:#C2404F">${disc}</span>` : '';
            return `<tr data-gi="${i}">
                <td><input type="checkbox" class="reg-audit-ck" data-gno="${g.group_no}" ${canAudit ? '' : 'disabled'}></td>
                <td style="font-family:monospace;font-size:12px">${g.group_no}</td>
                <td style="max-width:260px" title="${names}">${names}</td>
                <td>${g.submitter_phone || '-'}</td>
                <td>${tickets}</td>
                <td>${g.members.length}<br><span style="font-size:11px;color:#6B7280">邀约 ${g.invited_count || 0} · 需付款 ${g.paid_count || 0}</span>${cntTip}</td>
                <td>${stMap[g.status] || g.status}${g.members.some(m => m.reject_reason) ? '<br><span style="font-size:11px;color:#E34D59">' + (g.members.find(m => m.reject_reason) || {}).reject_reason + '</span>' : ''}</td>
                <td style="font-size:12px">${g.submitted_at ? new Date(g.submitted_at).toLocaleString() : '-'}</td>
                <td>${canAudit ? `<button class="btn btn-primary btn-sm" onclick="regAuditOne('${g.group_no}','approve')">通过</button>
                    <button class="btn btn-outline btn-sm" onclick="regAuditOne('${g.group_no}','reject')">驳回</button>` : '-'}</td>
            </tr>`;
        }).join('');
        const ckAll = document.getElementById('regAuditCkAll');
        ckAll.checked = false;
        ckAll.onchange = () => {
            document.querySelectorAll('#regAuditBody .reg-audit-ck:not(:disabled)').forEach(c => c.checked = ckAll.checked);
        };
    } catch (e) {
        body.innerHTML = `<tr><td colspan="9" style="color:#E34D59">加载失败：${e.message}</td></tr>`;
    }
}

async function regAuditOne(groupNo, action) {
    let reason = '';
    if (action === 'reject') {
        reason = prompt('驳回原因（将展示给用户）：');
        if (reason === null) return;
    } else {
        const g = regAuditCache.find(x => x.group_no === groupNo);
        const n = g ? g.members.length : 0;
        const p = g ? (g.paid_count || 0) : 0;
        const disc = p >= 5 ? '（满5张8折）' : (p >= 3 ? '（满3张9折）' : '');
        if (!confirm(`确认通过 ${groupNo} 整单（${n} 人，需付款 ${p} 人${disc}）？\n通过 = 全部通过；通过后建单锁库存，并向购票人发送付款链接短信。`)) return;
    }
    try {
        const res = await apiRequest(`/registrations/group/${groupNo}/audit`, {
            method: 'POST', body: JSON.stringify({ action, reason })
        });
        const d = res.data || {};
        if (action === 'approve' && d.pay_url) {
            alert(`已通过并建单。\n付款链接（短信已发购票人）：\n${d.pay_url}`);
        } else {
            alert(action === 'approve' ? '已通过' : '已驳回');
        }
        loadRegAudit();
    } catch (e) {
        alert('操作失败：' + e.message);
    }
}

async function regAuditBulk(action) {
    const gnos = Array.from(document.querySelectorAll('#regAuditBody .reg-audit-ck:checked')).map(c => c.dataset.gno);
    if (!gnos.length) { alert('请先勾选要审核的报名单（仅待审核可勾选）'); return; }
    let reason = '';
    if (action === 'reject') {
        reason = prompt(`驳回原因（将应用到所选 ${gnos.length} 单）：`);
        if (reason === null) return;
    } else if (!confirm(`确认批量通过 ${gnos.length} 单？通过后将分别建单锁库存并发短信。`)) return;
    let ok = 0, failMsgs = [];
    for (const gno of gnos) {
        try {
            await apiRequest(`/registrations/group/${gno}/audit`, {
                method: 'POST', body: JSON.stringify({ action, reason })
            });
            ok++;
        } catch (e) { failMsgs.push(`${gno}: ${e.message}`); }
    }
    alert(`批量${action === 'approve' ? '通过' : '驳回'}完成：成功 ${ok}/${gnos.length}` + (failMsgs.length ? '\n失败：\n' + failMsgs.join('\n') : ''));
    loadRegAudit();
}
