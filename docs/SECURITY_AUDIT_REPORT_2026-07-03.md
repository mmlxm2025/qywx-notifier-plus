# qywx-notifier-plus 安全漏洞分析与技术整改报告

> 审查日期：2026-07-03  
> 审查范围：服务端、前端、数据库、企业微信交互、Docker 部署、依赖和现有测试  
> 文档用途：供下一轮 AI 或开发人员按优先级直接实施整改  
> 当前状态：仅完成审查，尚未修改业务代码

## 1. 执行摘要

项目现有功能测试正常，但当前版本不适合未经加固直接暴露到公网。优先风险集中在：

1. 默认加密密钥及部署占位密码不会阻止服务启动。
2. 管理员 Token 同时出现在 URL 和 `localStorage`，并暴露给第三方 CDN 脚本运行环境。
3. 企业微信回调地址与通知发送凭证复用同一个 `code`，通知接口没有独立鉴权。
4. 生产依赖审计存在 2 个严重、10 个高危风险包。
5. 敏感信息使用无完整性保护的 AES-CBC 加密，回调 Token 仍明文存储。
6. 登录、通知和回调入口缺乏完整的限流、超时及重放保护。

综合风险评级：**高**。

## 2. 已完成的验证

- `npm test`：37 项测试全部通过，0 失败。
- 所有 JavaScript 文件通过 `node --check`。
- 根目录及 `deploy/` 下的 Docker Compose 配置均可解析。
- `npm audit --omit=dev`：21 个生产依赖风险包，其中严重 2、高危 10、中危 7、低危 2。
- 未发现已提交到 Git 历史中的 `.env`、私钥、数据库或明显真实凭证。
- 数据库访问均使用参数绑定，未发现直接 SQL 注入点。
- 前端动态数据主要经过转义或使用 `textContent`，未发现明确的存储型 XSS。
- Docker 主镜像使用非 root 用户，`.dockerignore` 已排除数据库、环境文件和密钥文件。

### 2.1 外部机构意见复核结论

本报告已对另一机构提出的 10 项意见逐条复核，结论如下：

| 外部意见 | 复核结论 | 报告处理 |
|---|---|---|
| Token 泄漏到 URL | **成立** | 保持 P1，见 SEC-002 |
| 内存 Token、环境变量密码、缺少暴力破解保护 | **部分成立** | 内存会话属于脆弱设计而非直接漏洞；登录限流、审计和全局吊销能力确实缺失，见 SEC-006 |
| 管理接口接受 query token | **成立** | 与 URL Token 属于同一根因，合并到 SEC-002，避免重复计数 |
| `configForm.corpid = { value: corpid }` 是 DOM 赋值 bug | **部分成立** | 该语句不是标准字段赋值，但 `configForm` 内不存在 `corpid` 字段，且代码中没有后续读取；当前属于无效死代码，不构成功能故障，见 SEC-014 |
| Docker 最终镜像仍以 root 运行 | **不成立** | `Dockerfile:73` 已明确设置 `USER node`，无需重复修改 |
| XML 使用 xmldom，可能存在 XXE | **未确认，原判断不准确** | 回调实际使用 `wxcrypt` 自带的自定义解析器，`xmldom` 未参与调用；DOCTYPE、外部/未知实体会被拒绝。仍存在签名前解析、重放和资源边界加固需求，见 SEC-013 |
| 配置更新可能产生逻辑不一致 | **成立** | `touser` 显式空值已被拒绝，但回调三元组、CorpID/CorpSecret、AgentID 缺少跨字段一致性校验，见 SEC-009 |
| `completed` 判定过于粗糙 | **成立** | 查询未返回 `encrypted_corpsecret`，实际主要依赖 AgentID 和 touser，见 SEC-009 |
| 大量 `innerHTML` 形成潜在 XSS 面 | **部分成立** | `public/script.js` 当前动态字段基本已转义；`public/rules.js` 主要使用 DOM API 和 `textContent`。未发现现存可利用 XSS，但应减少 HTML 字符串拼接，见 SEC-011 |
| `/api/notify/:code` 无鉴权 | **成立** | `code` 是事实上的 API 密钥，并与回调 ID 复用；已列为 P1，见 SEC-003 |

