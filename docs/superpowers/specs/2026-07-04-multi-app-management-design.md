# 多应用管理设计与实施计划：应用增删改、总开关与管理界面重构

> **状态**：待审核，暂不实施  
> **日期**：2026-07-04  
> **代码基线**：`dev@562e047`  
> **运行基线**：Node.js `v24.18.0`、npm `11.16.0`  
> **测试基线**：`npm.cmd test`，100 项通过、0 失败  
> **实施原则**：先修正多应用数据不变量与后端契约，再接入管理 UI；每阶段均可独立测试、提交和回滚。

---

## 0. 结论摘要

本项目不需要新增独立的 `apps` 表。现有 `configurations` 一行可以继续代表一个企业微信自建应用，`notification_rules.config_code` 代表该应用下的发送规则。本次采用：

- 一个已完成应用对应一个不可变的配置 `code`；应用身份为 `(corpid, agentid)`。
- 同一 `corpid` 下允许多个不同 `agentid`，管理页按 `corpid` 分组。
- 新增 `app_enabled` 作为应用总开关；它高于配置 Code 开关和规则开关。
- 后端统一输出生命周期、操作能力和告警，前端不自行拼装业务状态。
- 删除应用时同时删除其规则，必须由事务保证，不依赖前端逐条删除。
- `corpid` 创建后不可修改；`agentid`、`corpsecret`、描述、回调配置、默认接收成员可编辑。
- 所有应用级写操作使用版本号防止多页面静默覆盖，错误使用稳定业务码驱动前端恢复动作。
- 基础应用的默认接收范围保持现状，只支持成员 `touser`；部门和标签仍只属于规则，不在本次给 `configurations` 扩列。
- 现有两步创建流程可以保留，但必须先修复“按 corpid 复用已完成配置”的问题，否则同一企业新增第二个应用可能覆盖旧应用。
- 首版缓存失效以正确性优先，继续使用全量 `clearRuntimeCaches()`；不在本次引入复杂的精细失效算法。
- token 缓存没有“改密钥后继续使用旧 token”的正确性 Bug：缓存键已经包含 `corpid + corpsecret 哈希`。本次要解决的是两个 `WeChatService` 实例造成的缓存割裂，并在改密钥/删除时清理旧 token，属于资源与一致性收口。

---

## 1. 业务目的与统一语言

### 1.1 要解决的业务问题

本功能不是单纯“把配置列成表格”，而是要让管理员能安全地完成五类工作：

1. **接入第二个及后续应用**：同一企业新增应用时生成独立 Code，不覆盖、串用或误改已有应用。
2. **快速判断运行状态**：一眼识别应用属于哪个企业、是否完成、是否暂停、直接发送和规则发送分别是否可用。
3. **紧急止损**：凭证泄露、应用异常或误发时，用一个总开关阻止该应用的所有新发送，不破坏规则配置。
4. **日常维护**：安全修改凭证、AgentID、默认接收人、回调和通知安全设置，不因局部修改覆盖其他管理员的更新。
5. **安全下线**：删除前看清关联规则和失效地址，删除时保证应用与规则要么全部成功、要么全部保留。

业务优先级固定为：**数据归属正确 > 暂停/删除可控 > 凭证与敏感数据安全 > 操作效率 > 视觉一致性**。若实现取舍发生冲突，按此顺序决策。

### 1.2 成功结果

- 同一 `corpid` 的不同 AgentID 永远不会因新建流程共用同一行配置。
- 管理员无需理解数据库字段，也能区分“应用已暂停”“仅直接 Code 关闭”“某条规则关闭”。
- 暂停不等于删除：暂停后仍可查看、编辑、管理规则和安全设置，为恢复服务做准备。
- 前端不猜测业务状态；生命周期、操作能力、稳定错误码均由后端给出。
- 任何写操作的成功响应都代表数据库已提交且后续读取可观察到新状态。

### 1.3 统一术语

| 业务术语 | 代码/数据库对应 | 前端文案约束 |
|---|---|---|
| 企业 | `corpid` | 显示“企业”，值默认脱敏；不把 corpid 称作应用 ID |
| 应用 | `configurations` 的一行 | UI 统一称“应用”，API 为兼容仍使用 `configuration` 路径 |
| 应用名称 | `configurations.description` | 表单显示“应用名称/备注”，不新增仅用于展示的 name 字段 |
| 应用 Code | `configurations.code` | 显示“应用 Code”或“默认发送 Code”，不简称为规则 Code |
| 规则 API Code | `notification_rules.api_code` | 显示“规则 API Code” |
| 应用总开关 | `app_enabled` | 显示“应用发送总开关”，说明会同时影响直接和规则发送 |
| 默认发送开关 | `code_send_enabled` | 显示“允许应用 Code 直接发送”，明确不控制规则 |
| 规则开关 | `notification_rules.enabled` | 显示“规则启用”，只控制当前规则 |
| 默认接收人 | `configurations.touser` | 只包含成员 UserID |
| 规则接收范围 | 规则的 `touser/toparty/totag/is_all` | 可包含成员、部门、标签或全体 |
| 草稿 | 未完成的 `configurations` 行 | 显示“待完善”，不可称为已暂停应用 |

代码中的变量、API 文档和测试名称也应遵守这组映射，避免同一对象在不同层分别叫“配置”“应用”“回调配置”而产生误解。

---

## 2. 范围与非范围

### 2.1 本次范围

1. 应用总览：按企业分组、应用状态、默认接收人数、规则数、创建时间。
2. 新增应用：四步向导、可恢复未完成草稿、内联校验。
3. 编辑应用：除 `corpid` 外的现有配置字段，敏感字段留空表示不变。
4. 删除应用：展示关联规则及影响，事务级联删除。
5. 暂停/恢复应用发送：配置 Code 和该应用下全部规则 API 均受总开关控制。
6. 配置级安全设置入口：通知密钥、配置 Code 发送开关可从应用管理链路到达。
7. 统一管理页面的导航、Toast、确认对话框和基础视觉样式。
8. 补齐后端、前端行为测试和 API 文档。

### 2.2 明确不做

- 不把多个企业微信应用合并到同一个配置 Code。
- 不新增基础配置的 `toparty` / `totag`；部门、标签继续由规则承载。
- 不自动合并或删除历史上相同 `(corpid, agentid)` 的重复配置。
- 不取消正在执行的发送请求；暂停或删除只保证后续新请求被拒绝。
- 不引入前端构建工具、框架或新的 CDN 依赖。
- 不在首版实现分页、批量删除、批量暂停/恢复、企业别名或 RBAC。
- 不在首版把所有错误处理和所有旧页面一次性重写；只统一本功能涉及的契约。

---

## 3. 代码核查结果与对计划的修正

