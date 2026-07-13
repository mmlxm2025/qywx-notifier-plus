# 多应用管理二次修复复验、缺陷清单与 AI 执行指南

> 日期：2026-07-04
> 复验分支：`feature/multi-app`
> 复验提交：`06c590ccd3ebed279228e200cbe4b5baefc4a0d7`
> 上一轮复验基线：`efbaa52`
> 关联文档：
>
> - `2026-07-04-multi-app-management-design.md`
> - `2026-07-04-multi-app-management-fix-verification-ai-execution-guide.md`

## 1. 结论先行

本轮修复已经关闭上一轮的大部分核心问题：AgentID 编辑判重进入事务、失败写入不再提前失效 token、草稿 body version 能区分缺失与非法、`legacy-grace` 路由已删除、真实 Express 路由矩阵已补充，总览开关的目标布尔值反转也已修正。

但是当前版本仍不建议发布，存在 2 项 P0：

1. 旧 CBC CorpSecret 的惰性迁移会在 CorpSecret 更新提交后，把旧 secret 重新覆盖回数据库；接口返回成功且版本递增，但实际凭证未更新。
2. 编辑页修改默认接收成员成功后，页面用旧 `currentMembers.current` 重建选择器；下一次保存其他字段时，会把旧接收人再次提交，形成静默数据回退。

此外还有请求体错误返回不一致、向导误判 `INVALID_INPUT`、规则页异步隔离不完整、发送额度幽灵占用等 P1。自动化测试全绿不能覆盖这些问题，因为当前前端测试主要检查纯 helper 或源码形状，真实服务器测试默认跳过，服务端也缺少旧密文与请求解析失败的回归场景。

发布判断：**阻断发布，完成本文阶段 A～F 后再执行完整发布验收。**

## 2. 本轮验证证据

### 2.1 自动化结果

| 检查 | 结果 |
|---|---|
| `npm test` | 228 项：219 通过、0 失败、9 跳过 |
| `npm run test:isolated` | 228 项：219 通过、0 失败、9 跳过 |
| JS 语法检查 | `public/`、`src/` 共 25 个 JS 文件通过 |
| 覆盖率 | 行 72.21%、分支 71.76%、函数 70.13% |
| 关键覆盖率 | `routes.js` 67.41%、`database.js` 60.61%、`notifier.js` 77.73% |
| 依赖审计 | 0 个高危生产依赖漏洞 |
| 差异空白检查 | 通过 |

说明：9 项 `test/live-server-contract.test.js` 用例因缺少真实服务器环境变量而默认跳过，不能把它们计入发布通过项。

### 2.2 已确认关闭的上一轮问题

| 上一轮问题 | 当前状态 | 证据 |
|---|---|---|
| 并发编辑 AgentID 可形成重复身份 | 已关闭 | `updateConfigurationAtomic()` 在 `BEGIN IMMEDIATE` 内重读版本、判重和更新；真实 SQLite 并发测试通过 |
| 版本冲突前失效旧 token | 已关闭 | token 清理移动到数据库提交后；冲突时失效次数为 0 |
| 非法 body version 被误报 428 | 后端已关闭 | `parseBodyVersion()` 区分缺失、非法、合法；`"abc"`/`0` 返回 400 |
| `legacy-grace` 业务假成功 | 路由能力已删除 | service、route、API 文档均不再暴露该能力 |
| 管理写接口没有真实 HTTP 矩阵 | 部分关闭 | 已有 Express + fetch 测试；但未使用生产 `server.js` 完整中间件链 |
| 规则页跨应用成员倒灌 | 部分关闭 | 已清空旧成员并增加代次守卫；规则与成员仍共用一个守卫，冲突恢复仍可跨应用写入表单 |
| 编辑冲突丢非敏感输入 | 部分关闭 | 描述、AgentID、回调开关已恢复；接收人只快照未恢复 |
| 向导冲突与重复完成恢复 | 部分关闭 | 已处理版本冲突和 AgentID 核对；普通 `INVALID_INPUT` 会被误当版本异常 |
| 总览开关布尔值反转 | 已关闭 | `target` 已直接读取 change 后的 `cb.checked` |

