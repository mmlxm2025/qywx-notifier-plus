// 核心业务逻辑模块
// 处理配置创建和消息发送的业务逻辑

const crypto = require('crypto');
const Database = require('../core/database');
const { getCrypto } = require('../core/crypto-instance');
const WeChatService = require('../core/wechat');
const WeChatCallbackCrypto = require('../core/wechat-callback');
const config = require('../core/config');
const notifyAuth = require('../core/notify-auth');
const notifyCode = require('../core/notify-code');
const path = require('path');

// 环境变量
const DB_PATH = config.raw.dbPath;

const db = new Database(DB_PATH);
const wechat = new WeChatService(config.raw.wechatApiBase);
const CONFIG_CACHE_TTL_MS = Number(process.env.CONFIG_CACHE_TTL_MS || 60000);
const MEMBER_CACHE_TTL_MS = Number(process.env.MEMBER_CACHE_TTL_MS || 300000);
const SEND_DEDUP_TTL_MS = Number(process.env.SEND_DEDUP_TTL_MS || 30000);
const MEMBER_MINUTE_LIMIT = Number(process.env.WECHAT_MEMBER_MINUTE_LIMIT || 30);
const MEMBER_HOUR_LIMIT = Number(process.env.WECHAT_MEMBER_HOUR_LIMIT || 1000);
const WECHAT_ACCOUNT_LIMIT = Number(process.env.WECHAT_ACCOUNT_LIMIT || 0);
const APP_DAILY_PERSON_LIMIT = Number(
    process.env.WECHAT_APP_DAILY_PERSON_LIMIT || (WECHAT_ACCOUNT_LIMIT > 0 ? WECHAT_ACCOUNT_LIMIT * 200 : 0)
);
const RATE_BACKOFF_MS = Number(process.env.WECHAT_RATE_BACKOFF_MS || 60000);
// 回调重放保护：允许的时间戳偏差窗口（秒）与 nonce 缓存 TTL。
const CALLBACK_TIMESTAMP_TOLERANCE_SEC = Number(process.env.CALLBACK_TIMESTAMP_TOLERANCE_SEC || 300);
const CALLBACK_NONCE_TTL_MS = Number(process.env.CALLBACK_NONCE_TTL_MS || 600000);
// 回调请求体硬上限（字节），防御解析型 DoS。
const CALLBACK_MAX_BODY_BYTES = Number(process.env.CALLBACK_MAX_BODY_BYTES || 102400);
const targetCache = new Map();
const memberListCache = new Map();
const sendResultCache = new Map();
const memberWindows = new Map();
const appDailyWindows = new Map();
const backoffWindows = new Map();
// 回调 nonce / MsgId 重放缓存：key -> 过期时间戳。
const callbackNonceSeen = new Map();
// 进行中的发送（in-flight 合并）：相同 cacheKey 的并发请求复用同一 Promise。
const inflightSends = new Map();

// 数据库初始化状态（SEC-007）：暴露给 server.js 的 bootstrap 使用。
let dbReady = false;
let dbInitError = null;

// 立即触发数据库初始化；server.js 会在监听前 await ensureDbReady()。
db.init()
    .then(async () => {
        await migrateLegacyCiphertexts();
        dbReady = true;
        console.log('[启动] 数据库初始化完成');
    })
    .catch((err) => {
        dbInitError = err;
        // 此处不抛出；由 ensureDbReady() 在启动期统一处理，便于编排系统重启。
        console.error('[启动] 数据库初始化失败:', err.message);
    });

// SEC-007：启动期 bootstrap，供 server.js await。失败则抛错阻止监听。
async function ensureDbReady() {
    if (dbReady) return;
    if (dbInitError) throw dbInitError;
    // 初始化仍在进行中：轮询等待（数据库初始化为毫秒级）。
    for (let i = 0; i < 1000; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (dbReady) return;
        if (dbInitError) throw dbInitError;
    }
    throw new Error('数据库初始化超时');
}

function isDbReady() {
    return dbReady;
}

// SEC-005 / REV-008：迁移旧 CBC 密文为 GCM，并将历史明文 callback_token 加密后置空原列。
// 失败不阻断启动（保留可读性），仅记录。
//
// 多应用（二次复验 P0-01）：迁移统一采用“旧值条件更新”——
//   UPDATE ... SET field = ? WHERE code = ? AND field = ?
// 只有字段仍是本次读取的旧密文时才替换表示形式，避免与并发的业务写入（如 CorpSecret 更新）
// 竞争时把旧值重新写回，覆盖刚提交的新值。
async function migrateLegacyCiphertexts() {
    // 仅在底层 sqlite3 句柄就绪时执行：迁移在 db.init().then() 内调用，
    // 此时句柄已建立；测试环境若 require 时机早于 init 或指向不可用路径，句柄为空，
    // 视为“无需迁移”的正常跳过，避免 “数据库未初始化” 噪音掩盖真实迁移错误。
    if (!db.db) return;
    try {
        const rows = await db.allRaw('SELECT code, encrypted_corpsecret, encrypted_encoding_aes_key, callback_token, encrypted_callback_token FROM configurations');
        const cryptoSvc = safeGetCrypto();
        if (!cryptoSvc) return; // 无密钥时跳过，待配置后由读路径触发迁移。
        for (const row of rows || []) {
            try {
                if (row.encrypted_corpsecret && cryptoSvc.isLegacyCiphertext(row.encrypted_corpsecret)) {
                    const re = cryptoSvc.reencryptIfLegacy(row.encrypted_corpsecret);
                    // 旧值条件更新：字段仍是本次读取的旧密文时才替换。
                    await db.runRaw(
                        'UPDATE configurations SET encrypted_corpsecret = ? WHERE code = ? AND encrypted_corpsecret = ?',
                        [re, row.code, row.encrypted_corpsecret]
                    );
                }
                if (row.encrypted_encoding_aes_key && cryptoSvc.isLegacyCiphertext(row.encrypted_encoding_aes_key)) {
                    const re = cryptoSvc.reencryptIfLegacy(row.encrypted_encoding_aes_key);
                    await db.runRaw(
                        'UPDATE configurations SET encrypted_encoding_aes_key = ? WHERE code = ? AND encrypted_encoding_aes_key = ?',
                        [re, row.code, row.encrypted_encoding_aes_key]
                    );
                }
                // REV-008：历史明文 callback_token -> 加密到 encrypted_callback_token，然后置空原列。
                if (row.callback_token && !row.encrypted_callback_token) {
                    const enc = cryptoSvc.encrypt(row.callback_token);
                    await db.runRaw(
                        'UPDATE configurations SET encrypted_callback_token = ?, callback_token = NULL WHERE code = ? AND callback_token = ?',
                        [enc, row.code, row.callback_token]
                    );
                }
            } catch (err) {
                console.error('[迁移] 配置', row.code, '密文迁移失败:', err.message);
            }
        }
    } catch (err) {
        console.error('[迁移] 旧密文迁移检查失败:', err.message);
    }
}

// 多应用（二次复验 P0-01）：允许触发惰性迁移的字段白名单。
// 防止动态列名注入；只有这些密文列才允许在读取时迁移表示形式。
const MIGRATION_FIELDS = new Set([
    'encrypted_corpsecret',
    'encrypted_encoding_aes_key',
    'encrypted_callback_token'
]);

// 只解密、不触发迁移。供“提交后失效旧 token”等读路径使用——这些路径读取旧 secret
// 仅为 token 清理，不得启动旧值迁移（否则会与并发的 CorpSecret 业务更新竞争，把旧值写回）。
function decryptOnly(encrypted) {
    return getCrypto().decrypt(encrypted);
}

// 读取时若发现旧格式，触发一次性重新加密（惰性迁移，确保旧库可用）。
//
// 多应用（二次复验 P0-01）：惰性迁移改为“旧值条件更新”——
//   UPDATE configurations SET field = ? WHERE code = ? AND field = ?
// 只有字段仍是本次读取的旧密文时才替换表示形式。这样即使迁移 fire-and-forget 排在
// 一个并发的业务写入（如 CorpSecret 更新）之后，也会因 WHERE 条件不匹配而 changes=0，
// 不会覆盖已提交的新值。表示形式迁移不递增业务 version（UPDATE 不含 version）。
function decryptWithLazyMigration(field, encrypted, code) {
    const cryptoSvc = getCrypto();
    const plain = cryptoSvc.decrypt(encrypted);
    if (cryptoSvc.isLegacyCiphertext(encrypted) && MIGRATION_FIELDS.has(field)) {
        try {
            const re = cryptoSvc.encrypt(plain);
            // 旧值条件更新：字段仍是本次读取的旧密文时才替换。
            db.runRaw(
                `UPDATE configurations SET ${field} = ? WHERE code = ? AND ${field} = ?`,
                [re, code, encrypted]
            ).catch(() => {});
        } catch (err) {
            console.error('[迁移] 惰性迁移字段', field, '失败:', err.message);
        }
    }
    return plain;
}

function safeGetCrypto() {
    try {
        return getCrypto();
    } catch (err) {
        return null;
    }
}

function createError(message, statusCode, businessCode, details) {
    const error = new Error(message);
    if (statusCode) {
        error.statusCode = statusCode;
    }
    // 多应用（2026-07-04 §6.9）：稳定业务错误码，供前端分支使用，禁止匹配中文文案。
    // 内部属性命名为 businessCode，避免与 SQLite/Node 错误自带的 err.code 冲突；
    // 路由层 sendError() 会序列化成响应 JSON 中的 code 字段。
    if (businessCode) {
        error.businessCode = businessCode;
    }
    if (details) {
        error.details = details;
    }
    return error;
}

function normalizeTouser(value) {
    const list = Array.isArray(value) ? value : String(value || '').split('|');
    return [...new Set(list.map(item => String(item).trim()).filter(Boolean))];
}

function normalizeScopeList(value) {
    const list = Array.isArray(value)
        ? value
        : String(value || '').split(/[|,，;；\s]+/);
    return [...new Set(list.map(item => String(item).trim()).filter(Boolean))];
}

// SEC-009：严格布尔解析，拒绝字符串 "false"/"0" 等被当作真值。
function toStrictBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (value === undefined || value === null) return null; // 未提供
    if (typeof value === 'number') {
        if (value === 1) return true;
        if (value === 0) return false;
        return null;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim().toLowerCase();
        if (trimmed === 'true' || trimmed === '1' || trimmed === 'on') return true;
        if (trimmed === 'false' || trimmed === '0' || trimmed === 'off') return false;
        return null;
    }
    return null;
}

function toBoolean(value) {
    const result = toStrictBoolean(value);
    return result === true;
}

// SEC-009：严格正整数 AgentID 校验。
function parsePositiveInt(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
}

// 多应用（2026-07-04 §6.3）：统一凭证验证收口到 notifier 的 wechat 实例，
// 让 /api/validate、成员读取与发送共享同一 token 缓存。
//
// 校验 corpid + corpsecret + agentid 是否匹配一个可访问的企业微信自建应用。
// 成功返回 { agentInfo }；失败转换为稳定业务错误：
//   - 凭证无效/AgentID 不存在 → 400 WECHAT_CREDENTIAL_INVALID
//   - 网络/上游不可用         → 502 WECHAT_UNAVAILABLE
async function validateApplicationCredentials({ corpid, corpsecret, agentid }) {
    const numericAgentid = parsePositiveInt(agentid);
    if (!corpid || !corpsecret || !numericAgentid) {
        throw createError('参数不完整，请填写CorpID、CorpSecret和AgentID', 400, 'INVALID_INPUT');
    }
    let accessToken;
    try {
        accessToken = await wechat.getToken(corpid, corpsecret);
    } catch (err) {
        throw wrapWeChatError(err);
    }
    try {
        const agentInfo = await wechat.getAgentInfo(accessToken, numericAgentid);
        return { agentInfo, accessToken };
    } catch (err) {
        throw wrapWeChatError(err);
    }
}

// 多应用（P1-01）：/api/validate 收口到 notifier 的 wechat 实例，
// 与发送/成员读取共享同一 token 缓存。返回 { agentid, users } 供向导选择成员。
// 凭证错误返回 WECHAT_CREDENTIAL_INVALID，网络/上游不可用返回 WECHAT_UNAVAILABLE。
async function validateAndListMembers({ corpid, corpsecret, agentid }) {
    const numericAgentid = parsePositiveInt(agentid);
    if (!corpid || !corpsecret || !numericAgentid) {
        throw createError('参数不完整，请填写CorpID、CorpSecret和AgentID', 400, 'INVALID_INPUT');
    }
    let accessToken;
    try {
        accessToken = await wechat.getToken(corpid, corpsecret);
    } catch (err) {
        throw wrapWeChatError(err);
    }
    let agentInfo;
    let users;
    try {
        agentInfo = await wechat.getAgentInfo(accessToken, numericAgentid);
    } catch (err) {
        throw wrapWeChatError(err);
    }
    try {
        users = await wechat.getAgentVisibleUsers(accessToken, agentInfo);
    } catch (err) {
        throw wrapWeChatError(err);
    }
    return { agentid: numericAgentid, users };
}

