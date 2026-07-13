# qywx-notifier-plus 新手部署指南（1Panel / Docker）

本文适合第一次使用 Docker 或 1Panel 的用户。推荐直接拉取 GitHub Container Registry 中的公开镜像，无需下载源码，也无需自己构建镜像。

镜像地址：`ghcr.io/mmlxm2025/qywx-notifier-plus:latest`

> `.env` 保存管理员密码和数据加密密钥，不能上传到 GitHub、发到群里或截图公开。数据库保存在 Docker 命名卷中，更新或重建容器不会自动丢失数据。

## 一、部署前准备

请先确认：

- 已安装 1Panel，并在 1Panel 的「容器」页面安装了 Docker。
- 服务器能够访问 `ghcr.io`。
- 知道服务器公网 IP；若只在内网使用，也可以使用内网 IP。
- 已决定访问方式：推荐使用 1Panel HTTPS 反向代理；仅在可信网络临时使用时才直接开放应用端口。

在 1Panel 左侧打开「终端」，或通过 SSH 登录服务器，然后运行：

```bash
docker --version
docker compose version
```

两条命令都能显示版本号即可继续。

## 二、推荐部署：五步完成

### 第 1 步：创建部署目录并下载配置文件

下面命令可以整段复制到服务器终端执行：

```bash
mkdir -p /opt/qywx-notifier-plus
cd /opt/qywx-notifier-plus

curl -fsSL https://raw.githubusercontent.com/mmlxm2025/qywx-notifier-plus/main/deploy/docker-compose.yml \
  -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/mmlxm2025/qywx-notifier-plus/main/deploy/.env.example \
  -o .env.example

ls -la
```

最后应当看到 `docker-compose.yml` 和 `.env.example` 两个文件。

如果服务器没有 `curl`，也可以在 1Panel「文件」页面创建 `/opt/qywx-notifier-plus` 目录，然后从本仓库的 `deploy/` 目录下载并上传这两个文件。

### 第 2 步：创建并修改 `.env`

先复制模板，注意目标文件名前面有一个点：

```bash
cd /opt/qywx-notifier-plus
cp .env.example .env
```

分别生成加密密钥和管理员密码：

```bash
# 第一个结果用于 ENCRYPTION_KEY，必须正好是 32 个字符
openssl rand -hex 32

# 第二个结果用于 ADMIN_PASSWORD，可直接使用这个随机强密码
openssl rand -hex 32
```

请把两次输出暂时复制到安全的位置，随后编辑文件：

```bash
nano .env
```

如果提示 `nano: command not found`，可改用 `vi .env`；也可以在 1Panel「文件」页面中打开 `.env` 编辑。若看不到 `.env`，请开启「显示隐藏文件」。

修改后的内容类似下面这样。示例值不能直接照抄，请替换成刚才生成的真实随机值：

```ini
# 推荐的同机 HTTPS 反代：应用端口只监听回环地址
HOST_BIND=127.0.0.1
HOST_PORT=12121

# 必须是 32 个字符；首次保存业务数据后不要再更换
ENCRYPTION_KEY=这里粘贴第一次生成的32位随机值

# 登录管理页面使用的账号和密码
ADMIN_USERNAME=admin
ADMIN_PASSWORD=这里粘贴第二次生成的随机强密码

# 企业微信官方 API 地址，通常不需要修改
WECHAT_API_BASE=https://qyapi.weixin.qq.com

# 仅当 HOST_BIND=127.0.0.1 且反代与应用在同机时使用 loopback
TRUST_PROXY=loopback
```

保存文件后，限制其他系统用户读取：

```bash
chmod 600 .env
```

各变量的作用：

| 变量 | 是否必改 | 说明 |
|------|----------|------|
| `HOST_BIND` | 按部署方式 | HTTPS 同机反代用 `127.0.0.1`；直接访问用 `0.0.0.0` |
| `HOST_PORT` | 按需 | 浏览器访问端口，默认 `12121`；端口被占用时可改成 `8080` 等 |
| `ENCRYPTION_KEY` | 必改 | 加密数据库中的企业微信密钥，必须为 32 个字符 |
| `ADMIN_USERNAME` | 建议修改 | 管理页面登录账号，默认 `admin` |
| `ADMIN_PASSWORD` | 必改 | 管理页面登录密码，建议使用上面生成的随机值 |
| `WECHAT_API_BASE` | 不改 | 企业微信 API 地址 |
| `TRUST_PROXY` | 按部署方式 | 回环反代用 `loopback`；端口可被客户端直连时必须为 `false` |

