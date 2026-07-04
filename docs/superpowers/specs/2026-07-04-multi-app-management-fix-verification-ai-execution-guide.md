# 多应用管理修复复验、缺陷清单与 AI 执行指南

> 日期：2026-07-04  
> 复验分支：`feature/multi-app`  
> 复验提交：`efbaa52`  
> 对照基线：`9d44f0c`  
> 上一版审查：`docs/superpowers/specs/2026-07-04-multi-app-management-code-review-fix-guide.md`  
> 本文用途：指导下一轮 AI 先补失败测试，再修复遗留缺陷；不是需求草案，也不是已完成声明。

---

## 1. 复验结论

本轮修复有效关闭了共享 SQLite 事务串入、规则写入与应用版本非原子、草稿版本丢失、兼容创建/完成身份竞态、Code 发送开关缺版本、规则页重复安全设置等主要问题。普通测试、隔离测试和真实 SQLite 事务诊断均通过。

但当前版本仍不建议直接发布，原因是应用身份不变量只覆盖了“新建”和“完成草稿”，没有覆盖“编辑 AgentID”：两个已完成应用并发修改为同一个目标 AgentID 时可以同时成功，最终产生新的重复身份。这直接违反设计不变量“新建、完成或实际改变 AgentID 后，不得与另一行拥有相同 `(corpid, agentid)`”。

发布判定：

- P0：1 项，必须修复后再发布。
- P1：6 组，建议在本次多应用版本一起收口，否则会出现错误恢复、跨应用陈旧数据或接口语义不一致。
- P2：保留为后续工程质量优化，不阻塞本轮核心修复，但应登记。

---

## 2. 已执行验证

| 检查 | 结果 | 结论 |
|---|---:|---|
| `npm test` | 187/187 通过 | 共享进程模式无回归 |
| `npm run test:isolated` | 187/187 通过 | 测试隔离运行无隐藏依赖 |
| 前后端 JavaScript `node --check` | 21 个文件通过 | 无语法错误 |
| `git diff --check 9d44f0c..HEAD` | 通过 | 无空白符错误 |
| `npm audit --omit=dev --audit-level=high` | 0 个漏洞 | 当前生产依赖未报告已知漏洞 |
| 总行覆盖率 | 69.77% | 修复前为 65.77%，有提升 |
| `src/api/routes.js` 行覆盖率 | 59.53% | 管理写路由仍缺真实 HTTP 覆盖 |
| `src/core/database.js` 行覆盖率 | 58.14% | 修复前为 44.71%，关键事务已有提升 |
| `src/services/notifier.js` 行覆盖率 | 75.93% | 核心服务覆盖较好，但失败副作用仍漏测 |

真实 SQLite 事务诊断结果：

```json
{
  "race": "outside-blocked",
  "txResult": "forced rollback",
  "finalDescription": "outside"
}
```

含义：事务外写入在回滚前没有提前成功，回滚也没有撤销事务外调用方的写入，P0-01 已真实关闭。

真实 SQLite AgentID 编辑竞态诊断结果：

```json
{
  "results": [
    { "code": "a", "changes": 1, "version": 2 },
    { "code": "b", "changes": 1, "version": 2 }
  ],
  "duplicateCount": 2
}
```

含义：两个应用都在事务外查到“无冲突”，随后分别通过各自的版本 CAS；最终同企业出现两个相同 AgentID，身份不变量仍可被并发绕过。

服务副作用与版本错误诊断结果：

```json
{
  "malformedDraft": { "status": 428, "code": "APP_VERSION_REQUIRED" },
  "malformedComplete": { "status": 428, "code": "APP_VERSION_REQUIRED" },
  "staleSecretUpdate": { "status": 409, "code": "APP_VERSION_CONFLICT" },
  "invalidations": 1
}
```

含义：格式错误的 body version 被误报成“缺版本”；CorpSecret 更新最终发生版本冲突时，旧 token 仍被提前失效。

---

## 3. 上一版问题关闭状态