// 将企业微信上游错误转换为稳定业务码。
function wrapWeChatError(err) {
    const message = String(err && err.message || '');
    // 常见凭证错误：40001 invalid credential / 48002 agent invalid / 60011 no privilege。
    if (message.includes('40001') || message.includes('invalid credential')
        || message.includes('48002') || message.includes('60011')
        || message.includes('获取token失败') || message.includes('gettoken')) {
        return createError('企业微信凭证无效或 AgentID 不匹配', 400, 'WECHAT_CREDENTIAL_INVALID');
    }
    // 其余视为网络/上游暂时不可用。
    const wrapped = createError(
        '企业微信服务暂时不可用，请稍后重试',
        502,
        'WECHAT_UNAVAILABLE'
    );
    wrapped.cause = err;
    return wrapped;
}

// 多应用（2026-07-04 §6.7 / §4.5）：统一配置摘要序列化。
// 列表、详情、规则摘要均复用本函数，保证 lifecycle/capabilities/warnings/version 语义一致。
// 前端禁止根据多个布尔字段自行推导状态，只渲染本函数输出。
//
// options:
//   - includeSensitiveFlags: 详情页补充 corpsecret_configured 等“是否已配置”标志（不返回明文）
//   - ruleCounts: { [code]: { rule_count, enabled_rule_count } }，避免列表 N+1
//   - duplicateMap: { [code]: boolean }，总览用的重复身份标记
function serializeConfigurationSummary(config, options = {}) {
    if (!config) return null;
    const completed = isCompletedConfig(config);
    const appEnabled = config.app_enabled === undefined
        ? true
        : (config.app_enabled === 1 || config.app_enabled === true);
    const codeSendEnabled = config.code_send_enabled === undefined || config.code_send_enabled === null
        ? true
        : (config.code_send_enabled === 1 || config.code_send_enabled === true);

    // 主生命周期（设计 §4.3）：只有一条主生命周期。
    let lifecycle_status;
    if (!completed) {
        lifecycle_status = 'draft';
    } else if (!appEnabled) {
        lifecycle_status = 'paused';
    } else {
        lifecycle_status = 'active';
    }

    // 告警：重复身份等数据告警，不改变主生命周期。
    const warnings = [];
    if (options.duplicateMap && options.duplicateMap[config.code]) {
        warnings.push('duplicate_identity');
    }

    // 操作能力：由服务端统一决定，前端只渲染。草稿不能发送/切换/管理规则/安全设置。
    const capabilities = {
        can_edit: completed,
        can_resume: completed && !appEnabled,
        can_pause: completed && appEnabled,
        can_toggle: completed,
        can_manage_rules: completed,
        can_manage_security: completed,
        can_delete: true
    };

    const recipientCount = normalizeTouser(config.touser).length;
    const counts = (options.ruleCounts && options.ruleCounts[config.code]) || {
        rule_count: 0,
        enabled_rule_count: 0
    };

    const summary = {
        code: config.code,
        corpid: config.corpid,
        agentid: Number(config.agentid) || 0,
        description: config.description || '',
        version: Number(config.version) || 1,
        completed,
        app_enabled: appEnabled,
        callback_enabled: config.callback_enabled === 1 || config.callback_enabled === true,
        code_send_enabled: codeSendEnabled,
        recipient_count: recipientCount,
        rule_count: counts.rule_count,
        enabled_rule_count: counts.enabled_rule_count,
        created_at: config.created_at,
        lifecycle_status,
        warnings,
        capabilities,
        // 是否启用通知密钥：只是布尔标志（非敏感），列表/规则/详情都需要，
        // 用于决定是否在 UI 上显示密钥相关提示。放在基础摘要中（§6.7）。
        notify_key_enabled: !!(config.notify_key_hash)
    };

    // 详情页扩展：是否已配置（不返回明文）。
    if (options.includeSensitiveFlags) {
        summary.corpsecret_configured = !!config.encrypted_corpsecret;
        summary.callback_token_configured = !!(config.encrypted_callback_token || config.callback_token);
        summary.encoding_aes_key_configured = !!config.encrypted_encoding_aes_key;
    }
    return summary;
}

// 多应用：判定一行是否真正未完成的草稿（与 DAO getIncompleteConfigurationByCorpId 一致）。
function isDraftConfig(row) {
    if (!row) return false;
    const noSecret = !row.encrypted_corpsecret;
    const zeroAgent = parsePositiveInt(row.agentid) === null;
    const emptyTouser = normalizeTouser(row.touser).length === 0;
    return noSecret && zeroAgent && emptyTouser;
}

// 多应用（§4.4 三层发送开关 / §6.5 防绕过）：
// service 层发送入口的最外层判断。无论从配置 Code 还是规则 API 进入，
// 都先校验“应用是否已完成 + 应用总开关”，再由路由/规则各自校验子开关。
//
// 注意：本函数只覆盖应用级开关；配置 Code/规则级开关仍由 resolveNotifyAuth（路由层）负责，
// 这里是防绕过的二次校验，确保内部直接调用 notifier.sendNotification 也受限。
//
// 完成态必须用 isCompletedConfig（secret + agentid + touser 全齐），不能用 isDraftConfig：
// isDraft 只匹配「三项全缺」的纯草稿；半完成配置（仅有 secret、或 secret+agent 无 touser）
// 既不是草稿也不是完成态，若只拦草稿会错误放行并调用企业微信（空接收人/非法 agentid）。
function assertSendAllowed(config, rule) {
    if (!config) {
        throw createError('无效的code，未找到配置', 404, 'APP_NOT_FOUND');
    }
    if (!isCompletedConfig(config)) {
        throw createError('应用尚未完成配置', 409, 'APP_NOT_COMPLETED');
    }
    // 多应用（§4.4 三层发送开关）：与 HTTP resolveNotifyAuth 对齐，防止直接调用
    // sendNotification 绕过路由层子开关。
    const appEnabled = config.app_enabled === undefined
        ? true
        : (config.app_enabled === 1 || config.app_enabled === true);
    if (!appEnabled) {
        throw createError('该应用已暂停发送', 403, 'APP_DISABLED');
    }
    if (rule) {
        // null/undefined 视为开启（与序列化/历史默认一致）；仅显式关闭拒绝。
        const ruleEnabled = rule.enabled === null || rule.enabled === undefined
            ? true
            : (rule.enabled === 1 || rule.enabled === true);
        if (!ruleEnabled) {
            throw createError('该规则已被禁用', 403, 'RULE_DISABLED');
        }
    } else {
        const codeSendEnabled = config.code_send_enabled === undefined || config.code_send_enabled === null
            ? true
            : (config.code_send_enabled === 1 || config.code_send_enabled === true);
        if (!codeSendEnabled) {
            throw createError('该应用已关闭 Code 直接发送，请使用规则 API', 403, 'DIRECT_SEND_DISABLED');
        }
    }
}

// 多应用（§6.5 应用总开关）：严格布尔切换，版本乐观锁。
// 草稿不允许切换（APP_NOT_COMPLETED）。成功后递增应用版本并清运行时缓存。
async function setAppEnabled(code, enabled, options = {}) {
    const config = await db.getConfigurationByCode(code);
    if (!config) {
        throw createError('无效的code，未找到配置', 404, 'APP_NOT_FOUND');
    }
    // 严格布尔解析：拒绝 "false" 字符串等模糊值。
    const strict = toStrictBoolean(enabled);
    if (strict === null) {
        throw createError('应用总开关必须为布尔值', 400, 'INVALID_INPUT');
    }
    if (!isCompletedConfig(config)) {
        throw createError('应用尚未完成配置，不能切换总开关', 409, 'APP_NOT_COMPLETED');
    }

    const expectedVersion = parseExpectedVersion(options);
    if (expectedVersion === null) {
        throw createError('缺少版本号，请刷新后重试', 428, 'APP_VERSION_REQUIRED');
    }

    const value = strict ? 1 : 0;
    const updateResult = await db.updateConfigurationFields(code, { app_enabled: value }, expectedVersion);
    if (updateResult.changes === 0) {
        const stillExists = await db.getConfigurationByCode(code);
        if (!stillExists) {
            throw createError('无效的code，未找到配置', 404, 'APP_NOT_FOUND');
        }
        throw createError('应用已在其他页面更新，请加载最新值后重新确认', 409, 'APP_VERSION_CONFLICT', {
            version: Number(stillExists.version) || 1
        });
    }

    clearRuntimeCaches();
    return { code, app_enabled: strict, version: updateResult.version };
}

// 多应用（§6.6 删除应用）：事务级联删除应用及其全部规则。
//
// 步骤：
//   1. 读取配置（不存在 → APP_NOT_FOUND）；读取关联规则用于响应计数与影响展示。
//   2. 解密旧 CorpSecret 仅用于事务提交后的 token 清理，不写日志、不返回前端。
//   3. 调用 db.deleteConfigurationCascade(code, expectedVersion)，事务内重新校验版本。
//   4. **事务提交成功后**才清运行时缓存与失效旧 token。事务失败不得报告成功。
async function deleteConfiguration(code, expectedVersion) {
    const config = await db.getConfigurationByCode(code);
    if (!config) {
        throw createError('无效的code，未找到配置', 404, 'APP_NOT_FOUND');
    }
    const expectedVersionNum = parseExpectedVersion({ expectedVersion });
    if (expectedVersionNum === null) {
        throw createError('缺少版本号，请刷新后重试', 428, 'APP_VERSION_REQUIRED');
    }

    // 解密旧 secret 仅用于 token 清理；失败不阻断删除。
    // 多应用（二次复验 P0-01）：用 decryptOnly（不触发迁移），避免与并发业务写入竞争。
    let oldSecret = null;
    try {
        oldSecret = decryptOnly(config.encrypted_corpsecret);
    } catch (_e) { /* 尽力清理，不影响删除 */ }

    let cascadeResult;
    try {
        cascadeResult = await db.deleteConfigurationCascade(code, expectedVersionNum);
    } catch (err) {
        // 翻译 DAO 抛出的稳定删除原因。
        if (err && err.__deleteCause === 'missing') {
            throw createError('无效的code，未找到配置', 404, 'APP_NOT_FOUND');
        }
        if (err && err.__deleteCause === 'version') {
            const refreshed = await db.getConfigurationByCode(code);
            throw createError('应用已在其他页面更新，请加载最新值后重新确认', 409, 'APP_VERSION_CONFLICT', {
                version: Number(refreshed && refreshed.version) || 1
            });
        }
        throw err;
    }

    // 事务提交成功后才清理缓存与 token（资源/一致性收口）。
    clearRuntimeCaches();
    if (oldSecret) {
        try { wechat.invalidateToken(config.corpid, oldSecret); } catch (_e) { /* ignore */ }
    }

    return {
        code,
        configurations_deleted: cascadeResult.configurations_deleted,
        rules_deleted: cascadeResult.rules_deleted
    };
}

// SEC-009：EncodingAESKey 必须为 43 位，且仅含字母数字。
const AES_KEY_RE = /^[A-Za-z0-9]{43}$/;
function validateEncodingAesKey(value) {
    return typeof value === 'string' && AES_KEY_RE.test(value);
}

// 运行时缓存纪元：clear 时递增。异步 resolve 在 setCached 前比对 epoch，
// 避免“读旧快照 → 写路径 clear → 旧结果 setCached”把过期接收人重新灌回缓存。
let runtimeCacheEpoch = 0;

function getCached(map, key) {
    const cached = map.get(key);
    if (!cached || cached.expires <= Date.now()) {
        map.delete(key);
        return null;
    }
    return cached.value;
}

function setCached(map, key, value, ttlMs) {
    if (ttlMs <= 0) return value;
    map.set(key, {
        value,
        expires: Date.now() + ttlMs
    });
    return value;
}

// 仅在 clear 未发生时写入缓存；epoch 已前进则返回 value 但不污染 Map。
function setCachedIfCurrent(map, key, value, ttlMs, epoch) {
    if (epoch !== runtimeCacheEpoch) return value;
    return setCached(map, key, value, ttlMs);
}

function clearRuntimeCaches() {
    runtimeCacheEpoch += 1;
    targetCache.clear();
    memberListCache.clear();
    sendResultCache.clear();
    // 禁止 clear inflightSends：管理写路径 clear 时若抹掉 in-flight 合并键，
    // 并发相同 payload 会再次 executeSend，导致企业微信重复发送（SEC-010 不变量）。
    // in-flight Promise 自身在 finally 中 delete 键；配置变更后新请求会重新 resolve target。
}

function estimateRecipientCount(recipient, fallback = 1) {
    if (recipient.is_all) return Math.max(1, Number(fallback) || 1);
    const userCount = normalizeScopeList(recipient.touser).length;
    const partyCount = normalizeScopeList(recipient.toparty).length;
    const tagCount = normalizeScopeList(recipient.totag).length;
    if (partyCount > 0 || tagCount > 0) {
        return Math.max(1, Number(fallback) || userCount || 1);
    }
    return Math.max(1, userCount || Number(fallback) || 1);
}

