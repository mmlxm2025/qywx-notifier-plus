# 多应用管理代码审查、缺陷修复与 AI 执行指南

> **审查状态**：发现发布阻断项，当前分支不建议合并或发布  
> **审查日期**：2026-07-04  
> **审查分支**：`feature/multi-app`  
> **审查基线**：`9d44f0c`（相对 `dev@562e047`）  
> **原设计**：`docs/superpowers/specs/2026-07-04-multi-app-management-design.md`  
> **本文用途**：交给 AI/开发者按顺序修复，不直接改写业务目标，不以修改文档掩盖代码偏差。

---

## 0. 执行结论

当前实现已完成大部分页面、生命周期序列化、应用总开关、详情脱敏和基础测试，但仍有 5 类发布阻断问题：

1. SQLite 事务没有真正独占共享连接，其他请求的写入可以混入事务并被错误回滚。
2. 向导、Code 发送开关、规则写入等关键路由没有正确传递版本，部分 UI 操作必然失败，部分操作绕过并发控制。
3. 规则变更没有与应用聚合版本原子提交，删除影响预览可能在规则变化后仍使用旧版本继续删除。
4. `/api/configure` 和完成草稿没有在事务中维护“一企业一 AgentID 一应用”的身份不变量，并发时可生成重复应用。
5. 测试大量使用桩或源码字符串断言，关键真实数据库和 HTTP 路径没有覆盖，所以 138 项全绿仍未发现上述问题。

修复原则：**先补失败测试，再修后端原子性和路由契约，最后修前端与文档。禁止先改测试期望让现状“看起来一致”。**

---

## 1. 已完成的验证

| 检查 | 结果 |
|---|---|
| 工作区 | 审查开始时干净 |
| 功能提交 | 8 个，范围从测试、后端、UI 到文档 |
| `npm.cmd test` | 138 通过、0 失败 |
| `npm.cmd run test:isolated` | 138 通过、0 失败 |
| 前端 JavaScript 语法 | 11 个文件全部通过 `node --check` |
| 后端关键文件语法 | database/notifier/routes 全部通过 |
| 测试覆盖率 | 总行覆盖率 65.77%；`routes.js` 58.73%，`database.js` 44.71% |
| 真实 SQLite 事务并发诊断 | 失败：事务外写入在事务回滚前已返回成功，最终却被回滚 |

真实事务诊断结果：

```json
{
  "race": "outside-resolved-before-rollback",
  "txResult": "forced rollback",
  "finalDescription": "original"
}
```

这证明当前 `withTransaction()` 的注释与真实行为不一致：调用方收到普通写入成功，但该写入实际上加入了另一请求的事务，随后被回滚。

---

## 2. 缺陷总表

### 2.1 P0：发布阻断，必须优先修复

| ID | 缺陷 | 业务影响 | 主要证据 |
|---|---|---|---|
| P0-01 | 事务锁没有拦截普通数据库操作 | 无关请求可能被别人的回滚撤销；存在真实数据一致性风险 | `database.js:148-167,471-496,545-552` |
| P0-02 | Code 发送开关路由丢失 `If-Match` | 编辑页和规则页切换该开关都会返回 428，功能不可用 | `routes.js:499-510` 对比 `notifier.js:1810-1847` |
| P0-03 | 规则写入未执行版本前置条件和原子版本递增 | 并发覆盖；删除预览后新增规则仍可能被未展示地删除 | `routes.js:386-423,515-527`、`notifier.js:1005-1099` |
| P0-04 | 草稿路由丢弃 `draft_code/version`，service 对 CAS 失败返回假成功 | 草稿回退更新无法工作；过期完成请求可能报告 active 但未写库 | `routes.js:172-194`、`notifier.js:708-848` |
| P0-05 | 应用身份不变量存在旁路和竞态 | 同一 `(corpid,agentid)` 可通过 `/api/configure` 或并发完成产生多行 | `notifier.js:782-940` |

### 2.2 P1：合并前应完成