## 3. P0：必须在发布前修复

### P0-01：惰性密文迁移覆盖刚提交的新 CorpSecret

#### 现象

真实内存 SQLite 复现结果：

```json
{
  "resultVersion": 2,
  "rowVersion": 2,
  "storedPlaintext": "old-secret",
  "cipherFormat": "v2"
}
```

请求把 `old-secret` 修改为 `new-secret`，接口返回成功且版本从 1 变成 2，但最终数据库保存的是重新加密后的 `old-secret`。

#### 根因

- `src/services/notifier.js:114-123` 的 `decryptWithLazyMigration()` 发现旧 CBC 密文后，异步执行无条件更新：`UPDATE configurations SET field = ? WHERE code = ?`。
- `src/services/notifier.js:1824-1829` 在 CorpSecret 事务提交成功后，为失效旧 token 再次调用该函数解密旧密文。
- 这次惰性迁移排在已提交的新 secret 后执行，因此把旧 secret 重新写回；SQL 不校验“字段仍等于旧密文”，也不受应用版本保护。
- 同一无条件迁移还可能与成员读取、发送、其他管理写请求竞争。

启动迁移通常会先处理旧密文，但逐行迁移失败后服务仍会启动；滚动部署、遗留异常数据或未来兼容写入仍会进入惰性路径。因此不能把启动迁移当作正确性保证。

#### 必须实施的修复

1. 惰性迁移改为比较后写入：

   ```sql
   UPDATE configurations
   SET encrypted_corpsecret = ?
   WHERE code = ? AND encrypted_corpsecret = ?
   ```

   AESKey 等惰性迁移字段采用相同规则。只有字段仍是本次读取的旧密文时才能替换表示形式。

2. 动态列名必须使用内部白名单，不允许任意字符串插入 SQL。
3. 修改 CorpSecret 时，在事务前用“只解密、不触发迁移”的函数保存 `oldSecret`；提交成功后只用它失效旧 token，不再启动旧值迁移。
4. 表示形式迁移不递增业务 `version`，但必须使用旧密文比较条件，避免覆盖业务写入。
5. 启动批量迁移也建议采用 `WHERE code = ? AND field = ?`，为多实例滚动启动提供同样保护。

#### 必测场景

- 真实 SQLite：旧 CBC secret 更新为新 secret，返回成功后解密数据库字段必须等于新 secret。
- 惰性迁移已排队、并发更新新 secret：迁移 `changes=0`，新 secret 不被覆盖。
- 仅做 CBC→GCM 表示迁移时，业务版本不增加。
- CorpSecret 更新冲突时，不失效 token、不迁移旧值、不改变数据库。
- AgentID-only 更新仍能用旧 secret 验证，且不会覆盖并发 secret 更新。

### P0-02：默认接收人保存成功后会被旧选择器状态静默回退

#### 确定性路径

1. 初始接收人为 `alice`，`currentMembers.current = ['alice']`。
2. 用户改为 `bob`，保存请求正确提交 `touser=['bob']`。
3. `public/edit.js:212-221` 成功后调用 `refreshSummary()`。
4. `public/edit.js:279-287` 只重读应用详情，却直接使用旧 `currentMembers` 调用 `renderPicker()`。
5. 新选择器重新显示 `alice`，而 `original.touser` 已是服务端最新的 `bob`。
6. 用户再修改描述并保存，`buildPayload()` 会把选择器里的 `alice` 识别为接收人变化并一并提交，服务端的 `bob` 被静默改回 `alice`。

版本锁无法阻止这个问题，因为第二次请求使用的是最新版本，属于前端错误构造的合法写入。

#### 冲突恢复也未完成