function normalizeRulePayload(payload, existing = {}) {
    // SEC-009：严格布尔语义。未提供时继承 existing，再无则默认 false。
    let isAllRaw;
    if (payload.is_all !== undefined) {
        isAllRaw = payload.is_all;
    } else if (payload.isAll !== undefined) {
        isAllRaw = payload.isAll;
    } else if (existing.is_all !== undefined && existing.is_all !== null) {
        isAllRaw = existing.is_all;
    } else {
        isAllRaw = false;
    }
    const isAllStrict = toStrictBoolean(isAllRaw);
    if (isAllStrict === null) {
        throw createError('is_all 必须为布尔值', 400);
    }
    const isAll = isAllStrict;
    const name = String(payload.name !== undefined ? payload.name : existing.name || '').trim();
    if (!name) {
        throw createError('规则名称不能为空', 400);
    }

    const touser = isAll ? [] : normalizeScopeList(payload.touser !== undefined ? payload.touser : existing.touser);
    const toparty = isAll ? [] : normalizeScopeList(payload.toparty !== undefined ? payload.toparty : existing.toparty);
    const totag = isAll ? [] : normalizeScopeList(payload.totag !== undefined ? payload.totag : existing.totag);
    if (!isAll && touser.length === 0 && toparty.length === 0 && totag.length === 0) {
        throw createError('请至少配置一个接收范围', 400);
    }

    const estimatedRaw = payload.estimated_count !== undefined
        ? payload.estimated_count
        : (payload.estimatedCount !== undefined ? payload.estimatedCount : existing.estimated_count);
    const fallbackEstimate = isAll ? 1 : touser.length || 1;
    const estimatedCount = Math.max(1, Number.parseInt(estimatedRaw, 10) || fallbackEstimate);

    return {
        name,
        touser: touser.join('|'),
        toparty: toparty.join('|'),
        totag: totag.join('|'),
        is_all: isAll ? 1 : 0,
        estimated_count: estimatedCount
    };
}

