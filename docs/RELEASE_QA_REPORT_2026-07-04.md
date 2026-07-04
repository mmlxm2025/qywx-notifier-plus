# 发布前全量回归测试报告

- **测试日期**:2026-07-04
- **测试环境**:隔离测试实例,容器 `qywx-notifier-plus-verify`(镜像 `qywx-notifier-plus:verify-24dcc53`)
- **代码版本**:dev 分支 `24dcc53`(含本次会话全部 6 个 commit)
- **测试方法**:curl 接口实测 + Chrome DevTools 前端实测 + 容器内 Node 脚本 + 数据库直查
- **镜像改动点校验**:6 个 commit 的关键改动在镜像内全部就位(P2 校验/CSP unpkg/GBK 转码/notify_key_enabled/rules.js 遮罩修复/index.html label)

---

## 一、发布结论

| 维度 | 用例 | 通过 | 失败 |
|---|---|---|---|
| T1 基础功能 | 6 | 6 | 0 |
| T2 消息发送(含 HMAC/重放) | 11 | 11 | 0 |
| T3 鉴权安全 | 5 | 5 | 0 |
| T4 输入校验(含 P2 回归) | 5 | 5 | 0 |
| T5 限流(notify + login) | 4 | 4 | 0 |
| T6 回调接口 | 2 | 2 | 0 |
| T7 前端三页(含 P3 回归) | 7 | 7 | 0 |
| T8 持久化 | 1 | 1 | 0 |
| **合计** | **41** | **41** | **0** |

### ✅ 发布判定:**通过**

所有功能、安全、健壮性、前端用例全部通过。本次会话修复的 P2(非 JSON 500)、P3-01(CSP)、P3-02(无障碍)回归确认有效。无阻断性问题,可发布。

---

## 二、关键回归项确认

### P2-BUG-01 回归 ✅
非 JSON Content-Type (`text/plain`) 发送 → **HTTP 400**「请求体必须是 JSON 格式」,不再 500 崩溃。

### P3-ISSUE-01 回归 ✅
前端三页(/login、/rules、/api-docs)浏览器控制台**无 CSP 违规报错**(原 lucide source map 被阻止的 error 消失)。CSP `connect-src` 现含 `https://unpkg.com`。

### P3-ISSUE-02 回归 ✅
login 页 2 个 input 有 `label[for]` 关联(`for="login-username"` / `for="login-password"`),密码框 `autocomplete="current-password"`。

### 通知密钥默认关闭 ✅
新配置/撤销密钥后 `notify_key_enabled: false`,无 key 可直接发送(200)。启用后无 key 401、正确 key 200、错误 key 401。

### GBK 编码自动转码 ✅
GBK body 经反代发送 → 200,容器日志「编码兼容」记录递增。

### HMAC 全链路 ✅
容器内 Node 生成签名(签名 body = 发送 body)经反代发送 → **200**(更正此前"反代改 body"的误诊)。重放保护:同 nonce 第 2 次 → **401**。

### rules 页密钥栏目交互 ✅
轮换密钥 → 明文框默认遮罩(48 个 `•`)→ 点「显示」露出真实 64 位密钥(按钮变「隐藏」)→ 「复制」可用。

---

## 三、测试明细

### T1 基础功能(6/6)

| 用例 | 预期 | 实际 |
|---|---|---|
| 健康检查 live/ready | 200 | 200 + `{database:"ready"}` |
| 登录 | 200 + Cookie | 200 + HttpOnly Cookie |
| 配置列表 | 200 | 200,1 配置 |
| 配置详情 | 含 notify_key_enabled | `notify_key_enabled:false` |
| 规则列表 | 含 config.notify_key_enabled | 含字段,3 规则 |
| 规则 CRUD(创建→删除) | 201/200 | id=5 创建,删除 200 |

### T2 消息发送(11/11)

| 用例 | 预期 | 实际 |
|---|---|---|
| 无密钥 text | 200 | 200 |
| 无密钥 markdown | 200 | 200 |
| 空 content | 400 | 400 |
| 不存在 code | 404 | 404 |
| GBK 编码转码 | 200 + 转码日志 | 200,日志 +4 |
| 启用密钥(返回 64 字符 key) | key 长度 64 | 64 |
| 无 key(401) | 401 | 401 |
| 正确 key(200) | 200 | 200 |
| 错误 key(401) | 401 | 401 |
| HMAC 经反代 | 200 | 200 |
| HMAC 重放(第2次) | 401 | 第1次200,第2次401 |

### T3 鉴权安全(5/5)