| 原编号 | 状态 | 复验结论 |
|---|---|---|
| P0-01 事务期间普通读写混入 | 已关闭 | 全局操作队列 + direct tx 句柄有效，真实 SQLite 时序正确 |
| P0-02 Code 发送开关丢失 If-Match | 已关闭，测试待加强 | 路由已接 `requireIfMatch`，服务返回新版本；缺真实 HTTP 成功/428/409 测试 |
| P0-03 规则写与应用版本非原子 | 后端已关闭，前端恢复未闭环 | 五类规则写均走事务并返回 `app_version`；规则表单冲突时仍被清空 |
| P0-04 草稿路由丢失 draft_code/version | 核心已关闭，错误恢复未闭环 | 路由已转发；body version 格式错误码和向导冲突恢复仍有问题 |
| P0-05 身份不变量非原子 | 部分关闭，重新打开 | 新建、完成草稿已原子化；编辑 AgentID 仍在事务外判重 |
| P1-01 两个 WeChatService | 已关闭 | `/api/validate` 已复用 notifier 单实例 |
| P1-02 规则页两套安全设置/旧基础设施 | 大部分关闭 | 重复控件已删除并接入公共 HTTP/Modal/Toast；公共接收人组件和状态提示仍未统一 |
| P1-03 三个摘要 warnings 不一致 | 后端已关闭，规则 UI 部分未消费 | 列表/详情/规则摘要均返回统一 warnings；规则页只显示 paused，不显示重复身份 |
| P1-04 null 被解析为版本 0 | 已关闭 | null/undefined 返回 428 |
| P1-05 CAS 前失效旧 token | 未关闭 | `invalidateToken()` 仍位于数据库 CAS 前 |
| P1-06 编辑页冲突保留输入/安全状态漂移 | 部分关闭 | 安全开关同步已修复；空描述和接收成员仍会在冲突刷新后丢失 |
| P1-07 legacy-grace 绕过版本 | 版本问题已关闭，业务语义未生效 | 端点已要求 If-Match，但发送鉴权没有读取 `legacy_until` |

---

## 4. 发布阻断缺陷

### R-P0-01：编辑 AgentID 的身份判重仍非原子

业务目标：任何成功的新建、完成或 AgentID 编辑，都不能新产生重复 `(corpid, agentid)`。

代码证据：

- `src/services/notifier.js:1763-1771` 在事务外调用 `findCompletedByCorpidAgentId()`。
- 企业微信在线验证也在事务外执行，这是正确的；但验证后的数据库阶段仍调用通用 `updateConfigurationFields()`。
- `src/services/notifier.js:1802` 只做当前 code/version 的 CAS，没有在同一事务内重新检查目标身份。
- `src/core/database.js:363-392` 的通用局部更新不包含身份判重。

并发时序：

```text
请求 A：读取应用 A(version=1) ─┐
请求 B：读取应用 B(version=1) ─┤
请求 A：查询目标 AgentID，无冲突
请求 B：查询目标 AgentID，无冲突
请求 A：验证微信成功
请求 B：验证微信成功
请求 A：UPDATE A ... WHERE version=1，成功
请求 B：UPDATE B ... WHERE version=1，成功
结果：A、B 拥有相同 (corpid, agentid)
```

修复要求：

1. 企业微信在线验证继续放在事务外，禁止网络调用占用 SQLite 写事务。
2. 新增数据库原子方法，建议命名：

```js
updateConfigurationAtomic(code, fields, expectedVersion, {
  targetAgentid,
  checkIdentity
})
```

3. 方法内部使用 `withTransaction(async tx => ...)`，顺序固定为：

```text
BEGIN IMMEDIATE
按 code 重新读取 corpid/agentid/version/lifecycle
不存在 → missing
version 不符 → version_conflict + currentVersion
若 AgentID 实际变化：查询其他完成应用的 (corpid,targetAgentid)
有冲突 → identity_conflict + existingCode
按 code + version 更新 touched fields，version + 1
COMMIT
```

4. 事务回调中只能使用 `tx.get/run/all`，禁止调用 `this.get()`、`runRaw()`、`findCompletedByCorpidAgentId()` 等会再次入队的公共方法，否则会自锁。
5. 历史重复项在 AgentID 未变化时仍允许修改描述、凭证、接收人、回调和安全设置，不能扩大拦截范围。
6. service 将 DAO 原因翻译为现有稳定错误：`APP_NOT_FOUND`、`APP_VERSION_CONFLICT`、`APP_IDENTITY_CONFLICT`。

必须先补的失败测试：

