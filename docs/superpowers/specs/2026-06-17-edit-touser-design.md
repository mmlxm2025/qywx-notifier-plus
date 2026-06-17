# 查找已有配置后修改发送人员 - 设计文档

- 日期：2026-06-17
- 状态：待审查
- 范围：前端 UI（`public/index.html`、`public/script.js`）+ 后端（`src/api/routes.js`、`src/services/notifier.js`）

## 1. 背景与目标

当前"查找已有配置"区域（`index.html:130-145`）查出配置后，"编辑配置"按钮仅是占位（`script.js:300` `showToast('编辑功能待实现')`）。

目标：在用户查找已有配置后，支持**修改该配置的发送人员（touser）**，并通过复选框勾选成员、提交保存。

非目标（YAGNI，本期不做）：
- 修改 corpid / corpsecret / agentid / 回调配置
- 删除配置
- 批量管理多个配置

## 2. 关键约束

1. **安全模型不可破坏**：`getConfiguration`（`notifier.js:266-287`）出于安全**不返回 corpsecret**。前端永远拿不到密钥。
2. **拉取成员列表需要 corpsecret**：企业微信 `/cgi-bin/user/list` 走 access_token，而 token 来自 `corpid + corpsecret`。
3. **结论**：成员列表必须由后端用库内已存的加密 corpsecret 解密后去拉取，前端只接收明文 userid/name 列表。
4. **`touser` 存储格式**：SQLite 中以 `|` 分隔（如 `user1|user2`），读取时 `notifier.js:274` split 为数组。

## 3. 方案

**方案 A（采用）**：新增专用"拉取成员"接口 + 内联展开编辑区 + 保存复用已有 PUT 接口。

- 后端新增 `GET /api/configuration/:code/users`：解密库内 corpsecret → 调企业微信 → 返回成员列表 + 当前已选。
- 保存完全复用已有 `PUT /api/configuration/:code`，前端只传 `{ touser: [...] }`。`updateConfiguration`（`notifier.js:295-331`）已天然支持"只传 touser、其他字段保留原值"的部分更新。
- 前端在查找结果下方内联展开编辑卡片，复用第一步的成员勾选 DOM 风格。

**已排除**：
- 方案 B（让查找接口返回 corpsecret 给前端走 `/api/validate`）—— 破坏安全模型。
- 方案 C（保存也单独搞一个接口）—— `updateConfiguration` 已支持部分更新，没必要。

## 4. 后端设计

### 4.1 新增路由 `GET /api/configuration/:code/users`

文件：`src/api/routes.js`

- 中间件：`requireAuth`（与管理类接口一致）。
- 调用 `notifier.getConfigMembers(code)`。
- 成功 → `200`，返回 `{ users, current }`。
- 失败 → `400`，返回 `{ error }`。常见失败：code 不存在、corpsecret 失效、服务器 IP 未加入企业微信白名单。错误信息直接透传 `wechat.getToken` 抛出的原始 errmsg，不做翻译。

```js
router.get('/api/configuration/:code/users', requireAuth, async (req, res) => {
    const { code } = req.params;
    try {
        const result = await notifier.getConfigMembers(code);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message || '获取成员列表失败' });
    }
});
```

### 4.2 新增 `notifier.getConfigMembers(code)`

文件：`src/services/notifier.js`，挂到 `module.exports`。

职责：解密 corpsecret → 拉成员 → 组装返回。

```js
async function getConfigMembers(code) {
    const config = await db.getConfigurationByCode(code);
    if (!config) {
        throw new Error('无效的code，未找到配置');
    }

    const corpsecret = crypto.decrypt(config.encrypted_corpsecret);
    const accessToken = await wechat.getToken(config.corpid, corpsecret);
    const users = await wechat.getAllUsers(accessToken);

    return {
        users: users.map(u => ({
            userid: u.userid,
            name: u.name,
            department: u.department
        })),
        current: config.touser ? config.touser.split('|') : []
    };
}
```

说明：
- 复用 `wechat.getAllUsers`（`wechat.js:361`，已做部门遍历去重）。
- `current` 来自库内 `touser`，供前端做默认勾选。
- **不重新缓存 token**：`wechat.getToken` 自带进程内 Map 缓存（`wechat.js:11`），重复调用不会放大企业微信 API 请求。

