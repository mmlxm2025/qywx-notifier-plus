# 测试服务器、代码与 UI 联合排查报告

- 排查日期：2026-07-04（Asia/Shanghai）
- 代码工作区：`feature/multi-app`，基线 HEAD `839250a`，本报告修复尚未提交
- 测试站点：`https://ssl.oso21.top`
- 目标容器：`qywx-notifier-plus-verify`
- 报告用途：记录初始证据、已完成修复、测试服部署结果，以及交给下一位 AI 的剩余动作

> 状态说明：第 4 节保留修复前的原始证据和根因，便于追溯；当前真实状态以第 1、2、3、5、6 节为准。

## 1. 结论

除 `DEP-001` 及其依赖项 `DEP-003` 外，报告中的项目代码、测试门禁、缓存、UI、可访问性、前端自托管、文档、favicon、登录错误码和测试服混合镜像问题均已修复并回归。

`12125` 公网明文端口按项目所有者要求暂时保留，当前仍为 `0.0.0.0:12125 -> 12121/tcp`。因此测试服继续使用 `TRUST_PROXY=false`；在端口仍可被公网直连时，**不得**提前改成 `loopback` 或 `1`。这意味着 HTTPS 登录 Cookie 的 `Secure` 属性和真实客户端 IP 限流仍是已知、明确接受的临时缺口。

测试服已从热补丁混合态切换为不可变镜像 `qywx-notifier-plus:verify-wt-f27700605aab`，镜像 ID 为 `sha256:cc7d9d7bedbd...`。14 个关键业务文件与本地工作区哈希完全一致，`docker diff` 没有 `/app/public`、`/app/src` 或 `/app/server.js` 变化。由于本地修复尚未提交，镜像 revision 明确写成 `839250a...+worktree.f27700605aab`，没有伪装成干净 Git 提交；下一位 AI 应在用户确认后提交并重建正式 commit 标签镜像。

## 2. 已验证的环境状态

### 2.1 本地代码

| 项目 | 结果 |
|---|---|
| 分支 / HEAD | `feature/multi-app` / `839250a` |
| Node / npm | `v24.18.0` / `11.16.0` |
| 自动测试 | `378 passed, 0 failed` |
| 生产依赖审计 | `0` 个已知漏洞 |
| live 门禁 | 缺环境变量时 `npm run test:live` 非零退出，不再全量 skip 假绿 |
| 工作区既有未跟踪文件 | `docs/` 下 7 张 UI 截图，均保留未修改 |

### 2.2 测试服务器

| 项目 | 结果 |
|---|---|
| Docker | `29.6.1` |
| 容器 | `qywx-notifier-plus-verify`，healthy |
| 声明镜像 | `qywx-notifier-plus:verify-wt-f27700605aab` |
| Image ID | `sha256:cc7d9d7bedbd...` |
| 端口 | `0.0.0.0:12125 -> 12121/tcp` |
| 数据卷 | `/root/qywx-verify-data/database -> /app/database` |
| Node / npm | `v24.18.0` / `11.16.0` |
| 进程状态 | healthy，0 次重启，日志无 fatal/error 匹配 |
| 数据库 | `PRAGMA integrity_check = ok`；2 个配置、5 条规则、10 条退役编号 |
| HTTPS | HTTP/2 正常；证书覆盖 `*.oso21.top`，到期日 2026-09-17 |
| 健康检查 | `/health/live` 与 `/health/ready` 均为 200 |
| 版本接口 | `2.0.0-dev` / `839250a...+worktree.f27700605aab` |
| 测试实例标识 | `ssl-oso21-test-20260704-f277`；仅认证后接口可读取 |
| 回滚容器 | `qywx-notifier-plus-verify-pre-f277-20260704-231008`（已停止） |
| 数据库备份 | `notifier.db.pre-f277-20260704-231008.bak` |
| OpenResty 备份 | `ssl.oso21.top.conf.pre-qywx-audit-20260704-231323.bak` |

### 2.3 验证边界

