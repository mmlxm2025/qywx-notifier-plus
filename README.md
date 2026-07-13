# 企业微信通知转发服务（qywx-notifier-plus）

类似 Server 酱的轻量级通知服务，通过企业微信应用消息把告警/通知推送到指定成员，并支持企业微信回调。

本版本面向个人使用或仅由一名管理员维护的场景，不包含多用户、角色权限或团队协作功能。

## 本版主要修改

- 增加管理员登录，避免管理页面直接暴露。
- 增加自定义 API 规则：每个 API 对应一组独立选择的通知对象。
- 支持按规则管理接收成员，并为规则生成独立的调用地址。
- 增加 GitHub Actions，自动测试并发布独立命名的 Docker 镜像。
- **多应用管理（2026-07-04）**：同一企业可接入多个不同 AgentID 的自建应用，按企业分组；新增应用总开关、事务级联删除、版本乐观锁（If-Match）、统一生命周期状态与稳定错误码。详见下方「多应用管理」。

## 多应用管理

一个应用 = 企业微信一个自建应用（企业 + AgentID + 凭证 + 默认接收人）。规则挂在应用下。

**管理页面**（登录后）：
- `/` 应用总览：按企业分组，显示状态（待完善/运行中/已暂停）、接收人数、规则数；行内总开关、删除预览。
- `/new` 新建向导：四步（回调 → 凭证 → 接收人 → 确认），支持草稿恢复。
- `/edit?code=` 编辑页：基本信息、企业凭证、回调、默认接收人、安全设置（Code 发送开关 / 通知密钥）。
- `/rules?code=` 接收规则：显示所属应用与状态。

**三层发送开关**（优先级从高到低）：
```
配置 Code：app_enabled AND code_send_enabled AND notify_auth_ok
规则 API ： app_enabled AND rule.enabled       AND notify_auth_ok
```
暂停应用（`app_enabled=false`）会拒绝配置 Code 与全部规则 API 的发送，但不影响编辑、规则管理与安全设置——便于修复后恢复。

**并发控制**：所有应用聚合写操作需携带 `If-Match: <version>` 头（版本来自列表/详情）。多页面同时编辑时，过期版本不会静默覆盖他人修改（`409 APP_VERSION_CONFLICT`）。

**兼容与回滚**：`app_enabled` / `version` 是加法列，旧代码可忽略并运行；但旧版本不会执行应用总开关与版本控制，回滚不是行为等价——回滚前应停止外部通知流量，或把需暂停应用的 Code/规则开关逐一关闭。详情接口不再返回回调 Token 明文（新 UI 不需要）。

完整 API 与错误码见应用内 `/api-docs.html` 的「应用管理 API」章节。

## 快速开始

> 运行环境要求：**Node.js 24 LTS** 与 **npm 11**（项目通过 `engines` 与 `.nvmrc` 声明）。不再推荐使用 Node 18/20/22 作为新部署环境。

```bash
npm install
cp env.template .env   # 编辑 .env，至少修改 ENCRYPTION_KEY 和 ADMIN_PASSWORD
npm start              # 默认监听 12121
```

## 目录结构

```
server.js            # 入口
src/api/routes.js    # 路由（含页面会话守卫）
src/core/            # 加密、数据库（含事务/级联删除）、企业微信 API、回调
src/services/        # 业务编排（notifier：多应用生命周期/序列化/总开关）
public/              # 前端页面（无构建步骤）
  index.html/script.js     # 应用总览
  wizard.html/wizard.js    # 新建向导
  edit.html/edit.js        # 应用编辑
  rules.html/rules.js      # 接收规则
  styles.css, http.js, topnav.js, components/  # 公共组件
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
