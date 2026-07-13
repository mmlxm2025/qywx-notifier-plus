// 认证模块
//
// SEC-002 整改：改用随机服务端会话 ID，经 HttpOnly/Secure/SameSite Cookie 下发，
// 不再把 Token 放进 URL / localStorage。
// SEC-006 整改：
//   - 常量时间密码比较，避免时序侧信道。
//   - 登录失败限流（由 routes/server 层调用 checkLogin / recordLoginFailure）。
//   - 会话支持列表、单会话/全部吊销、密码版本失效。
//
// 注意：默认导出仍为 AuthService 实例，以兼容旧测试对 auth.verifyToken 的替换。

const crypto = require('crypto');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'session';

function constantTimeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) {
        crypto.timingSafeEqual(ba, ba); // 保持恒定时间
        return false;
    }
    return crypto.timingSafeEqual(ba, bb);
}

class AuthService {
    constructor() {
        this.sessions = new Map(); // sessionId -> { expires, username, createdAt, lastSeen, ip, passwordVersion }
        this.username = process.env.ADMIN_USERNAME || 'admin';
        this.password = process.env.ADMIN_PASSWORD || '';
        this.passwordVersion = 1;
    }

    generateSessionId() {
        return crypto.randomBytes(32).toString('hex');
    }

    login(username, password, meta = {}) {
        if (!this.password) {
            return { success: false, error: '管理员未配置密码，请设置 ADMIN_PASSWORD 环境变量' };
        }

        const userOk = constantTimeEqual(username || '', this.username);
        const passOk = constantTimeEqual(password || '', this.password);
        if (!(userOk && passOk)) {
            return { success: false, error: '用户名或密码错误' };
        }

        const sessionId = this.generateSessionId();
        const now = Date.now();
        this.sessions.set(sessionId, {
            expires: now + SESSION_TTL_MS,
            username: this.username,
            createdAt: now,
            lastSeen: now,
            ip: meta.ip || '',
            passwordVersion: this.passwordVersion
        });
        return { success: true, sessionId, expiresIn: SESSION_TTL_MS };
    }

    verifySession(sessionId) {
        if (!sessionId) return false;
        const data = this.sessions.get(sessionId);
        if (!data) return false;
        if (Date.now() > data.expires) {
            this.sessions.delete(sessionId);
            return false;
        }
        if (data.passwordVersion !== this.passwordVersion) {
            this.sessions.delete(sessionId);
            return false;
        }
        data.lastSeen = Date.now();
        return true;
    }

    getSessionUser(sessionId) {
        const data = this.sessions.get(sessionId);
        if (!data || Date.now() > data.expires) return null;
        return { username: data.username, createdAt: data.createdAt, lastSeen: data.lastSeen, ip: data.ip };
    }

    logout(sessionId) {
        if (sessionId) {
            this.sessions.delete(sessionId);
        }
        return true;
    }

    // 兼容旧 Bearer Token / query token 校验：迁移期保留，供未改造调用方使用。
    verifyToken(token) {
        return this.verifySession(token);
    }

    listSessions() {
        const now = Date.now();
        const result = [];
        for (const [id, data] of this.sessions) {
            if (data.expires <= now) continue;
            result.push({
                id,
                username: data.username,
                createdAt: data.createdAt,
                lastSeen: data.lastSeen,
                ip: data.ip,
                expires: data.expires
            });
        }
        return result;
    }

    revokeSession(sessionId) {
        return this.sessions.delete(sessionId);
    }

    revokeAllSessions() {
        this.sessions.clear();
    }

    isConfigured() {
        return !!this.password;
    }
}

const authService = new AuthService();

function getCookieName() {
    return COOKIE_NAME;
}

function parseSessionFromCookie(cookieHeader) {
    if (!cookieHeader) return null;
    const parts = String(cookieHeader).split(';');
    for (const part of parts) {
        const [name, ...rest] = part.trim().split('=');
        if (name === COOKIE_NAME) {
            return rest.join('=') || null;
        }
    }
    return null;
}

function buildSessionCookie(sessionId, { secure, maxAgeMs = SESSION_TTL_MS, sameSite = 'Lax' } = {}) {
    const parts = [
        `${COOKIE_NAME}=${sessionId}`,
        'Path=/',
        `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
        `SameSite=${sameSite}`,
        'HttpOnly'
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

function buildClearCookie({ secure } = {}) {
    const parts = [`${COOKIE_NAME}=`, 'Path=/', 'Max-Age=0', 'SameSite=Lax', 'HttpOnly'];
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

// 默认导出实例（兼容旧用法）；同时挂载静态辅助方法。
Object.assign(authService, {
    getCookieName,
    parseSessionFromCookie,
    buildSessionCookie,
    buildClearCookie,
    SESSION_TTL_MS,
    COOKIE_NAME
});

module.exports = authService;
module.exports.getCookieName = getCookieName;
module.exports.parseSessionFromCookie = parseSessionFromCookie;
module.exports.buildSessionCookie = buildSessionCookie;
module.exports.buildClearCookie = buildClearCookie;
module.exports.SESSION_TTL_MS = SESSION_TTL_MS;
module.exports.COOKIE_NAME = COOKIE_NAME;
