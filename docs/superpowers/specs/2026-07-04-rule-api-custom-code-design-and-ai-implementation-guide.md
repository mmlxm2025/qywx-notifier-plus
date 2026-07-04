# 接收规则 API 自定义编号——技术建议书与 AI 实施指南

- 编写日期：2026-07-04
- 状态：待审查、待实现
- 目标版本：`2.0.0-dev`
- 适用运行时：Node.js 24、SQLite、无前端构建步骤
- 核心范围：每条接收规则可在创建时自定义、在编辑时修改 `/api/notify/{自定义编号}`
- 主要文件：`src/core/database.js`、`src/services/notifier.js`、`src/api/routes.js`、`public/rules.html`、`public/rules.js`、`public/frontend-helpers.js`、`public/api-docs.html`、`test/*.test.js`

## 0. 结论先行

本功能不应被实现成“在规则表单中加一个输入框，然后把值写入 `notification_rules.api_code`”。完整实现必须同时满足以下五点：

1. **前后端使用同一个字段 `api_code`、同一套格式规则和同一套错误码。**
2. **通知路径是全局命名空间。** 自定义编号既不能与其他规则的 `api_code` 重复，也不能与 `configurations.code` 重复。
3. **唯一性由数据库事务最终裁决。** 前端可做可用性预检，但预检结果不能代替保存时的原子校验。
4. **修改编号与应用聚合版本必须原子提交。** 继续使用现有 `If-Match` / `app_version` 协议，不建立第二套并发机制。
5. **旧编号不得被其他对象接管。** 编号修改或规则删除后，旧调用方只能得到 404，不能误发到另一条规则或应用；同一条仍存在的规则可以恢复自己曾用过的编号。

推荐方案是：**复用现有 `notification_rules.api_code` 作为当前编号，新增退役编号表保存历史占用，增加跨表防冲突约束，并把创建、编辑、随机重生成、删除全部纳入现有规则事务。**

## 1. 当前实现与真实缺口

以下结论基于 2026-07-04 的当前代码。

### 1.1 已有能力

- `notification_rules.api_code` 已存在，且声明为 `TEXT UNIQUE NOT NULL`：`src/core/database.js:100-112`。
- 规则列表已经返回 `api_code` 和 `apiUrl`：`src/services/notifier.js:560-575`。
- 创建规则时由服务端生成 UUID：`src/services/notifier.js:1124-1156`。
- 更新规则当前只修改名称、范围、预计人数，不修改 `api_code`：`src/services/notifier.js:1159-1209`。
- `POST /api/rules/:id/regenerate` 可随机重生成编号：`src/api/routes.js:395-403`、`src/services/notifier.js:1212-1247`。
- 所有规则写操作已通过 `mutateRuleWithAppVersion` 将规则修改和应用 `version + 1` 放在同一事务中：`src/core/database.js:599-655`。
- 规则页已有版本冲突恢复、公共 HTTP 客户端、确认弹窗和请求代次保护。

### 1.2 现有实现不能直接承接自定义编号的原因

1. 规则表自身的 `UNIQUE(api_code)` 只能阻止“规则与规则”重复，不能阻止规则编号与 `configurations.code` 重复。
2. 通知入口当前先查规则、再查配置：
   - `src/api/routes.js:264-273`
   - `src/services/notifier.js:1340-1365`
   
   如果某规则 `api_code` 与某应用 `code` 相同，`/api/notify/{code}` 会优先命中规则，导致应用直发入口被静默劫持。
3. 路由层和服务层各自实现了一遍“编号解析”，以后很容易出现一层认为是规则、另一层认为是应用的协议漂移。
4. 当前“重生成”会让旧地址立即失效，但数据库不记录旧编号。加入可读的自定义编号后，旧编号更容易被再次申请；若被其他规则接管，遗留调用方会发生误投递。
5. 通知密钥默认可选。短而可猜的自定义编号会降低 UUID 原有的随机性，因此 UI 和文档必须明确：编号是标识符，不是凭证。

## 2. 目标与非目标

### 2.1 功能目标

- 新建规则时允许用户填写自定义 `api_code`；留空时继续由服务端生成 UUID，保持旧客户端兼容。
- 编辑规则时显示当前 `api_code`，允许用户修改。
- 修改成功后，新地址立即生效，旧地址立即失效。
- 规则列表、复制按钮、响应体和 API 文档都显示服务端确认后的规范化编号。
- 在前端提供即时格式提示和可用性预检；最终结果以保存响应为准。
- 对非法格式、当前占用、历史占用和应用版本冲突给出稳定、可区分的错误语义。
- 随机重生成继续保留，并与手工修改复用同一套底层改号逻辑。

### 2.2 非目标

- 本期不修改基础应用 `configurations.code` 的用户体验，不允许用户自定义应用 Code。
- 本期不提供旧地址转发、302 跳转或双地址并行的宽限期。
- 本期不把每条规则改成独立通知密钥；规则仍使用所属应用的 `notify_key`。
- 本期不改变通知请求体、消息类型、接收范围和限频策略。
- 本期不允许 `/`、中文、空格、`.`、`%` 等复杂 URL 字符。
- 本期不进行数据库 ORM 或前端框架重构。

## 3. 术语与必须成立的不变量