- `public/edit.js:230-235` 已把 `touser` 放入快照。
- `public/edit.js:241-253` 只恢复描述、AgentID、回调开关，明确没有把 `snapshot.touser` 写回选择器。
- `loadApp()` 在 `public/edit.js:105` 没有等待 `loadMembers()`，即使立即恢复选择器，也可能被稍后返回的成员请求再次覆盖。
- 模态文案声称“保留你的非敏感输入”，与实际行为不一致。

#### 必须实施的修复

1. `loadApp()` 必须 `await loadMembers(false)`，调用完成时要保证 picker 已基于最新服务端数据建立。
2. `refreshSummary()` 不得用旧 `currentMembers.current` 重建 picker。可选方案：
   - 重读详情后再调用成员接口；成员接口的 `current` 每次由最新配置计算；或
   - 用最新详情的 `touser` 作为 picker 的显式选中值，并重新计算 orphan。
3. 给 `AppRecipientPicker` 增加受控的 `setValue()`，或允许 `renderPicker(selectionOverride)`；恢复值中不可见的 UserID 必须作为 orphan 显示，不能丢弃。
4. 版本冲突确认流程必须等待最新详情和成员加载完成，再恢复描述、AgentID、回调开关、默认接收人。
5. 敏感字段仍不得快照或恢复。
6. 安全设置冲突刷新不得顺带清空主编辑表单；可保存非敏感草稿，或只刷新安全分区和版本。

#### 必测场景

- `alice → bob` 保存成功后 picker 仍显示 `bob`。
- 随后只改描述，请求体不得包含 `touser`，数据库仍是 `bob`。
- 409 后空描述、AgentID、回调开关和接收人全部恢复；secret/token/AESKey 清空。
- 冲突期间成员请求延迟返回，不得覆盖恢复后的选择。
- 快照含不可见成员时，以 orphan 形式恢复。

## 4. P1：高优先级正确性与契约问题

### P1-01：配置更新缺 body 返回 500，畸形 JSON 返回 HTML

#### 已复现

```json
[
  {
    "label": "missing-body",
    "status": 500,
    "contentType": "application/json; charset=utf-8",
    "body": "Cannot read properties of undefined (reading 'corpid')"
  },
  {
    "label": "malformed-json",
    "status": 400,
    "contentType": "text/html; charset=utf-8"
  }
]
```

根因：

- `src/api/routes.js:419-425` 仍把 `req.body` 原样传给 `updateConfiguration()`；缺 body 时 service 访问 `newConfig.corpid` 抛 TypeError。
- `server.js:42-46` 安装 JSON parser，但没有 parser 错误处理中间件；畸形 JSON 由 Express 默认 HTML 错误页处理。
- `sendError()` 对无业务码的 5xx 不补 `INTERNAL_ERROR`。

修复要求：

1. 所有要求 JSON 对象的写接口统一使用 `requireJsonObjectBody`；缺失、数组、primitive 返回 `400 INVALID_INPUT`。
2. `updateConfiguration(code, newConfig = {}, ...)` 做 service 防御，但不能只靠默认值掩盖路由契约。
3. 给生产 JSON parser 增加错误中间件：解析失败返回 JSON `400 INVALID_INPUT`；过大返回 JSON 413；不返回 HTML/堆栈。
4. 未预期 5xx 统一 `{ error: '服务器内部错误', code: 'INTERNAL_ERROR' }`。
5. HTTP 测试必须使用 `jsonBodyParser()`，不能只用测试里的 `express.json()` 替代生产链路。

### P1-02：向导把所有 INVALID_INPUT 都误判为版本异常

- `public/wizard.js:199-210` 在生成回调失败时，把任何 `INVALID_INPUT` 当成版本变化并读取 `/api/configuration/${draft.code}`。
- 新建草稿时 `draft.code` 为空；例如 AESKey 格式错误会额外请求 `/api/configuration/null`，随后提示“草稿已不存在”，掩盖真实字段错误。
- `public/wizard.js:344-348` 完成配置时也把 AgentID、接收人等普通输入错误当成版本异常，可能形成无意义重试。

