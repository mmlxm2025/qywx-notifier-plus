# 多应用管理第三轮复验、服务器实测风险与 AI 执行指南

> 日期：2026-07-04
> 复验分支：`feature/multi-app`
> 复验提交：`f97eb932f65eb709388d029ac07e06a91ef6ab57`
> 对照提交：`06c590ccd3ebed279228e200cbe4b5baefc4a0d7`
> 关联文档：`2026-07-04-multi-app-management-design.md`、`2026-07-04-multi-app-management-second-fix-review-ai-execution-guide.md`

## 1. 结论先行

上一轮两个 P0 的主体修复已经生效：旧 CBC 密文迁移改成旧值条件更新，默认接收人刷新也改成以服务端最新值为基线；额度回滚、向导错误分流、Modal busy、认证和管理读取错误码等修复也有自动化证据。

但当前提交仍不应发布，原因不是旧问题反复，而是服务器实测与跨层修复又暴露了新的风险：

1. **P0 安全事件：真实服务器测试文件把可登录的管理凭据写入了受 Git 跟踪的源码注释。** 删除当前行不能撤销历史暴露，必须先轮换凭据、撤销旧会话，再评估历史清理。
2. **P0 实测隔离风险：所谓真实服务器测试会修改既有应用、创建无法通过 API 清理的草稿，并且没有强制确认目标是隔离测试环境。** 它不能直接对生产数据运行。
3. **P1 前端运行错误：编辑保存成功后的统一刷新路径引用了块级作用域外的 `H`，必然产生 `ReferenceError`。** 现有测试只检查源码包含某个函数名，没有真正执行页面逻辑。
4. 登录返回地址的生产端和消费端协议相反；请求体 413、未来版本快速失败、规则页写响应归属也仍不一致。
5. 9 项真实服务器测试在默认测试中继续显示 `SKIP`；其中“AgentID 抢占冲突”用例没有执行标题所述操作，清理用例也没有清理。服务器上曾经运行过不等于仓库已经具备可信、可重复的发布证据。

发布判断：**阻断发布。先完成阶段 A 的安全处置，再按 B→G 修复和验收。不要再次只凭“全部测试绿色”宣布完成。**

## 2. 本轮验证证据

### 2.1 自动化与静态检查

| 检查 | 结果 | 解释 |
|---|---:|---|
| `npm test` | 267 项；258 通过、0 失败、9 跳过 | 9 项全部为真实服务器用例 |
| `npm run test:isolated` | 267 项；258 通过、0 失败、9 跳过 | 隔离运行结果相同 |
| JS 语法检查 | 25 个文件通过 | 只能证明可解析，不能发现运行时作用域/时序错误 |
| 生产依赖审计 | 高危漏洞 0 | 不代表仓库中没有明文凭据 |
| 总行覆盖率 | 73.27% | `routes.js` 67.28%、`database.js` 60.99%、`notifier.js` 79.20% |
| 分支/函数覆盖率 | 73.23% / 71.04% | 浏览器页面脚本并未被真实执行覆盖 |
| `git diff --check HEAD~1..HEAD` | 未通过 | 历史复验文档和规则 API 文档仍有行尾空白 |

本机未配置 `QYWX_LIVE_BASE`、`QYWX_LIVE_USER`、`QYWX_LIVE_PASS`，因此本轮没有再次调用真实服务器。鉴于测试源码已经泄露凭据，在完成轮换和隔离前也禁止用仓库中的旧值重跑。

### 2.2 上一轮问题复验

| 上一轮问题 | 当前判断 | 证据/剩余风险 |
|---|---|---|
| 旧 CBC 迁移覆盖新 CorpSecret | 已关闭 | 启动迁移和惰性迁移均带旧密文条件；真实 SQLite 竞争测试通过 |
| 默认接收人后续静默回退 | 核心数据路径已关闭 | `loadMembers()` 重建最新 picker；但随后执行 `H.computeEditRefreshPlan()` 时发生作用域错误 |
| 缺 body / 畸形 JSON 错误契约 | JSON 主链已关闭 | `urlencoded` 和 callback raw 的 parser 错误仍绕过专用处理器 |
| 向导误判普通 `INVALID_INPUT` | 已关闭 | 只对版本业务码或 `details.field=version` 刷新 |
| 规则/成员读取响应跨应用倒灌 | 读取路径大部关闭 | 写请求成功响应仍可污染切换后的新应用状态 |
| 成员限频占用每日额度 | 已关闭 | 定向回归测试通过 |
| 登录 `next` | 未关闭 | 生产端写绝对 URL，消费端只认相对路径 |
| nonce 跨应用误判 | 已关闭 | 已按 notify key 哈希分区 |
| nonce 真正硬容量 | 未关闭 | 超过 10000 时只删过期项，全部未过期时仍无限增长 |
| `X-Forwarded-Proto` 信任 | 未关闭 | Cookie Secure 判断仍绕过 Express `trust proxy` 语义 |