### 3.1 术语

- **规则编号**：JSON 字段和数据库字段统一命名为 `api_code`，只表示路径最后一段，不包含 `/api/notify/`。
- **完整地址**：`/api/notify/{api_code}`。
- **当前编号**：当前保存在 `notification_rules.api_code` 或 `configurations.code` 中、能够路由的编号。
- **退役编号**：曾经生效但已被修改或删除，不再能够路由的编号。
- **编号所有者**：最初使用该编号的规则或应用。

### 3.2 硬性不变量

1. 任一时刻，一个规范化编号最多对应一个可发送目标。
2. 编号唯一性覆盖全部 `notification_rules.api_code` 与全部 `configurations.code`，不能只在单表内判重。
3. 编号比较采用 ASCII 不区分大小写语义；所有新规则编号保存为小写。
4. 任意规则写操作成功时，规则数据和所属应用版本一起提交；失败时两者都不改变。
5. 旧编号不能被其他规则或应用重新使用。
6. 同一条仍存在的规则可以恢复自己曾经使用过的编号。
7. 删除规则或删除应用时，所有失效的通知编号都必须先登记为退役，再删除当前记录，且在同一事务完成。
8. 可用性查询只是提示；创建/更新事务必须重新校验。
9. 后端从不相信 HTML `pattern`、`maxlength` 或前端预检结果。
10. `api_code` 是路由标识，不是安全凭证；鉴权继续依赖所属应用的通知密钥/HMAC。

## 4. 业务规则

### 4.1 编号格式

后端唯一规范如下，前端必须镜像，但不能另起一套不同规则：

| 项目 | 规则 |
|---|---|
| 规范化 | `String(value).trim().toLowerCase()` |
| 长度 | 3～64 个字符 |
| 允许字符 | 小写字母 `a-z`、数字 `0-9`、连字符 `-`、下划线 `_` |
| 首尾字符 | 必须是字母或数字 |
| 禁止 | `/`、`\\`、`.`、空格、中文、`%`、`?`、`#`、控制字符、完整 URL |
| 示例 | `ops-alert`、`prod_001`、`10086` |
| 非法示例 | `a`、`-ops`、`ops-`、`/api/notify/ops`、`生产告警` |

建议的后端判定顺序：

```js
const normalized = String(value).trim().toLowerCase();
if (normalized.length < 3 || normalized.length > 64) invalid();
if (!/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/.test(normalized)) invalid();
```

不要用 `encodeURIComponent` 代替输入校验，也不要默默截断超长值。

### 4.2 创建规则

- 请求未提供 `api_code`，或提供值为 `null` / 空白字符串：服务端生成 UUID。
- 请求提供非空 `api_code`：规范化、校验格式、事务内校验全局占用后保存。
- 响应总是返回最终 `api_code`、`apiUrl` 和 `app_version`。
- 随机生成发生冲突时最多重试 5 次；全部失败返回 503，不能误报成身份冲突或 500。

这样可以保持现有管理客户端和测试兼容：旧客户端完全不传 `api_code` 时行为不变。

### 4.3 编辑规则

- 请求省略 `api_code`：保留原编号，兼容旧客户端。
- 请求显式提供 `api_code`：必须为非空合法值；空字符串不能在编辑场景解释成“随机重生成”。
- 规范化后与当前值相同：视为普通更新，不写退役记录，不产生额外版本递增。
- 与当前值不同：保存前由前端确认，服务端在同一规则事务内完成“占用新编号、退役旧编号、更新规则、应用版本 +1”。
- 更新成功响应增加 `api_code_changed: true|false`，便于前端准确提示。

### 4.4 冲突矩阵

| 候选编号状态 | 结果 | HTTP / 业务码 |
|---|---|---|
| 未被使用、无退役记录 | 允许 | 成功 |
| 是当前规则自己的当前编号 | 允许，按未改号处理 | 成功 |
| 被其他当前规则使用 | 拒绝 | 409 `RULE_API_CODE_CONFLICT` |
| 与当前应用 Code 相同 | 拒绝 | 409 `RULE_API_CODE_CONFLICT` |
| 是当前规则自己的退役编号，且当前规则仍存在 | 允许恢复 | 成功 |
| 是其他规则的退役编号 | 拒绝 | 409 `RULE_API_CODE_CONFLICT` |
| 属于已删除规则或已删除应用 | 拒绝 | 409 `RULE_API_CODE_CONFLICT` |
| 格式非法 | 拒绝 | 400 `RULE_API_CODE_INVALID` |
| 应用版本已变化 | 拒绝 | 409 `APP_VERSION_CONFLICT` |

`RULE_API_CODE_CONFLICT` 的 `details` 只返回必要信息：

```json
{
  "api_code": "ops-alert",
  "conflict_scope": "rule"
}
```

`conflict_scope` 允许值：`rule`、`configuration`、`retired`。不要返回另一条规则的名称、接收人或应用密钥状态。

注意：编号冲突与版本冲突都使用 HTTP 409，前端必须按 `body.code` 分支，禁止按中文文案或仅按状态码判断。当前 `AppHttp.isVersionConflict()` 只应把 `APP_VERSION_CONFLICT` 或带 `details.version` 的响应当作版本冲突；编号冲突响应不得携带 `details.version`。

