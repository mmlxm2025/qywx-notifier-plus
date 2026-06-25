# 企业微信通知转发服务（wechat-notifier）

类似 Server 酱的轻量级通知服务，通过企业微信应用消息把告警/通知推送到指定成员，并支持企业微信回调。

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

推荐使用 Docker 部署，详见 **[deploy/README-1PANEL.md](deploy/README-1PANEL.md)**。

核心流程：构建镜像 → 打包 tar.gz → 上传到 1Panel 服务器 → 导入镜像 → 创建「编排」。

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