- 真实 SQLite：两个不同 code 并发改成同一目标 AgentID，只允许一个成功，另一个返回身份冲突。
- 完成后查询目标 `(corpid,agentid)` 只能有一行。
- 两个请求分别改到不同 AgentID，都成功。
- 历史重复项不改 AgentID，只改描述，仍成功。
- 微信验证失败时不得开启事务或修改数据。
- 事务内 SQL 故障时字段和版本全部回滚。

验收输出应类似：

```json
{
  "successCount": 1,
  "identityConflictCount": 1,
  "duplicateCount": 1
}
```

---

## 5. P1 缺陷与修复要求

### R-P1-01：版本冲突前失效旧 token

代码证据：`src/services/notifier.js:1788-1798` 在调用 `updateConfigurationFields()` 之前失效旧 token；真正的 CAS 位于 `src/services/notifier.js:1802`。

当前行为：新 CorpSecret 验证成功，但数据库因旧版本返回 409 时，配置没有改变，旧 token 却已失效。诊断已复现 `invalidations=1`。

修复：

- 在写库前只安全取得旧 secret，不能执行 token 失效副作用。
- 数据库提交成功后再执行 `clearRuntimeCaches()` 和 `wechat.invalidateToken(oldCorpid, oldSecret)`。
- 版本冲突、身份冲突、验证失败、SQL 失败时失效次数必须为 0。
- token 清理失败仍可按“尽力清理”记录告警，但不能把已提交写入伪装成失败。

测试：成功更新为 1 次；409/400/500 为 0 次；只改 AgentID 不失效 token。

### R-P1-02：前端版本冲突会丢失用户输入

规则页：

- `public/rules.js:107-112` 的统一冲突处理直接调用 `loadRules()`。
- `public/rules.js:204-228` 的 `loadRules()` 固定调用 `resetForm()`。
- 因此规则创建/编辑收到 409 后，名称、接收成员、部门、标签、全体开关和估算人数全部丢失，与“保留输入后重新确认”相反。

编辑页：

- `public/edit.js:228-242` 只快照描述、AgentID、回调开关。
- `if (snapshot.description)` 使“主动清空描述”的意图无法恢复。
- 默认接收成员属于非敏感输入，但没有快照，刷新后会被服务端新值覆盖。

修复：

1. 规则页将“刷新规则数据”和“重置编辑器”拆开；409 时快照并恢复完整表单，提示用户对比后再次提交。
2. 编辑页快照描述时按属性存在恢复，允许空字符串；同时快照 `picker.getValue().touser`。
3. 敏感字段 CorpSecret/Token/AESKey 仍必须清空并明确提示重新输入。
4. 冲突刷新只采用服务端返回的新版本，不得本地 `+1`。
5. 增加 DOM 行为测试，不要只用源码字符串断言。

### R-P1-03：向导没有消费版本冲突，重复完成判定过于乐观

代码证据：

- `public/wizard.js:314-350` 没有处理 `APP_VERSION_CONFLICT` 或 `APP_VERSION_REQUIRED`。
- 收到冲突后仍保留旧 `draft.version`，再次点击会继续使用旧版本，用户只能手工刷新才能恢复。
- `public/wizard.js:335-338` 收到 `APP_ALREADY_COMPLETED` 就直接展示成功，没有读取最新详情并核对 AgentID。
- 这与设计文档“响应丢失后重试需核对实际 AgentID；不匹配则停止”的要求不一致。

修复：

- generate-callback/complete-config 收到 `APP_VERSION_CONFLICT` 时读取草稿最新摘要，更新 `draft.version`，保留当前内存输入，并要求重新确认。
- `APP_VERSION_REQUIRED` 视为客户端状态异常：重新加载详情，不无限重试。
- `APP_ALREADY_COMPLETED` 后读取 `details.existing_code || draft.code` 的详情；仅当服务端 AgentID 与 `cred.agentid` 一致时进入成功页，否则停止并提示应用已被其他操作完成。
- 失败或不匹配时不能清除草稿状态，也不能伪造成功 URL。

### R-P1-04：legacy-grace 只写字段，发送鉴权不读取

代码证据：

- `src/services/notifier.js:2094-2108` 写入 `legacy_until` 并递增版本。
- `src/api/routes.js:303-329` 在存在 `notify_key_hash` 时无条件要求密钥，没有判断 `legacy_until`。
- 全项目除写入和详情序列化外，没有发送鉴权使用该字段。

