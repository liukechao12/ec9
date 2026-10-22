// 获取URL参数
function getUrlParam(name) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(name);
}

// 页面缩放处理 - 确保在所有手机上全屏显示
function setupPageScale() {
    const designWidth = 375;
    const designHeight = 813;
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    
    // 计算缩放比例：使用屏幕宽度填满
    const scale = screenWidth / designWidth;
    
    // 设置CSS变量
    document.documentElement.style.setProperty('--scale-ratio', scale);
    document.documentElement.style.setProperty('--screen-width', screenWidth + 'px');
    document.documentElement.style.setProperty('--screen-height', screenHeight + 'px');
    
    // 设置所有页面的缩放
    const pages = document.querySelectorAll('.page');
    pages.forEach(page => {
        page.style.transform = `scale(${scale})`;
        page.style.transformOrigin = '0 0';
        page.style.width = designWidth + 'px';
        page.style.height = designHeight + 'px';
    });
    
    // 设置body的最小高度为缩放后的页面高度
    const scaledHeight = designHeight * scale;
    document.body.style.minHeight = Math.max(scaledHeight, screenHeight) + 'px';
    document.body.style.width = '100vw';
    document.body.style.overflowX = 'hidden';
}

// 页面加载和窗口大小变化时重新计算缩放
window.addEventListener('DOMContentLoaded', setupPageScale);
window.addEventListener('resize', setupPageScale);
window.addEventListener('orientationchange', function() {
    setTimeout(setupPageScale, 100);
});

// 邀请信息存储
let invitationData = null;