## 3. P0：立即处理的安全与数据隔离问题

### P0-01：管理凭据已进入 Git 跟踪文件与历史

#### 证据

- `test/live-server-contract.test.js:4-6` 的使用示例包含真实部署地址、用户名和明文密码。
- 该内容至少存在于提交 `3d1033e`、`00d0c20`，当前提交也仍可读取。
- `.gitignore` 正确忽略了 `.env`，但源码注释绕过了这层保护。

本文件不得复制或转述已经暴露的密码。后续日志、提交信息、报告和 AI 对话也不得再次输出它。

#### 必须立即执行的处置

1. 在服务器侧轮换管理密码；重启或触发密码版本变化，确认旧会话全部失效。
2. 检查访问日志：从凭据首次提交时间起，排查异常登录、配置修改、密钥轮换、规则变化和删除操作。
3. 把测试注释改成纯占位符，只从进程环境或受控密钥系统读取凭据。
4. 增加仓库敏感信息扫描，至少覆盖新增提交和历史待推送范围；扫描输出只能报告文件和规则，不能回显秘密。
5. 判断这些提交是否已推送、镜像、备份或被其他人拉取。只要无法证明未离开本机，就按已泄露处理。
6. Git 历史重写属于协作破坏性操作：AI 只能给出影响清单和执行方案，未经仓库负责人明确批准不得自动执行、不得强推。

#### 验收

- 旧凭据无法登录，已有旧会话不可继续访问管理接口。
- 当前工作树和拟发布历史的敏感扫描不再命中真实值。
- 测试说明只出现变量名和占位符。
- 形成不含秘密值的安全处置记录：发现时间、轮换时间、影响范围、日志核查结论。

### P0-02：真实服务器测试没有生产防护且会留下数据

#### 证据

- `test/live-server-contract.test.js:108-126` 选择任意既有已完成应用，创建并删除规则；断言中途失败时没有 `finally` 保证删除。
- `test/live-server-contract.test.js:129-167` 每次创建新草稿；当前管理 API 不允许删除草稿。
- `test/live-server-contract.test.js:169-185` 又创建一个草稿，随后明确把“AgentID 冲突”退化成 `legacy_until` 断言。
- `test/live-server-contract.test.js:200-204` 名为“清理”，实际仅执行 `assert.ok(true)`，注释也承认草稿保留。
- 测试只检查三个环境变量是否存在，没有验证目标实例是测试环境或使用一次性数据库。

这与文件顶部“创建并删除”“不破坏既有数据”“全量验证”的承诺冲突。

#### 必须实施

1. 立即禁止该脚本指向生产实例；服务器实测只能使用独立域名/端口、独立数据库卷和专用企业微信测试应用。
2. 增加双重保险：显式 `QYWX_LIVE_ALLOW_MUTATION=I_UNDERSTAND_TEST_ONLY`，并从服务端预检一个不可伪造的测试环境标识；任一不满足即失败退出。
3. 不再挑选任意既有应用。测试数据必须有唯一 run id，全部由本轮 fixture 创建，或由隔离数据卷预置。
4. 用 `test.after()`/`afterEach()` 统一清理，按规则→应用逆序删除；清理失败必须让套件失败并输出非敏感 run id。
5. 草稿无法经 API 删除时，优先在一次性数据卷测试后销毁整个卷；不要为生产管理面临时增加危险的“强删草稿”接口。
6. 盘点服务器上 `live-corp-` 前缀和本次测试时间窗口内的残留项。先备份并人工确认归属，不得按前缀直接批量删除。

## 4. P1：发布前必须修复的业务与跨层一致性问题

### P1-01：编辑页成功刷新必然引用未定义变量

#### 确定性路径

