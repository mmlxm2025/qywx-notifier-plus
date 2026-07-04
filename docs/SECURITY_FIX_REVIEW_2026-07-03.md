# 安全整改复核与下一步技术建议

- 项目：`qywx-notifier-plus`
- 复核日期：2026-07-03
- 复核对象：当前工作区未提交的安全整改代码
- 基线报告：`docs/SECURITY_AUDIT_REPORT_2026-07-03.md`
- 结论：**有条件不通过；暂不建议作为生产安全版本发布**

## 1. 执行摘要

本轮整改不是表面修补：URL Token、默认弱密钥、依赖漏洞、AES-CBC、数据库启动就绪、HTTP 超时、安全响应头、容器非 root 等问题都已有实质性改善。自动化测试从原先的 37 项增加到 75 项，且全部通过；生产依赖审计已由 21 个问题降为 0。

但复核额外发现并验证了 3 个发布阻断问题：

1. 合法的企业微信 POST 回调会被自身的二次重放检查拒绝。
2. 规则生成的通知 API Code 无法通过新的通知鉴权，固定返回 404。
3. 未生成 `notify_key` 的配置仍默认允许仅凭 URL Code 发消息，原 SEC-003 实际没有闭环。

另有 HMAC 原始请求体、限流绕过与内存增长、失败额度回滚、配置原子校验等 P1 问题。建议先完成本文第 5 节“发布阻断整改”，再进入生产部署。

## 2. 验证结果

| 验证项 | 结果 |
|---|---|
| Node.js 测试 | 75/75 通过，0 失败 |
| JavaScript 语法检查 | 全部通过 |
| `npm audit --omit=dev` | 0 个已知生产依赖漏洞 |
| 根目录 Docker Compose 解析 | 通过 |
| `deploy/docker-compose.yml` 解析 | 通过 |
| Git 空白检查 | 仅 `test/frontend-rules-page.test.js` 存在文件末尾多余空行 |
| URL/query Token 搜索 | 后端不再接受 query token；前端只负责清除历史 URL/localStorage token |
| 定向回调探针 | 返回 `检测到回调重放`，确认 REV-001 |
| 定向规则 API 探针 | 返回 404，确认 REV-002 |
| 定向失败回滚探针 | 第一次网络失败，第二次错误变为 429，确认 REV-006 |
| 定向 HMAC 探针 | 同一 JSON 仅因空白不同即签名失败，确认 REV-005 |
| 定向限流探针 | 修改 `X-Forwarded-For` 后连续请求均通过，确认 REV-004 |

说明：全量测试通过与上述问题并不矛盾；现有测试主要覆盖模块函数和管理路由，尚未覆盖规则通知鉴权、真实回调成功链路及失败后的额度恢复。

## 3. 原报告整改状态

| 原编号 | 状态 | 复核结论 |
|---|---|---|
| SEC-001 启动弱配置 | 基本完成 | 缺失或占位密钥/密码会阻止启动；密钥生成文档仍写错命令，见 REV-011 |
| SEC-002 URL Token | 核心完成 | 已切换 HttpOnly Cookie，query token 已移除；代理信任和会话持久化仍需加强 |
| SEC-003 通知能力密钥 | 未完成 | 已增加 `notify_key` 数据结构，但默认仍可无密钥调用，且规则 API 被破坏 |
| SEC-004 依赖漏洞 | 完成 | 生产依赖审计为 0；已移除未使用的 `xmldom`、`uuid` |
| SEC-005 数据加密 | 部分完成 | 新数据使用 AES-256-GCM；历史明文回调 Token 未自动迁移 |
| SEC-006 登录与会话 | 部分完成 | 已有限流、吊销和清理；仍是单进程内存会话，且限流 IP 可伪造 |
| SEC-007 启动/就绪 | 完成 | 数据库初始化完成后才监听，并提供 live/ready 探针 |
| SEC-008 企业微信 HTTP | 部分完成 | 已有限时、体积和重定向限制；Token 失效重试函数未接入调用链 |
| SEC-009 配置一致性 | 部分完成 | 类型和完成态判断改善；已启用回调仍可被半更新破坏，凭证组合未重新验证 |
| SEC-010 失败计数 | 未完成 | 日额度会回滚，但成员分钟/小时额度因时间戳不一致实际无法回滚 |
| SEC-011 前端/CSP | 部分完成 | 已增加 CSP 和固定 CDN 版本；仍依赖第三方运行时脚本且无 SRI |
| SEC-012 敏感日志 | 完成 | 回调日志已缩减为事件类型、Code 和 MsgId |
| SEC-013 XML/回调 | 未完成 | 大小和时间窗口已增加，但重放实现导致合法 POST 回调固定失败 |
| SEC-014 DOM 无效赋值 | 完成 | `configForm.corpid = { value: corpid }` 已移除 |

