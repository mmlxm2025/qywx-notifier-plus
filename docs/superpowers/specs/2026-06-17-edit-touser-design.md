# 查找已有配置后修改发送人员（touser）- 设计文档

- 创建日期：2026-06-17
- 更新日期：2026-06-18
- 状态：待审查（v3，补充完成态校验、API 合约、安全渲染与冲突处理）
- 范围：前端 UI（`public/index.html`、`public/script.js`）+ 后端（`src/api/routes.js`、`src/services/notifier.js`、`src/core/wechat.js`）
- 不改表结构：复用现有 `configurations.touser` 与 `UNIQUE(corpid, agentid, touser)` 约束

## 1. 背景与目标

当前「查找已有配置」区域（`public/index.html:129-144`）查出配置后，「编辑配置」按钮仍是占位逻辑（`public/script.js:297-300`），只提示「编辑功能待实现」。

目标是在用户查找已有配置后，支持修改该配置的发送人员（`touser`）。用户点击「编辑配置」后，系统重新拉取企业微信可见范围内的成员列表，用复选框展示当前可选成员，并在保存时用勾选结果整体覆盖配置的 `touser`。

核心策略：**重新拉取可见范围内成员列表 + 全量更新发送人员**。本功能不做增量 diff，也不要求用户重新输入 `CorpSecret`。后端使用数据库中已加密保存的 `corpsecret` 解密后调用企业微信接口。

成功标准：

- 查找到已完成配置后，可以展开编辑区并看到当前接收人默认勾选。
- 保存时只更新 `touser`，不改变 `corpid`、`corpsecret`、`agentid`、回调配置和描述。
- 前端永远拿不到 `corpsecret` 或 `encrypted_corpsecret`。
- 库中已有但当前企业微信接口拉不回来的 `userid` 不会被无声删除。
- 空接收人、未完成配置、重复配置冲突、权限不足等场景都有明确错误语义。

非目标（YAGNI，本期不做）：

- 修改 `corpid`、`corpsecret`、`agentid`、回调 Token、`EncodingAESKey` 或描述。
- 删除配置。
- 批量管理多个配置。
- 重构原有 `/api/validate` 和 `wechat.getAllUsers`。
- 做服务端分页、成员分组或部门树选择。

## 2. 企业微信 API 依据

本节记录本次改动依赖的企业微信接口规则。实现以企业微信开发者中心文档为准，参考链接见第 14 节。

### 2.1 access_token

| 维度 | 规范 | 本项目现状 |
|------|------|-----------|
| 接口 | `GET /cgi-bin/gettoken?corpid=&corpsecret=` | `src/core/wechat.js:14-45` 已实现 |
| 有效期 | 正常为 7200 秒，应在服务端缓存 | 进程内 `Map` 缓存，提前 5 分钟过期 |
| 失效重取 | `40014`、`42001` 需要重新获取 | 当前未做自动清缓存重试，记录为已知限制 |
| 安全要求 | `corpsecret` 不得暴露给前端 | 本功能由后端解密调用，符合 |

### 2.2 成员接口选择

企业微信提供多个通讯录接口，本功能只需要 `userid` 和展示名称，因此优先使用「获取部门成员」简要接口：

| 接口 | 路径 | 返回字段 | 本功能是否使用 |
|------|------|----------|----------------|
| 获取部门成员 | `/cgi-bin/user/simplelist` | `userid`、`name`、`department`、`open_userid` | 使用 |
| 获取部门成员详情 | `/cgi-bin/user/list` | 包含手机号、邮箱、头像等敏感字段 | 不使用 |
| 获取成员 ID 列表 | `/cgi-bin/user/list_id` | 仅 `userid` | 不使用 |

选择 `simplelist` 的原因：

- 权限门槛低于详情接口，避免为了展示复选框而申请敏感字段权限。
- 返回数据更小，满足「展示名称 + 保存 userid」的需求。
- 与本项目现有 `getUserList` 使用详情接口的行为隔离，降低回归风险。

### 2.3 `fetch_child` 与根部门

本功能新增专用方法时，按以下参数调用简要成员接口：

```text
department_id=1
fetch_child=1
```