- `public/edit.js:231` 只在 `APP_VERSION_CONFLICT` 分支内部声明 `const H = window.FrontendHelpers`。
- `public/edit.js:295-313` 的独立函数 `refreshSummary()` 使用 `H.computeEditRefreshPlan()`，该函数不在上述块级作用域内。
- 保存成功、缺版本刷新、安全开关冲突、通知密钥冲突都会进入 `refreshSummary()`。
- 详情和成员数据可能已刷新，但 Promise 最终以 `ReferenceError: H is not defined` 拒绝，形成未处理异常，后续行为不再可信。

#### 修复

在 `DOMContentLoaded` 顶部与 `http/toast/modal` 同级声明唯一的 `const H = window.FrontendHelpers`，删除分支内重复声明。启动时若公共依赖缺失，应显示可诊断错误而不是继续执行。

#### 测试要求

必须在浏览器或可执行 DOM 环境加载真实 `edit.js`：模拟保存成功、详情返回、成员返回，断言无未处理异常、版本和 picker 都更新。禁止再用 `source.includes('computeEditRefreshPlan')` 代替执行。

### P1-02：登录返回地址生产端与消费端协议相反

- `public/http.js:115-117` 把当前路径拼成 `window.location.origin + path`，写入绝对 URL。
- `public/login.js:62-72` 只接受以单个 `/` 开头的相对路径，并拒绝绝对 URL。
- 因此 AppHttp 遇到 401 后，即使重新登录成功，也会落到首页而不是原编辑/规则页面。

修复以相对路径作为内部协议：`pathname + search + hash`；`login.js` 继续严格拒绝协议相对地址和外部来源。若为兼容旧书签解析绝对 URL，只能接受 `url.origin === window.location.origin`，并立即降级成相对路径。

测试必须把“401 生产 next”与“登录消费 next”串成一个用例，并覆盖 `/edit?code=x#security`、外部 URL、`//evil`、`javascript:`。

### P1-03：完整服务器 parser 链的 413 没有稳定业务码

生产顺序是：

```text
json parser → bodyParserErrorHandler → urlencoded parser → callback raw parser → routes → global handler
```

专用错误处理器只能接住它之前 JSON parser 的异常。最小运行复现结果：

```json
{"name":"urlencoded","status":413,"response":{"error":"request entity too large"}}
{"name":"callback-raw","status":413,"response":{"error":"request entity too large"}}
```

两条响应都缺少 `PAYLOAD_TOO_LARGE`，并泄漏了框架英文错误。修复时应把 parser 错误归一化放到所有 parser 之后、路由之前，或为不同 parser 使用同一包装；全局 4xx 兜底也必须补稳定 code。测试必须复刻 `server.js` 的完整顺序，而不是只安装 JSON parser。

### P1-04：未来版本号仍会先调用企业微信

`completeConfiguration()` 和 `updateConfiguration()` 的快速失败条件是：

```js
if (expectedVersion < currentVersion)
```

乐观锁要求的是任何不相等都冲突。最小运行验证中，当前版本为 3、请求版本为 999 时，两条路径都先调用一次企业微信，最后才由 CAS 返回 `409 APP_VERSION_CONFLICT`。

应改成 `expectedVersion !== currentVersion`。事务内 CAS 仍必须保留，网络调用仍不得进入写事务。分别测试低于和高于当前版本，断言 `getToken/getAgentInfo` 调用次数均为 0；等于当前版本才允许验证。

### P1-05：规则页旧应用写响应会污染新应用状态

读取路径已使用 `rulesGuard`/`membersGuard`，但写路径只在冲突处理时检查 `writeCode`：

- 保存成功会无条件更新 `currentAppVersion`、清空表单并 `loadRules()`。
- 启停成功会无条件把旧应用返回版本写入当前应用版本；这是最危险的路径，下一次新应用写请求会携带错误版本。
- 重生成和删除成功也会无条件刷新当前应用。

若用户在应用 A 的写请求等待期间切换到 B，A 的晚响应仍可改写 B 的版本和表单。

所有规则写操作都要捕获 `{ writeCode, writeVersion, writeGeneration }`。请求已经提交到 A 时可以让服务端完成，但响应到达后，只有当前上下文仍属于 A 才能修改 DOM、表单和 `currentAppVersion`。否则只记录“旧上下文写已完成”，不得触碰 B；随后重新进入 A 时通过读取获得真实版本。

