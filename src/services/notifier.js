// 核心业务逻辑模块
// 处理配置创建和消息发送的业务逻辑

const { v4: uuidv4 } = require('uuid');
const Database = require('../core/database');
const CryptoService = require('../core/crypto');
const WeChatService = require('../core/wechat');
const WeChatCallbackCrypto = require('../core/wechat-callback');
const path = require('path');

// 环境变量
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../database/notifier.db');
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-key-for-development-only';

const db = new Database(DB_PATH);
const crypto = new CryptoService(ENCRYPTION_KEY);
const wechat = new WeChatService();
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
const targetCache = new Map();
const memberListCache = new Map();
const sendResultCache = new Map();
const memberWindows = new Map();
const appDailyWindows = new Map();
const backoffWindows = new Map();

// 初始化数据库（仅需调用一次）
db.init().catch(console.error);

function createError(message, statusCode) {
    const error = new Error(message);
    if (statusCode) {
        error.statusCode = statusCode;
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

function toBoolean(value) {
    return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

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

function clearRuntimeCaches() {
    targetCache.clear();
    memberListCache.clear();
    sendResultCache.clear();
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
    const isAllRaw = payload.is_all !== undefined
        ? payload.is_all
        : (payload.isAll !== undefined ? payload.isAll : existing.is_all);
    const isAll = toBoolean(isAllRaw);
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

function trackExplicitMembers(config, recipient) {
    if (recipient.is_all || recipient.toparty || recipient.totag) return;

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

    const now = Date.now();
    for (const userid of users) {
        const key = `${config.corpid}:${config.agentid}:${userid}`;
        memberWindows.get(`${key}:minute`).push(now);
        memberWindows.get(`${key}:hour`).push(now);
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

/**
 * 创建回调配置（第一步）
 * @param {Object} config - { corpid, callback_token, encoding_aes_key }
 * @returns {Promise<{ code: string, callbackUrl: string }>}
 */
async function createCallbackConfiguration(config) {
    const { corpid, callback_token, encoding_aes_key } = config;
    if (!corpid || !callback_token || !encoding_aes_key) {
        throw new Error('回调配置参数不完整');
    }
    if (encoding_aes_key.length !== 43) {
        throw new Error('EncodingAESKey必须是43位字符');
    }

    // 检查是否已存在相同的回调配置
    const existingConfig = await db.getCallbackConfiguration(corpid, callback_token);
    if (existingConfig) {
        console.log('发现重复回调配置，返回已存在的code:', existingConfig.code);
        return {
            code: existingConfig.code,
            callbackUrl: `/api/callback/${existingConfig.code}`,
            message: '回调配置已存在，返回现有配置'
        };
    }

    // 生成唯一code
    const code = uuidv4();
    // 加密encoding_aes_key
    const encrypted_encoding_aes_key = crypto.encrypt(encoding_aes_key);

    // 保存回调配置到数据库
    await db.saveCallbackConfiguration({
        code,
        corpid,
        callback_token,
        encrypted_encoding_aes_key
    });

    console.log('回调配置创建成功，code:', code);

    return {
        code,
        callbackUrl: `/api/callback/${code}`
    };
}

/**
 * 完善配置（第二步）
 * @param {Object} config - { code, corpsecret, agentid, touser, description }
 * @returns {Promise<{ code: string, apiUrl: string, callbackUrl: string }>}
 */
async function completeConfiguration(config) {
    const { code, corpsecret, agentid, touser, description } = config;
    if (!code || !corpsecret || !agentid || !touser) {
        throw new Error('参数不完整');
    }

    // 检查回调配置是否存在
    const callbackConfig = await db.getConfigurationByCode(code);
    if (!callbackConfig) {
        throw new Error('回调配置不存在，请先生成回调URL');
    }

    // 加密corpsecret
    const encrypted_corpsecret = crypto.encrypt(corpsecret);
    const formattedTouser = Array.isArray(touser) ? touser.join('|') : touser;

    // 更新配置
    await db.completeConfiguration({
        code,
        encrypted_corpsecret,
        agentid,
        touser: formattedTouser,
        description: description || ''
    });

    console.log('配置完善成功，code:', code);

    return {
        code,
        apiUrl: `/api/notify/${code}`,
        callbackUrl: `/api/callback/${code}`
    };
}

/**
 * 创建配置（原有方法，保持兼容性）
 * @param {Object} config - { corpid, corpsecret, agentid, touser, description, callback_token, encoding_aes_key, callback_enabled }
 * @returns {Promise<{ code: string, apiUrl: string, callbackUrl?: string }>}
 */
async function createConfiguration(config) {
    const {
        corpid, corpsecret, agentid, touser, description,
        callback_token, encoding_aes_key, callback_enabled
    } = config;
    if (!corpid || !corpsecret || !agentid || !touser) {
        throw new Error('参数不完整');
    }

    // 第一步：优先处理回调配置验证
    if (callback_enabled) {
        if (!callback_token || !encoding_aes_key) {
            throw new Error('启用回调时必须提供回调Token和EncodingAESKey');
        }
        if (encoding_aes_key.length !== 43) {
            throw new Error('EncodingAESKey必须是43位字符');
        }
        console.log('回调配置验证通过，继续处理配置...');
    }

    // 第二步：检查是否已存在完全相同的配置（包括回调配置）
    const formattedTouser = Array.isArray(touser) ? touser.join('|') : touser;
    const existingConfig = await db.getConfigurationByCompleteFields(
        corpid,
        agentid,
        formattedTouser,
        callback_enabled ? 1 : 0,
        callback_token || null
    );

    if (existingConfig) {
        console.log('发现重复配置，返回已存在的code:', existingConfig.code);
        const result = {
            code: existingConfig.code,
            apiUrl: `/api/notify/${existingConfig.code}`,
            message: '配置已存在，返回现有配置'
        };
        if (existingConfig.callback_enabled) {
            result.callbackUrl = `/api/callback/${existingConfig.code}`;
        }
        return result;
    }

    // 第三步：生成新配置
    const code = uuidv4();
    // 加密corpsecret
    const encrypted_corpsecret = crypto.encrypt(corpsecret);
    // 加密encoding_aes_key（如果提供）
    const encrypted_encoding_aes_key = encoding_aes_key ? crypto.encrypt(encoding_aes_key) : null;

    // 保存到数据库
    await db.saveConfiguration({
        code,
        corpid,
        encrypted_corpsecret,
        agentid,
        touser: formattedTouser,
        description: description || '',
        callback_token: callback_token || null,
        encrypted_encoding_aes_key,
        callback_enabled: callback_enabled ? 1 : 0
    });

    console.log('新配置创建成功，code:', code);

    // 返回API调用信息
    const result = {
        code,
        apiUrl: `/api/notify/${code}`
    };
    if (callback_enabled) {
        result.callbackUrl = `/api/callback/${code}`;
    }
    return result;
}

async function listRules(configCode) {
    const config = await db.getConfigurationByCode(configCode);
    if (!config) {
        throw createError('未找到配置', 404);
    }

    const rules = await db.listNotificationRules(configCode);
    return {
        config: {
            code: config.code,
            corpid: config.corpid,
            agentid: config.agentid,
            touser: normalizeTouser(config.touser),
            description: config.description
        },
        rules: rules.map(serializeRule)
    };
}

async function listConfigurations() {
    const rows = await db.listConfigurations();
    return {
        configurations: rows.map(row => ({
            code: row.code,
            agentid: Number(row.agentid) || 0,
            description: row.description || '',
            completed: Boolean(row.encrypted_corpsecret || Number(row.agentid)) && normalizeTouser(row.touser).length > 0,
            created_at: row.created_at
        }))
    };
}

async function createRule(configCode, payload) {
    const config = await db.getConfigurationByCode(configCode);
    if (!config) {
        throw createError('未找到配置', 404);
    }

    const normalized = normalizeRulePayload(payload);
    const api_code = uuidv4();
    const saved = await db.saveNotificationRule({
        config_code: configCode,
        api_code,
        ...normalized
    });

    clearRuntimeCaches();
    return {
        id: saved.id,
        api_code,
        apiUrl: `/api/notify/${api_code}`
    };
}

async function updateRule(id, payload) {
    const existing = await db.getNotificationRuleById(id);
    if (!existing) {
        throw createError('未找到规则', 404);
    }

    const normalized = normalizeRulePayload(payload, existing);
    await db.updateNotificationRule({
        id: Number(id),
        ...normalized
    });

    clearRuntimeCaches();
    return {
        id: Number(id),
        api_code: existing.api_code,
        apiUrl: `/api/notify/${existing.api_code}`
    };
}

async function regenerateRuleApiCode(id) {
    const existing = await db.getNotificationRuleById(id);
    if (!existing) {
        throw createError('未找到规则', 404);
    }

    const api_code = uuidv4();
    await db.regenerateNotificationRuleApiCode(Number(id), api_code);
    clearRuntimeCaches();
    return {
        id: Number(id),
        api_code,
        apiUrl: `/api/notify/${api_code}`
    };
}

async function deleteRule(id) {
    const existing = await db.getNotificationRuleById(id);
    if (!existing) {
        throw createError('未找到规则', 404);
    }

    await db.deleteNotificationRule(Number(id));
    clearRuntimeCaches();
    return { id: Number(id) };
}

async function resolveNotificationTarget(code) {
    const cached = getCached(targetCache, code);
    if (cached) return cached;

    const rule = await db.getNotificationRuleByApiCode(code);
    if (rule) {
        const config = await db.getConfigurationByCode(rule.config_code);
        if (!config) {
            throw createError('规则关联的配置不存在', 404);
        }

        const recipient = recipientFromRule(rule);
        const target = {
            config,
            rule,
            recipient,
            estimatedCount: estimateRecipientCount(recipient, rule.estimated_count),
            cacheScope: `rule:${rule.id}:${rule.api_code}`
        };
        return setCached(targetCache, code, target, CONFIG_CACHE_TTL_MS);
    }

    const config = await db.getConfigurationByCode(code);
    if (!config) {
        throw createError('无效的code，未找到配置', 404);
    }

    const recipient = recipientFromConfig(config);
    const target = {
        config,
        rule: null,
        recipient,
        estimatedCount: estimateRecipientCount(recipient),
        cacheScope: `config:${config.code}`
    };
    return setCached(targetCache, code, target, CONFIG_CACHE_TTL_MS);
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
 * @param {string} code - 唯一配置code
 * @param {string} title - 消息标题
 * @param {string} content - 消息内容
 * @param {Object} options - 消息选项
 * @returns {Promise<Object>} - 企业微信API返回结果
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
    const sendOptions = { msgType, mediaId, url, btntxt, articles, safe };
    const cacheKey = buildSendCacheKey(target, title, content, sendOptions);
    if (!force) {
        const cachedResult = getCached(sendResultCache, cacheKey);
        if (cachedResult) {
            return { ...cachedResult, cached: true };
        }
    }

    assertNotInBackoff(config);
    trackAppDaily(config, target.estimatedCount);
    trackExplicitMembers(config, target.recipient);

    const corpsecret = crypto.decrypt(config.encrypted_corpsecret);
    const accessToken = await wechat.getToken(config.corpid, corpsecret);

    let result;
    try {
        switch (msgType) {
            case 'text':
                const message = title ? `${title}\n${content}` : content;
                result = await wechat.sendTextMessage(accessToken, config.agentid, target.recipient, message, safe);
                break;

            case 'markdown':
                const markdownContent = title ? `**${title}**\n\n${content}` : content;
                result = await wechat.sendMarkdownMessage(accessToken, config.agentid, target.recipient, markdownContent, safe);
                break;

            case 'image':
                if (!mediaId) {
                    throw new Error('图片消息需要提供media_id');
                }
                result = await wechat.sendImageMessage(accessToken, config.agentid, target.recipient, mediaId, safe);
                break;

            case 'file':
                if (!mediaId) {
                    throw new Error('文件消息需要提供media_id');
                }
                result = await wechat.sendFileMessage(accessToken, config.agentid, target.recipient, mediaId, safe);
                break;

            case 'textcard':
                if (!title || !content || !url) {
                    throw new Error('文本卡片消息需要提供title、content和url');
                }
                result = await wechat.sendTextCardMessage(accessToken, config.agentid, target.recipient, title, content, url, btntxt, safe);
                break;

            case 'news':
                if (!articles || !Array.isArray(articles) || articles.length === 0) {
                    throw new Error('图文消息需要提供articles数组');
                }
                result = await wechat.sendNewsMessage(accessToken, config.agentid, target.recipient, articles, safe);
                break;

            default:
                throw new Error(`不支持的消息类型: ${msgType}`);
        }
    } catch (err) {
        if ((err.message || '').includes('45009')) {
            enterBackoff(config);
            err.statusCode = 429;
        }
        throw err;
    }

    setCached(sendResultCache, cacheKey, result, SEND_DEDUP_TTL_MS);
    return result;
}

/**
 * 获取配置（不返回敏感信息）
 * @param {string} code - 唯一配置code
 * @returns {Promise<Object>} - 配置信息
 */
async function getConfigMembers(code, options = {}) {
    if (!code) {
        throw createError('\u65e0\u6548\u7684code\uff0c\u672a\u627e\u5230\u914d\u7f6e', 404);
    }

    const config = await db.getConfigurationByCode(code);
    if (!config) {
        throw createError('\u65e0\u6548\u7684code\uff0c\u672a\u627e\u5230\u914d\u7f6e', 404);
    }

    const current = normalizeTouser(config.touser);
    if (!config.encrypted_corpsecret || !config.agentid || current.length === 0) {
        throw createError('\u914d\u7f6e\u5c1a\u672a\u5b8c\u6210\uff0c\u8bf7\u5148\u5b8c\u6210\u7b2c\u4e8c\u6b65\u914d\u7f6e', 400);
    }

    const cacheKey = `${config.corpid}:${config.agentid}`;
    let memberData = options.refresh ? null : getCached(memberListCache, cacheKey);
    if (Array.isArray(memberData)) {
        memberData = { users: memberData, warning: '' };
    }

    if (!memberData) {
        try {
            const corpsecret = crypto.decrypt(config.encrypted_corpsecret);
            const accessToken = await wechat.getToken(config.corpid, corpsecret);
            const agentInfo = await wechat.getAgentInfo(accessToken, config.agentid);
            memberData = {
                users: await wechat.getAgentVisibleUsers(accessToken, agentInfo),
                warning: ''
            };
        } catch (err) {
            if (!isContactPrivilegeError(err)) throw err;
            memberData = {
                users: fallbackMembersFromCurrent(current),
                warning: '企业微信未授权读取通讯录，已仅显示当前配置中的 UserID。'
            };
        }
        setCached(memberListCache, cacheKey, memberData, MEMBER_CACHE_TTL_MS);
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

async function getConfiguration(code) {
    const config = await db.getConfigurationByCode(code);
    if (!config) return null;

    const result = {
        code: config.code,
        corpid: config.corpid,
        agentid: config.agentid,
        touser: config.touser.split('|'),
        description: config.description,
        callback_enabled: config.callback_enabled === 1,
        created_at: config.created_at
    };

    // 如果启用了回调，添加回调相关信息（不包含敏感数据）
    if (config.callback_enabled) {
        result.callback_token = config.callback_token;
        result.callbackUrl = `/api/callback/${config.code}`;
    }

    return result;
}

/**
 * 更新配置
 * @param {string} code - 唯一配置code
 * @param {Object} newConfig - 新的配置信息
 * @returns {Promise<{ message: string, code: string, callbackUrl?: string }>}
 */
async function updateConfiguration(code, newConfig) {
    const config = await db.getConfigurationByCode(code);
    if (!config) {
        throw new Error('无效的code，未找到配置');
    }

    // 如果提供了新的corpsecret，则加密
    const hasTouser = Object.prototype.hasOwnProperty.call(newConfig, 'touser');
    const normalizedTouser = hasTouser ? normalizeTouser(newConfig.touser) : null;
    if (hasTouser && normalizedTouser.length === 0) {
        throw createError('\u8bf7\u81f3\u5c11\u9009\u62e9\u4e00\u4e2a\u6210\u5458', 400);
    }

    let encrypted_corpsecret = config.encrypted_corpsecret;
    if (newConfig.corpsecret) {
        encrypted_corpsecret = crypto.encrypt(newConfig.corpsecret);
    }

    // 如果提供了新的encoding_aes_key，则加密
    let encrypted_encoding_aes_key = config.encrypted_encoding_aes_key;
    if (newConfig.encoding_aes_key) {
        encrypted_encoding_aes_key = crypto.encrypt(newConfig.encoding_aes_key);
    }

    // 更新数据库
    const targetCorpid = newConfig.corpid || config.corpid;
    const targetAgentid = newConfig.agentid || config.agentid;
    const targetTouser = hasTouser ? normalizedTouser.join('|') : config.touser;
    const duplicate = await db.getConfigurationByFields(targetCorpid, targetAgentid, targetTouser);
    if (duplicate && duplicate.code !== code) {
        throw createError('\u76f8\u540c\u4f01\u4e1a\u3001\u5e94\u7528\u548c\u63a5\u6536\u4eba\u5458\u7684\u914d\u7f6e\u5df2\u5b58\u5728', 409);
    }

    await db.updateConfiguration({
        code,
        corpid: targetCorpid,
        encrypted_corpsecret,
        agentid: targetAgentid,
        touser: targetTouser,
        description: newConfig.description !== undefined ? newConfig.description : config.description,
        callback_token: newConfig.callback_token !== undefined ? newConfig.callback_token : config.callback_token,
        encrypted_encoding_aes_key,
        callback_enabled: newConfig.callback_enabled !== undefined ? (newConfig.callback_enabled ? 1 : 0) : config.callback_enabled
    });
    clearRuntimeCaches();

    const result = { message: '配置更新成功', code };
    if (newConfig.callback_enabled || config.callback_enabled) {
        result.callbackUrl = `/api/callback/${code}`;
    }
    return result;
}

/**
 * 处理回调验证
 * @param {string} code - 唯一配置code
 * @param {string} msgSignature - 消息签名
 * @param {string} timestamp - 时间戳
 * @param {string} nonce - 随机数
 * @param {string} echoStr - 回显字符串
 * @returns {Promise<{ success: boolean, data?: string, error?: string }>}
 */
async function handleCallbackVerification(code, msgSignature, timestamp, nonce, echoStr) {
    try {
        // 查询配置
        const config = await db.getConfigurationByCode(code);
        if (!config || !config.callback_enabled) {
            return { success: false, error: '回调未启用或配置不存在' };
        }

        if (!config.callback_token || !config.encrypted_encoding_aes_key) {
            return { success: false, error: '回调配置不完整' };
        }

        // 解密encoding_aes_key
        const encodingAESKey = crypto.decrypt(config.encrypted_encoding_aes_key);

        // 创建回调加密实例
        const callbackCrypto = new WeChatCallbackCrypto(
            config.callback_token,
            encodingAESKey,
            config.corpid
        );

        // 验证URL
        const result = callbackCrypto.verifyURL(msgSignature, timestamp, nonce, echoStr);
        return result;
    } catch (error) {
        console.error('回调验证失败:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * 处理回调消息
 * @param {string} code - 唯一配置code
 * @param {string} encryptedData - 加密的消息数据
 * @param {string} msgSignature - 消息签名
 * @param {string} timestamp - 时间戳
 * @param {string} nonce - 随机数
 * @returns {Promise<{ success: boolean, message?: Object, error?: string }>}
 */
async function handleCallbackMessage(code, encryptedData, msgSignature, timestamp, nonce) {
    try {
        // 查询配置
        const config = await db.getConfigurationByCode(code);
        if (!config || !config.callback_enabled) {
            return { success: false, error: '回调未启用或配置不存在' };
        }

        if (!config.callback_token || !config.encrypted_encoding_aes_key) {
            return { success: false, error: '回调配置不完整' };
        }

        // 解密encoding_aes_key
        const encodingAESKey = crypto.decrypt(config.encrypted_encoding_aes_key);

        // 创建回调加密实例
        const callbackCrypto = new WeChatCallbackCrypto(
            config.callback_token,
            encodingAESKey,
            config.corpid
        );

        // 解密消息
        const decryptResult = callbackCrypto.decryptMsg(encryptedData, msgSignature, timestamp, nonce);
        if (!decryptResult.success) {
            return decryptResult;
        }

        // 解析XML消息
        const message = callbackCrypto.parseXMLMessage(decryptResult.data);

        // 记录消息日志
        console.log(`[回调消息] Code: ${code}, 发送者: ${message.fromUserName}, 类型: ${message.msgType}`);
        if (message.msgType === 'text') {
            console.log(`[回调消息] 内容: ${message.content}`);
        }

        return { success: true, message };
    } catch (error) {
        console.error('回调消息处理失败:', error.message);
        return { success: false, error: error.message };
    }
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
    sendNotification,
    getConfigMembers,
    getConfiguration,
    updateConfiguration,
    handleCallbackVerification,
    handleCallbackMessage
};
