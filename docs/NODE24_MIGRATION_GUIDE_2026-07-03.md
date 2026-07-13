# Node.js 24 迁移技术建议与 AI 执行指南

> 文档日期：2026-07-03  
> 适用项目：`qywx-notifier-plus`  
> 文档用途：指导下一位 AI 在不混入业务改动、不破坏现有数据的前提下，将 GitHub Actions、开发/测试环境和生产 Docker 镜像统一迁移到 Node.js 24 LTS。

## 1. 结论

建议迁移到 Node.js 24，但不要把“GitHub Action 自身运行在 Node 24”和“项目应用运行在 Node 24”混为一件事。

当前 GitHub 警告来自部分旧 Action 仍声明使用 Node 20；项目测试和生产镜像则仍主要运行 Node 22。推荐分三个阶段推进：

1. 先升级 dev 工作流中仍基于 Node 20 的 Action，并增加 Node 22/24 双版本测试。
2. 再把应用 CI、Docker 构建及运行镜像切到 Node 24，重建 `sqlite3` 原生模块。
3. dev 镜像稳定运行后，清理 Node 22/18 遗留入口并发布正式镜像。

本地已使用以下环境完成兼容性基线验证：

| 项目 | 结果 |
|---|---|
| Node.js | `v24.18.0` |
| npm | `11.16.0` |
| 自动化测试 | 89 项通过，0 失败 |
| `sqlite3` | `6.0.1`，声明要求 Node.js `>=20.17.0` |
| 结论 | 未发现阻止 Node 24 迁移的业务代码或依赖问题，但仍需验证 Docker 原生编译、已有数据库和线上回调链路 |

