// 企业微信通知转发服务 - 主入口文件

require('dotenv').config();
const express = require('express');
const path = require('path');
const routes = require('./src/api/routes');
const auth = require('./src/core/auth');
const config = require('./src/core/config');
const notifier = require('./src/services/notifier');
const { securityHeaders } = require('./src/core/security-headers');
const { LoginRateLimiter } = require('./src/core/rate-limit');
const { jsonBodyParser, bodyParserErrorHandler } = require('./src/core/body-parser');

// SEC-001：启动配置校验。除非显式跳过（本地开发），缺失/占位符即退出，禁止监听端口。
try {
    config.validateRuntime();
} catch (err) {
    console.error('[启动] ' + err.message);
    process.exit(1);
}

const app = express();
const PORT = config.raw.port;
const NODE_ENV = config.raw.nodeEnv;
const isProduction = NODE_ENV === 'production';

// REV-004：默认不信任任何代理，req.ip 反映真实连接来源；仅在明确部署于可信反代后
// 通过 TRUST_PROXY 配置（跳数或 CIDR）。这避免伪造 X-Forwarded-For 绕过限流。
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy === undefined || trustProxy === '' || trustProxy === '0' || trustProxy === 'false') {
    app.set('trust proxy', false);
} else {
    // 支持数字跳数或逗号分隔的 CIDR/网段
    const hops = Number.parseInt(trustProxy, 10);
    app.set('trust proxy', Number.isFinite(hops) ? hops : trustProxy.split(',').map(s => s.trim()));
}

// SEC-011：隐藏框架指纹 + 安全响应头，置于所有路由之前。
app.disable('x-powered-by');
app.use(securityHeaders);

// 通用 JSON / urlencoded 解析（带大小限制，防御资源耗尽）。
// jsonBodyParser 封装了 UTF-8 自动兼容：Windows CMD/PowerShell 的 curl 默认按 GBK 发送
// 中文，此处自动用 GB18030 转码为 UTF-8，避免消息乱码。同时捕获原始字节供 HMAC 校验。
app.use(...jsonBodyParser({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

// SEC-013：回调接口原始 body，限制 Content-Type 白名单与大小上限。
const CALLBACK_MAX = Number(process.env.CALLBACK_MAX_BODY_BYTES || 102400);
app.use('/api/callback', express.raw({
    type: ['text/xml', 'application/xml', 'text/plain'],
    limit: CALLBACK_MAX
}));

// 多应用（第三轮复验 P1-03）：parser 错误统一处理器，覆盖 json/urlencoded/raw 全部 parser。
// 必须放在所有 parser 之后、路由之前，才能接住任意 parser 抛出的 400/413。
// 旧实现把它放在 json 与 urlencoded 之间，导致 urlencoded/raw 的 413 绕过它。
app.use(bodyParserErrorHandler);

// 静态资源服务
app.use('/public', express.static(path.join(__dirname, 'public')));

// 登录页面
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/login.html'));
});

// SEC-006：登录限流（按 用户名 + IP 递增退避）。
const loginLimiter = new LoginRateLimiter({
    baseWindowMs: Number(process.env.LOGIN_RATE_WINDOW_MS || 5 * 60 * 1000),
    maxAttempts: Number(process.env.LOGIN_RATE_MAX || 10),
    message: '登录尝试过于频繁，请稍后再试'
});

// 登录状态验证（Cookie 会话优先，兼容 Bearer）
app.get('/api/auth-status', (req, res) => {
    const sessionId = auth.parseSessionFromCookie(req.headers.cookie);
    const loggedIn = (sessionId && auth.verifySession(sessionId))
        || (req.headers.authorization && auth.verifyToken(req.headers.authorization.replace('Bearer ', '')));
    res.json({ loggedIn: !!loggedIn, configured: auth.isConfigured() });
});

// 登录
app.post('/api/login', async (req, res) => {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ error: '用户名和密码不能为空' });
    }

    try {
        loginLimiter.check(`${username}:${ip}`);
    } catch (limitErr) {
        res.setHeader('Retry-After', String(limitErr.retryAfter || 1));
        return res.status(429).json({ error: limitErr.message });
    }

    const result = auth.login(username, password, { ip });
    if (result.success) {
        loginLimiter.reset(`${username}:${ip}`);
        // SEC-002：下发 HttpOnly Cookie；生产 + HTTPS 下附加 Secure。
        const secure = isProduction && isSecureRequest(req);
        res.setHeader('Set-Cookie', auth.buildSessionCookie(result.sessionId, { secure }));
        return res.json({ success: true });
    }
    loginLimiter.recordFailure(`${username}:${ip}`);
    return res.status(401).json({ error: result.error });
});