至少增加一个受控 Promise 测试：A 写挂起→切换 B 并完成读取→A 写成功返回→B 的版本、规则、表单均不变。

### P1-06：真实服务器用例存在假阳性

1. 无既有应用时直接 `return`，测试报告显示通过而不是跳过或失败。
2. “AgentID 抢占冲突”没有完成第二个应用，也没有发送编辑请求，只断言了另一个字段。
3. “清理测试创建的草稿”无条件通过。
4. app-enabled 注释写“旧版本”，实际发送的是远高于当前值的未来版本。
5. 默认 `npm test` 永远收集这 9 项并显示跳过，使总数看起来完整但没有服务器证据。

应把 live suite 从默认 glob 中分离成 `test:live`。用户显式启动 live suite 后，缺环境、缺 fixture、目标非 test、清理失败都必须失败；业务前置条件确实不满足时使用带原因的 `t.skip()`，禁止空 `return` 冒充通过。

## 5. P2：优化与加固建议

1. `src/core/notify-auth.js` 的 `seenNonces` 超过 10000 后只删除已过期项；有效 TTL 窗口内可继续增长。增加可配置且有上下界的硬容量，按过期时间/插入顺序淘汰，并测试最终大小不超过上限。
2. `server.js:isSecureRequest()` 直接信任客户端 `X-Forwarded-Proto`。只依赖 `req.secure`；反向代理可信范围由 Express `trust proxy` 配置负责。测试 direct client 伪造 header 不得改变 Secure Cookie。
3. 编辑页成员刷新和总览 `loadApps()` 缺少请求代次；旧响应可能覆盖新刷新。统一使用请求所有权守卫。
4. 编辑页安全开关/密钥操作冲突时会调用整个 `refreshSummary()`，可能覆盖主表单未保存的非敏感输入。安全分区应独立刷新，或先快照并恢复主表单。
5. `AppRecipientPicker.setValue()` 只追加 orphan，不移除旧 orphan；多次恢复后可能保留不再相关的未选项。受控 `setValue` 应替换 orphan 基线，而不是无限累积。
6. `Modal.close()` 作为公开方法仍可在 busy 时强制关闭，`open()` 也会先关闭已有 Modal。若目标是“所有关闭路径都禁止”，公共入口同样要检查 busy。
7. `createConfiguration()`、规则字段和消息字段仍有部分 400 未附稳定业务码；统一输入错误为 `INVALID_INPUT`，并增加类型、长度、`Number.isSafeInteger()` 校验。
8. `completeConfigurationAtomic()` 调用仍传入已从 DAO 白名单移除的 `legacy_until`；虽不会写库，但注释和参数契约互相矛盾，应删除死参数。
9. `src/api/routes.js` 仍有未使用的 `isSecureRequest()`；删除死代码，避免未来有人误用同一不安全判断。
10. 把 `coverage/` 加入 `.gitignore`，避免本地覆盖率产物误提交；修复本次提交中的行尾空白。
11. 当前限流、nonce、发送去重和缓存均为进程内状态。发布文档应明确单实例约束；多实例前迁移到共享存储。
12. 增加结构化审计日志：request id、操作者会话、应用 code、操作类型、旧/新版本、结果码；绝不记录密码、CorpSecret、Token、AESKey、notify key 或 Cookie。

## 6. 业务目的—前端—后端—测试一致性矩阵

| 业务结果 | 后端 | 前端 | 当前测试 | 判定 |
|---|---|---|---|---|
| 管理凭据不进入源码和历史 | 环境变量读取正确 | 无关 | 测试注释写入真实值 | **P0 违反** |
| 实测不破坏业务数据 | API 无草稿删除 | live suite 修改既有数据 | 无环境隔离/真实清理 | **P0 违反** |
| 编辑保存后状态可继续操作 | 写入和最新读取正确 | 刷新末尾 `H` 未定义 | 只测 helper/源码形状 | **P1 违反** |
| 会话失效后返回原页 | 401/登录可用 | next 生产绝对、消费相对 | 两端分开测 | **P1 违反** |
| 所有请求格式错误有稳定 code | JSON parser 已统一 | AppHttp 依赖 JSON code | 未覆盖生产完整 parser 顺序 | **P1 部分完成** |
| 任意版本不匹配先冲突 | CAS 最终正确 | 可展示冲突 | 只覆盖旧/部分未来值，不断言上游调用 | **P1 性能与优先级不一致** |
| A/B 应用状态绝不串写 | 服务端按 code 隔离 | 读响应隔离，写响应未隔离 | 只测试通用 guard | **P1 违反** |
| 真实身份冲突被服务器验收 | 事务测试充分 | 提示已有 | live 用例未发冲突请求 | **发布证据缺失** |
| HMAC 防重放且内存有界 | 按 key 隔离 | 无关 | 未测试硬容量 | P2 未完成 |

