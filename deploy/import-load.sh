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
IMAGE_TAG="1.0.0"
ARCHIVE_NAME="${IMAGE_NAME}-${IMAGE_TAG}.tar.gz"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

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
docker tag "${IMAGE_NAME}:${IMAGE_TAG}" "${IMAGE_NAME}:${IMAGE_TAG}" 2>/dev/null || true
export IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
echo "已导入镜像："
docker images "${IMAGE_NAME}:${IMAGE_TAG}"

echo
echo "[3/4] 检查 .env 配置文件 ..."
if [ ! -f ".env" ]; then
  echo "[提示] 未发现 .env，正在从模板生成，请随后编辑真实配置。"
  cp -n .env.example .env
fi
# 校验关键变量是否仍为占位符
if grep -q "change-this-to-a-random-32-char-string" .env 2>/dev/null; then
  echo "[警告] .env 中 ENCRYPTION_KEY 仍是占位符，请务必修改为 32 位随机字符串！"
fi
if grep -q "change-this-to-a-strong-password" .env 2>/dev/null; then
  echo "[警告] .env 中 ADMIN_PASSWORD 仍是占位符，请务必修改！"
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
echo "部署完成。默认访问地址：http://<服务器IP>:<HOST_PORT>"