## 3. 风险清单

### SEC-001：默认密钥和占位凭证可带病启动

- 严重级别：P1 高危
- 证据：
  - `src/services/notifier.js:13`：缺少环境变量时使用公开默认加密密钥。
  - `src/api/routes.js:14`：重复使用相同公开默认密钥。
  - `src/core/crypto.js:9`：密钥通过补零和截断强制变成 32 个字符。
  - `deploy/.env.example:20,25-26`：包含公开占位密钥、默认用户名和占位密码。
  - `deploy/import-load.sh:46-50`：发现占位值后只警告，仍会继续启动。
- 影响：使用模板值部署时，攻击者可直接登录管理后台；数据库中的 CorpSecret 和 EncodingAESKey 等同于使用公开密钥保护。
- 整改要求：
  1. 删除代码中的默认加密密钥。
  2. 启动时校验 `ENCRYPTION_KEY`、`ADMIN_PASSWORD`，为空、长度错误或命中已知占位值时立即退出。
  3. 加密密钥改为严格的 32 字节随机值，建议以 Base64 表示并解码校验。
  4. 部署脚本发现占位值必须返回非零状态，禁止继续启动。
  5. 删除 `src/api/routes.js` 中未使用的 `CryptoService` 实例，避免出现多套配置入口。
- 验收标准：
  - 未配置密钥或密码时进程无法监听端口。
  - 两个模板占位值均能被自动识别并拒绝。
  - 增加启动配置单元测试。

### SEC-002：管理员 Token 经 URL 和 localStorage 暴露

- 严重级别：P1 高危
- 证据：
  - `public/login.html:102-103,129-130`：Token 写入 `localStorage` 后再次拼接到 URL。
  - `public/script.js:4-9`、`public/rules.js:2-8`：从 URL 读取 Token 并持久化。
  - `server.js:35-37,66-68`、`src/api/routes.js:19-21`：服务端接受查询参数中的 Token。
- 影响：Token 可进入浏览器历史、代理访问日志、截图、复制链接和其他诊断系统；在同源请求、旧浏览器或被覆盖的 Referrer 策略下还可能通过 Referer 扩散。现代浏览器默认跨源策略通常只发送源站，但项目没有显式设置 `Referrer-Policy`，不能依赖默认行为。任何能执行页面脚本的第三方依赖均可读取 `localStorage` 中的 Token。
- 整改要求：
  1. 使用随机服务端会话配合 `HttpOnly`、`Secure`、`SameSite=Strict/Lax` Cookie。
  2. 完全移除查询参数 Token 和登录后的 `?token=` 跳转。
  3. 登录成功只跳转到 `/`，退出时清除服务端会话和 Cookie。
  4. 如果暂不改 Cookie，至少改用 `sessionStorage`，并立即通过 `history.replaceState` 清理 URL；该方案仅作临时缓解。
- 验收标准：
  - 浏览器地址栏、历史记录和访问日志中不再出现 Token。
  - JavaScript 无法读取会话凭证。
  - 认证、过期、退出、重复退出均有自动化测试。

### SEC-003：回调标识与通知发送凭证复用

- 严重级别：P1 高危
- 证据：
  - `src/api/routes.js:135-160`：`POST /api/notify/:code` 不要求管理员认证或独立签名。
  - `src/services/notifier.js:346-349`：同一 `code` 同时生成通知 URL 和回调 URL。
  - `src/services/notifier.js:424-429`：普通配置同样复用一个 `code`。
- 影响：回调 URL 必须提供给企业微信并可能出现在代理日志中；一旦该 URL 泄漏，泄漏者同时获得消息发送能力。主配置 `code` 当前无法轮换或撤销。
- 整改要求：
  1. 分离 `config_id`、`callback_id`、`notify_key` 三种标识。
  2. 通知接口使用独立 API Key，推荐放在请求头并在数据库中仅保存哈希。
  3. 更高安全场景使用 `timestamp + nonce + body hash` 的 HMAC 签名，并校验时间窗口及 nonce 重放。
  4. 所有通知凭证支持轮换、撤销、启停和最后使用时间审计。
  5. 为旧 URL 设计明确的迁移期，迁移结束后禁用旧 `code` 发送能力。