## 4. 新发现及残留问题

### REV-001（P0）合法 POST 回调固定被判为重放

证据：

- `src/services/notifier.js:1181` 首次调用 `assertCallbackFreshness(timestamp, nonce, null)`，立即记录 nonce。
- 解密成功后，`src/services/notifier.js:1207` 再次传入同一个 nonce。
- `src/services/notifier.js:1117` 使用 `nonce || msgId`，因此第二次永远优先检查已记录的 nonce，合法请求被判为重放。
- 首次记录发生在签名/解密验证前，伪造请求也能污染 nonce 缓存。

影响：企业微信正常消息回调无法成功；攻击者还可利用伪造 nonce 占用内存或干扰后续请求。

整改要求：

1. 将“时间戳只读校验”和“重放键写入”拆成两个函数。
2. 先完成企业微信签名验证和解密，再原子写入重放键。
3. 重放键必须带配置作用域，例如 `callback:${code}:nonce:${nonce}` 和 `callback:${code}:msgid:${msgId}`。
4. 第二层只能检查 MsgId，不得再次使用同一 nonce。
5. 对已成功处理的企业微信重试建议幂等返回 `200 ok`，避免企业微信持续重试。
6. 缓存必须有硬容量上限；超过上限时执行 LRU/TTL 淘汰，而不是只删除已过期项。

### REV-002（P0）规则通知 API 在新鉴权下固定 404

证据：

- `src/api/routes.js:220` 只调用 `getConfigurationByCode(code)`。
- 规则 API 使用的是 `notification_rules.api_code`，不是配置 Code。
- 定向探针以有效规则 Code 请求，返回 `404 {"error":"无效的code，未找到配置"}`。
- 即使简单把规则 Code 映射为配置 Code，`src/api/routes.js:203` 再用配置 Code 调用 `sendNotification` 也会丢失规则的接收人范围。

整改要求：

1. 建立唯一的 `resolveNotificationPrincipal(code)`：同时解析基础配置 Code 和规则 API Code。
2. 返回值至少包含 `{ requestedCode, config, rule }`。
3. 鉴权使用所属配置的 `notify_key_hash`；实际发送仍传入原始 `requestedCode`，保留规则接收范围。
4. 增加“规则 Code + 正确 Key 成功、错误 Key 401、基础配置 Code 不回归”的路由集成测试。

### REV-003（P0）通知接口默认仍可无密钥调用

证据：

- `src/api/routes.js:248-259` 中，无论 `NOTIFY_LEGACY_CODE_GRACE_MS` 大于 0 还是等于 0，只要配置存在都会放行。
- 该变量名为时长，但代码既不记录迁移开始时间，也不计算到期时间；设置正数等同于永久放行。
- `createConfiguration()`、`completeConfiguration()` 不自动生成通知密钥。
- 管理前端及多数 API 示例仍只展示 URL，不展示 `X-Notify-Key`。

影响：原 SEC-003“Code 泄漏即可发消息”的安全问题仍然存在。

整改要求：

1. 新配置创建时在同一事务中生成 `notify_key`，数据库只保存哈希，明文只返回一次。
2. 默认拒绝无 Key 请求；不存在模糊的“0 仍兼容”分支。
3. 历史兼容应使用持久化的 `legacy_until` 明确截止时间，而不是进程环境变量无限延长。
4. 管理界面增加生成、轮换、撤销和一次性复制入口，并同步更新所有 curl/代码示例。
5. 明确规则 Key 策略：建议规则继承所属配置 Key；如业务需要独立撤销，再增加每规则 Key。