| ID | 缺陷 | 影响 | 主要证据 |
|---|---|---|---|
| P1-01 | `/api/validate` 仍使用路由层第二个 `WeChatService` | token 缓存未收口；向导拿不到计划中的稳定微信错误码 | `routes.js:7-15,155-168` |
| P1-02 | 规则页仍保留安全设置、原生 fetch/confirm，且未携带版本 | 与“唯一编辑位置”冲突；通知密钥操作返回 428；错误码无法恢复 | `rules.html:73-126`、`rules.js:97-108,245-386,569-718` |
| P1-03 | 列表有重复身份告警，详情/规则摘要没有 | 同一应用在总览显示告警，进入编辑页告警消失 | `notifier.js:942-1003,1375-1397` |
| P1-04 | DELETE 缺少版本时被解析成版本 0 | 应返回 428，却可能返回 409 版本冲突 | `notifier.js:396-404,1602-1613` |
| P1-05 | 更新 CorpSecret 在 CAS 提交前失效旧 token | 版本冲突也会产生无意义缓存失效和额外 token 请求 | `notifier.js:1534-1562` |
| P1-06 | 编辑页版本冲突“保留输入”与实际行为不符 | 确认刷新会调用 `loadApp()` 覆盖非敏感输入；安全开关成功后原始状态未同步 | `edit.js:198-286` |
| P1-07 | `legacy-grace` 绕过应用版本 | README 所称“所有聚合写操作需 If-Match”不成立 | `routes.js:530-540`、`notifier.js:1849-1862` |

### 2.3 P2：优化和一致性收口

| ID | 建议 | 说明 |
|---|---|---|
| P2-01 | 统一路由错误处理 | users/rules/code-send/rule-enabled/legacy-grace 仍使用旧字符串映射或裸 `{error}` |
| P2-02 | 统一页面基础组件 | rules/api-docs/login 未接入统一 styles/topnav/http；rules 仍有两套安全设置 |
| P2-03 | 修正登录返回地址 | `AppHttp` 生成 `next`，但 login.js 完全忽略；注释与行为不一致 |
| P2-04 | 模态框请求期间锁定关闭动作 | 当前异步危险操作期间仍可 ESC/遮罩/取消，用户可能误认为操作已取消 |
| P2-05 | 明确多实例限制 | `app_enabled` 缓存失效只在当前进程生效；多副本下其他实例最多继续使用旧 target 60 秒 |
| P2-06 | 增加结构化管理日志 | 设计中的完成、暂停、恢复、删除、密钥变更日志尚未实现 |

---

## 3. 关键缺陷详解

### 3.1 P0-01：事务并未独占共享连接

#### 现状

- `withTransaction()` 只让其他 `withTransaction()` 通过 `_txChain` 排队。
- 普通 `runRaw()`、`get()`、`allRaw()` 完全不读取 `_txChain` 或 `_inTransaction`。
- 事务的 `tx.run/get/all` 又直接调用相同的公共方法。

因此普通请求可以在 `BEGIN IMMEDIATE` 与 `COMMIT/ROLLBACK` 之间执行，并自动成为当前事务的一部分。

#### 必须采用的修复结构

```text
公共 runRaw/get/allRaw
  → enqueueOperation(task)
  → private _runDirect/_getDirect/_allDirect

withTransaction(fn)
  → enqueueOperation(exclusive task)
  → _runDirect(BEGIN IMMEDIATE)
  → fn({ run:_runDirect, get:_getDirect, all:_allDirect })
  → _runDirect(COMMIT) 或 _runDirect(ROLLBACK)
```

要求：

1. 每个公共数据库操作都经过同一条 Promise 队列。
2. 事务内部只使用不再入队的 private direct 方法，避免自锁。
3. 事务 callback 禁止调用普通 `db.*`；代码审查和测试同时约束。
4. `close()` 也应排到队列末尾。
5. 移除未发挥作用的 `_inTransaction`，或只用于断言错误调用，不能把它当锁。

#### 必须新增的真实测试

新建 `test/backend-database-transaction.test.js`，使用临时 SQLite 文件而不是 prototype 桩：

- 事务内第一条写入完成后用 Promise barrier 暂停。
- 同时发起普通 `runRaw()`。
- 在事务释放前，普通写入不得 resolve。
- 强制事务回滚后，普通写入再执行并最终保留。
- 再测试 COMMIT 路径和多个事务顺序。

