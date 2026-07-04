// 运行时配置与启动校验
//
// 设计要点：
// - 本模块仅读取并集中暴露环境变量，不在加载阶段抛错，避免业务模块在
//   require 时副作用失败（测试与按需调用均依赖这一约定）。
// - 真正的“启动阻断”由 server.js 在监听端口前调用 validateRuntime() 完成，
//   从而满足 SEC-001 验收标准：未配置密钥或密码时进程无法监听端口。

const path = require('path');

// 已知的模板占位值，命中即视为未配置。覆盖两个 .env 模板与历史默认值。
const PLACEHOLDER_VALUES = new Set([
    'default-key-for-development-only',
    'change-this-to-a-random-32-char-string',
    'your-32-character-encryption-key-here',
    'change-this-to-a-strong-password',
    'your-secure-password'
]);

function isPlaceholder(value) {
    if (value === undefined || value === null) return true;
    const trimmed = String(value).trim();
    return trimmed.length === 0 || PLACEHOLDER_VALUES.has(trimmed);
}

// 将用户输入的 ENCRYPTION_KEY 归一化为 32 字节 Buffer。
// 支持 3 种等价输入：
//   1. 64 位 hex           -> Buffer.from(hex, 'hex')
//   2. 44 位 base64 (含填充) -> Buffer.from(base64, 'base64')
//   3. 原始 32 字符 UTF-8   -> Buffer.from(raw, 'utf8')
// 解码后必须正好 32 字节；否则返回 null（视为无效）。
function decodeEncryptionKey(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;

    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        return Buffer.from(trimmed, 'hex');
    }
    if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) {
        const buf = Buffer.from(trimmed, 'base64');
        if (buf.length === 32) return buf;
    }
    if (Buffer.byteLength(trimmed, 'utf8') === 32) {
        return Buffer.from(trimmed, 'utf8');
    }
    return null;
}

function readRawConfig() {
    return {
        port: process.env.PORT || 3000,
        dbPath: process.env.DB_PATH || path.join(__dirname, '../../database/notifier.db'),
        encryptionKeyRaw: process.env.ENCRYPTION_KEY,
        adminUsername: process.env.ADMIN_USERNAME || 'admin',
        adminPassword: process.env.ADMIN_PASSWORD,
        wechatApiBase: process.env.WECHAT_API_BASE || 'https://qyapi.weixin.qq.com',
        nodeEnv: process.env.NODE_ENV || 'development',
        // 可选：关闭某些启动硬性校验，仅用于本地开发，生产不应设置
        skipStartupValidation: process.env.SKIP_STARTUP_VALIDATION === '1'
    };
}

// 暴露原始配置（不做校验），供业务模块按需引用。
// 注意：每次访问 raw 才读取环境变量，以便测试在 process.env 注入后立即生效。
const raw = new Proxy({}, {
    get(_target, prop) {
        return readRawConfig()[prop];
    }
});

// 加密密钥：每次按当前环境变量重新解码，不缓存，避免测试注入后失效。
function getEncryptionKey() {
    return decodeEncryptionKey(process.env.ENCRYPTION_KEY);
}

// 启动期硬性校验：缺失、占位符或长度错误时抛错，server.js 据此拒绝监听。
function validateRuntime() {
    const errors = [];

    if (isPlaceholder(raw.encryptionKeyRaw)) {
        errors.push('ENCRYPTION_KEY 未配置或仍为模板占位值，请生成 32 字节随机密钥（推荐 openssl rand -hex 32 或 openssl rand -base64 32）。');
    } else {
        const decoded = decodeEncryptionKey(raw.encryptionKeyRaw);
        if (!decoded) {
            errors.push('ENCRYPTION_KEY 格式无效：必须是 64 位 hex、44 位 base64（含填充）或正好 32 字符的字符串。');
        }
    }

    if (isPlaceholder(raw.adminPassword)) {
        errors.push('ADMIN_PASSWORD 未配置或仍为模板占位值，请设置强密码。');
    } else if (String(raw.adminPassword).length < 8) {
        errors.push('ADMIN_PASSWORD 强度过低，至少需要 8 个字符。');
    }

    if (errors.length > 0) {
        const err = new Error('启动配置校验失败：\n  - ' + errors.join('\n  - '));
        err.fatal = true;
        throw err;
    }
}

module.exports = {
    raw,
    isPlaceholder,
    decodeEncryptionKey,
    getEncryptionKey,
    validateRuntime,
    PLACEHOLDER_VALUES
};