设计意图是拉取根部门及其子部门下、当前应用可见范围内的成员，避免本项目现有 `getAllUsers` 的部门遍历和 N+1 请求。若联调发现企业微信实际返回不包含子部门成员，应在 `getDepartmentUsers` 内改为专用递归实现；不要回退复用 `getAllUsers` 或详情接口 `user/list`。

### 2.4 应用可见范围

企业微信应用只能获取自身可见范围内的成员。成员离职、被移出应用可见范围、或应用通讯录权限不足时，接口可能拉不回该成员。

对本功能的影响：

- 数据库中旧 `touser` 可能包含当前拉取不到的 `userid`。
- 直接用最新成员列表覆盖会造成接收人无声丢失。
- 因此后端必须返回 `orphan`：旧配置中存在、但当前成员列表不可见的 `userid`。

`orphan` 的语义是「当前无法确认的旧接收人」。保留它只表示继续把该 `userid` 保存到配置中，实际消息是否可投递仍取决于企业微信当前权限和成员状态。

### 2.5 本功能关注的错误码

| errcode | 含义 | 本功能触发场景 | 处理 |
|---------|------|----------------|------|
| `0` | 成功 | 正常拉取成员 | 返回数据 |
| `40014` | 不合法的 `access_token` | token 缓存边界或提前失效 | 透传错误，提示重试 |
| `42001` | `access_token` 已过期 | token 失效 | 透传错误，提示重试 |
| `40056` | 不合法的 `agentid` | 配置错误 | 提示检查配置 |
| `60011` | 成员、部门或标签无权限 | 应用可见范围或通讯录权限不足 | 提示管理员检查权限 |
| `60020` | 不安全的访问 IP | 企业可信 IP 未配置或未生效 | 提示检查 IP 白名单 |
| `45009` | 接口调用超过限制 | 高频调用 | 提示稍后重试 |
| `-1` | 系统繁忙 | 企业微信偶发错误 | 提示稍后重试 |

## 3. 关键约束

1. **安全模型不可破坏**：`getConfiguration` 不返回 `corpsecret`；新增成员接口也不得返回密钥。
2. **只编辑已完成配置**：回调第一步生成但尚未完善的配置没有可用 `corpsecret`、`agentid` 和 `touser`，编辑入口必须禁用，后端也要拒绝。
3. **成员拉取走专用方法**：新增 `getDepartmentUsers` 使用 `simplelist + fetch_child=1`，不复用 `getAllUsers`。
4. **保存为全量覆盖**：保存请求里的 `touser` 是最终接收人全集，不做增量更新。
5. **接收人不能为空**：前端拦截，后端兜底校验。`touser` 为空数组、空字符串或只包含空白项时返回 400。
6. **不可见成员不可无声丢失**：`orphan` 默认勾选，用户明确取消后才移除。
7. **动态内容必须转义**：企业微信成员名、`userid`、描述、错误信息等进入 HTML 模板前必须转义，避免 XSS。
8. **唯一约束冲突要可解释**：更新后的 `(corpid, agentid, touser)` 若与其他配置重复，返回 409，并提示该接收人组合已存在。
9. **认证一致**：新增管理接口必须使用 `requireAuth`，前端请求必须带 `getAuthHeaders()`。

## 4. 方案取舍

### 方案 A：新增拉成员接口，保存复用现有 PUT（采用）

- 新增 `GET /api/configuration/:code/users`。
- 后端解密库内 `corpsecret` 后调用企业微信 `simplelist`。
- 前端内联展开编辑区。
- 保存时复用 `PUT /api/configuration/:code`，请求体只传 `{ "touser": [...] }`。

优点：安全边界清晰，复用现有更新能力，改动面可控。缺点：`PUT` 仍是通用更新接口，需要在前端和文档中明确本功能只传 `touser`。

### 方案 B：新增专用保存接口

- 新增 `PATCH /api/configuration/:code/touser`。
- 后端只接受 `touser`。

优点：接口意图更窄，后端边界更强。缺点：新增 API 面，和现有 `updateConfiguration` 能力重复。本期不采用。

### 方案 C：要求用户重新输入 `corpsecret`