验收：不得再出现“outside-resolved-before-rollback”。

### 3.2 P0-02/P0-04：版本在路由、service、DAO 之间断链

#### 当前契约矩阵

| 操作 | 前端是否发送版本 | 路由是否转发 | service 是否强制 | 当前结果 |
|---|---:|---:|---:|---|
| 编辑应用 | 是，If-Match | 是 | 是 | 基本可用 |
| 删除应用 | 是，If-Match | 是 | 是 | UI 可用；缺头状态码错误 |
| 应用总开关 | 是，If-Match | 是 | 是 | 基本可用 |
| Code 发送开关 | 是，If-Match | **否** | 是 | **固定返回 428** |
| 编辑页通知密钥 | 是，If-Match | 是 | 是 | 可用 |
| 规则页通知密钥 | **否** | 路由要求 | 是 | **固定返回 428** |
| 更新草稿回调 | body 有 version | **draft_code/version 被丢弃** | **否** | 返回草稿冲突或绕过版本 |
| 完成草稿 | body 有 version | **version 被丢弃** | **否** | 绕过版本 |
| 规则增删改/重生成 | 否 | 否 | 否 | 绕过聚合版本 |
| 规则启停 | 否 | 否 | 只做尽力 bump | 非原子、可丢版本 |
| legacy grace | 否 | 否 | 否 | 绕过聚合版本 |

#### 修复要求

1. 新增统一 `requireIfMatch`/`parseIfMatch` 中间件：
   - 缺失：428 `APP_VERSION_REQUIRED`。
   - 非正整数、弱格式非法：400 `INVALID_INPUT`。
   - 与当前聚合版本不一致：409 `APP_VERSION_CONFLICT`，`details.version` 返回最新版本。
   - 成功：写入 `req.expectedVersion`。
2. 管理写路由只使用 `req.expectedVersion`，不再在各路由重复解析。
3. `/api/generate-callback` 显式转发 `draft_code/version`。
4. `/api/complete-config` 显式转发 `version`。
5. `/code-send` 传入原始 `enabled` 和 `{ expectedVersion }`，不能先用真值表达式静默转换。
6. `deleteConfiguration()` 在 `null/undefined` 时先返回 428，禁止 `Number(null) === 0`。
7. `createCallbackConfiguration()` 和 `completeConfiguration()`：
   - draft 更新/完成必须要求正整数版本。
   - 必须检查 DAO `changes`。
   - changes=0 后区分 404、非草稿、版本冲突，禁止硬编码成功状态。
8. 新草稿创建返回 HTTP 201；更新现有草稿返回 200。

### 3.3 P0-03：规则变更没有聚合事务

#### 现状

- create/update/regenerate/delete 不读取或递增应用版本。
- enabled 先写规则，再调用 `bumpAppVersion()`；bump 失败被吞掉。
- 规则写成功与版本递增不在一个事务。
- 路由和 rules.js 都未传 If-Match。

#### 正确模型

为规则操作新增数据库事务方法：

```text
mutateRuleWithAppVersion(rule/config identity, expectedVersion, mutation)
  BEGIN IMMEDIATE
  读取所属应用并检查 completed + version
  执行规则 INSERT/UPDATE/DELETE
  UPDATE configurations
    SET version = version + 1
    WHERE code = ? AND version = ?
  COMMIT
  返回 rule result + app_version
```

要求：

- create 由 config code 找应用；其他操作由 rule id 在事务内找 `config_code`。
- 草稿返回 409 `APP_NOT_COMPLETED`。
- 规则不存在返回 404 `RULE_NOT_FOUND`。
- 应用版本不匹配时规则不得变化。
- 任一步失败全部回滚。
- 删除预览读取的 config.version 可可靠阻止预览后新增/修改规则。
- 删除 `bumpAppVersion()`“尽力而为”实现。
- `setRuleEnabled` 使用 `toStrictBoolean()`，拒绝模糊值。

#### 路由和前端