| 代码事实 | 位置 | 对实施的影响 |
|---|---|---|
| `configurations` 已包含企业、应用凭证、默认接收人、回调和安全设置 | `src/core/database.js:40-55` | 无需新增 `apps` 表，直接补 `app_enabled` |
| 当前唯一约束是 `(corpid, agentid, touser)`，不是应用身份唯一 | `src/core/database.js:54` | 新建、完成和实际修改 AgentID 时按 `(corpid, agentid)` 判重；历史重复项只标记，不自动合并 |
| 规则表没有外键和 `ON DELETE CASCADE` | `src/core/database.js:58-72` | 删除必须新增事务 DAO，不能只删配置行 |
| 回调草稿查询只按 `corpid + callback_enabled`，而且实参中的 token 被忽略 | `src/core/database.js:230-233`、`src/services/notifier.js:453-460` | 可能把已完成的同企业应用当作新建草稿复用，是多应用功能的首要阻塞项 |
| `completeConfiguration()` 对任意存在的 code 都可执行，没有验证它仍是草稿 | `src/services/notifier.js:485-517` | 必须禁止通过“完成配置”接口覆盖已完成应用 |
| 基础配置只有 `touser`，规则才有 `toparty` / `totag` | `src/core/database.js:47,64-66` | 向导和编辑页的默认接收人只做成员选择；共享选择器需支持“成员模式”和“规则模式” |
| `PUT /api/configuration/:code` 的业务层接受局部 payload，但 DAO 最终全字段 UPDATE | `src/core/database.js:181-198`、`src/services/notifier.js:1055-1158` | 编辑页复用路径，但 DAO 改 touched-field 更新并加版本，防止并发覆盖 |
| 路由层和 notifier 各自实例化了 `WeChatService` | `src/api/routes.js:15`、`src/services/notifier.js:17` | `/api/validate` 与实际发送不共享 token 缓存；应收口到 notifier 中的实例 |
| token 缓存键包含 `corpid + corpsecret 哈希` | `src/core/wechat.js:108-139` | 改 secret 后不会命中旧 token；旧 token 清理是内存/安全卫生，不是发送正确性修复 |
| 已有配置 Code 开关和规则开关 | `src/api/routes.js:226-249`、`src/services/notifier.js:1345-1355` | 应用总开关应成为最外层判断，且不能改写子开关原值 |
| `resolveNotifyAuth()` 先判断规则/Code 开关，再校验通知密钥 | `src/api/routes.js:228-285` | 需重排为“解析所属应用 → 草稿状态 → 应用总开关 → 子开关 → 通知密钥” |
| `listConfigurations()` 缺少 corpid、生命周期、规则数等管理字段 | `src/core/database.js:172-179`、`src/services/notifier.js:651-661` | 扩展现有 `/api/configurations`，保持原字段兼容 |
| 配置详情会解密返回回调 Token，旧首页还会展示 | `src/services/notifier.js:1032-1043`、`public/script.js:315` | 新 UI 改为 configured 标志；旧首页下线后停止返回 Token 明文并写明兼容变化 |
| 运行时缓存全清包含 target、成员、发送结果和在途去重表 | `src/services/notifier.js:210-215` | 首版沿用全清；删除后另清理对应 token，避免过早优化 |
| 当前前端为无构建步骤的 HTML + 普通 JS，使用固定版本 Tailwind/DaisyUI/Lucide | `public/*.html` | 公共组件继续使用普通脚本和 CSS，不引入模块打包器 |
| 当前自动化测试实际为 100 项，不是旧草案中的 41 项 | `package.json`、`test/` | 验收以基线 100 项全部回归通过为准，不硬编码实施后的总数 |

---

## 4. 领域模型与强制不变量

### 4.1 实体定义

```text
企业（corpid）
└─ 应用配置 configurations（code，agentid，凭证，默认 touser）
   ├─ 应用总开关 app_enabled
   ├─ 配置 Code 开关 code_send_enabled
   ├─ 通知密钥 notify_key_hash
   └─ 发送规则 notification_rules（config_code，api_code，enabled，独立接收范围）
```

### 4.2 不变量

1. `code` 创建后不可修改。
2. `corpid` 在草稿生成后不可通过编辑接口修改；更换企业必须新建应用。
3. 新建、完成或实际改变 AgentID 后，不得与另一行拥有相同 `(corpid, agentid)`。
4. 历史重复应用不自动合并：总览标记“重复应用”，身份未变时允许编辑、暂停/恢复或删除；新写入继续阻止产生更多重复。
5. 草稿定义为：有 `code/corpid/回调凭证`，但 `encrypted_corpsecret` 为空、`agentid=0`、`touser=''`。
6. `completeConfiguration()` 只能完成草稿，不能再次完成已配置应用。
7. `app_enabled` 默认 `1`；旧数据迁移后全部保持启用。
8. 应用暂停不修改 `code_send_enabled` 和规则 `enabled`，恢复发送后沿用各子开关原状态。
9. 敏感字段不进入 URL、localStorage 或 sessionStorage；前端留空时不发送该属性。
10. 删除应用不可恢复；删除成功后配置 Code、规则 API Code 后续返回 404，回调验证/接收失败，不再命中原配置。

### 4.3 生命周期与状态机

应用只有一个主生命周期；“重复身份”是数据告警，“默认发送关闭/部分规则关闭”是通道状态，均不能冒充主状态。

```text
                 完成配置
  DRAFT（待完善） ─────────→ ACTIVE（运行中）
       │                         │  ▲
       │ 删除                    │  │ 总开关
       ▼                         ▼  │
    DELETED                  PAUSED（已暂停）
                                  │
                                  └──── 删除 → DELETED
```

| 状态 | 判定 | 可发送 | 可编辑 | 可管理规则/安全设置 | 可删除 |
|---|---|---:|---:|---:|---:|
| `draft` | `completed=false` | 否，409 | 仅继续向导 | 否 | 是 |
| `active` | `completed=true && app_enabled=true` | 继续判断子开关 | 是 | 是 | 是 |
| `paused` | `completed=true && app_enabled=false` | 否，403 | 是 | 是 | 是 |
| `deleted` | 数据不存在 | 否，404 | 否 | 否 | 否 |

后端统一返回 `lifecycle_status`，并通过 `warnings` 表示 `duplicate_identity` 等告警。前端禁止根据多个布尔字段自行推导另一套状态。

草稿只允许：读取自身摘要、更新草稿回调、完成配置、验证待填凭证以及删除。成员读取、应用/Code/密钥开关和规则管理统一返回 `409 APP_NOT_COMPLETED`；回调验证为完成接入所必需，仍允许使用草稿 callback URL。

### 4.4 三层发送开关与返回优先级

```text
POST /api/notify/:requestedCode
  → 解析 requestedCode 是配置 Code 还是规则 API Code，并找到所属 config
  → config 不存在：404
  → 应用仍是草稿：409「应用尚未完成配置」
  → app_enabled = 0：403「该应用已暂停发送」
  → 配置 Code 入口且 code_send_enabled = 0：403
  → 规则入口且 rule.enabled = 0：403
  → 如启用通知密钥，校验 X-Notify-Key / HMAC：401
  → 发送
```

发送条件为：

```text
配置 Code：app_enabled AND code_send_enabled AND notify_auth_ok
规则 API： app_enabled AND rule.enabled       AND notify_auth_ok
```

回调验证和回调接收不属于“发送”，本次不受 `app_enabled` 影响。

暂停只影响发送链路。所有已认证管理 API（详情、编辑、成员读取、规则管理、安全设置）在 `paused` 状态仍可使用；否则管理员将无法修复问题后恢复应用。

### 4.5 前后端单一事实来源

所有配置摘要由 notifier 的同一个序列化函数生成，列表、详情和规则页不得分别实现布尔转换。建议响应统一包含：

```json
{
  "lifecycle_status": "active",
  "warnings": [],
  "capabilities": {
    "can_resume": false,
    "can_edit": true,
    "can_toggle": true,
    "can_manage_rules": true,
    "can_delete": true
  }
}
```

- 后端决定 `lifecycle_status` 和 `capabilities`；前端只渲染，不复制判定条件。
- `duplicate_identity` 放入 `warnings`，不改变 active/paused，也不禁止独立暂停、恢复和删除。
- 规则页和编辑页若发现服务端状态发生变化，应刷新公共应用摘要，而不是沿用页面初始化时的旧布尔值。

---

## 5. 创建流程的兼容修复