- 验收标准：
  - 仅知道回调 URL 无法调用通知接口。
  - 通知密钥可轮换，旧密钥立即失效。
  - 重放、过期时间戳、错误签名均返回 401/403。

### SEC-004：生产依赖存在已知漏洞

- 严重级别：P1 高危
- 当前审计结果：

| 直接依赖 | 当前版本 | 审计级别 | 建议 |
|---|---:|---|---|
| `form-data` | 4.0.3 | 严重 | 升级到当前已修复版本，至少覆盖 4.0.6 修复线 |
| `xmldom` | 0.6.0 | 严重 | 当前代码未使用，直接移除 |
| `axios` | 1.10.0 | 高危 | 升级到当前安全版本；审计显示修复线至少需要 1.16.0 |
| `express` | 4.21.2 | 高危 | 升级到当前修复版本，并同步更新 `body-parser`、`qs`、`path-to-regexp` |
| `sqlite3` | 5.1.7 | 高危 | 评估并升级 6.x；重点回归原生模块构建与数据库兼容性 |
| `uuid` | 9.0.1 | 中危 | 可改用 Node.js `crypto.randomUUID()`，移除该依赖 |

- 可达性说明：
  - Express/`qs` 位于全局 URL-encoded 请求解析链，存在未认证入口可达性。
  - Axios 位于企业微信运行时请求主链路，应优先升级。
  - `form-data` 当前上传方法没有公开路由，可达性较低，但仍不应保留漏洞版本。
  - sqlite3 的部分告警来自 `node-gyp`/`tar` 构建链，主要属于供应链和构建环境风险。
- 整改要求：
  1. 分批升级直接依赖并更新锁文件。
  2. 每批升级后运行完整测试、Docker 构建和一次真实/沙箱企业微信联调。
  3. CI 增加 `npm audit --omit=dev`、依赖更新机器人和镜像漏洞扫描。
  4. Dockerfile 中禁止 `npm ci` 失败后静默回退到 `npm install`。
- 验收标准：
  - 生产依赖严重和高危审计结果清零，或对无法修复项形成书面豁免及可达性证明。
  - 锁文件和容器镜像均来自可复现构建。

### SEC-005：敏感数据加密缺少认证与轮换能力

- 严重级别：P2 中高
- 证据：
  - `src/core/crypto.js:9-22`：使用 AES-256-CBC，仅保存 IV 和密文，没有认证标签。
  - `src/core/database.js:65`：`callback_token` 明文存储。
  - `src/services/notifier.js:754-757`：回调 Token 会返回给认证后的前端。
- 影响：数据库密文被篡改时无法可靠检测；密钥格式处理不严格；数据库泄漏将直接暴露回调签名 Token。
- 整改要求：
  1. 新数据改用 AES-256-GCM，保存版本、nonce、ciphertext、auth tag 和 key id。
  2. 加密 CorpSecret、EncodingAESKey 和 callback token。
  3. 设计向后兼容迁移：读取旧 CBC 密文后重新加密为 GCM。
  4. 迁移前必须备份数据库，迁移过程可重复执行并支持回滚。
- 验收标准：
  - 任意修改密文、nonce 或 tag 均导致统一的认证失败。
  - 旧数据库可自动或通过受控命令迁移。
  - 日志和 API 响应不出现明文密钥。

### SEC-006：认证和入口级限流不足

- 严重级别：P2 中高
- 证据：
  - `server.js:45-55`：登录失败没有次数、IP 或时间窗口限制。
  - `src/core/auth.js:8,23-25`：会话保存在单进程 `Map`，固定 24 小时过期。
  - `src/core/auth.js:31-49`：只有单 Token 退出，没有全局吊销、密码变更后失效、会话审计或定期清理机制。
  - 通知、回调路由没有统一入口限流。