- 所有规则写路由接入 `requireIfMatch`。
- 成功返回 `app_version`。
- rules.js 保存 `currentAppVersion = listRules().config.version`。
- 每次写入携带版本，成功后采用服务端 `app_version`，不能本地 `+1`。
- 冲突时保留规则表单内容，刷新列表后让用户重新确认。

### 3.4 P0-05：应用身份不变量未原子执行

#### 现状

- `completeConfiguration()` 在事务外先查冲突，再验证微信，再单独 UPDATE。
- `/api/configure` 仍按 `(corpid,agentid,touser,callback_enabled)` 判重；换一组 touser 就能创建同 AgentID 的第二行。
- 当前数据库唯一约束也包含 touser，不能代替应用身份约束。

#### 修复要求

在线微信验证可以在事务外执行，避免长期持有写锁；验证成功后的数据库阶段必须原子：

```text
BEGIN IMMEDIATE
重新读取 draft/code + expected version + lifecycle
检查不存在其他完成的 (corpid, agentid)
按 code + version + draft 条件更新，version + 1
COMMIT
```

`/api/configure` 必须复用相同的身份事务：

```text
BEGIN IMMEDIATE
检查 (corpid, agentid) 完成应用
有冲突 → APP_IDENTITY_CONFLICT + existing_code
无冲突 → INSERT
COMMIT
```

同时修复并发创建草稿：查询已有草稿与 INSERT 必须在同一事务；若唯一约束竞争失败，应翻译为 `APP_DRAFT_EXISTS`，不能返回裸 SQLite 500。

### 3.5 P1-01：微信验证仍有两个 service 实例

#### 修复要求

- 删除 routes.js 中 `WeChatService`、`config` 和 `wechat` 实例。
- notifier 新增或扩展一个方法，完成：getToken → getAgentInfo → getAgentVisibleUsers。
- `/api/validate` 只调用 notifier，并用 `sendError()` 返回稳定业务码。
- 参数错误也返回 `{error, code:'INVALID_INPUT'}`。
- 增加测试：route 与发送使用同一 notifier `_internal.wechat`，凭证错误为 `WECHAT_CREDENTIAL_INVALID`，网络错误为 `WECHAT_UNAVAILABLE`。

### 3.6 P1-02：规则页没有完成迁移

规则页当前同时显示“去编辑页管理安全设置”的链接和旧的 Code/密钥控件，形成两个编辑位置；旧控件又没有版本头。

按原设计执行：

1. 从 rules.html 删除 `code-send-panel` 和 `notify-key-panel`。
2. 从 rules.js 删除对应状态、事件和一次性密钥渲染逻辑。
3. 接入 `styles.css`、`http.js`、`topnav.js`、`modal.js`、`toast.js`。
4. 用 `AppHttp` 取代本地 `requestJson` 和裸 fetch。
5. 用 `AppModal` 取代规则重生成/删除的 `window.confirm`。
6. 只保留应用上下文、暂停横幅和“前往安全设置”链接。
7. 严格读取后端 `lifecycle_status/capabilities`，删除本地 fallback 推导。

### 3.7 P1-03/P1-06：跨页面状态仍不一致

- `duplicate_identity` 只在 listConfigurations 计算；详情和 listRules 没传 duplicateMap。
- 编辑页因此永远看不到重复身份横幅。
- Code 开关成功后只更新 `version`，未更新 `original.code_send_enabled`；后续失败回滚可能显示错误状态。
- 版本冲突弹窗声称保留输入，确认后调用 `loadApp()` 实际覆盖所有非敏感输入。

修复：

1. 抽出 `getDuplicateWarningForConfig(config)` 或批量 helper，三个读取接口统一调用。
2. 安全开关成功后同步 `original` 中的对应状态。
3. 版本冲突前快照非敏感表单；加载最新摘要后重新应用用户改动并展示差异。
4. CorpSecret/Token/AESKey 明确清空并提示重输，不得复制或持久化。

---

## 4. AI 执行顺序

### 阶段 A：先补会失败的测试

**只改测试，不改实现。**

新增：