现有首页先调用 `POST /api/generate-callback` 创建半成品行，再调用 `POST /api/complete-config` 完成。该流程能提前生成回调 URL，但当前草稿识别方式会复用同一企业下已完成应用，必须先修。

首版管理 UI 延续“先生成回调 URL，再配置企业微信后台和 IP 白名单”的标准接入路径，因此向导要求回调配置。后端兼容接口 `/api/configure` 仍允许创建不启用回调的通知应用，但前端首版不提供该分支；这是有意的产品范围差异，不能让前端假装支持后端的全部可选组合。

### 5.1 草稿查询

新增 `db.getIncompleteConfigurationByCorpId(corpid)`，只允许命中真正未完成的行：

```sql
SELECT *
FROM configurations
WHERE corpid = ?
  AND agentid = 0
  AND touser = ''
  AND encrypted_corpsecret = ''
ORDER BY id DESC
LIMIT 1
```

不再用 `callback_enabled = 1` 判断草稿，因为已完成且启用回调的应用同样满足该条件。

### 5.2 生成回调配置

`POST /api/generate-callback` 保留原 URL，行为调整为：

- 请求体为 `{ corpid, callback_token, encoding_aes_key, draft_code?, version? }`。
- 没有 `draft_code` 且没有草稿：创建新草稿并返回 `201`、`code`、`callbackUrl`、`version: 1`、`lifecycle_status: "draft"`。
- 没有 `draft_code` 但已有同企业草稿：返回 `409 APP_DRAFT_EXISTS`，`details.existing_code` 供前端展示“继续配置”或“删除草稿后重建”。
- 传入 `draft_code`：必须同时传当前 `version`，仅允许更新同一 corpid 的现有草稿回调凭证，成功返回 `200` 和递增后的版本；code 不属于草稿、版本冲突或 corpid 不匹配时返回稳定错误码，绝不修改已完成应用。
- 恢复入口使用 `/new?code=<draft-code>`；只加载非敏感状态，不回填 secret、Token 或 AESKey。
- 提交按钮在请求期间禁用，避免双击产生重复请求。

由于现有表级唯一约束包含 `(corpid, 0, '')`，同一企业最多存在一个草稿。首版接受这一限制，并把冲突显式呈现给用户。

### 5.3 完成草稿

`POST /api/complete-config` 的请求体增加草稿 `version`，并执行以下检查：

1. code 存在且仍满足草稿定义；已完成时返回 `409 APP_ALREADY_COMPLETED`，不得再次写入。
2. 使用共享的 `WeChatService` 验证 `corpid + corpsecret + agentid`。
3. 按 `(corpid, agentid)` 查询其他已完成配置；冲突返回 `409 APP_IDENTITY_CONFLICT`，并在 `details.existing_code` 给出现有 code。
4. 更新草稿后重新读取并返回标准化配置摘要。

校验和完成写入必须防止并发创建同一应用；在事务内完成“身份判重 + 更新草稿”。不新增数据库唯一索引，以免升级时因历史重复数据导致启动失败。

兼容接口 `POST /api/configure` 也必须复用同一身份判重和原子写入逻辑，不能成为绕过多应用不变量的旁路。

若完成请求的响应在网络中丢失，前端重试收到 `APP_ALREADY_COMPLETED` 后应读取 `details.existing_code` 的详情；确认 AgentID 与当前向导一致时进入成功页，否则停止并提示刷新。不能为了“重试方便”再次覆盖已完成行。

### 5.4 四步向导

1. **企业与回调**：CorpID、回调 Token、EncodingAESKey；创建草稿并展示回调 URL。
2. **应用信息与凭证**：应用名称/备注、CorpSecret、AgentID；显示脱敏企业上下文，调用 `/api/validate`。
3. **默认接收成员**：成员搜索、多选、全选、不可见旧成员提示；不提供部门/标签输入。
4. **确认与完成**：只读摘要，调用 `/api/complete-config`；成功页提供 API 地址和回调地址复制按钮，再返回总览。

sessionStorage 只允许保存：`draft_code`、`version`、当前步骤、`corpid`、`agentid`、描述和已选 UserID。CorpSecret、回调 Token、EncodingAESKey 不得持久化，刷新后需重新输入必要的敏感项。

从步骤 2 返回步骤 1 时，提交必须携带现有 `draft_code`；服务端据此更新当前草稿的回调凭证。生成草稿后 CorpID 锁定，如需更换企业，应确认删除当前草稿后重新开始，避免一个 code 在不同企业间漂移。

---

## 6. 后端设计

### 6.1 数据库迁移

在 `Database.createTables()` 中沿用现有幂等迁移模式：

```sql
ALTER TABLE configurations ADD COLUMN app_enabled INTEGER DEFAULT 1;
UPDATE configurations SET app_enabled = 1 WHERE app_enabled IS NULL;
ALTER TABLE configurations ADD COLUMN version INTEGER DEFAULT 1;
UPDATE configurations SET version = 1 WHERE version IS NULL OR version < 1;
```

要求：

- `app_enabled` 只接受 `0/1`，业务层统一序列化成布尔值。
- `version` 是应用聚合版本；除删除外，应用字段、安全设置或所属规则发生任何成功写入时都原子执行 `version = version + 1`；删除只校验当前版本后移除整行。
- 不重建表，不修改当前唯一约束，不自动处理历史重复配置。
- 增加重复身份查询，用于总览标记和新写入判重。

### 6.2 数据库事务

新增事务能力时不能简单实现成 `runTransaction(async fn)` 后在共享 sqlite 连接上任意 `await`，否则其他请求的语句可能插入同一事务。实现必须保证事务期间该连接上的语句串行且不会混入其他请求。

至少提供：

```js
await db.withTransaction(async (tx) => {
  const rulesDeleted = await tx.run(...);
  const configsDeleted = await tx.run(...);
  return { rulesDeleted, configsDeleted };
});
```

并满足：

- `BEGIN IMMEDIATE → COMMIT`；异常执行 `ROLLBACK`。
- 事务中的查询使用 `tx` 句柄，不能回调普通 `db.runRaw()`。
- 共享连接上的其他数据库操作需排队到事务结束后。
- 为“第一条删除成功、第二条删除失败”编写回滚测试。
- “校验版本 → 修改应用/规则 → 递增应用版本”必须在同一事务内完成，禁止先查版本再在事务外更新形成 TOCTOU。

新增 `db.deleteConfigurationCascade(code, expectedVersion)`：

1. 在事务内读取并校验应用存在且版本等于 `expectedVersion`。
2. 删除 `notification_rules WHERE config_code = ?`。
3. 删除 `configurations WHERE code = ? AND version = ?`。
4. 返回两条语句各自的 `changes`。
5. 配置不存在返回 404；版本不符返回 409；配置删除数不为 1 时回滚。

### 6.3 WeChatService 收口

- 删除 `src/api/routes.js` 中单独创建的 `new WeChatService(...)`。
- 在 notifier 新增 `validateApplicationCredentials({ corpid, corpsecret, agentid })`，内部复用 notifier 的 `wechat` 实例。
- `/api/validate` 改调该服务，保证验证、成员读取和发送共享 token 缓存。
- 更新 CorpSecret 成功后，使用旧 `corpid + oldSecret` 调用 `invalidateToken()`；无需因 AgentID 变化清 token，因为 token 键不包含 AgentID。
- 删除配置成功后尽力失效其 token。若多个历史配置共享相同凭证，只会造成下一次重新取 token，不影响正确性。

### 6.4 更新应用

增强现有 `notifier.updateConfiguration(code, payload)`：