- 影响：管理员密码可被持续尝试；泄漏通知凭证后可进行高频消息轰炸和额度消耗。服务重启会使全部会话失效，多实例之间会话不共享；过期 Token 只在再次验证该 Token 时清除，长期运行可能留下过期条目。管理员密码来自环境变量是常见部署方式，本身不是明文落库漏洞，但其强度和保管完全依赖部署配置。
- 整改要求：
  1. 登录按“用户名 + 来源 IP”限流并采用递增退避。
  2. 通知按 API Key、来源 IP 和配置维度限流。
  3. 回调按来源 IP、配置维度和整体并发限制进行保护。
  4. 正确配置 `trust proxy`，仅信任明确的反向代理层。
  5. 多实例部署时使用 Redis 等共享限流存储。
  6. 增加会话列表、单会话/全部会话吊销、密码变更后失效和安全审计记录。
  7. 使用 Secret Manager、Docker Secret 或受控环境注入管理员密码，并在启动时执行最低强度与占位值校验。
  8. 当前 Bearer Header 模式不依赖 Cookie，经典 CSRF 风险较低；迁移到 Cookie 后必须同时启用 SameSite，并对敏感写操作评估 CSRF Token/Origin 校验。
- 验收标准：
  - 超限请求稳定返回 429 和合理 `Retry-After`。
  - 重启或扩容不能绕过关键限流策略。
  - 管理员可查看并吊销活跃会话，修改密码后旧会话全部失效。

### SEC-007：数据库启动失败不会阻止服务对外提供流量

- 严重级别：P2 中
- 证据：
  - `src/services/notifier.js:36`：数据库初始化异步启动并仅记录异常。
  - `server.js:89`：未等待数据库完成即开始监听。
  - `Dockerfile:69-70`、`deploy/docker-compose.yml:31-35`：健康检查只访问静态登录页。
- 影响：数据库不可用或建表失败时，容器仍被标记为健康，业务请求持续返回错误。
- 整改要求：
  1. 将服务启动改为明确的异步 bootstrap，数据库初始化成功后再监听。
  2. 初始化失败时退出进程，让容器编排系统负责重启。
  3. 增加 `/health/live` 和 `/health/ready`；ready 至少验证数据库可执行轻量查询。
- 验收标准：
  - 数据库路径不可写、数据库损坏或建表失败时服务不监听业务端口。
  - 健康检查能够区分存活和就绪状态。

### SEC-008：企业微信 HTTP 客户端缺少边界保护

- 严重级别：P2 中
- 证据：
  - `src/core/wechat.js:9`：API 地址硬编码，未使用部署声明的 `WECHAT_API_BASE`。
  - `src/core/wechat.js:64` 及其他 Axios 调用：未设置超时、响应大小、重定向策略。
  - access token 提前失效时没有自动清缓存重试。
- 影响：企业微信或网络异常可长时间占用连接；配置项看似可用但实际无效；Token 提前失效会导致持续失败。
- 整改要求：
  1. 创建统一 Axios 实例，配置连接/响应超时、最大响应体、最大请求体和 `maxRedirects: 0`。
  2. 读取并严格校验 `WECHAT_API_BASE`，生产环境默认只允许 HTTPS 和可信主机。
  3. 对 40014、42001 等 Token 失效错误清缓存并仅重试一次。
  4. 只对幂等请求采用有限、带抖动的重试；消息发送不得盲目重试。
- 验收标准：
  - 模拟超时后请求能在配置时间内结束。
  - 修改 `WECHAT_API_BASE` 后实际请求目标同步改变。
  - Token 失效只触发一次刷新，不会无限循环。

### SEC-009：输入校验和错误语义不完整