- 线上完成新镜像构建、自检、数据库停机备份、容器替换、健康检查、认证 API 探针和 OpenResty 目标站点配置修正。
- 没有读取或输出管理员密码、加密密钥或通知密钥；认证探针在容器内部直接使用环境变量，并在结束时注销会话。
- 没有发送企业微信消息，也没有运行会创建/删除业务数据的 live 套件；认证探针只读配置列表，线上仍为原 2 个配置。
- 认证后 UI 使用独立本地临时实例和临时 SQLite 数据库完成浏览器回归；部署后的真实站点另做了未认证登录页资源和控制台复验。

## 3. 问题分级总表

| ID | 级别 | 问题 | 当前状态 |
|---|---|---|---|
| DEP-001 | P0 | 后端 `12125` 端口公网 HTTP 直出 | **用户暂缓**：保持现状，后续由用户手动关闭 |
| DEP-002 | P0 | 镜像、标签与容器文件不一致 | **已修复测试服**：不可变工作区镜像；待提交后换正式 commit 标签 |
| DEP-003 | P1 | 未配置可信代理 | **依赖 DEP-001 暂缓**：模板/文档已就绪，运行态保持 `false` |
| QA-001 | P1 | live 套件缺少真实测试环境保护且会假绿 | **已修复** |
| CACHE-001 | P1 | 管理 API 未设置 `no-store` | **已修复并线上验证** |
| UI-001 | P2 | 规则页 375px 横向溢出 | **已修复**，含长错误文本追加修复 |
| UI-002 | P2 | 编辑页 sticky 保存栏遮挡表单 | **已修复** |
| UI-003 | P2 | API 文档移动端横向溢出且线上仍为旧版 | **已修复并进入镜像** |
| UI-004 | P2 | 关键文字颜色对比度不达标 | **已修复**：实际值 6.62:1 / 5.95:1 |
| A11Y-001 | P2 | 规则页若干控件没有可访问名称 | **已修复** |
| OPS-001 | P2 | Tailwind CDN 运行时用于生产 | **已修复**：Tailwind/DaisyUI/Lucide 全部构建期自托管 |
| DOC-001 | P3 | 版本、镜像、HTTPS 文档不一致 | **已修复** |
| OPS-002 | P3 | favicon 404、OpenResty 配置告警 | **目标站点已修复**；其他站点告警不属于本项目 |
| API-001 | P3 | 登录接口错误响应缺稳定 `code` | **已修复** |

## 4. 详细问题与根因

本节为修复前审计记录，不代表当前运行状态；每项最终状态见第 3 节。

### DEP-001：公网可直连明文 HTTP 后端（P0）

证据：

- Docker 映射为 `0.0.0.0:12125->12121/tcp`。
- 从外部访问 `http://oso21.top:12125/health/live` 返回 HTTP 200。
- 直连端口不执行 OpenResty 的 HTTP→HTTPS 301；登录页和管理 API 同样可达。

风险：

- 用户若误用 `http://oso21.top:12125` 登录，账号密码通过明文 HTTP 传输。
- 可绕过反代的 HTTPS、站点级限制和未来增加的 WAF/审计策略。
- 与 DEP-003 叠加后，当前会话 Cookie 本身也没有 `Secure`。

修正：

1. 本测试服务器把端口改为仅回环监听：`127.0.0.1:12125:12121`。
2. 云安全组和主机防火墙关闭公网 `12125`。
3. 外部只保留 `80/443`，由 OpenResty 访问回环端口。

验收：

- 外部 `curl http://oso21.top:12125/health/live` 必须连接失败。
- 服务器本机 `curl http://127.0.0.1:12125/health/live` 为 200。
- `https://ssl.oso21.top/health/ready` 仍为 200。

### DEP-002：运行容器是热补丁混合态（P0）

证据：

- 容器声明镜像：`qywx-notifier-plus:prod-c43a27c`，镜像创建于 21:07。
- `docker diff qywx-notifier-plus-verify` 显示 `/app/public/` 下 12 个业务文件被修改。
- 容器内后端、`package.json` 与本地 HEAD 完全一致。
- 19 个前端文件中 18 个与 HEAD `839250a` 一致，只有 `public/api-docs.html` 不一致。
- 直接对原镜像启动一次性容器后，`modal.js`、`rules.html`、`styles.css` 等哈希均与当前运行容器不同。

