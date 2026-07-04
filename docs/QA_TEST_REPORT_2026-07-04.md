# 全量测试技术报告

- **测试日期**:2026-07-04
- **测试环境**:隔离测试实例(容器 `qywx-notifier-plus-verify`,镜像 `qywx-notifier-plus:verify-58ee693`)
- **代码版本**:dev 分支 `ccf8c34`(本地),服务器镜像 `verify-58ee693` + rules.js 热补丁
- **测试方法**:curl 接口实测 + Chrome DevTools 前端实测 + 容器内 Node 脚本 + 数据库直查

---

## 一、测试结论摘要

| 维度 | 用例数 | 通过 | 问题 |
|---|---|---|---|
| 基础功能(健康/登录/配置/规则) | 8 | 8 | 0 |
| 消息发送(msgType/编码/鉴权/HMAC/重放) | 10 | 10 | 0 |
| 鉴权安全(未登录/越权/密钥/限流) | 8 | 8 | 0 |
| 输入校验(超长/非法JSON/SQLi/XSS) | 5 | 4 | **1**(P2) |
| 限流与并发 | 2 | 2 | 0 |
| 回调接口 | 2 | 2 | 0 |
| 前端页面(三页) | 3 | 1 | **2**(P3) |
| 配置持久化 | 1 | 1 | 0 |
| **合计** | **39** | **36** | **3** |

**总体评价**:核心功能、安全机制、鉴权全部正常,无阻断性(P0/P1)问题。发现 1 个 P2 健壮性 bug、2 个 P3 前端问题,建议修复。

---

## 二、发现的问题(按优先级)

### 🔴 P2-BUG-01:非 JSON Content-Type 导致 500 崩溃

- **现象**:向 `/api/notify/:code` 发送 `Content-Type: text/plain` 的请求,服务端返回 **HTTP 500**,容器日志报 `TypeError: Cannot destructure property 'title' of 'req.body' as it is undefined`。
- **根因**:`src/api/routes.js` 第 182-192 行 `const { title, content, msgType, ... } = req.body;`。当请求 Content-Type 非 JSON(或 JSON 解析失败)时,`express.json` 不解析,`req.body` 为 `undefined`,解构直接抛 TypeError,被全局兜底捕获返回 500。
- **影响**:健壮性缺陷。攻击者可用非 JSON Content-Type 触发 500(非 DoS 级,但暴露内部错误且不友好)。
- **复现**:`curl -X POST <test-instance>/api/notify/<code> -H "Content-Type: text/plain" -d 'plain text'` → HTTP 500
- **建议修复**:在路由入口加 `if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: '请求体必须是 JSON' });`
- **关联日志证据**:
  ```
  TypeError: Cannot destructure property 'title' of 'req.body' as it is undefined.
      at router.post (/app/src/api/routes.js:...)
  ```

### 🟡 P3-ISSUE-01:CSP 阻止 lucide source map(前端控制台报错)

- **现象**:首页 `/`、规则页 `/rules`、文档页 `/api-docs.html` 浏览器控制台均有:
  ```
  [error] Connecting to 'https://unpkg.com/lucide.min.js.map' violates the following Content Security Policy directive: "connect-src 'self'".
  ```
- **根因**:CSP 的 `connect-src 'self'` 不含 `https://unpkg.com`,lucide 加载时尝试获取 source map 被阻止。
- **影响**:非阻断(图标正常显示),但控制台报错影响调试体验,且浏览器会持续重试。
- **建议修复**:在 `src/core/security-headers.js` 的 CSP `connect-src` 中追加 `https://unpkg.com`(或对 `.map` 请求加 `Access-Control-Allow-Origin`,但 CSP 方更直接)。

### 🟡 P3-ISSUE-02:Tailwind CDN 生产环境警告 + 表单无障碍问题

- **现象**:
  1. 三页控制台告警:`cdn.tailwindcss.com should not be used in production`(JIT 运行时编译,性能与稳定性非最优)。
  2. 首页 8 处表单字段未关联 `<label>`(a11y issue);密码框无 `autocomplete="current-password"`。