- payload 含与原值不同的 `corpid`：返回 `400`，提示更换企业需新建应用。
- `corpsecret` 未传或为空：保留原值；前端不得把空字符串作为“清空 secret”发送。
- 修改 CorpSecret 或 AgentID：先用最终候选值验证企业微信凭证和应用，再写库。
- 修改 AgentID：按 `(corpid, targetAgentid)` 判重，排除当前 code。
- 历史重复项在未改变 AgentID 时允许修改描述、凭证和接收人；不能因为它已经重复而阻断止损和整理。只有新建、完成或实际改变 AgentID 时执行身份冲突拦截。
- 修改默认接收成员：继续标准化、去空、去重，至少保留一个成员。
- 回调开启时 Token/AESKey 最终状态必须完整；敏感字段未传则保留原值。
- 描述和默认接收人变更无需调用企业微信凭证验证。
- DAO 只更新 payload 实际触及的字段，禁止把服务层早先读取的整行重新覆盖回去。
- DB 更新成功后调用 `clearRuntimeCaches()`；凭证验证或 DB 更新失败时不改变原配置。

#### 配置并发控制

现有 DAO 使用全字段 `UPDATE`，两个管理页面同时保存时可能发生“后保存的描述把先保存的接收人覆盖掉”。本次用“局部字段更新 + 版本号”解决：

1. 列表和详情返回 `version`，前端保存当前版本。
2. `PUT/DELETE` 及应用级设置变更携带 `If-Match: "<version>"`。
3. SQL 使用 `WHERE code = ? AND version = ?`，成功时同时 `version = version + 1`。
4. 缺少 `If-Match` 返回 `428 APP_VERSION_REQUIRED`；版本不匹配返回 `409 APP_VERSION_CONFLICT` 和最新摘要。
5. 前端冲突时保留用户输入，展示“应用已在其他页面更新”，允许加载最新值后重新确认；禁止静默覆盖。
6. 规则行保留自己的 `updated_at`，但规则增删改、API Code 重生成和规则启停也必须递增所属应用版本，防止删除预览后又新增规则却仍按旧影响范围删除。

应用总开关、默认发送开关、通知密钥变更、规则变更和删除都属于应用聚合写操作，必须遵守同一版本前置条件。除删除外，成功响应返回新 `version/app_version`；删除返回计数。草稿创建返回初始版本；草稿回调更新和完成也携带版本。

### 6.5 应用总开关

新增 `notifier.setAppEnabled(code, enabled)`：

1. 使用 `toStrictBoolean()` 严格解析，非法值返回 `400`。
2. 配置不存在返回 `404`。
3. 未完成草稿不允许切换，返回 `409`。
4. 校验版本，更新 `app_enabled` 并递增版本，清运行时缓存，返回 `{ code, app_enabled, version }`。

`resolveNotifyAuth()` 重排判断顺序；此外在 notifier 的目标解析/发送入口再校验一次 `app_enabled`，防止未来内部调用绕过 HTTP 路由。

### 6.6 删除应用

新增 `notifier.deleteConfiguration(code, expectedVersion)`：

1. 读取配置和关联规则；不存在返回 `404`。
2. 解密旧 CorpSecret 仅用于后续 token 清理，不写日志、不返回前端。
3. 调用 `db.deleteConfigurationCascade(code, expectedVersion)`，在事务内重新校验版本。
4. **事务提交成功后**清运行时缓存并失效旧 token。
5. 返回 `{ code, configurations_deleted: 1, rules_deleted: N }`。

事务失败时不得清理数据库记录，也不得向前端报告成功。已经开始的发送可能完成；提交后发起的新请求必须返回 404。

### 6.7 列表和详情序列化

扩展 `GET /api/configurations`，保留当前字段并新增：

```json
{
  "configurations": [
    {
      "code": "uuid",
      "corpid": "ww...",
      "agentid": 1000002,
      "description": "告警应用",
      "version": 3,
      "completed": true,
      "duplicate_identity": false,
      "lifecycle_status": "active",
      "warnings": [],
      "app_enabled": true,
      "callback_enabled": true,
      "code_send_enabled": true,
      "recipient_count": 3,
      "rule_count": 2,
      "enabled_rule_count": 1,
      "capabilities": {
        "can_resume": false,
        "can_edit": true,
        "can_toggle": true,
        "can_manage_rules": true,
        "can_delete": true
      },
      "created_at": "..."
    }
  ]
}
```

说明：

- 列表不返回 CorpSecret、AESKey、通知密钥哈希或完整默认成员列表。
- `recipient_count` 由标准化后的 `touser` 计算，不能用分隔符数量直接推断。
- `rule_count/enabled_rule_count` 由 SQL 聚合或批量查询获得，禁止前端对每行发一次请求形成 N+1。
- `getConfiguration()`、`listConfigurations()`、`listRules()` 复用同一个 `serializeConfigurationSummary()`，统一输出 `version/lifecycle_status/warnings/capabilities`。
- 详情增加 `corpsecret_configured`、`callback_token_configured`、`encoding_aes_key_configured`，只表示是否配置。
- 新 UI 不需要也不展示回调 Token 明文；旧首页同步下线后，`getConfiguration()` 停止返回 `callback_token`。该兼容变化必须写入 API 文档和发布说明。

### 6.8 API 与页面路由

| 方法 | 路径 | 鉴权 | 行为 |
|---|---|---|---|
| GET | `/api/configurations` | requireAuth | 扩展管理列表字段 |
| GET | `/api/configuration/:code` | requireAuth | 返回编辑所需的非 secret 状态 |
| PUT | `/api/configuration/:code` | requireAuth | 按 `If-Match` 局部更新应用 |
| DELETE | `/api/configuration/:code` | requireAuth | 按 `If-Match` 事务删除应用及规则 |
| PUT | `/api/configuration/:code/app-enabled` | requireAuth | 按 `If-Match` 更新严格布尔总开关 |
| PUT | `/api/configuration/:code/code-send` | requireAuth | 按 `If-Match` 更新默认发送开关 |
| POST/DELETE | `/api/configuration/:code/notify-key` | requireAuth | 按 `If-Match` 启用/轮换/撤销通知密钥 |
| POST | `/api/configuration/:code/rules` | requireAuth | 按应用 `If-Match` 新建规则并返回 app_version |
| PUT/DELETE | `/api/rules/:id` | requireAuth | 按所属应用 `If-Match` 更新/删除规则 |
| PUT/POST | `/api/rules/:id/enabled`、`/regenerate` | requireAuth | 按所属应用 `If-Match` 启停/重生成并返回 app_version |
| POST | `/api/generate-callback` | requireAuth | 只处理真正草稿，冲突返回 409 |
| POST | `/api/complete-config` | requireAuth | 按草稿版本完成配置，身份判重 |
| POST | `/api/configure` | requireAuth | 兼容单次创建，复用身份判重事务 |
| POST | `/api/validate` | requireAuth | 改用 notifier 的 WeChatService |
| GET | `/` | 页面会话 | 应用总览（替换当前首页） |
| GET | `/new` | 页面会话 | 新建向导 |
| GET | `/edit` | 页面会话 | 编辑/安全设置页 |
| GET | `/rules` | 页面会话 | 规则页，支持 `?code=` |
| GET | `/api-docs.html` | 页面会话 | API 文档 |

页面鉴权失败统一重定向 `/login`；API 鉴权失败继续返回 JSON 401。当前 `/rules` 和 `/api-docs.html` 也应接入页面会话守卫。`/public/*` 只提供静态资源，不承载数据鉴权。