重要提醒：

- `ENCRYPTION_KEY` 和 `ADMIN_PASSWORD` 不是企业微信后台的 CorpSecret。
- `ENCRYPTION_KEY` 在产生业务数据后不能更换，否则已有企业微信密钥将无法解密。
- 不要在值的两边添加中文引号或多余空格。
- 自定义密码若包含 `$`、`#` 等符号，可能触发 Compose 解析；新手建议直接使用上述十六进制随机密码。

### 第 3 步：检查 `.env`

运行以下命令：

```bash
cd /opt/qywx-notifier-plus

key=$(sed -n 's/^ENCRYPTION_KEY=//p' .env)
if [ "${#key}" -eq 32 ]; then
  echo "ENCRYPTION_KEY 长度正确"
else
  echo "错误：ENCRYPTION_KEY 必须正好是 32 个字符，当前为 ${#key} 个"
fi

grep -q '^ADMIN_PASSWORD=change-this-to-a-strong-password$' .env \
  && echo "错误：ADMIN_PASSWORD 仍是模板值，请修改" \
  || echo "ADMIN_PASSWORD 已修改"

docker compose config --quiet && echo "Compose 配置检查通过"
```

必须同时看到：

- `ENCRYPTION_KEY 长度正确`
- `ADMIN_PASSWORD 已修改`
- `Compose 配置检查通过`

> 请使用 `docker compose config --quiet`。不要把不带 `--quiet` 的完整输出发给别人，因为其中可能显示已经解析的密码。

### 第 4 步：拉取镜像并启动

```bash
cd /opt/qywx-notifier-plus
docker compose pull
docker compose up -d
docker compose ps
```

首次拉取镜像需要一些时间。`docker compose ps` 中容器状态最终应显示为 `Up` 或 `healthy`。

查看启动日志：

```bash
docker compose logs --tail=100
```

持续查看日志可使用 `docker compose logs -f`，按 `Ctrl+C` 只会退出日志查看，不会停止服务。

### 第 5 步：配置访问入口

推荐方式是 HTTPS 反向代理：保持 `HOST_BIND=127.0.0.1`、`TRUST_PROXY=loopback`，不要在安全组或防火墙放行应用端口。在 1Panel「网站」中创建反向代理，代理地址填写 `http://127.0.0.1:12121`（若修改过 `HOST_PORT`，同步替换），然后为域名启用 HTTPS。浏览器只访问 `https://你的域名`。

仅在可信内网或临时调试时才直接访问端口：设置 `HOST_BIND=0.0.0.0`、`TRUST_PROXY=false`，并只向可信来源放行 `HOST_PORT`。不要通过公网明文 HTTP 登录或传递通知密钥。

使用 `.env` 中的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录。登录后再按页面提示填写企业微信的 CorpID、CorpSecret、AgentID、回调 Token 和 EncodingAESKey。

## 三、使用 1Panel 图形界面创建编排

完成上面的第 1～3 步后，也可以不用终端启动：

1. 打开 1Panel「容器」→「编排」。
2. 点击「创建编排」。
3. 名称填写 `qywx-notifier-plus`。
4. 编排目录填写 `/opt/qywx-notifier-plus`。
5. 选择使用已有的 `docker-compose.yml`；如果页面要求粘贴内容，就粘贴该文件内容。
6. 确认目录中同时存在 `.env`，然后点击创建或启动。
7. 在编排详情中确认容器状态为运行中。

如果 1Panel 提示 `ENCRYPTION_KEY` 或 `ADMIN_PASSWORD` 未设置，通常是编排目录填错、`.env` 没有创建，或文件实际被命名成了 `.env.txt`。

## 四、部署后检查

在 `/opt/qywx-notifier-plus` 目录运行：

```bash
# 查看容器状态
docker compose ps

# 查看健康状态
docker inspect --format='{{.State.Health.Status}}' qywx-notifier-plus

# 从服务器本机测试应用入口（HOST_PORT 修改后同步替换）
curl -I http://127.0.0.1:12121/login
```

若修改了 `HOST_PORT`，最后一条命令也要换成对应端口。

## 五、更新版本

GitHub 发布新镜像后运行：

```bash
cd /opt/qywx-notifier-plus
docker compose pull
docker compose up -d
docker image prune -f
```

更新不会删除命名卷中的数据库。更新前仍建议先备份。

## 六、修改端口、账号或密码

```bash
cd /opt/qywx-notifier-plus
nano .env
docker compose up -d
```

