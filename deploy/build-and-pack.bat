@echo off
REM =====================================================================
REM 企业微信通知转发服务 - 构建镜像并打包脚本（Windows / 本机构建机）
REM
REM 用途：按 package.json 版本 + Git 短提交生成可追溯镜像并打包。
REM
REM 用法：双击运行，或在命令行执行  build-and-pack.bat
REM =====================================================================
setlocal enabledelayedexpansion

set IMAGE_NAME=qywx-notifier-plus
cd /d "%~dp0\.."

for /f %%i in ('node -p "require('./package.json').version"') do set PACKAGE_VERSION=%%i
for /f %%i in ('git rev-parse HEAD') do set VCS_REF=%%i
for /f %%i in ('git rev-parse --short^=7 HEAD') do set SHORT_REF=%%i
set IMAGE_TAG=%PACKAGE_VERSION%-%SHORT_REF%
set ARCHIVE_NAME=qywx-notifier-plus-%IMAGE_TAG%.tar.gz

echo.
echo [1/4] 检查 Docker ...
docker info >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Docker，请先安装并启动 Docker Desktop。
    exit /b 1
)

echo.
echo [2/4] 构建镜像 %IMAGE_NAME%:%IMAGE_TAG% ...
docker build --build-arg VCS_REF=%VCS_REF% --build-arg APP_VERSION=%PACKAGE_VERSION% -t %IMAGE_NAME%:%IMAGE_TAG% .
if errorlevel 1 (
    echo [错误] 镜像构建失败。
    exit /b 1
)

echo.
echo [3/4] 打包镜像为 %ARCHIVE_NAME% ...
if exist "deploy\%ARCHIVE_NAME%" del "deploy\%ARCHIVE_NAME%"
docker save %IMAGE_NAME%:%IMAGE_TAG% | gzip > "deploy\%ARCHIVE_NAME%"
if errorlevel 1 (
    echo [错误] 镜像打包失败。
    exit /b 1
)
> "deploy\IMAGE_TAG" echo %IMAGE_TAG%

echo.
echo [4/4] 完成！产物清单：
echo     deploy\%ARCHIVE_NAME%
echo     deploy\IMAGE_TAG
echo     deploy\docker-compose.yml
echo     deploy\.env.example
echo     deploy\import-load.sh
echo     deploy\README-1PANEL.md
echo.
echo 下一步：把这 5 个文件上传到 1Panel 服务器同一目录，
echo         按 README-1PANEL.md 操作即可。
endlocal