- 前端复用 `/api/validate` 获取成员列表。

优点：后端无需新增取成员逻辑。缺点：用户体验差，且容易诱导前端处理密钥。本期不采用。

## 5. 后端设计

### 5.1 新增 `wechat.getDepartmentUsers`

文件：`src/core/wechat.js`

职责：用 `simplelist` 拉取当前应用可见范围内的成员简要列表。

```js
async getDepartmentUsers(accessToken, departmentId = 1) {
    try {
        const response = await axios.get(`${this.apiBase}/cgi-bin/user/simplelist`, {
            params: {
                access_token: accessToken,
                department_id: departmentId,
                fetch_child: 1
            }
        });

        const { data } = response;
        if (data.errcode !== 0) {
            throw new Error(`获取成员列表失败: ${data.errmsg} (错误码: ${data.errcode})`);
        }

        return data.userlist || [];
    } catch (error) {
        console.error('获取部门成员失败:', error.message);
        throw error;
    }
}
```

返回字段只取：

- `userid`：保存到 `touser` 的真实值。
- `name`：前端展示。若为空或不可用，前端以 `userid` 兜底展示。

### 5.2 新增 `notifier.getConfigMembers(code)`

文件：`src/services/notifier.js`

职责：校验配置完成态，解密 `corpsecret`，拉取成员，计算 `orphan`，组装响应。

```js
async function getConfigMembers(code) {
    const config = await db.getConfigurationByCode(code);
    if (!config) {
        throw new Error('无效的code，未找到配置');
    }

    const current = (config.touser || '')
        .split('|')
        .map(uid => uid.trim())
        .filter(Boolean);

    if (!config.encrypted_corpsecret || !config.agentid || current.length === 0) {
        throw new Error('配置尚未完成，请先完成第二步配置');
    }

    const corpsecret = crypto.decrypt(config.encrypted_corpsecret);
    const accessToken = await wechat.getToken(config.corpid, corpsecret);
    const users = await wechat.getDepartmentUsers(accessToken);

    const visibleUserids = new Set(users.map(user => user.userid));
    const orphan = current.filter(userid => !visibleUserids.has(userid));

    return {
        users: users.map(user => ({
            userid: user.userid,
            name: user.name || user.userid,
            displayName: user.name || user.userid
        })),
        current,
        orphan
    };
}
```

说明：

- `current` 过滤空值，避免第一步未完成配置把 `['']` 当作有效接收人。
- `orphan` 只返回 `userid` 字符串数组，因为后端无法再获得名称。
- `displayName` 是前端可直接使用的展示兜底字段，但前端仍要做 HTML 转义。

### 5.3 新增路由 `GET /api/configuration/:code/users`

文件：`src/api/routes.js`

```js
router.get('/api/configuration/:code/users', requireAuth, async (req, res) => {
    const { code } = req.params;
    try {
        const result = await notifier.getConfigMembers(code);
        res.json(result);
    } catch (err) {
        if (err.message && err.message.includes('未找到配置')) {
            return res.status(404).json({ error: err.message });
        }
        if (err.message && err.message.includes('配置尚未完成')) {
            return res.status(400).json({ error: err.message });
        }
        res.status(400).json({ error: err.message || '获取成员列表失败' });
    }
});
```

响应示例：

```json
{
  "users": [
    { "userid": "zhangsan", "name": "张三", "displayName": "张三" },
    { "userid": "lisi", "name": "李四", "displayName": "李四" }
  ],
  "current": ["zhangsan", "old_user"],
  "orphan": ["old_user"]
}
```

HTTP 语义：

| 场景 | HTTP |
|------|------|
| 未登录或登录过期 | 401 |
| code 不存在 | 404 |
| 配置尚未完成 | 400 |
| 企业微信凭证、权限、IP 或频率错误 | 400 |
| 成功 | 200 |

### 5.4 保存路径：复用 `PUT /api/configuration/:code`

前端请求体：

```json
{
  "touser": ["zhangsan", "lisi", "old_user"]
}
```

`notifier.updateConfiguration` 需要补强 `touser` 归一化与重复检查：