影响：

- `docker rm` 后按原镜像重建，会丢失随机编号按钮、模态自动关闭和全局 UI 优化。
- 镜像标签暗示代码是 `c43a27c`，实际运行内容却接近 `839250a`，无法可靠审计。
- API 文档单页仍使用旧的内联样式，与其他页面的新设计系统不一致。

修正：

1. 完成本报告中的代码修复并提交，确保 `git status` 没有业务文件修改。
2. 从干净提交构建新镜像，建议标签：`qywx-notifier-plus:verify-<commit>`。
3. 写入 OCI 标签 `org.opencontainers.image.revision=<full sha>`、`created`、`version`。
4. 用新镜像重建容器；不得再复制文件进容器。
5. 部署后比较 `/app` 文件清单与构建提交，并要求 `docker diff` 只出现运行时 `/tmp` 和数据库挂载变化。

验收：

- 容器镜像标签、OCI revision、Git HEAD 三者一致。
- `docker diff` 不再出现 `/app/public/*` 或 `/app/src/*`。
- 删除并重建容器后 UI 与功能不回退。

### DEP-003：反代部署未设置 `TRUST_PROXY`（P1）

代码链路：

- `server.js:27-38`：缺少 `TRUST_PROXY` 时 `app.set('trust proxy', false)`。
- `server.js:101-103`：只有 `req.secure === true` 才给登录 Cookie 添加 `Secure`。
- `src/api/routes.js:26-28` 与 `server.js:77-105`：登录、通知、回调限流依赖 `req.ip`。
- OpenResty 将请求转发到 `127.0.0.1:12125`，但容器环境变量列表没有 `TRUST_PROXY`。

确定性结果：

- Express 看到的是反代的 HTTP 连接，`req.secure=false`，成功登录 Cookie 不含 `Secure`。
- 经 HTTPS 反代进入的所有外部请求在应用层共享同一个代理 IP。
- 通知限流会退化为全站共享 60 次/窗口；任一调用方可耗尽其他调用方额度。
- 管理员用户名通常相同，任一来源的失败登录会影响其他来源的登录退避。

修正顺序非常重要：

1. 先完成 DEP-001，只允许回环访问容器端口。
2. 再为该反代部署设置 `TRUST_PROXY=loopback`（或精确可信 CIDR）。
3. 不要在仍允许公网直连的端口上使用宽泛 `TRUST_PROXY=1`，否则直连客户端可伪造转发头。
4. 在部署文档中拆分“直接访问”和“同机反代”配置，不共用模糊默认值。

验收：

- HTTPS 成功登录的 `Set-Cookie` 同时含 `HttpOnly; Secure; SameSite=Lax`。
- 两个不同外部 IP 不再共享同一通知限流桶。
- 直连端口已不可从公网访问，伪造 `X-Forwarded-For` 无法绕过。

### QA-001：live 测试保护和结论失真（P1）

证据：

- `test/live/live-server-contract.test.js:9-10` 注释声称会检查 `/health/ready` 的 `test_env`，实际代码没有该检查。
- 缺少 live 环境变量时使用 `{ skip: SKIP_REASON }`；实测 `npm run test:live` 为 `0 passed / 8 skipped`，退出码仍为 0。
- “编辑 AgentID 抢占身份冲突”用例实际发送未来版本号，并接受 `APP_VERSION_CONFLICT`，没有验证 `APP_IDENTITY_CONFLICT`。
- `/health/ready` 当前只返回 `{status, database}`，测试容器也没有任何测试实例标识。

风险：

- CI 或人工报告可能把“全部跳过”误写成通过。
- 只要设置四个环境变量，套件就可能对错误目标创建/删除数据。
- 绿色用例名称会给 AgentID 身份冲突提供错误保证。

修正：