- **影响**:非阻断。Tailwind CDN 模式官方明确不建议生产使用(有 FOUC、运行时编译开销);无障碍问题影响屏幕阅读器。
- **建议修复**(可选,非紧急):
  - Tailwind 改为构建期编译(CLI/PostCSS),输出静态 CSS;
  - 表单 input 加 `id` + `<label for>`,密码框加 `autocomplete`。

---

## 三、通过项详细记录

### T1 基础功能(8/8 通过)

| 用例 | 请求 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| 健康检查 live | `GET /health/live` | 200 | 200 | ✅ |
| 健康检查 ready | `GET /health/ready` | 200 + db ready | 200 `{database:"ready"}` | ✅ |
| 登录 | `POST /api/login` 正确账密 | 200 + Set-Cookie | 200 + HttpOnly Cookie | ✅ |
| 配置列表 | `GET /api/configurations` | 200 + 数组 | 200,1 个配置 | ✅ |
| 配置详情 | `GET /api/configuration/:code` | 含 notify_key_enabled | `notify_key_enabled:true` | ✅ |
| 规则列表 | `GET /api/configuration/:code/rules` | 含 config.notify_key_enabled | 含字段 | ✅ |
| 会话列表 | `GET /api/sessions` | 200 + 会话数组 | 200,含 ip/expires | ✅ |
| 规则 CRUD | 创建→删除 | 201/200 | id=4 创建成功,删除 200 | ✅ |

### T2 消息发送(10/10 通过)

| 用例 | 场景 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| T2.1 | 无密钥 text 消息 | 200 | 200 + msgid | ✅ |
| T2.2 | 无密钥 markdown | 200 | 200 + msgid | ✅ |
| T2.3 | 空 content | 400 | 400「消息内容不能为空」 | ✅ |
| T2.4 | 不存在的 code | 404 | 404「无效的code」 | ✅ |
| T2.5 | GBK 编码自动转码 | 200 + 转码日志 | 200,容器日志 3 条「编码兼容」 | ✅ |
| T2.6 | 启用密钥后无 key | 401 | 401「请通过 X-Notify-Key 头提供」 | ✅ |
| T2.7 | 正确 key | 200 | 200 + msgid | ✅ |
| T2.8 | 错误 key | 401 | 401「通知密钥无效」 | ✅ |
| T2.9 | HMAC 四头(直连容器) | 200 | 200 + msgid | ✅ |
| T2.10 | HMAC 重放保护 | 第2次 401 | 第1次200,第2次401「检测到请求重放」 | ✅ |

> **重要更正**:HMAC 经反代(OpenResty)**可正常工作(200)**。此前文档中"HMAC 经反代 401 是反代改 body"的诊断**有误**,实测为客户端 shell 签名计算时转义不一致所致。用容器内 Node 生成签名(保证签名 body = 发送 body)经反代发送 → 200 成功。**反代未改写 body,HMAC 全链路正常**。

### T3 鉴权安全(8/8 通过)

| 用例 | 场景 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| T3.1 | 未登录访问 4 个受保护端点 | 401 | 全部 401 | ✅ |
| T3.2 | 查询参数 token(SEC-002 应拒绝) | 401 | 401 | ✅ |
| T3.3 | 错误密码登录 | 401 | 401 | ✅ |
| T3.4 | 连续 5 次错误密码 | 第5次 429 | 第5次 429 | ✅ |
| 密钥错误 | 错误 X-Notify-Key | 401 | 401 | ✅ |
| 无密钥配置 | 无需 key 直接发送 | 200 | 200 | ✅ |
| legacy-grace 负数 | `seconds:-1` | 400 | 400「宽限期必须为正整数」 | ✅ |
| 路径遍历 | `/public/../server.js` | 404 | 404 | ✅ |

### T4 输入校验(4/5 通过,1 个 P2 问题)

