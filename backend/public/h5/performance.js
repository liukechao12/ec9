/**
 * 2025业绩说明会 - 独立H5报名页面
 * 可无邀请码；手机验证(模板21)；审批通过后发短信(模板22)
 * 收集：姓名、联系电话、单位名称、职位
 */
(function () {
    'use strict';

    const VERIFY_SMS_TEMPLATE_ID = 21;

    function getUrlParam(name) {
        const params = new URLSearchParams(window.location.search);
        return params.get(name);
    }

    function showPage(pageId) {
        document.querySelectorAll('.perf-page').forEach(function (el) {
            el.classList.remove('active');
        });
        const page = document.getElementById(pageId);
        if (page) page.classList.add('active');
    }

    // 有邀请码时加载邀约信息，并决定展示成功/待审核/验证页
    async function loadInvitation() {
        const code = getUrlParam('code');
        if (!code) return;
        try {
            const res = await fetch('/api/invitations/code/' + code);
            const data = await res.json();
            if ((data.code === 200 || data.code === 0) && data.data) {
                const inv = data.data;
                if (inv.registration_status === 2) {
                    showPage('page-success');
                    return;
                }
                if (inv.registration_status === 1) {
                    showPage('page-pending');
                    return;
                }
                if (inv.guest) {
                    const g = inv.guest;
                    document.getElementById('inputName').value = g.name || '';
                    document.getElementById('inputPhoneForm').value = g.phone_decrypted || '';
                    document.getElementById('inputPhoneVerify').value = g.phone_decrypted || '';
                    document.getElementById('inputCompany').value = g.company || '';
                    document.getElementById('inputPosition').value = g.position || '';
                }
            }
        } catch (e) {}
    }

    // 立即报名：直接进入验证页（有无邀请码均可）
    document.getElementById('btnRegister').addEventListener('click', function () {
        showPage('page-verify');
    });

    // 获取验证码（使用模板 21）
    (function () {
        const btn = document.getElementById('btnGetCode');
        const inputPhone = document.getElementById('inputPhoneVerify');
        const errEl = document.getElementById('verifyError');
        let countdown = 0;
        let timer = null;

        function setBtnState(disabled, text) {
            btn.disabled = disabled;
            btn.textContent = text;
        }

        btn.addEventListener('click', async function () {
            const phone = (inputPhone && inputPhone.value) ? inputPhone.value.trim() : '';
            if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
                if (errEl) {
                    errEl.textContent = '请输入正确的11位手机号';
                    errEl.style.display = 'block';
                }
                return;
            }
            if (errEl) errEl.style.display = 'none';
            setBtnState(true, '发送中...');
            try {
                const res = await fetch('/api/verification/send-code', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone: phone, template_id: VERIFY_SMS_TEMPLATE_ID })
                });
                const data = await res.json();
                if (data.code === 200 || data.code === 0) {
                    countdown = 60;
                    timer = setInterval(function () {
                        countdown--;
                        if (countdown <= 0) {
                            clearInterval(timer);
                            setBtnState(false, '获取验证码');
                            return;
                        }
                        setBtnState(true, countdown + 's 后重发');
                    }, 1000);
                } else {
                    if (errEl) {
                        errEl.textContent = data.message || '发送失败，请稍后重试';
                        errEl.style.display = 'block';
                    }
                    setBtnState(false, '获取验证码');
                }
            } catch (e) {
                if (errEl) {
                    errEl.textContent = '发送失败，请稍后重试';
                    errEl.style.display = 'block';
                }
                setBtnState(false, '获取验证码');
            }
        });
    })();

    // 验证验证码通过后进入表单页，并锁定手机号
    document.getElementById('btnVerify').addEventListener('click', async function () {
        const phone = document.getElementById('inputPhoneVerify').value.trim();
        const code = document.getElementById('inputCode').value.trim();
        const errEl = document.getElementById('verifyError');
        if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
            errEl.textContent = '请输入正确的11位手机号';
            errEl.style.display = 'block';
            return;
        }
        if (!code || code.length !== 6) {
            errEl.textContent = '请输入6位验证码';
            errEl.style.display = 'block';
            return;
        }
        errEl.style.display = 'none';
        const btn = this;
        btn.disabled = true;
        btn.textContent = '验证中...';
        try {
            const res = await fetch('/api/verification/verify-code', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: phone, code: code })
            });
            const data = await res.json();
            if (data.code === 200 || data.code === 0) {
                document.getElementById('inputPhoneForm').value = phone;
                document.getElementById('inputPhoneForm').setAttribute('readonly', 'readonly');
                showPage('page-form');
            } else {
                errEl.textContent = data.message || '验证码错误';
                errEl.style.display = 'block';
            }
        } catch (e) {
            errEl.textContent = '验证失败，请稍后重试';
            errEl.style.display = 'block';
        } finally {
            btn.disabled = false;
            btn.textContent = '下一步';
        }
    });

    // 提交报名：有邀请码走 /submit，无邀请码走 /submit-performance（均需审批，通过后发 22 号短信）
    document.getElementById('btnSubmit').addEventListener('click', async function () {
        const code = getUrlParam('code');
        const name = document.getElementById('inputName').value.trim();
        const phone = document.getElementById('inputPhoneForm').value.trim();
        const company = document.getElementById('inputCompany').value.trim();
        const position = document.getElementById('inputPosition').value.trim();
        const errEl = document.getElementById('formError');

        if (!name) {
            errEl.textContent = '请输入姓名';
            errEl.style.display = 'block';
            return;
        }
        if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
            errEl.textContent = '请输入正确的11位手机号';
            errEl.style.display = 'block';
            return;
        }
        if (!company) {
            errEl.textContent = '请输入单位名称';
            errEl.style.display = 'block';
            return;
        }
        if (!position) {
            errEl.textContent = '请输入职位';
            errEl.style.display = 'block';
            return;
        }
        errEl.style.display = 'none';

        const btn = this;
        btn.disabled = true;
        btn.textContent = '提交中...';
        try {
            let res;
            if (code) {
                res = await fetch('/api/registrations/submit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        invite_code: code,
                        name: name,
                        company: company,
                        position: position,
                        hotel_12_29: 'no',
                        hotel_12_30: 'no'
                    })
                });
            } else {
                res = await fetch('/api/registrations/submit-performance', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone, name, company, position })
                });
            }
            const data = await res.json();
            if (data.code === 200 || data.code === 0) {
                if (data.data && data.data.needApproval) {
                    showPage('page-pending');
                } else {
                    showPage('page-success');
                }
            } else {
                errEl.textContent = data.message || '提交失败，请稍后重试';
                errEl.style.display = 'block';
            }
        } catch (e) {
            errEl.textContent = '提交失败，请稍后重试';
            errEl.style.display = 'block';
        } finally {
            btn.disabled = false;
            btn.textContent = '提交报名';
        }
    });

    document.addEventListener('DOMContentLoaded', loadInvitation);
})();