- 严重级别：P2 中
- 证据：
  - `src/services/notifier.js:321,363`：空数组为 truthy，可绕过 `touser` 必填判断。
  - 创建和完善配置没有统一校验正整数 AgentID。
  - `src/services/notifier.js:811`：字符串 `"false"` 会被当作启用回调。
  - 更新 EncodingAESKey 时未校验 43 位及合法字符。
  - `src/services/notifier.js:769-812`：允许分别修改 CorpID、CorpSecret、AgentID、callback token、EncodingAESKey 和启用状态，缺少跨字段一致性校验。
  - `src/core/database.js:171-175` 未查询 `encrypted_corpsecret`，但 `src/services/notifier.js:460` 用该字段计算 `completed`；因此当前判定实际上接近“AgentID 非零且 touser 非空”。
  - `src/api/routes.js:115-130`：多类用户输入错误统一返回 500。
- 影响：可形成“回调已启用但 Token/AESKey 缺失或不匹配”“CorpID 已改变但仍使用旧 CorpSecret”“AgentID 与当前凭证不匹配”等逻辑不一致状态；管理页面还可能把密钥缺失的异常配置误判为已完成。显式空 `touser` 在更新路径已被拒绝，不属于当前漏洞。
- 整改要求：
  1. 引入统一请求 Schema 校验，覆盖类型、长度、枚举、数组数量和对象结构。
  2. 严格区分布尔值，不做普通 truthy 转换。
  3. 在调用限流和企业微信前完成所有消息类型校验。
  4. 用户输入错误返回 400，认证错误返回 401/403，冲突返回 409，限流返回 429。
  5. 对客户端返回通用错误码，内部详细异常只进入脱敏日志。
  6. 将回调启用状态、callback token、EncodingAESKey 作为一个原子配置组校验和更新；启用回调时三者必须完整。
  7. CorpID、CorpSecret 或 AgentID 发生变化时，保存前重新调用企业微信接口验证组合有效性。
  8. `listConfigurations()` 查询并严格检查 `encrypted_corpsecret` 非空、AgentID 为正整数、touser 非空；数据库层增加能表达的约束。
- 验收标准：
  - 空接收人、非法 AgentID、错误布尔值、非法 EncodingAESKey、畸形 articles 均被拒绝。
  - 错误状态码和响应格式有路由级测试。
  - 不能通过任意部分更新创建回调半配置；密钥缺失配置不会显示为 completed。

### SEC-010：失败请求提前消耗本地发送额度

- 严重级别：P2 中
- 证据：`src/services/notifier.js:618-620` 在解密、Token 获取、消息类型校验及企业微信调用前完成额度累计。
- 影响：无效消息、密钥错误、网络失败也会消耗每日及成员频率额度，攻击者可借此造成业务拒绝服务。
- 整改要求：
  1. 参数校验必须先于额度预占。
  2. 使用“预占—成功提交—失败回滚”或原子 Token Bucket 模型。
  3. 对并发相同请求增加 in-flight 合并，避免去重缓存写入前产生重复发送。
  4. 明确 `force` 权限，不允许普通通知调用方无限绕过去重策略。
- 验收标准：
  - 参数错误、解密错误、网络错误不会永久消耗业务额度。
  - 并发相同消息最多产生一次实际发送。

### SEC-011：前端供应链和浏览器安全头不足

- 严重级别：P2 中
- 证据：
  - `public/index.html:8-14`、`public/login.html:7-9`、`public/rules.html:7-9` 使用运行时 CDN 脚本，其中包含 `@latest`。
  - 服务端未设置 CSP、HSTS、`X-Content-Type-Options`、`Referrer-Policy`、`frame-ancestors` 等。
  - `public/script.js` 多处使用 `innerHTML` 和 `insertAdjacentHTML`；本次逐项复核未发现未转义的外部动态字段，但该模式容易在后续维护中引入遗漏。
  - `public/rules.js:430-515` 实际使用 `createElement`、`textContent` 组装规则表，不属于同等风险的 HTML 字符串拼接。