- `test/backend-database-transaction.test.js`
- `test/backend-management-routes.test.js`
- `test/backend-rule-version.test.js`
- `test/backend-identity-transaction.test.js`
- `test/frontend-wizard-route-contract.test.js`
- `test/frontend-rules-page-behavior.test.js`

最低失败用例：

1. 普通 runRaw 在事务结束前不能 resolve。
2. 回滚不能撤销事务外调用方的成功写入。
3. `/code-send` 带 If-Match 成功并返回新版本。
4. `/code-send` 缺 If-Match 返回 428。
5. generate-callback 路由保留 draft_code/version。
6. complete-config 路由保留 version，旧版本返回 409 而不是成功。
7. 每个规则写接口缺版本 428、冲突 409、成功返回 app_version。
8. 规则 SQL 失败时应用版本不变；版本更新失败时规则回滚。
9. `/api/configure` 不能创建重复 `(corpid,agentid)`。
10. 两个并发完成请求只能一个成功。
11. rules.html 不再包含安全设置控件和 `window.confirm`。

阶段验收：新测试必须按预期失败，旧 138 项仍通过。

### 阶段 B：修复数据库执行队列和事务

**允许修改**：`src/core/database.js`、事务测试。

执行 3.1 的 direct/private + 全局队列结构。随后把以下操作改成数据库事务方法：

- 删除配置及规则。
- 完成草稿。
- 单次创建配置。
- 创建/更新/启停/重生成/删除规则并递增应用版本。

阶段验收：真实 SQLite 并发测试全部通过；任何事务外操作都不能混入。

### 阶段 C：修复路由版本和错误契约

**允许修改**：`src/api/routes.js`、`src/services/notifier.js`、管理路由测试。

- 实现统一 If-Match 中间件。
- 转发 draft_code/version。
- 修复 code-send、rules、legacy-grace。
- 严格布尔解析。
- 全部使用 sendError，不再使用中文字符串状态映射。
- 修复 delete 的 null→0。

阶段验收：API 文档列出的每个写接口均有真实 HTTP 成功/缺版本/冲突测试。

### 阶段 D：修复身份与草稿状态机

**允许修改**：database/notifier/routes 及身份测试。

- 原子维护 `(corpid,agentid)`。
- CAS changes=0 不能返回成功。
- 并发草稿转换为稳定错误。
- `/api/configure` 无旁路。
- 微信验证失败不进入数据库事务。

阶段验收：并发测试循环执行不少于 20 次，始终只有一个应用身份成功。

### 阶段 E：修复规则页和编辑页

**允许修改**：`public/rules.html`、`public/rules.js`、`public/edit.js`、相关前端测试。

- 完成规则页公共组件迁移。
- 删除重复安全设置。
- 规则写入完整版本链路。
- 版本冲突保留非敏感输入。
- 安全开关同步 original 状态。

阶段验收：不依赖源码字符串断言；使用最小 DOM/fetch mock 执行真实事件流程。

### 阶段 F：统一验证、序列化、日志和文档

**允许修改**：notifier/routes、README、api-docs、QA 文档。

- 收口 WeChatService。
- 三个读取接口统一 warnings。
- 增加提交后结构化管理日志，不记录敏感值。
- 文档最后更新，确保不再描述尚未实现的能力。
- 记录修复后测试总数和真实覆盖率。

---

## 5. 测试与验收矩阵

### 5.1 必跑命令

```powershell
npm.cmd test
npm.cmd run test:isolated
node --test --test-isolation=none --experimental-test-coverage test/*.test.js
```

并对所有变更脚本执行 `node --check`。

### 5.2 后端验收

- 同一企业不同 AgentID：均成功，code 不同。
- 同一企业相同 AgentID：顺序和并发创建都只允许一个。
- 草稿更新和完成：缺版本 428、旧版本 409、成功版本 +1。
- 应用/安全/规则所有写接口：版本行为一致。
- 规则变更后旧删除预览必须冲突。
- 任意事务故障不留下半配置、半规则或错误版本。
- 暂停应用时 direct/rule 都 403；管理 API 可用。
- 微信凭证错误/网络错误具有稳定 code。

### 5.3 前端验收