- 修改 `HOST_PORT` 后，需要同步调整安全组和防火墙。
- 修改 `ADMIN_PASSWORD` 后，使用新密码重新登录。
- 不要修改已经投入使用的 `ENCRYPTION_KEY`。

## 七、备份与恢复

数据库保存在命名卷 `qywx-notifier-plus-data` 中。

备份：

```bash
cd /opt/qywx-notifier-plus
docker run --rm \
  -v qywx-notifier-plus-data:/data \
  -v "$PWD":/backup \
  alpine tar czf /backup/qywx-data-$(date +%F).tar.gz -C /data .
```

恢复前先停止服务，并把备份文件名替换成实际文件名：

```bash
cd /opt/qywx-notifier-plus
docker compose down
docker run --rm \
  -v qywx-notifier-plus-data:/data \
  -v "$PWD":/backup \
  alpine tar xzf /backup/qywx-data-YYYY-MM-DD.tar.gz -C /data
docker compose up -d
```

## 八、常用命令

| 操作 | 命令 |
|------|------|
| 查看状态 | `docker compose ps` |
| 查看最近日志 | `docker compose logs --tail=100` |
| 持续查看日志 | `docker compose logs -f` |
| 重启 | `docker compose restart` |
| 重新读取 `.env` | `docker compose up -d` |
| 停止并删除容器 | `docker compose down` |
| 启动 | `docker compose up -d` |

## 九、常见问题

### 1. 提示 `ENCRYPTION_KEY` 或 `ADMIN_PASSWORD` 未设置

确认当前目录正确，并检查隐藏文件：

```bash
cd /opt/qywx-notifier-plus
pwd
ls -la
```

目录中必须同时存在 `.env` 和 `docker-compose.yml`。

### 2. 容器反复重启或显示 `unhealthy`

```bash
docker compose logs --tail=200
```

优先检查 `ENCRYPTION_KEY` 是否正好 32 个字符，以及 `.env` 中是否仍有 `change-this-...` 模板值。

### 3. 浏览器无法访问

依次检查：

1. `docker compose ps` 中容器是否运行。
2. `curl -I http://127.0.0.1:12121/login` 是否有响应。
3. HTTPS 反代模式下，1Panel 上游是否指向正确的 `127.0.0.1:HOST_PORT`，证书和域名是否生效。
4. 直接访问模式下，`HOST_BIND` 是否为 `0.0.0.0`，安全组和防火墙是否只向可信来源放行端口。
5. `TRUST_PROXY` 是否与访问方式匹配；公网可直连时必须为 `false`。

### 4. 无法从 `ghcr.io` 拉取镜像

确认服务器网络和 DNS 正常。若所在网络无法访问 GHCR，可参考下一节使用离线镜像包。

### 5. `docker compose` 命令不存在

较老环境可能使用 `docker-compose`。建议先在 1Panel 中升级 Docker Compose；临时情况下，可将文档中的 `docker compose` 替换为 `docker-compose`。

## 十、离线部署（仅 GHCR 无法访问时使用）

在一台能够运行 Docker 且可以访问 GitHub 的电脑上下载源码，然后执行：

```bash
chmod +x deploy/build-and-pack.sh
./deploy/build-and-pack.sh
```

Windows 可以运行 `deploy\build-and-pack.bat`。脚本会按 `package.json` 版本和 Git 短提交号生成镜像包，同时生成 `deploy/IMAGE_TAG`。将生成的 `qywx-notifier-plus-<版本>-<提交>.tar.gz`、`IMAGE_TAG`、`deploy/docker-compose.yml`、`deploy/.env.example`、`deploy/import-load.sh` 和本说明上传到服务器同一目录，然后执行：

```bash
cd /opt/qywx-notifier-plus
chmod +x import-load.sh
./import-load.sh
```

执行前仍需按照本文第 2 步创建并修改 `.env`。

## 十一、安全建议

- `.env` 权限保持为 `600`，不要提交到 Git 或公开分享。
- 对公网使用时，使用 `HOST_BIND=127.0.0.1`、`TRUST_PROXY=loopback`，并通过 1Panel 配置 HTTPS 反向代理。
- 只有可信内网或临时调试才使用 `HOST_BIND=0.0.0.0`；此时保持 `TRUST_PROXY=false`。
- 定期备份 `qywx-notifier-plus-data` 命名卷。
- 不要把日志、`.env`、数据库文件或带有企业微信凭据的截图发到公开 Issue。