## 7. AI 分阶段执行计划

以下顺序不可调整。每阶段先补能在当前实现上稳定失败的测试，再修改代码；每阶段结束运行定向测试和默认全量测试，单独提交。

### 阶段 A：安全应急与服务器隔离

责任边界：密码轮换、日志核查、历史重写和强推需要仓库/服务器负责人授权。AI 不得假定权限。

1. 立即轮换已暴露管理密码并验证旧会话失效。
2. 从 `test/live-server-contract.test.js` 删除真实值，只保留占位说明。
3. 检查当前分支、所有待推送提交和可见历史的秘密命中。
4. 暂停 live suite 的数据写入，先建立独立测试实例和一次性 DB 卷。
5. 形成历史重写方案和协作者通知清单，等待明确批准后再执行。

阶段门槛：旧凭据不可用、当前源码不含真实值、live 测试无法误指向生产。未满足前禁止继续服务器写测试。

### 阶段 B：先冻结五个真实失败场景

新增或改造测试：

- 编辑页真实执行：保存成功刷新不得抛异常。
- 登录链路：AppHttp 生成的 next 能被 login 安全消费。
- server 完整 parser 链：JSON、urlencoded、raw 的 400/413 均有稳定 JSON code。
- complete/update 未来版本：企业微信调用数为 0。
- 规则页 A 写延迟、切换 B 后返回：B 状态不变。

这些测试必须在修实现前失败，且失败原因分别对应本指南缺陷；不得用正则或复制一份“同语义实现”来冒充生产代码执行。

### 阶段 C：修复前端运行错误和返回地址契约

修改：

- `public/edit.js`
- `public/http.js`
- `public/login.js`
- 必要的可复用 helper 与前端行为测试

要求：

1. `H` 在页面顶层依赖区只声明一次。
2. next 内部协议统一为同源相对路径，保留 query/hash。
3. 外部、协议相对和脚本协议继续拒绝。
4. 完成真实页面执行测试，不只检查源码文本。

### 阶段 D：统一后端错误与版本优先级

修改：

- `server.js`
- `src/core/body-parser.js`
- `src/services/notifier.js`
- `src/api/routes.js`
- 后端 HTTP/服务测试

要求：

1. parser 统一处理器覆盖 json、urlencoded、raw。
2. 400/413 响应均为 `{ error, code, details? }`，不返回框架英文、HTML、堆栈或路径。
3. complete/update 的事务外检查使用严格不相等；事务内 CAS 保持权威。
4. 高/低版本冲突均不调用企业微信。
5. Cookie Secure 只依赖正确配置的 `req.secure`。

### 阶段 E：修复规则写响应归属与刷新竞态

修改：

- `public/rules.js`
- `public/script.js`
- `public/edit.js`
- `public/components/recipient-picker.js`
- 对应行为测试

要求：

1. 所有规则写操作统一捕获并校验写上下文，过期响应不得修改当前 UI/版本。
2. load 按钮只能由当前 load 请求解锁。
3. 总览和编辑成员刷新加入独立代次守卫。
4. 安全分区冲突不清空主表单草稿。
5. picker 受控重置时替换 orphan 基线。

### 阶段 F：重建可信的 live suite

修改：

- `test/live-server-contract.test.js`
- `package.json`
- 部署/QA 文档

要求：

1. 默认 `npm test` 不收集 live 文件；提供显式 `npm run test:live`。
2. live 启动必须通过测试环境标识和显式写入确认。
3. 不读取或修改任意既有业务应用；所有 fixture 带 run id。
4. 真正构造两个已完成测试应用并执行 AgentID 抢占编辑，断言 `409 APP_IDENTITY_CONFLICT + existing_code`。
5. 规则、应用、草稿清理要么可靠执行，要么通过销毁一次性数据卷完成；清理失败不得报告全绿。
6. 产出脱敏 JSON/JUnit 报告，记录目标环境标识、提交、开始/结束时间、通过/失败/跳过数和清理结果。