- 新建、恢复、回退修改回调、完成全流程。
- 编辑页 Code 开关和通知密钥均成功；冲突能恢复。
- 规则增删改、启停、重生成均携带版本并更新 app_version。
- 规则页没有第二套安全设置，没有原生 confirm。
- 总览、编辑、规则对 duplicate/active/paused 状态一致。
- sessionStorage、DOM、响应和日志没有 secret/token/aeskey 明文残留。

### 5.4 发布门槛

- P0、P1 全部关闭。
- 新增真实 SQLite 和 HTTP 集成测试，不允许全部由 prototype stub 代替。
- `database.js` 行覆盖率至少覆盖事务队列、CAS、规则聚合事务和回滚路径。
- `routes.js` 覆盖全部新增管理写路由。
- README/API 文档与真实 curl 响应一致。
- 工作区干净，每个阶段独立提交。

---

## 6. 建议提交顺序

1. `test(multi-app): expose transaction and route contract gaps`
2. `fix(database): serialize all operations around transactions`
3. `fix(config): make draft completion and identity writes atomic`
4. `fix(api): enforce versions across management routes`
5. `fix(rules): mutate rules and app version atomically`
6. `refactor(wechat): route validation through notifier service`
7. `refactor(rules-ui): remove duplicate security controls and use shared clients`
8. `fix(edit-ui): preserve conflict input and synchronize switch state`
9. `test(multi-app): add real sqlite http and frontend behavior regressions`
10. `docs: align multi-app contracts with verified implementation`

每个提交都必须通过普通和 isolated 测试。不要把数据库队列、规则 UI 和文档揉成一个大提交。

---

## 7. AI 执行约束

AI 执行本文时必须遵守：

1. 不修改“一应用一 Code、身份为 `(corpid,agentid)`”的业务决定。
2. 不通过放宽 If-Match、吞掉版本错误或删除测试来换取测试通过。
3. 不新增破坏性数据库迁移，不自动合并历史重复应用。
4. 不在事务内执行企业微信网络请求。
5. 不记录或返回 CorpSecret、回调 Token、AESKey、通知密钥明文。
6. 不在前端匹配中文错误字符串。
7. 不让前端本地猜版本号。
8. 不保留规则页和编辑页两套安全设置。
9. 发现设计与本文冲突时停止，列出冲突和影响，不自行扩大范围。
10. 每完成一个阶段，报告：修改文件、关闭的缺陷 ID、测试结果、剩余风险。

### AI 阶段完成报告模板

```text
阶段：B 数据库事务
关闭：P0-01
修改：src/core/database.js, test/backend-database-transaction.test.js
验证：npm test / test:isolated / 指定并发测试
结果：通过数、失败数
未完成：列出缺陷 ID
风险：是否存在兼容或迁移影响
下一步：阶段 C
```

---

## 8. 审查后可做的优化（不阻塞首轮修复）

1. 抽取 `requirePageAuth`，替代 5 处重复页面守卫。
2. 给 `configurations(corpid,agentid)` 增加普通索引，加速身份检查；暂不建 UNIQUE，避免历史重复升级失败。
3. 为大量应用的规则计数分批查询，避免超过 SQLite 变量数上限。
4. 明确仅支持单实例；若未来多副本，使用共享缓存失效/消息通知保证暂停立即生效。
5. 登录页安全消费同源 `next` 参数，或删除未实现的返回地址功能。
6. 模态框异步确认期间禁用 ESC、遮罩和取消，并让危险操作默认聚焦取消。
7. 将 `getConfigurationUsersStatus/getRuleStatus` 全部替换为稳定业务错误。
8. 清理未使用的 `originalHtml`、历史 DAO `updateConfiguration/getCallbackConfiguration` 和过时注释。

---

## 9. 最终判定

功能方向正确，已完成的生命周期、脱敏、总览和测试框架可以保留；问题主要集中在“最后一公里”的原子性与契约接线。由于 P0-01 已用真实 SQLite 复现，且多个页面操作存在确定性 428，当前版本不能仅凭 138 项测试通过进入发布。

按本文 A→F 顺序修复后，再进行一次独立代码审查和完整多应用手工矩阵，方可把状态改为“可发布”。