### 4.5 修改、重生成与删除后的旧地址

- 改号后旧地址立即返回 404，不转发到新地址。
- 随机重生成与手工改号遵循相同策略。
- 删除规则后旧地址返回 404。
- 旧编号登记为退役后，其他对象永久不能接管。
- 仍存在的原规则可以把自己的退役编号恢复为当前编号；恢复时删除对应退役记录，并把被替换掉的当前编号登记为退役。
- 删除应用时，其应用 Code 和级联删除的全部规则编号都登记为退役，避免遗留调用方误发。

这里的目的不是保护“漂亮编号”，而是保护投递目标的身份连续性。

## 5. 方案比较与选择

### 5.1 只依赖 `notification_rules.api_code UNIQUE`——不采用

能阻止规则与规则重复，但无法阻止与 `configurations.code` 冲突，也不能防止旧编号被重新分配。

### 5.2 保存前分别查询两张表——不能单独采用

可以给出友好提示，但如果查询和写入不在同一事务，两个并发请求可能都看到“可用”并同时提交。前端预检更不具备任何并发保证。

### 5.3 新建完整的通知路由注册表——暂不采用

把配置、规则和历史编号全部迁入单一注册表是长期最整洁的模型，但会同时改动配置创建、回调草稿、级联删除和现有查询路径，首期风险偏高。

### 5.4 当前值 + 退役表 + 事务校验 + 数据库防线——采用

优点：

- 复用现有 `api_code`，管理 API 和发送路径无需整体迁移。
- 能处理跨表冲突和历史误投递风险。
- 能复用现有 `mutateRuleWithAppVersion` 的串行事务与乐观锁。
- 迁移为加法变更，旧版客户端仍可工作。

代价：

- 所有创建/改号/删除路径都必须同步维护退役表。
- 必须为配置创建和级联删除补上对通知命名空间的处理。
- 需要数据库触发器或等价约束作为服务层之外的最后防线。

## 6. 数据库设计

### 6.1 新增退役编号表

在 `Database.createTables()` 中新增：

```sql
CREATE TABLE IF NOT EXISTS retired_notify_codes (
    code TEXT PRIMARY KEY COLLATE NOCASE,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('rule', 'configuration')),
    owner_id TEXT NOT NULL,
    retired_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reason TEXT NOT NULL CHECK (reason IN ('renamed', 'regenerated', 'deleted', 'cascade_deleted'))
);

CREATE INDEX IF NOT EXISTS idx_retired_notify_codes_owner
ON retired_notify_codes(owner_type, owner_id);
```

说明：

- 不设置外键。规则/应用删除后历史占用必须继续保留，外键反而会破坏该语义。
- `owner_id` 使用文本：规则保存 `String(rule.id)`，应用保存其稳定 `code`。
- `COLLATE NOCASE` 与小写规范化共同避免 `Ops-Alert` / `ops-alert` 的视觉重复。
- 退役表不是审计日志；一个编号只保留当前所有权事实，因此 `code` 为主键。

### 6.2 当前数据的不区分大小写唯一性

建议新增表达式唯一索引：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS ux_notification_rules_api_code_nocase
ON notification_rules(lower(api_code));

CREATE UNIQUE INDEX IF NOT EXISTS ux_configurations_code_nocase
ON configurations(lower(code));
```

SQLite 内置 `lower()` 对本功能允许的 ASCII 字符足够。服务层仍需把新规则编号规范化为小写。

### 6.3 跨表与退役编号防线

由于 SQLite 不能直接声明跨表唯一约束，建议添加 `BEFORE INSERT/UPDATE` 触发器：

- 规则插入/改号时，拒绝与 `configurations.code` 或不属于当前规则的退役编号冲突。
- 配置插入/改 Code 时，拒绝与 `notification_rules.api_code` 或任一退役编号冲突。
- 服务层先做结构化查询并抛稳定业务错误；触发器只负责防止未来新增的遗漏写路径破坏不变量。
- 触发器使用固定错误标识 `NOTIFY_CODE_CONFLICT`，不要把用户输入拼进 SQLite 错误文本。

服务层的友好检查和数据库触发器缺一不可：前者负责业务语义，后者负责兜底完整性。

### 6.4 上线前数据审计

创建唯一索引/触发器前必须审计旧数据：

```sql
-- 规则表内部的大小写重复
SELECT lower(api_code) AS normalized_code, count(*) AS count
FROM notification_rules
GROUP BY lower(api_code)
HAVING count(*) > 1;

-- 配置表内部的大小写重复
SELECT lower(code) AS normalized_code, count(*) AS count
FROM configurations
GROUP BY lower(code)
HAVING count(*) > 1;