### 4.3 保存路径（无新增）

完全复用：
- 路由 `PUT /api/configuration/:code`（`routes.js:141`）。
- `notifier.updateConfiguration`（`notifier.js:295`）已支持：仅传 `touser` 时，其他字段从库内读原值保留（`notifier.js:316-324`）。
- 数据库 `updateConfiguration`（`database.js:119`）整行更新。

前端请求体：`{ "touser": ["user1", "user2"] }`。`updateConfiguration` 内部已做 `Array.isArray ? join('|') : 原值`（`notifier.js:319`），传数组即可。

## 5. 前端设计

### 5.1 触发点

替换 `script.js:297-301` 的占位逻辑。原代码：

```js
document.getElementById('edit-config-btn').addEventListener('click', (e) => {
    const code = e.currentTarget.dataset.code;
    showToast('编辑功能待实现');
});
```

### 5.2 编辑区 DOM 结构

在 `lookupResultDiv` 内、现有配置详情卡片**之后**追加一个编辑卡片 `editSection`。用纯 JS 字符串模板生成（与现有 `lookupResultDiv.innerHTML = ...` 风格一致）。

结构（DaisyUI 类名，与第一步 `index.html:114-117` 的 `userListSection` 一致）：

```html
<div id="edit-section" class="card bg-base-100 shadow-md mt-4">
  <div class="card-body">
    <h2 class="card-title flex items-center gap-2">
      <i data-lucide="user-cog" class="h-5 w-5"></i> 修改发送人员
    </h2>
    <!-- 工具栏：已选计数 + 全选/取消全选 -->
    <div class="flex items-center justify-between">
      <span id="edit-selected-count" class="text-sm text-base-content/70">已选 0 人</span>
      <div class="flex gap-2">
        <button id="edit-select-all" class="btn btn-xs btn-ghost">全选</button>
        <button id="edit-clear-all" class="btn btn-xs btn-ghost">取消全选</button>
      </div>
    </div>
    <!-- 成员列表 -->
    <div id="edit-user-list" class="grid grid-cols-2 gap-2 max-h-60 overflow-y-auto bg-base-100 rounded-lg p-2 border border-base-200"></div>
    <!-- 操作按钮 -->
    <div class="card-actions justify-end mt-2">
      <button id="edit-cancel" class="btn btn-ghost btn-sm">取消</button>
      <button id="edit-save" class="btn btn-primary btn-sm">
        <i data-lucide="save" class="h-4 w-4"></i> 保存修改
      </button>
    </div>
  </div>
</div>
```

### 5.3 交互流程

1. **点"编辑配置"**：按钮变 loading `加载成员...`，禁用；调 `GET /api/configuration/:code/users`。
2. **拉取成功**：渲染编辑区，gsap 淡入（与现有 `gsap.from(... {opacity:0, y:20})` 一致）。渲染复选框时，`current.includes(userid)` 默认勾选。
3. **全选/取消全选**：两个按钮分别 `check all` / `uncheck all` 编辑区内的 `input[type=checkbox]`，并同步更新"已选 X 人"计数。
4. **已选计数实时更新**：每个复选框 `change` 事件触发计数刷新。
5. **保存**：点"保存修改" → 按钮 loading、禁用；收集勾选的 userid 数组；调 `PUT /api/configuration/:code`，body `{ touser: [...] }`。
6. **保存成功**：toast `保存成功` + **重新调查找接口**（刷新 `lookupResultDiv` 让"接收用户"行显示新值）+ 折叠编辑区（移除 `#edit-section`）。
7. **取消**：移除 `#edit-section`，不调任何接口。
8. **再次点"编辑配置"**（编辑区已展开时）：折叠编辑区（toggle），不重复拉取。
9. **加载失败**（如 corpsecret 失效）：编辑区不展开，在 `lookupResultDiv` 内展示 alert 错误信息（原始 errmsg）。

### 5.4 离职员工处理

`current` 里的 userid 可能已不在企业微信返回的成员列表中（员工离职）。处理策略：