function serializeRule(row) {
    return {
        id: row.id,
        config_code: row.config_code,
        api_code: row.api_code,
        apiUrl: `/api/notify/${row.api_code}`,
        name: row.name,
        touser: normalizeScopeList(row.touser),
        toparty: normalizeScopeList(row.toparty),
        totag: normalizeScopeList(row.totag),
        is_all: row.is_all === 1 || row.is_all === true,
        estimated_count: Number(row.estimated_count) || 1,
        enabled: row.enabled === null || row.enabled === undefined ? true : (row.enabled === 1 || row.enabled === true),
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

function recipientFromRule(rule) {
    return {
        is_all: rule.is_all === 1 || rule.is_all === true,
        touser: rule.touser || '',
        toparty: rule.toparty || '',
        totag: rule.totag || ''
    };
}

function recipientFromConfig(config) {
    return {
        is_all: config.touser === '@all',
        touser: config.touser || '',
        toparty: '',
        totag: ''
    };
}

function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function getWindowEntries(map, key, windowMs) {
    const now = Date.now();
    const current = map.get(key) || [];
    const kept = current.filter(item => item > now - windowMs);
    map.set(key, kept);
    return kept;
}

function trackAppDaily(config, estimatedCount) {
    if (APP_DAILY_PERSON_LIMIT <= 0) return;

    const key = `${config.corpid}:${config.agentid}`;
    const now = Date.now();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const current = appDailyWindows.get(key);
    const bucket = current && current.dayStart === dayStart.getTime()
        ? current
        : { dayStart: dayStart.getTime(), count: 0 };

    if (bucket.count + estimatedCount > APP_DAILY_PERSON_LIMIT) {
        throw createError('已接近企业微信应用消息每日人次限制，请稍后再发送', 429);
    }

    bucket.count += estimatedCount;
    appDailyWindows.set(key, bucket);
}

// REV-006：预占成员频率额度，返回 reservation receipt（含精确时间戳），
// 供失败时精确回滚。避免用 Date.now() 重新取值导致找不到原记录。
function trackExplicitMembers(config, recipient) {
    if (recipient.is_all || recipient.toparty || recipient.totag) return null;

    const users = normalizeScopeList(recipient.touser);
    for (const userid of users) {
        const key = `${config.corpid}:${config.agentid}:${userid}`;
        const minuteEntries = getWindowEntries(memberWindows, `${key}:minute`, 60000);
        if (MEMBER_MINUTE_LIMIT > 0 && minuteEntries.length >= MEMBER_MINUTE_LIMIT) {
            throw createError(`成员 ${userid} 已达到企业微信每分钟接收频率保护`, 429);
        }

        const hourEntries = getWindowEntries(memberWindows, `${key}:hour`, 3600000);
        if (MEMBER_HOUR_LIMIT > 0 && hourEntries.length >= MEMBER_HOUR_LIMIT) {
            throw createError(`成员 ${userid} 已达到企业微信每小时接收频率保护`, 429);
        }
    }

    // 用单调时间戳，确保回滚能精确定位。
    const ts = Date.now();
    const reservations = [];
    for (const userid of users) {
        const key = `${config.corpid}:${config.agentid}:${userid}`;
        const minuteList = memberWindows.get(`${key}:minute`);
        const hourList = memberWindows.get(`${key}:hour`);
        minuteList.push(ts);
        hourList.push(ts);
        reservations.push({ minuteKey: `${key}:minute`, hourKey: `${key}:hour`, ts });
    }
    return reservations;
}

// REV-006：按 receipt 精确回滚预占的成员频率额度。
function rollbackMemberReservation(reservations) {
    if (!Array.isArray(reservations)) return;
    for (const r of reservations) {
        const minuteList = memberWindows.get(r.minuteKey);
        if (Array.isArray(minuteList)) {
            const idx = minuteList.lastIndexOf(r.ts);
            if (idx >= 0) minuteList.splice(idx, 1);
        }
        const hourList = memberWindows.get(r.hourKey);
        if (Array.isArray(hourList)) {
            const idx = hourList.lastIndexOf(r.ts);
            if (idx >= 0) hourList.splice(idx, 1);
        }
    }
}

function assertNotInBackoff(config) {
    const key = `${config.corpid}:${config.agentid}`;
    const until = backoffWindows.get(key);
    if (until && until > Date.now()) {
        throw createError('企业微信返回限频，当前应用暂时进入退避保护', 429);
    }
    if (until) {
        backoffWindows.delete(key);
    }
}

function enterBackoff(config) {
    const key = `${config.corpid}:${config.agentid}`;
    backoffWindows.set(key, Date.now() + RATE_BACKOFF_MS);
}

function isContactPrivilegeError(err) {
    const message = err && err.message || '';
    return message.includes('60011') || message.includes('no privilege to access/modify contact/party/agent');
}

function formatMemberForResponse(user) {
    const userid = String(user && user.userid || '').trim();
    if (!userid) return null;
    const name = user.name || user.displayName || userid;
    return {
        userid,
        name,
        displayName: name
    };
}

function fallbackMembersFromCurrent(current) {
    return current.map(userid => ({
        userid,
        name: userid,
        displayName: userid
    }));
}

function generateId() {
    return crypto.randomUUID();
}

/**
 * 创建回调配置（第一步）
 *
 * 多应用（2026-07-04 §5.2）：
 *   - 不再用 callback_enabled=1 判断草稿（会把同企业已完成应用误命中）。
 *   - 没有 draft_code 且没有草稿：创建新草稿，返回初始 version=1。
 *   - 没有 draft_code 但已有同企业草稿：返回 409 APP_DRAFT_EXISTS + details.existing_code。
 *   - 传入 draft_code：仅更新同一 corpid 的现有草稿回调凭证（阶段2补充版本校验）。
 */
async function createCallbackConfiguration(configInput) {
    const { corpid, callback_token, encoding_aes_key, draft_code, version } = configInput;
    if (!corpid || !callback_token || !encoding_aes_key) {
        throw createError('回调配置参数不完整', 400, 'INVALID_INPUT');
    }
    if (!validateEncodingAesKey(encoding_aes_key)) {
        throw createError('EncodingAESKey 必须为 43 位字母数字字符', 400, 'INVALID_INPUT');
    }

    const cryptoSvc = getCrypto();
    // SEC-005：回调 Token 与 AESkey 均加密存储。
    const encrypted_callback_token = cryptoSvc.encrypt(callback_token);
    const encrypted_encoding_aes_key = cryptoSvc.encrypt(encoding_aes_key);

    // 传入 draft_code：仅允许更新同一 corpid 的现有草稿回调凭证。
    // 多应用（P0-04）：草稿更新必须校验 version（缺省 428，不匹配 409），走原子事务。
    if (draft_code) {
        // 先做 corpid 归属校验（事务外只读，与版本无关）。
        const existing = await db.getConfigurationByCode(draft_code);
        if (!existing) {
            throw createError('应用不存在', 404, 'APP_NOT_FOUND');
        }
        if (existing.corpid !== corpid) {
            throw createError('草稿不属于该企业', 409, 'APP_DRAFT_MISMATCH');
        }
        if (isCompletedConfig(existing)) {
            // 已完成应用不得通过本接口再次写入回调凭证。
            // 半完成配置（非 isDraft 但 isCompleted=false）仍允许更新，与 updateDraftCallbackAtomic 一致。
            throw createError('该应用已完成配置，不能再次写入', 409, 'APP_ALREADY_COMPLETED');
        }
        // 多应用（R-P1-05）：body version 三分——缺失/非法/合法。
        const parsed = parseBodyVersion(version);
        if (!parsed.provided) {
            throw createError('缺少版本号，请刷新后重试', 428, 'APP_VERSION_REQUIRED');
        }
        if (!parsed.valid) {
            // 多应用（二次复验 P1-02）：details.field='version' 让前端区分版本非法与普通字段错误。
            throw createError('版本号不合法', 400, 'INVALID_INPUT', { field: 'version' });
        }
        const expectedVersion = parsed.value;
        let updated;
        try {
            updated = await db.updateDraftCallbackAtomic(draft_code, {
                encrypted_callback_token,
                encrypted_encoding_aes_key,
                callback_enabled: 1
            }, expectedVersion);
        } catch (err) {
            const cause = err && err.__draftCause;
            if (cause === 'missing') throw createError('应用不存在', 404, 'APP_NOT_FOUND');
            if (cause === 'already_completed') throw createError('该应用已完成配置，不能再次写入', 409, 'APP_ALREADY_COMPLETED');
            if (cause === 'version_conflict') {
                throw createError('应用已在其他页面更新，请加载最新值后重新确认', 409, 'APP_VERSION_CONFLICT', {
                    version: Number(err.__currentVersion) || undefined
                });
            }
            throw err;
        }
        clearRuntimeCaches();
        return {
            code: draft_code,
            callbackUrl: `/api/callback/${draft_code}`,
            version: updated.version,
            lifecycle_status: 'draft'
        };
    }

    // 未传 draft_code：在事务内检查同 corpid 未完成草稿，无则 INSERT（原子）。
    const code = generateId();
    try {
        await db.createDraftCallbackAtomic({
            code,
            corpid,
            encrypted_callback_token,
            encrypted_encoding_aes_key
        });
    } catch (err) {
        if (err && err.__draftCreateCause === 'exists') {
            throw createError('该企业已有待完善应用', 409, 'APP_DRAFT_EXISTS', {
                existing_code: err.__existingCode
            });
        }
        throw err;
    }

    return {
        code,
        callbackUrl: `/api/callback/${code}`,
        version: 1,
        lifecycle_status: 'draft'
    };
}

/**
 * 完善配置（第二步）
 *
 * 多应用（2026-07-04 §5.3）：
 *   1. code 必须存在且仍是草稿；已完成应用返回 409 APP_ALREADY_COMPLETED。
 *   2. 复用 notifier 的 wechat 实例验证 corpid + corpsecret + agentid（收口 token 缓存）。
 *   3. 按 (corpid, agentid) 身份判重，冲突返回 409 APP_IDENTITY_CONFLICT + details.existing_code。
 *   4. 完成后返回标准化配置摘要。
 */
async function completeConfiguration(configInput) {
    const { code, corpsecret, agentid, touser, description, version } = configInput;
    if (!code || !corpsecret) {
        throw createError('参数不完整', 400, 'INVALID_INPUT');
    }
    const numericAgentid = parsePositiveInt(agentid);
    if (!numericAgentid) {
        throw createError('AgentID 必须为正整数', 400, 'INVALID_INPUT');
    }
    const touserList = normalizeTouser(touser);
    if (touserList.length === 0) {
        throw createError('请至少选择一个接收成员', 400, 'INVALID_INPUT');
    }

    const callbackConfig = await db.getConfigurationByCode(code);
    if (!callbackConfig) {
        throw createError('回调配置不存在，请先生成回调URL', 404, 'APP_NOT_FOUND');
    }
    // 多应用不变量 6：completeConfiguration 只能完成未完成应用（纯草稿或半完成）。
    // 必须用 isCompletedConfig：isDraftConfig 只匹配三项全缺，半完成配置会被误判为
    // APP_ALREADY_COMPLETED，与 DAO completeConfigurationAtomic（仅拦真正完成态）不一致，
    // 导致半完成应用既不能发送也不能完成，永久卡死。
    if (isCompletedConfig(callbackConfig)) {
        throw createError('该应用已完成配置，不能再次完成', 409, 'APP_ALREADY_COMPLETED', {
            existing_code: code
        });
    }

    // 多应用（R-P1-05）：body version 三分——缺失/非法/合法。
    const parsed = parseBodyVersion(version);
    if (!parsed.provided) {
        throw createError('缺少版本号，请刷新后重试', 428, 'APP_VERSION_REQUIRED');
    }
    if (!parsed.valid) {
        // 多应用（二次复验 P1-02）：details.field='version' 让前端区分版本非法与普通字段错误。
        throw createError('版本号不合法', 400, 'INVALID_INPUT', { field: 'version' });
    }
    const expectedVersion = parsed.value;

    // 多应用（二次复验 P1-07 + 第三轮 P1-04）：事务外只读版本快速失败——
    // 乐观锁要求任何不相等都冲突。旧实现用 expectedVersion < currentVersion，
    // 导致未来版本（999 > 当前 3）绕过快速检查，先调用企业微信再被 CAS 拒绝。
    // 改为严格不相等：低于或高于当前版本都立即冲突，只有完全相等才进入验证。
    // 注意：这只是优化，事务内 CAS 仍是权威校验，不能用快速检查替代原子校验。
    const currentVersion = Number(callbackConfig.version) || 1;
    if (expectedVersion !== currentVersion) {
        throw createError('应用已在其他页面更新，请加载最新值后重新确认', 409, 'APP_VERSION_CONFLICT', {
            version: currentVersion
        });
    }

    // 收口到 notifier 的 wechat 实例验证凭证，保证 token 缓存与发送共享。
    // 微信在线验证在事务外执行，避免长期持锁。
    await validateApplicationCredentials({
        corpid: callbackConfig.corpid,
        corpsecret,
        agentid: numericAgentid
    });

    const cryptoSvc = getCrypto();
    const encrypted_corpsecret = cryptoSvc.encrypt(corpsecret);
    const formattedTouser = touserList.join('|');

    // 多应用（P0-05）：数据库阶段原子化——事务内重新校验版本 + 身份判重 + UPDATE。
    // 通知密钥默认关闭：新配置不自动生成 notify_key。
    let completed;
    try {
        // 多应用（第三轮 P2-8）：删除 legacy_until 死参数（已从 DAO 白名单移除，传了也不写库）。
        completed = await db.completeConfigurationAtomic(code, {
            encrypted_corpsecret,
            agentid: numericAgentid,
            touser: formattedTouser,
            description: description || '',
            notify_key_hash: null
        }, expectedVersion, { numericAgentid });
    } catch (err) {
        const cause = err && err.__completeCause;
        if (cause === 'missing') throw createError('回调配置不存在，请先生成回调URL', 404, 'APP_NOT_FOUND');
        if (cause === 'already_completed') {
            throw createError('该应用已完成配置，不能再次完成', 409, 'APP_ALREADY_COMPLETED', { existing_code: code });
        }
        if (cause === 'version_conflict') {
            throw createError('应用已在其他页面更新，请加载最新值后重新确认', 409, 'APP_VERSION_CONFLICT', {
                version: Number(err.__currentVersion) || undefined
            });
        }
        if (cause === 'identity_conflict') {
            throw createError('该企业下此 AgentID 已绑定到其他应用', 409, 'APP_IDENTITY_CONFLICT', {
                existing_code: err.__existingCode
            });
        }
        throw err;
    }

    clearRuntimeCaches();

    return {
        code,
        apiUrl: `/api/notify/${code}`,
        notify_key_enabled: false,
        callbackUrl: `/api/callback/${code}`,
        version: completed.version,
        lifecycle_status: 'active'
    };
}

/**
 * 创建配置（原有方法，保持兼容性）
 */
async function createConfiguration(configInput) {
    const {
        corpid, corpsecret, agentid, touser, description,
        callback_token, encoding_aes_key, callback_enabled
    } = configInput;
    if (!corpid || !corpsecret) {
        throw createError('参数不完整', 400);
    }
    const numericAgentid = parsePositiveInt(agentid);
    if (!numericAgentid) {
        throw createError('AgentID 必须为正整数', 400);
    }
    const touserList = normalizeTouser(touser);
    if (touserList.length === 0) {
        throw createError('请至少选择一个接收成员', 400);
    }

    // SEC-009：启用回调时，Token + AESKey 必须作为原子配置组完整且合法。
    const callbackEnabledStrict = toStrictBoolean(callback_enabled);
    if (callback_enabled !== undefined && callbackEnabledStrict === null) {
        throw createError('callback_enabled 必须为布尔值', 400);
    }
    const wantCallback = callbackEnabledStrict === true;
    let encrypted_callback_token = null;
    let encrypted_encoding_aes_key = null;
    if (wantCallback) {
        if (!callback_token || !encoding_aes_key) {
            throw createError('启用回调时必须提供回调Token和EncodingAESKey', 400);
        }
        if (!validateEncodingAesKey(encoding_aes_key)) {
            throw createError('EncodingAESKey 必须为 43 位字母数字字符', 400);
        }
        const cryptoSvc = getCrypto();
        encrypted_callback_token = cryptoSvc.encrypt(callback_token);
        encrypted_encoding_aes_key = cryptoSvc.encrypt(encoding_aes_key);
    }

    // 与 completeConfiguration / 编辑改凭证一致：落库前在线校验 CorpID+Secret+AgentID，
    // 避免兼容入口 /api/configure 写入无效凭证并占用 (corpid, agentid) 身份位。
    await validateApplicationCredentials({
        corpid,
        corpsecret,
        agentid: numericAgentid
    });

    const formattedTouser = touserList.join('|');

    // 多应用（P0-05 §3.4）：身份判重必须按 (corpid, agentid)。
    // 设计不变量 3：同一 (corpid, agentid) 只能存在一个完成应用。
    // /api/configure（兼容入口）若同身份已有完成应用，返回 APP_IDENTITY_CONFLICT + existing_code。
    const existingConfig = await db.findCompletedByCorpidAgentId(corpid, numericAgentid, null);
    if (existingConfig) {
        throw createError('该企业下此 AgentID 已绑定到其他应用', 409, 'APP_IDENTITY_CONFLICT', {
            existing_code: existingConfig.code
        });
    }

    const cryptoSvc = getCrypto();
    const encrypted_corpsecret = cryptoSvc.encrypt(corpsecret);

    // 通知密钥默认关闭：新配置不自动生成 notify_key。
    // 需要时可在配置详情页手动启用（POST /api/configuration/:code/notify-key）。
    // 规范 §6.6：随机 Code 碰撞（与规则编号/退役编号冲突）时重试，不误报 APP_IDENTITY_CONFLICT。
    const MAX_CODE_GEN_RETRY = 5;
    let code = null;
    for (let attempt = 0; attempt < MAX_CODE_GEN_RETRY; attempt++) {
        code = generateId();
        try {
            await db.createConfigurationAtomic({
                code,
                corpid,
                encrypted_corpsecret,
                agentid: numericAgentid,
                touser: formattedTouser,
                description: description || '',
                encrypted_callback_token,
                encrypted_encoding_aes_key,
                callback_enabled: wantCallback ? 1 : 0,
                notify_key_hash: null
            });
            break;
        } catch (err) {
            // 并发期间另一请求已创建同 (corpid, agentid) 应用 → 返回身份冲突。
            if (err && err.__createCause === 'identity_conflict') {
                const refreshed = await db.findCompletedByCorpidAgentId(corpid, numericAgentid, null);
                throw createError('该企业下此 AgentID 已绑定到其他应用', 409, 'APP_IDENTITY_CONFLICT', {
                    existing_code: refreshed ? refreshed.code : (err.__existingCode || undefined)
                });
            }
            // 通知命名空间冲突（随机 Code 碰撞）：重试，不向用户报身份冲突。
            if (err && err.__createCause === 'notify_code_conflict') {
                continue;
            }
            throw err;
        }
    }
    if (code === null) {
        // 连续 5 次随机 Code 碰撞（概率极低）。
        throw createError('应用 Code 自动生成连续失败，请稍后重试', 503, 'APP_CODE_GENERATION_FAILED');
    }

    const result = {
        code,
        apiUrl: `/api/notify/${code}`,
        notify_key_enabled: false
    };
    if (wantCallback) {
        result.callbackUrl = `/api/callback/${code}`;
    }
    return result;
}

async function listRules(configCode) {
    const config = await db.getConfigurationByCode(configCode);
    if (!config) {
        throw createError('未找到配置', 404, 'APP_NOT_FOUND');
    }

    // 使用库内权威 code 列规则（大小写与写入时一致）；DAO 本身也 lower() 匹配。
    const rules = await db.listNotificationRules(config.code);
    // 多应用（§4.5 单一事实来源 + P1-03）：config 摘要复用统一序列化，
    // warnings（含 duplicate_identity）与总览/详情一致；规则页据此显示状态横幅。
    const duplicateMap = await computeDuplicateMapForCodes([config.code]);
    const summary = serializeConfigurationSummary(config, {
        ruleCounts: { [config.code]: { rule_count: rules.length, enabled_rule_count: rules.filter(r => r.enabled === 1 || r.enabled === true).length } },
        duplicateMap
    });
    summary.touser = normalizeTouser(config.touser);
    return {
        config: summary,
        rules: rules.map(serializeRule)
    };
}

// SEC-009：严格 completed 判定，需要密钥已配置、AgentID 为正整数、touser 非空。
function isCompletedConfig(row) {
    if (!row) return false;
    const hasSecret = typeof row.encrypted_corpsecret === 'string'
        && row.encrypted_corpsecret.length > 0;
    const agentOk = parsePositiveInt(row.agentid) !== null;
    const touserOk = normalizeTouser(row.touser).length > 0;
    return hasSecret && agentOk && touserOk;
}

async function listConfigurations() {
    const rows = await db.listConfigurations();

    // 多应用：批量读取规则聚合数与重复身份标记，避免列表 N+1。
    const codes = rows.map(r => r.code);
    const [ruleCounts, duplicateMap] = await Promise.all([
        db.countRulesByConfigCodes(codes),
        computeDuplicateIdentityMap(rows)
    ]);

    return {
        configurations: rows.map(row => serializeConfigurationSummary(row, { ruleCounts, duplicateMap }))
    };
}

// 多应用：按 (corpid, agentid) 分组找出超过一行的已完成应用，用于总览 duplicate_identity 标记。
// 仅做告警，不自动合并、不改变 lifecycle/capabilities。
async function computeDuplicateIdentityMap(rows) {
    const groups = new Map(); // "corpid|agentid" -> [code,...]
    for (const r of rows) {
        if (!isCompletedConfig(r)) continue;
        const key = `${r.corpid}|${Number(r.agentid) || 0}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r.code);
    }
    const map = {};
    for (const codes of groups.values()) {
        if (codes.length > 1) {
            for (const code of codes) map[code] = true;
        }
    }
    return map;
}

// 多应用（P1-03 §3.7）：为给定 code 列表查询重复身份标记，供详情/规则页与总览一致显示。
// 复用 DAO findDuplicatesByCorpidAgentId：读取应用 → 找同 (corpid, agentid) 完成应用 → 标记。
async function computeDuplicateMapForCodes(codes) {
    if (!codes || codes.length === 0) return {};
    const map = {};
    for (const code of codes) {
        const config = await db.getConfigurationByCode(code);
        if (!config || !isCompletedConfig(config)) continue;
        const dups = await db.findDuplicatesByCorpidAgentId(config.corpid, Number(config.agentid) || 0);
        // 仅当同身份存在多于一行时标记（自身 + 其他）。
        if (dups && dups.length > 1) {
            for (const row of dups) map[row.code] = true;
        }
    }
    return map;
}

// 多应用（§3.3 P0-03）：规则变更与应用聚合版本原子提交。
// 所有规则写操作必须：
//   - 携带 expectedVersion（缺省 428，由路由 requireIfMatch 拦截）；
//   - 通过 db.mutateRuleWithAppVersion 在事务内执行规则变更 + 版本递增；
//   - 成功返回 app_version，任一步失败整体回滚。
// 统一错误翻译 helper：把 DAO 的 __ruleCause 翻译成稳定业务错误。
// 规范 §4.4：编号冲突（__ruleCause='notify_code_conflict'）翻译为 409 RULE_API_CODE_CONFLICT，
// 不携带 details.version，避免被 AppHttp.isVersionConflict 误判。
function translateRuleCause(err, defaultStatus = 500, defaultCode = 'INTERNAL_ERROR') {
    const cause = err && err.__ruleCause;
    if (!cause) {
        return createError(err && err.message ? err.message : '规则操作失败', defaultStatus, defaultCode);
    }
    if (cause === 'app_missing') return createError('无效的code，未找到配置', 404, 'APP_NOT_FOUND');
    if (cause === 'app_not_completed') return createError('应用尚未完成配置，不能管理规则', 409, 'APP_NOT_COMPLETED');
    if (cause === 'rule_missing') return createError('未找到规则', 404, 'RULE_NOT_FOUND');
    if (cause === 'notify_code_conflict') {
        // details.conflict_scope 仅返回必要信息，不泄漏占用对象详情。
        return createError('该编号已占用或已被保留，请更换', 409, 'RULE_API_CODE_CONFLICT', {
            api_code: err.__conflictCode || undefined,
            conflict_scope: err.__conflictScope || undefined
        });
    }
    if (cause === 'version_conflict') {
        return createError('应用已在其他页面更新，请加载最新值后重新确认', 409, 'APP_VERSION_CONFLICT', {
            version: Number(err.__currentVersion) || undefined
        });
    }
    return createError(err && err.message ? err.message : '规则操作失败', defaultStatus, defaultCode);
}

// 接收规则 API 自定义编号（规范 §7.2）：统一改号 helper。
// 在事务内完成“校验候选编号 → 恢复自己退役编号时删退役记录 → 退役旧编号 → 更新规则 api_code”。
// 任一步失败整体回滚（由 mutateRuleWithAppVersion 的外层事务保证）。
// reason: 'renamed'（手工改号）| 'regenerated'（随机重生成）。
async function changeRuleApiCodeInTransaction(tx, app, existingRule, nextApiCode, reason) {
    const ruleId = existingRule.id;
    const oldApiCode = existingRule.api_code;
    // 候选编号全局命名空间校验（规则/配置/退役编号）。
    const conflict = await db.inspectNotifyCodeConflict(tx, nextApiCode, { ruleId });
    if (conflict) {
        if (conflict.scope === 'retired' && conflict.reclaimable) {
            // 恢复当前规则自己的退役编号：删除该退役记录。
            await tx.run(
                'DELETE FROM retired_notify_codes WHERE lower(code) = ? AND owner_type = ? AND owner_id = ?',
                [nextApiCode.toLowerCase(), 'rule', String(ruleId)]
            );
        } else {
            const e = new Error('notify code conflict');
            e.__ruleCause = 'notify_code_conflict';
            e.__conflictCode = nextApiCode;
            e.__conflictScope = conflict.scope;
            throw e;
        }
    }
    // 旧编号登记为当前规则的退役编号（幂等）。
    await db.retireNotifyCode(tx, {
        code: oldApiCode,
        ownerType: 'rule',
        ownerId: String(ruleId),
        reason
    });
    // 更新规则 api_code。
    const upd = await tx.run(
        'UPDATE notification_rules SET api_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND lower(config_code) = lower(?)',
        [nextApiCode, ruleId, app.code]
    );
    if (upd.changes !== 1) {
        const e = new Error('rule missing');
        e.__ruleCause = 'rule_missing';
        throw e;
    }
}

async function createRule(configCode, payload, options = {}) {
    const expectedVersion = parseExpectedVersion(options);
    if (expectedVersion === null) {
        throw createError('缺少版本号，请刷新后重试', 428, 'APP_VERSION_REQUIRED');
    }
    const normalized = normalizeRulePayload(payload);
    // 规范 §7.4：未提供/空 -> 服务端生成 UUID；非空 -> 规范化校验。
    const provided = payload.api_code !== undefined
        && payload.api_code !== null
        && String(payload.api_code).trim() !== '';
    // 自动生成编号碰撞时的重试上限（规范 §4.2）。
    const MAX_CODE_GEN_RETRY = 5;
    let lastErr = null;
    for (let attempt = 0; attempt < MAX_CODE_GEN_RETRY; attempt++) {
        // 每轮重新生成候选编号（自动生成时）；自定义编号只在第一轮使用。
        const api_code = (provided && attempt === 0)
            ? notifyCode.normalizeRuleApiCode(payload.api_code)
            : notifyCode.generateNotifyCode();
        let result;
        try {
            result = await db.mutateRuleWithAppVersion(
                { configCode },
                expectedVersion,
                async (tx, app) => {
                    // 创建不允许借用旧规则 ID（reclaimable），故 ruleId=null。
                    const conflict = await db.inspectNotifyCodeConflict(tx, api_code, { ruleId: null });
                    if (conflict) {
                        const e = new Error('notify code conflict');
                        e.__ruleCause = 'notify_code_conflict';
                        e.__conflictCode = api_code;
                        e.__conflictScope = conflict.scope;
                        throw e;
                    }
                    // 写入库内权威 code（大小写），避免请求路径混大小写导致规则归属漂移。
                    const insert = await tx.run(
                        `INSERT INTO notification_rules (
                            config_code, api_code, name, touser, toparty, totag, is_all, estimated_count
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [app.code, api_code, normalized.name, normalized.touser, normalized.toparty,
                         normalized.totag, normalized.is_all || 0, normalized.estimated_count || 1]
                    );
                    return { id: insert.lastID, api_code };
                }
            );
        } catch (err) {
            lastErr = err;
            // 自定义编号冲突：直接翻译为 409，不重试。
            if (err && err.__ruleCause === 'notify_code_conflict') {
                throw translateRuleCause(err);
            }
            // 版本冲突：不重试（交给前端刷新）。
            if (err && err.__ruleCause === 'version_conflict') {
                throw translateRuleCause(err);
            }
            // 自动生成碰撞：仅当确为编号冲突（约束错误）时才重试，避免误把事务级
            // 故障（如版本递增失败、应用不存在）当成碰撞重试。
            const isCodeCollision = err
                && (err.code === 'SQLITE_CONSTRAINT'
                    || /NOTIFY_CODE_CONFLICT|UNIQUE|constraint/i.test(String(err && err.message || '')));
            if (!provided && isCodeCollision) {
                continue;
            }
            throw translateRuleCause(err);
        }
        clearRuntimeCaches();
        return {
            id: result.rule.id,
            api_code: result.rule.api_code,
            apiUrl: `/api/notify/${result.rule.api_code}`,
            app_version: result.app_version
        };
    }
    // 自定义编号连续冲突不应走到这里（已在循环内抛 409）；此处仅覆盖自动生成连续 5 次碰撞。
    throw createError('编号自动生成连续失败，请稍后重试', 503, 'RULE_API_CODE_GENERATION_FAILED');
}