-- 规则编号与应用 Code 冲突
SELECT r.id AS rule_id, r.api_code, c.code AS config_code
FROM notification_rules r
JOIN configurations c ON lower(r.api_code) = lower(c.code);
```

若发现冲突：

- 启动应以清晰错误失败，列出冲突类型和对象 ID；
- 不得静默改号；
- 不得凭查询优先级自行决定“保留规则”或“保留应用”；
- 修复数据后再重启完成迁移。

当前两类编号均由 UUID 生成，历史冲突概率很低，但迁移不能用概率代替验证。

### 6.5 原子操作顺序

#### 创建规则

在 `mutateRuleWithAppVersion({ configCode }, expectedVersion, mutation)` 的 `mutation` 内：

1. 校验候选编号不在配置表、规则表、退役表中。
2. 插入规则。
3. 外层事务递增应用版本。

#### 编辑规则并改号

在同一事务内：

1. 读取当前规则，确认归属。
2. 校验候选编号；若退役编号属于当前规则，允许恢复。
3. 若是恢复，删除候选编号的退役记录。
4. 用 `INSERT ... ON CONFLICT` 安全登记旧编号为当前规则的退役编号。
5. 更新规则全部字段和 `api_code`。
6. 外层事务递增应用版本。

任一步失败必须整体回滚。尤其不能出现“旧编号已退役，但规则仍使用旧编号”的半完成状态。

#### 随机重生成

复用编辑改号的内部函数，只把候选编号来源改成 UUID，并把退役原因记为 `regenerated`。不要保留第二份 SQL 实现。

#### 删除规则

在删除前读取 `api_code`，登记 `reason='deleted'`，再删除规则并递增应用版本。

#### 删除应用

修改 `deleteConfigurationCascade()`：

1. 校验应用存在和版本。
2. 查询该应用全部规则的 `id/api_code`。
3. 登记应用 Code 为 `configuration/cascade_deleted`。
4. 登记全部规则编号为 `rule/cascade_deleted`。
5. 删除规则。
6. 删除应用。

全部步骤使用现有事务句柄 `tx`，不能在事务回调里调用会再次入队的公共数据库方法。

### 6.6 配置创建也必须遵守命名空间

虽然应用 Code 仍由 UUID 随机生成，以下路径也要受到触发器保护并在冲突时重新生成：

- `createDraftCallbackAtomic()`
- `createConfigurationAtomic()`
- 仍可能被旧路径调用的 `saveConfiguration()` / `saveCallbackConfiguration()`

特别注意：`createConfigurationAtomic()` 当前把所有 SQLite 唯一约束错误都翻译为 `identity_conflict`。实现时必须区分：

- `(corpid, agentid)` 身份冲突；
- `configurations.code` 自身冲突；
- `NOTIFY_CODE_CONFLICT` 通知命名空间冲突。

随机 Code 冲突应重试，不得向用户返回错误的 `APP_IDENTITY_CONFLICT`。

## 7. 后端设计

### 7.1 新增单一编号规范模块

建议新增 `src/core/notify-code.js`，集中导出：

```js
normalizeRuleApiCode(value)       // 非空值 -> 规范化字符串或抛 RULE_API_CODE_INVALID
isValidRuleApiCode(value)         // 纯布尔，供单测和内部使用
generateNotifyCode()              // 当前仍返回 crypto.randomUUID()
```

不要把规则名称、接收人规范化塞进该模块。它只负责通知编号语法，便于测试和未来复用。

### 7.2 数据库/服务内部 helper

建议形成以下单一职责 helper；名称可调整，但职责不可散落：

```js
inspectNotifyCodeConflict(tx, apiCode, { ruleId = null })
retireNotifyCode(tx, { code, ownerType, ownerId, reason })
changeRuleApiCodeInTransaction(tx, app, existingRule, nextApiCode, reason)
```

`inspectNotifyCodeConflict` 返回 `null` 或：

```js
{ scope: 'rule' | 'configuration' | 'retired', reclaimable: false }
```

若命中当前规则自己的退役编号，返回 `{ scope: 'retired', reclaimable: true }`。只有更新现有规则时允许使用 `reclaimable`；创建规则不能借用旧规则 ID。

### 7.3 修改 `normalizeRulePayload`

接收范围规范化与编号规范化应保持可区分：

- `normalizeRulePayload()` 继续处理名称、接收范围、预计人数。
- 创建/更新函数单独解析 `payload.api_code`，以便正确区分“省略”“创建时留空”“更新时显式清空”。
- 不要使用 `payload.apiCode` 双字段兼容；对外只定义 `api_code`，避免长期协议分叉。

### 7.4 修改 `createRule`

建议语义：

```js
const provided = payload.api_code !== undefined
    && payload.api_code !== null
    && String(payload.api_code).trim() !== '';
