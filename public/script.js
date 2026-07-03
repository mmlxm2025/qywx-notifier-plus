// 企业微信通知配置前端交互脚本

document.addEventListener('DOMContentLoaded', function () {
    const token = new URLSearchParams(window.location.search).get('token') || localStorage.getItem('authToken');
    if (!token) {
        window.location.href = '/login';
        return;
    }
    localStorage.setItem('authToken', token);

    async function checkAuth() {
        try {
            const res = await fetch('/api/auth-status', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            const data = await res.json();
            if (!data.loggedIn) {
                window.location.href = '/login';
                return false;
            }
            return true;
        } catch (err) {
            window.location.href = '/login';
            return false;
        }
    }

    checkAuth().then(isAuth => {
        if (!isAuth) return;
        initApp();
    });

    function getAuthHeaders() {
        const token = localStorage.getItem('authToken');
        return {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        };
    }

    function initApp() {
        lucide.createIcons();
    }

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            const token = localStorage.getItem('authToken');
            await fetch('/api/logout', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token }
            });
            localStorage.removeItem('authToken');
            window.location.href = '/login';
        });
    }
    // 元素引用
    const callbackForm = document.getElementById('callbackForm');
    const configForm = document.getElementById('configForm');
    const validateBtn = document.getElementById('validateBtn');
    const userListSection = document.getElementById('userListSection');
    const userList = document.getElementById('userList');
    const lookupForm = document.getElementById('lookupForm');
    const lookupResultDiv = document.getElementById('lookup-result');
    const resultDiv = document.getElementById('result');
    const saveAlert = document.getElementById('save-alert');
    const step1Container = document.getElementById('step1-container');
    const step2Container = document.getElementById('step2-container');
    const callbackResult = document.getElementById('callbackResult');

    let usersCache = [];
    let currentCode = null; // 存储当前的code
    let editUsersCache = [];
    let editCurrent = [];
    let editOrphan = [];
    let editCode = null;
    let editSelectedUserids = new Set();
    let editSelectedOrphans = new Set();

    // 第一步：生成回调URL
    callbackForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        resultDiv.innerHTML = '';

        const corpid = callbackForm.corpid.value.trim();
        const callbackToken = callbackForm.callback_token.value.trim();
        const encodingAesKey = callbackForm.encoding_aes_key.value.trim();

        if (!corpid || !callbackToken || !encodingAesKey) {
            showError('请填写所有必填项');
            return;
        }
        if (encodingAesKey.length !== 43) {
            showError('EncodingAESKey必须是43位字符');
            return;
        }

        const submitBtn = callbackForm.querySelector('button[type=submit]');
        submitBtn.disabled = true;
        submitBtn.textContent = '生成中...';

        try {
            const res = await fetch('/api/generate-callback', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({
                    corpid,
                    callback_token: callbackToken,
                    encoding_aes_key: encodingAesKey
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '生成失败');

            currentCode = data.code;
            showCallbackResult(data);

            // 显示第二步
            step2Container.classList.remove('hidden');
            gsap.from(step2Container, { opacity: 0, y: 20, duration: 0.5 });

            // 将CorpID传递到第二步
            configForm.corpid = { value: corpid };

        } catch (err) {
            showError('生成回调URL失败: ' + err.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = '生成回调URL';
        }
    });

    // 验证并获取成员列表
    validateBtn.addEventListener('click', async function (e) {
        e.preventDefault();
        resultDiv.innerHTML = '';
        userList.innerHTML = '';
        userListSection.classList.add('hidden');

        const corpid = callbackForm.corpid.value.trim(); // 从第一步获取
        const corpsecret = configForm.corpsecret.value.trim();
        const agentid = configForm.agentid.value.trim();
        if (!corpid || !corpsecret || !agentid) {
            showError('请填写CorpSecret和AgentID');
            return;
        }
        validateBtn.disabled = true;
        validateBtn.textContent = '验证中...';
        try {
            const res = await fetch('/api/validate', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({ corpid, corpsecret, agentid: Number(agentid) })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '验证失败');
            usersCache = data.users || [];
            if (usersCache.length === 0) {
                showError('未获取到任何成员，请检查该应用的可见范围是否包含成员、部门或标签');
                return;
            }
            userList.innerHTML = usersCache.map(user =>
                `<label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" class="checkbox checkbox-sm" value="${escapeHtml(user.userid)}">
                    <span>${escapeHtml(user.name || user.userid)} <span class="text-xs text-gray-400">(${escapeHtml(user.userid)})</span></span>
                </label>`
            ).join('');
            userListSection.classList.remove('hidden');
            gsap.from(userListSection, { opacity: 0, y: 20, duration: 0.5 });
        } catch (err) {
            showError(err.message);
        } finally {
            validateBtn.disabled = false;
            validateBtn.textContent = '验证并获取成员列表';
        }
    });

    // 查找配置
    lookupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = lookupForm.code.value.trim();
        if (!code) return;

        lookupResultDiv.innerHTML = '<div class="loading loading-spinner loading-md mx-auto"></div>';

        try {
            const res = await fetch(`/api/configuration/${code}`, {
                headers: getAuthHeaders()
            });
            const data = await res.json();

            if (!res.ok) throw new Error(data.error || '查找配置失败');

            showLookupConfiguration(data);

        } catch (err) {
            lookupResultDiv.innerHTML = `
                <div class="alert alert-error">
                    <i data-lucide="alert-circle" class="h-5 w-5"></i>
                    <span>${escapeHtml(err.message)}</span>
                </div>
            `;
            lucide.createIcons();
        }
    });

    // 第二步：完善配置
    configForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        resultDiv.innerHTML = '';

        if (!currentCode) {
            showError('请先完成第一步生成回调URL');
            return;
        }

        const corpsecret = configForm.corpsecret.value.trim();
        const agentid = configForm.agentid.value.trim();
        const description = configForm.description.value.trim();
        const checked = userListSection.classList.contains('hidden')
            ? []
            : Array.from(userList.querySelectorAll('input[type=checkbox]:checked')).map(cb => cb.value);
        if (!corpsecret || !agentid || checked.length === 0) {
            showError('请填写所有必填项并选择至少一个成员');
            return;
        }

        const payload = {
            code: currentCode,
            corpsecret,
            agentid: Number(agentid),
            touser: checked,
            description
        };
        configForm.querySelector('button[type=submit]').disabled = true;
        configForm.querySelector('button[type=submit]').textContent = '完成中...';
        try {
            const res = await fetch('/api/complete-config', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '完成失败');
            showFinalResult(data);

            // 显示一次性保存提醒
            saveAlert.classList.remove('hidden');
            gsap.from(saveAlert, { opacity: 0, y: -50, duration: 0.5 });
            setTimeout(() => {
                gsap.to(saveAlert, { opacity: 0, y: -50, duration: 0.5, onComplete: () => {
                    saveAlert.classList.add('hidden');
                    saveAlert.style.opacity = 1;
                    saveAlert.style.transform = 'none';
                }});
            }, 5000);
        } catch (err) {
            showError(err.message);
        } finally {
            configForm.querySelector('button[type=submit]').disabled = false;
            configForm.querySelector('button[type=submit]').textContent = '完成配置';
        }
    });

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function normalizeTouser(value) {
        const list = Array.isArray(value) ? value : String(value || '').split('|');
        return list.map(item => String(item).trim()).filter(Boolean);
    }

    function getUserDisplayName(user) {
        return user.displayName || user.name || user.userid || '';
    }

    function resetEditState() {
        const section = document.getElementById('edit-section');
        if (section) section.remove();
        editUsersCache = [];
        editCurrent = [];
        editOrphan = [];
        editCode = null;
        editSelectedUserids = new Set();
        editSelectedOrphans = new Set();
    }

    function isCompletedConfig(data) {
        return Number(data.agentid) !== 0 && normalizeTouser(data.touser).length > 0;
    }

    function showLookupConfiguration(data) {
        resetEditState();

        const apiUrl = `/api/notify/${data.code}`;
        const safeCode = escapeHtml(data.code);
        const safeApiUrl = escapeHtml(apiUrl);
        const touser = normalizeTouser(data.touser);
        const touserText = touser.length ? touser.map(userid => escapeHtml(userid)).join(', ') : '无';
        const description = data.description ? escapeHtml(data.description) : '无';
        const createdAt = data.created_at ? new Date(data.created_at).toLocaleString() : '未知';

        lookupResultDiv.innerHTML = `
            <div class="card bg-base-100 shadow-md" id="lookup-detail-card">
                <div class="card-body">
                    <h2 class="card-title flex items-center gap-2">
                        <i data-lucide="settings" class="h-5 w-5"></i>
                        配置详情
                    </h2>
                    <div class="space-y-2 mt-2">
                        <p><span class="font-medium">CorpID:</span> ${escapeHtml(data.corpid)}</p>
                        <p><span class="font-medium">AgentID:</span> ${escapeHtml(data.agentid)}</p>
                        <p><span class="font-medium">接收用户:</span> ${touserText}</p>
                        <p><span class="font-medium">描述:</span> ${description}</p>
                        <p><span class="font-medium">回调状态:</span> ${data.callback_enabled ? '已启用' : '未启用'}</p>
                        ${data.callback_enabled ? `<p><span class="font-medium">回调Token:</span> ${escapeHtml(data.callback_token || '未设置')}</p>` : ''}
                        <p><span class="font-medium">创建时间:</span> ${escapeHtml(createdAt)}</p>
                    </div>
                    <div class="card-actions justify-end mt-4">
                        <a class="btn btn-secondary btn-sm" href="/rules?code=${safeCode}">
                            <i data-lucide="route" class="h-4 w-4"></i>
                            接收规则
                        </a>
                        <button class="btn btn-primary btn-sm" id="edit-config-btn" data-code="${safeCode}">
                            <i data-lucide="edit" class="h-4 w-4"></i>
                            编辑配置
                        </button>
                        <button class="btn btn-outline btn-sm" id="copy-api-btn" data-code="${safeCode}">
                            <i data-lucide="copy" class="h-4 w-4"></i>
                            复制API地址
                        </button>
                    </div>

                    <div class="divider">API使用说明</div>

                    <div class="space-y-4">
                        <div>
                            <h3 class="font-medium mb-2">请求方式</h3>
                            <div class="bg-base-200 p-3 rounded-md">
                                <code class="text-sm">POST ${safeApiUrl}</code>
                            </div>
                        </div>

                        <div>
                            <h3 class="font-medium mb-2">请求头</h3>
                            <div class="bg-base-200 p-3 rounded-md">
                                <code class="text-sm">Content-Type: application/json</code>
                            </div>
                        </div>

                        <div>
                            <h3 class="font-medium mb-2">请求参数</h3>
                            <div class="overflow-x-auto">
                                <table class="table table-zebra w-full">
                                    <thead>
                                        <tr>
                                            <th>参数名</th>
                                            <th>类型</th>
                                            <th>必填</th>
                                            <th>说明</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr>
                                            <td class="font-mono">title</td>
                                            <td>String</td>
                                            <td>否</td>
                                            <td>消息标题，可选</td>
                                        </tr>
                                        <tr>
                                            <td class="font-mono">content</td>
                                            <td>String</td>
                                            <td>是</td>
                                            <td>消息内容，必填</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        <div>
                            <h3 class="font-medium mb-2">请求示例</h3>
                            <div class="bg-base-200 p-3 rounded-md">
<pre class="text-sm whitespace-pre-wrap">curl -X POST "${safeApiUrl}" \\
-H "Content-Type: application/json" \\
-d '{
  "title": "服务器告警",
  "content": "CPU使用率超过90%，请及时处理！"
}'</pre>
                            </div>
                        </div>

                        <div>
                            <h3 class="font-medium mb-2">返回示例</h3>
                            <div class="bg-base-200 p-3 rounded-md">
<pre class="text-sm whitespace-pre-wrap">{
  "message": "发送成功",
  "response": {
    "errcode": 0,
    "errmsg": "ok",
    "msgid": "MSGID1234567890"
  }
}</pre>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        lucide.createIcons();
        gsap.from(lookupResultDiv.firstElementChild, { opacity: 0, y: 20, duration: 0.5 });

        document.getElementById('edit-config-btn').addEventListener('click', (event) => {
            toggleEditSection(data, event.currentTarget);
        });

        document.getElementById('copy-api-btn').addEventListener('click', () => {
            navigator.clipboard.writeText(`/api/notify/${data.code}`);
            showToast('API地址已复制到剪贴板');
        });
    }

    async function toggleEditSection(config, button) {
        const existingSection = document.getElementById('edit-section');
        if (existingSection) {
            resetEditState();
            return;
        }

        if (!isCompletedConfig(config)) {
            showToast('该配置尚未完成第二步，暂不能编辑发送人员');
            return;
        }

        const code = config.code;
        const originalHtml = button.innerHTML;
        button.disabled = true;
        button.innerHTML = '<span class="loading loading-spinner loading-xs"></span> 加载中';

        try {
            const res = await fetch(`/api/configuration/${code}/users`, {
                headers: getAuthHeaders()
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '获取成员列表失败');

            editUsersCache = Array.isArray(data.users) ? data.users.filter(user => user && user.userid) : [];
            editCurrent = normalizeTouser(data.current);
            editOrphan = normalizeTouser(data.orphan);
            editCode = code;
            if (data.warning) {
                showToast(data.warning);
            }

            const visibleUserids = new Set(editUsersCache.map(user => String(user.userid)));
            editSelectedUserids = new Set(editCurrent.filter(userid => visibleUserids.has(userid)));
            editSelectedOrphans = new Set(editOrphan);

            renderEditSection();
        } catch (err) {
            showToast(err.message || '获取成员列表失败');
        } finally {
            button.disabled = false;
            button.innerHTML = originalHtml;
            lucide.createIcons();
        }
    }

    function renderEditSection() {
        const detailCard = document.getElementById('lookup-detail-card');
        if (!detailCard) return;

        const bothEmpty = editUsersCache.length === 0 && editOrphan.length === 0;
        const orphanHtml = editOrphan.map(userid => `
            <label class="badge badge-warning gap-2 p-3 h-auto">
                <input type="checkbox" class="checkbox checkbox-xs edit-orphan-checkbox" value="${escapeHtml(userid)}" checked>
                <span class="font-mono text-xs">${escapeHtml(userid)}</span>
            </label>
        `).join('');

        detailCard.insertAdjacentHTML('afterend', `
            <div id="edit-section" class="card bg-base-100 shadow-md mt-4">
                <div class="card-body">
                    <h2 class="card-title flex items-center gap-2">
                        <i data-lucide="user-cog" class="h-5 w-5"></i>
                        修改发送人员
                    </h2>

                    <div id="edit-error" class="hidden alert alert-error text-sm"></div>

                    <div class="form-control">
                        <input id="edit-user-filter" class="input input-bordered input-sm" placeholder="按姓名或 UserID 筛选">
                    </div>

                    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <span id="edit-selected-count" class="text-sm text-base-content/70">已选 0 人</span>
                        <div class="flex flex-wrap gap-2">
                            <button id="edit-select-all" class="btn btn-xs btn-ghost" type="button">全选当前列表</button>
                            <button id="edit-clear-all" class="btn btn-xs btn-ghost" type="button">取消全选</button>
                        </div>
                    </div>

                    <div id="edit-user-list" class="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-60 overflow-y-auto bg-base-100 rounded-lg p-2 border border-base-200"></div>

                    <div id="edit-orphan-section" class="${editOrphan.length ? '' : 'hidden'} mt-2">
                        <div class="text-xs text-warning mb-2">
                            以下 UserID 当前不可见，可能已离职或不在应用可见范围内。保留勾选会继续保存到配置中。
                        </div>
                        <div id="edit-orphan-list" class="flex flex-wrap gap-2">${orphanHtml}</div>
                    </div>

                    ${bothEmpty ? `
                    <div class="alert alert-warning text-sm">
                        <i data-lucide="alert-triangle" class="h-5 w-5"></i>
                        <span>未获取到任何成员，请检查应用可见范围与通讯录权限</span>
                    </div>
                    ` : ''}

                    <div class="card-actions justify-end mt-2">
                        <button id="edit-cancel" class="btn btn-ghost btn-sm" type="button">取消</button>
                        <button id="edit-save" class="btn btn-primary btn-sm" type="button" ${bothEmpty ? 'disabled' : ''}>
                            <i data-lucide="save" class="h-4 w-4"></i>
                            保存修改
                        </button>
                    </div>
                </div>
            </div>
        `);

        bindEditSectionEvents();
        renderEditUserList('');
        updateEditSelectedCount();
        lucide.createIcons();
        gsap.from(document.getElementById('edit-section'), { opacity: 0, y: 20, duration: 0.4 });
    }

    function bindEditSectionEvents() {
        const filterInput = document.getElementById('edit-user-filter');
        const selectAllBtn = document.getElementById('edit-select-all');
        const clearAllBtn = document.getElementById('edit-clear-all');
        const cancelBtn = document.getElementById('edit-cancel');
        const saveBtn = document.getElementById('edit-save');

        filterInput.addEventListener('input', () => {
            syncRenderedSelections();
            renderEditUserList(filterInput.value);
            updateEditSelectedCount();
        });

        selectAllBtn.addEventListener('click', () => {
            getFilteredEditUsers(filterInput.value).forEach(user => editSelectedUserids.add(String(user.userid)));
            renderEditUserList(filterInput.value);
            updateEditSelectedCount();
        });

        clearAllBtn.addEventListener('click', () => {
            editSelectedUserids = new Set();
            renderEditUserList(filterInput.value);
            updateEditSelectedCount();
        });

        document.getElementById('edit-orphan-list').addEventListener('change', (event) => {
            if (!event.target.classList.contains('edit-orphan-checkbox')) return;
            if (event.target.checked) {
                editSelectedOrphans.add(event.target.value);
            } else {
                editSelectedOrphans.delete(event.target.value);
            }
            updateEditSelectedCount();
        });

        cancelBtn.addEventListener('click', resetEditState);
        saveBtn.addEventListener('click', saveEditedTouser);
    }

    function getFilteredEditUsers(filterValue) {
        const keyword = String(filterValue || '').trim().toLowerCase();
        return editUsersCache.filter(user => {
            const displayName = getUserDisplayName(user).toLowerCase();
            const userid = String(user.userid || '').toLowerCase();
            return !keyword || displayName.includes(keyword) || userid.includes(keyword);
        });
    }

    function renderEditUserList(filterValue) {
        const list = document.getElementById('edit-user-list');
        if (!list) return;

        const users = getFilteredEditUsers(filterValue);
        if (users.length === 0) {
            list.innerHTML = `
                <div class="md:col-span-2 text-sm text-base-content/60 py-4 text-center">
                    ${editUsersCache.length === 0 ? '当前没有可见成员' : '没有匹配的成员'}
                </div>
            `;
            return;
        }

        list.innerHTML = users.map(user => {
            const userid = String(user.userid);
            const checked = editSelectedUserids.has(userid) ? 'checked' : '';
            return `
                <label class="flex items-center gap-3 cursor-pointer rounded-md border border-base-200 p-2 hover:bg-base-200/60">
                    <input type="checkbox" class="checkbox checkbox-sm edit-user-checkbox" value="${escapeHtml(user.userid)}" ${checked}>
                    <span class="min-w-0">
                        <span class="block truncate">${escapeHtml(getUserDisplayName(user))}</span>
                        <span class="block truncate text-xs text-base-content/50 font-mono">${escapeHtml(user.userid)}</span>
                    </span>
                </label>
            `;
        }).join('');

        list.querySelectorAll('.edit-user-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    editSelectedUserids.add(checkbox.value);
                } else {
                    editSelectedUserids.delete(checkbox.value);
                }
                updateEditSelectedCount();
            });
        });
    }

    function syncRenderedSelections() {
        document.querySelectorAll('.edit-user-checkbox:checked').forEach(checkbox => {
            editSelectedUserids.add(checkbox.value);
        });
        document.querySelectorAll('.edit-user-checkbox:not(:checked)').forEach(checkbox => {
            editSelectedUserids.delete(checkbox.value);
        });
        editSelectedOrphans = new Set(Array.from(document.querySelectorAll('.edit-orphan-checkbox:checked')).map(checkbox => checkbox.value));
    }

    function updateEditSelectedCount() {
        const countNode = document.getElementById('edit-selected-count');
        if (!countNode) return;
        const selected = new Set([...editSelectedUserids, ...editSelectedOrphans]);
        countNode.textContent = `已选 ${selected.size} 人`;
    }

    function showEditError(message) {
        const errorNode = document.getElementById('edit-error');
        if (!errorNode) return;
        errorNode.classList.remove('hidden');
        errorNode.innerHTML = `<span>${escapeHtml(message)}</span>`;
    }

    async function refreshLookupConfiguration(code) {
        const res = await fetch(`/api/configuration/${code}`, {
            headers: getAuthHeaders()
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '刷新配置详情失败');
        showLookupConfiguration(data);
    }

    async function saveEditedTouser() {
        syncRenderedSelections();
        const finalTouser = [...new Set([...editSelectedUserids, ...editSelectedOrphans])];
        if (finalTouser.length === 0) {
            showEditError('请至少选择一个成员');
            return;
        }

        const saveBtn = document.getElementById('edit-save');
        const originalHtml = saveBtn.innerHTML;
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<span class="loading loading-spinner loading-xs"></span> 保存中';

        try {
            const res = await fetch(`/api/configuration/${editCode}`, {
                method: 'PUT',
                headers: getAuthHeaders(),
                body: JSON.stringify({ touser: finalTouser })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '保存失败');

            const savedCode = editCode;
            showToast('保存成功');
            await refreshLookupConfiguration(savedCode);
        } catch (err) {
            showEditError(err.message || '保存失败');
        } finally {
            const currentSaveBtn = document.getElementById('edit-save');
            if (currentSaveBtn) {
                currentSaveBtn.disabled = false;
                currentSaveBtn.innerHTML = originalHtml;
                lucide.createIcons();
            }
        }
    }

    function showError(msg) {
        resultDiv.innerHTML = `<div class="alert alert-error"><span>${escapeHtml(msg)}</span></div>`;
        gsap.from(resultDiv, { opacity: 0, y: 20, duration: 0.5 });
    }

    function showCallbackResult(data) {
        const callbackUrl = window.location.origin + data.callbackUrl;
        callbackResult.innerHTML = `
            <div class="card bg-base-100 shadow-md">
                <div class="card-body">
                    <h2 class="card-title text-primary flex items-center gap-2">
                        <i data-lucide="check-circle" class="h-6 w-6"></i>
                        回调URL生成成功！
                    </h2>

                    <div class="space-y-4 mt-4">
                        <div>
                            <div class="font-medium">您的配置Code</div>
                            <div class="bg-base-200 p-2 rounded-md font-mono text-sm overflow-x-auto">${escapeHtml(data.code)}</div>
                        </div>
                        <div>
                            <div class="font-medium">回调URL</div>
                            <div class="bg-base-200 p-2 rounded-md font-mono text-sm overflow-x-auto">${escapeHtml(callbackUrl)}</div>
                            <button class="btn btn-sm btn-outline mt-1" id="copy-callback-url-btn">
                                <i data-lucide="copy" class="h-4 w-4 mr-1"></i>复制回调URL
                            </button>
                        </div>
                    </div>

                    <div class="alert alert-info mt-4">
                        <i data-lucide="info" class="h-5 w-5"></i>
                        <div>
                            <div class="font-medium">下一步操作</div>
                            <div class="text-sm">
                                1. 复制上方回调URL到企业微信管理后台<br>
                                2. 配置IP白名单（添加您的服务器IP）<br>
                                3. 完成下方第二步配置
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // 绑定复制按钮事件
        document.getElementById('copy-callback-url-btn').addEventListener('click', () => {
            navigator.clipboard.writeText(callbackUrl);
            showToast('回调URL已复制到剪贴板');
        });

        callbackResult.classList.remove('hidden');
        lucide.createIcons();
        gsap.from(callbackResult.firstElementChild, { opacity: 0, y: 20, duration: 0.5 });
    }

    function showFinalResult(data) {
        const apiUrl = window.location.origin + data.apiUrl;
        const callbackUrl = window.location.origin + data.callbackUrl;
        resultDiv.innerHTML = `
            <div class="card bg-base-100 shadow-md">
                <div class="card-body">
                    <h2 class="card-title text-success flex items-center gap-2">
                        <i data-lucide="check-circle-2" class="h-6 w-6"></i>
                        配置完成！
                    </h2>

                    <div class="space-y-4 mt-4">
                        <div>
                            <div class="font-medium">配置Code</div>
                            <div class="bg-base-200 p-2 rounded-md font-mono text-sm overflow-x-auto">${escapeHtml(data.code)}</div>
                        </div>
                        <div>
                            <div class="font-medium">通知API地址</div>
                            <div class="bg-base-200 p-2 rounded-md font-mono text-sm overflow-x-auto">${escapeHtml(apiUrl)}</div>
                            <button class="btn btn-sm btn-outline mt-1" id="copy-api-url-btn">
                                <i data-lucide="copy" class="h-4 w-4 mr-1"></i>复制API地址
                            </button>
                        </div>
                        <div>
                            <div class="font-medium">回调地址</div>
                            <div class="bg-base-200 p-2 rounded-md font-mono text-sm overflow-x-auto">${escapeHtml(callbackUrl)}</div>
                        </div>
                    </div>

                    <div class="alert alert-success mt-4">
                        <i data-lucide="check" class="h-5 w-5"></i>
                        <span>配置已完成！您现在可以使用API发送通知，也可以接收企业微信回调消息。</span>
                    </div>
                </div>
            </div>
        `;

        // 绑定复制按钮事件
        document.getElementById('copy-api-url-btn').addEventListener('click', () => {
            navigator.clipboard.writeText(apiUrl);
            showToast('API地址已复制到剪贴板');
        });

        lucide.createIcons();
        gsap.from(resultDiv.firstElementChild, { opacity: 0, y: 20, duration: 0.5 });
    }
    function showResult(data) {
        const callbackUrl = data.callbackUrl ? window.location.origin + data.callbackUrl : '';
        resultDiv.innerHTML = `
            <div class="card bg-base-100 shadow-md">
                <div class="card-body">
                    <h2 class="card-title text-primary flex items-center gap-2">
                        <i data-lucide="check-circle" class="h-6 w-6"></i>
                        API生成成功！
                    </h2>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                        <div class="space-y-2">
                            <div class="font-medium">您的唯一调用ID</div>
                            <div class="bg-base-200 p-2 rounded-md font-mono text-sm overflow-x-auto">${escapeHtml(data.code)}</div>
                        </div>
                        <div class="space-y-2">
                            <div class="font-medium">API地址</div>
                            <div class="bg-base-200 p-2 rounded-md font-mono text-sm overflow-x-auto">${escapeHtml(data.apiUrl)}</div>
                            <button class="btn btn-sm btn-outline mt-1" id="copy-new-api-btn">
                                <i data-lucide="copy" class="h-4 w-4 mr-1"></i>复制
                            </button>
                        </div>
                        ${data.callbackUrl ? `
                        <div class="space-y-2 md:col-span-2">
                            <div class="font-medium">回调地址</div>
                            <div class="bg-base-200 p-2 rounded-md font-mono text-sm overflow-x-auto">${escapeHtml(callbackUrl)}</div>
                            <button class="btn btn-sm btn-outline mt-1" id="copy-callback-btn">
                                <i data-lucide="copy" class="h-4 w-4 mr-1"></i>复制回调地址
                            </button>
                            <div class="text-sm text-base-content/60 mt-1">
                                <i data-lucide="info" class="h-4 w-4 inline mr-1"></i>
                                在企业微信管理后台配置此回调地址以接收消息
                            </div>
                        </div>
                        ` : ''}
                    </div>

                    <div class="divider">API使用说明</div>

                    <div class="space-y-4">
                        <div>
                            <h3 class="font-medium mb-2">请求方式</h3>
                            <div class="bg-base-200 p-3 rounded-md">
                                <code class="text-sm">POST ${escapeHtml(data.apiUrl)}</code>
                            </div>
                        </div>

                        <div>
                            <h3 class="font-medium mb-2">请求头</h3>
                            <div class="bg-base-200 p-3 rounded-md">
                                <code class="text-sm">Content-Type: application/json</code>
                            </div>
                        </div>

                        <div>
                            <h3 class="font-medium mb-2">请求参数</h3>
                            <div class="overflow-x-auto">
                                <table class="table table-zebra w-full">
                                    <thead>
                                        <tr>
                                            <th>参数名</th>
                                            <th>类型</th>
                                            <th>必填</th>
                                            <th>说明</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr>
                                            <td class="font-mono">title</td>
                                            <td>String</td>
                                            <td>否</td>
                                            <td>消息标题，可选</td>
                                        </tr>
                                        <tr>
                                            <td class="font-mono">content</td>
                                            <td>String</td>
                                            <td>是</td>
                                            <td>消息内容，必填</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        <div>
                            <h3 class="font-medium mb-2">请求示例</h3>
                            <div class="bg-base-200 p-3 rounded-md">
<pre class="text-sm whitespace-pre-wrap">curl -X POST "${escapeHtml(data.apiUrl)}" \\
-H "Content-Type: application/json" \\
-d '{
  "title": "服务器告警",
  "content": "CPU使用率超过90%，请及时处理！"
}'</pre>
                            </div>
                        </div>

                        <div>
                            <h3 class="font-medium mb-2">返回示例</h3>
                            <div class="bg-base-200 p-3 rounded-md">
<pre class="text-sm whitespace-pre-wrap">{
  "message": "发送成功",
  "response": {
    "errcode": 0,
    "errmsg": "ok",
    "msgid": "MSGID1234567890"
  }
}</pre>
                            </div>
                        </div>
                    </div>

                    <div class="alert alert-warning mt-4">
                        <i data-lucide="alert-triangle" class="h-5 w-5"></i>
                        <span>请妥善保存您的配置Code，它是调用API的唯一凭证。出于安全考虑，它只会显示一次！</span>
                    </div>
                </div>
            </div>
        `;

        // 绑定复制按钮事件
        document.getElementById('copy-new-api-btn').addEventListener('click', () => {
            navigator.clipboard.writeText(data.apiUrl);
            showToast('API地址已复制到剪贴板');
        });

        // 绑定回调地址复制按钮事件（如果存在）
        if (data.callbackUrl) {
            document.getElementById('copy-callback-btn').addEventListener('click', () => {
                navigator.clipboard.writeText(callbackUrl);
                showToast('回调地址已复制到剪贴板');
            });
        }

        // 创建图标
        lucide.createIcons();

        gsap.from(resultDiv, { opacity: 0, y: 20, duration: 0.5 });
    }

    // 显示提示消息
    function showToast(message) {
        const toast = document.createElement('div');
        toast.className = 'toast toast-top toast-center';
        toast.innerHTML = `
            <div class="alert alert-info">
                <span>${escapeHtml(message)}</span>
            </div>
        `;
        document.body.appendChild(toast);

        gsap.fromTo(toast, 
            { opacity: 0, y: -20 }, 
            { opacity: 1, y: 0, duration: 0.3 }
        );

        setTimeout(() => {
            gsap.to(toast, { 
                opacity: 0, 
                y: -20, 
                duration: 0.3,
                onComplete: () => toast.remove()
            });
        }, 3000);
    }
}); 