```js
function normalizeTouser(value) {
    const list = Array.isArray(value) ? value : String(value || '').split('|');
    return [...new Set(list.map(item => item.trim()).filter(Boolean))];
}

async function updateConfiguration(code, newConfig) {
    const config = await db.getConfigurationByCode(code);
    if (!config) {
        throw new Error('无效的code，未找到配置');
    }

    const hasTouser = Object.prototype.hasOwnProperty.call(newConfig, 'touser');
    const normalizedTouser = hasTouser ? normalizeTouser(newConfig.touser) : null;
    if (hasTouser && normalizedTouser.length === 0) {
        throw new Error('请至少选择一个成员');
    }

    const targetTouser = hasTouser ? normalizedTouser.join('|') : config.touser;
    const duplicate = await db.getConfigurationByFields(
        newConfig.corpid || config.corpid,
        newConfig.agentid || config.agentid,
        targetTouser
    );
    if (duplicate && duplicate.code !== code) {
        const err = new Error('相同企业、应用和接收人的配置已存在');
        err.statusCode = 409;
        throw err;
    }

    // 其余字段沿用当前逻辑，touser 使用 targetTouser。
}
```

`routes.js` 中 `PUT /api/configuration/:code` 的错误码建议调整：

| 场景 | 当前 | 目标 |
|------|------|------|
| code 不存在 | 500 | 404 |
| `touser` 为空 | 500 | 400 |
| 唯一约束冲突 / 重复配置 | 500 | 409 |
| 其他异常 | 500 | 500 |

## 6. 前端设计

### 6.1 触发点

替换 `public/script.js:297-300` 的占位逻辑。

点击「编辑配置」后：

1. 若编辑区已展开，则折叠并移除编辑区。
2. 若配置尚未完成，则展示提示，不请求成员接口。
3. 否则按钮进入 loading 状态，调用 `GET /api/configuration/:code/users`。

### 6.2 安全渲染

新增一个小型转义函数，所有进入模板字符串的动态内容都必须先处理：

```js
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
```

适用字段：

- `data.corpid`、`data.agentid`、`data.description`、`data.callback_token`
- `user.userid`、`user.displayName`
- `orphan` 中的 `userid`
- 错误提示和 toast 文案中来自服务端的内容

### 6.3 编辑区 DOM 结构

编辑区追加在配置详情卡片之后，沿用 DaisyUI + Lucide + GSAP 的现有风格。

```html
<div id="edit-section" class="card bg-base-100 shadow-md mt-4">
  <div class="card-body">
    <h2 class="card-title flex items-center gap-2">
      <i data-lucide="user-cog" class="h-5 w-5"></i>
      修改发送人员
    </h2>

    <div class="form-control">
      <input id="edit-user-filter" class="input input-bordered input-sm" placeholder="按姓名或 UserID 筛选">
    </div>

    <div class="flex items-center justify-between">
      <span id="edit-selected-count" class="text-sm text-base-content/70">已选 0 人</span>
      <div class="flex gap-2">
        <button id="edit-select-all" class="btn btn-xs btn-ghost" type="button">全选当前列表</button>
        <button id="edit-clear-all" class="btn btn-xs btn-ghost" type="button">取消全选</button>
      </div>
    </div>

    <div id="edit-user-list" class="grid grid-cols-2 gap-2 max-h-60 overflow-y-auto bg-base-100 rounded-lg p-2 border border-base-200"></div>

    <div id="edit-orphan-section" class="hidden mt-2">
      <div class="text-xs text-warning mb-1">
        以下 UserID 当前不可见，可能已离职或不在应用可见范围内。保留勾选会继续保存到配置中。
      </div>
      <div id="edit-orphan-list" class="flex flex-wrap gap-2"></div>
    </div>

    <div class="card-actions justify-end mt-2">
      <button id="edit-cancel" class="btn btn-ghost btn-sm" type="button">取消</button>
      <button id="edit-save" class="btn btn-primary btn-sm" type="button">
        <i data-lucide="save" class="h-4 w-4"></i>
        保存修改
      </button>
    </div>
  </div>
</div>
```

说明：