async function updateRule(id, payload, options = {}) {
    const expectedVersion = parseExpectedVersion(options);
    if (expectedVersion === null) {
        throw createError('缺少版本号，请刷新后重试', 428, 'APP_VERSION_REQUIRED');
    }
    const numericId = Number(id);
    // 规范 §7.5：区分“省略 api_code（不改）”“显式空值（报错）”“合法值（改号）”。
    const hasApiCodeProp = Object.prototype.hasOwnProperty.call(payload, 'api_code');
    if (hasApiCodeProp) {
        const raw = payload.api_code;
        if (raw === undefined || raw === null || String(raw).trim() === '') {
            // 显式空值：编辑场景不能解释为“随机重生成”，直接报格式错误。
            throw createError('API 编号格式不合法', 400, 'RULE_API_CODE_INVALID', {
                field: 'api_code',
                min_length: notifyCode.MIN_LENGTH,
                max_length: notifyCode.MAX_LENGTH,
                allowed: '小写字母 a-z、数字 0-9、连字符 -、下划线 _'
            });
        }
    }
    let result;
    let refreshedApiCode = null;
    let apiCodeChanged = false;
    try {
        result = await db.mutateRuleWithAppVersion(
            { ruleId: numericId },
            expectedVersion,
            async (tx, app) => {
                // 事务内读取现有规则，用于 normalizeRulePayload 继承未变更字段。
                const existing = await tx.get(
                    'SELECT * FROM notification_rules WHERE id = ? AND lower(config_code) = lower(?)',
                    [numericId, app.code]
                );
                if (!existing) {
                    const e = new Error('rule missing');
                    e.__ruleCause = 'rule_missing';
                    throw e;
                }
                refreshedApiCode = existing.api_code;
                const normalized = normalizeRulePayload(payload, existing);
                // 处理 api_code：省略 -> 沿用；提供 -> 规范化 + 与当前比较决定是否改号。
                let nextApiCode = existing.api_code;
                if (hasApiCodeProp) {
                    nextApiCode = notifyCode.normalizeRuleApiCode(payload.api_code);
                }
                if (nextApiCode !== existing.api_code) {
                    // 改号：通过统一 helper 完成校验/退役/更新（任一步失败整体回滚）。
                    await changeRuleApiCodeInTransaction(tx, app, existing, nextApiCode, 'renamed');
                    refreshedApiCode = nextApiCode;
                    apiCodeChanged = true;
                }
                // 单次 UPDATE 写入全部规则字段（name/touser/toparty/totag/is_all/estimated_count）。
                const insert = await tx.run(
                    `UPDATE notification_rules
                     SET name = ?, touser = ?, toparty = ?, totag = ?,
                         is_all = ?, estimated_count = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND lower(config_code) = lower(?)`,
                    [normalized.name, normalized.touser, normalized.toparty, normalized.totag,
                     normalized.is_all || 0, normalized.estimated_count || 1, numericId, app.code]
                );
                if (insert.changes !== 1) {
                    const e = new Error('rule missing');
                    e.__ruleCause = 'rule_missing';
                    throw e;
                }
                return { id: numericId };
            }
        );
    } catch (err) {
        throw translateRuleCause(err);
    }
    clearRuntimeCaches();
    return {
        id: numericId,
        api_code: refreshedApiCode,
        apiUrl: refreshedApiCode ? `/api/notify/${refreshedApiCode}` : undefined,
        api_code_changed: apiCodeChanged,
        app_version: result.app_version
    };
}

async function regenerateRuleApiCode(id, options = {}) {
    const expectedVersion = parseExpectedVersion(options);
    if (expectedVersion === null) {
        throw createError('缺少版本号，请刷新后重试', 428, 'APP_VERSION_REQUIRED');
    }
    const numericId = Number(id);
    // 规范 §7.6：复用统一改号逻辑（changeRuleApiCodeInTransaction），reason='regenerated'。
    // 随机碰撞最多重试 5 次（规范 §4.2）。
    // 仅编号碰撞可重试；app_missing / app_not_completed / version_conflict / rule_missing
    // 必须立即翻译返回，不得吞成 RULE_API_CODE_GENERATION_FAILED。
    const MAX_CODE_GEN_RETRY = 5;
    let result;
    let finalApiCode = null;
    let lastCollision = null;
    for (let attempt = 0; attempt < MAX_CODE_GEN_RETRY; attempt++) {
        const candidateCode = notifyCode.generateNotifyCode();
        try {
            result = await db.mutateRuleWithAppVersion(
                { ruleId: numericId },
                expectedVersion,
                async (tx, app) => {
                    const existing = await tx.get(
                        'SELECT id, api_code FROM notification_rules WHERE id = ? AND lower(config_code) = lower(?)',
                        [numericId, app.code]
                    );
                    if (!existing) {
                        const e = new Error('rule missing');
                        e.__ruleCause = 'rule_missing';
                        throw e;
                    }
                    await changeRuleApiCodeInTransaction(tx, app, existing, candidateCode, 'regenerated');
                    return { id: numericId };
                }
            );
        } catch (err) {
            const cause = err && err.__ruleCause;
            // 稳定业务失败：立即翻译，不重试。
            if (cause === 'version_conflict' || cause === 'rule_missing'
                || cause === 'app_missing' || cause === 'app_not_completed') {
                throw translateRuleCause(err);
            }
            // 编号碰撞（随机 UUID 概率极低）或唯一约束/触发器冲突：重试。
            const msg = String(err && err.message || '');
            if (cause === 'notify_code_conflict'
                || msg.includes('UNIQUE')
                || msg.includes('NOTIFY_CODE_CONFLICT')
                || (err && err.code === 'SQLITE_CONSTRAINT')) {
                lastCollision = err;
                continue;
            }
            // 其它未知错误：原样翻译，禁止掩成 503 生成失败。
            throw translateRuleCause(err);
        }
        finalApiCode = candidateCode;
        break;
    }
    if (!result) {
        if (lastCollision && lastCollision.__ruleCause === 'notify_code_conflict') {
            throw translateRuleCause(lastCollision);
        }
        throw createError('编号自动生成连续失败，请稍后重试', 503, 'RULE_API_CODE_GENERATION_FAILED');
    }
    clearRuntimeCaches();
    return {
        id: numericId,
        api_code: finalApiCode,
        apiUrl: `/api/notify/${finalApiCode}`,
        app_version: result.app_version
    };
}

async function deleteRule(id, options = {}) {
    const expectedVersion = parseExpectedVersion(options);
    if (expectedVersion === null) {
        throw createError('缺少版本号，请刷新后重试', 428, 'APP_VERSION_REQUIRED');
    }
    const numericId = Number(id);
    let result;
    let deletedApiCode = null;
    try {
        result = await db.mutateRuleWithAppVersion(
            { ruleId: numericId },
            expectedVersion,
            async (tx, app) => {
                const existing = await tx.get(
                    'SELECT api_code FROM notification_rules WHERE id = ? AND lower(config_code) = lower(?)',
                    [numericId, app.code]
                );
                if (!existing) {
                    const e = new Error('rule missing');
                    e.__ruleCause = 'rule_missing';
                    throw e;
                }
                deletedApiCode = existing.api_code;
                // 规范 §6.5：删除前登记退役编号（reason='deleted'），避免旧调用方误投到新规则。
                await db.retireNotifyCode(tx, {
                    code: existing.api_code,
                    ownerType: 'rule',
                    ownerId: String(numericId),
                    reason: 'deleted'
                });
                const del = await tx.run(
                    'DELETE FROM notification_rules WHERE id = ? AND lower(config_code) = lower(?)',
                    [numericId, app.code]
                );
                if (del.changes !== 1) {
                    const e = new Error('rule missing');
                    e.__ruleCause = 'rule_missing';
                    throw e;
                }
                return { id: numericId };
            }
        );
    } catch (err) {
        throw translateRuleCause(err);
    }
    clearRuntimeCaches();
    return { id: numericId, api_code: deletedApiCode, app_version: result.app_version };
}

