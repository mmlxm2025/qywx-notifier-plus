# 企业微信通知转发服务（qywx-notifier-plus）

类似 Server 酱的轻量级通知服务，通过企业微信应用消息把告警/通知推送到指定成员，并支持企业微信回调。

本版本面向个人使用或仅由一名管理员维护的场景，不包含多用户、角色权限或团队协作功能。

## 本版主要修改

- 增加管理员登录，避免管理页面直接暴露。
- 增加自定义 API 规则：每个 API 对应一组独立选择的通知对象。
- 支持按规则管理接收成员，并为规则生成独立的调用地址。
- 增加 GitHub Actions，自动测试并发布独立命名的 Docker 镜像。

## 快速开始

```bash
npm install
cp env.template .env   # 编辑 .env，至少修改 ENCRYPTION_KEY 和 ADMIN_PASSWORD
npm start              # 默认监听 12121
```

## 目录结构

```
server.js            # 入口
src/api/routes.js    # 路由
src/core/            # 加密、数据库、企业微信 API、回调
src/services/        # 业务编排
public/              # 前端页面
```

## 部署

推荐使用 Docker 部署。第一次部署请按 **[新手部署指南](deploy/README-1PANEL.md)** 操作，其中包含 `.env` 创建、随机密钥生成、1Panel 图形界面、更新、备份和常见问题说明。

镜像地址：`ghcr.io/mmlxm2025/qywx-notifier-plus:latest`

```bash
mkdir -p /opt/qywx-notifier-plus && cd /opt/qywx-notifier-plus
curl -fsSL https://raw.githubusercontent.com/mmlxm2025/qywx-notifier-plus/main/deploy/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/mmlxm2025/qywx-notifier-plus/main/deploy/.env.example -o .env.example
cp .env.example .env
# 按新手部署指南修改 .env 后再执行：
docker compose pull && docker compose up -d
```

推送到 `main` 分支或创建 `v*` 标签时，GitHub Actions 会自动运行测试、构建镜像并推送到 GitHub Container Registry。

核心流程：下载编排文件 → 创建并修改 `.env` → 拉取镜像 → 启动服务。无法访问 GHCR 时，再使用文档中的离线镜像方案。

镜像**不含任何配置 / 密码 / 数据**，所有敏感项通过环境变量（`.env`）注入，数据库通过卷持久化。

## 关键配置（环境变量）

| 变量 | 说明 | 是否必改 |
|------|------|---------|
| `ENCRYPTION_KEY` | 32 位字符串，加密数据库中的 corpsecret / EncodingAESKey | ✅ 必改 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 管理后台登录账号 | ✅ 必改 |
| `PORT` | 监听端口（默认 12121） | 否 |
| `DB_PATH` | 数据库路径（默认 ./database/notifier.db） | 否 |
| `WECHAT_API_BASE` | 企业微信 API 地址 | 否 |

> ⚠️ `ENCRYPTION_KEY` 一旦产生数据后不可更改，否则已加密数据无法解密。

## Fork 与致谢

本项目 Fork 自 [wangwangit/qywx-push](https://github.com/wangwangit/qywx-push)，感谢原作者“一只会飞的旺旺”公开并维护原项目。

当前版本在原项目基础上增加了登录、自定义 API 规则和自动发布镜像等功能。为避免与原作者发布的镜像混淆，本项目使用独立名称 `qywx-notifier-plus`。如需了解原始实现或获取上游更新，请访问原项目仓库。