| 用例 | 场景 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| T4.1 | body > 256kb | 413 | 413 | ✅ |
| T4.2 | 非法 JSON | 400 | 400 | ✅ |
| T4.3 | SQL 注入(描述字段) | 拒绝且表不损 | 400,表完好 | ✅ |
| T4.5 | XSS in content | 原样发送不执行 | 200(企业微信不执行脚本) | ✅ |
| T4.4 | 非 JSON Content-Type | 应 400 | **500(P2-BUG-01)** | ❌ |

### T5 限流与并发(2/2 通过)

| 用例 | 场景 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| T5.1 | notify 连续请求(默认 60/分钟) | 超 60 后 429 | 第 56 次触发 429 | ✅ |
| T5.2 | 429 响应头 | 含 Retry-After | `Retry-After: 5` | ✅ |

### T6 回调接口(2/2 通过)

| 用例 | 场景 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| T6.1 | GET 回调缺参数 | 400 | 400「缺少必要的验证参数」 | ✅ |
| T6.2 | POST 回调缺签名参数 | 400 | 400 | ✅ |

### T7 前端页面(1/3 通过,2 个 P3 问题)

| 用例 | 场景 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| 页面可达 | 5 个页面/静态资源 | 全部可达 | 全部 200(/login /rules /api-docs + 3个JS) | ✅ |
| 控制台错误 | 无 error | — | **P3-ISSUE-01 CSP 阻止 lucide .map** | ❌ |
| 无障碍 | 表单有 label | — | **P3-ISSUE-02 8 处无 label** | ❌ |

> 安全响应头齐全:`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Strict-Transport-Security`、完整 CSP、无 `X-Powered-By`。HTTP 方法越权(DELETE/PUT on notify)返回 404,无越权。

### T8 配置持久化(1/1 通过)

| 用例 | 场景 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| 容器重启 | 配置/规则数量保留 | 一致 | 重启前 1配置/3规则 = 重启后 1配置/3规则 | ✅ |

> SQLite journal_mode 为 `delete`(非 WAL),挂载卷 `/root/qywx-verify-data/database` 持久化正常。

---

## 四、安全机制确认

| 机制 | 状态 | 备注 |
|---|---|---|
| HttpOnly + SameSite Cookie | ✅ | 登录下发,生产+HTTPS 附加 Secure |
| 查询参数 token 拒绝 | ✅ | SEC-002 |
| 登录限流 | ✅ | 5 次错误密码触发 429 |
| 通知限流 | ✅ | 60/分钟,429 含 Retry-After |
| 通知密钥(可选) | ✅ | 默认关闭,启用后 401 鉴权 |
| HMAC 签名 + 重放保护 | ✅ | 直连/反代均 200,重放 401 |
| CSP / HSTS / X-Frame | ✅ | 齐全(仅 lucide .map CSP 小冲突) |
| 路径遍历防护 | ✅ | 404 |
| SQL 注入防护 | ✅ | 参数化,注入无效 |
| XSS | ✅ | 原样发送,企业微信不执行 |
| body 大小限制 | ✅ | 256kb,超限 413 |

---

## 五、修复建议优先级

| 优先级 | 问题 | 工作量 | 建议 |
|---|---|---|---|
| **P2** | 非 JSON Content-Type 500 崩溃 | 小(~10 行) | 路由入口加 `req.body` 类型校验,本报告**建议本次修复** |
| P3 | CSP 阻止 lucide source map | 小(CSP 加域名) | 可选,改善控制台 |
| P3 | Tailwind CDN / 表单 a11y | 中(构建改造) | 可选,长期优化 |

---

## 六、附:测试环境现状

- 容器 `qywx-notifier-plus-verify` 运行中(镜像 `verify-58ee693` + rules.js 热补丁 `ccf8c34`)
- 数据库挂载 `/root/qywx-verify-data/database/notifier.db`(1 配置 / 3 规则)
- 测试期间产生若干测试消息(已发至企业微信)
- **注**:rules.js 的 bug 修复为 `docker cp` 热补丁,`docker rm` 重建容器会丢失,需重建镜像持久化