const apiCode = provided ? normalizeRuleApiCode(payload.api_code) : generateNotifyCode();
```

随后在规则版本事务内检查并插入。若是自动生成且发生冲突，整体回滚并用同一 `expectedVersion` 重试，最多 5 次。

### 7.5 修改 `updateRule`

事务内读取现有规则后再决定：

- `payload` 无自有属性 `api_code`：沿用 `existing.api_code`；
- 有该属性但规范化前为空：400 `RULE_API_CODE_INVALID`；
- 有合法值：进入改号流程。

SQL 更新应一次写入全部规则字段和 `api_code`，不要先改接收范围、再单独改号。

成功响应：

```json
{
  "id": 7,
  "api_code": "ops-alert",
  "apiUrl": "/api/notify/ops-alert",
  "api_code_changed": true,
  "app_version": 4
}
```

### 7.6 重构 `regenerateRuleApiCode`

- 保留现有管理 API，避免破坏 UI 和外部管理脚本。
- 生成 UUID 后调用与手工改号相同的事务 helper。
- 继续返回 `api_code`、`apiUrl`、`app_version`。
- 旧编号写入退役表，原因是 `regenerated`。
- 随机碰撞最多重试 5 次。

### 7.7 统一发送目标解析

当前 `resolveNotifyAuth()` 和 `resolveNotificationTarget()` 分别查规则/配置。建议把 `resolveNotificationTarget(code)` 作为服务层唯一解析入口并供路由鉴权复用，返回：

```js
{
  kind: 'rule' | 'configuration',
  requestedCode,
  config,
  rule,
  recipient,
  estimatedCount,
  cacheScope
}
```

要求：

- 解析逻辑只实现一次；
- 鉴权与实际发送使用相同 `kind/config/rule` 语义；
- 若迁移前遗留数据导致同时命中两个当前对象，抛 500 `NOTIFY_CODE_NAMESPACE_CORRUPTED` 并拒绝发送，不能再依赖“规则优先”；
- 改号、删除和级联删除只在提交成功后调用 `clearRuntimeCaches()`；回滚时不清缓存也不写成功日志。

### 7.8 可用性预检接口

新增认证管理接口：

```text
GET /api/rule-api-codes/availability?api_code=ops-alert&rule_id=7
```

- 使用 `requireAuth`。
- `rule_id` 可选；编辑时传当前规则 ID，新建时不传。
- `rule_id` 存在时必须确认规则存在，且只用于判断“当前值/自己的退役值”；不能绕过最终保存校验。
- 非法格式返回 400 `RULE_API_CODE_INVALID`。
- 合法格式统一返回 200：

```json
{
  "api_code": "ops-alert",
  "available": false,
  "reason": "rule"
}
```

`reason` 为 `null`、`rule`、`configuration` 或 `retired`。不要返回占用对象详情。

## 8. 管理 API 合约

### 8.1 创建规则

```http
POST /api/configuration/{configCode}/rules
If-Match: 3
Content-Type: application/json

{
  "name": "生产告警",
  "api_code": "prod-alert",
  "is_all": false,
  "touser": ["zhangsan"],
  "toparty": "",
  "totag": "",
  "estimated_count": 1
}
```

`api_code` 可省略或在创建时留空，此时随机生成。

### 8.2 编辑规则

```http
PUT /api/rules/7
If-Match: 4
Content-Type: application/json

{
  "name": "生产告警",
  "api_code": "prod-alert-v2",
  "is_all": false,
  "touser": ["zhangsan"]
}
```

省略 `api_code` 表示不修改编号；显式空值返回 400。

### 8.3 错误协议

| 场景 | HTTP | `code` | `details` |
|---|---:|---|---|
| 编号格式非法 | 400 | `RULE_API_CODE_INVALID` | `field`、`min_length`、`max_length`、`allowed` |
| 编号被占用/退役 | 409 | `RULE_API_CODE_CONFLICT` | `api_code`、`conflict_scope` |
| 缺少 If-Match | 428 | `APP_VERSION_REQUIRED` | 无 |
| 版本冲突 | 409 | `APP_VERSION_CONFLICT` | `version` |
| 规则不存在 | 404 | `RULE_NOT_FOUND` | 无 |
| 应用不存在 | 404 | `APP_NOT_FOUND` | 无 |
| 应用未完成 | 409 | `APP_NOT_COMPLETED` | 无 |
| 随机编号连续冲突 | 503 | `RULE_API_CODE_GENERATION_FAILED` | 无 |

所有管理路由继续使用 `sendError()` 输出 `{ error, code?, details? }`。生产环境的 500 错误不得暴露 SQLite SQL 或约束文本。

## 9. 前端设计

### 9.1 表单布局

在规则名称下方新增“API 自定义编号”：

```text
API 自定义编号
[/api/notify/] [ prod-alert________________ ]
3～64 位小写字母、数字、-、_；留空将自动生成
```

建议 DOM：

- `#rule-api-code`
- `#rule-api-code-status`
- `#rule-api-code-help`

输入框设置 `maxlength="64"`、`autocomplete="off"`、`spellcheck="false"`。HTML `pattern` 可用于提示，但不能成为唯一校验。

### 9.2 新建态

- 输入框默认为空，placeholder 为“留空自动生成”。
- 用户输入时只做本地格式提示；停止输入约 300 ms 后调用可用性接口。
- 用户保存时即便最近一次预检显示可用，也必须正常提交并处理服务端 409。
- 成功后以响应 `api_code` 渲染，不能自行猜测服务端生成的 UUID。

### 9.3 编辑态

- `editRule(rule)` 把 `rule.api_code` 填入输入框。
- 保存前比较规范化后的输入与编辑开始时的 `originalApiCode`。
- 若变化，显示确认弹窗：

```text
修改 API 编号后，旧地址 /api/notify/old-code 将立即失效。
请确认调用方会改用 /api/notify/new-code。
```

- 弹窗确认后才发 PUT；取消时保留表单。
- 不要用“重生成”按钮模拟手工修改。重生成仍是独立随机操作。

### 9.4 前端状态模型

除现有状态外增加：

```js
let originalApiCode = '';
const apiCodeRequestGuard = H.createRequestGuard();
```