- 这些 userid 仍作为复选框渲染，**置灰**（`opacity-50` + `disabled` 属性使其不可取消），默认勾选，名称旁注 `(可能已离职)`。
- 保存时：`disabled` 的复选框不参与表单提交，但**保存逻辑显式收集它们**（因其 `disabled` 浏览器不会带值）。具体实现：渲染时把离职 userid 存入一个 `orphanUserids` 数组，保存时合并进最终 `touser`。
- 理由：避免无声删除用户已配置的接收人；用户若真想删除，可在企业微信后台移除后重新拉取（此时该 userid 自然消失）。

### 5.5 状态管理

沿用现有命令式风格，不引入框架。新增独立变量避免与第一步配置流程串扰：

- `let editUsersCache = []` —— 编辑区当前成员列表。
- `let editCode = null` —— 当前编辑的 code（与 `currentCode` 分开）。
- `let orphanUserids = []` —— 离职 userid。

### 5.6 视觉伴侣（可选）

本设计的 UI 是对现有组件的复用（复选框网格、card、gsap 动效），无新颖视觉问题，不使用浏览器视觉伴侣。

## 6. 数据流

```
[拉取]
点编辑 → GET /api/configuration/:code/users
       → db.getConfigurationByCode → crypto.decrypt(corpsecret)
       → wechat.getToken → wechat.getAllUsers
       → 返回 { users, current }
       → 前端渲染（current 默认勾选）

[保存]
点保存 → PUT /api/configuration/:code  body { touser: [...] }
       → notifier.updateConfiguration（其余字段保留原值）
       → db.updateConfiguration（touser 存为 user1|user2）
       → 成功 → 前端重新查找 + 折叠编辑区
```

## 7. 错误处理

| 场景 | HTTP | 前端展示 |
|------|------|---------|
| code 不存在 | 400 | alert：`无效的code，未找到配置` |
| corpsecret 失效（被重置） | 400 | alert：原始 errmsg（如 `invalid corpid or corpsecret`） |
| 服务器 IP 未加白名单 | 400 | alert：原始 errmsg（如 `not allow to access from your ip`） |
| 保存时勾选为空 | —— | 前端拦截：`请至少选择一个成员`，不发请求 |
| 保存时 code 不存在 | 500→优化为 404 | alert：错误信息（沿用 `routes.js:118` 已有逻辑） |

注：保存接口 `routes.js:141` 当前失败统一返回 500。code 不存在场景下 `updateConfiguration` 会抛 `无效的code`，建议顺手把该路由的错误码优化为 404（与 `/api/notify` 的 `routes.js:118` 处理一致），属于本次改动范围内的小改进。

## 8. 测试要点

手动验证（本项目无自动化测试基建）：

1. 查找一个已存在的配置 → 点"编辑配置" → 成员列表加载、当前 touser 默认勾选。
2. 全选 / 取消全选 → 计数同步、复选框状态正确。
3. 改动后保存 → toast 成功 → 查找结果"接收用户"行刷新为新值。
4. 取消按钮 → 编辑区移除，配置未变。
5. code 错误 → 友好错误提示。
6. corpsecret 失效场景 → 原始 errmsg 展示（需用一个错误 secret 模拟）。
7. 离职员工：构造 `current` 含一个不在列表的 userid → 渲染置灰、保存仍包含它。
8. 空勾选保存 → 前端拦截不发请求。

## 9. 改动清单

| 文件 | 改动 |
|------|------|
| `src/services/notifier.js` | 新增 `getConfigMembers(code)`，加入 exports |
| `src/api/routes.js` | 新增 `GET /api/configuration/:code/users`；`PUT /api/configuration/:code` 错误码 500→404（code 不存在时） |
| `public/script.js` | 替换编辑按钮占位逻辑；新增编辑区渲染、全选/计数、保存、取消、toggle、离职处理 |
| `public/index.html` | 无需改动（编辑区由 JS 动态生成） |

## 10. 非功能考量

- **安全**：corpsecret 全程不出库，前端不接触任何密钥；新接口受 `requireAuth` 保护。
- **性能**：成员拉取走 `wechat.getToken` 的进程内缓存，多配置共享同一 corpid+corpsecret 时只请求一次 token。
- **向后兼容**：纯新增能力，不改动现有配置/通知/回调流程。
- **YAGNI**：不做删除配置、批量管理、修改其他字段——超出当前目标。