// 登出：清除服务端会话与 Cookie
app.post('/api/logout', (req, res) => {
    const sessionId = auth.parseSessionFromCookie(req.headers.cookie);
    if (sessionId) auth.logout(sessionId);
    const secure = isProduction && isSecureRequest(req);
    res.setHeader('Set-Cookie', auth.buildClearCookie({ secure }));
    res.json({ success: true });
});

// 会话管理（SEC-006）：列出 / 吊销会话
app.get('/api/sessions', (req, res) => {
    const sessionId = auth.parseSessionFromCookie(req.headers.cookie);
    if (!auth.verifySession(sessionId)) return res.status(401).json({ error: '未登录或登录已过期' });
    res.json({ sessions: auth.listSessions() });
});

app.delete('/api/sessions/:id', (req, res) => {
    const sessionId = auth.parseSessionFromCookie(req.headers.cookie);
    if (!auth.verifySession(sessionId)) return res.status(401).json({ error: '未登录或登录已过期' });
    auth.revokeSession(req.params.id);
    res.json({ success: true });
});

app.delete('/api/sessions', (req, res) => {
    const sessionId = auth.parseSessionFromCookie(req.headers.cookie);
    if (!auth.verifySession(sessionId)) return res.status(401).json({ error: '未登录或登录已过期' });
    auth.revokeAllSessions();
    res.json({ success: true });
});

// 多应用（第三轮复验 P2-2）：Cookie Secure 判断只依赖 req.secure，
// 不再直接信任客户端可伪造的 X-Forwarded-Proto。
// 反向代理可信范围由 Express trust proxy 配置负责（TRUST_PROXY 环境变量），
// 正确配置后 Express 会把代理透传的协议反映到 req.secure。
function isSecureRequest(req) {
    return !!req.secure;
}

// SEC-007：健康检查 —— live 仅探测进程存活，ready 验证数据库可读。
app.get('/health/live', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/health/ready', async (req, res) => {
    try {
        await notifier.ensureDbReady();
        const db = notifier._internal.db;
        await db.ping();
        res.json({ status: 'ok', database: 'ready' });
    } catch (err) {
        res.status(503).json({ status: 'not_ready', error: '数据库不可用' });
    }
});

// 路由
app.use('/', routes);

// 多应用（二次复验 P1-01/P1-06 + 第三轮 P1-03）：全局兜底错误中间件。
// 任何未捕获的异常（TypeError、SQL 错误等）统一返回稳定 JSON code，
// 生产环境不暴露堆栈/路径/SQL。必须放在路由之后、404 catch-all 之前。
// 多应用（第三轮 P1-03）：parser 漏网的 413（urlencoded/raw）也在此归一化为
// PAYLOAD_TOO_LARGE，不泄漏框架英文 "request entity too large"。
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const status = err && (err.statusCode || err.status) || 500;
    const errType = err && (err.type || (err.constructor && err.constructor.name)) || '';
    // 413 超限：任何 parser 的 entity.too.large 都归一化为 PAYLOAD_TOO_LARGE。
    if (status === 413 || errType === 'entity.too.large' || /entity too large/i.test(err && err.message || '')) {
        return res.status(413).json({ error: '请求体超过大小限制', code: 'PAYLOAD_TOO_LARGE' });
    }
    if (status < 500) {
        // 已有业务错误（4xx）：交给 sendError 风格的 JSON 响应；此处兜底确保有 code。
        const body = { error: (err && err.message) || '请求失败' };
        if (err && err.businessCode) body.code = err.businessCode;
        if (err && err.details) body.details = err.details;
        // 4xx 无业务码时补 INVALID_INPUT（parser 400 等）。
        if (!body.code) body.code = 'INVALID_INPUT';
        return res.status(status).json(body);
    }
    // 未预期 5xx：不泄露内部细节。
    if (process.env.NODE_ENV !== 'production') {
        console.error('[未捕获错误]', err && err.stack ? err.stack : err);
    }
    return res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
});