### REV-004（P1）限流可通过伪造代理头绕过，并存在内存增长面

证据：

- `server.js:28-29` 默认信任一层代理，即使服务可能直接暴露。
- `src/api/routes.js:29-33` 直接读取客户端提供的 `X-Forwarded-For` 首段，绕过 Express 的可信代理判断。
- 修改 `X-Forwarded-For` 后，超过单 IP 限额的请求仍可继续成功。
- server 只清理登录限流器；通知与回调限流器没有周期清理不再活跃的 Key。
- `RateLimiter` 会把已超限请求继续写入数组；回调 nonce 缓存超过 10000 后只清理过期项，没有硬上限。

整改要求：统一使用 `req.ip`；默认 `trust proxy=false`，仅部署时显式配置可信代理网段/跳数；对 Map 和单桶数组设置硬上限；单实例可使用成熟限流库，多实例改用 Redis。通知限流建议按 `notify key/config + IP`，回调限流按 `callback code + IP`。

### REV-005（P1）HMAC 校验的请求体不是客户端签名的原始字节

证据：

- `server.js:36` 先解析 JSON。
- `server.js:49-57` 再用 `JSON.stringify(req.body)` 重建所谓 raw body。
- 合法客户端对 `{ "content": "hi" }\n` 签名，服务端重建为 `{"content":"hi"}` 后校验失败。
- `src/core/notify-auth.js:78` 在签名正确性验证前写入 nonce。

整改要求：用 `express.json({ verify(req, res, buffer) { ... } })` 捕获原始 Buffer；计算签名后再记录 nonce；nonce 按通知 Key/配置作用域隔离并设置硬容量。增加空白、Unicode、属性顺序、错误签名不占 nonce 等测试。

### REV-006（P1）发送失败后成员频率额度没有真正回滚

证据：

- `src/services/notifier.js:353-358` 预占时写入一个 `now`。
- `src/services/notifier.js:870-884` 回滚时重新调用 `Date.now()`，再用 `lastIndexOf(now)` 删除；毫秒值通常不同，无法找到原记录。
- 定向探针中第一次发送发生网络失败，第二次立即被 429 拒绝。

整改要求：预占函数返回包含精确条目 ID/时间戳的 reservation receipt；成功时提交，失败时按 receipt 回滚。并发场景必须保证同一预占只提交或回滚一次。

### REV-007（P1）配置更新仍可形成不一致状态

证据：

- `src/services/notifier.js:1057-1066` 只在回调从关闭变为开启时检查 Token/AESKey。
- 回调已开启时，单独把 `callback_token` 或 `encoding_aes_key` 清空会留下“开启但不完整”的状态。
- `src/services/notifier.js:1068-1084` 更改 CorpID、CorpSecret 或 AgentID 时只做本地格式/重复检查，没有执行注释所称的企业微信组合验证。

整改要求：先合并得到完整 candidate configuration，再对最终状态执行统一不变量校验；回调开启时最终 Token/AESKey 必须始终成组存在；CorpID/CorpSecret/AgentID 任一变化时用候选组合验证 Token 和应用可见性；全部通过后用一次数据库事务提交。

### REV-008（P2）数据库迁移失败可能被静默忽略

- `src/core/database.js:90-99` 对非“列已存在”的 `ALTER TABLE` 错误也不抛出，ready 可能在结构未完成时仍成功。
- 当前迁移没有 schema version、事务和回滚策略。
- 历史 `callback_token` 明文字段没有批量迁移到 `encrypted_callback_token`，读取路径会长期回退到明文。

建议引入 `schema_migrations` 表和有序事务迁移；未知迁移错误必须阻断启动；迁移历史明文后置空原列，并提供迁移前备份、迁移后校验和回滚说明。

### REV-009（P2）企业微信 Token 失效重试代码未接入

`src/core/wechat.js:143` 定义了 `withTokenRetry()`，但项目没有调用它；实际路径仍直接 `getToken()`。建议对读取类调用接入“一次清缓存重试”；发送类仅在企业微信明确返回 Token 无效且可确认消息未受理时重试，网络超时不得盲目重发，以免重复通知。