除删除外，所有应用聚合写接口成功后返回统一的最新应用摘要或至少返回 `{ code, version/app_version }`；前端不得在本地猜测递增版本。删除成功返回删除计数，不再返回版本。管理读取在 paused 状态正常工作，只有发送入口受应用总开关拦截。

### 6.9 错误契约

HTTP 状态码表达错误类别，`code` 为前端分支使用的稳定业务码，`error` 只用于用户阅读。前端禁止匹配中文错误字符串。

```json
{
  "error": "该企业已有待完善应用",
  "code": "APP_DRAFT_EXISTS",
  "details": {
    "existing_code": "uuid"
  }
}
```

- 保留现有 `error` 字段兼容调用方，不新增冗余 `statusCode`。
- `details` 可省略，只允许放前端完成恢复操作所需的非敏感信息。
- notifier 使用 `createError(message, statusCode, businessCode, details)`；内部属性命名为 `businessCode`，避免与 SQLite/Node 错误自带的 `err.code` 冲突；路由统一调用 `sendError()` 并序列化成 JSON `code`。
- 生产环境 5xx 统一转换为 `INTERNAL_ERROR`，不返回 SQL、路径、密文或上游原始响应。
- 外部企业微信凭证错误转换为 400 `WECHAT_CREDENTIAL_INVALID`；网络/服务异常转换为 502 `WECHAT_UNAVAILABLE`。

| HTTP | 稳定 code | 使用场景 | 前端动作 |
|---:|---|---|---|
| 400 | `INVALID_INPUT` | 字段格式、严格布尔值、回调组合不合法 | 字段就近提示 |
| 400 | `CORPID_IMMUTABLE` | 编辑时试图更换企业 | 提示新建应用 |
| 400 | `WECHAT_CREDENTIAL_INVALID` | CorpSecret/AgentID 无效 | 保留输入并定位凭证区 |
| 401 | `AUTH_REQUIRED` | 会话失效 | 跳转登录 |
| 403 | `APP_DISABLED` | 应用总开关关闭 | 不自动重试 |
| 403 | `DIRECT_SEND_DISABLED` | 应用 Code 直接发送关闭 | 提示使用/检查规则 API |
| 403 | `RULE_DISABLED` | 当前规则关闭 | 提示启用规则 |
| 404 | `APP_NOT_FOUND` | 应用不存在或已删除 | 返回总览并刷新 |
| 404 | `RULE_NOT_FOUND` | 规则不存在或已删除 | 刷新规则列表 |
| 409 | `APP_DRAFT_EXISTS` | 同企业已有草稿 | 提供继续配置入口 |
| 409 | `APP_DRAFT_MISMATCH` | draft code 不属于该企业或已非草稿 | 停止写入并刷新总览 |
| 409 | `APP_NOT_COMPLETED` | 草稿尝试发送/切换/管理规则 | 提供继续配置入口 |
| 409 | `APP_ALREADY_COMPLETED` | 重复完成同一草稿 | 读取详情后进入成功页 |
| 409 | `APP_IDENTITY_CONFLICT` | `(corpid,agentid)` 与其他应用冲突 | 打开现有应用 |
| 409 | `APP_VERSION_CONFLICT` | 管理页面数据已过期 | 保留输入并加载最新版本 |
| 428 | `APP_VERSION_REQUIRED` | 配置写操作缺少版本 | 刷新详情后重试 |
| 502 | `WECHAT_UNAVAILABLE` | 企业微信或网络暂时不可用 | 提示稍后重试 |

现有三个字符串匹配状态函数应在相关 service 错误均有 `businessCode/statusCode` 后退役。测试同时断言 HTTP、JSON `code` 和必要的 `details`，确保前后端行为不会只靠文案偶然一致。

### 6.10 操作可观测性

应用完成、编辑、暂停、恢复、删除以及通知密钥变更在事务提交后记录结构化管理日志，便于排查“谁在什么时候改变了哪个应用”：

- 记录事件名、request ID、应用 code、脱敏 corpid、AgentID、旧/新生命周期、删除规则数和结果。
- 可记录会话 ID 的不可逆摘要，不记录 Cookie、Bearer、CorpSecret、回调 Token、AESKey、通知密钥或请求完整 body。
- 失败日志记录稳定错误码；数据库未提交时不能记录成成功。
- 当前项目只有单管理员账号，本次日志用于运维追踪，不宣称提供不可篡改审计或 RBAC 审计能力。

---

## 7. 前端信息架构与交互

### 7.1 页面结构

- `/`：应用总览，登录后的默认落点。
- `/new`：四步新建向导。
- `/edit?code=<code>`：应用编辑；`?tab=security` 直接打开安全设置。
- `/rules?code=<code>`：指定应用的规则管理。
- `/api-docs.html`：接口文档。

现有 `public/index.html` 和 `public/script.js` 重构为应用总览，不再保留旧首页内嵌的“创建 + 查找 + 编辑接收人”多职责结构。

#### 设置归属

| 设置 | 唯一编辑位置 | 其他页面如何呈现 |
|---|---|---|
| 应用总开关 | 总览行内 toggle | 编辑/规则页只显示状态与返回总览入口 |
| 描述、AgentID、CorpSecret | 编辑页“基本信息/企业凭证” | 总览只读摘要，规则页只读上下文 |
| 回调启停、Token、AESKey | 编辑页“回调配置” | 总览显示是否启用，不显示敏感值 |
| 默认接收成员 | 编辑页“默认接收人” | 总览只显示人数 |
| 应用 Code 直接发送开关 | 编辑页“安全设置” | 总览显示通道状态，规则页不再编辑 |
| 通知密钥 | 编辑页“安全设置” | 规则页只提示该应用是否要求密钥 |
| 规则内容和规则开关 | 规则页 | 总览显示启用数/总数 |

一个设置只能有一个可编辑位置，避免多个页面各自保存并产生不同状态。移动安全设置后，应删除规则页原控件和事件处理器，而不是保留两套入口。

### 7.2 应用总览

按完整 `corpid` 分组，标题只显示脱敏值，例如 `ww12…89ab`，并显示应用数量。每个应用行展示：

- 描述；空值显示“未命名应用”。
- AgentID；草稿显示“待填写”。
- 默认接收人数、规则数、创建时间。
- 主状态文本来自 `lifecycle_status`：`待完善`、`运行中`、`已暂停`；`重复应用`作为独立告警徽标，不能只靠颜色表达。
- 通道摘要：应用 Code `开启/关闭`，规则 `已启用数/总数`。应用暂停时仍显示子开关原值，并注明“总开关暂停中”。
- 应用发送总开关；未完成草稿禁用开关并说明原因。历史重复项仍可独立暂停/恢复，便于先止损再整理。
- 操作：继续配置/编辑、规则、安全设置、删除。

交互要求：

- 加载中使用骨架或明确 loading；空数据提供“新建应用”主按钮；失败提供重试。
- toggle 请求期间禁用，不做无法回滚的纯乐观更新；失败恢复原状态并 Toast。
- 操作按钮的显示和禁用只读取服务端 `capabilities`；例如草稿显示“继续配置”，不显示规则和安全设置入口。
- 响应 `APP_VERSION_CONFLICT` 时不覆盖页面：保留用户输入，弹出“查看最新值/取消”选择；总览 toggle 冲突则刷新该行。
- 响应 `APP_NOT_FOUND` 时移除失效行或返回总览；响应 `AUTH_REQUIRED` 时只记录同源路径作为安全返回地址并跳转登录，禁止接受完整外部 URL。
- 桌面使用表格/行，移动端改为卡片；375、768、1024、1440 宽度验证。
- `?highlight=<code>` 可在新建成功返回后高亮新行，高亮不超过一次会话。