修复要求：

1. body version 非法仍可保留 `400 INVALID_INPUT`，但后端增加 `details.field='version'`；缺失版本继续使用 `APP_VERSION_REQUIRED`。
2. 前端只在 `APP_VERSION_CONFLICT`、`APP_VERSION_REQUIRED` 或 `INVALID_INPUT + details.field==='version'` 时同步版本。
3. 普通 `INVALID_INPUT` 直接显示服务端字段错误，不读取空 code。
4. `APP_VERSION_REQUIRED` 且尚无 `draft.code` 时也不得请求详情。

### P1-03：规则页代次守卫仍可把旧应用表单恢复到新应用

当前 `rules.js` 的规则请求和成员请求共用一个 `requestGuard`：

- `refreshRulesData()` 在 `public/rules.js:239-257` 推进代次。
- `loadMembers()` 在 `public/rules.js:285-311` 再次推进同一代次。
- 并发的成员刷新会让规则刷新被判为过期，反之亦然。
- `handleRuleWriteConflict()` 在 `public/rules.js:115-125` 不检查 `refreshRulesData()` 是否成功，也不检查应用是否已切换；即使旧应用响应被丢弃，仍会把旧表单快照恢复到当前新应用。
- 切换开始时旧规则 DOM 未立即清空/禁用，用户仍可能操作旧行。

修复要求：

1. 规则、成员、应用列表使用独立请求守卫；应用切换时统一使所有旧请求失效。
2. 冲突处理捕获 `conflictCode`，只有 `currentCode === conflictCode` 且最新规则成功返回时才恢复表单。
3. 切换应用立即清空或禁用旧规则操作区，并将 `currentAppVersion` 置空，直到新响应成功。
4. `finally` 只能由当前请求恢复按钮状态，旧请求不得提前解锁新请求的按钮。
5. 规则启停请求期间禁用 toggle，避免快速双击并发提交同一版本。

### P1-04：总览开关失败后 checkbox 与文字不一致，业务术语也发生漂移

- `public/script.js:289-293` 在 change 时立即更新文字。
- `public/script.js:335-345` 失败时只回滚 checkbox，没有回滚文字；网络错误后可能出现“勾选 + 已停用”或“未勾选 + 启用”。
- 设计文档把它定义为“应用发送总开关”；最新 UI 只显示“启用/已停用”，容易被理解为整个应用不可管理，而实际暂停只阻止发送。

建议统一为“发送已启用 / 发送已暂停”，并保留辅助说明“暂停不影响编辑、规则和安全设置”。失败时用同一个 `renderToggleState(checked)` 同时更新 checkbox、文字和 ARIA。

### P1-05：成员限频拒绝会永久占用当日应用额度

真实复现（每日额度 2、成员每分钟额度 1）：

```json
[
  { "code": "r-a", "result": "ok" },
  { "code": "r-a", "result": "error", "status": 429, "message": "成员 alice 已达到每分钟保护" },
  { "code": "r-b", "result": "error", "status": 429, "message": "已接近应用每日人次限制" }
]
```

第二次请求没有发送，但第三次发给另一个成员也被每日额度拒绝。

根因：`src/services/notifier.js:1482-1486` 先执行 `trackAppDaily()`，随后 `trackExplicitMembers()` 可直接抛错；这个抛错发生在现有 try/catch 之前，当日额度没有回滚。

修复：捕获成员预占异常并调用 `rollbackReservation(config, target, null)` 后再抛出。增加“成员限频失败不消耗每日额度”的回归测试。

### P1-06：稳定错误码尚未覆盖管理读取与 parser 错误

当前仍有以下跨层不一致：