- 「全选当前列表」只影响当前筛选结果中的可见成员，不影响 `orphan`。
- `orphan` 区默认勾选，用户取消勾选才会移除。
- 本地筛选只在 `editUsersCache` 上过滤，不新增后端查询。

### 6.4 状态变量

新增独立状态，避免与第二步配置流程的 `usersCache` 串扰：

```js
let editUsersCache = [];
let editCurrent = [];
let editOrphan = [];
let editCode = null;
```

### 6.5 交互流程

1. 查找配置成功后，计算 `isCompletedConfig`：`agentid` 非 0，且 `touser.filter(Boolean).length > 0`。
2. 未完成配置展示提示：「该配置尚未完成第二步，暂不能编辑发送人员」。
3. 点击编辑，调用 `GET /api/configuration/:code/users`，请求头使用 `getAuthHeaders()`。
4. 成功后渲染编辑区。`current` 中出现在 `users` 的成员默认勾选。
5. `orphan` 渲染为带复选框的小标签，显示 `userid`，默认勾选。
6. 每次勾选、取消勾选、筛选后刷新已选计数。
7. 点击保存时，合并「可见成员中已勾选的 `userid`」和「`orphan` 中仍勾选的 `userid`」，去重后得到最终 `touser`。
8. 若最终 `touser` 为空，前端提示「请至少选择一个成员」，不发请求。
9. 保存成功后 toast「保存成功」，重新请求 `GET /api/configuration/:code` 刷新详情，并折叠编辑区。
10. 保存失败时保留编辑区，恢复按钮状态，展示服务端错误。

### 6.6 空列表与边界显示

- `users` 为空且 `orphan` 为空：展示「未获取到任何成员，请检查应用可见范围与通讯录权限」，保存按钮禁用。
- `users` 为空但 `orphan` 不为空：只展示 `orphan`，允许用户保留或删除旧接收人。
- `name` 为空：展示 `userid`。
- 筛选无结果：主列表展示「没有匹配的成员」。

## 7. 数据流

```text
[拉取成员]
点击编辑
  -> GET /api/configuration/:code/users
  -> requireAuth
  -> notifier.getConfigMembers(code)
  -> db.getConfigurationByCode(code)
  -> 校验配置已完成
  -> crypto.decrypt(encrypted_corpsecret)
  -> wechat.getToken(corpid, corpsecret)
  -> wechat.getDepartmentUsers(accessToken)
  -> 计算 orphan = current - visibleUserids
  -> 返回 { users, current, orphan }
  -> 前端转义并渲染

[保存成员]
点击保存
  -> 合并可见成员勾选项 + orphan 勾选项
  -> 去重并校验非空
  -> PUT /api/configuration/:code body { touser: [...] }
  -> requireAuth
  -> notifier.updateConfiguration(code, body)
  -> 归一化 touser
  -> 检查重复配置
  -> db.updateConfiguration(..., touser = "user1|user2")
  -> 返回成功
  -> 前端刷新配置详情
```

## 8. 错误处理

| 场景 | HTTP | 前端展示 |
|------|------|----------|
| 未登录或登录过期 | 401 | 跳转登录页或提示重新登录 |
| code 不存在 | 404 | `未找到配置` |
| 配置尚未完成 | 400 | `配置尚未完成，请先完成第二步配置` |
| `corpsecret` 解密失败 | 400/500 | `配置密钥异常，请重新配置` |
| 企业微信凭证失效 | 400 | 透传 `errmsg`，提示重试或检查凭证 |
| 通讯录权限不足 | 400 | 提示检查应用可见范围和通讯录权限 |
| IP 未加入白名单 | 400 | 提示检查企业可信 IP |
| 接口超频 | 400 | 提示稍后重试 |
| 保存时未选成员 | 400 | `请至少选择一个成员` |
| 保存后与其他配置重复 | 409 | `相同企业、应用和接收人的配置已存在` |
| 其他保存失败 | 500 | `更新配置失败` + 服务端信息 |

## 9. 测试要点

本项目当前没有自动化测试基建，本功能先按手动验证覆盖：