- 可用性请求必须使用独立 guard，不能复用规则/成员加载的 `requestGuard`，否则会相互取消。
- 切换应用、点击“新建”、保存成功时清空 `originalApiCode` 和可用性提示。
- 编辑规则时设为服务端当前 `rule.api_code`。
- 版本冲突刷新后，如果规则仍存在，用最新规则值更新 `originalApiCode`，但保留用户期望保存的输入值；如果规则已被删除，退出编辑态并明确提示。

### 9.5 payload 与快照

`getPayload()` 增加：

```js
api_code: ruleApiCodeInput.value.trim()
```

创建时空字符串可以传给服务端或从 payload 删除，二者只能选一种并通过测试固定；推荐删除空字段，语义更清楚。

`snapshotRuleForm()` / `restoreRuleForm()` 必须加入：

- `api_code`
- `rule_id`（用于冲突后确认编辑对象）
- `original_api_code`（用于重新计算改号确认）

避免版本冲突刷新后只恢复名称/接收范围，却把用户输入的编号丢掉。

### 9.6 错误展示

- `RULE_API_CODE_INVALID`：在编号输入框下展示字段错误并聚焦输入框。
- `RULE_API_CODE_CONFLICT`：显示“该编号已占用或已被保留，请更换”，保留全部表单内容。
- `APP_VERSION_CONFLICT`：沿用现有刷新并恢复表单流程。
- 网络错误：保留输入，可重试。
- 不按 `res.error` 中文文本判断错误类型。

### 9.7 规则列表

- “API 地址”列继续显示完整相对路径。
- 复制按钮必须复制服务端返回的 `rule.apiUrl`；fallback 拼接时对路径段使用 `encodeURIComponent`。
- 改号成功提示：“规则已更新，新 API 地址已生效；旧地址已失效。”
- 随机重生成弹窗补充“旧编号会被保留，不能分配给其他规则”。
- 动态值一律通过 `textContent` 写入，不拼接 `innerHTML`。

### 9.8 安全提示

规则页已有“前往编辑页管理通知密钥”入口。自定义编号区域增加简短提示：

> 自定义编号便于记忆，但不是密码。公网使用时请在应用安全设置中启用通知密钥。

不要因用户选择自定义编号就自动轮换密钥，也不要在规则页复制一套通知密钥控件。

## 10. 缓存、鉴权与发送一致性

1. 改号事务提交后清空 `targetCache`、发送去重缓存和相关运行时缓存；现有 `clearRuntimeCaches()` 可复用。
2. 旧编号被清缓存后应立即 404，不能等待 60 秒 TTL。
3. HMAC 签名内容包含请求路径。调用方改用新编号后必须按新路径重新计算签名，文档需明确。
4. 规则仍继承所属应用的 `notify_key_hash`；改号不改变密钥。
5. 应用总开关、规则开关、直发开关优先级保持不变。
6. `resolveNotifyAuth` 与 `sendNotification` 必须使用同一解析结果语义，避免“鉴权检查了 A、实际发送到 B”。
7. 自定义编号不应被记录为敏感凭证，但日志中仍不要输出通知密钥、HMAC 签名或消息正文。

## 11. 测试先行清单

实现 AI 必须先补失败测试，再写生产代码。不要只新增正向页面源码断言。

### 11.1 编号规范化单元测试

建议新建 `test/notify-code.test.js`：

- `Ops-Alert` -> `ops-alert`。
- 首尾空白被移除。
- `abc`、`a_b`、`10086` 合法。
- 长度 2、65 非法。
- 首尾 `-` / `_` 非法。
- 中文、空格、`.`、`/`、`%2F`、完整 URL 非法。
- `null`、对象、数组的处理符合接口约定，不产生 `[object Object]` 这类有效编号。

### 11.2 真实 SQLite 数据完整性测试

建议新建 `test/backend-rule-api-code-sqlite.test.js`，使用临时数据库验证：

1. 创建自定义编号成功并保存为小写。
2. 两条规则抢同一编号，只有一条成功。
3. 大小写不同仍冲突。
4. 与 `configurations.code` 冲突时拒绝。
5. 改号同时写入退役表并递增一次应用版本。
6. 改号失败时规则、退役表、应用版本全部回滚。
7. 同一规则可以恢复自己的退役编号。
8. 其他规则不能使用退役编号。
9. 删除规则后编号留在退役表。
10. 级联删除应用后，应用 Code 和全部规则编号都进入退役表。
11. 触发器能拦截绕过 service 的直接 SQL 冲突写入。
12. 迁移审计能发现旧数据中的跨表冲突。

### 11.3 Service 测试

扩展 `test/backend-rules-cache.test.js` 与 `test/backend-rule-version.test.js`：

- `createRule` 接收自定义 `api_code`。
- 未提供编号仍生成 UUID。
- `updateRule` 省略编号时保留旧值。
- `updateRule` 修改编号返回 `api_code_changed=true`。
- 同值更新不写退役记录。
- 冲突映射为 409 `RULE_API_CODE_CONFLICT`，不是 500。
- 编号冲突不会递增 `app_version`。
- 随机重生成调用统一改号逻辑且有重试上限。
- 改号后缓存被清理，新地址命中、旧地址 404。
- 发送目标解析不会在规则/配置之间产生不同结论。