### REV-010（P2）会话仍受单进程和代理部署约束

当前 URL Token 泄漏已解决，但会话仍保存在进程内 Map，重启全部失效，多实例互不识别。下一阶段建议使用 Redis/数据库会话、限制每管理员会话数、记录登录/吊销审计，并给状态修改接口增加 Origin 校验。生产环境应强制 HTTPS；Bearer 兼容入口应设置明确移除版本和日期。

### REV-011（P2）密钥生成说明错误且缺少轮换机制

`env.template`、`src/core/config.js`、`deploy/import-load.sh` 把“64 位 hex”对应命令写为 `openssl rand -hex 16`；该命令只产生 32 位 hex（16 字节随机量）。应改为 `openssl rand -hex 32`。同时需要设计带版本的密钥环和轮换流程，否则直接更改 `ENCRYPTION_KEY` 会导致历史数据无法解密。

### REV-012（P2）前端供应链与运行维护仍可收口

CSP 已生效，但 Tailwind、DaisyUI、Lucide、GSAP 仍从第三方 CDN 运行时加载且没有 SRI。建议构建时固定依赖并随镜像自托管，CSP 收紧为 `script-src 'self'`。同时增加 SIGTERM 优雅停止、SQLite WAL/busy timeout/foreign_keys、结构化审计日志、错误率与 401/429/企业微信错误码指标。

## 5. 下一步执行顺序

### 阶段 A：发布阻断整改

1. 先为 REV-001、REV-002、REV-003 写失败的路由/端到端测试。
2. 重构通知目标解析，保证基础配置与规则共用正确的 Key，但发送仍保留原规则 Code。
3. 新配置默认生成 Key，旧配置默认拒绝无 Key；补齐管理界面和文档。
4. 重写回调重放流程为“验签/解密成功后再登记”，修复 nonce/MsgId 双检查。

### 阶段 B：同一发布内完成的 P1

1. 捕获真实 raw body，修复 HMAC 与 nonce 写入顺序。
2. 修正可信代理和限流存储，加入容量上限与清理。
3. 用 reservation receipt 修复失败额度回滚。
4. 将配置更新改为候选状态统一校验和事务提交。

### 阶段 C：下一版本工程化

1. 建立版本化数据库迁移和旧明文数据迁移。
2. 接入企业微信 Token 失效的安全重试策略。
3. 建立可轮换的加密密钥环与会话共享存储。
4. 自托管前端资源，补齐优雅停止、指标、审计和备份恢复演练。

## 6. 必补验收测试

- 一条使用真实 `wxcrypt` 生成的合法 POST 回调返回 `200 ok`。
- 错误签名不得占用 nonce；同一已成功 MsgId 的重试幂等返回成功。
- 规则 API Code + 所属配置正确 Key 能按规则接收范围发送。
- 规则 API 错 Key、无 Key均返回 401；基础配置 API 行为一致。
- 未迁移旧配置在截止时间后无 Key 必须返回 401。
- HMAC 对带空白、换行、Unicode 的原始 JSON 均可按原始字节验证。
- 伪造 `X-Forwarded-For` 不能绕过限流；限流 Map 和 nonce Map 不超过硬上限。
- 企业微信调用失败后，下一次请求不会因幽灵额度错误返回 429。
- 已启用回调时不能单独清空 Token/AESKey；无效 CorpID/Secret/AgentID 组合不能提交。
- 旧数据库升级成功后明文回调 Token 被清空；模拟迁移失败时 ready 返回失败且进程不监听。
- 生产 HTTP 登录被拒绝或重定向 HTTPS，Cookie 始终具备预期的 Secure/SameSite/HttpOnly 属性。

## 7. 完成定义

满足以下条件后，才建议将结论改为“可发布”：

1. REV-001 至 REV-007 全部关闭。
2. 本文第 6 节测试全部自动化并通过。
3. `npm audit --omit=dev` 保持 0 个高危/严重问题。
4. 新旧数据库迁移均经过备份恢复演练。
5. API 文档、管理界面和实际鉴权行为完全一致。
6. 生产环境完成 HTTPS、可信代理、随机密钥、强管理员密码和日志脱敏核验。