### 7.3 删除确认

点击删除后先取现有规则列表，模态框展示：

- 应用描述、AgentID、脱敏 CorpID。
- 将删除的规则数和规则名称/API Code 摘要。
- 配置 Code、规则 API、回调 URL 都将失效的说明。
- 明确“正在发送的请求可能完成，删除后新请求失效”。

确认按钮使用危险样式；请求期间锁定按钮。成功后从当前分组移除，空分组一并移除；失败保留行和模态框状态。禁止使用 `window.confirm()`。

### 7.4 编辑页

表单分区：

1. 基本信息：描述、AgentID。
2. 企业凭证：CorpID 只读、CorpSecret 密码输入（留空不变）。
3. 回调配置：启停、Token/AESKey 密码输入（留空不变）。
4. 默认接收人：成员选择器。
5. 安全设置：通知密钥状态与启用/轮换/撤销、配置 Code 发送开关。

Payload 只包含用户实际修改的字段，请求携带详情返回的版本。敏感输入离开页面即丢弃，不回填、不写存储。AgentID 或 CorpSecret 变化时，保存按钮文案提示会重新验证凭证。

- paused 应用顶部显示说明横幅，但所有维护表单仍可使用。
- 保存成功后用服务端响应整体刷新摘要和版本，不能只修改本地表单值。
- 版本冲突时不得清空密码框之外的用户输入；敏感输入因安全原因不自动复制到新表单，需提示重新输入。
- 回调关闭只发送 `callback_enabled=false`，默认保留已加密凭证；清除回调凭证不在首版范围，避免“空输入=不改”和“空输入=删除”冲突。

### 7.5 公共组件

在无构建系统前提下，以普通脚本暴露小型命名空间，避免各页复制逻辑：

- `public/styles.css`：CSS 变量、页面布局、状态、焦点、响应式和 reduced-motion。
- `public/topnav.js`：总览/规则/文档/登出，当前页 `aria-current="page"`。
- `public/components/toast.js`：`aria-live="polite"`，消息文本通过 `textContent` 注入。
- `public/components/modal.js`：ESC、遮罩关闭、焦点陷阱、关闭后焦点归还。
- `public/components/recipient-picker.js`：成员搜索、多选、全选和 orphan；应用页用 member-only 模式，规则页保留部门/标签输入。
- `public/http.js`：同源 cookie 请求、`If-Match`、稳定错误码解析、401 跳登录、重复提交保护。

不使用 GSAP 实现必要交互；简单过渡由 CSS 完成，并尊重 `prefers-reduced-motion`。继续沿用已固定版本的 DaisyUI/Lucide，不新增外部依赖。

---

## 8. 跨层一致性追踪矩阵

实施和评审时按下表逐行核对，任何一行缺少后端约束、前端反馈或测试，都不能视为业务完成。

| 业务结果 | 后端不变量/事务 | API 契约 | 前端行为 | 必测场景 |
|---|---|---|---|---|
| 同企业多应用不串行 | 已完成身份按 `(corpid,agentid)` 判重；草稿只匹配未完成行 | 冲突返回 `APP_DRAFT_EXISTS` / `APP_IDENTITY_CONFLICT` 和 `details.existing_code` | 提供继续草稿或打开现有应用，不重复创建 | 同 corpid 的 A/B AgentID 得到不同 code，A 数据不变 |
| 草稿不会被当成可发送应用 | `completed=false` 是独立生命周期 | 发送/切换/规则管理返回 `APP_NOT_COMPLETED` | 只展示继续配置、删除 | 草稿发送 409，回调验证仍可工作 |
| 紧急暂停全部发送 | `app_enabled` 高于 direct/rule 开关，路由和 service 双检 | 两种发送入口均 `403 APP_DISABLED` | toggle 提交期间锁定；paused 仍显示子开关原值 | 直接 Code、启用规则、禁用规则组合全部覆盖 |
| 暂停后可维护并恢复 | 总开关不限制管理 API，不改写子开关 | 详情/编辑/规则/安全设置在 paused 下正常 | 显示暂停横幅，表单仍可用 | paused 状态修改凭证、规则后再启用 |
| 局部编辑不覆盖他人更新 | touched-field SQL + version 乐观锁 | `If-Match`；冲突 `APP_VERSION_CONFLICT` | 保留输入，加载最新值后重新确认 | 两页面分别改描述/接收人及同字段冲突 |
| 历史重复项可治理 | 不自动合并；身份未变时允许维护 | `warnings=[duplicate_identity]`，能力不被关闭 | 告警独立于主状态，可暂停/编辑/删除 | 重复项可暂停和改描述，新建同身份被拒绝 |
| 删除无半成品 | 规则写入递增应用版本；规则和应用在同一互斥事务内删除 | 预览版本通过 `If-Match`；成功返回计数；失败时读取仍完整 | 规则变化导致版本冲突时重新展示最新影响 | 预览后新增规则、第二条 SQL 故障回滚、删除后缓存失效 |
| 敏感值不泄露 | 密文存储；摘要只返回 configured 标志 | 详情不返回 secret/AES/token 明文 | 密码框不回填，sessionStorage 白名单 | 响应、DOM、存储、日志均无敏感值 |
| 页面状态一致 | 统一 serializer 产出 lifecycle/capabilities/warnings | 列表、详情、规则摘要字段语义一致 | 不自行推导状态，不匹配中文错误 | 三个读取接口对同一应用返回相同主状态 |

---

## 9. 分阶段实施

### 阶段 0：冻结契约与补失败测试

**目标**：先用测试复现多应用阻塞问题，再改实现。

- 新增同一 corpid 下两个不同 AgentID 的创建场景。
- 证明现状会错误复用已完成回调配置。
- 新增完成接口覆盖已完成配置的保护测试。
- 新增应用总开关两类入口测试。
- 新增删除事务回滚测试骨架。
- 冻结 `lifecycle_status/capabilities/warnings` 和稳定错误码响应快照。
- 增加并发编辑丢失更新的失败测试。
- 记录当前 100 项基线持续通过。

### 阶段 1：数据迁移、草稿修复与 WeChatService 收口

**文件**：`src/core/database.js`、`src/services/notifier.js`、`src/api/routes.js`

- 迁移 `app_enabled/version`。
- 增加真正的草稿查询和身份重复查询。
- `completeConfiguration()` 仅允许完成草稿。
- `/api/validate` 改用 notifier 共享服务。
- 创建/完成/实际改变 AgentID 时执行 `(corpid,agentid)` 业务判重。
- 建立统一配置摘要序列化和结构化业务错误。
- 更新 DAO 改为 touched-field SQL，并接入版本乐观锁。

### 阶段 2：总开关、事务删除和缓存收口

**文件**：`src/core/database.js`、`src/services/notifier.js`、`src/api/routes.js`

- 实现不会发生语句混入的事务封装。
- 实现级联删除 DAO、service 和 DELETE 路由。
- 实现 `setAppEnabled` 与 PUT 路由。
- 重排 `resolveNotifyAuth`，并补 service 层防绕过校验。
- 更新/删除成功后清运行时缓存；凭证变更/删除时失效旧 token。
- 所有布尔输入严格解析。
- 既有管理写接口接入 `If-Match`；草稿写接口校验 body 中的版本；非删除写入均返回最新版本。
- 规则写接口递增并返回所属应用版本，删除预览使用同一版本。
- 写操作提交后输出不含敏感值的结构化管理日志。

### 阶段 3：前端基础组件和页面守卫