现有事务桩需要支持编号查询和退役表 SQL，不要通过放宽断言来“适配”新实现。

### 11.4 HTTP 合约测试

扩展 `test/backend-management-http-matrix.test.js`：

- 创建/更新自定义编号成功。
- 创建/更新仍要求认证和 `If-Match`。
- 缺版本 428、非法版本 400、旧版本 409。
- 非法编号 400 `RULE_API_CODE_INVALID`。
- 占用编号 409 `RULE_API_CODE_CONFLICT`。
- 编号冲突不被 `AppHttp.isVersionConflict` 误判。
- availability 未登录 401、非法格式 400、四类结果为 200。
- 更新不存在规则 404。

### 11.5 前端行为测试

扩展：

- `test/frontend-rules-page.test.js`
- `test/frontend-rules-page-behavior.test.js`
- `test/frontend-conflict-and-isolation.test.js`

覆盖：

1. 表单存在编号输入、前缀、帮助文本和安全提示。
2. 新建态留空，编辑态回填当前编号。
3. payload 使用 `api_code`，没有 `custom_code` / `apiCode` 协议分叉。
4. 改号前使用 `AppModal` 确认。
5. 编号冲突保留表单。
6. 版本冲突快照/恢复包含编号和编辑对象。
7. 可用性请求使用独立代次，旧响应不能覆盖新输入。
8. 切换应用后旧应用的可用性响应被丢弃。
9. 保存成功以后端 `api_code/apiUrl/app_version` 为准。
10. 不新增裸 `fetch`、`window.confirm` 或 `innerHTML` 动态渲染。

### 11.6 真实服务器契约测试

扩展 `test/live-server-contract.test.js`：

- 用包含时间戳的唯一自定义编号创建规则。
- 用该编号发送一条测试消息（测试环境允许时）。
- 改成第二个编号后验证旧地址 404、新地址不为 404。
- 清理规则；清理不能假设旧编号可再次使用。

## 12. 推荐实施顺序

### 阶段 A：锁定协议

1. 先提交/确认本建议书中的格式、旧编号策略和错误码。
2. 写编号规范化单测、HTTP 合约失败测试和 SQLite 冲突失败测试。
3. 运行目标测试并确认因功能缺失而失败，而不是测试夹具错误。

### 阶段 B：数据库完整性

1. 新增 `retired_notify_codes`。
2. 新增迁移审计。
3. 新增不区分大小写索引和跨表/历史防冲突触发器。
4. 实现事务内冲突查询和退役 helper。
5. 先让真实 SQLite 完整性测试通过。

### 阶段 C：Service

1. 新增 `notify-code.js`。
2. 修改 `createRule`、`updateRule`。
3. 抽取统一改号 helper，改造 regenerate。
4. 修改单条删除和应用级联删除。
5. 修正配置随机 Code 冲突的错误翻译与重试。
6. 统一发送目标解析与缓存清理。

### 阶段 D：路由与 API 合约

1. 新增 availability 路由。
2. 保持现有创建/更新路由，仅扩展 body 字段。
3. 补齐稳定错误码和响应字段。
4. 运行后端和 HTTP 矩阵测试。

### 阶段 E：前端

1. 增加输入框、路径前缀、帮助和安全提示。
2. 补充表单状态、payload、快照恢复。
3. 增加独立的可用性请求代次。
4. 增加改号确认和错误分支。
5. 更新列表与成功提示。
6. 运行全部前端测试。

### 阶段 F：文档与回归

1. 更新 `public/api-docs.html` 的规则请求体、更新说明、错误码和 HMAC 路径说明。
2. 必要时更新 `README.md` 的功能说明。
3. 运行完整测试。
4. 手工执行第 14 节验收场景。

不要先改 UI、最后才处理数据库唯一性；那样最容易留下“看起来能用，遇到并发就错”的实现。

## 13. 验证命令与通过标准

项目要求 Node.js 24。建议按以下顺序验证：

```powershell
node --test --test-isolation=none test/notify-code.test.js test/backend-rule-api-code-sqlite.test.js
node --test --test-isolation=none test/backend-rules-cache.test.js test/backend-rule-version.test.js test/backend-management-http-matrix.test.js
node --test --test-isolation=none test/frontend-rules-page.test.js test/frontend-rules-page-behavior.test.js test/frontend-conflict-and-isolation.test.js
npm test
```

通过标准：

- 新增目标测试全部通过。
- `npm test` 全量通过，无跳过新增的本地测试。
- 没有新增未处理的 Promise rejection、SQLite busy/constraint 原始错误或前端控制台异常。
- 旧客户端不传 `api_code` 时仍能创建 UUID 规则。
- 失败事务不改变规则、版本或退役记录。

## 14. 手工验收场景