- 影响：CDN 或依赖供应链被污染时可在管理页面执行脚本；页面可被框架嵌入并产生点击劫持风险。
- 整改要求：
  1. 将前端依赖固定版本并在构建时打包、自托管。
  2. 部署 CSP；将内联脚本迁移到独立文件或使用 nonce/hash。
  3. 增加 HSTS、nosniff、Referrer-Policy、Permissions-Policy 和 frame-ancestors。
  4. 公网部署强制 HTTPS；管理端口默认只绑定内网或反向代理网络。
  5. 逐步把 `public/script.js` 的动态视图改为 DOM API、模板组件或统一安全渲染函数；禁止未审查的数据直接进入 `innerHTML`。
- 验收标准：
  - 管理页面不再运行未固定版本的远程 JavaScript。
  - 安全头自动化测试通过，HTTP 请求跳转 HTTPS。
  - 新增静态检查或测试，阻止未转义动态值进入 HTML 字符串。

### SEC-012：日志记录敏感消息内容

- 严重级别：P3 一般
- 证据：
  - `src/services/notifier.js:903-905` 记录回调发送者和文本正文。
  - `src/api/routes.js:297` 记录完整解析消息。
- 影响：日志系统、备份或运维平台可能长期保存企业成员标识和聊天内容。
- 整改要求：
  1. 默认只记录事件类型、内部追踪 ID、处理状态和耗时。
  2. 禁止记录正文、CorpSecret、Token、EncodingAESKey、access token 和完整请求体。
  3. 仅在受控调试模式短期启用脱敏日志，并设置保留期限。
- 验收标准：
  - 自动化测试确认敏感字段不会出现在日志输出中。

### SEC-013：回调 XML 解析与重放防护需要加固

- 严重级别：P3 防御性加固
- 复核事实：
  - `src/api/routes.js:289-295` 将原始回调 Buffer 转为 UTF-8 字符串后交给回调模块，这是 XML 回调处理的正常数据转换，不是漏洞本身。
  - `src/core/wechat-callback.js:4-5,70-73` 使用 npm 包 `wxcrypt` 自带的 `x2o` 解析器，并未使用直接依赖 `xmldom`。
  - `node_modules/wxcrypt/util/x2o-builder.js:9-61` 只识别简单标签、CDATA 和五种预定义实体；实测 DOCTYPE、外部实体和未知实体均快速拒绝，因此未确认 XXE 或实体扩展漏洞。
  - `node_modules/wxcrypt/index.js:74-75` 会先解析外层 XML 取得 `Encrypt`，再进入签名验证；该解析发生在认证之前，但 Express raw parser 默认请求体上限约为 100KB，当前风险主要是有限的解析型 DoS 面。
  - 当前代码和 `wxcrypt` 没有校验回调时间戳新鲜度，也没有 nonce/消息 ID 重放缓存。
- 整改要求：
  1. 删除未使用的直接依赖 `xmldom`，避免其审计漏洞造成误报和供应链暴露。
  2. 明确设置回调 `express.raw()` 的 Content-Type 白名单和更严格的请求体上限。
  3. 对 timestamp 设置允许偏差窗口，并按配置缓存 nonce/MsgId 防止重复处理。
  4. 为 DOCTYPE、未知实体、超深嵌套、超长 CDATA、畸形 XML 和错误签名增加负向测试。
  5. 评估替换长期未维护的 `wxcrypt`，或将协议实现封装并使用企业微信官方测试向量持续验证。
- 验收标准：
  - XXE/DOCTYPE/实体扩展样本被稳定拒绝且不会读取本地文件或发起网络请求。
  - 超限、过期、重放及错误签名回调不会进入业务处理。

### SEC-014：`configForm.corpid` 是无效死代码

- 严重级别：P3 代码质量
- 证据：`public/script.js:123` 执行 `configForm.corpid = { value: corpid }`，但 `public/index.html:104-125` 的 `configForm` 没有名为 `corpid` 的输入框，项目中也没有后续读取 `configForm.corpid`。
- 影响：当前流程直接从 `callbackForm.corpid` 读取 CorpID，因此该语句不影响现有功能；但它会误导维护者，使人误以为第二步表单中存在标准字段。
- 整改要求：直接删除该赋值。若产品确实需要在第二步保存 CorpID，应增加明确的 hidden/input 字段并通过 DOM 元素的 `.value` 赋值，不能挂载临时对象。
- 验收标准：删除后现有配置流程测试继续通过，并增加测试确认第二步使用第一步的正确 CorpID。

