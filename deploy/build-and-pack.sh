#!/usr/bin/env bash
# =====================================================================
# 企业微信通知转发服务 - 构建镜像并打包脚本（Linux / macOS / WSL 通用）
#
# 用途：生成 qywx-notifier:1.0.0 镜像，并打包为 tar.gz 供 1Panel 导入。
# 用法：chmod +x build-and-pack.sh && ./build-and-pack.sh
# =====================================================================
set -euo pipefail

# 镜像信息（改版本号请同步 docker-compose.yml 与 import-load.sh）
IMAGE_NAME="qywx-notifier"
IMAGE_TAG="1.0.0"
ARCHIVE_NAME="${IMAGE_NAME}-${IMAGE_TAG}.tar.gz"

# 切换到项目根目录（脚本位于 deploy/ 下）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo
echo "[1/4] 检查 Docker ..."
if ! docker info >/dev/null 2>&1; then
  echo "[错误] 未检测到 Docker，请先安装并启动 Docker。" >&2
  exit 1
fi

echo
echo "[2/4] 构建镜像 ${IMAGE_NAME}:${IMAGE_TAG} ..."
docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" .

echo
echo "[3/4] 打包镜像为 ${ARCHIVE_NAME} ..."
rm -f "deploy/${ARCHIVE_NAME}"
docker save "${IMAGE_NAME}:${IMAGE_TAG}" | gzip > "deploy/${ARCHIVE_NAME}"

echo
echo "[4/4] 完成！产物清单："
echo "    deploy/${ARCHIVE_NAME}"
echo "    deploy/docker-compose.yml"
echo "    deploy/.env.example"
echo "    deploy/import-load.sh"
echo "    deploy/README-1PANEL.md"
echo
echo "下一步：把这 5 个文件上传到 1Panel 服务器同一目录，按 README-1PANEL.md 操作即可。"
