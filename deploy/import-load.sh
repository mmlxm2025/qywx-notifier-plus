#!/usr/bin/env bash
# =====================================================================
# 企业微信通知转发服务 - 镜像导入与启动脚本（1Panel / Linux 服务器）
#
# 用途：在 1Panel 所在服务器上执行，
#       把 tar.gz 导入为本地镜像，并用 compose 启动服务。
# 用法：chmod +x import-load.sh && ./import-load.sh
#
# 前置：请先把上传的 tar.gz 放在与本脚本同目录，并先编辑好 .env 文件。
# =====================================================================
set -euo pipefail

IMAGE_NAME="qywx-notifier-plus"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f IMAGE_TAG ]; then
  echo "[错误] 缺少 IMAGE_TAG，无法确认镜像版本与归档名称。" >&2
  exit 1
fi
IMAGE_TAG="$(tr -d '\r\n[:space:]' < IMAGE_TAG)"
if [ -z "$IMAGE_TAG" ]; then
  echo "[错误] IMAGE_TAG 内容为空。" >&2
  exit 1
fi
ARCHIVE_NAME="${IMAGE_NAME}-${IMAGE_TAG}.tar.gz"

echo
echo "[1/4] 检查 Docker ..."
if ! docker info >/dev/null 2>&1; then
  echo "[错误] 未检测到 Docker / 1Panel 未安装 Docker。" >&2
  exit 1
fi

echo
echo "[2/4] 导入镜像 ${ARCHIVE_NAME} ..."
if [ ! -f "$ARCHIVE_NAME" ]; then
  echo "[错误] 未找到 ${ARCHIVE_NAME}，请确认已上传到本目录。" >&2
  exit 1
fi
gunzip -c "$ARCHIVE_NAME" | docker load
export IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
echo "已导入镜像："
docker images "${IMAGE_NAME}:${IMAGE_TAG}"

echo
echo "[3/4] 检查 .env 配置文件 ..."
if [ ! -f ".env" ]; then
  echo "[提示] 未发现 .env，正在从模板生成，请随后编辑真实配置。"
  cp -n .env.example .env
fi
# 校验关键变量是否仍为占位符（SEC-001：发现占位值必须退出，禁止带病启动）
PLACEHOLDER_ERROR=0
if grep -Eq "ENCRYPTION_KEY\s*=\s*(change-this-to-a-random-32-char-string|your-32-character-encryption-key-here|default-key-for-development-only)" .env 2>/dev/null; then
  echo "[错误] .env 中 ENCRYPTION_KEY 仍是占位符，请修改为 32 位随机字符串（推荐 openssl rand -hex 32）。"
  PLACEHOLDER_ERROR=1
fi
if grep -Eq "ADMIN_PASSWORD\s*=\s*(change-this-to-a-strong-password|your-secure-password)" .env 2>/dev/null; then
  echo "[错误] .env 中 ADMIN_PASSWORD 仍是占位符，请设置强密码。"
  PLACEHOLDER_ERROR=1
fi
if [ "$PLACEHOLDER_ERROR" -ne 0 ]; then
  echo "[错误] 检测到未修改的占位配置，拒绝启动。请编辑 .env 后重试。"
  exit 1
fi

echo
echo "[4/4] 启动编排 ..."
if docker compose version >/dev/null 2>&1; then
  docker compose up -d
  echo
  echo "------ 容器状态 ------"
  docker compose ps
  echo
  echo "------ 查看日志 ------"
  echo "  docker compose logs -f"
else
  echo "[提示] 当前环境无 docker compose 子命令。可在 1Panel 界面中导入本目录的"
  echo "       docker-compose.yml 创建编排（详见 README-1PANEL.md）。"
fi

echo
echo "部署完成。请按 README-1PANEL.md 选择 HTTPS 反代或直接端口访问方式。"