// 规则启停：禁用的规则其 API 地址发送返回 403，但规则本身保留（区别于删除）。
// 多应用（P0-03）：属应用聚合写，必须按 If-Match 校验版本，与版本递增原子提交。
async function setRuleEnabled(id, enabled, options = {}) {
    const expectedVersion = parseExpectedVersion(options);
    if (expectedVersion === null) {
        throw createError('缺少版本号，请刷新后重试', 428, 'APP_VERSION_REQUIRED');
    }
    // 严格布尔解析：拒绝 "false" 字符串等模糊值。
    const strict = toStrictBoolean(enabled);
    if (strict === null) {
        throw createError('规则开关必须为布尔值', 400, 'INVALID_INPUT');
    }
    const value = strict ? 1 : 0;
    const numericId = Number(id);
    let result;
    try {
        result = await db.mutateRuleWithAppVersion(
            { ruleId: numericId },
            expectedVersion,
            async (tx, app) => {
                const existing = await tx.get(
                    'SELECT id FROM notification_rules WHERE id = ? AND lower(config_code) = lower(?)',
                    [numericId, app.code]
                );
                if (!existing) {
                    const e = new Error('rule missing');
                    e.__ruleCause = 'rule_missing';
                    throw e;
                }
                const upd = await tx.run(
                    'UPDATE notification_rules SET enabled = ? WHERE id = ? AND lower(config_code) = lower(?)',
                    [value, numericId, app.code]
                );
                if (upd.changes !== 1) {
                    const e = new Error('rule missing');
                    e.__ruleCause = 'rule_missing';
                    throw e;
                }
                return { id: numericId };
            }
        );
    } catch (err) {
        throw translateRuleCause(err);
    }
    clearRuntimeCaches();
    return { id: numericId, enabled: strict, app_version: result.app_version };
}

async function resolveNotificationTarget(code) {
    const cached = getCached(targetCache, code);
    if (cached) return cached;

    // 在任何 await 之前捕获纪元，避免 clear 后把旧 DB 快照重新写入缓存。
    const epoch = runtimeCacheEpoch;

    // 规范 §7.7：解析逻辑只实现一次。规则优先，但若遗留数据导致同一编号同时命中
    // 规则与配置，必须拒绝发送（不能再依赖“规则优先”静默劫持），抛 500 命名空间损坏。
    const rule = await db.getNotificationRuleByApiCode(code);
    if (rule) {
        const config = await db.getConfigurationByCode(rule.config_code);
        if (!config) {
            throw createError('规则关联的配置不存在', 404);
        }
        // 同时命中配置 Code：命名空间损坏，拒绝发送。
        // 编号比较 ASCII 大小写不敏感（与 ux_*_nocase / getConfigurationByCode 一致），
        // 不能用 directConfig.code === code 精确相等，否则 OPS-ALERT vs ops-alert 会漏检。
        const directConfig = await db.getConfigurationByCode(code).catch(() => null);
        if (directConfig
            && String(directConfig.code).toLowerCase() === String(code).toLowerCase()) {
            throw createError(
                '通知编号命名空间损坏：同一编号同时被规则与配置占用',
                500,
                'NOTIFY_CODE_NAMESPACE_CORRUPTED'
            );
        }

        const recipient = recipientFromRule(rule);
        const target = {
            kind: 'rule',
            requestedCode: code,
            config,
            rule,
            recipient,
            estimatedCount: estimateRecipientCount(recipient, rule.estimated_count),
            cacheScope: `rule:${rule.id}:${rule.api_code}`
        };
        return setCachedIfCurrent(targetCache, code, target, CONFIG_CACHE_TTL_MS, epoch);
    }

    const config = await db.getConfigurationByCode(code);
    if (!config) {
        throw createError('无效的code，未找到配置', 404);
    }

    const recipient = recipientFromConfig(config);
    const target = {
        kind: 'configuration',
        requestedCode: code,
        config,
        rule: null,
        recipient,
        estimatedCount: estimateRecipientCount(recipient),
        cacheScope: `config:${config.code}`
    };
    return setCachedIfCurrent(targetCache, code, target, CONFIG_CACHE_TTL_MS, epoch);
}

// 接收规则 API 自定义编号（规范 §7.8）：可用性预检。
// 只读检查，不入事务写；最终保存时仍由创建/更新事务重新校验。
// ruleId 可选：编辑时传当前规则 ID（用于判断“当前值/自己的退役值”），新建时不传。
// 非法格式抛 400 RULE_API_CODE_INVALID；合法返回 { api_code, available, reason }。
// reason: null（可用）/ 'rule' / 'configuration' / 'retired'。不返回占用对象详情。
async function checkNotifyCodeAvailability(rawApiCode, ruleId = null) {
    const apiCode = notifyCode.normalizeRuleApiCode(rawApiCode);
    let conflict = null;
    await db.withTransaction(async (tx) => {
        conflict = await db.inspectNotifyCodeConflict(tx, apiCode, { ruleId });
    });
    // 命中当前规则自己的当前编号或自己的退役编号（reclaimable）-> 视为可用。
    if (!conflict || (conflict.scope === 'retired' && conflict.reclaimable)) {
        return { api_code: apiCode, available: true, reason: null };
    }
    return { api_code: apiCode, available: false, reason: conflict.scope };
}

function buildSendCacheKey(target, title, content, options) {
    return stableStringify({
        scope: target.cacheScope,
        recipient: target.recipient,
        title,
        content,
        msgType: options.msgType,
        mediaId: options.mediaId,
        url: options.url,
        btntxt: options.btntxt,
        articles: options.articles,
        safe: options.safe
    });
}

/**
 * 发送通知
 *
 * SEC-010：额度预占改为“先校验、成功后确认”，失败回滚；
 *         并发相同请求通过 in-flight 合并，最多一次实际发送。
 */
async function sendNotification(code, title, content, options = {}) {
    const {
        msgType = 'text',
        mediaId,
        url,
        btntxt,
        articles,
        safe = 0,
        force = false
    } = options;

    const target = await resolveNotificationTarget(code);
    const config = target.config;

    // 多应用（§4.4 / §6.5 防绕过）：service 层独立校验应用总开关与草稿状态，
    // 防止未来内部调用绕过 HTTP 路由的 resolveNotifyAuth。
    assertSendAllowed(config, target.rule);

    // SEC-010：在额度预占与企业微信调用前完成全部消息类型校验。
    validateMessagePayload({ msgType, title, content, mediaId, url, btntxt, articles });

    const sendOptions = { msgType, mediaId, url, btntxt, articles, safe };
    const cacheKey = buildSendCacheKey(target, title, content, sendOptions);
    if (!force) {
        const cachedResult = getCached(sendResultCache, cacheKey);
        if (cachedResult) {
            return { ...cachedResult, cached: true };
        }
        // SEC-010：并发相同请求合并，避免去重缓存写入前重复发送。
        const inflight = inflightSends.get(cacheKey);
        if (inflight) {
            return { ...await inflight, merged: true };
        }
    }

    const promise = executeSend(target, title, content, sendOptions, cacheKey, force);
    if (!force) {
        // SEC-010：并发相同请求合并，避免去重缓存写入前重复发送。
        // 注意：用包装后的 promise 做 in-flight 键，原 promise 直接返回，避免
        // .finally 产生的派生 rejection 成为 unhandledRejection。
        const tracked = promise.then(
            (value) => { inflightSends.delete(cacheKey); return value; },
            (err) => { inflightSends.delete(cacheKey); throw err; }
        );
        tracked.catch(() => {}); // 自身吞掉派生 rejection，错误仍由 promise 传递给调用方
        inflightSends.set(cacheKey, tracked);
    }
    return promise;
}

function validateMessagePayload({ msgType, title, content, mediaId, url, articles }) {
    const allowed = ['text', 'markdown', 'image', 'file', 'textcard', 'news'];
    if (!allowed.includes(msgType)) {
        throw createError(`不支持的消息类型: ${msgType}`, 400);
    }
    if (msgType === 'text' || msgType === 'markdown') {
        if (!content) throw createError('消息内容不能为空', 400);
    }
    if (msgType === 'image' || msgType === 'file') {
        if (!mediaId) throw createError(msgType === 'image' ? '图片消息需要提供media_id' : '文件消息需要提供media_id', 400);
    }
    if (msgType === 'textcard') {
        if (!title || !content || !url) {
            throw createError('文本卡片消息需要提供title、content和url', 400);
        }
    }
    if (msgType === 'news') {
        if (!Array.isArray(articles) || articles.length === 0) {
            throw createError('图文消息需要提供articles数组', 400);
        }
        for (const article of articles) {
            if (!article || typeof article !== 'object'
                || typeof article.title !== 'string' || !article.title
                || typeof article.url !== 'string' || !article.url) {
                throw createError('图文消息每项必须包含非空 title 和 url', 400);
            }
        }
    }
}

async function executeSend(target, title, content, sendOptions, cacheKey, force) {
    const config = target.config;

    assertNotInBackoff(config);
    // SEC-010 / REV-006：先校验限频是否允许，预占额度并记录 reservation receipt。
    // 多应用（二次复验 P1-05）：trackExplicitMembers 可能抛错（成员限频），
    // 此时 trackAppDaily 的当日额度预占必须回滚，否则失败发送会永久占用当日额度。
    // 用 memberReservation=null 表示尚未预占成员额度，回滚只退当日额度。
    trackAppDaily(config, target.estimatedCount);
    let memberReservation = null;
    try {
        memberReservation = trackExplicitMembers(config, target.recipient);
    } catch (limitErr) {
        // 成员限频失败：回滚刚预占的当日额度，再抛出限频错误。
        rollbackReservation(config, target, null);
        throw limitErr;
    }

    let corpsecret;
    try {
        corpsecret = decryptWithLazyMigration('encrypted_corpsecret', config.encrypted_corpsecret, config.code);
    } catch (err) {
        rollbackReservation(config, target, memberReservation);
        throw createError('配置密钥解密失败，请检查 ENCRYPTION_KEY', 500);
    }

    let result;
    try {
        // SEC-008：发送与成员读取一致，access_token 失效时清缓存并仅重试一次。
        result = await wechat.withTokenRetry(config.corpid, corpsecret, async (accessToken) => {
            return dispatchMessage(wechat, accessToken, config.agentid, target.recipient, title, content, sendOptions);
        });
    } catch (err) {
        // SEC-010 / REV-006：网络/调用失败按 receipt 精确回滚额度，避免幽灵额度。
        rollbackReservation(config, target, memberReservation);
        if ((err.message || '').includes('45009')) {
            enterBackoff(config);
            const rateErr = createError(err.message || '企业微信频率限制', 429);
            throw rateErr;
        }
        // 凭证/上游错误归一化为稳定业务码，避免裸 Error 变成 500 INTERNAL_ERROR。
        throw wrapWeChatError(err);
    }

    setCached(sendResultCache, cacheKey, result, SEND_DEDUP_TTL_MS);
    return result;
}

// REV-006：按 reservation receipt 精确回滚额度。
function rollbackReservation(config, target, memberReservation) {
    if (APP_DAILY_PERSON_LIMIT > 0) {
        const key = `${config.corpid}:${config.agentid}`;
        const bucket = appDailyWindows.get(key);
        if (bucket) {
            bucket.count = Math.max(0, bucket.count - (target.estimatedCount || 1));
        }
    }
    rollbackMemberReservation(memberReservation);
}

async function dispatchMessage(wechat, accessToken, agentid, recipient, title, content, options) {
    const { msgType, mediaId, url, btntxt, articles, safe } = options;
    switch (msgType) {
        case 'text': {
            const message = title ? `${title}\n${content}` : content;
            return wechat.sendTextMessage(accessToken, agentid, recipient, message, safe);
        }
        case 'markdown': {
            const markdownContent = title ? `**${title}**\n\n${content}` : content;
            return wechat.sendMarkdownMessage(accessToken, agentid, recipient, markdownContent, safe);
        }
        case 'image':
            return wechat.sendImageMessage(accessToken, agentid, recipient, mediaId, safe);
        case 'file':
            return wechat.sendFileMessage(accessToken, agentid, recipient, mediaId, safe);
        case 'textcard':
            return wechat.sendTextCardMessage(accessToken, agentid, recipient, title, content, url, btntxt, safe);
        case 'news':
            return wechat.sendNewsMessage(accessToken, agentid, recipient, articles, safe);
        default:
            throw createError(`不支持的消息类型: ${msgType}`, 400);
    }
}