当前结果：接口返回“宽限期已设置”，但通知请求行为完全不变，属于业务假成功。

建议语义：

```text
无 notify_key_hash                         → 按现有策略放行
有 notify_key_hash，且未提供 Key：
  legacy_until > 当前 Unix 秒             → 宽限放行
  legacy_until <= 当前 Unix 秒或为空       → 401 AUTH_REQUIRED
有 notify_key_hash，且提供了 Key           → 必须校验；错误 Key 不能借宽限期放行
```

测试必须覆盖宽限前、宽限内、过期后、错误 Key 四种情况，并使用真实 HTTP 通知入口验证。

### R-P1-05：body version 格式错误被误报为缺版本

代码证据：`src/services/notifier.js:1843-1859` 把“未提供”和“格式非法”都返回 null；草稿更新/完成先把 null 映射成 428，因此后面的 400 校验不可达。

已复现：`version: "abc"`、`version: 0` 在 generate-callback/complete-config 中返回 `428 APP_VERSION_REQUIRED`。

期望契约：

- 缺失/null/空值：428 `APP_VERSION_REQUIRED`。
- 已提供但不是正整数：400 `INVALID_INPUT`。
- 正整数但不是当前版本：409 `APP_VERSION_CONFLICT` + 最新 version。

修复时不要继续用一个 null 同时表达两种状态。可拆成 `requireBodyVersion()` 与 `requireExpectedVersion()`，或返回判别结构 `{ provided, valid, value }`。

### R-P1-06：规则页可短暂混用上一个应用的成员与异步响应

代码证据：

- `public/rules.js:204-233` 切换应用时没有清空 `members`，随后异步加载新应用成员。
- `public/rules.js:235-254` 加载失败时保留旧数组；工作区和规则表单仍可操作。
- 多次快速切换应用没有请求序号或 AbortController，较早请求可以晚返回并覆盖较新应用的 rules/version/members。

业务影响：在跨企业切换或网络慢/失败时，用户可能用上一个应用的成员创建当前应用规则；即使后端版本锁阻止部分写入，界面仍显示了错误所属数据。

修复：

- 切换 code 时立即清空成员和编辑态，成员加载完成前禁用规则提交。
- 为规则与成员请求增加同一代次标识；响应返回时若 `requestCode !== currentCode` 或序号已过期，直接丢弃。
- 加载失败显示空状态，不能保留上一个应用的数据。
- 浏览器行为测试模拟 A 慢、B 快，最终页面只能显示 B 的规则、版本和成员。

---

## 6. 测试与契约缺口

### 6.1 名为“管理路由”的测试实际没有经过 HTTP 路由

`test/backend-management-routes.test.js:10-12` 明确说明测试沿用 service 层调用；文件没有向 Express 发请求。它能验证 service，但不能证明：

- `requireAuth`/`requireIfMatch` 中间件顺序正确；
- 路由确实转发 `draft_code/version/expectedVersion`；
- HTTP 状态码、响应 `{error,code,details}` 和成功版本字段正确；
- 非法头、缺头、无认证请求不会误入 service。

这与上一版指南“每个写接口均有真实 HTTP 成功/缺版本/冲突测试”的验收条件不一致，也是 routes.js 仍只有 59.53% 行覆盖率的主要原因。

必须新增真实 HTTP 集成测试，至少覆盖：

| 接口组 | 成功 | 缺版本 | 非法版本 | 旧版本 | 无认证 |
|---|---:|---:|---:|---:|---:|
| app-enabled/code-send | 是 | 428 | 400 | 409 | 401 |
| notify-key POST/DELETE | 是 | 428 | 400 | 409 | 401 |
| rules create/update/delete/regenerate/enabled | 是 | 428 | 400 | 409 | 401 |
| configuration PUT/DELETE | 是 | 428 | 400 | 409 | 401 |
| legacy-grace | 是 | 428 | 400 | 409 | 401 |
| generate-callback/complete-config | 是 | 428 body | 400 body | 409 | 401 |

测试可使用 Node 内置 `fetch` + 临时端口，不要求新增 supertest 依赖。

### 6.2 前端测试偏源码形状，缺少真实交互