1. `npm run test:live` 缺任一必要变量时必须失败退出，不能全部 skip。
2. 在测试实例启用独立的 `TEST_INSTANCE_ID`；认证后的预检接口返回实例标识或其摘要。
3. live 客户端要求 `QYWX_LIVE_EXPECT_INSTANCE` 与服务端完全匹配后，才允许任何写操作。
4. 测试数据必须使用一次性数据卷；测试结束销毁卷，而不是依赖长期库清理。
5. 真正构造同 CorpID、不同 AgentID 的两个应用，再用**当前正确版本**发起抢占并断言 `409 APP_IDENTITY_CONFLICT`。如需要企业微信验证，给测试实例配置隔离的 WeChat stub，不要用未来版本冲突绕过。
6. 删除或重命名测试名中“当前失败”但实际通过的历史复现用例，避免绿灯报告误读。

验收：

- 无变量运行 `npm run test:live` 必须非零退出。
- 指向非测试站点时在首次写请求前失败。
- 身份冲突用例断言的业务码必须是 `APP_IDENTITY_CONFLICT`。
- 套件结束后临时数据卷中无残留，失败清理必须令套件失败。

### CACHE-001：认证和管理响应被缓存（P1）

证据：

- `/api/auth-status` 与 `/api/configurations` 响应带 `ETag`，没有 `Cache-Control: no-store`。
- OpenResty 访问日志中管理 API 多次返回 304，包括 `auth-status`、配置列表、规则和成员接口。

影响：

- 浏览器会保留认证状态和管理数据响应体，登出/切换会话后可能短暂使用旧状态。
- 共享终端或浏览器缓存中保留应用元数据，不符合管理后台的最小缓存原则。

修正：

在所有 `/api/` 管理与认证响应前统一设置：

```http
Cache-Control: no-store, private
Pragma: no-cache
```

通知发送接口也可统一 `no-store`，避免返回消息 ID/错误详情被缓存。静态资源仍保留独立缓存策略。

验收：

- `/api/auth-status`、配置列表/详情/规则/成员均含 `Cache-Control: no-store, private`。
- 带旧 `If-None-Match` 再请求管理 API 不应返回 304。
- 登出后浏览器后退不会显示缓存的管理数据。

### UI-001：规则页移动端整页横向溢出（P2）

复现：最新 HEAD，375×812，打开 `/rules?code=<code>`。

测量结果：

- `body.clientWidth = 360`
- `body.scrollWidth = 448`
- `#rule-form` 宽约 408px，右边界 448px
- API 编号 join、筛选框、随机/刷新按钮和规则操作按钮均超出视口

根因：`public/rules.html:53-147` 的 CSS Grid 子项默认 `min-width:auto`；API 编号 join 中前缀、长 placeholder 和按钮共同形成较大的最小内容宽度，撑开 grid 和整页。规则表虽然有 `overflow-x-auto`，父 grid 已先被表单撑宽。

修正：

- 给 `#workspace`、两列 grid、`#rule-form`、规则列表 section 添加 `min-w-0`。
- API 编号输入添加 `min-w-0 w-0 flex-1`；必要时在窄屏把“随机”按钮换成仅图标或单独一行。
- 筛选框添加 `min-w-0`。
- 规则表只允许自己的容器横向滚动，不能扩大 `document`。

验收尺寸：320、375、768、1024、1440。

```js
document.documentElement.scrollWidth === document.documentElement.clientWidth
```

同时要求所有表单控件位于视口内；规则表如需横向滚动，只能在 `#rules-list` 内发生。

### UI-002：编辑页保存栏遮挡字段（P2）

证据：`public/edit.html:143-149` 使用 `sticky bottom-2`。

- 1440×900 页面顶部，保存栏位于 y=819～892，与“回调配置”发生重叠。
- 375×812 页面顶部，保存栏位于 y=731～804，与“企业凭证”发生重叠。
- 现有 `docs/ui-optimized-edit.png` 也能看到保存栏覆盖输入区域。

根因：bottom sticky 会在其自然位置尚未进入视口时提前贴底，本质上会覆盖滚动内容；注释中的“避免遮挡内容”并未被布局实现。

