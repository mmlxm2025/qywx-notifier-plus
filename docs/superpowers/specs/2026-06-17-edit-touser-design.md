# 查找已有配置后修改发送人员 - 设计文档

- 日期：2026-06-17
- 状态：待审查（v2 — 结合企业微信官方 API 规范完善）
- 范围：前端 UI（`public/index.html`、`public/script.js`）+ 后端（`src/api/routes.js`、`src/services/notifier.js`、`src/core/wechat.js`）

## 1. 背景与目标

当前"查找已有配置"区域（`index.html:130-145`）查出配置后，"编辑配置"按钮仅是占位（`script.js:300` `showToast('编辑功能待实现')`）。

目标：在用户查找已有配置后，支持**修改该配置的发送人员（touser）**，并通过复选框勾选成员、全量提交保存。

核心策略（用户确认）：**重新拉取全员列表 + 全量更新发送人员**。即编辑时重新拉一次完整成员列表呈现给用户，保存时用勾选结果整体覆盖 `touser`，不做增量 diff。

非目标（YAGNI，本期不做）：
- 修改 corpid / corpsecret / agentid / 回调配置
- 删除配置
- 批量管理多个配置
- 重构原有 `getAllUsers`（保留给配置流程，本功能走专用方法）

## 2. 企业微信官方 API 规范要点

本节为本次改动所依据的企业微信官方规范，源自开发者中心文档（见第 11 节"参考文档"）。实现必须符合这些规范。

### 2.1 access_token 规范

| 维度 | 规范 | 本项目现状 |
|------|------|-----------|
| 接口 | `GET https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=&corpsecret=` | `wechat.js:27` 符合 |
| 有效期 | 7200 秒（2 小时），**必须自行缓存**，禁止每次业务请求都获取 | `wechat.js:11` 进程内 Map 缓存，提前 5 分钟过期，符合 |
| 频率限制 | gettoken 本身有限制（每企业 1 万次/分）；业务接口另有每企业/每 IP 限制 | 依赖缓存规避，符合 |
| token 失效处理 | `errcode 42001`（过期）/`40014`（不合法）应触发重新获取 | **本项目未做自动重试**（已知限制，见第 9 节）|

### 2.2 获取成员列表 —— 接口选择规范

企业微信提供三个相关接口，权限与返回字段差异显著：

| 接口 | 路径 | 返回字段 | 权限要求 |
|------|------|---------|---------|
| 获取部门成员（简要） | `/cgi-bin/user/simplelist` | userid、name、department、open_userid | 通讯录基础读取 |
| 获取部门成员详情 | `/cgi-bin/user/list` | 上述 + 手机号、邮箱、头像、性别等敏感字段 | **更高通讯录权限** |
| 获取成员ID列表 | `/cgi-bin/user/list_id` | 仅 userid | 最低权限 |