1. 新建规则，编号留空：得到 UUID 地址并可复制。
2. 新建规则，输入 ` Ops-Alert `：保存为 `ops-alert`。
3. 再建一条 `OPS-ALERT`：前端预检提示占用，强行保存仍由服务端返回 409。
4. 输入当前某应用 Code：返回编号冲突，不改变应用版本。
5. 编辑 `ops-alert` 为 `ops-alert-v2`：出现确认弹窗；确认后新地址生效，旧地址 404。
6. 用另一条规则申请 `ops-alert`：被历史占用拒绝。
7. 原规则从 `ops-alert-v2` 改回 `ops-alert`：允许，`ops-alert-v2` 转为退役。
8. 两个浏览器窗口同时改同一应用规则：后提交者得到 `APP_VERSION_CONFLICT`，表单编号不丢失。
9. 两条规则并发申请同一新编号：只有一个成功，应用版本只增加一次。
10. 随机重生成：新 UUID 生效，旧自定义编号不能被其他规则申请。
11. 删除规则：原地址 404，编号不能被新规则申请。
12. 删除应用：应用 Code 与所属规则编号均不能被后续规则接管。
13. 开启通知密钥后改号：Key 不变化；HMAC 按新路径签名可用，旧路径失败。
14. 快速切换应用并连续输入编号：旧应用/旧输入的可用性响应不会覆盖当前状态。

## 15. 完成定义（Definition of Done）

- [ ] 规则创建支持可选 `api_code`，不传仍自动生成 UUID。
- [ ] 规则编辑支持修改 `api_code`，省略字段保持兼容。
- [ ] 前后端格式、字段名、错误码一致。
- [ ] 规则、配置、退役编号处于同一全局命名空间。
- [ ] 当前唯一性有数据库防线，不只靠前端或事务外查询。
- [ ] 改号/重生成/删除/级联删除正确维护退役编号。
- [ ] 旧编号不能误投到其他目标，同一活跃规则可恢复自己的旧编号。
- [ ] 改号与应用版本原子提交，失败完整回滚。
- [ ] 编号冲突与版本冲突可区分，前端不匹配中文文案。
- [ ] 发送鉴权与实际发送使用一致的目标解析。
- [ ] 改号后缓存立即失效。
- [ ] UI 有改号确认、可用性提示和通知密钥安全提示。
- [ ] API 文档更新。
- [ ] 新增单元、真实 SQLite、HTTP、前端行为与回归测试。
- [ ] `npm test` 通过，并记录实际测试结果。

## 16. 可直接交给编程 AI 的执行指令

```text
请严格依据 docs/superpowers/specs/2026-07-04-rule-api-custom-code-design-and-ai-implementation-guide.md 实现“接收规则 API 自定义编号”。

执行要求：
1. 先阅读建议书列出的现有实现文件和测试，不要凭空重构。
2. 按 TDD 顺序：先写失败测试，再实现数据库完整性、Service、路由、前端和文档。
3. 对外字段只使用 api_code；创建时省略/留空自动生成，更新时省略表示不改、显式空值报错。
4. 全局检查规则编号、应用 Code 和退役编号；不能只依赖 notification_rules.api_code 的单表 UNIQUE。
5. 所有改号/删除动作必须与应用 app_version 在同一事务提交；继续使用 If-Match。
6. 修改、随机重生成和删除后的旧编号必须保留占用，避免被其他目标接管；同一条仍存在的规则允许恢复自己的历史编号。
7. 编号冲突返回 409 RULE_API_CODE_CONFLICT，格式错误返回 400 RULE_API_CODE_INVALID，不能混同 APP_VERSION_CONFLICT。
8. 前端必须保留版本冲突时的 api_code 输入，使用独立请求代次处理可用性预检，并在改号前确认旧地址立即失效。
9. 不新增第二套通知密钥 UI，不把自定义编号当凭证。
10. 保留并兼容现有 regenerate 接口，但让它复用统一改号逻辑。
11. 不修改无关文件，不覆盖工作区中用户已有改动，不使用破坏性 Git 操作。
12. 完成后运行建议书第 13 节全部验证，报告测试命令、通过数量、未解决事项和实际修改文件。

若实现中发现建议书与真实代码冲突，先以“不变量、API 合约、事务安全”为准，记录差异和理由；不得静默降低唯一性、历史占用或并发要求。
```

## 17. 风险与回滚

### 17.1 主要风险

- 迁移发现历史跨表冲突，服务无法安全启动。
- 旧事务测试桩不支持新增 SQL，产生假失败。
- 409 编号冲突被前端误当成版本冲突，导致无意义刷新。
- 改号成功但缓存未清理，旧地址短期仍可用。
- 删除路径漏写退役表，之后出现误投递。
- 配置创建把命名空间冲突误报成应用身份冲突。
- availability 旧响应覆盖新输入，给出错误可用状态。

### 17.2 回滚策略

- 数据库变更为加法：退役表、索引和触发器可以随新版保留，旧版代码不会读取退役表。
- 不建议回滚时删除退役数据；删除会重新引入旧地址被接管的风险。
- 若必须回退应用代码，先确认旧版所有写路径不会被新触发器意外拦截；随机 UUID 正常情况下不会冲突。
- 遇到迁移审计冲突时，优先人工确认目标归属并改号，不自动清理或覆盖历史数据。

---

本建议书的核心判断是：**`/api/notify/{code}` 的最后一段不是普通展示字段，而是一个可长期被外部系统持有的投递目标标识。** 因此，格式校验解决的是“能不能写”，全局唯一解决的是“现在发给谁”，退役占用解决的是“旧调用方以后会不会发错人”；三者必须一起实现。