async function getConfigMembers(code, options = {}) {
    if (!code) {
        // 多应用（二次复验 P1-06）：补稳定 code。
        throw createError('无效的code，未找到配置', 404, 'APP_NOT_FOUND');
    }

    const config = await db.getConfigurationByCode(code);
    if (!config) {
        // 多应用（二次复验 P1-06）：补稳定 code。
        throw createError('无效的code，未找到配置', 404, 'APP_NOT_FOUND');
    }

    const current = normalizeTouser(config.touser);
    if (!config.encrypted_corpsecret || !parsePositiveInt(config.agentid) || current.length === 0) {
        // 多应用（二次复验 P1-06）：未完成改 409 APP_NOT_COMPLETED，与其它接口语义一致。
        throw createError('应用尚未完成配置', 409, 'APP_NOT_COMPLETED');
    }

    const cacheKey = `${config.corpid}:${config.agentid}`;
    const memberEpoch = runtimeCacheEpoch;
    let memberData = options.refresh ? null : getCached(memberListCache, cacheKey);
    if (Array.isArray(memberData)) {
        memberData = { users: memberData, warning: '' };
    }

    if (!memberData) {
        try {
            const cryptoSvc = getCrypto();
            const corpsecret = decryptWithLazyMigration('encrypted_corpsecret', config.encrypted_corpsecret, config.code);
            // REV-009：读取类调用接入 token 失效单次刷新重试。
            const memberResult = await wechat.withTokenRetry(config.corpid, corpsecret, async (accessToken) => {
                const agentInfo = await wechat.getAgentInfo(accessToken, config.agentid);
                return wechat.getAgentVisibleUsers(accessToken, agentInfo);
            });
            memberData = { users: memberResult, warning: '' };
        } catch (err) {
            if (!isContactPrivilegeError(err)) throw err;
            memberData = {
                users: fallbackMembersFromCurrent(current),
                warning: '企业微信未授权读取通讯录，已仅显示当前配置中的 UserID。'
            };
        }
        setCachedIfCurrent(memberListCache, cacheKey, memberData, MEMBER_CACHE_TTL_MS, memberEpoch);
    }

    const users = Array.isArray(memberData.users) ? memberData.users : [];
    const formattedUsers = users
        .map(formatMemberForResponse)
        .filter(Boolean);
    const visibleUserids = new Set(formattedUsers.map(user => user.userid));

    return {
        users: formattedUsers,
        current,
        orphan: current.filter(userid => !visibleUserids.has(userid)),
        ...(memberData.warning ? { warning: memberData.warning } : {})
    };
}

// 注意：返回的 callback_token 仅供管理后台展示，不再下发到非必要字段。
async function getConfiguration(code) {
    const config = await db.getConfigurationByCode(code);
    if (!config) return null;

    // 多应用（§6.7 + P1-03）：详情复用统一摘要序列化，warnings（含 duplicate_identity）
    // 与列表、规则页语义一致；前端不再各自推导状态。
    const [ruleCounts, duplicateMap] = await Promise.all([
        db.countRulesByConfigCodes([code]),
        computeDuplicateMapForCodes([code])
    ]);
    const summary = serializeConfigurationSummary(config, {
        includeSensitiveFlags: true,
        ruleCounts,
        duplicateMap
    });

    // 详情额外字段：默认接收成员数组（编辑页选择器需要），回调 URL（不含明文 token）。
    // 多应用（§6.7）：新 UI 不再返回回调 Token 明文；旧首页下线后此兼容变化已记录。
    // 多应用（R-P1-04）：legacy-grace 能力已删除，不再序列化 legacy_until。
    summary.touser = normalizeTouser(config.touser);
    if (config.callback_enabled) {
        summary.callbackUrl = '/api/callback/' + config.code;
    }

    return summary;
}

/**
 * 更新配置
 *
 * SEC-009：回调三元组（enabled + token + aeskey）原子校验；
 *         CorpID/AgentID 变更触发企业微信组合校验。
 */
async function updateConfiguration(code, newConfig, options = {}) {
    const config = await db.getConfigurationByCode(code);
    if (!config) {
        throw createError('无效的code，未找到配置', 404, 'APP_NOT_FOUND');
    }

    // 多应用不变量 2：corpid 创建后不可通过编辑接口修改；更换企业必须新建应用。
    if (newConfig.corpid !== undefined && newConfig.corpid !== config.corpid) {
        throw createError('企业（CorpID）不可修改，请新建应用', 400, 'CORPID_IMMUTABLE');
    }

    // 多应用（§6.4 配置并发控制）：必须携带 If-Match 版本，禁止无版本静默覆盖。
    const expectedVersion = parseExpectedVersion(options);
    if (expectedVersion === null) {
        throw createError('缺少版本号，请刷新后重试', 428, 'APP_VERSION_REQUIRED');
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        throw createError('版本号不合法', 400, 'INVALID_INPUT');
    }

    // 多应用（二次复验 P1-07 + 第三轮 P1-04）：事务外只读版本快速失败——
    // 乐观锁要求任何不相等都冲突。旧实现用 expectedVersion < currentVersion，
    // 导致未来版本（999 > 当前 3）绕过快速检查，先调用企业微信再被 CAS 拒绝，
    // 也可能让无效凭证先返回 WECHAT_CREDENTIAL_INVALID 掩盖版本冲突。
    // 改为严格不相等：低于或高于当前版本都立即冲突，只有完全相等才进入验证。
    // 注意：这只是优化，事务内 CAS 仍是权威校验，不能用快速检查替代原子校验。
    const currentVersion = Number(config.version) || 1;
    if (expectedVersion !== currentVersion) {
        throw createError('应用已在其他页面更新，请加载最新值后重新确认', 409, 'APP_VERSION_CONFLICT', {
            version: currentVersion
        });
    }

    const hasTouser = Object.prototype.hasOwnProperty.call(newConfig, 'touser');
    const normalizedTouser = hasTouser ? normalizeTouser(newConfig.touser) : null;
    if (hasTouser && normalizedTouser.length === 0) {
        throw createError('请至少选择一个成员', 400, 'INVALID_INPUT');
    }

    const cryptoSvc = getCrypto();

    // 收集本次实际修改的列（touched-field），DAO 只 SET 这些列 + version=version+1。
    const fields = {};

    // CorpSecret：未传或为空表示不变；前端不得把空字符串作为清空发送。
    let credentialChanged = false;
    let candidateCorpsecret = null; // 用于在线验证
    if (newConfig.corpsecret) {
        fields.encrypted_corpsecret = cryptoSvc.encrypt(newConfig.corpsecret);
        candidateCorpsecret = newConfig.corpsecret;
        credentialChanged = true;
    }

    // AgentID：变化时才需要身份判重 + 凭证重新验证。
    let candidateAgentid = null;
    let agentidChanged = false;
    if (newConfig.agentid !== undefined) {
        const parsed = parsePositiveInt(newConfig.agentid);
        if (!parsed) {
            throw createError('AgentID 必须为正整数', 400, 'INVALID_INPUT');
        }
        if (parsed !== Number(config.agentid)) {
            candidateAgentid = parsed;
            agentidChanged = true;
            credentialChanged = true; // AgentID 变化也要求重新验证凭证
        }
    }

    // 回调相关：严格布尔解析。
    let callbackEnabledValue = config.callback_enabled;
    if (newConfig.callback_enabled !== undefined) {
        const strict = toStrictBoolean(newConfig.callback_enabled);
        if (strict === null) {
            throw createError('callback_enabled 必须为布尔值', 400, 'INVALID_INPUT');
        }
        callbackEnabledValue = strict ? 1 : 0;
        if (callbackEnabledValue !== (config.callback_enabled ? 1 : 0)) {
            fields.callback_enabled = callbackEnabledValue;
        }
    }

    let encrypted_callback_token = config.encrypted_callback_token;
    let encrypted_encoding_aes_key = config.encrypted_encoding_aes_key;
    let callbackTokenTouched = false;
    let aesKeyTouched = false;
    if (newConfig.callback_token !== undefined) {
        callbackTokenTouched = true;
        if (newConfig.callback_token) {
            encrypted_callback_token = cryptoSvc.encrypt(newConfig.callback_token);
        } else {
            encrypted_callback_token = null;
        }
        fields.encrypted_callback_token = encrypted_callback_token;
    }
    if (newConfig.encoding_aes_key !== undefined) {
        aesKeyTouched = true;
        if (newConfig.encoding_aes_key) {
            if (!validateEncodingAesKey(newConfig.encoding_aes_key)) {
                throw createError('EncodingAESKey 必须为 43 位字母数字字符', 400, 'INVALID_INPUT');
            }
            encrypted_encoding_aes_key = cryptoSvc.encrypt(newConfig.encoding_aes_key);
        } else {
            encrypted_encoding_aes_key = null;
        }
        fields.encrypted_encoding_aes_key = encrypted_encoding_aes_key;
    }

    // REV-007：回调开启时 Token/AESKey 最终状态必须完整。
    if (callbackEnabledValue === 1) {
        const candidateToken = callbackTokenTouched ? encrypted_callback_token
            : (config.encrypted_callback_token || config.callback_token);
        const candidateAesKey = aesKeyTouched ? encrypted_encoding_aes_key : config.encrypted_encoding_aes_key;
        if (!candidateToken || !candidateAesKey) {
            throw createError('回调开启时 Token 与 EncodingAESKey 必须同时完整，不能单独清空', 400, 'INVALID_INPUT');
        }
    }

    if (hasTouser) {
        const joined = normalizedTouser.join('|');
        if (joined !== config.touser) {
            fields.touser = joined;
        }
    }
    if (newConfig.description !== undefined && newConfig.description !== config.description) {
        fields.description = newConfig.description;
    }
    if (agentidChanged) {
        fields.agentid = candidateAgentid;
    }

    // 多应用（R-P0-01 §4）：身份判重移入原子事务——禁止事务外判重后再 UPDATE 的 TOCTOU 窗口。
    // 微信在线验证仍在事务外（禁止网络调用占用写锁）；数据库阶段统一走 updateConfigurationAtomic。

    // QA-001：已有明确身份冲突时，在企业微信在线验证前快速失败。
    // 这只是避免无意义外部调用的优化；并发期间出现的新冲突仍由下方原子事务兜底，
    // 因此不会恢复旧版“事务外判重后直接 UPDATE”的 TOCTOU 缺陷。
    if (agentidChanged) {
        const existingIdentity = await db.findCompletedByCorpidAgentId(
            config.corpid,
            candidateAgentid,
            code
        );
        if (existingIdentity) {
            throw createError('该企业下此 AgentID 已绑定到其他应用', 409, 'APP_IDENTITY_CONFLICT', {
                existing_code: existingIdentity.code
            });
        }
    }

    // 凭证变化（CorpSecret 或 AgentID）才调用企业微信在线验证；描述/接收人变更无需验证。
    // 多应用（R-P1-01）：此处只验证，不执行任何副作用（旧 token 失效必须在写库成功后）。
    if (credentialChanged) {
        // 若仅改 AgentID 未改 secret，需要解密原 secret 用于验证。
        let secretForValidation = candidateCorpsecret;
        if (!secretForValidation) {
            secretForValidation = decryptWithLazyMigration(
                'encrypted_corpsecret', config.encrypted_corpsecret, config.code
            );
        }
        await validateApplicationCredentials({
            corpid: config.corpid,
            corpsecret: secretForValidation,
            agentid: candidateAgentid || Number(config.agentid)
        });
    }

    // 没有任何字段被触摸：只校验版本匹配（不增版本，也不进事务）。
    if (Object.keys(fields).length === 0) {
        // 版本不匹配直接报冲突。
        if (Number(config.version) !== Number(expectedVersion)) {
            throw createError('应用已在其他页面更新，请加载最新值后重新确认', 409, 'APP_VERSION_CONFLICT', {
                version: Number(config.version) || 1
            });
        }
        return {
            message: '配置无变化',
            code,
            version: Number(config.version) || 1
        };
    }

    // 多应用（R-P0-01）：事务内重新校验版本 + AgentID 身份判重 + touched-field 更新。
    let updateResult;
    try {
        updateResult = await db.updateConfigurationAtomic(code, fields, expectedVersion, {
            targetAgentid: agentidChanged ? candidateAgentid : null,
            checkIdentity: agentidChanged
        });
    } catch (err) {
        const cause = err && err.__updateCause;
        if (cause === 'missing') throw createError('无效的code，未找到配置', 404, 'APP_NOT_FOUND');
        if (cause === 'version_conflict') {
            throw createError('应用已在其他页面更新，请加载最新值后重新确认', 409, 'APP_VERSION_CONFLICT', {
                version: Number(err.__currentVersion) || undefined
            });
        }
        if (cause === 'identity_conflict') {
            throw createError('该企业下此 AgentID 已绑定到其他应用', 409, 'APP_IDENTITY_CONFLICT', {
                existing_code: err.__existingCode
            });
        }
        throw err;
    }

    // 多应用（R-P1-01）：副作用必须在数据库提交成功后执行。
    // 只有改了 CorpSecret 才失效旧 token（仅改 AgentID 不失效，secret 未变）。
    // 多应用（二次复验 P0-01）：用 decryptOnly（不触发迁移）读取旧 secret，
    // 避免惰性迁移的旧值条件更新排在刚提交的新 secret 之后导致回退。
    clearRuntimeCaches();
    if (candidateCorpsecret) {
        try {
            const oldSecret = decryptOnly(config.encrypted_corpsecret);
            await wechat.invalidateToken(config.corpid, oldSecret);
        } catch (_e) {
            // 尽力清理，失败不影响已提交写入。
        }
    }

    const refreshed = await db.getConfigurationByCode(code);
    const result = {
        message: '配置更新成功',
        code,
        version: Number(refreshed && refreshed.version) || updateResult.version
    };
    const finalCallbackEnabled = refreshed
        ? (refreshed.callback_enabled === 1 || refreshed.callback_enabled === true)
        : (callbackEnabledValue === 1 || config.callback_enabled === 1);
    if (finalCallbackEnabled) {
        result.callbackUrl = `/api/callback/${code}`;
    }
    return result;
}