**文件**：`public/styles.css`、`public/http.js`、`public/topnav.js`、`public/components/*`、`src/api/routes.js`

- 建立设计变量和公共交互组件。
- 统一页面导航、登出、Toast、Modal、版本头和错误码解析。
- 页面路由统一会话守卫。
- 保持 CSP 允许源不扩大；动态内容禁止不可信 `innerHTML`。

### 阶段 4：应用总览

**文件**：`public/index.html`、`public/script.js`

- 按 corpid 分组渲染。
- 只按服务端 lifecycle/capabilities 接入状态、总开关、规则/安全/编辑入口。
- 区分主状态、重复身份告警和直接/规则发送子状态。
- 接入删除影响预览和事务删除。
- 完成 loading/empty/error/mobile 状态。

### 阶段 5：新建向导

**新文件**：`public/wizard.html`、`public/wizard.js`

- 四步进度、回退、草稿恢复和敏感数据不落存储。
- 复用修正后的 generate/validate/complete API。
- 用稳定错误码处理草稿冲突、重复完成和身份冲突。
- 草稿回调更新与完成携带当前版本。
- 成功页先展示并允许复制地址，再返回总览。

### 阶段 6：编辑、安全设置与规则页整合

**新文件**：`public/edit.html`、`public/edit.js`  
**修改**：`public/rules.html`、`public/rules.js`

- 完整编辑表单和局部 payload。
- 接入版本冲突保留输入与刷新确认流程。
- 把配置级安全设置从规则工作区迁到编辑页安全分区。
- 规则页支持 `?code=` 自动选中，并显示所属企业/应用和暂停状态。
- 规则页保存应用聚合版本，每次规则写入后采用服务端返回的新版本。
- 将规则删除、API 重生成、密钥轮换/撤销的 `confirm` 迁移到公共 Modal。
- 接入公共成员选择器，保证现有规则部门/标签语义不变。

### 阶段 7：文档、视觉收口和 QA

**文件**：`public/api-docs.html`、`README.md`、测试文件、部署/QA 文档

- 文档新增应用总开关、删除接口和三层开关优先级。
- 更新创建流程、错误码和回滚注意事项。
- 自动化测试、键盘流程、对比度和响应式检查。
- 删除已不再使用的旧页面片段和重复函数，但不做无关重构。

---

## 10. 测试计划

### 10.1 后端自动化

建议新增 `test/backend-multi-app.test.js` 和 `test/backend-delete-configuration.test.js`：

1. 迁移：旧行 `app_enabled/version` 正确补值，重复启动幂等。
2. 序列化：列表、详情、规则摘要的 lifecycle/capabilities/warnings/version 一致，不泄露密文或回调 Token 明文。
3. 多应用：同一 corpid 下 AgentID A/B 获得不同 code，A 不被 B 覆盖。
4. 草稿：已完成应用不被当成草稿；已有草稿返回 `APP_DRAFT_EXISTS`；已完成 code 返回 `APP_ALREADY_COMPLETED`。
5. 身份判重：新建、完成和实际修改 AgentID 阻止重复身份；历史重复项不改 AgentID 时仍可维护。
6. 更新：corpid 变更被拒绝；敏感字段缺省保留；凭证变化才触发在线验证。
7. 并发：缺版本 428；旧版本 409；局部字段更新不覆盖未触及字段；应用和规则写入均返回新聚合版本。
8. token：验证和发送共享服务实例；改 secret 后旧缓存键被清理，AgentID 单独变化不清 token。
9. 总开关：配置 Code 和规则 API 均返回 `403 APP_DISABLED`；重新启用恢复子开关原状态。
10. paused 管理：详情、成员、编辑、规则与安全设置 API 保持可用。
11. 防绕过：直接调用 notifier 发送时也受 `app_enabled` 和草稿状态限制。
12. 删除：配置和 N 条规则一起删除，返回计数准确，后续 code/rule code 均 404。
13. 回滚：预览后新增规则使删除版本冲突；第二步删除故障时配置和规则都保留；并发语句不混入事务。
14. 严格输入：`"false"`、`2`、`null` 等非法总开关值按契约处理。
15. 错误契约：所有关键失败同时断言 HTTP、稳定 code 和允许的 details。
16. 回归：通知密钥、HMAC、限流、回调、规则启停、配置 Code 开关行为不变。

### 10.2 前端自动化/行为测试

1. corpid 分组和脱敏显示正确，动态内容经过转义。
2. 待完善/运行中/已暂停主状态和重复身份告警不混用，也不只依赖颜色。
3. toggle 成功、失败回滚和重复点击锁定。
4. 删除模态框规则清单、ESC、焦点归还、失败保留状态。
5. 向导前进、回退、刷新恢复；sessionStorage 不出现 corpsecret/callback token/aeskey。
6. 编辑 payload 只发送改动字段，空 secret 不进入请求体，所有配置写请求携带当前版本。
7. `/rules?code=` 自动选择应用，暂停状态可见。
8. paused 状态仍能进入编辑、规则和安全设置，草稿只出现服务端允许的操作。
9. 规则写入携带当前应用版本，并用响应的新 app_version 更新后续请求。
10. 版本冲突保留非敏感输入并提供刷新确认；稳定错误码触发正确恢复动作。
11. 所有管理请求只使用同源 cookie，不在 URL/localStorage 保存登录凭证。

### 10.3 手工场景矩阵

至少准备：2 个 corpid，每个 2 个 AgentID，每个应用 0/2 条规则。

- 完成增、改、停、启、删全流程。
- 暂停时配置 Code 和规则 API 都为 403；恢复后按各自子开关状态工作。
- 删除时另一个应用完全不受影响。
- CorpSecret 改为有效值后立即发送成功；无效值不写库。
- 两个浏览器页面同时编辑，后提交的过期版本不会静默覆盖先提交结果。
- paused 应用可修改凭证和规则，恢复后使用新配置发送。
- 通讯录无权限时，现有 orphan/fallback 行为不退化。
- 375/768/1024/1440 视口；键盘完成新建、编辑、删除。
- Windows PowerShell 中文请求、回调、通知密钥相关现有回归全部通过。

### 10.4 质量门槛

- `npm.cmd test` 全部通过，现有 100 项不得回归；新增测试数量不设固定值。
- 新功能关键分支均有自动化覆盖。
- 浏览器控制台无未处理异常、CSP 违规和敏感数据日志。
- 无 P0/P1 可访问性或数据一致性问题。

---

## 11. 验收标准

1. 同一 corpid 可连续创建至少两个不同 AgentID，分别获得独立 code，旧应用字段和规则不变化。
2. 总览按 corpid 分组，明确展示 AgentID、描述、默认接收人数、规则数和文字状态。
3. 草稿可继续配置或删除；已完成应用不会被新建流程复用或覆盖。
4. 编辑页除 corpid 外可修改计划内字段；敏感字段留空不变；无效凭证不落库。
5. 暂停应用发送后，其配置 Code 与全部规则 API 均返回 403；恢复后子开关原值不变。
6. 暂停仅影响发送；管理员仍可编辑应用、规则和安全设置，并在修复后恢复。
7. 并发编辑发生冲突时返回 409，任何页面都不会静默覆盖其他页面已提交的配置。
8. 删除确认能展示影响；确认前规则发生变化时要求重新预览；成功后配置与规则一起消失，注入故障时全部回滚。
9. 删除后配置 Code、规则 API Code 的后续请求返回 404；回调请求验证失败；三者均不再命中旧配置缓存。
10. 列表、详情和规则页对同一应用返回相同主状态、能力与告警；前端不自行推导另一套状态。
11. 原有通知密钥、HMAC、Code 开关、规则开关、回调、限流和成员 fallback 行为全部回归通过。
12. 页面可用键盘操作，焦点清晰，375px 可用，reduced-motion 生效，状态不只靠颜色。
13. API 文档与实际请求/响应一致，错误使用 HTTP + `{error, code, details?}`，前端不匹配中文文案。