当前新增前端测试主要断言“源码中包含 AppHttp/If-Match、不包含 confirm”。下一轮必须增加最小 DOM 行为测试或浏览器测试：

- 规则保存冲突后表单值仍存在；版本变为服务端最新值。
- 编辑冲突后空描述和接收成员仍存在，敏感输入被清空。
- 应用 A/B 快速切换不会发生响应倒灌。
- 向导版本冲突可以恢复；不同 AgentID 的 `APP_ALREADY_COMPLETED` 不显示成功。

---

## 7. 前后端一致性矩阵

| 业务结果 | 后端/数据库 | API | 前端 | 当前状态 |
|---|---|---|---|---|
| 编辑 AgentID 不产生重复身份 | 判重与更新应同一事务 | 冲突 409 + existing_code | 保留输入并打开现有应用 | **后端 P0 未闭环** |
| 规则写入是应用聚合写 | 规则变更 + version 原子提交 | If-Match，返回 app_version | 后续写采用返回版本 | 后端已闭环，冲突表单未闭环 |
| 草稿写入可恢复 | body version 区分缺失/非法/冲突 | 428/400/409 稳定区分 | 刷新版本并保留输入 | API 与向导未闭环 |
| CorpSecret 更新失败无副作用 | 提交成功后才失效旧 token | 失败不报告成功 | 显示稳定错误 | 副作用时序未闭环 |
| 宽限期真实影响鉴权 | 发送鉴权读取 legacy_until | 宽限内无 Key 可调用 | 文档/页面准确提示 | **业务假成功** |
| 状态和告警单一事实来源 | serializer 统一输出 | 三个读取接口同语义 | 页面只渲染服务端值 | 后端已闭环；规则页忽略部分字段 |
| 跨应用数据不串用 | code 隔离 | 响应属于请求 code | 丢弃过期响应、失败清空旧数据 | 前端未闭环 |

---

## 8. P2 优化登记

以下项不应与 P0 修复混成一个大提交：

1. 规则页 `public/rules.js:162` 在缺少生命周期时回退为 active；应显示“未知/需刷新”，不能把协议缺失解释为运行中。
2. 规则页没有展示后端已经提供的 `warnings=[duplicate_identity]` 和 `notify_key_enabled`，与设计中的只读状态提示不完整。
3. 规则页仍自建成员选择逻辑，没有复用 `AppRecipientPicker`，两套 orphan/搜索/选择行为会继续漂移。
4. `public/login.js` 忽略 `?next=`，而 `public/http.js` 会生成该参数；登录后总是回首页。
5. `public/components/modal.js` 异步处理中仍允许 ESC、遮罩和取消关闭，用户可能误认为请求已取消。
6. 运行时缓存和限流均为进程内状态；多实例部署时暂停/删除在其他实例最多延迟一个缓存 TTL 生效，需要部署约束或共享失效机制。
7. 设计要求的完成、编辑、暂停、恢复、删除、密钥变更结构化管理日志尚未实现。
8. `server.js:135-138` 在 `trust proxy=false` 时仍直接信任 `X-Forwarded-Proto` 来决定 Secure Cookie，建议只依赖 `req.secure` 或与 TRUST_PROXY 配置保持一致。
9. 规则 `:id` 未统一校验为正整数；0/NaN 可能被翻译为 APP_NOT_FOUND 而非 RULE_NOT_FOUND/INVALID_INPUT。
10. `createConfigurationAtomic()` 把所有 UNIQUE 约束错误都翻译为身份冲突；随机 code 极小概率碰撞时应重试 code 或返回内部冲突，而非误报 AgentID 被占用。

---

## 9. AI 执行顺序

### 阶段 A：先补会失败的测试

只改测试，不改实现：

- 新增 AgentID 编辑真实 SQLite 并发测试。
- 新增 CAS 失败不失效旧 token 测试。
- 新增 body version 缺失/非法/冲突三分测试。
- 新增 legacy grace 真实通知 HTTP 测试。
- 新增真实管理 HTTP 路由矩阵测试。
- 新增前端冲突保留与跨应用请求倒灌行为测试。

阶段验收：新用例按本文预期失败，现有 187 项继续通过。

### 阶段 B：只修 P0 身份事务

允许修改：

- `src/core/database.js`
- `src/services/notifier.js`
- 身份事务测试

禁止顺手改 UI、文档、宽限期或日志。完成 R-P0-01 后单独提交：