// 404处理
app.use((req, res) => {
    res.status(404).json({ error: '未找到资源' });
});

// 周期清理限流器内存
setInterval(() => {
    loginLimiter.cleanup();
}, 5 * 60 * 1000).unref();

// SEC-007：异步 bootstrap —— 数据库初始化成功后再监听；失败则退出进程交由编排重启。
// REV-012：保存 http server 句柄，用于优雅退出（先停 HTTP，再关 DB）。
let httpServer = null;

async function start() {
    try {
        await notifier.ensureDbReady();
    } catch (err) {
        console.error('[启动] 数据库初始化失败，拒绝监听端口:', err.message);
        process.exit(1);
    }

    httpServer = app.listen(PORT, () => {
        console.log(`企业微信通知服务已启动，端口: ${PORT} (NODE_ENV=${NODE_ENV})`);
    });
}

// 优雅退出：收到 SIGTERM/SIGINT（如 docker stop）时，先停止接收新连接并等待在途
// 请求结束，再关闭数据库连接，最后以退出码 0 正常退出。设超时兜底，避免卡死。
// 校验 SHUTDOWN_TIMEOUT_MS 为安全整数且落在合理区间 [1000, 60000]ms：
// 过小（如 0.5）会近乎立即强制退出；过大（如 999999999999）超出 32 位整数，
// setTimeout 在部分平台溢出也会立即触发。区间外或非法值回退默认值。
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const MIN_SHUTDOWN_TIMEOUT_MS = 1000;
const MAX_SHUTDOWN_TIMEOUT_MS = 60000;
function resolveShutdownTimeoutMs(raw) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < MIN_SHUTDOWN_TIMEOUT_MS || n > MAX_SHUTDOWN_TIMEOUT_MS) {
        return DEFAULT_SHUTDOWN_TIMEOUT_MS;
    }
    return n;
}
const SHUTDOWN_TIMEOUT_MS = resolveShutdownTimeoutMs(process.env.SHUTDOWN_TIMEOUT_MS);
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[退出] 收到 ${signal}，开始优雅关闭`);

    // 超时兜底：超过阈值仍未关闭则强制退出，避免编排系统等待超时被 SIGKILL。
    const forceTimer = setTimeout(() => {
        console.error(`[退出] 超过 ${SHUTDOWN_TIMEOUT_MS}ms 未完成，强制退出`);
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    // 1. 停止接收新连接，等待在途请求完成（Express 5 的 close 会处理 keep-alive）。
    if (httpServer) {
        await new Promise((resolve) => {
            httpServer.close((err) => {
                if (err) console.error('[退出] 关闭 HTTP server 时出错:', err.message);
                resolve();
            });
        });
        console.log('[退出] HTTP server 已关闭');
    }

    // 2. 关闭数据库连接（close 已包装为 Promise，失败时 reject）。
    // 关闭失败（如 SQLITE_BUSY，可能有未刷盘的 WAL）属于不干净退出：
    // 记录错误并以非零码退出，让编排系统感知这次关闭未正常完成。
    let dbClosed = true;
    try {
        await notifier._internal.db.close();
        console.log('[退出] 数据库连接已关闭');
    } catch (err) {
        dbClosed = false;
        console.error('[退出] 关闭数据库失败，以非零码退出:', err.message);
    }

    clearTimeout(forceTimer);
    if (dbClosed) {
        console.log('[退出] 优雅关闭完成');
        process.exit(0);
    }
    console.error('[退出] 关闭未正常完成');
    process.exit(1);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
    console.error('[启动] 启动失败:', err.message);
    process.exit(1);
});