// 多应用：解析 If-Match / options.expectedVersion。
// 支持 { expectedVersion } 或 { ifMatch }（字符串 "<version>" 或裸数字）。
// 返回 null 表示调用方未提供版本（调用方按需返回 428）。
// P1-04 修复：null/undefined 不能被 Number() 转成 0，必须显式判为缺失。
function parseExpectedVersion(options) {
    if (!options) return null;
    if (Object.prototype.hasOwnProperty.call(options, 'expectedVersion')) {
        const v = options.expectedVersion;
        if (v === null || v === undefined) return null;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) return null;
        return n;
    }
    if (options.ifMatch !== undefined && options.ifMatch !== null) {
        const raw = String(options.ifMatch).replace(/["']/g, '').trim();
        if (raw === '') return null;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) return null;
        return n;
    }
    return null;
}

// 多应用（R-P1-05）：请求体 version 字段三分解析。
// 草稿更新/完成的 version 是请求体字段（不是 If-Match 头），需区分三种状态：
//   - 缺失/null/undefined/空字符串 → { provided: false }（调用方返回 428 APP_VERSION_REQUIRED）
//   - 已提供但不是正整数 → { provided: true, valid: false }（调用方返回 400 INVALID_INPUT）
//   - 正整数 → { provided: true, valid: true, value }
// 不再用单一 null 同时表达“缺失”和“非法”，避免 "abc"/0 被误报为缺版本。
function parseBodyVersion(value) {
    if (value === null || value === undefined) return { provided: false };
    if (typeof value === 'string' && value.trim() === '') return { provided: false };
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) return { provided: true, valid: false };
    return { provided: true, valid: true, value: n };
}

// REV-001：将时间戳校验与重放登记拆分为两个函数。
//
// 流程要求：先校验时间戳新鲜度（只读，不写缓存） -> 完成企业微信签名验证与解密 ->
//           解密成功后再原子登记 MsgId（幂等）。
// 重放键带配置作用域，第二层只检查 MsgId，不再复用 nonce。
const CALLBACK_NONCE_HARD_LIMIT = Number(process.env.CALLBACK_NONCE_HARD_LIMIT || 50000);

// 只读校验：时间戳新鲜度。
function assertCallbackTimestamp(timestamp) {
    const now = Math.floor(Date.now() / 1000);
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
        throw createError('回调时间戳无效', 400);
    }
    if (Math.abs(now - ts) > CALLBACK_TIMESTAMP_TOLERANCE_SEC) {
        throw createError('回调时间戳超出允许范围', 401);
    }
}

// 原子登记并检测重放：仅在签名/解密成功后调用。
// 返回 true 表示首次处理；false 表示已处理过（企业微信重试），调用方应幂等返回成功。
function registerCallbackMessage(code, msgId) {
    if (!msgId) return true; // 无 MsgId 无法去重，放行
    const key = `callback:${code}:msgid:${msgId}`;
    const seen = callbackNonceSeen.get(key);
    if (seen && seen > Date.now()) {
        return false; // 已处理过 -> 幂等
    }
    callbackNonceSeen.set(key, Date.now() + CALLBACK_NONCE_TTL_MS);
    // REV-001 整改要求 6：硬容量上限 + LRU/TTL 淘汰。
    if (callbackNonceSeen.size > CALLBACK_NONCE_HARD_LIMIT) {
        const cutoff = Date.now();
        for (const [k, expires] of callbackNonceSeen) {
            if (expires <= cutoff) callbackNonceSeen.delete(k);
        }
        // 仍超限则淘汰最旧（Map 保持插入顺序）
        if (callbackNonceSeen.size > CALLBACK_NONCE_HARD_LIMIT) {
            const firstKey = callbackNonceSeen.keys().next().value;
            callbackNonceSeen.delete(firstKey);
        }
    }
    return true;
}

// 供 routes 层在读取 raw body 前做大小校验。
function assertCallbackBodySize(byteLength) {
    if (!Number.isFinite(byteLength) || byteLength <= 0) {
        throw createError('消息数据为空', 400);
    }
    if (byteLength > CALLBACK_MAX_BODY_BYTES) {
        throw createError('回调请求体超过大小限制', 413);
    }
}

/**
 * 处理回调验证
 */
async function handleCallbackVerification(code, msgSignature, timestamp, nonce, echoStr) {
    try {
        // REV-001：只读校验时间戳，不登记 nonce（避免伪造请求污染缓存）。
        assertCallbackTimestamp(timestamp);

        const config = await db.getConfigurationByCode(code);
        if (!config || !config.callback_enabled) {
            return { success: false, error: '回调未启用或配置不存在' };
        }

        const decoded = decodeCallbackCredentials(config);
        if (!decoded) {
            return { success: false, error: '回调配置不完整' };
        }

        const callbackCrypto = new WeChatCallbackCrypto(
            decoded.token,
            decoded.aesKey,
            config.corpid
        );

        const result = callbackCrypto.verifyURL(msgSignature, timestamp, nonce, echoStr);
        return result;
    } catch (error) {
        console.error('回调验证失败:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * 处理回调消息
 *
 * REV-001 整改流程：
 *   1. 时间戳新鲜度校验（只读）
 *   2. 企业微信签名验证 + 解密（失败直接返回，不登记 nonce）
 *   3. 解密成功后按 MsgId 原子登记；重复 MsgId 幂等返回成功（企业微信重试）
 */
async function handleCallbackMessage(code, encryptedData, msgSignature, timestamp, nonce) {
    try {
        assertCallbackBodySize(Buffer.byteLength(encryptedData || '', 'utf8'));
        assertCallbackTimestamp(timestamp);

        const config = await db.getConfigurationByCode(code);
        if (!config || !config.callback_enabled) {
            return { success: false, error: '回调未启用或配置不存在' };
        }

        const decoded = decodeCallbackCredentials(config);
        if (!decoded) {
            return { success: false, error: '回调配置不完整' };
        }

        const callbackCrypto = new WeChatCallbackCrypto(
            decoded.token,
            decoded.aesKey,
            config.corpid
        );

        const decryptResult = callbackCrypto.decryptMsg(encryptedData, msgSignature, timestamp, nonce);
        if (!decryptResult.success) {
            return decryptResult;
        }

        const message = callbackCrypto.parseXMLMessage(decryptResult.data);

        // REV-001：解密成功后才登记 MsgId；企业微信重试同一 MsgId 幂等返回成功。
        const isFirst = registerCallbackMessage(code, message.msgId);
        if (!isFirst) {
            console.log(`[回调] code=${code} msgId=${message.msgId || '-'} 重复消息，幂等返回成功`);
            return { success: true, message, duplicate: true };
        }

        // SEC-012：日志脱敏，仅记录事件类型与追踪信息。
        console.log(`[回调] code=${code} msgType=${message.msgType} msgId=${message.msgId || '-'}`);

        return { success: true, message };
    } catch (error) {
        console.error('回调消息处理失败:', error.message);
        return { success: false, error: error.message };
    }
}

function decodeCallbackCredentials(config) {
    const cryptoSvc = getCrypto();
    let token = null;
    let aesKey = null;
    try {
        if (config.encrypted_callback_token) {
            token = cryptoSvc.decrypt(config.encrypted_callback_token);
        } else if (config.callback_token) {
            // 兼容旧明文字段
            token = config.callback_token;
        }
        if (config.encrypted_encoding_aes_key) {
            aesKey = decryptWithLazyMigration('encrypted_encoding_aes_key', config.encrypted_encoding_aes_key, config.code);
        }
    } catch (err) {
        return null;
    }
    if (!token || !aesKey) return null;
    return { token, aesKey };
}

// SEC-003：为配置生成/轮换独立的 notify_key（仅返回一次明文，DB 只存哈希）。
// 多应用（§6.4）：属应用聚合写，按 If-Match 校验版本并递增。
async function regenerateNotifyKey(code, options = {}) {
    const config = await db.getConfigurationByCode(code);
    if (!config) {
        throw createError('无效的code，未找到配置', 404, 'APP_NOT_FOUND');
    }
    if (!isCompletedConfig(config)) {
        throw createError('应用尚未完成配置', 409, 'APP_NOT_COMPLETED');
    }
    const plainKey = notifyAuth.generateNotifyKey();
    const hash = notifyAuth.hashNotifyKey(plainKey);
    const version = await applyAppFieldUpdate(code, { notify_key_hash: hash }, options);
    clearRuntimeCaches();
    return { code, notify_key: plainKey, notify_key_enabled: true, version, message: '请妥善保存通知密钥，仅显示一次' };
}

// SEC-003：撤销 notify_key（旧 key 立即失效）。
async function revokeNotifyKey(code, options = {}) {
    const config = await db.getConfigurationByCode(code);
    if (!config) {
        throw createError('无效的code，未找到配置', 404, 'APP_NOT_FOUND');
    }
    if (!isCompletedConfig(config)) {
        throw createError('应用尚未完成配置', 409, 'APP_NOT_COMPLETED');
    }
    const version = await applyAppFieldUpdate(code, { notify_key_hash: null }, options);
    clearRuntimeCaches();
    return { code, notify_key_enabled: false, version, message: '通知密钥已撤销' };
}

// 配置级 Code 发送开关：关闭后 /api/notify/:code 返回 403，规则 API 不受影响。
// 多应用（§6.4）：属应用聚合写，按 If-Match 校验版本并递增。
async function setCodeSendEnabled(code, enabled, options = {}) {
    const config = await db.getConfigurationByCode(code);
    if (!config) {
        throw createError('无效的code，未找到配置', 404, 'APP_NOT_FOUND');
    }
    if (!isCompletedConfig(config)) {
        throw createError('应用尚未完成配置', 409, 'APP_NOT_COMPLETED');
    }
    const strict = toStrictBoolean(enabled);
    if (strict === null) {
        throw createError('Code 发送开关必须为布尔值', 400, 'INVALID_INPUT');
    }
    const value = strict ? 1 : 0;
    const version = await applyAppFieldUpdate(code, { code_send_enabled: value }, options);
    clearRuntimeCaches();
    return { code, code_send_enabled: strict, version };
}

// 多应用：统一的应用聚合字段更新 + 版本乐观锁 + 错误翻译。
// 供 regenerateNotifyKey/revokeNotifyKey/setCodeSendEnabled 等复用。
// 成功返回新 version；缺版本 428，版本冲突 409。
async function applyAppFieldUpdate(code, fields, options = {}) {
    const expectedVersion = parseExpectedVersion(options);
    if (expectedVersion === null) {
        throw createError('缺少版本号，请刷新后重试', 428, 'APP_VERSION_REQUIRED');
    }
    const result = await db.updateConfigurationFields(code, fields, expectedVersion);
    if (result.changes === 0) {
        const stillExists = await db.getConfigurationByCode(code);
        if (!stillExists) {
            throw createError('无效的code，未找到配置', 404, 'APP_NOT_FOUND');
        }
        throw createError('应用已在其他页面更新，请加载最新值后重新确认', 409, 'APP_VERSION_CONFLICT', {
            version: Number(stillExists.version) || 1
        });
    }
    return result.version;
}

module.exports = {
    createCallbackConfiguration,
    completeConfiguration,
    createConfiguration,
    listRules,
    listConfigurations,
    createRule,
    updateRule,
    regenerateRuleApiCode,
    deleteRule,
    setRuleEnabled,
    sendNotification,
    getConfigMembers,
    getConfiguration,
    updateConfiguration,
    handleCallbackVerification,
    handleCallbackMessage,
    ensureDbReady,
    isDbReady,
    assertCallbackBodySize,
    validateMessagePayload,
    isCompletedConfig,
    toStrictBoolean,
    parsePositiveInt,
    validateEncodingAesKey,
    regenerateNotifyKey,
    revokeNotifyKey,
    setCodeSendEnabled,
    // 多应用（2026-07-04）：
    setAppEnabled,
    deleteConfiguration,
    validateApplicationCredentials,
    validateAndListMembers,
    serializeConfigurationSummary,
    isDraftConfig,
    // 接收规则 API 自定义编号（2026-07-04）：
    checkNotifyCodeAvailability,
    _internal: {
        db,
        wechat,
        config: config.raw,
        CALLBACK_MAX_BODY_BYTES,
        notifyAuth,
        // 测试/诊断用：缓存清除与纪元（生产路由不依赖）。
        clearRuntimeCaches,
        get runtimeCacheEpoch() { return runtimeCacheEpoch; },
        targetCache,
        inflightSends
    }
};