Node 20 已结束支持；Node 24 当前为 LTS。Node 22 仍在维护期，可作为短期回滚环境，但不应继续作为新部署的长期基线。参考：[Node.js 版本生命周期](https://nodejs.org/en/about/previous-releases)、[GitHub Actions Node 20 迁移说明](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/)。

## 2. 当前状态

### 2.1 版本入口

| 位置 | 当前状态 | 目标状态 | 处理优先级 |
|---|---|---|---|
| `.github/workflows/docker-publish.yml` | 项目测试使用 Node 22；Action 已是 Node 24 兼容主版本 | 项目测试改为 Node 24 | P1 |
| `.github/workflows/docker-publish-dev.yml` | 项目测试使用 Node 22；`checkout@v4`、`setup-node@v4`、`build-push-action@v6` 仍基于 Node 20 | 升级 Action，并将项目测试改为 Node 24 | P0 |
| `Dockerfile` builder | `node:22-bookworm-slim` | `node:24-bookworm-slim` | P1 |
| `Dockerfile` runtime | `node:22-bookworm-slim` | `node:24-bookworm-slim` | P1 |
| `Dockerfile.alternative` | `node:18`，且端口/安全配置已落后 | 推荐删除；若必须保留则按主 Dockerfile 同步到 Node 24 | P1 |
| `package.json` | 未声明 `engines` | 明确 Node 24/npm 11 支持范围 | P1 |
| 本地版本文件 | 无 `.nvmrc` / `.node-version` | 新增 `.nvmrc`，内容为 `24` | P2 |
| README | 未明确 Node 版本 | 写明 Node 24 LTS、npm 11 | P2 |

### 2.2 依赖与兼容风险

- `sqlite3@6.0.1` 是当前最重要的原生依赖。Dockerfile 已使用 `--build-from-source=sqlite3`，切换 Node 24 后必须在 Node 24 builder 阶段重新编译，禁止把 Node 22 的 `node_modules` 直接复制到 Node 24 镜像。
- `wxcrypt@1.4.3` 涉及企业微信回调加解密。虽然现有测试在 Node 24 下通过，仍应执行真实格式的签名、解密、重放和幂等回归测试。
- Node 24 使用更新的 V8、OpenSSL 和 TLS 默认实现。必须复核企业微信 API HTTPS 请求、AES/HMAC 加密和证书链，不应只以单元测试作为上线依据。
- npm 主版本变化可能改写 `package-lock.json`。迁移期间不得顺便升级业务依赖，避免把“运行时迁移”和“依赖升级”混成一个不可回滚的改动。

## 3. 迁移原则

下一位 AI 必须遵守以下约束：

1. 迁移分支只处理 Node/Action/Docker/说明文档，不修改认证、通知、回调、数据库表结构等业务逻辑。
2. 不执行 `npm update`，不主动改变依赖版本；只允许为同步根项目元数据而更新 lockfile。
3. 不删除或覆盖 `database/`，不修改 `.env` 中的真实密钥，不旋转 `ENCRYPTION_KEY`。
4. 不复用旧版原生模块产物；Node 24 环境必须执行一次干净的 `npm ci` 或 Docker 全量构建。
5. 先发布 `dev`/SHA 镜像验证，再更新 `latest`。保留上一版 Node 22 镜像摘要，用于快速回滚。
6. 若工作区已有无关改动，必须保留并避开；不得使用 `git reset --hard` 或覆盖用户修改。

## 4. 推荐实施步骤

### 阶段 A：消除 GitHub Action 的 Node 20 警告

修改 `.github/workflows/docker-publish-dev.yml`：

```yaml
- uses: actions/checkout@v7

- uses: actions/setup-node@v6
  with:
    node-version: 22
    cache: npm

- uses: docker/build-push-action@v7
```

此阶段暂时保留 `node-version: 22`，目的是先单独验证 Action 升级，避免同时改变 Action 运行时和应用运行时。

保持以下已升级组件不变：

```yaml
docker/setup-buildx-action@v4
docker/login-action@v4
docker/metadata-action@v6
```

验收条件：

- dev 工作流不再出现 “Node.js 20 is deprecated” 警告。
- `npm ci`、测试、依赖审计、Docker 构建和 GHCR 推送全部成功。
- 如果使用 GitHub 自托管 Runner，其版本必须不低于 `v2.327.1`；当前 `ubuntu-latest` 托管 Runner 无需单独处理。
- 不得设置 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true`，该配置只会临时掩盖问题。

### 阶段 B：增加 Node 22/24 双版本兼容门禁

在正式切换前，将 main 和 dev 工作流的测试 job 临时改为矩阵：

```yaml
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        node-version: [22, 24]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm
      - run: node --version
      - run: npm --version
      - run: npm ci
      - run: npm test
```

注意事项：

- 生产依赖审计可以只在 Node 24 任务执行，避免重复：`if: matrix.node-version == 24`。
- Docker job 应继续 `needs: test`，确保 Node 22 和 Node 24 两组测试全部通过后才构建镜像。
- 双版本门禁建议保留到 Node 24 dev 镜像完成一次实际部署验证后，再收敛为 Node 24 单版本。

### 阶段 C：声明项目运行时要求

在 `package.json` 增加：

```json
"engines": {
  "node": ">=24 <25",
  "npm": ">=11 <12"
}
```

同时新增 `.nvmrc`：

```text
24
```

随后使用 Node 24/npm 11 同步 lockfile：

```powershell
npm install --package-lock-only --ignore-scripts
```

AI 必须检查 `package-lock.json` 差异：

- 允许：根项目版本、`engines`、lockfile 根元数据同步。
- 不允许：无关依赖发生大面积版本漂移。
- 当前 `package.json` 是 `2.0.0-dev`，而 lockfile 根项目仍显示 `1.0.0`；本次可一并同步为 `2.0.0-dev`，但不要修改实际依赖范围。

同时修改 README 的本地运行前提：Node.js 24 LTS、npm 11。不要在文档中继续推荐 Node 18/20/22 作为新安装环境。

### 阶段 D：切换 Docker builder 与 runtime

将主 `Dockerfile` 中两处基础镜像统一修改为：

```dockerfile
FROM node:24-bookworm-slim AS builder
...
FROM node:24-bookworm-slim AS runtime
```

必须保留以下安全和构建设计：

- builder/runtime 两阶段构建。
- builder 中安装 `python3 make g++`。
- `npm ci --omit=dev --build-from-source=sqlite3`。
- runtime 使用 `tini`。
- runtime 最终保持 `USER node`。
- 健康检查继续访问 `/health/ready`。
- 数据库路径继续使用 `/app/database/notifier.db`，不得改变卷挂载位置。

构建时应拉取最新 Node 24 基础镜像补丁：

```powershell
docker build --pull --no-cache -t qywx-notifier-plus:node24-test .
```

如果生产策略要求镜像摘要固定，可将基础镜像固定到 digest，但必须同时配置 Dependabot/Renovate 定期更新 digest，不能永久停留在旧安全补丁。

### 阶段 E：处理 `Dockerfile.alternative`

首选方案是删除 `Dockerfile.alternative`，原因如下：

- 仍使用已停止支持的 Node 18。
- 使用 `npm install` 而不是可复现的 `npm ci`。
- 未采用非 root 用户。
- 暴露端口 3000，与当前服务端口 12121 不一致。
- 会给后续维护者提供一条不安全、不可复现的错误部署路径。

如果外部流程确认仍依赖该文件，则不能直接删除，必须将其改造成与主 Dockerfile等价的 Node 24 安全版本，并补充独立构建测试。

### 阶段 F：收敛 CI 到 Node 24

完成 dev 部署验证后：

- main/dev 工作流的 `node-version` 均改为 `24`。
- 删除临时 Node 22 测试矩阵。
- 保持所有 Action 为 Node 24 兼容主版本。
- 不要把应用的 `node-version: 24` 误认为 Action 自身版本已经安全；两者仍需分别维护。

目标工作流核心配置：

```yaml
- uses: actions/checkout@v7
- uses: actions/setup-node@v6
  with:
    node-version: 24
    cache: npm
- uses: docker/setup-buildx-action@v4
- uses: docker/login-action@v4
- uses: docker/metadata-action@v6
- uses: docker/build-push-action@v7
```

## 5. 验证清单

### 5.1 本地与 CI 验证

必须全部通过：

```powershell
node --version
npm --version
npm ci
npm test
npm audit --omit=dev
```

预期：

- Node 输出 `v24.x.x`。
- npm 输出 `11.x.x`。
- 测试不少于当前基线 89 项，0 失败。
- 生产依赖无 high/critical 漏洞；若审计策略要求零漏洞，则按更严格标准执行。

还需执行所有 JavaScript 文件语法检查，并确认没有 Node 24 弃用警告。若出现警告，必须定位到具体依赖或调用点，不能用环境变量静默屏蔽。

### 5.2 Docker 验证

```powershell
docker build --pull --no-cache -t qywx-notifier-plus:node24-test .
docker run --rm --entrypoint node qywx-notifier-plus:node24-test --version
docker run --rm --entrypoint npm qywx-notifier-plus:node24-test --version
docker run --rm --entrypoint id qywx-notifier-plus:node24-test
```

预期：

- 镜像内部 Node 为 `v24.x.x`。
- npm 为 `11.x.x`。
- 运行用户不是 root，应为 `node` 用户对应 UID/GID。

使用测试环境变量和临时数据库启动容器后，验证：

- `/health/live` 返回成功。
- `/health/ready` 返回成功。
- 登录页、管理页和 API 文档能正常加载。
- 容器收到停止信号后能正常退出，无 SQLite 损坏或未关闭句柄。

### 5.3 数据与业务回归

禁止直接拿生产数据库做首次验证。应先备份并复制数据库到隔离环境：

1. 使用 Node 22 旧镜像读取数据库，记录配置数量、规则数量和健康状态。
2. 停止旧容器，对数据库文件和相关 WAL/SHM 文件做一致性备份。
3. 使用 Node 24 测试镜像挂载数据库副本。
4. 验证数据库初始化、迁移、配置读取和规则读取无异常。
5. 重启 Node 24 容器，再次验证数据持久性。
6. 使用测试企业微信应用验证 access token 获取、文本通知、回调验签/解密和重复回调幂等。

不得在迁移验证中向真实生产成员批量发送消息。

重点回归场景：

- AES-GCM 新密文读取及旧 CBC 密文兼容迁移。
- 企业微信回调 XML 解析、签名校验、AES 解密、重放保护。
- 通知接口 API Key/HMAC 校验。
- `sqlite3` 读写、事务、WAL、并发请求和优雅关闭。
- HTTPS/TLS 请求企业微信 API。
- Docker 健康检查、非 root 权限和数据库卷写权限。

## 6. 发布与观察

推荐发布顺序：

1. 推送 dev 分支，生成 `dev` 和 `dev-sha-*` 镜像。
2. 在测试环境明确使用不可变 SHA 标签，不直接使用浮动 `dev` 标签作为回滚依据。
3. 观察至少一个完整业务周期，最低建议 24 小时。
4. 检查启动失败、进程退出、SQLite 锁、通知失败、回调失败、HTTP 超时和内存增长。
5. 验证通过后合并 main，发布新的 `sha-*` 镜像，再更新 `latest`。
6. 记录 Node 22 最后一个正常镜像 digest，保留到 Node 24 稳定运行至少一个发布周期。

建议记录以下观测指标：

- 容器重启次数与退出码。
- `/health/ready` 失败次数。
- 企业微信 token 获取失败率。
- 通知成功率、429 和 5xx 数量。
- 回调验签/解密失败率及重复消息数量。
- SQLite `BUSY`/锁错误。
- RSS 内存、CPU 和事件循环延迟。

## 7. 回滚方案

触发回滚的情况包括：

- Node 24 镜像无法启动或健康检查持续失败。
- `sqlite3` 原生模块加载失败、数据库无法写入或出现异常锁竞争。
- 企业微信 HTTPS、加解密、通知或回调链路出现 Node 22 环境中不存在的错误。
- 错误率、内存或 CPU 明显高于旧版本。

回滚步骤：

1. 停止 Node 24 容器，避免两个版本同时写同一个 SQLite 数据库。
2. 将部署镜像切回已记录的 Node 22 SHA/digest，不使用不确定的 `latest`。
3. 挂载原数据卷并启动单个旧容器。
4. 检查 `/health/ready`、数据库完整性、配置与规则数量。
5. 记录 Node 24 日志和镜像摘要，定位问题后再重试迁移。

本次迁移不得夹带数据库 schema 或密文格式变更。只要遵守这一约束，回滚通常不需要还原数据库；如部署期间应用自动执行了其他迁移，则必须按该迁移自己的备份方案处理，不能假定旧镜像一定可读取新 schema。

## 8. 风险矩阵

| 风险 | 概率 | 影响 | 控制措施 |
|---|---:|---:|---|
| Action 仍引用 Node 20 | 高 | 中 | 升级 dev 的 checkout/setup-node/build-push，检查 GitHub 日志无警告 |
| `sqlite3` ABI/编译失败 | 中 | 高 | Node 24 builder 中干净重编译；禁止复制 Node 22 模块；执行数据库回归 |
| npm 11 导致 lockfile 大面积漂移 | 中 | 中 | 禁止 `npm update`；只同步根元数据；人工检查 diff |
| OpenSSL/TLS 行为变化 | 低到中 | 高 | 测试企业微信 HTTPS、AES、HMAC、回调签名和解密 |
| 旧 Dockerfile 被误用 | 中 | 高 | 删除或彻底升级 `Dockerfile.alternative` |
| 数据卷权限变化 | 低 | 高 | 保持 `USER node`、验证挂载卷写权限和重启持久性 |
| 浮动镜像标签无法回滚 | 中 | 高 | 发布和部署均记录 SHA/digest |
| 迁移 PR 混入业务/数据库变更 | 中 | 高 | 缩小变更范围，分阶段提交，逐文件复核 |

## 9. 下一位 AI 的具体任务单

按顺序执行，任一步失败都应停止推进并报告原因：

- [ ] 查看 `git status`，确认并保留用户已有修改。
- [ ] 升级 dev 工作流的 `checkout@v4`、`setup-node@v4`、`build-push-action@v6`。
- [ ] 为 main/dev 测试 job 临时增加 Node 22/24 矩阵。
- [ ] 在 Node 24 下执行干净的 `npm ci`、完整测试和生产依赖审计。
- [ ] 修改 `package.json` engines，新增 `.nvmrc`，同步并检查 lockfile。
- [ ] 将主 Dockerfile builder/runtime 切到 `node:24-bookworm-slim`。
- [ ] 删除或升级 `Dockerfile.alternative`；如果无法确认外部依赖，先报告，不可擅自删除。
- [ ] 构建无缓存 Node 24 镜像，确认 Node/npm 版本和非 root 用户。
- [ ] 使用数据库副本完成启动、重启、读写和健康检查。
- [ ] 完成通知、企业微信 API、回调验签/解密、重放保护的测试环境回归。
- [ ] 发布 dev SHA 镜像并观察。
- [ ] 验证稳定后把 CI 收敛为 Node 24 单版本，发布 main/正式 SHA 镜像。
- [ ] 更新 README 和部署说明中的 Node 版本要求。
- [ ] 输出迁移结果报告，列出实际镜像 digest、测试数量、审计结果、验证环境和遗留风险。

## 10. 完成标准（Definition of Done）

同时满足以下条件，才可判定 Node 24 迁移完成：

1. main/dev GitHub Actions 不再出现 Node 20 弃用或强制运行警告。
2. main/dev 项目测试均明确运行在 Node 24。
3. 主 Docker 镜像 builder/runtime 均为 Node 24，并从干净环境重建 `sqlite3`。
4. `package.json`、`.nvmrc`、CI、Dockerfile 和 README 对 Node 版本的描述一致。
5. 所有自动化测试通过，数量不少于当前 89 项。
6. 生产依赖审计符合项目安全门禁。
7. Node 24 镜像以非 root 用户运行，健康检查和数据卷读写正常。
8. 数据库副本、通知发送和企业微信回调链路完成验证。
9. dev 环境观察期无新增高风险异常。
10. 已记录正式 Node 24 镜像和可回滚 Node 22 镜像的不可变 SHA/digest。
11. 没有夹带无关依赖升级、业务逻辑或数据库 schema 变更。

## 11. 后续维护建议

- 配置 Dependabot 的 `github-actions` 和 npm 更新检查，Action 主版本升级需先在 dev 验证。
- 每周或每月至少重建一次镜像，以获取 Node 24 和 Debian 安全补丁。
- 在 CI 输出 `node --version` 与 `npm --version`，防止基础镜像或 Runner 变化悄悄改变构建环境。
- 对正式镜像记录 SBOM、provenance 和 digest；部署使用 digest 或不可变 SHA 标签。
- 在 Node 24 进入维护后期前制定下一 LTS 迁移计划，不再等到 GitHub 强制切换后被动处理。