修正建议：首选移除 `sticky`，让保存按钮回到正常文档流。若产品必须常驻操作栏，应把页面改成“独立滚动内容区 + 不参与覆盖的固定 footer”应用壳，而不是只增加 `z-index`。仅加背景或阴影不能解决遮挡。

验收：在 375×812 和 1440×900 的任意滚动位置，保存栏与任一 `#edit-form > section` 的矩形交集必须为 0。

### UI-003：API 文档移动端溢出，且线上文件落后（P2）

证据：

- 最新 HEAD 在 375×812 下 `body.scrollWidth = 667`，视口内容宽 360。
- 多个表格/长 code 超出视口；顶层 body 是 flex，文档卡片保持内容最小宽度。
- 线上容器的 `public/api-docs.html` 哈希与 HEAD 不同，仍保留旧内联 `.glass-card/body` 样式，未引入共享 `styles.css`。

修正：

- 将 HEAD 版本的 `api-docs.html` 真正纳入新镜像。
- 顶层文档卡片和各 section 增加 `min-w-0 max-w-full`。
- 所有表格包裹受限的 `overflow-x-auto max-w-full` 容器。
- `pre` 使用自身横向滚动或换行，`code`/长字段使用 `overflow-wrap:anywhere`。
- 移动端 header 允许标题和“返回首页”换行。

验收：375px 下 document 无横向滚动；表格/代码块的内部滚动不扩大 body。

### UI-004：主题对比度不足（P2）

在最新页面读取实际计算样式并按 WCAG 对比度计算：

| 元素 | 前景 / 背景 | 对比度 | 要求 |
|---|---|---:|---:|
| `.btn-primary` 14px 粗体 | `rgb(255,219,228)` / `rgb(245,0,118)` | 3.21:1 | 4.5:1 |
| 规则页蓝色应用横幅中的安全设置链接 12px | `rgb(245,0,118)` / `rgb(58,191,248)` | 1.94:1 | 4.5:1 |
| 运行中 badge 12px | `rgb(21,128,61)` / `rgb(220,252,231)` | 4.57:1 | 4.5:1，通过 |

修正：

- 不要在 `alert-info` 蓝底上使用 `link-primary`；改为 `info-content` 的深色链接并保留下划线。
- 为 DaisyUI 建立自定义主题，调深 primary 或使用深色 primary-content，确保按钮常态、hover、disabled 均达到 4.5:1。
- 自动化测试读取计算样式并断言关键组合对比度，不只检查 class 名。

### A11Y-001：规则页控件缺少可访问名称（P2）

浏览器可访问树显示：

- `#rule-api-code` 的名称来自 placeholder，而不是“API 自定义编号”。
- `#member-filter` 只有 placeholder。
- 规则列表中的多个启停开关显示为无名称 checkbox；`title` 没有形成稳定可访问名称。

修正：

- 用 `<label for="rule-api-code">API 自定义编号</label>`。
- 给成员筛选框增加显式 label（可视觉隐藏）或 `aria-label="筛选成员"`。
- 动态规则开关设置 `aria-label="启用规则：<规则名>"`，状态变化后同步文本；不要只依赖 `title`。
- 增加浏览器级可访问树测试，断言所有交互控件有唯一名称。

### OPS-001：生产 UI 依赖 Tailwind CDN 运行时（P2）

浏览器控制台每个页面都会出现：

```text
cdn.tailwindcss.com should not be used in production
```

所有页面还依赖 unpkg/jsDelivr；Tailwind 在浏览器中运行时生成样式，CSP 因此允许远端脚本和 `'unsafe-inline'` 样式。CDN 网络异常会直接破坏页面布局或图标。

修正：

1. 构建期生成静态 Tailwind CSS。
2. 将 DaisyUI、Lucide 所需产物固定并随镜像自托管。
3. 删除浏览器 Tailwind 编译器和无用 CDN 域名。
4. 收紧 CSP，目标是移除远端 `script-src` 和 `style-src 'unsafe-inline'`（如仍有必要，使用 nonce/hash）。