1. 查找已完成配置，点击编辑后成员列表能加载，当前 `touser` 默认勾选。
2. 查找只完成第一步的配置，编辑入口不可用，后端成员接口返回 400。
3. 全选当前列表、取消全选、单个勾选后计数正确。
4. 按姓名或 `userid` 筛选后，只影响主列表显示和「全选当前列表」范围。
5. 保存修改后，详情里的「接收用户」刷新为最新列表。
6. 取消编辑后，编辑区移除，不发送保存请求。
7. 构造 `current` 中包含不可见 `userid`，`orphan` 区显示且默认勾选。
8. 保存时保留 `orphan`，请求体仍包含该 `userid`。
9. 取消 `orphan` 勾选后保存，该 `userid` 从 `touser` 移除。
10. 可见成员和 `orphan` 全部取消后，前端拦截，不发送请求。
11. 更新后的 `(corpid, agentid, touser)` 与其他配置重复时返回 409。
12. 企业微信返回 `60011`、`60020`、`45009` 时，前端展示可理解的错误提示。
13. 成员名、描述中包含 `<script>`、引号或 HTML 标签时，页面只显示文本，不执行脚本。
14. 未登录访问新增成员接口返回 401。

## 10. 改动清单

| 文件 | 改动 |
|------|------|
| `src/core/wechat.js` | 新增 `getDepartmentUsers(accessToken, departmentId = 1)`，调用 `user/simplelist` |
| `src/services/notifier.js` | 新增 `getConfigMembers(code)`；补强 `updateConfiguration` 的 `touser` 归一化、空值校验和重复配置检查 |
| `src/api/routes.js` | 新增 `GET /api/configuration/:code/users`；优化 `PUT /api/configuration/:code` 的 400/404/409 错误码 |
| `public/script.js` | 替换编辑占位逻辑；新增编辑区渲染、筛选、计数、orphan 保留、保存、取消和 HTML 转义 |
| `public/index.html` | 无需改动，编辑区由 JS 动态生成 |
| `src/core/database.js` | 不改表结构；可复用现有 `getConfigurationByFields` 做重复检查 |

## 11. 已知限制

1. `access_token` 提前失效后不会自动清缓存重试，本次只透传错误。
2. token 缓存为进程内 `Map`，多实例部署时各实例独立缓存。
3. 原有 `/api/validate` 仍使用 `getAllUsers` 和详情接口，本功能不改它。
4. `orphan` 无法区分是离职、不可见范围变化，还是通讯录权限不足，只能展示 `userid`。
5. 企业微信可能对部分应用不返回真实姓名，前端以 `userid` 兜底。
6. 编辑区只做本地筛选，不做分页。若企业成员数量很大，后续再设计分页或部门树。

## 12. 非功能考量

- **安全**：密钥只在后端解密使用；新增接口受 `requireAuth` 保护；前端动态 HTML 做转义。
- **合规**：只调用简要成员接口，避免拉取手机号、邮箱等敏感字段。
- **性能**：本功能一次拉取当前可见范围内成员；token 走缓存。
- **向后兼容**：不改通知发送、回调、配置创建流程；不改数据库表结构。
- **可维护性**：新增成员拉取逻辑独立于旧 `getAllUsers`，后续可单独替换实现。

## 13. 规格自检

- 无 `TODO`、占位章节或待定决策。
- 范围聚焦在「查找后编辑发送人员」，可以用一个实现计划覆盖。
- 安全、权限、空值、重复配置和不可见成员都有明确处理。
- 文档中的代码片段为设计示例，实现时应遵循项目现有代码风格。

## 14. 参考文档

- [获取 access_token — path/91039](https://developer.work.weixin.qq.com/document/path/91039)
- [访问频率限制 — path/96212](https://developer.work.weixin.qq.com/document/path/96212)
- [全局错误码 — path/90313](https://developer.work.weixin.qq.com/document/path/90313)
- [获取部门成员（simplelist）— path/90200](https://developer.work.weixin.qq.com/document/path/90200)
- [获取部门成员详情（list）— path/90201](https://developer.work.weixin.qq.com/document/path/90201)
- [获取部门列表 — path/90208](https://developer.work.weixin.qq.com/document/path/90208)
- [通讯录同步概述 — path/90329](https://developer.work.weixin.qq.com/document/path/90329)
