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
FROM node:24-bookworm-slim AS builder

ARG DEBIAN_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security

# 安装编译 sqlite3 原生模块所需的工具链（仅构建阶段需要）
RUN sed -i "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g; s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 国内 npm 镜像源，提升构建稳定性（如需公网源可删除此段）
RUN npm config set registry https://registry.npmmirror.com \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000

# 先复制 package 文件以利用 Docker 层缓存
COPY package.json package-lock.json* ./

# 安装锁文件中的完整依赖：前端构建需要 Tailwind/DaisyUI/Lucide 开发依赖。
# REV-012：先 npm ci --ignore-scripts 跳过所有 install 脚本
# （避免 npm 11 把 build-from-source 当 Unknown config 警告，npm 12 将移除该支持）；
# 再显式对 sqlite3 调用 node-gyp rebuild，在镜像内用本机工具链(python3/make/g++)
# 源码编译，保证 .node 与本镜像 glibc(2.36) ABI 一致（prebuild 二进制要求
# GLIBC_2.38，在 bookworm 上会 ERR_DLOPEN_FAILED）。
# SEC-004：禁止 npm ci 失败后静默回退到 npm install，保证可复现构建
RUN npm ci --ignore-scripts

# 构建完全自托管的前端静态资产，生产页面不再依赖 CDN 运行时。
COPY tailwind.config.js ./
COPY scripts/build-frontend.js ./scripts/
COPY src/styles ./src/styles
COPY public ./public

RUN npm run build:frontend \
    && cd node_modules/sqlite3 \
    && ../../node_modules/.bin/node-gyp rebuild \
    && cd /app \
    && npm prune --omit=dev --ignore-scripts

# ---------- 运行阶段：精简最终镜像 ----------
FROM node:24-bookworm-slim AS runtime

ARG VCS_REF=unknown
ARG APP_VERSION=2.0.0-dev
ARG DEBIAN_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security

LABEL org.opencontainers.image.source="https://github.com/mmlxm2025/qywx-notifier-plus" \
      org.opencontainers.image.title="qywx-notifier-plus" \
      org.opencontainers.image.description="企业微信通知转发服务" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${APP_VERSION}"

# 安装最小运行时依赖（sqlite3 动态库等），并清理 apt 缓存
RUN sed -i "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g; s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 从构建阶段复制已编译的生产依赖
COPY --from=builder /app/node_modules ./node_modules

# 复制应用源码（.dockerignore 已排除 database/.env/node_modules/test 等）
COPY package.json server.js ./
COPY src ./src
COPY --from=builder /app/public ./public

# 创建非 root 用户运行应用，提升安全性
RUN groupdir=$(getent group node | cut -d: -f1) >/dev/null 2>&1; \
    mkdir -p /app/database \
    && chown -R node:node /app

# 容器内固定监听端口（外部映射在 compose / 1Panel 中配置）
ENV NODE_ENV=production \
    PORT=12121 \
    DB_PATH=/app/database/notifier.db \
    APP_REVISION=${VCS_REF} \
    APP_VERSION=${APP_VERSION}

EXPOSE 12121

# 健康检查（SEC-007）：使用就绪探测 /health/ready，数据库不可用时返回 503 标记不健康。
# 仅接受 HTTP 200 为健康，避免 3xx/4xx 被误判为就绪。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||12121)+'/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# 使用 tini 作为 1 号进程，正确处理信号与僵尸进程
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