### 阶段 G：加固、文档和最终发布验收

1. nonce 硬容量、Modal 所有关闭路径、字段长度/类型、安全整数、死代码和 legacy 死参数收口。
2. 更新 API 文档、README、QA 报告、部署单实例约束和错误码矩阵。
3. 修复空白检查；覆盖率产物加入忽略。
4. 完成默认测试、隔离测试、live 测试、浏览器行为矩阵和敏感扫描。
5. 只有 P0/P1 为 0、清理报告成功、服务器实测报告可追溯时才能给出发布结论。

## 8. 最终验收清单

### 安全与实测

- [ ] 已轮换泄露凭据，旧凭据和旧会话不可用。
- [ ] 当前源码、提交差异和待发布历史不含真实秘密。
- [ ] live suite 只能连接隔离测试环境和一次性数据库。
- [ ] 实测结束没有规则、应用、草稿残留；报告包含清理结果。
- [ ] 身份冲突用例真实发送了冲突编辑请求，不再以无关断言代替。

### 前端

- [ ] 编辑保存成功、缺版本、安全开关冲突、密钥冲突刷新均无未处理异常。
- [ ] `alice → bob → 只改描述` 不回退接收人。
- [ ] 401 登录后返回原 `/edit` 或 `/rules` 路径，外部 next 被拒绝。
- [ ] A 写挂起后切换 B，A 的任何晚响应都不改变 B。
- [ ] 快速重复刷新时只有最新响应可渲染和解锁按钮。
- [ ] 安全分区冲突不清空未保存主表单。

### 后端

- [ ] json/urlencoded/raw 畸形或超限均返回稳定 JSON code。
- [ ] 高于和低于当前版本都先返回冲突，企业微信调用次数为 0。
- [ ] 事务内 CAS、身份判重、token 提交后失效和密文旧值条件更新仍通过。
- [ ] 伪造 `X-Forwarded-Proto` 不能绕过 `trust proxy` 改变 Cookie 判断。
- [ ] nonce 缓存达到上限后保持有界且重放判断正确。

### 质量门槛

- [ ] `npm test` 全通过且默认套件没有伪装成通过的 live 用例。
- [ ] `npm run test:isolated` 全通过。
- [ ] `npm run test:live` 在隔离服务器全通过并生成脱敏报告。
- [ ] 关键前端流程执行真实页面脚本，不以 `source.includes()` 作为行为证据。
- [ ] `npm audit --omit=dev --audit-level=high` 通过。
- [ ] `git diff --check` 和敏感信息扫描通过。

## 9. 可直接交给 AI 的执行提示

```text
请严格按照《2026-07-04-multi-app-management-third-fix-review-ai-execution-guide.md》阶段 A→G 执行。

第一优先级是安全处置：test/live-server-contract.test.js 曾把真实管理凭据写入 Git。不要在任何输出中复述该值；先要求负责人轮换凭据并确认旧会话失效。Git 历史重写和强推必须单独取得明确授权，禁止自行执行。live suite 在隔离测试实例和一次性数据库就绪前不得运行写操作。

每个代码阶段必须：
1. 先添加在当前代码上稳定失败、且执行生产代码的回归测试；
2. 只修改该阶段文件及必要依赖，不覆盖历史复验文档；
3. 运行定向测试、npm test、npm run test:isolated；live 测试只在阶段 F 的隔离环境运行；
4. 汇报业务行为变化、测试证据、清理结果和剩余风险；
5. 不使用 git reset --hard、git checkout -- 等破坏性命令，不记录或提交任何秘密。

必须优先关闭：编辑页 H 作用域运行错误、next 生产/消费协议不一致、完整 parser 链 413 缺 code、未来版本仍调用企业微信、规则写响应跨应用污染。事务外版本检查不能替代事务内 CAS，网络调用不得进入 SQLite 写事务，前端不得匹配中文错误文案。

不得把测试名称、source.includes、空 return 或 assert.ok(true 当作业务验收。最终发布证据必须包含真实浏览器流程和隔离服务器脱敏报告，并证明测试数据已清理。
```
