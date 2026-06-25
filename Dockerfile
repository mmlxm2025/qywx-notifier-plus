# syntax=docker/dockerfile:1
# =====================================================================
# 企业微信通知转发服务 - Dockerfile（多阶段构建）
#
# 设计目标：镜像内【不含任何配置 / 密码 / 数据】
#   - 运行时所有配置（ENCRYPTION_KEY、ADMIN_PASSWORD 等）通过环境变量注入
#   - 数据库文件不打包进镜像，由 volume 挂载到容器外持久化
#   - 构建阶段在独立 stage 完成依赖编译，最终镜像仅含生产依赖与源码
# =====================================================================

# ---------- 构建阶段：编译原生依赖（sqlite3 等）----------
FROM node:18-bookworm-slim AS builder

# 安装编译 sqlite3 原生模块所需的工具链（仅构建阶段需要）
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 国内 npm 镜像源，提升构建稳定性（如需公网源可删除此段）
RUN npm config set registry https://registry.npmmirror.com \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000

# 先复制 package 文件以利用 Docker 层缓存
COPY package.json package-lock.json* ./

# 仅安装生产依赖（排除 devDependencies 如 nodemon）
# sqlite3 需从源码编译以匹配运行时 glibc 版本
RUN npm ci --omit=dev --build-from-source=sqlite3 || \
    npm install --omit=dev --build-from-source=sqlite3

# ---------- 运行阶段：精简最终镜像 ----------
FROM node:18-bookworm-slim AS runtime

# 安装最小运行时依赖（sqlite3 动态库等），并清理 apt 缓存
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 从构建阶段复制已编译的生产依赖
COPY --from=builder /app/node_modules ./node_modules

# 复制应用源码（.dockerignore 已排除 database/.env/node_modules/test 等）
COPY package.json server.js ./
COPY src ./src
COPY public ./public

# 创建非 root 用户运行应用，提升安全性
RUN groupdir=$(getent group node | cut -d: -f1) >/dev/null 2>&1; \
    mkdir -p /app/database \
    && chown -R node:node /app

# 容器内固定监听端口（外部映射在 compose / 1Panel 中配置）
ENV NODE_ENV=production \
    PORT=12121 \
    DB_PATH=/app/database/notifier.db

EXPOSE 12121

# 健康检查：监听端口存活探测
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||12121)+'/login',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

# 使用 tini 作为 1 号进程，正确处理信号与僵尸进程
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
