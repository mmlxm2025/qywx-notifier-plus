# 企业微信通知转发服务 · 1Panel 编排部署指南

本指南指导你在 **1Panel** 中通过「编排」部署本服务。

> 镜像 **不含任何配置、密码、数据**：所有敏感项通过 `.env` 注入，数据库通过卷持久化。1Panel 服务器**无需源码、无需联网构建**。

---

## 一、交付物清单

构建产物全部在 `deploy/` 目录，需要一起上传到 1Panel 服务器：

| 文件 | 说明 | 必需 |
|------|------|------|
| `qywx-notifier-plus-1.0.0.tar.gz` | 打包好的 Docker 镜像 | ✅ |
| `docker-compose.yml` | 1Panel 编排文件（引用本地镜像） | ✅ |
| `.env.example` | 环境变量模板 | ✅ |
| `import-load.sh` | 一键导入+启动脚本（可选，命令行用） | 可选 |
| `README-1PANEL.md` | 本文档 | 可选 |

---

## 二、整体流程

```
[构建机] 构建+打包 tar.gz
        │ 上传
        ▼
[1Panel 服务器]  导入镜像 → 配置 .env → 创建编排 → 访问
```

---

## 三、第一步：构建并打包（在开发机/任意装了 Docker 的机器上）

> 已由开发者完成，产物为 `deploy/qywx-notifier-plus-1.0.0.tar.gz`。
> 如需自行重建，执行：

```bash
# Linux / macOS / WSL
chmod +x deploy/build-and-pack.sh
./deploy/build-and-pack.sh
```

或在 Windows 上双击 `deploy\build-and-pack.bat`。

产物：`deploy/qywx-notifier-plus-1.0.0.tar.gz`。

---

## 四、第二步：上传到 1Panel 服务器

把 `deploy/` 目录下的这些文件，上传到服务器**同一个目录**（建议放 `/opt/qywx-notifier-plus/`）：

- `qywx-notifier-plus-1.0.0.tar.gz`
- `docker-compose.yml`
- `.env.example`

---

## 五、第三步：导入镜像

### 方式 A：1Panel 界面导入（推荐，可视化）

1. 登录 1Panel → 左侧菜单 **「容器」→「镜像」**
2. 点击 **「导入镜像」**
3. 选择上传的 `qywx-notifier-plus-1.0.0.tar.gz`（或先解压成 `.tar`）
4. 确认导入，列表中出现 `qywx-notifier-plus:1.0.0` 即成功

### 方式 B：命令行导入

```bash
cd /opt/qywx-notifier-plus
gunzip -c qywx-notifier-plus-1.0.0.tar.gz | docker load
# 验证
docker images | grep qywx-notifier-plus
```

---

## 六、第四步：配置环境变量（重要！）

```bash
cd /opt/qywx-notifier-plus
cp .env.example .env
vi .env
```

**必须修改**这两项（其余按需）：

```ini
# 32 位随机字符串，用于加密数据库里的 corpsecret / EncodingAESKey
ENCRYPTION_KEY=<改成 32 位随机字符串>

# 管理后台登录密码
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<改成你自己的强密码>
```

生成 32 位随机字符串：

```bash
openssl rand -hex 16
```

> ⚠️ `ENCRYPTION_KEY` 一旦设定并产生数据后**不可再改**，否则已加密的密文无法解密。

---

## 七、第五步：在 1Panel 创建「编排」

1Panel 对「编排」本质上就是管理一个 docker-compose 项目。两种方式任选：

### 方式 A：界面创建编排（推荐）

1. 登录 1Panel → 左侧菜单 **「容器」→「编排」**
2. 点击 **「创建编排」**
3. 填写：
   - **名称**：`qywx-notifier-plus`
   - **编排目录**：填上传文件的目录，如 `/opt/qywx-notifier-plus`
   - **来源**：选择 **「使用已有编排文件」**（不要选"在线模板"）
4. 1Panel 会自动读取该目录下的 `docker-compose.yml`
5. 点击 **「确认」**，1Panel 自动 `docker compose up -d`

> 如果界面要求粘贴 yml：把 `docker-compose.yml` 内容粘贴进去即可，但要保证编排目录里仍有 `.env` 文件（变量从那里读）。

### 方式 B：命令行启动（最快）

```bash
cd /opt/qywx-notifier-plus
docker compose up -d
docker compose ps        # 查看状态
docker compose logs -f   # 看日志
```

启动成功会看到：
```
企业微信通知服务已启动，端口: 12121
```

---

## 八、访问与验证

浏览器打开：

```
http://<1Panel服务器IP>:<HOST_PORT>     # 默认 12121
```

- 首次会跳转到登录页，用 `.env` 里的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录
- 登录后按界面引导配置企业微信应用（两步配置流程）

**检查清单**：

```bash
# 1. 容器在运行
docker compose ps
# 2. 健康检查为 healthy
docker inspect --format='{{.State.Health.Status}}' qywx-notifier-plus
# 3. 端口可达
curl -I http://127.0.0.1:12121/login
```

---

## 九、常用运维操作

| 操作 | 命令 |
|------|------|
| 查看日志 | `docker compose logs -f` |
| 重启服务 | `docker compose restart` |
| 停止服务 | `docker compose down` |
| 更新镜像（新版） | 重新上传新 tar.gz → `docker load` → `docker compose up -d` |
| 修改配置/密码 | 编辑 `.env` → `docker compose up -d`（容器会重建以读取新值） |
| 进入容器排查 | `docker exec -it qywx-notifier-plus sh` |

### 数据备份与恢复

数据存在 Docker 命名卷 `qywx-notifier-plus-data`：

```bash
# 备份
docker run --rm -v qywx-notifier-plus-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/qywx-data-$(date +%F).tar.gz -C /data .

# 恢复（停服后）
docker run --rm -v qywx-notifier-plus-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/qywx-data-YYYY-MM-DD.tar.gz -C /data
```

---

## 十、常见问题

**Q1：编排启动后容器一直 `unhealthy` 或重启？**
→ 多半是 `.env` 里 `ENCRYPTION_KEY` 仍是占位符，或长度不对。确认是 32 位字符串。

**Q2：1Panel 界面看不到这个镜像？**
→ 默认直接拉取 `ghcr.io/mmlxm2025/qywx-notifier-plus:latest`；离线环境也可用 `docker load` 导入本地镜像。

**Q3：`docker compose` 命令不存在？**
→ 新版 Docker 已内置 `docker compose` 子命令；若 1Panel 用的是老版 docker-compose，改用 `docker-compose up -d`（带连字符）。

**Q4：想改端口？**
→ 编辑 `.env` 里的 `HOST_PORT`，例如 `HOST_PORT=8080`，然后 `docker compose up -d`。

**Q5：企业微信回调验证失败 / IP 白名单问题？**
→ 与镜像无关，属于应用配置。参考项目根目录 `MODIFICATIONS_SUMMARY.md` 的两步配置流程说明。

---

## 十一、安全建议

1. **务必修改** `ENCRYPTION_KEY` 与 `ADMIN_PASSWORD`，不要用模板默认值
2. 在 1Panel / 服务器防火墙只放行 `HOST_PORT`，必要时仅限内网
3. 生产环境建议前置 Nginx + HTTPS（1Panel 自带 OpenResty 可配置反向代理 + 证书）
4. `.env` 文件权限设为 `600`：`chmod 600 .env`，且**不要提交到 git**
5. 定期备份 `qywx-notifier-plus-data` 卷