验收：所有管理页控制台 0 error、0 Tailwind production warning；断网后本地静态 UI 仍可完整加载。

### DOC-001 / OPS-002 / API-001（P3）

- `package.json` 为 `2.0.0-dev`，离线构建、导入脚本和文档仍固定 `1.0.0`。
- `public/api-docs.html` 多处示例使用 `http://your-server.com`，会诱导在明文 HTTP 中携带通知密钥。
- `deploy/README-1PANEL.md` 主流程要求公网放行应用端口，与本服务器 HTTPS 反代架构冲突。
- `/favicon.ico` 每次访问返回 404。
- `/opt/1panel/www/conf.d/ssl.oso21.top.conf` 写成重复的 `server_name ssl.oso21.top ssl.oso21.top;`；`openresty -t` 还报告多站点 protocol options/server_name 告警，语法虽通过但应清理。
- `POST /api/login` 的缺字段 400、错误凭据 401、限流 429 只返回 `error`，没有项目其他 API 使用的稳定 `code`。

修正：统一版本来源，HTTPS 示例优先，按反代/直连拆分部署文档，增加本地 favicon，清理 1Panel 重复域名项，并为登录接口补充 `INVALID_INPUT`、`AUTH_INVALID`、`RATE_LIMITED` 等稳定错误码。

## 5. 下一位 AI 只需处理的剩余动作

1. **不要擅自调整 `12125`。** 项目所有者已明确该公网映射是临时设置，后续由其手动处理。
2. 用户确认端口已改为回环监听并关闭公网入口后，再把测试服改为 `TRUST_PROXY=loopback`；随后验证 HTTPS 登录 Cookie 含 `Secure; HttpOnly; SameSite=Lax`，并验证不同外部 IP 使用不同限流桶。
3. 用户授权提交后，把当前工作区修复提交到 Git，构建 `verify-<commit>` 正式测试镜像，并替换目前明确标记为 worktree 的镜像。不得把 `f27700605aab` 当成 Git commit。
4. 替换正式镜像前保留当前回滚容器和数据库备份；验证完成后再询问用户是否删除旧容器、旧镜像和构建目录。
5. 如需运行 `npm run test:live`，必须使用一次性数据卷和隔离企业微信 stub。长期测试库虽然有实例标识，也不得直接执行有写入的 live 套件。
6. OpenResty 中 `ssl.oso21.top` 的重复域名已修复；其余 `frp/ha/push/_` 与协议选项告警属于其他站点，不要在本项目任务中顺手修改。

## 6. 本次实际验收结果

### 后端/部署

- `npm test`：378 passed，0 failed。
- `npm audit --omit=dev --audit-level=high`：0 vulnerabilities。
- 无 live 环境变量时 `npm run test:live`：退出码 1，0 skipped。
- live 套件在任何写操作前要求认证后的实例标识与 `QYWX_LIVE_EXPECT_INSTANCE` 完全一致。
- 真实 AgentID 抢占用例使用当前版本并只接受 `409 APP_IDENTITY_CONFLICT`。
- 管理 API：`Cache-Control: no-store, private`，无 `ETag`；带旧 `If-None-Match` 仍返回 200。
- 登录错误码：`INVALID_INPUT`、`AUTH_INVALID`、`RATE_LIMITED` 已加入运行时测试。
- 镜像自检：sqlite3、CSP、本地 CSS/Lucide/favicon、live/ready/version/favicon HTTP 路由均通过。
- 部署前后数据库 `PRAGMA integrity_check = ok`，数据数量未变化。
- 新容器 healthy、0 重启、无 fatal/error 日志匹配。
- 14 个关键业务文件的容器哈希与本地完全一致；`docker diff` 无业务文件修改。
- HTTPS 443 成功；公网 12125 仍为 200，属于用户明确暂缓项。
- HTTPS Cookie `Secure` 与真实客户端 IP 限流未验收，原因是 `DEP-001` 尚未由用户关闭。

### 浏览器/UI

