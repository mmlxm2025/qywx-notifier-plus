# 安全事件处置记录：管理凭据泄露

> 事件编号：SEC-INCIDENT-2026-07-04  
> 发现日期：2026-07-04  
> 处置状态：代码侧 + Git 历史已清除；服务器侧密码轮换待负责人执行  
> 关联复验文档：`docs/superpowers/specs/2026-07-04-multi-app-management-third-fix-review-ai-execution-guide.md` §3 P0-01

## ⚠️ 本文档原则

本文档**不记录任何已泄露凭据的真实值**。所有凭据以类别（密码/用户名/域名）描述。
日志、提交信息、报告与 AI 对话同样禁止复述这些值。

---

## 1. 事件概述

`test/live-server-contract.test.js` 的文件头注释在「用法示例」中写入了真实部署实例的：
- 管理员密码（明文）
- 管理员用户名
- 部署域名

该内容随提交进入 Git 跟踪，并一度存在于多个提交版本中。

## 2. 泄露范围（经 git log -S 全历史扫描确认）

### 真实秘密（密码 + 用户名）
- **涉及文件**：`test/live-server-contract.test.js`
- **涉及提交**：1 个（首次引入该测试文件的提交）
- **远程状态**：**从未推送到 GitHub**（仅存在于本地 `feature/multi-app` 分支，`origin/main` 之后）
- **结论**：密码与用户名从未离开本地仓库

### 部署域名（测试环境描述，非秘密凭据）
- **涉及文件**：`test/live-server-contract.test.js`、`docs/QA_TEST_REPORT_2026-07-04.md`、`docs/RELEASE_QA_REPORT_2026-07-04.md`
- **涉及提交**：3 个
- **远程状态**：曾推送到 `origin/dev`（GitHub）。密码/用户名未进入 `origin/dev` 或 `origin/main`

## 3. 处置措施

### 3.1 代码侧（已完成）
- `test/live-server-contract.test.js`：删除注释中的真实值，改为纯占位符说明，并增加安全说明指向本记录。
- `docs/QA_TEST_REPORT_2026-07-04.md`、`docs/RELEASE_QA_REPORT_2026-07-04.md`：部署域名改为通用占位符 `<test-instance>` / `隔离测试实例`。
- 新增 `scripts/scan-secrets.js`：扫描工作树与历史中的可疑凭据模式，输出仅报告文件:行与规则名，不回显秘密值。

### 3.2 Git 历史重写（已完成，负责人授权）
- **备份**：重写前创建备份分支（重写完成后已删除，含原始凭据的对象已通过 gc 清理）。
- **工具**：`git filter-branch --tree-filter`（`git filter-repo` 不可用）。
- **替换规则**：密码 → `REDACTED`；用户名 → `REDACTED`；域名 → `test-instance.example`。
- **重写范围**：
  - `feature/multi-app` 分支：`origin/main..HEAD`（29 个本地提交）
  - `dev` 分支：`origin/main..dev`（14 个提交）
- **清理**：
  - 删除 `refs/original/`（filter-branch 备份引用）
  - 删除 `refs/codex/turn-diffs/checkpoints/`（codex 检查点引用）
  - 删除 `refs/stash`（stash 引用旧对象）
  - `git reflog expire --expire=now --all`
  - `git gc --prune=now --aggressive`
- **远程同步**：`git push --force origin dev`（清除 GitHub `origin/dev` 上的域名残留）。

### 3.3 验证清除彻底（已完成）
- `git log --all --oneline -S <密码>`：空 ✓
- `git log --all --oneline -S <用户名>`：空 ✓
- `git log --all --oneline -S <域名>`：空 ✓
- 工作树 `grep`：无残留 ✓
- `git fsck --unreachable`：无悬空对象 ✓
- 所有 blob `git cat-file` 扫描：无凭据 ✓
- `node scripts/scan-secrets.js`：无命中 ✓

### 3.4 服务器侧（待负责人执行）
**以下步骤需仓库/服务器负责人本人操作，AI 不执行：**

1. **轮换管理员密码**：修改 `ADMIN_PASSWORD` 环境变量为新的强密码；重启服务使 `passwordVersion` 递增，所有旧会话失效。
2. **核查访问日志**：从凭据首次提交时间起，排查管理接口的异常登录、配置修改、密钥轮换、规则变化与删除操作。
3. **评估镜像/备份**：确认是否有 Docker 镜像、数据库快照或备份包含旧凭据；如有，一并清理或轮换。
4. **GitHub 远程残留**：`origin/dev` 已强推重写。若其他协作者曾拉取旧 `dev`，需通知他们重新 clone（旧对象可能在他们的本地仓库中）。GitHub 的 reflog/fork 缓存可能仍保留旧提交一段时间，但无凭据（密码/用户名从未进入远程）。

## 4. 根因与预防

### 根因
测试文件作者在「用法示例」注释中直接写入了真实环境变量值，绕过了 `.gitignore` 对 `.env` 的保护。

### 预防措施
1. **`scripts/scan-secrets.js`**：扫描密码/Token/AESKey/私钥等模式，可接入 pre-commit 钩子与 CI。
2. **测试文件规范**：`test/live-server-contract.test.js` 头部明确标注「不得包含真实凭据」，只从进程环境读取。
3. **凭据管理**：真实凭据只通过环境变量或受控密钥系统注入，不写入任何源码/注释/文档。

## 5. 验收清单

- [x] 当前源码不含真实凭据（`node scripts/scan-secrets.js` 通过）
- [x] 本地全历史不含凭据（`git log --all -S` 全空）
- [x] 远程 `origin/dev` 历史不含域名残留（强推后确认）
- [x] 悬空对象已清理（`git fsck` 无 unreachable）
- [x] 新增敏感扫描脚本
- [ ] 服务器密码已轮换、旧会话已失效（待负责人执行）
- [ ] 访问日志核查完成（待负责人执行）

## 6. 影响评估

- **密码 + 用户名**：从未推送到远程，泄露仅限本地。轮换密码后风险消除。
- **部署域名**：曾推送 `origin/dev`。域名本身不是秘密（DNS 可解析），但与凭据关联。已通过强推清除。强推后 GitHub 历史 URL 中的旧提交短期内可能仍可访问（GitHub 缓存），但不含密码/用户名。
- **数据完整性**：凭据泄露期间，任何掌握凭据者可登录管理后台。需通过日志核查确认是否有未授权操作。