| 用例 | 预期 | 实际 |
|---|---|---|
| 未登录访问 4 端点 | 全 401 | 全 401 |
| 查询参数 token | 401 | 401 |
| 路径遍历 `/public/../server.js` | 404 | 404 |
| 密钥三态(无/正确/错误) | 401/200/401 | 401/200/401 |
| HMAC 重放 | 401 | 401 |

### T4 输入校验(5/5)

| 用例 | 预期 | 实际 |
|---|---|---|
| 超大 body(>256kb) | 413 | 413 |
| 非法 JSON | 400 | 400 |
| **非 JSON Content-Type(P2 回归)** | **400 非 500** | **400** |
| SQL 注入(表不损) | 拒绝,表完好 | 400,配置仍存在 |
| XSS in content | 原样发送 | 200 |

### T5 限流(4/4)

| 用例 | 预期 | 实际 |
|---|---|---|
| notify 限流(60/分钟) | 超 60 后 429 | 窗口累计触发 429 |
| notify 429 Retry-After | 含头 | 含 |
| login 限流(默认 10 次/5分钟) | 第 11 次 429 | 累计第 10 次触发 429 |
| login 429 Retry-After | 含头 | `Retry-After: 274` |

> 说明:login 限流默认阈值 `LOGIN_RATE_MAX=10`(非 5),代码与配置一致,非 bug。

### T6 回调接口(2/2)

| 用例 | 预期 | 实际 |
|---|---|---|
| GET 回调缺参 | 400 | 400 |
| POST 回调缺签名 | 400 | 400 |

### T7 前端三页(7/7)

| 用例 | 预期 | 实际 |
|---|---|---|
| 三页可达 | 200 | /login /rules /api-docs 全 200 |
| 三页 CSP 无报错(P3 回归) | 无 error | 仅 Tailwind CDN 警告 |
| 文档 #hmac 锚点 | 可达 + 四头 + curl 范例 | 锚点存在,四头齐全,openssl 范例 |
| rules 密钥栏目渲染 | 状态徽章 + 按钮 | 已启用 + 轮换/撤销 |
| 轮换后明文默认遮罩 | 48 个 • | `keyBoxMasked:true` |
| 显示/隐藏切换 | 切换明文 + 按钮变隐藏 | `keyBoxIsHex:true`(64位) |
| 复制按钮 | 存在 | 存在 |

### T8 持久化(1/1)

| 用例 | 预期 | 实际 |
|---|---|---|
| 容器重启数据保留 | 配置/规则/密钥一致 | 1配置/3规则/has_key 一致,健康 200 |

---

## 四、安全机制确认

| 机制 | 状态 |
|---|---|
| HttpOnly + SameSite Cookie(生产+HTTPS 加 Secure) | ✅ |
| 查询参数 token 拒绝 | ✅ |
| login 限流(10次/5分钟,429+Retry-After) | ✅ |
| notify 限流(60次/分钟,429+Retry-After) | ✅ |
| 通知密钥(默认关闭,可选启用) | ✅ |
| HMAC 签名 + nonce 重放保护 | ✅ |
| CSP / HSTS / X-Frame-Options / nosniff | ✅ |
| 路径遍历防护 | ✅ |
| SQL 注入防护(参数化) | ✅ |
| body 大小限制(256kb) | ✅ |
| 非 JSON Content-Type 健壮处理(400 非 500) | ✅ |

---

## 五、已知非阻断项(不影响发布)

| 项 | 说明 | 建议 |
|---|---|---|
| Tailwind CDN 生产警告 | 控制台 warn,官方不建议生产用 CDN JIT | 长期:改构建期编译 |
| login 限流默认 10 次 | 配置 `LOGIN_RATE_MAX=10`,非 bug | 如需更严可调环境变量 |

---

## 六、测试环境收尾

- 容器 `qywx-notifier-plus-verify` 运行中(镜像 `verify-24dcc53`,healthy)
- 测试副作用已清理:配置描述恢复"消息通知"、密钥撤销为默认关闭
- 数据库挂载 `/root/qywx-verify-data/database/notifier.db`(1 配置 / 3 规则)
- 镜像 `verify-24dcc53` 已持久化在服务器(不再依赖 docker cp 热补丁)

---

## 七、发布建议

**可发布**。dev 分支 `24dcc53` 通过全部 41 项回归测试,本次会话 6 个 commit 的改动(通知密钥默认关闭+UI 入口、GBK 转码、密钥移至 rules 页、明文遮罩、P2/P3 修复)在测试服务器验证无问题。

建议执行 `git push origin dev` 触发 GHCR CI,让服务器可按标准流程切换到 GHCR 镜像。