```text
fix(multi-app): make AgentID edits identity-atomic
```

阶段验收：并发测试只能一个成功；普通/隔离测试全绿；真实事务诊断仍为 `outside-blocked`。

### 阶段 C：收口失败副作用与 API 契约

允许修改：

- `src/services/notifier.js`
- `src/api/routes.js`
- `server.js`（仅在本阶段选择修复 Secure Cookie 判断时）
- 对应后端/HTTP 测试

依次修复：token 失效时序、body version 三分、legacy grace 实际鉴权。完成后单独提交：

```text
fix(multi-app): align version errors and post-commit side effects
```

### 阶段 D：修复前端恢复和跨应用隔离

允许修改：

- `public/edit.js`
- `public/wizard.js`
- `public/rules.js`
- 必要时 `public/components/recipient-picker.js`
- 前端行为测试

要求：

- 冲突保留全部非敏感输入；敏感输入清空。
- 采用服务端版本，不猜 `+1`。
- 过期异步响应不能覆盖当前应用。
- 规则页消费 warnings 和 notify_key_enabled，未知生命周期不回退 active。

完成后单独提交：

```text
fix(ui): preserve edits and isolate async app state
```

### 阶段 E：真实路由回归、文档与发布检查

允许修改：

- `test/*`
- `public/api-docs.html`
- `README.md`
- 本设计/复验文档的状态说明

要求：

- 管理写接口通过真实 HTTP 矩阵。
- 文档明确 body version 与 If-Match 的区别。
- 若保留 legacy grace，文档写清无 Key 宽限语义；若产品决定删除该能力，必须同时删除路由、service、字段文档和测试，不能保留假成功端点。
- routes.js 建议行覆盖率提高到至少 75%，database.js 至少 65%，总行覆盖率不低于 72%；禁止为了数字添加无断言测试。

---

## 10. AI 执行约束

1. 不重建 configurations 表，不新增 `(corpid,agentid)` 唯一索引；历史重复数据必须继续可启动、可治理。
2. 不修改 code 主键；corpid 仍不可通过编辑接口修改。
3. 网络验证放在事务外；身份判重和最终写入放在同一 `BEGIN IMMEDIATE` 事务内。
4. 事务回调只使用 tx 句柄，禁止公共 DB 方法二次入队。
5. 所有成功写响应采用数据库提交后的 version/app_version；前端不得本地递增。
6. 失败不得留下可观察副作用：不清缓存、不失效 token、不改变字段、不递增版本。
7. 不在响应、日志、DOM、URL、localStorage/sessionStorage 中加入 CorpSecret、回调 Token、AESKey 或通知密钥明文。
8. 前端只按稳定 `code` 分支，不匹配中文错误文案。
9. API 与静态前端必须同一版本发布，不能先上线强制版本头的后端再晚发前端。
10. 每个阶段完成后先跑普通与隔离测试，再提交；不要把 P0、UI 重构和 P2 清理压成一个不可审查的大提交。

---

## 11. 最终验收清单

发布前必须全部满足：

- [ ] AgentID 编辑并发只能一个成功，数据库无新增重复身份。
- [ ] 新建、完成、编辑三条身份写路径都经过原子身份事务。
- [ ] 版本冲突时旧 token 失效次数为 0。
- [ ] body version 缺失/非法/过期分别返回 428/400/409。
- [ ] legacy grace 要么真实生效且有 HTTP 测试，要么完整删除，不存在假成功。
- [ ] 规则和编辑页版本冲突保留非敏感输入。
- [ ] 向导能恢复版本冲突，不把其他人完成的不同 AgentID 误报为成功。
- [ ] 快速切换应用时不会显示或提交上一个应用的规则、版本、成员。
- [ ] 所有管理写路由有真实 HTTP 鉴权、版本和错误响应测试。
- [ ] `npm test` 与 `npm run test:isolated` 全绿。
- [ ] 前后端脚本语法检查通过。
- [ ] `npm audit --omit=dev --audit-level=high` 无 high/critical。
- [ ] API 文档、README 与实际响应一致。
- [ ] 发布前备份 SQLite 文件，并确认回滚旧版本会忽略 app_enabled 的风险已被接受。

完成上述清单后，才可把多应用管理状态从“修复复验中”改为“可发布”。