**关键决策**：本功能只需 `userid` + `name`（用于复选框展示和保存），应使用 **`user/simplelist`**（[path/90200](https://developer.work.weixin.qq.com/document/path/90200)），而非项目现有的 `user/list`（详情接口）。

理由：
1. `user/list` 拉取大量敏感字段（手机号/邮箱等），**需要更高通讯录权限**，很多自建应用权限不足会直接失败。
2. `simplelist` 返回数据量小、响应快、权限门槛低，完全满足"勾选发送人员"的需求。

### 2.3 `fetch_child` 递归参数规范（关键）

`simplelist` 和 `list` 都支持 `fetch_child` 参数：

```
fetch_child: 1/0   // 是否递归获取子部门下的成员
department_id: 必填 // 根部门 id=1
```

**官方推荐做法**：对**根部门 `department_id=1` 传 `fetch_child=1`**，**一次调用即可拉取全公司成员**，无需遍历部门列表。

本项目现有 `getAllUsers`（`wechat.js:361`）的做法：
- ❌ 未传 `fetch_child`，靠遍历 `department/list` 逐个部门调用
- ❌ N+1 串行调用（`for...of`），部门多时放大请求数，易触发频率限制
- ❌ 多部门成员靠内存 `Set` 去重

**本功能新增专用方法 `getDepartmentUsers`，采用 simplelist + fetch_child=1 一次拉取全公司**，规避上述问题。

### 2.4 通讯录可见范围限制（关键业务约束）

> 应用**只能获取"可见范围"内的成员信息**。不在可见范围的成员，拉取列表时**不会返回**。

对本功能的直接影响：

- 用户 A 配置时选了张三、李四。后来管理员调整应用可见范围移除张三，或张三离职 → 重新拉取时张三不在列表里。
- 但 `touser` 库里还存着张三的 userid。
- 若直接用新列表覆盖，会**无声丢失张三**——可能导致关键告警收不到。

→ 由此引出第 6.4 节"不可见成员/离职成员的保留处理"。

### 2.5 全局错误码规范

本次功能需正确识别并提示的错误码（来自 [path/90313](https://developer.work.weixin.qq.com/document/path/90313)）：

| errcode | 含义 | 本功能触发场景 | 处理 |
|---------|------|--------------|------|
| `0` | 成功 | 正常 | 返回数据 |
| `40014` | 不合法的 access_token | 极少（有缓存） | 提示重试 |
| `42001` | access_token 已过期 | 缓存失效边界 | 提示重试 |
| `40056` | 不合法的 agentid | 配置错误 | 提示检查配置 |
| `60011` | 无权限/通讯录权限不足 | 应用不可见该成员或无通讯录权限 | 提示管理员检查应用可见范围与通讯录权限 |
| `45009` | 接口调用超过限制 | 高频调用 | 提示稍后重试 |
| `-1` | 系统繁忙 | 偶发 | 提示稍后重试 |

当前代码统一抛 `获取成员列表失败: ${errmsg} (${errcode})`，前端透传展示——满足"可见性"，本功能沿用此模式。

## 3. 关键约束（实现红线）

1. **安全模型不可破坏**：`getConfiguration`（`notifier.js:266-287`）不返回 corpsecret。前端永远拿不到密钥，成员列表由后端用库内加密 secret 解密后拉取。
2. **遵循 simplelist + fetch_child 规范**：不走详情接口、不遍历部门。
3. **全量更新语义**：保存时以勾选结果整体覆盖 `touser`。
4. **不可见成员不可无声丢失**：库里已有但拉取列表里没有的 userid，必须保留呈现给用户决策。
5. **`touser` 存储格式**：SQLite 中以 `|` 分隔，读取时 split 为数组（`notifier.js:274`）。

## 4. 方案

**方案 A（采用）**：后端新增专用拉成员接口（走 simplelist + fetch_child 规范）+ 前端内联展开编辑区 + 保存复用已有 PUT 接口（全量覆盖 touser）。

- 后端新增 `GET /api/configuration/:code/users`：解密库内 corpsecret → 调企业微信 `simplelist` → 返回成员列表 + 当前已选。
- 保存完全复用已有 `PUT /api/configuration/:code`，前端只传 `{ touser: [...] }`。
- 前端在查找结果下方内联展开编辑卡片，复用第一步的成员勾选 DOM 风格。

**已排除**：
- 方案 B（让查找接口返回 corpsecret 给前端走 `/api/validate`）—— 破坏安全模型。
- 方案 C（保存也单独搞一个接口）—— `updateConfiguration` 已支持部分更新，没必要。

## 5. 后端设计

### 5.1 新增 wechat 方法 `getDepartmentUsers`（遵循规范）

文件：`src/core/wechat.js`

职责：用 `simplelist` + `fetch_child=1` 对根部门一次性拉取全公司成员。**不复用 `getAllUsers`**（其 N+1 问题见第 2.3 节）。

```js
// 获取部门成员（简要列表，递归根部门，一次拉全公司）
// 遵循官方规范：simplelist + fetch_child=1，避免 N+1 调用
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

        // simplelist 返回 { userlist: [{userid, name, department, open_userid}] }
        return data.userlist || [];
    } catch (error) {
        console.error('获取部门成员失败:', error.message);
        throw error;
    }
}
```

说明：
- 用 `simplelist` 而非 `list`：只需 userid+name，避免拉敏感字段和权限不足（第 2.2 节）。
- `fetch_child=1`：递归子部门，一次拉全公司，规避 N+1（第 2.3 节）。
- 返回字段映射：`simplelist` 返回的 `department` 是部门 id 数组，前端展示用 `name` 即可，部门信息非必需。

### 5.2 新增路由 `GET /api/configuration/:code/users`

文件：`src/api/routes.js`

- 中间件：`requireAuth`（与管理类接口一致）。
- 调用 `notifier.getConfigMembers(code)`。
- 成功 → `200`，返回 `{ users, current, orphan }`。
- 失败 → `400`，返回 `{ error }`，透传企业微信原始 errmsg。

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

### 5.3 新增 `notifier.getConfigMembers(code)`

文件：`src/services/notifier.js`，挂到 `module.exports`。

职责：解密 corpsecret → 拉成员 → 计算"不可见成员" → 组装返回。

```js
async function getConfigMembers(code) {
    const config = await db.getConfigurationByCode(code);
    if (!config) {
        throw new Error('无效的code，未找到配置');
    }

    const corpsecret = crypto.decrypt(config.encrypted_corpsecret);
    const accessToken = await wechat.getToken(config.corpid, corpsecret);
    const users = await wechat.getDepartmentUsers(accessToken);

    const current = config.touser ? config.touser.split('|') : [];

    // 计算"不可见成员"：库里有、但企业微信返回列表里没有的 userid
    // 原因：成员离职、或被移出应用可见范围（第 2.4 节）
    const visibleUserids = new Set(users.map(u => u.userid));
    const orphan = current.filter(uid => !visibleUserids.has(uid));

    return {
        users: users.map(u => ({
            userid: u.userid,
            name: u.name
        })),
        current,
        orphan
    };
}
```

说明：
- `users`：当前可见的成员（可勾选）。
- `current`：库里现存的 touser（用于默认勾选）。
- `orphan`：库里有但拉不回来的 userid（离职/不可见），前端单独置灰展示。
- 复用 `wechat.getToken`（自带缓存，见第 2.1 节），不重复请求 token。

### 5.4 保存路径（无新增）

完全复用：
- 路由 `PUT /api/configuration/:code`（`routes.js:141`）。
- `notifier.updateConfiguration`（`notifier.js:295`）支持部分更新：仅传 `touser` 时其他字段保留原值（`notifier.js:319`）。

前端请求体：`{ "touser": ["user1", "user2"] }`。`updateConfiguration` 内部已做数组 → `|` 分隔（`notifier.js:319`）。

## 6. 前端设计

### 6.1 触发点

替换 `script.js:297-301` 的占位逻辑。

### 6.2 编辑区 DOM 结构

在 `lookupResultDiv` 内、现有配置详情卡片**之后**追加编辑卡片 `editSection`（纯 JS 字符串模板，与现有风格一致）。

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
    <!-- 成员列表（可勾选） -->
    <div id="edit-user-list" class="grid grid-cols-2 gap-2 max-h-60 overflow-y-auto bg-base-100 rounded-lg p-2 border border-base-200"></div>
    <!-- 不可见成员区（如有） -->
    <div id="edit-orphan-section" class="hidden mt-2">
      <div class="text-xs text-warning mb-1">以下人员当前不可见（已离职或不在应用可见范围），保留勾选则会继续发送给TA：</div>
      <div id="edit-orphan-list" class="flex flex-wrap gap-2"></div>
    </div>
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

### 6.3 交互流程

1. **点"编辑配置"**：按钮 loading `加载成员...`、禁用；调 `GET /api/configuration/:code/users`。
2. **拉取成功**：渲染编辑区，gsap 淡入。可勾选复选框中，`current.includes(userid)` 默认勾选。
3. **全选/取消全选**：两个按钮分别全选/全不选 `#edit-user-list` 内的复选框（不影响 orphan 区），并同步计数。
4. **已选计数实时更新**：每个复选框 `change` 事件触发计数刷新。
5. **保存**：收集 `#edit-user-list` 内勾选的 userid + orphan 区仍勾选的 userid，合并去重 → 调 `PUT /api/configuration/:code`，body `{ touser: [...] }`。
6. **保存成功**：toast `保存成功` + 重新调查找接口（刷新"接收用户"行）+ 折叠编辑区。
7. **取消**：移除 `#edit-section`，不调接口。
8. **再次点"编辑配置"**（编辑区已展开时）：折叠编辑区（toggle），不重复拉取。
9. **加载失败**（corpsecret 失效/权限不足）：编辑区不展开，在 `lookupResultDiv` 内展示 alert（透传 errmsg）。

### 6.4 不可见成员/离职成员的保留处理（规范合规）

基于第 2.4 节"可见范围限制"，后端返回的 `orphan` 数组单独渲染在 `#edit-orphan-section`：

- 每个 orphan userid 渲染为一个**带复选框的小标签**（默认勾选），标签显示 userid（因拉不回 name）。
- 用户可主动取消勾选来删除该接收人，或保留勾选继续发送给 TA。
- **保存时显式合并 orphan 中仍勾选的项**（因它们不在主列表，主列表的"全选"操作不覆盖它们）。
- 设计意图：**避免无声丢失已配置的接收人**——这是企业微信可见范围机制下最容易踩的坑。

### 6.5 空成员/边界场景

- 拉取的 `users` 为空：展示提示"未获取到任何成员，请检查应用可见范围与通讯录权限"（对应 errcode 60011 类场景），不展开可勾选区。
- `current` 与 `users` 完全一致、无 orphan：orphan 区不显示（`hidden`）。
- 保存时全部取消勾选（含 orphan）：前端拦截 `请至少选择一个成员`，不发请求。

### 6.6 状态管理

沿用现有命令式风格，新增独立变量避免与第一步配置流程串扰：

- `let editUsersCache = []` —— 编辑区可见成员列表。
- `let editCode = null` —— 当前编辑的 code。
- `let editOrphan = []` —— 不可见 userid 列表。

### 6.7 视觉伴侣（可选）

本设计的 UI 是对现有组件的复用（复选框网格、card、gsap 动效），无新颖视觉问题，不使用浏览器视觉伴侣。

## 7. 数据流

```
[拉取]
点编辑 → GET /api/configuration/:code/users
       → db.getConfigurationByCode
       → crypto.decrypt(corpsecret)
       → wechat.getToken（走缓存）
       → wechat.getDepartmentUsers（simplelist + fetch_child=1）
       → 计算 orphan = current - visibleUserids
       → 返回 { users, current, orphan }
       → 前端渲染（current 默认勾选，orphan 单独区）

[保存]
点保存 → 合并 [勾选的可见] + [仍勾选的 orphan] → 去重
       → PUT /api/configuration/:code  body { touser: [...] }
       → notifier.updateConfiguration（其余字段保留原值）
       → db.updateConfiguration（touser 存为 user1|user2）
       → 成功 → 前端重新查找 + 折叠编辑区
```

## 8. 错误处理

| 场景 | HTTP | errcode | 前端展示 |
|------|------|---------|---------|
| code 不存在 | 400 | —— | `无效的code，未找到配置` |
| corpsecret 失效 | 400 | 42001/40014 | 透传 errmsg（如 `invalid corpid or corpsecret`） |
| 通讯录权限不足 | 400 | 60011 | 透传 errmsg + 提示检查应用可见范围 |
| IP 未加白名单 | 400 | 60020 | 透传 errmsg（如 `not allow to access from your ip`） |
| 接口超频 | 400 | 45009 | 透传 errmsg + 提示稍后重试 |
| 保存时勾选为空 | —— | —— | 前端拦截：`请至少选择一个成员` |
| 保存时 code 不存在 | 404 | —— | 错误信息（`routes.js:141` 错误码优化 500→404） |

注：保存接口 `routes.js:141` 当前失败统一 500。code 不存在时 `updateConfiguration` 抛错，建议把该路由错误码优化为 404（与 `/api/notify` 的 `routes.js:118` 一致），属本次范围内的小改进。

## 9. 已知限制（不在本次范围，记录备查）

1. **access_token 失效自动重试**：当前遇到 `42001/40014` 不会自动清缓存重取 token。可在后续给 `getToken` 加失败重试逻辑。
2. **多实例 token 缓存**：进程内 Map，多实例部署时各实例独立缓存。若部署规模扩大，应迁移到 Redis。
3. **原有 `getAllUsers` 的 N+1 问题**：本功能绕开它走 `getDepartmentUsers`，但配置流程（`/api/validate`）仍用 `getAllUsers`。后续可统一改造（不在本次范围，避免回归风险）。
4. **`45009` 退避重试**：超频时未做指数退避，仅提示用户。

## 10. 测试要点

手动验证（本项目无自动化测试基建）：

1. 查找已存在配置 → 点编辑 → 成员列表加载（验证 simplelist+fetch_child 生效）、当前 touser 默认勾选。
2. 全选 / 取消全选 → 计数同步、复选框正确。
3. 改动保存 → toast 成功 → 查找结果"接收用户"行刷新。
4. 取消 → 编辑区移除，配置未变。
5. code 错误 → 友好提示。
6. corpsecret 失效（用错误 secret 模拟）→ 原始 errmsg 展示。
7. **不可见成员**：构造 current 含一个不在返回列表的 userid → orphan 区显示、默认勾选、保存仍包含它。
8. orphan 取消勾选 → 保存后该 userid 从 touser 移除。
9. 全部取消勾选（含 orphan）→ 前端拦截不发请求。
10. 可见范围为空（模拟 60011）→ 提示检查可见范围。

## 11. 改动清单

| 文件 | 改动 |
|------|------|
| `src/core/wechat.js` | 新增 `getDepartmentUsers`（simplelist + fetch_child=1） |
| `src/services/notifier.js` | 新增 `getConfigMembers(code)`（含 orphan 计算），加入 exports |
| `src/api/routes.js` | 新增 `GET /api/configuration/:code/users`；`PUT /api/configuration/:code` 错误码 500→404 |
| `public/script.js` | 替换编辑按钮占位逻辑；新增编辑区渲染、全选/计数、orphan 区、保存、取消、toggle |
| `public/index.html` | 无需改动（编辑区由 JS 动态生成） |

## 12. 非功能考量

- **安全**：corpsecret 全程不出库；新接口受 `requireAuth` 保护；用 simplelist 避免拉取敏感字段。
- **合规**：遵循官方 simplelist + fetch_child 规范，规避 N+1 和权限问题。
- **性能**：单次 simplelist 调用拉全公司；token 走缓存。
- **向后兼容**：纯新增能力，不改现有配置/通知/回调流程。
- **YAGNI**：不做删除配置、批量管理、修改其他字段、token 自动重试。

## 13. 参考文档

- [获取 access_token — path/91039](https://developer.work.weixin.qq.com/document/path/91039)
- [访问频率限制 — path/96212](https://developer.work.weixin.qq.com/document/path/96212)
- [全局错误码 — path/90313](https://developer.work.weixin.qq.com/document/path/90313)
- [获取部门成员（simplelist）— path/90200](https://developer.work.weixin.qq.com/document/path/90200)
- [获取部门成员详情（list）— path/90201](https://developer.work.weixin.qq.com/document/path/90201)
- [获取部门列表 — path/90208](https://developer.work.weixin.qq.com/document/path/90208)
- [通讯录同步概述 — path/90329](https://developer.work.weixin.qq.com/document/path/90329)
