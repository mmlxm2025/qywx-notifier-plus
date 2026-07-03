document.addEventListener('DOMContentLoaded', function () {
    const query = new URLSearchParams(window.location.search);
    const token = query.get('token') || localStorage.getItem('authToken');
    if (!token) {
        window.location.href = '/login';
        return;
    }
    localStorage.setItem('authToken', token);

    const configCodeInput = document.getElementById('config-code');
    const loadBtn = document.getElementById('load-btn');
    const statusNode = document.getElementById('status');
    const workspace = document.getElementById('workspace');
    const ruleForm = document.getElementById('rule-form');
    const formTitle = document.getElementById('form-title');
    const ruleIdInput = document.getElementById('rule-id');
    const ruleNameInput = document.getElementById('rule-name');
    const ruleAllInput = document.getElementById('rule-all');
    const customScope = document.getElementById('custom-scope');
    const memberFilter = document.getElementById('member-filter');
    const memberList = document.getElementById('member-list');
    const refreshMembersBtn = document.getElementById('refresh-members-btn');
    const orphanSection = document.getElementById('orphan-section');
    const orphanList = document.getElementById('orphan-list');
    const topartyInput = document.getElementById('rule-toparty');
    const totagInput = document.getElementById('rule-totag');
    const estimatedCountInput = document.getElementById('estimated-count');
    const formError = document.getElementById('form-error');
    const rulesList = document.getElementById('rules-list');
    const resetFormBtn = document.getElementById('reset-form-btn');
    const reloadRulesBtn = document.getElementById('reload-rules-btn');
    const logoutBtn = document.getElementById('logout-btn');

    let currentCode = query.get('code') || '';
    let configurations = [];
    let rules = [];
    let members = [];
    let selectedUsers = new Set();
    let selectedOrphans = new Set();

    function authHeaders() {
        return {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + localStorage.getItem('authToken')
        };
    }

    function refreshIcons() {
        if (window.lucide) window.lucide.createIcons();
    }

    function clear(node) {
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    function icon(name, size = 'h-4 w-4') {
        const node = document.createElement('i');
        node.setAttribute('data-lucide', name);
        node.className = size;
        return node;
    }

    function textButton(label, iconName, className) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.appendChild(icon(iconName));
        button.appendChild(document.createTextNode(label));
        return button;
    }

    function normalizeList(value) {
        const list = Array.isArray(value) ? value : String(value || '').split(/[|,，;；\s]+/);
        return [...new Set(list.map(item => String(item).trim()).filter(Boolean))];
    }

    function setStatus(message, type = 'info') {
        clear(statusNode);
        if (!message) return;
        const alert = document.createElement('div');
        alert.className = `alert alert-${type} py-2`;
        const span = document.createElement('span');
        span.textContent = message;
        alert.appendChild(span);
        statusNode.appendChild(alert);
    }

    function setFormError(message) {
        clear(formError);
        if (!message) {
            formError.classList.add('hidden');
            return;
        }
        formError.classList.remove('hidden');
        const span = document.createElement('span');
        span.textContent = message;
        formError.appendChild(span);
    }

    async function requestJson(url, options = {}) {
        const res = await fetch(url, {
            ...options,
            headers: {
                ...authHeaders(),
                ...(options.headers || {})
            }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '请求失败');
        return data;
    }

    async function checkAuth() {
        const res = await fetch('/api/auth-status', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await res.json();
        if (!data.loggedIn) {
            window.location.href = '/login';
            return false;
        }
        return true;
    }

    function configOptionText(config) {
        const description = config.description ? ` - ${config.description}` : '';
        const status = config.completed ? '' : '（未完成）';
        return `${config.code}${description}${status}`;
    }

    function renderConfigOptions() {
        clear(configCodeInput);
        if (configurations.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '暂无可用配置';
            configCodeInput.appendChild(option);
            configCodeInput.disabled = true;
            loadBtn.disabled = true;
            return;
        }

        configCodeInput.disabled = false;
        loadBtn.disabled = false;
        configurations.forEach(config => {
            const option = document.createElement('option');
            option.value = config.code;
            option.textContent = configOptionText(config);
            option.disabled = !config.completed;
            configCodeInput.appendChild(option);
        });
    }

    async function loadConfigurations() {
        try {
            const data = await requestJson('/api/configurations');
            configurations = Array.isArray(data.configurations) ? data.configurations : [];
            renderConfigOptions();

            const completed = configurations.filter(config => config.completed);
            if (completed.length === 0) {
                workspace.classList.add('hidden');
                setStatus(configurations.length === 0 ? '暂无配置，请先返回首页创建配置' : '暂无已完成配置，请先完成第二步配置', 'warning');
                return;
            }

            const requested = completed.find(config => config.code === currentCode);
            currentCode = requested ? requested.code : completed[0].code;
            configCodeInput.value = currentCode;
            await loadRules();
        } catch (err) {
            workspace.classList.add('hidden');
            setStatus(err.message, 'error');
        } finally {
            refreshIcons();
        }
    }

    async function loadRules() {
        currentCode = configCodeInput.value.trim();
        if (!currentCode) {
            setStatus('请输入配置 Code', 'warning');
            return;
        }

        loadBtn.disabled = true;
        setStatus('');
        try {
            const data = await requestJson(`/api/configuration/${encodeURIComponent(currentCode)}/rules`);
            rules = Array.isArray(data.rules) ? data.rules : [];
            workspace.classList.remove('hidden');
            renderRules();
            resetForm();
            await loadMembers(false);
        } catch (err) {
            workspace.classList.add('hidden');
            setStatus(err.message, 'error');
        } finally {
            loadBtn.disabled = false;
            refreshIcons();
        }
    }

    async function loadMembers(refresh) {
        if (!currentCode) return;
        refreshMembersBtn.disabled = true;
        try {
            const suffix = refresh ? '?refresh=1' : '';
            const data = await requestJson(`/api/configuration/${encodeURIComponent(currentCode)}/users${suffix}`);
            members = Array.isArray(data.users) ? data.users.filter(user => user && user.userid) : [];
            if (data.warning) {
                setStatus(data.warning, 'warning');
            }
            renderMembers();
        } catch (err) {
            setStatus(err.message, 'error');
        } finally {
            refreshMembersBtn.disabled = false;
            refreshIcons();
        }
    }

    function resetForm() {
        ruleIdInput.value = '';
        ruleNameInput.value = '';
        ruleAllInput.checked = false;
        topartyInput.value = '';
        totagInput.value = '';
        estimatedCountInput.value = '1';
        selectedUsers = new Set();
        selectedOrphans = new Set();
        formTitle.textContent = '新建规则';
        setFormError('');
        toggleScopeMode();
        renderMembers();
        renderOrphans();
    }

    function editRule(rule) {
        ruleIdInput.value = String(rule.id);
        ruleNameInput.value = rule.name || '';
        ruleAllInput.checked = rule.is_all === true;
        topartyInput.value = normalizeList(rule.toparty).join('|');
        totagInput.value = normalizeList(rule.totag).join('|');
        estimatedCountInput.value = String(rule.estimated_count || 1);
        selectedUsers = new Set(normalizeList(rule.touser));
        const visible = new Set(members.map(user => String(user.userid)));
        selectedOrphans = new Set([...selectedUsers].filter(userid => !visible.has(userid)));
        formTitle.textContent = '编辑规则';
        setFormError('');
        toggleScopeMode();
        renderMembers();
        renderOrphans();
    }

    function toggleScopeMode() {
        customScope.classList.toggle('hidden', ruleAllInput.checked);
    }

    function visibleMembers() {
        const keyword = memberFilter.value.trim().toLowerCase();
        return members.filter(user => {
            const userid = String(user.userid || '').toLowerCase();
            const name = String(user.displayName || user.name || user.userid || '').toLowerCase();
            return !keyword || userid.includes(keyword) || name.includes(keyword);
        });
    }

    function renderMembers() {
        clear(memberList);
        const list = visibleMembers();
        if (ruleAllInput.checked) return;

        if (list.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'text-sm text-base-content/60 text-center py-3';
            empty.textContent = members.length === 0 ? '暂无成员' : '无匹配成员';
            memberList.appendChild(empty);
            return;
        }

        list.forEach(user => {
            const userid = String(user.userid);
            const label = document.createElement('label');
            label.className = 'flex items-center gap-2 rounded-md border border-base-200 p-2 hover:bg-base-200/60';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'checkbox checkbox-sm';
            checkbox.value = userid;
            checkbox.checked = selectedUsers.has(userid);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    selectedUsers.add(userid);
                } else {
                    selectedUsers.delete(userid);
                }
                updateEstimateFromExplicitUsers();
            });

            const textWrap = document.createElement('span');
            textWrap.className = 'min-w-0';
            const name = document.createElement('span');
            name.className = 'block truncate';
            name.textContent = user.displayName || user.name || userid;
            const id = document.createElement('span');
            id.className = 'block truncate text-xs text-base-content/50 font-mono';
            id.textContent = userid;
            textWrap.appendChild(name);
            textWrap.appendChild(id);

            label.appendChild(checkbox);
            label.appendChild(textWrap);
            memberList.appendChild(label);
        });
    }

    function renderOrphans() {
        clear(orphanList);
        const orphans = [...selectedOrphans];
        orphanSection.classList.toggle('hidden', orphans.length === 0 || ruleAllInput.checked);
        orphans.forEach(userid => {
            const label = document.createElement('label');
            label.className = 'flex items-center gap-2 rounded-md border border-error bg-error/10 p-2 text-error';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'checkbox checkbox-xs';
            checkbox.value = userid;
            checkbox.checked = true;
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    selectedOrphans.add(userid);
                    selectedUsers.add(userid);
                } else {
                    selectedOrphans.delete(userid);
                    selectedUsers.delete(userid);
                }
                updateEstimateFromExplicitUsers();
            });

            const text = document.createElement('span');
            text.className = 'font-mono text-xs';
            text.textContent = userid;
            const reason = document.createElement('span');
            reason.className = 'text-xs font-medium';
            reason.textContent = '成员不可见或成员已删除';

            label.appendChild(checkbox);
            label.appendChild(text);
            label.appendChild(reason);
            orphanList.appendChild(label);
        });
    }

    function updateEstimateFromExplicitUsers() {
        const toparty = normalizeList(topartyInput.value);
        const totag = normalizeList(totagInput.value);
        if (!ruleAllInput.checked && toparty.length === 0 && totag.length === 0) {
            estimatedCountInput.value = String(Math.max(1, selectedUsers.size));
        }
    }

    function getPayload() {
        const isAll = ruleAllInput.checked;
        const visibleSelected = Array.from(memberList.querySelectorAll('input[type=checkbox]:checked'))
            .map(checkbox => checkbox.value);
        const hiddenVisibleUserids = [...selectedUsers].filter(userid => {
            return !visibleMembers().some(user => String(user.userid) === userid)
                && !selectedOrphans.has(userid);
        });
        const touser = isAll
            ? []
            : [...new Set([...visibleSelected, ...hiddenVisibleUserids, ...selectedOrphans])];
        return {
            name: ruleNameInput.value.trim(),
            is_all: isAll,
            touser,
            toparty: topartyInput.value,
            totag: totagInput.value,
            estimated_count: Number(estimatedCountInput.value) || 1
        };
    }

    async function saveRule(event) {
        event.preventDefault();
        setFormError('');
        const payload = getPayload();
        if (!payload.name) {
            setFormError('规则名称不能为空');
            return;
        }
        if (!payload.is_all && payload.touser.length === 0 && normalizeList(payload.toparty).length === 0 && normalizeList(payload.totag).length === 0) {
            setFormError('请至少配置一个接收范围');
            return;
        }

        const id = ruleIdInput.value;
        try {
            if (id) {
                await requestJson(`/api/rules/${encodeURIComponent(id)}`, {
                    method: 'PUT',
                    body: JSON.stringify(payload)
                });
            } else {
                await requestJson(`/api/configuration/${encodeURIComponent(currentCode)}/rules`, {
                    method: 'POST',
                    body: JSON.stringify(payload)
                });
            }
            resetForm();
            await loadRules();
        } catch (err) {
            setFormError(err.message);
        }
    }

    function scopeText(rule) {
        if (rule.is_all) return '全体人员';
        const parts = [];
        const users = normalizeList(rule.touser);
        const parties = normalizeList(rule.toparty);
        const tags = normalizeList(rule.totag);
        if (users.length) parts.push(`成员 ${users.length}`);
        if (parties.length) parts.push(`部门 ${parties.join('|')}`);
        if (tags.length) parts.push(`标签 ${tags.join('|')}`);
        return parts.join(' / ') || '未配置';
    }

    function renderRules() {
        clear(rulesList);
        if (rules.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'text-sm text-base-content/60 py-8 text-center';
            empty.textContent = '暂无规则';
            rulesList.appendChild(empty);
            return;
        }

        const table = document.createElement('table');
        table.className = 'table table-zebra table-sm';
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        ['名称', '范围', 'API', '操作'].forEach(label => {
            const th = document.createElement('th');
            th.textContent = label;
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        rules.forEach(rule => {
            const tr = document.createElement('tr');

            const nameTd = document.createElement('td');
            nameTd.textContent = rule.name || '';
            tr.appendChild(nameTd);

            const scopeTd = document.createElement('td');
            scopeTd.textContent = scopeText(rule);
            tr.appendChild(scopeTd);

            const apiTd = document.createElement('td');
            const apiCode = document.createElement('code');
            apiCode.className = 'text-xs';
            apiCode.textContent = rule.apiUrl || `/api/notify/${rule.api_code}`;
            apiTd.appendChild(apiCode);
            tr.appendChild(apiTd);

            const actionsTd = document.createElement('td');
            actionsTd.className = 'flex flex-wrap gap-1';

            const editBtn = textButton('编辑', 'edit-3', 'btn btn-xs btn-outline');
            editBtn.addEventListener('click', () => editRule(rule));
            actionsTd.appendChild(editBtn);

            const copyBtn = textButton('复制', 'copy', 'btn btn-xs btn-outline');
            copyBtn.addEventListener('click', () => {
                const apiUrl = window.location.origin + (rule.apiUrl || `/api/notify/${rule.api_code}`);
                navigator.clipboard.writeText(apiUrl);
                setStatus('API 已复制', 'success');
            });
            actionsTd.appendChild(copyBtn);

            const regenBtn = textButton('重生成', 'refresh-cw', 'btn btn-xs btn-warning');
            regenBtn.addEventListener('click', async () => {
                if (!window.confirm('重新生成后旧地址会失效，继续吗？')) return;
                try {
                    await requestJson(`/api/rules/${encodeURIComponent(rule.id)}/regenerate`, { method: 'POST' });
                    await loadRules();
                } catch (err) {
                    setStatus(err.message, 'error');
                }
            });
            actionsTd.appendChild(regenBtn);

            const deleteBtn = textButton('删除', 'trash-2', 'btn btn-xs btn-error');
            deleteBtn.addEventListener('click', async () => {
                if (!window.confirm('删除这条规则吗？')) return;
                try {
                    await requestJson(`/api/rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' });
                    await loadRules();
                } catch (err) {
                    setStatus(err.message, 'error');
                }
            });
            actionsTd.appendChild(deleteBtn);

            tr.appendChild(actionsTd);
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        rulesList.appendChild(table);
        refreshIcons();
    }

    loadBtn.addEventListener('click', loadRules);
    configCodeInput.addEventListener('change', loadRules);
    reloadRulesBtn.addEventListener('click', loadRules);
    resetFormBtn.addEventListener('click', resetForm);
    refreshMembersBtn.addEventListener('click', () => loadMembers(true));
    memberFilter.addEventListener('input', renderMembers);
    ruleAllInput.addEventListener('change', () => {
        toggleScopeMode();
        renderMembers();
        renderOrphans();
    });
    topartyInput.addEventListener('input', updateEstimateFromExplicitUsers);
    totagInput.addEventListener('input', updateEstimateFromExplicitUsers);
    ruleForm.addEventListener('submit', saveRule);
    logoutBtn.addEventListener('click', async () => {
        await fetch('/api/logout', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token }
        });
        localStorage.removeItem('authToken');
        window.location.href = '/login';
    });

    checkAuth().then(isAuth => {
        if (!isAuth) return;
        refreshIcons();
        loadConfigurations();
    });
});