- `requireAuth` 返回 401 但没有 `AUTH_REQUIRED`。
- `GET /api/configuration/:code` 不存在时只有 `{error}`，没有 `APP_NOT_FOUND`。
- `getConfigMembers()` 不存在时没有 `APP_NOT_FOUND`；未完成时返回旧的 400，而设计要求 `409 APP_NOT_COMPLETED`。
- 未预期 5xx、畸形 JSON 和请求体过大没有统一 JSON 错误码。

前端虽然常用 HTTP 状态兜底，但设计目标是“HTTP + 稳定 code 驱动恢复”，应补齐并冻结 HTTP 响应快照。

### P1-07：旧版本请求仍会先调用企业微信，再返回版本冲突

`completeConfiguration()` 和 `updateConfiguration()` 都在事务 CAS 前做在线凭证验证。若请求版本已明显落后：

- 仍会获取 token、调用企业微信接口并增加延迟；
- 无效凭证可能先返回 `WECHAT_CREDENTIAL_INVALID`，掩盖应优先处理的 `APP_VERSION_CONFLICT`；
- 攻击者可用旧版本请求制造不必要的上游调用。

修复方式：读取配置并解析版本后，先做一次只读的版本快速失败，再做在线验证，最后仍由事务内 CAS 重新校验，不能用快速检查替代原子校验。

## 5. P2：优化与技术债

1. `public/login.js` 忽略 `/login?next=`，登录成功和已登录检查都固定跳 `/`；应只接受同源路径并恢复原页面。
2. 规则页仍维护第二套成员选择逻辑，没有接入 `AppRecipientPicker` 的 rule 模式，公共组件与真实页面继续漂移。
3. `legacy-grace` 删除后仍残留 `legacy_until` 白名单/查询、`notify-auth.js` 的 `LEGACY_GRACE_MS` 和旧注释，`docs/QA_TEST_REPORT_2026-07-04.md` 仍宣称端点存在。数据库列可为回滚保留，但运行时代码和发布文档应明确清理。
4. HMAC nonce 只按裸 nonce 全局判重，不按应用/密钥分区；不同应用相同 nonce 会互相拒绝。建议使用 `hash(notifyKey):nonce`，并设置真正的硬容量淘汰。
5. Modal 在异步确认期间仍可用 ESC 或遮罩关闭；删除/轮换可能在界面显示“取消”后实际成功。busy 时应禁止关闭，或显示“操作正在完成”。
6. 总览 `loadApps()`、编辑成员刷新缺少请求所有权；较旧响应可能覆盖较新刷新结果。
7. `parsePositiveInt()` 应使用 `Number.isSafeInteger()`；description、CorpSecret、Token 等字段需显式类型和长度限制，避免错误输入变成 500。
8. 旧表约束 `UNIQUE(corpid, agentid, touser)` 仍可能让历史重复身份在治理接收人时触发原始 SQLite 500；至少应翻译为稳定业务错误，长期再评估安全重建表。
9. 多实例部署下 token 之外的限流、nonce、发送去重和缓存均为进程内状态；部署文档应明确“单实例”，或迁移到共享存储。
10. 管理写操作缺少结构化审计日志：request ID、应用 code、脱敏企业、旧/新生命周期、版本、结果码和删除规则数。
11. `server.js:isSecureRequest()` 仍直接信任 `X-Forwarded-Proto`；应只依赖 Express 在正确 `trust proxy` 下计算的 `req.secure`。

## 6. 前端—后端—业务目的的一致性矩阵