- 本地认证实例覆盖总览、规则、编辑、API 文档 4 页和 320×568、375×812、768×1024、1440×900 共 16 个组合，全部无 document 横向溢出。
- 编辑页保存栏与表单 section 的矩形交集为 0。
- 所有脚本和样式资源同源；控制台 0 warning、0 error、无 Tailwind production warning。
- 主按钮实际对比度 6.62:1；信息横幅链接 5.95:1。
- API 自定义编号、成员筛选和动态规则开关均有稳定可访问名称。
- 随机编号按钮生成 36 位合法编号。
- 部署后的 `https://ssl.oso21.top/login` 在 375×812 下无溢出、无外部资源、无控制台告警，主题为 `qywx`。

## 7. 可保留的良好基线

以下项目已验证正常，修复时不要回退：

- Node 24 / npm 11 与 `package.json` engines 一致。
- 378 项本地测试通过，生产依赖审计为 0。
- 容器以 uid 1000 的非 root 用户运行，tini 与健康检查有效。
- 数据库完整性为 `ok`，数据卷独立于其他实例。
- HTTPS、HSTS、CSP、X-Frame-Options、nosniff 等响应头已存在。
- 非 JSON body 返回 400 而非 500。
- 模态成功自动关闭、规则随机编号、响应式 UI 和自托管前端均已通过新镜像持久化。

## 8. 禁止事项

- 禁止继续以 `docker cp`/容器内直接编辑作为最终部署。
- 禁止在公网直连仍开放时设置宽泛的 `TRUST_PROXY=1`。
- 禁止从容器环境打印管理员密码、加密密钥或通知密钥。
- 禁止在长期测试库或真实业务库运行会创建/删除应用的 live 套件。
- 禁止用未来版本冲突冒充 AgentID 身份冲突验证。
- 禁止仅凭“单元测试全绿”宣布发布通过；必须同时验证镜像来源、端口暴露、代理语义和 375px UI。

## 9. 修复落点速查

| 范围 | 主要文件 | 作用 |
|---|---|---|
| API/运行时 | `server.js`、`src/core/config.js` | API no-store、登录稳定错误码、认证测试实例探针、版本接口、favicon、关闭 ETag |
| 身份冲突 | `src/services/notifier.js` | 已知 AgentID 身份冲突在企业微信调用前快速失败，事务仍负责最终竞态判定 |
| live 门禁 | `test/live/live-server-contract.test.js` | 缺参数失败、实例标识预检、真实 `APP_IDENTITY_CONFLICT` 断言 |
| 前端构建 | `tailwind.config.js`、`src/styles/tailwind.css`、`scripts/build-frontend.js` | 构建期 Tailwind/DaisyUI 与本地 Lucide 产物 |
| 前端产物 | `public/app.css`、`public/vendor/lucide.min.js`、`public/favicon.svg` | 必须随源码提交并进入镜像，不能在容器内临时复制 |
| UI/CSP | `public/*.html`、`public/styles.css`、`public/components/modal.js`、`public/components/toast.js`、`src/core/security-headers.js` | 响应式、对比度、可访问名称、无内联样式、严格同源 CSP |
| 镜像来源 | `Dockerfile`、两份 Docker workflow | 前端构建、OCI revision/version、可选 Debian 镜像源 |
| 离线部署 | `deploy/build-and-pack.*`、`deploy/import-load.sh`、`deploy/IMAGE_TAG` | 版本与 Git 短提交派生，不再固定 `1.0.0` |
| 部署说明 | `deploy/docker-compose.yml`、`deploy/.env.example`、`deploy/README-1PANEL.md` | 明确区分 HTTPS 回环反代与直接端口访问；默认值不替用户擅自关闭端口 |
| 新增回归 | `test/backend-server-runtime.test.js`、`test/frontend-ui-hardening.test.js` | 运行时 HTTP 契约、自托管资源、CSP、WCAG 和响应式源码契约 |

提交前至少再次执行：

```powershell
npm.cmd test
npm.cmd audit --omit=dev --audit-level=high
npm.cmd run test:live  # 在没有 live 参数时应失败，这是预期门禁
git diff --check
```