---

## 12. 风险、发布与回滚

| 风险 | 控制措施 |
|---|---|
| 新建流程覆盖同企业旧应用 | 先修草稿查询；complete 仅接受草稿；增加同 corpid 多 AgentID 回归 |
| 历史重复应用导致身份不唯一 | 不建强制唯一索引、不自动合并；总览标记；新写入业务判重 |
| 删除半成功 | 共享连接互斥事务、故障注入回滚测试、发布前备份 SQLite 文件 |
| 暂停判断被缓存绕过 | 切换后清 target 缓存；路由和 service 双层校验 |
| 前端、详情和规则页各自推导出不同状态 | 后端统一 serializer 输出 lifecycle/capabilities/warnings，前端只渲染 |
| 多页面编辑发生静默覆盖 | touched-field SQL + version/If-Match；冲突保留输入并要求确认 |
| 前端依赖中文错误文案 | 稳定业务错误码；测试断言 HTTP + code + details |
| 两个 WeChatService 缓存不一致 | `/api/validate` 收口到 notifier 单实例 |
| 敏感值进入浏览器存储/DOM | sessionStorage 白名单；密码框不回填；动态文本使用 textContent |
| 旧调用方依赖详情中的 callback_token 明文 | API 文档标为安全性兼容变更；发布前确认无外部管理脚本依赖 |
| 公共选择器重构破坏规则页 | member-only/rule 两种模式；保留部门/标签回归用例 |
| 新后端与旧前端短时混用 | API 与静态页面作为同一发布物原子部署；不得先强制 If-Match 再单独晚发前端 |
| 回滚到旧版本后忽略 app_enabled | 回滚前停止流量并评估：旧版本会把“已暂停应用”重新视为可发送 |
| 删除不可逆 | 发布前备份；UI 展示规则影响；不提供静默批量删除 |

发布顺序：

1. 备份数据库并验证可恢复。
2. 构建包含后端 API 与新静态页面的同一发布物，禁止拆分版本。
3. 在预发布环境执行迁移、自动化、API 契约和页面 smoke test。
4. 用两个企业、四个应用完成手工矩阵和并发编辑测试。
5. 确认 API 文档/发布说明已更新后切换生产流量。

回滚说明：`app_enabled/version` 都是加法列，旧代码可以忽略并运行；但旧代码不会执行应用总开关，也不会执行版本并发控制，因此回滚不是行为等价。若必须回滚，应先停止外部通知流量，或把需暂停应用的配置 Code 和规则开关逐一关闭。已经删除的数据只能从发布前备份恢复。

---

## 13. 文件改动清单

| 类型 | 文件 | 主要改动 |
|---|---|---|
| 修改 | `src/core/database.js` | app_enabled/version 迁移、局部更新、管理列表、草稿/重复查询、事务级联删除 |
| 修改 | `src/services/notifier.js` | 共享凭证验证、生命周期序列化、草稿保护、判重、版本、总开关、删除 |
| 修改 | `src/api/routes.js` | 页面守卫、开关优先级、If-Match、新 DELETE/PUT 路由、稳定错误码 |
| 修改 | `public/index.html` / `public/script.js` | 重构为应用总览 |
| 新增 | `public/wizard.html` / `public/wizard.js` | 四步新建向导 |
| 新增 | `public/edit.html` / `public/edit.js` | 应用编辑和安全设置 |
| 新增 | `public/styles.css` | 设计变量、共享布局、状态和可访问性样式 |
| 新增 | `public/http.js` / `public/topnav.js` | 请求/版本/错误码封装和统一导航 |
| 新增 | `public/components/modal.js` | 可访问确认对话框 |
| 新增 | `public/components/toast.js` | 统一 Toast |
| 新增 | `public/components/recipient-picker.js` | 成员/规则两种模式的接收范围组件 |
| 修改 | `public/rules.html` / `public/rules.js` | code 深链、应用状态、安全设置迁出、公共组件接入 |
| 修改 | `public/api-docs.html` | 新接口、三层开关、创建和错误契约 |
| 修改 | `README.md` | 管理入口和多应用说明 |
| 新增/修改 | `test/*.test.js` | 后端事务/多应用/开关与前端行为回归 |

---

## 14. 建议提交顺序

1. `test(multi-app): freeze lifecycle error and concurrency contracts`
2. `feat(config): add aggregate version and lifecycle serializer`
3. `fix(config): isolate incomplete drafts per enterprise`
4. `refactor(wechat): share credential validation service`
5. `feat(app): add app enabled state and enforcement`
6. `feat(config): add transactional cascade deletion`
7. `refactor(api): add stable management errors and preconditions`
8. `refactor(ui): add shared management components`
9. `feat(ui): add application overview`
10. `feat(ui): add application wizard and editor`
11. `refactor(rules): integrate app context version and dialogs`
12. `docs: document multi-app management APIs and rollback`

每个提交必须在当前分支执行 `npm.cmd test`；涉及页面的提交同时完成对应手工 smoke test。不要把数据库事务、发送鉴权重排和大规模 UI 重构塞入同一个提交。

---

## 附录 A：关键代码索引（基线 `562e047`）

| 关注点 | 位置 |
|---|---|
| 配置表与当前唯一约束 | `src/core/database.js:40-55` |
| 规则表（无外键） | `src/core/database.js:58-72` |
| 现有列迁移模式 | `src/core/database.js:83-105` |
| 配置列表 SQL | `src/core/database.js:172-179` |
| 回调草稿误查询 | `src/core/database.js:230-233` |
| 完成配置 | `src/services/notifier.js:485-525` |
| 配置列表序列化 | `src/services/notifier.js:641-661` |
| 目标解析缓存 | `src/services/notifier.js:745-780` |
| 成员列表与 fallback | `src/services/notifier.js:958-1011` |
| 配置详情序列化 | `src/services/notifier.js:1013-1047` |
| 业务层局部 payload、DAO 全字段更新 | `src/core/database.js:181-198`、`src/services/notifier.js:1055-1158` |
| 配置 Code 开关范式 | `src/services/notifier.js:1345-1355` |
| token 缓存与失效 | `src/core/wechat.js:108-150` |
| 路由层第二个 WeChatService | `src/api/routes.js:15` |
| 通知鉴权与开关顺序 | `src/api/routes.js:220-286` |
| 配置/规则管理路由 | `src/api/routes.js:288-436` |
| 当前运行时全量缓存失效 | `src/services/notifier.js:210-215` |
| 当前首页两步创建 | `public/index.html`、`public/script.js:76-252` |
| 当前规则页安全设置 | `public/rules.html:56-113`、`public/rules.js:211-346` |

## 附录 B：方案选择说明

企业微信 access token 由 `corpid + corpsecret` 对应的应用凭证获取。无论管理系统如何组织 Code，不同应用的 token 获取成本都不能合并。当前 `WeChatService` 已按 `corpid + secret 哈希` 缓存 token，因此“每应用一个配置 Code”不会额外增加同一应用内部的 token 请求；把多个应用塞进同一 Code 反而会迫使每条规则再选择应用，并放大数据模型和权限错误的复杂度。

因此本计划维持“一应用一 Code、规则挂在应用下”的结构，把工作重点放在草稿隔离、应用身份、总开关、删除事务和管理体验上。