// 页面管理器
const PageManager = {
    currentPage: 'page-home',
    // 将手机号同步到两个信息填写表单
    setPhoneInForms(phone) {
        if (!phone) return;
        const formPhones = [
            document.getElementById('guestPhone'),
            document.getElementById('guestPhone2')
        ];
        formPhones.forEach(input => {
            if (input) input.value = phone;
        });
    },
    
    init() {
        // 初始化时也设置缩放
        setupPageScale();
        // 检查URL参数，支持直接访问指定页面
        const urlPage = getUrlParam('page');
        const hashPage = window.location.hash.replace('#', '');
        const targetPage = urlPage || hashPage || null;
        
        // 确保首页显示，其他页面隐藏
        const pages = document.querySelectorAll('.page');
        pages.forEach(page => {
            if (targetPage && page.id === targetPage) {
                // 如果URL指定了页面，显示该页面
                page.classList.add('active');
                page.style.display = 'block';
                this.currentPage = targetPage;
            } else if (!targetPage && page.id === 'page-home') {
                // 默认显示首页
                page.classList.add('active');
                page.style.display = 'block';
            } else {
                page.classList.remove('active');
                page.style.display = 'none';
            }
        });
        
        // 加载邀请信息
        this.loadInvitationInfo();
    },
    
    // 检查已保存的手机号状态
    async checkSavedPhoneStatus() {
        // 从localStorage获取上次验证的手机号
        const savedPhone = localStorage.getItem('lastVerifiedPhone');
        if (!savedPhone || savedPhone.length !== 11 || !/^1[3-9]\d{9}$/.test(savedPhone)) {
            return false;
        }
        
        // 获取EventID
        const eventId = getUrlParam('EventID');
        if (!eventId) {
            return false;
        }
        
        // 如果当前页面是签到页，跳过自动注册状态检查，保持签到流程
        if (PageManager.currentPage === 'page-checkin-info') {
            return false;
        }
        
        console.log('检测到已保存的手机号，自动检查状态:', savedPhone);
        
        try {
            // 调用API检查该手机号在该活动下的状态
            const response = await fetch('/api/invitations/verify-phone', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ 
                    phone: savedPhone,
                    event_id: eventId
                })
            });
            
            const result = await response.json();
            
            if ((result.code === 200 || result.code === 0) && result.data) {
                // 如果已报名，直接显示结果页
                if (result.data.is_registered) {
                    console.log('用户已报名，直接显示结果页面');
                    // 同步手机号到sessionStorage
                    sessionStorage.setItem('verifiedPhone', savedPhone);
                    // 根据审批状态决定显示成功页还是待审核页
                    if (result.data.approval_status === 1) {
                        // 待审核
                        PageManager.showPage('page-pending');
                    } else {
                        // 已报名成功
                        PageManager.showPage('page-success');
                    }
                    return true;
                } else {
                    // 未报名，但手机号在系统中，预填手机号并显示注册表单
                    console.log('手机号在系统中但未报名，进入注册流程');
                    sessionStorage.setItem('verifiedPhone', savedPhone);
                    PageManager.setPhoneInForms(savedPhone);
                    // 根据EventID判断显示哪个表单
                    if (eventId === '1') {
                        PageManager.showPage('page-register-form-2');
                    } else if (eventId === '2') {
                        PageManager.showPage('page-register-form');
                    } else {
                        PageManager.showPage('page-register-form');
                    }
                    return true;
                }
            } else if (result.code === 404) {
                // 手机号不在系统中，清除保存的手机号，进入新用户注册流程
                console.log('手机号不在系统中，清除保存，进入新用户注册流程');
                localStorage.removeItem('lastVerifiedPhone');
                sessionStorage.setItem('verifiedPhone', savedPhone);
                PageManager.setPhoneInForms(savedPhone);
                // 根据EventID判断显示哪个表单
                if (eventId === '1') {
                    PageManager.showPage('page-register-form-2');
                } else if (eventId === '2') {
                    PageManager.showPage('page-register-form');
                } else {
                    PageManager.showPage('page-register-form');
                }
                return true;
            }
        } catch (error) {
            console.error('检查已保存手机号状态失败:', error);
            return false;
        }
        
        return false;
    },
    
    // 加载邀请信息
    async loadInvitationInfo() {
        const code = getUrlParam('code');
        if (!code) {
            console.log('未找到邀请码，将使用手机号注册流程');
            
            // 如果当前页面是签到页，跳过自动注册状态检查，避免直接跳到报名成功/待审核
            if (this.currentPage === 'page-checkin-info') {
                this.prefillPhoneNumber();
                return;
            }
            
            // 先检查是否有已保存的手机号，如果有则自动检查状态
            const hasChecked = await this.checkSavedPhoneStatus();
            if (hasChecked) {
                // 已经自动处理了，不需要继续
                return;
            }
            
            // 即使没有邀请码，也尝试预填手机号（从sessionStorage或localStorage）
            this.prefillPhoneNumber();
            return;
        }
        
        try {
            const response = await fetch(`/api/invitations/code/${code}`);
            const result = await response.json();
            
            if ((result.code === 200 || result.code === 0) && result.data) {
                invitationData = result.data;
                console.log('邀请信息加载成功:', invitationData);
                
                // 检查是否已报名，如果已报名直接显示结果页
                if (invitationData.registration_status === 2 || 
                    (invitationData.registration_status === 1 && invitationData.approval_status === 1)) {
                    console.log('用户已报名，直接显示结果页面');
                    if (invitationData.approval_status === 1) {
                        // 待审核
                        PageManager.showPage('page-pending');
                    } else {
                        // 已报名成功
                        PageManager.showPage('page-success');
                    }
                    return;
                }
                
                // 预填手机号
                this.prefillPhoneNumber();
                
                // 如果有邀约信息，根据邀约的 event_id 决定显示哪个表单
                // 当用户点击"下一步"时，如果手机号在系统中，会根据邀约信息跳转到对应的表单
                // 这里先保存 event_id 到全局变量，供后续使用
                if (invitationData.event_id) {
                    window.currentInvitationEventId = invitationData.event_id;
                    console.log('保存邀约的活动ID:', invitationData.event_id);
                }
            } else {
                console.error('获取邀请信息失败:', result.message);
                // 如果邀请码无效，也尝试预填手机号（从sessionStorage）
                this.prefillPhoneNumber();
                // 如果邀请码无效，显示错误提示
                if (result.code === 404) {
                    this.showInvitationError('邀请码无效，请获取新的链接');
                }
            }
        } catch (error) {
            console.error('加载邀请信息出错:', error);
            // 出错时也尝试预填手机号
            this.prefillPhoneNumber();
        }
    },
    
    // 预填表单信息（包括手机号、姓名、公司、职务、邀请人）
    prefillPhoneNumber() {
        // 1. 预填手机号
        let phone = null;
        
        // 优先从邀请信息中获取手机号
        if (invitationData && invitationData.guest) {
            const guest = invitationData.guest;
            if (guest.phone_decrypted) {
                phone = guest.phone_decrypted;
            } else if (guest.phone) {
                const rawPhone = guest.phone;
                if (rawPhone && rawPhone.length === 11 && /^1[3-9]\d{9}$/.test(rawPhone)) {
                    phone = rawPhone;
                }
            }
        }
        
        // 如果没有邀请信息，从sessionStorage或localStorage获取验证过的手机号
        if (!phone) {
            // 优先从sessionStorage获取（当前会话）
            let verifiedPhone = sessionStorage.getItem('verifiedPhone');
            // 如果sessionStorage没有，从localStorage获取（持久化）
            if (!verifiedPhone) {
                verifiedPhone = localStorage.getItem('lastVerifiedPhone');
            }
            if (verifiedPhone && verifiedPhone.length === 11 && /^1[3-9]\d{9}$/.test(verifiedPhone)) {
                phone = verifiedPhone;
                console.log('从存储获取验证手机号:', phone);
            }
        }
        
        if (phone) {
            const phoneInputs = [
                document.getElementById('registerPhone'),
                document.getElementById('checkinPhone'),
                document.getElementById('guestPhone'),
                document.getElementById('guestPhone2')
            ];
            
            phoneInputs.forEach(input => {
                if (input) {
                    input.value = phone;
                }
            });
            console.log('手机号已预填:', phone);
        }
        
        // 2. 预填姓名、公司、职务（仅当有邀请信息时）
        if (invitationData && invitationData.guest) {
            const guest = invitationData.guest;
            
            // 预填姓名（两个表单页面）
            if (guest.name) {
                const nameInputs = [
                    document.getElementById('guestName'),
                    document.getElementById('guestName2')
                ];
                nameInputs.forEach(input => {
                    if (input) {
                        input.value = guest.name;
                    }
                });
                console.log('姓名已预填:', guest.name);
            }
            
            // 预填公司（两个表单页面）
            if (guest.company) {
                const companyInputs = [
                    document.getElementById('guestCompany'),
                    document.getElementById('guestCompany2')
                ];
                companyInputs.forEach(input => {
                    if (input) {
                        input.value = guest.company;
                    }
                });
                console.log('公司已预填:', guest.company);
            }
            
            // 预填职务（两个表单页面）
            if (guest.position) {
                const positionInputs = [
                    document.getElementById('guestPosition'),
                    document.getElementById('guestPosition2')
                ];
                positionInputs.forEach(input => {
                    if (input) {
                        input.value = guest.position;
                    }
                });
                console.log('职务已预填:', guest.position);
            }
        }
        
        // 5. 预填邀请人（从 BD 信息或 source_bd 获取，两个表单页面）
        // ⚠️ invitationData 可能为 null（邀约码无效/接口失败），
        //    这里必须判空，否则直接读 .bd 会抛 "Cannot read properties of null"，
        //    把整个 catch 块里的兜底预填一起带崩（2026-10-15 修）。
        let inviterName = null;
        if (invitationData && invitationData.bd) {
            inviterName = invitationData.bd.name || invitationData.bd.username || null;
        }
        if (!inviterName && invitationData && invitationData.source_bd) {
            // 如果没有 BD 对象但有 source_bd 字段，使用 source_bd
            inviterName = invitationData.source_bd;
        }
        
        if (inviterName) {
            const inviterInputs = [
                document.getElementById('inviter'),
                document.getElementById('inviter2')
            ];
            inviterInputs.forEach(input => {
                if (input) {
                    input.value = inviterName;
                }
            });
            console.log('邀请人已预填:', inviterName);
        }
    },

    /**
     * 根据 /api/invitations/verify-phone 返回的数据，预填嘉宾信息
     * 适用于“通过短信验证手机号”的报名流程（无邀请码）
     */
    prefillGuestInfoFromVerifyResult(data) {
        if (!data) return;
        
        const { guest_name, guest_company, guest_position, inviter_name, inviter_username } = data;
        
        // 预填姓名
        if (guest_name) {
            const nameInputs = [
                document.getElementById('guestName'),
                document.getElementById('guestName2')
            ];
            nameInputs.forEach(input => {
                if (input && !input.value) {
                    input.value = guest_name;
                }
            });
            console.log('通过手机号验证预填姓名:', guest_name);
        }
        
        // 预填公司
        if (guest_company) {
            const companyInputs = [
                document.getElementById('guestCompany'),
                document.getElementById('guestCompany2')
            ];
            companyInputs.forEach(input => {
                if (input && !input.value) {
                    input.value = guest_company;
                }
            });
            console.log('通过手机号验证预填公司:', guest_company);
        }
        
        // 预填职务
        if (guest_position) {
            const positionInputs = [
                document.getElementById('guestPosition'),
                document.getElementById('guestPosition2')
            ];
            positionInputs.forEach(input => {
                if (input && !input.value) {
                    input.value = guest_position;
                }
            });
            console.log('通过手机号验证预填职务:', guest_position);
        }

        // 预填邀请人（优先 inviter_name，其次 inviter_username）
        const inviterValue = inviter_name || inviter_username || null;
        if (inviterValue) {
            const inviterInputs = [
                document.getElementById('inviter'),
                document.getElementById('inviter2')
            ];
            inviterInputs.forEach(input => {
                if (input && !input.value) {
                    input.value = inviterValue;
                }
            });
            console.log('通过手机号验证预填邀请人:', inviterValue);
        }
    },
    
    // 显示邀请错误提示
    showInvitationError(message) {
        // 可以创建一个错误提示元素显示在页面上
        const errorDiv = document.createElement('div');
        errorDiv.className = 'invitation-error';
        errorDiv.style.cssText = 'position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #e74c3c; color: white; padding: 15px 20px; border-radius: 8px; z-index: 10000; box-shadow: 0 4px 12px rgba(0,0,0,0.3);';
        errorDiv.textContent = message;
        document.body.appendChild(errorDiv);
        
        // 3秒后自动移除
        setTimeout(() => {
            errorDiv.remove();
        }, 3000);
    },
    
    showPage(pageId) {
        // 隐藏所有页面
        const pages = document.querySelectorAll('.page');
        pages.forEach(page => {
            page.classList.remove('active');
            page.style.display = 'none';
        });
        
        // 显示目标页面
        const targetPage = document.getElementById(pageId);
        if (targetPage) {
            targetPage.classList.add('active');
            targetPage.style.display = 'block';
            this.currentPage = pageId;
        }
    },
    

    // 渲染电子票信息
    renderTicket(ticketData) {
        const { guest, ticket } = ticketData || {};
        const nameEl = document.querySelector('#page-ticket .guest-name');
        if (nameEl && guest?.name) nameEl.textContent = guest.name;
        const companyEl = document.querySelector('#page-ticket .ticket-company');
        if (companyEl && guest?.company) companyEl.textContent = guest.company;
        const seatEl = document.querySelector('#page-ticket .ticket-seat');
        if (seatEl && ticketData?.seat) seatEl.textContent = ticketData.seat;
        const codeEl = document.querySelector('#page-ticket .ticket-code');
        if (codeEl && ticket?.ticket_code) codeEl.textContent = ticket.ticket_code;
    },

    // 签到成功后显示电子票
    showTicket(ticketData) {
        this.renderTicket(ticketData);
        this.showPage('page-ticket');
    }
};

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', function() {
    // 初始化页面管理器
    PageManager.init();
    
    // 导航功能已移除
    
    // 首页"立即报名"按钮 - 增强触摸反馈
    const btnRegisterHome = document.getElementById('btnRegisterHome');
    const btnWrapper = btnRegisterHome?.closest('.home-btn-wrapper');
    
    if (btnRegisterHome && btnWrapper) {
        // 触摸开始（移动设备）
        btnRegisterHome.addEventListener('touchstart', function(e) {
            e.preventDefault();
            btnWrapper.classList.add('pressing');
            // 添加轻微震动反馈（如果支持）
            if (navigator.vibrate) {
                navigator.vibrate(10);
            }
        }, { passive: false });
        
        // 触摸结束
        btnRegisterHome.addEventListener('touchend', function(e) {
            e.preventDefault();
            btnWrapper.classList.remove('pressing');
            // 延迟跳转，让用户看到按下效果
            setTimeout(() => {
                PageManager.showPage('page-register-info');
            }, 100);
        }, { passive: false });
        
        // 鼠标按下（桌面设备）
        btnRegisterHome.addEventListener('mousedown', function() {
            btnWrapper.classList.add('pressing');
        });
        
        // 鼠标释放
        btnRegisterHome.addEventListener('mouseup', function() {
            btnWrapper.classList.remove('pressing');
        });
        
        // 鼠标离开按钮区域时移除按下状态
        btnRegisterHome.addEventListener('mouseleave', function() {
            btnWrapper.classList.remove('pressing');
        });
        
        // 点击事件（作为备用）
        btnRegisterHome.addEventListener('click', function(e) {
            // 如果已经通过触摸处理，则阻止默认行为
            if (e.detail === 0) return;
            PageManager.showPage('page-register-info');
        });
    }
    
    // 获取验证码按钮（报名信息页）
    const btnGetCode = document.getElementById('btnGetCode');
    if (btnGetCode) {
        btnGetCode.addEventListener('click', async function() {
            const phone = document.getElementById('registerPhone').value;
            
            // 检查手机号是否更换，如果更换了清除旧的记录
            const lastPhone = localStorage.getItem('lastVerifiedPhone');
            if (lastPhone && lastPhone !== phone) {
                console.log('检测到手机号更换，清除旧记录');
                localStorage.removeItem('lastVerifiedPhone');
                sessionStorage.removeItem('verifiedPhone');
            }
            if (!phone || phone.length !== 11) {
                alert('请输入正确的手机号');
                return;
            }
            
            // 开始倒计时
            let countdown = 60;
            this.disabled = true;
            const originalText = this.textContent;
            
            const timer = setInterval(() => {
                countdown--;
                this.textContent = (window.t ? window.t('h5Register.retryAfterSeconds', [countdown]) : `${countdown}秒后重试`);
                
                if (countdown <= 0) {
                    clearInterval(timer);
                    this.disabled = false;
                    this.textContent = originalText;
                }
            }, 1000);
            
            try {
                // 调用后端验证码发送接口
                const response = await fetch('/api/verification/send-code', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ phone: phone })
                });
                
                const result = await response.json();
                
                if (result.code === 200 || result.code === 0) {
                    // EC9 已移除 debugCode（安全加固：验证码明文绝不下发）。
                    // 联调期短信通道走 mock，真机收不到短信，
                    // 改调 /api/verification/dev-code 取码 —— 该接口仅在
                    // 非生产 + mock 通道下可用，生产/真实通道一律 404。
                    let devTip = '';
                    try {
                        const dv = await fetch('/api/verification/dev-code', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone: phone })
                        }).then(r => r.json());
                        if (dv.code === 0 && dv.data && dv.data.code) {
                            devTip = `\n\n[联调模式] 验证码：${dv.data.code}`;
                            console.log('%c验证码: ' + dv.data.code, 'color: #FF6B6B; font-size: 16px; font-weight: bold;');
                        }
                    } catch (e) { /* 取不到就当真实通道，走正常短信 */ }
                    alert('验证码已发送，请查收短信' + devTip);
                } else {
                    alert(result.message || '发送失败，请稍后重试');
                    // 发送失败，恢复按钮
                    clearInterval(timer);
                    this.disabled = false;
                    this.textContent = originalText;
                }
            } catch (error) {
                console.error('发送验证码失败:', error);
                alert('发送失败，请稍后重试');
                // 发送失败，恢复按钮
                clearInterval(timer);
                this.disabled = false;
                this.textContent = originalText;
            }
        });
    }
    
    // 报名信息页"下一步"按钮
    const btnNext = document.getElementById('btnNext');
    if (btnNext) {
        btnNext.addEventListener('click', async function() {
            const phone = document.getElementById('registerPhone').value;
            const code = document.getElementById('registerCode').value;
            
            if (!phone || phone.length !== 11) {
                alert('请输入正确的手机号');
                return;
            }
            
            if (!code) {
                alert('请输入验证码');
                return;
            }
            
            // 验证验证码（调用后端验证接口）
            try {
                const verifyResponse = await fetch('/api/verification/verify-code', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ phone: phone, code: code })
                });
                
                const verifyResult = await verifyResponse.json();
                
                if (verifyResult.code !== 200 && verifyResult.code !== 0) {
                    alert(verifyResult.message || '验证码错误');
                    return;
                }
                
                // 验证码验证成功，保存手机号到sessionStorage和localStorage
                // sessionStorage用于当前会话，localStorage用于持久化记录
                sessionStorage.setItem('verifiedPhone', phone);
                localStorage.setItem('lastVerifiedPhone', phone);
                console.log('已保存验证手机号到sessionStorage和localStorage:', phone);
                
                // 验证码验证成功，继续验证手机号
            } catch (error) {
                console.error('验证验证码失败:', error);
                alert('验证失败，请稍后重试');
                return;
            }
            
            // 验证手机号是否在系统中
            try {
                // 获取EventID，用于检查该活动下的报名状态
                const eventId = getUrlParam('EventID');
                
                const response = await fetch('/api/invitations/verify-phone', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ 
                        phone: phone,
                        event_id: eventId || null
                    })
                });
                
                const result = await response.json();
                
                // 如果手机号不在系统中（404），也允许继续，但会进入新用户注册流程
                if (result.code === 404) {
                    console.log('手机号不在系统中，将进入新用户注册流程');
                    PageManager.setPhoneInForms(phone);
                    // 获取EventID，判断活动类型
                    if (eventId === '1') {
                        // 深圳活动，跳转到报名信息填写2
                        PageManager.showPage('page-register-form-2');
                    } else if (eventId === '2') {
                        // 深圳+香港活动，跳转到报名信息填写
                        PageManager.showPage('page-register-form');
                    } else {
                        // 默认跳转到报名信息填写
                        PageManager.showPage('page-register-form');
                    }
                    return;
                }
                
                if (result.code !== 200 && result.code !== 0) {
                    alert(result.message || '手机号验证失败，请联系管理员');
                    return;
                }
                
                // 如果后端返回了嘉宾信息，先预填姓名/公司/职务
                if (result.data) {
                    PageManager.prefillGuestInfoFromVerifyResult(result.data);
                }
                
                // 检查是否已报名（如果提供了event_id）
                if (eventId && result.data?.is_registered) {
                    console.log('用户已报名，直接显示结果页面');
                    // 根据审批状态决定显示成功页还是待审核页
                    if (result.data.approval_status === 1) {
                        // 待审核
                        PageManager.showPage('page-pending');
                    } else {
                        // 已报名成功
                        PageManager.showPage('page-success');
                    }
                    return;
                }
                
                // 如果有邀约信息（通过邀约码访问），优先使用邀约的活动ID
                let targetEventId = eventId;
                if (invitationData && invitationData.event_id) {
                    targetEventId = String(invitationData.event_id);
                    console.log('使用邀约信息中的活动ID:', targetEventId);
                }
                
                // 根据活动ID判断显示哪个表单
                // 活动1 -> 报名信息填写2，活动2 -> 报名信息填写
                if (targetEventId === '1') {
                    // 活动1，跳转到报名信息填写2
                    PageManager.setPhoneInForms(phone);
                    PageManager.showPage('page-register-form-2');
                } else if (targetEventId === '2') {
                    // 活动2，跳转到报名信息填写
                    PageManager.setPhoneInForms(phone);
                    PageManager.showPage('page-register-form');
                } else {
                    // 如果没有活动ID，使用原来的逻辑（根据活动列表的location判断）
                    const events = result.data?.events || [];
                    const hasShenzhen = events.some(e => e.location && e.location.includes('深圳'));
                    const hasHongkong = events.some(e => e.location && e.location.includes('香港'));
                    
                    if (hasShenzhen && hasHongkong) {
                        // 绑定了深圳和香港两个活动，跳转到报名信息填写
                        PageManager.setPhoneInForms(phone);
                        PageManager.showPage('page-register-form');
                    } else if (hasHongkong && !hasShenzhen) {
                        // 只有香港，跳转到报名信息填写2
                        PageManager.setPhoneInForms(phone);
                        PageManager.showPage('page-register-form-2');
                    } else {
                        // 其他情况，默认跳转到报名信息填写
                        PageManager.setPhoneInForms(phone);
                        PageManager.showPage('page-register-form');
                    }
                }
            } catch (error) {
                console.error('验证手机号失败:', error);
                alert('验证失败，请稍后重试');
            }
        });
    }
    
    // 获取验证码按钮（签到信息页）
    const btnGetCodeCheckin = document.getElementById('btnGetCodeCheckin');
    if (btnGetCodeCheckin) {
        btnGetCodeCheckin.addEventListener('click', async function() {
            const phone = document.getElementById('checkinPhone').value;
            if (!phone || phone.length !== 11) {
                alert('请输入正确的手机号');
                return;
            }
            
            // 开始倒计时
            let countdown = 60;
            this.disabled = true;
            const originalText = this.textContent;
            
            const timer = setInterval(() => {
                countdown--;
                this.textContent = (window.t ? window.t('h5Register.retryAfterSeconds', [countdown]) : `${countdown}秒后重试`);
                
                if (countdown <= 0) {
                    clearInterval(timer);
                    this.disabled = false;
                    this.textContent = originalText;
                }
            }, 1000);
            
            try {
                // 调用后端验证码发送接口
                const response = await fetch('/api/verification/send-code', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ phone: phone })
                });
                
                const result = await response.json();
                
                if (result.code === 200 || result.code === 0) {
                    // 同上：debugCode 已被 EC9 移除，联调改走 /api/verification/dev-code
                    let devTip = '';
                    try {
                        const dv = await fetch('/api/verification/dev-code', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone: phone })
                        }).then(r => r.json());
                        if (dv.code === 0 && dv.data && dv.data.code) {
                            devTip = `\n\n[联调模式] 验证码：${dv.data.code}`;
                            console.log('%c验证码: ' + dv.data.code, 'color: #FF6B6B; font-size: 16px; font-weight: bold;');
                        }
                    } catch (e) { /* 取不到就当真实通道，走正常短信 */ }
                    alert(`验证码已发送，请查收短信${devTip}`);
                } else {
                    alert(result.message || '发送失败，请稍后重试');
                    // 发送失败，恢复按钮
                    clearInterval(timer);
                    this.disabled = false;
                    this.textContent = originalText;
                }
            } catch (error) {
                console.error('发送验证码失败:', error);
                alert('发送失败，请稍后重试');
                // 发送失败，恢复按钮
                clearInterval(timer);
                this.disabled = false;
                this.textContent = originalText;
            }
        });
    }
    
    // 签到信息页"下一步"按钮
    const btnCheckin = document.getElementById('btnCheckin');
    if (btnCheckin) {
        btnCheckin.addEventListener('click', async function() {
            const phone = document.getElementById('checkinPhone').value;
            const code = document.getElementById('checkinCode').value;
            const eventId = getUrlParam('EventID');
            
            if (!phone || phone.length !== 11) {
                alert('请输入正确的手机号');
                return;
            }
            
            if (!code) {
                alert('请输入验证码');
                return;
            }
            if (!eventId) {
                alert('缺少活动ID，无法签到');
                return;
            }
            
            try {
                // 先验证验证码
                const verifyResp = await fetch('/api/verification/verify-code', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone, code })
                });
                const verifyResult = await verifyResp.json();
                if (verifyResult.code !== 200 && verifyResult.code !== 0) {
                    alert(verifyResult.message || '验证码错误');
                    return;
                }
                
                // 调用签到接口
                const checkinResp = await fetch('/api/checkins/event-checkin', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        phone,
                        event_id: parseInt(eventId, 10)
                    })
                });
                const checkinResult = await checkinResp.json();
                if (checkinResult.code !== 200 && checkinResult.code !== 0) {
                    alert(checkinResult.message || '签到失败');
                    return;
                }
                
                // 签到成功或已签到，展示电子票
                PageManager.showTicket(checkinResult.data);
            } catch (error) {
                console.error('签到失败:', error);
                alert('签到失败，请稍后重试');
            }
        });
    }
    
    // 信息填写页"下一步"按钮
    const btnSubmitForm = document.getElementById('btnSubmitForm');
    if (btnSubmitForm) {
        btnSubmitForm.addEventListener('click', async function() {
            const name = document.getElementById('guestName').value.trim();
            const phone = document.getElementById('guestPhone').value.trim();
            const company = document.getElementById('guestCompany').value.trim();
            const position = document.getElementById('guestPosition').value.trim();
            const inviter = document.getElementById('inviter').value.trim();
            
            // 验证必填字段
            if (!name) {
                alert('请输入姓名');
                return;
            }
            
            if (!phone || phone.length !== 11 || !/^1[3-9]\d{9}$/.test(phone)) {
                alert('请输入正确的手机号');
                return;
            }
            
            if (!company) {
                alert('请输入公司名称');
                return;
            }
            
            if (!position) {
                alert('请输入职务');
                return;
            }

            if (!inviter) {
                alert('请输入邀请人');
                return;
            }

            if (!inviter) {
                alert('请输入邀请人');
                return;
            }
            
            // 获取住宿选择
            const hotel1 = document.querySelector('input[name="hotel1"]:checked');
            const hotel2 = document.querySelector('input[name="hotel2"]:checked');
            const hotel_12_29 = hotel1 ? hotel1.value : 'no';
            const hotel_12_30 = hotel2 ? hotel2.value : 'no';
            
            // 获取邀请码和EventID
            const code = getUrlParam('code');
            const eventId = getUrlParam('EventID');
            
            // 禁用按钮，防止重复提交
            this.disabled = true;
            const originalText = this.textContent;
            this.textContent = '提交中...';
            
            try {
                // 如果有邀请码，使用原有接口；否则使用新接口（通过手机号注册）
                const apiUrl = code ? '/api/registrations/submit' : '/api/registrations/submit-by-phone';
                const requestBody = code ? {
                    invite_code: code,
                    name: name,
                    company: company,
                    position: position,
                    hotel_12_29: hotel_12_29,
                    hotel_12_30: hotel_12_30
                } : {
                    phone: phone,
                    name: name,
                    company: company,
                    position: position,
                    inviter: inviter,
                    event_id: eventId ? parseInt(eventId) : null,
                    hotel_12_29: hotel_12_29,
                    hotel_12_30: hotel_12_30
                };
                
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestBody)
                });
                
                const result = await response.json();
                
                if (result.code === 200 || result.code === 0) {
                    // 根据返回的状态决定跳转页面
                    if (result.data.needApproval) {
                        // 需要审批，跳转到待审核页
                        PageManager.showPage('page-pending');
                    } else {
                        // 直接成功，跳转到成功页
                        PageManager.showPage('page-success');
                    }
                } else {
                    alert(result.message || '提交失败，请稍后重试');
                    // 恢复按钮
                    this.disabled = false;
                    this.textContent = originalText;
                }
            } catch (error) {
                console.error('提交报名失败:', error);
                alert('提交失败，请稍后重试');
                // 恢复按钮
                this.disabled = false;
                this.textContent = originalText;
            }
        });
    }
    
    // 信息填写页2"下一步"按钮（仅香港活动）
    const btnSubmitForm2 = document.getElementById('btnSubmitForm2');
    if (btnSubmitForm2) {
        btnSubmitForm2.addEventListener('click', async function() {
            const name = document.getElementById('guestName2').value.trim();
            const phone = document.getElementById('guestPhone2').value.trim();
            const company = document.getElementById('guestCompany2').value.trim();
            const position = document.getElementById('guestPosition2').value.trim();
            const inviter = document.getElementById('inviter2').value.trim();
            
            // 验证必填字段
            if (!name) {
                alert('请输入姓名');
                return;
            }
            
            if (!phone || phone.length !== 11 || !/^1[3-9]\d{9}$/.test(phone)) {
                alert('请输入正确的手机号');
                return;
            }
            
            if (!company) {
                alert('请输入公司名称');
                return;
            }
            
            if (!position) {
                alert('请输入职务');
                return;
            }
            
            // 获取住宿选择（仅12月30日）
            const hotel2 = document.querySelector('input[name="hotel2-2"]:checked');
            const hotel_12_30 = hotel2 ? hotel2.value : 'no';
            const hotel_12_29 = 'no'; // 香港活动不需要12月29日住宿
            
            // 获取邀请码和EventID
            const code = getUrlParam('code');
            const eventId = getUrlParam('EventID');
            
            // 禁用按钮，防止重复提交
            this.disabled = true;
            const originalText = this.textContent;
            this.textContent = '提交中...';
            
            try {
                // 如果有邀请码，使用原有接口；否则使用新接口（通过手机号注册）
                const apiUrl = code ? '/api/registrations/submit' : '/api/registrations/submit-by-phone';
                const requestBody = code ? {
                    invite_code: code,
                    name: name,
                    company: company,
                    position: position,
                    hotel_12_29: hotel_12_29,
                    hotel_12_30: hotel_12_30
                } : {
                    phone: phone,
                    name: name,
                    company: company,
                    position: position,
                    inviter: inviter,
                    event_id: eventId ? parseInt(eventId) : null,
                    hotel_12_29: hotel_12_29,
                    hotel_12_30: hotel_12_30
                };
                
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestBody)
                });
                
                const result = await response.json();
                
                if (result.code === 200 || result.code === 0) {
                    // 根据返回的状态决定跳转页面
                    if (result.data.needApproval) {
                        // 需要审批，跳转到待审核页
                        PageManager.showPage('page-pending');
                    } else {
                        // 直接成功，跳转到成功页
                        PageManager.showPage('page-success');
                    }
                } else {
                    alert(result.message || '提交失败，请稍后重试');
                    // 恢复按钮
                    this.disabled = false;
                    this.textContent = originalText;
                }
            } catch (error) {
                console.error('提交报名失败:', error);
                alert('提交失败，请稍后重试');
                // 恢复按钮
                this.disabled = false;
                this.textContent = originalText;
            }
        });
    }
    
    // 复选框单选逻辑
    const checkboxGroups = document.querySelectorAll('.checkbox-group');
    checkboxGroups.forEach(group => {
        const checkboxes = group.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(checkbox => {
            checkbox.addEventListener('change', function() {
                if (this.checked) {
                    checkboxes.forEach(cb => {
                        if (cb !== this) cb.checked = false;
                    });
                }
            });
        });
    });
    
    // 强制保持页面可见性
    setInterval(() => {
        const pages = document.querySelectorAll('.page');
        pages.forEach(page => {
            if (page.id === PageManager.currentPage) {
                if (page.style.display !== 'block') {
                    page.style.display = 'block';
                }
            } else {
                if (page.style.display !== 'none') {
                    page.style.display = 'none';
                }
            }
        });
    }, 100);
});