| 业务结果 | 后端现状 | 前端现状 | 判定 |
|---|---|---|---|
| CorpSecret 修改后立即使用新值 | CAS 与 token 时序已正确 | 成功提示正常 | **P0：旧密文惰性迁移会写回旧值** |
| 默认接收人修改不被后续操作覆盖 | touched-field + version 正确 | 保存后选择器回到旧 current | **P0：下一次保存可静默回退** |
| 版本冲突保留所有非敏感输入 | 后端返回最新 version | 描述等恢复，touser 未恢复 | 部分完成 |
| 向导字段错误就近提示 | 后端统一 `INVALID_INPUT` | 全部被当版本异常 | 不一致 |
| 跨应用切换绝不混用数据 | 后端按 code 隔离 | 规则冲突快照可恢复到新应用 | 不一致 |
| 暂停只阻止发送 | 后端语义正确 | “启用/已停用”可能暗示应用整体停用 | 文案需收口 |
| 请求格式错误始终返回稳定 JSON | route 业务错误大多 JSON | AppHttp 期望 JSON | parser HTML / PUT 缺 body 500 |
| 失败发送不占额度 | 发送失败大多回滚 | 无直接展示 | 成员预检失败漏回滚 |
| 会话失效返回原页面 | 后端可登录 | `next` 被忽略 | 未完成 |

## 7. AI 分阶段执行指令

以下顺序不可调整。每阶段先写失败测试，再修改实现；禁止一次性大改后补测试。

### 阶段 A：冻结 P0 复现

新增测试：

- `test/backend-lazy-migration-cas.test.js`
  - 真实内存 SQLite 插入 CBC secret；更新为新 secret 后断言数据库为新 secret。
  - 人工排队惰性迁移与业务更新，断言旧值条件更新为 0 changes。
- `test/frontend-edit-recipient-state.test.js`
  - 至少冻结“成功刷新采用服务端最新 touser”“冲突快照 touser 被实际消费”。
  - 不允许只断言 `snapshotEditForm()` 返回了 touser，必须断言页面状态恢复路径调用它。

验收：新测试在旧实现上稳定失败，失败原因分别指向旧 secret 覆盖和旧接收人回退。

### 阶段 B：修复密文迁移正确性

修改：

- `src/services/notifier.js`
- 必要时 `src/core/database.js`

要求：

1. 提供不触发迁移的解密路径。
2. 惰性迁移执行旧值条件更新和字段白名单。
3. CorpSecret 提交前捕获旧明文，提交后只做 token 失效。
4. 不改变应用业务版本语义。

验收：阶段 A 后端测试、token 时序测试、全量 SQLite 事务测试全部通过。

### 阶段 C：修复编辑页受控状态

修改：

- `public/edit.js`
- `public/components/recipient-picker.js`
- `public/frontend-helpers.js`（如需纯状态 helper）
- 对应前端测试

要求：

1. 详情与成员加载组成一个可等待的刷新操作。
2. picker 支持显式 selection override 或 `setValue()`。
3. 成功保存与 409 恢复都以最新服务端摘要为基线，再叠加用户非敏感草稿。
4. 安全设置独立写操作不得清空未保存主表单。

验收：`alice → bob → 只改描述` 的第二次请求不含 touser；冲突后 touser 完整恢复。

### 阶段 D：统一请求体和错误契约

修改：

- `src/core/body-parser.js`
- `server.js`
- `src/api/routes.js`
- `src/services/notifier.js`
- `test/backend-management-http-matrix.test.js`

要求：

1. 管理写接口统一校验 JSON object。
2. parser 400/413、认证 401、读取 404/409、意外 500 均返回 JSON + 稳定 code。
3. 测试使用生产 body parser；覆盖无 body、非 JSON Content-Type、畸形 JSON、数组、primitive、超限。
4. 不在响应中返回 TypeError、SQL、路径或堆栈。

### 阶段 E：修复向导和规则页异步一致性

修改：

- `public/wizard.js`
- `public/rules.js`
- `public/script.js`
- 相应行为测试

要求：

1. `INVALID_INPUT` 按 `details.field` 分流，普通字段错误不刷新版本。
2. 规则/成员使用独立守卫，冲突恢复绑定原 code。
3. 应用切换期间旧操作区不可用。
4. 所有 toggle 请求期间锁定，失败同时回滚值、文字、ARIA。
5. 文案统一为发送启用/暂停，不暗示应用不可管理。

### 阶段 F：修复额度回滚并清理技术债

修改：