## 4. 推荐实施计划

### 第一阶段：阻断高风险暴露

按以下顺序实施，每项独立提交并运行完整测试：

1. SEC-001：启动配置校验和占位值阻断。
2. SEC-004：升级高风险直接依赖，移除未使用依赖。
3. SEC-002：重构管理员会话，移除 URL Token。
4. SEC-003：拆分回调标识和通知凭证，加入轮换与迁移兼容。
5. SEC-006、SEC-011：入口限流、安全响应头和 HTTPS 部署约束。

### 第二阶段：数据和可用性加固

1. SEC-005：实现 AES-GCM 和数据库迁移。
2. SEC-007：重构启动过程和健康检查。
3. SEC-008：统一企业微信 HTTP 客户端。
4. SEC-009、SEC-010：统一输入校验及原子额度策略。
5. SEC-012、SEC-013：日志脱敏、回调边界与重放防护。
6. SEC-014：清理无效前端赋值。

### 第三阶段：持续安全治理

1. CI 增加依赖审计、镜像扫描、SBOM 和密钥扫描。
2. GitHub Actions 和 Docker 基础镜像固定到可信版本或 digest。
3. 增加数据库备份、恢复演练和密钥轮换操作手册。
4. 增加通知凭证使用审计和异常调用告警。

## 5. 下一轮 AI 执行约束

下一轮实施时必须遵守以下约束：

1. 开始修改前先运行 `npm test`，以 37 项通过作为基线。
2. 不得覆盖现有数据库；任何 Schema 或加密变更必须先提供迁移与备份方案。
3. 不得把真实密钥、Token、数据库或测试凭证写入仓库和日志。
4. 通知 URL 变更必须考虑旧调用方迁移，不能无提示直接使生产调用全部失效。
5. 每完成一个 SEC 编号，补充对应的单元测试或集成测试。
6. 依赖升级后必须重新运行生产依赖审计、完整测试和 Docker 构建。
7. 保留现有参数绑定和前端转义措施，避免修复过程中引入 SQL 注入或 XSS 回归。
8. 优先小步提交，避免把会话、加密、数据库迁移和依赖大版本升级混在同一提交中。

## 6. 建议新增的测试

- 缺少关键环境变量、使用模板占位值时启动失败。
- 登录暴力尝试触发 429，时间窗口结束后恢复。
- Cookie 的 `HttpOnly`、`Secure`、`SameSite` 属性正确。
- 查询参数 Token 不再被接受。
- 回调 ID 无法调用通知接口，旧通知密钥轮换后失效。
- HMAC 错误、过期和 nonce 重放被拒绝。
- AES-GCM 篡改检测和 CBC 旧数据迁移。
- 数据库初始化失败时服务不监听、ready 返回失败。
- Axios 超时、Token 单次刷新和禁止重定向。
- 空 `touser`、非法 AgentID、错误布尔值和畸形消息对象校验。
- 回调配置跨字段一致性和严格 completed 判定。
- 失败发送不消耗持久额度，并发重复消息只发送一次。
- XML DOCTYPE/实体/畸形/超限样本拒绝，以及 timestamp/nonce/MsgId 重放保护。
- 删除 `configForm.corpid` 死代码后配置流程保持正常。
- 响应安全头和日志敏感信息脱敏。

## 7. 完成定义

满足以下条件后，可将本轮安全整改视为完成：

- 所有 P1 问题关闭。
- 生产依赖无严重或高危可达漏洞。
- 管理员凭证不出现在 URL 或 JavaScript 可读存储中。
- 回调地址与通知发送权限完全分离。
- 敏感字段采用认证加密并有可验证迁移路径。
- 登录、通知、回调均有入口级限流和审计。
- 数据库故障不会被健康检查误判为正常。
- 完整自动化测试、依赖审计和容器构建通过。