- `src/services/notifier.js`
- `src/core/notify-auth.js`
- `public/components/modal.js`
- `public/login.js`
- API/README/QA 文档

要求：

1. 成员预占失败回滚应用每日额度。
2. HMAC nonce 按密钥/应用分区并有硬上限。
3. Modal busy 时不可被误关闭。
4. 安全消费 `next`，只允许同源路径。
5. 清理已删除 legacy-grace 的运行时代码与过时文档，但保留数据库列时写明回滚原因。

## 8. 每阶段通用约束

1. 不删除或覆盖现有两份历史复验文档。
2. 不使用 `git reset --hard`、`git checkout --` 等破坏用户工作区的命令。
3. 不把前端状态修复做成中文文案匹配；只使用 HTTP、`code`、`details`。
4. 不移除事务内版本重检；事务外快速版本检查只能减少无效上游调用。
5. 不把网络调用放进 SQLite 写事务。
6. 敏感值不得进入响应、日志、DOM 非密码区、sessionStorage 或测试快照。
7. 前端测试不能只用 `source.includes()` 证明行为；关键状态恢复必须执行真实函数或浏览器流程。
8. 每个修复提交保持单一主题，并同步更新 API 文档和错误矩阵。

## 9. 最终发布验收清单

### 自动化

- [ ] `npm test` 全通过且无意外跳过。
- [ ] `npm run test:isolated` 全通过。
- [ ] 真实服务器契约测试在临时数据库上实际运行，不再 SKIP。
- [ ] 旧 CBC secret 更新回归通过。
- [ ] 接收人保存后连续第二次保存回归通过。
- [ ] 畸形 JSON、缺 body、数组 body 均返回稳定 JSON。
- [ ] 成员限频失败不消耗每日额度。
- [ ] `git diff --check` 通过。

### 浏览器行为

- [ ] 修改默认接收人成功后刷新、再改描述，接收人不回退。
- [ ] 编辑 409 后非敏感输入全部保留，敏感输入清空。
- [ ] 新建向导 AESKey 错误显示字段错误，不请求 `/configuration/null`。
- [ ] 规则页快速切换 A/B 应用，旧规则、成员、冲突表单均不会进入 B。
- [ ] 总览开关网络失败后 checkbox、文字和服务端状态一致。
- [ ] 安全设置冲突不会清空未保存的描述/AgentID/接收人。
- [ ] Modal 异步删除/轮换期间不能被 ESC 或遮罩伪取消。
- [ ] 登录失效后重新登录能回到原同源页面。

### 数据与业务

- [ ] 同企业不同 AgentID 可独立创建；同身份并发只能一个成功。
- [ ] 暂停同时拦截配置 Code 和全部规则 API，但管理功能仍可用。
- [ ] 所有成功写入均可立即读到新状态；不得出现“版本已增加、值仍是旧值”。
- [ ] 删除事务、规则版本、token 清理和历史重复治理回归通过。
- [ ] 列表、详情、规则页对生命周期、能力、告警、版本使用同一语义。
- [ ] API 文档、README、QA 报告与实际路由一致。

## 10. 可直接交给 AI 的执行提示

```text
请严格按《2026-07-04-multi-app-management-second-fix-review-ai-execution-guide.md》阶段 A→F 执行。

先阅读多应用设计文档和前两轮复验文档。每一阶段必须：
1. 先添加能在当前代码上失败的回归测试；
2. 只修改该阶段列出的文件和必要依赖；
3. 运行定向测试、npm test、npm run test:isolated；
4. 汇报行为变化、测试证据和剩余风险；
5. 不使用破坏性 Git 命令，不覆盖用户已有文档。

阶段 A/B 的旧 CBC secret 覆盖与阶段 A/C 的默认接收人静默回退是发布阻断项，未关闭前不得宣称可发布。事务外版本快速检查不能替代事务内 CAS，网络调用不得进入 SQLite 写事务。前端不得依赖中文错误文案，敏感字段不得快照或持久化。
```
