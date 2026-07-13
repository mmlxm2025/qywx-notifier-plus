// Express路由定义
// 包含所有API端点的路由配置

const express = require('express');
const path = require('path');
const notifier = require('../services/notifier');
const auth = require('../core/auth');
const notifyAuth = require('../core/notify-auth');
const { RateLimiter } = require('../core/rate-limit');

const router = express.Router();

// SEC-006：通知与回调入口限流（按来源 IP）。多实例需替换为共享存储。
const notifyLimiter = new RateLimiter({
    windowMs: Number(process.env.NOTIFY_RATE_WINDOW_MS || 60000),
    max: Number(process.env.NOTIFY_RATE_MAX || 60),
    message: '通知请求过于频繁，请稍后再试'
});
const callbackLimiter = new RateLimiter({
    windowMs: Number(process.env.CALLBACK_RATE_WINDOW_MS || 60000),
    max: Number(process.env.CALLBACK_RATE_MAX || 120),
    message: '回调请求过于频繁'
});

function clientIp(req) {
    // REV-004：统一使用 req.ip（受 Express trust proxy 约束），
    // 不直接读取客户端提供的 X-Forwarded-For，避免伪造绕过限流。
    return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// 多应用（第三轮复验 P2-9）：已删除未使用的 isSecureRequest 死代码。
// Cookie Secure 判断统一在 server.js 中只依赖 req.secure，避免未来误用同一不安全判断。

// SEC-002：认证中间件 —— 优先 Cookie 会话，兼容 Bearer 头（迁移期），拒绝 query token。
function requireAuth(req, res, next) {
    const sessionId = auth.parseSessionFromCookie(req.headers.cookie);
    if (sessionId && auth.verifySession(sessionId)) {
        req.sessionId = sessionId;
        return next();
    }
    // 迁移期：保留 Bearer 头支持（如旧脚本/API 文档示例），但不再接受 query token。
    const bearer = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
    if (bearer && auth.verifyToken(bearer)) {
        return next();
    }
    // 多应用（二次复验 P1-06）：401 补稳定 code，前端可统一分支。
    return res.status(401).json({ error: '未登录或登录已过期', code: 'AUTH_REQUIRED' });
}

// 通用错误处理：脱敏对外错误信息（SEC-009/SEC-012）。
// 多应用（§6.9）：序列化稳定业务码 code 与 details，前端禁止匹配中文文案。
function sendError(res, err, fallbackStatus = 500) {
    const status = err.statusCode || fallbackStatus;
    const message = (status >= 500 && process.env.NODE_ENV === 'production')
        ? '服务器内部错误'
        : (err.message || '请求失败');
    const body = { error: message };
    if (err.businessCode) body.code = err.businessCode;
    if (err.details) body.details = err.details;
    // 多应用（二次复验 P1-06）：无业务码的 5xx 补 INTERNAL_ERROR，前端可统一分支。
    if (status >= 500 && !body.code) {
        body.code = 'INTERNAL_ERROR';
    }
    res.status(status).json(body);
}

// 多应用（二次复验 P1-01）：要求请求体是 JSON 对象。
// 缺失 body（非 JSON Content-Type 或空 body）、数组、primitive → 400 INVALID_INPUT。
// 挂在所有需要 JSON 对象的写路由上，避免 service 层访问 undefined 字段时 500。
function requireJsonObjectBody(req, res, next) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ error: '请求体必须是 JSON 对象', code: 'INVALID_INPUT' });
    }
    next();
}

// 多应用（§3.2 P0-02/P0-04）：统一 If-Match 中间件。
//   - 缺失：428 APP_VERSION_REQUIRED
//   - 非正整数/弱格式非法：400 INVALID_INPUT
//   - 成功：写入 req.expectedVersion（正整数），service 层不再各自解析。
function requireIfMatch(req, res, next) {
    const raw = req.headers['if-match'];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return res.status(428).json({ error: '缺少版本号，请刷新后重试', code: 'APP_VERSION_REQUIRED' });
    }
    const cleaned = String(raw).replace(/["']/g, '').trim();
    const n = Number(cleaned);
    if (!Number.isInteger(n) || n < 1) {
        return res.status(400).json({ error: '版本号不合法', code: 'INVALID_INPUT' });
    }
    req.expectedVersion = n;
    next();
}

// 1. GET / 返回前端页面（仅校验会话，不再透传 token 到 URL）
router.get('/', (req, res) => {
    const sessionId = auth.parseSessionFromCookie(req.headers.cookie);
    const bearer = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
    if (!((sessionId && auth.verifySession(sessionId)) || (bearer && auth.verifyToken(bearer)))) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, '../../public/index.html'));
});

router.get('/rules', (req, res) => {
    // 多应用（§6.8）：页面路由统一接入会话守卫，未登录跳转 /login。
    const sessionId = auth.parseSessionFromCookie(req.headers.cookie);
    const bearer = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
    if (!((sessionId && auth.verifySession(sessionId)) || (bearer && auth.verifyToken(bearer)))) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, '../../public/rules.html'));
});

router.get('/api-docs.html', (req, res) => {
    // 多应用（§6.8）：API 文档页同样接入会话守卫。
    const sessionId = auth.parseSessionFromCookie(req.headers.cookie);
    const bearer = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
    if (!((sessionId && auth.verifySession(sessionId)) || (bearer && auth.verifyToken(bearer)))) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, '../../public/api-docs.html'));
});

// 多应用（§7.1）：新建向导页（会话守卫）。
router.get('/new', (req, res) => {
    const sessionId = auth.parseSessionFromCookie(req.headers.cookie);
    const bearer = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
    if (!((sessionId && auth.verifySession(sessionId)) || (bearer && auth.verifyToken(bearer)))) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, '../../public/wizard.html'));
});

// 多应用（§7.1）：应用编辑页（会话守卫；完整编辑表单在阶段6 落地，此处先返回页面壳）。
router.get('/edit', (req, res) => {
    const sessionId = auth.parseSessionFromCookie(req.headers.cookie);
    const bearer = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
    if (!((sessionId && auth.verifySession(sessionId)) || (bearer && auth.verifyToken(bearer)))) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, '../../public/edit.html'));
});

// 2. POST /api/validate 验证凭证并获取成员列表
// 多应用（P1-01）：通过 notifier 的 wechat 实例统一验证，与发送/成员读取共享 token 缓存。
router.post('/api/validate', requireAuth, requireJsonObjectBody, async (req, res) => {
    const { corpid, corpsecret, agentid } = req.body || {};
    try {
        const result = await notifier.validateAndListMembers({ corpid, corpsecret, agentid });
        res.json(result);
    } catch (err) {
        sendError(res, err, 400);
    }
});

// 2.1 POST /api/generate-callback 生成回调URL
// 多应用（P0-04）：显式转发 draft_code/version；新建草稿返回 201，更新草稿返回 200。
router.post('/api/generate-callback', requireAuth, requireJsonObjectBody, async (req, res) => {
    const { corpid, callback_token, encoding_aes_key, draft_code, version } = req.body || {};
    if (!corpid || !callback_token || !encoding_aes_key) {
        return res.status(400).json({ error: '回调配置参数不完整', code: 'INVALID_INPUT' });
    }
    try {
        const result = await notifier.createCallbackConfiguration({
            corpid,
            callback_token,
            encoding_aes_key,
            draft_code,
            version
        });
        // 新建草稿（无 draft_code）返回 201；更新现有草稿返回 200。
        res.status(draft_code ? 200 : 201).json(result);
    } catch (err) {
        sendError(res, err);
    }
});

// 3. POST /api/complete-config 完善配置（第二步）
// 多应用（P0-04）：显式转发 version，service 层强制版本校验。
router.post('/api/complete-config', requireAuth, requireJsonObjectBody, async (req, res) => {
    try {
        const { code, corpsecret, agentid, touser, description, version } = req.body || {};
        const result = await notifier.completeConfiguration({ code, corpsecret, agentid, touser, description, version });
        res.status(201).json(result);
    } catch (err) {
        sendError(res, err);
    }
});

// 3.1 POST /api/configure 保存配置并生成唯一code（保持兼容性）
router.post('/api/configure', requireAuth, requireJsonObjectBody, async (req, res) => {
    try {
        const { corpid, corpsecret, agentid, touser, description } = req.body || {};
        const result = await notifier.createConfiguration({ corpid, corpsecret, agentid, touser, description });
        res.status(201).json(result);
    } catch (err) {
        sendError(res, err);
    }
});

// 4. POST /api/notify/:code 发送通知
//
// SEC-003：通知凭证独立化（可选）。
//   - 通知密钥默认关闭：未启用 notify_key 的配置，可直接用 :code 发送，无需鉴权。
//   - 启用了 notify_key 的配置：必须通过 X-Notify-Key 头提供正确 key（可选 HMAC 签名增强）。
//   - HMAC 签名错误/过期/重放返回 401。
router.post('/api/notify/:code', async (req, res) => {
    try {
        notifyLimiter.check(`notify:${clientIp(req)}`);
    } catch (limitErr) {
        res.setHeader('Retry-After', String(limitErr.retryAfter || 1));
        return res.status(429).json({ error: limitErr.message });
    }

    const { code } = req.params;

    // 健壮性：非 JSON Content-Type 或 JSON 解析失败时 req.body 为 undefined，
    // 直接解构会抛 TypeError 被全局兜底捕获返回 500。在此显式校验返回 400。
    // 数组/primitive 同样拒绝（与 requireJsonObjectBody 契约一致），避免静默取不到字段。
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ error: '请求体必须是 JSON 格式（Content-Type: application/json）' });
    }

    const {
        title,
        content,
        msgType = 'text',
        mediaId,
        url,
        btntxt,
        articles,
        safe = 0
    } = req.body;

    try {
        // 鉴权：解析配置/规则 Code，校验 notify_key（REV-002）。
        const authResult = await resolveNotifyAuth(req, code);
        if (!authResult.ok) {
            const body = { error: authResult.error };
            if (authResult.code) body.code = authResult.code;
            return res.status(authResult.statusCode).json(body);
        }

        // REV-002：发送传入原始 requestedCode，保留规则接收范围。
        const options = { msgType, mediaId, url, btntxt, articles, safe, force: req.body.force === true };
        const result = await notifier.sendNotification(authResult.requestedCode, title, content, options);
        res.json({ message: '发送成功', response: result });
    } catch (err) {
        sendError(res, err, 500);
    }
});

// 解析通知鉴权：返回 { ok, requestedCode, statusCode?, error? }。
//
// REV-002 整改：同时解析基础配置 Code 与规则 API Code；规则 Code 使用所属配置的 notify_key，
//              发送仍传入原始 requestedCode（保留规则接收范围）。
// 默认值策略：通知密钥为可选（默认关闭）。有 notify_key_hash -> 必须提供正确 X-Notify-Key；
//             无 notify_key_hash -> 默认放行（无需鉴权），由用户在配置详情页按需启用。
// 启停开关：配置级 code_send_enabled 控制配置 Code 入口；规则级 enabled 控制单条规则入口。
//           关闭对应入口返回 403。
async function resolveNotifyAuth(req, requestedCode) {
    const nodeCrypto = require('crypto');
    const db = notifier._internal.db;

    // 多应用（§4.4 三层发送开关优先级）：
    //   解析 requestedCode 是配置 Code 还是规则 API Code，找到所属 config
    //   → config 不存在：404
    //   → 应用仍是草稿：409 APP_NOT_COMPLETED
    //   → app_enabled = 0：403 APP_DISABLED
    //   → 配置 Code 入口且 code_send_enabled = 0：403 DIRECT_SEND_DISABLED
    //   → 规则入口且 rule.enabled = 0：403 RULE_DISABLED
    //   → 启用通知密钥则校验 X-Notify-Key / HMAC：401
    //   → 通过
    let config = null;
    let viaRule = false;
    const rule = await db.getNotificationRuleByApiCode(requestedCode).catch(() => null);
    if (rule) {
        viaRule = true;
        config = await db.getConfigurationByCode(rule.config_code).catch(() => null);
        if (!config) {
            return { ok: false, statusCode: 404, code: 'APP_NOT_FOUND', error: '规则关联的配置不存在' };
        }
    } else {
        config = await db.getConfigurationByCode(requestedCode).catch(() => null);
    }

    if (!config) {
        return { ok: false, statusCode: 404, code: 'APP_NOT_FOUND', error: '无效的code，未找到配置' };
    }

    // 草稿状态：草稿不能发送，但仍允许回调验证（回调验证不走本函数）。
    if (notifier.isDraftConfig(config)) {
        return { ok: false, statusCode: 409, code: 'APP_NOT_COMPLETED', error: '应用尚未完成配置' };
    }

    // 应用总开关：最高优先级，关闭后配置 Code 与全部规则 API 均被拒绝。
    const appEnabled = config.app_enabled === undefined
        ? true
        : (config.app_enabled === 1 || config.app_enabled === true);
    if (!appEnabled) {
        return { ok: false, statusCode: 403, code: 'APP_DISABLED', error: '该应用已暂停发送' };
    }

    // 子开关：配置 Code 入口 vs 规则入口分别判断。
    if (viaRule) {
        if (rule.enabled === 0) {
            return { ok: false, statusCode: 403, code: 'RULE_DISABLED', error: '该规则已被禁用' };
        }
    } else {
        if (config.code_send_enabled === 0) {
            return { ok: false, statusCode: 403, code: 'DIRECT_SEND_DISABLED', error: '该应用已关闭 Code 直接发送，请使用规则 API' };
        }
    }

    // 有 notify_key_hash -> 必须提供正确 Key（HMAC 可选增强）。
    if (config.notify_key_hash) {
        const providedKey = req.headers[notifyAuth.KEY_HEADER];
        if (!providedKey) {
            return { ok: false, statusCode: 401, code: 'AUTH_REQUIRED', error: '该配置已启用独立通知密钥，请通过 X-Notify-Key 头提供' };
        }
        const providedHash = notifyAuth.hashNotifyKey(providedKey);
        const expected = config.notify_key_hash;
        const a = Buffer.from(providedHash, 'hex');
        const b = Buffer.from(expected, 'hex');
        if (a.length !== b.length || a.length === 0 || !nodeCrypto.timingSafeEqual(a, b)) {
            return { ok: false, statusCode: 401, code: 'AUTH_REQUIRED', error: '通知密钥无效' };
        }
        // 可选 HMAC 校验（使用捕获的原始 body）
        const sigCheck = notifyAuth.verifySignedRequest({
            headers: req.headers,
            method: req.method,
            path: req.path,
            rawBody: req._rawBody || '',
            notifyKey: providedKey
        });
        if (!sigCheck.ok) {
            return { ok: false, statusCode: sigCheck.statusCode, code: 'AUTH_REQUIRED', error: sigCheck.error };
        }
        // REV-002：发送仍传入原始 requestedCode（保留规则接收范围）
        return { ok: true, requestedCode };
    }

    // 默认：未启用通知密钥 -> 放行（无需鉴权）。
    return { ok: true, requestedCode };
}

// 5. GET /api/configuration/:code 获取配置信息
router.get('/api/configuration/:code/users', requireAuth, async (req, res) => {
    const { code } = req.params;
    try {
        const result = await notifier.getConfigMembers(code, { refresh: req.query.refresh === '1' });
        res.json(result);
    } catch (err) {
        sendError(res, err, 500);
    }
});

router.get('/api/configurations', requireAuth, async (req, res) => {
    try {
        const result = await notifier.listConfigurations();
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
});

router.get('/api/configuration/:code/rules', requireAuth, async (req, res) => {
    const { code } = req.params;
    try {
        const result = await notifier.listRules(code);
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
});

router.post('/api/configuration/:code/rules', requireAuth, requireIfMatch, requireJsonObjectBody, async (req, res) => {
    const { code } = req.params;
    try {
        const result = await notifier.createRule(code, req.body || {}, { expectedVersion: req.expectedVersion });
        res.status(201).json(result);
    } catch (err) {
        sendError(res, err);
    }
});

router.put('/api/rules/:id', requireAuth, requireIfMatch, requireJsonObjectBody, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await notifier.updateRule(id, req.body || {}, { expectedVersion: req.expectedVersion });
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
});

router.delete('/api/rules/:id', requireAuth, requireIfMatch, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await notifier.deleteRule(id, { expectedVersion: req.expectedVersion });
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
});

router.post('/api/rules/:id/regenerate', requireAuth, requireIfMatch, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await notifier.regenerateRuleApiCode(id, { expectedVersion: req.expectedVersion });
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
});

// 接收规则 API 自定义编号（规范 §7.8）：可用性预检。
// GET /api/rule-api-codes/availability?api_code=...&rule_id=...
// rule_id 可选（编辑时传当前规则 ID）；非法格式 400 RULE_API_CODE_INVALID；合法 200。
router.get('/api/rule-api-codes/availability', requireAuth, async (req, res) => {
    try {
        const rawApiCode = req.query.api_code;
        let ruleId = null;
        if (req.query.rule_id !== undefined && req.query.rule_id !== null && String(req.query.rule_id).trim() !== '') {
            ruleId = Number(req.query.rule_id);
            if (!Number.isInteger(ruleId) || ruleId < 1) {
                return res.status(400).json({ error: 'rule_id 不合法', code: 'INVALID_INPUT' });
            }
            // rule_id 存在时确认规则存在（只用于判断当前值/自己的退役值，不绕过最终保存校验）。
            const db = notifier._internal.db;
            const rule = await db.getNotificationRuleById(ruleId).catch(() => null);
            if (!rule) {
                return res.status(404).json({ error: '未找到规则', code: 'RULE_NOT_FOUND' });
            }
        }
        const result = await notifier.checkNotifyCodeAvailability(rawApiCode, ruleId);
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
});

router.get('/api/configuration/:code', requireAuth, async (req, res) => {
    const { code } = req.params;
    try {
        const configData = await notifier.getConfiguration(code);
        if (!configData) {
            // 多应用（二次复验 P1-06）：404 补稳定 code。
            return res.status(404).json({ error: '未找到配置', code: 'APP_NOT_FOUND' });
        }
        res.json(configData);
    } catch (err) {
        sendError(res, err);
    }
});

// 6. PUT /api/configuration/:code 更新配置（按 If-Match 局部更新）
router.put('/api/configuration/:code', requireAuth, requireIfMatch, requireJsonObjectBody, async (req, res) => {
    const { code } = req.params;
    try {
        const result = await notifier.updateConfiguration(code, req.body, { expectedVersion: req.expectedVersion });
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
});

// 多应用（§6.6）：DELETE 应用及关联规则（按 If-Match 事务级联删除）
// P1-04：缺 If-Match 时返回 428（禁止 Number(null)===0）。
router.delete('/api/configuration/:code', requireAuth, requireIfMatch, async (req, res) => {
    const { code } = req.params;
    try {
        const result = await notifier.deleteConfiguration(code, req.expectedVersion);
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
});

// 多应用（§6.5）：应用发送总开关（按 If-Match 严格布尔切换）
router.put('/api/configuration/:code/app-enabled', requireAuth, requireIfMatch, requireJsonObjectBody, async (req, res) => {
    const { code } = req.params;
    const enabled = req.body && req.body.enabled;
    if (enabled === undefined || enabled === null) {
        return res.status(400).json({ error: '缺少 enabled 参数', code: 'INVALID_INPUT' });
    }
    try {
        const result = await notifier.setAppEnabled(code, enabled, { expectedVersion: req.expectedVersion });
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
});

// SEC-003：通知密钥（独立于回调 code）管理 —— 轮换 / 撤销（按 If-Match）
router.post('/api/configuration/:code/notify-key', requireAuth, requireIfMatch, requireJsonObjectBody, async (req, res) => {
    const { code } = req.params;
    try {
        const result = await notifier.regenerateNotifyKey(code, { expectedVersion: req.expectedVersion });
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
});

router.delete('/api/configuration/:code/notify-key', requireAuth, requireIfMatch, async (req, res) => {
    const { code } = req.params;
    try {
        const result = await notifier.revokeNotifyKey(code, { expectedVersion: req.expectedVersion });
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
});

// 配置级 Code 发送开关：PUT { enabled: boolean }。
// 多应用（P0-02）：属应用聚合写，必须按 If-Match 校验版本并递增。
router.put('/api/configuration/:code/code-send', requireAuth, requireIfMatch, requireJsonObjectBody, async (req, res) => {
    const { code } = req.params;
    const enabled = req.body && req.body.enabled;
    if (enabled === undefined || enabled === null) {
        return res.status(400).json({ error: '缺少 enabled 参数', code: 'INVALID_INPUT' });
    }
    try {
        // 传入原始 enabled，由 service 用 toStrictBoolean 严格解析（不在此静默转换）。
        const result = await notifier.setCodeSendEnabled(code, enabled, { expectedVersion: req.expectedVersion });
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
});

// 规则启停开关：PUT { enabled: boolean }。禁用的规则其 API 地址发送返回 403。
// 多应用（P0-03）：属应用聚合写，必须按 If-Match 校验版本。
router.put('/api/rules/:id/enabled', requireAuth, requireIfMatch, requireJsonObjectBody, async (req, res) => {
    const { id } = req.params;
    const enabled = req.body && req.body.enabled;
    if (enabled === undefined || enabled === null) {
        return res.status(400).json({ error: '缺少 enabled 参数', code: 'INVALID_INPUT' });
    }
    try {
        const result = await notifier.setRuleEnabled(id, enabled, { expectedVersion: req.expectedVersion });
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
});

// 7. GET /api/callback/:code 企业微信回调验证
router.get('/api/callback/:code', async (req, res) => {
    try {
        callbackLimiter.check(`callback:get:${clientIp(req)}`);
    } catch (limitErr) {
        res.setHeader('Retry-After', String(limitErr.retryAfter || 1));
        return res.status(429).send('failed');
    }

    const { code } = req.params;
    const { msg_signature, timestamp, nonce, echostr } = req.query;

    if (!msg_signature || !timestamp || !nonce || !echostr) {
        return res.status(400).json({ error: '缺少必要的验证参数' });
    }

    try {
        const result = await notifier.handleCallbackVerification(code, msg_signature, timestamp, nonce, echostr);
        if (result.success) {
            res.send(result.data);
        } else {
            res.status(400).send('failed');
        }
    } catch (err) {
        res.status(500).send('failed');
    }
});

// 8. POST /api/callback/:code 企业微信回调消息接收
//
// SEC-013：限制 Content-Type 白名单与请求体上限。
router.post('/api/callback/:code', async (req, res) => {
    try {
        callbackLimiter.check(`callback:post:${clientIp(req)}`);
    } catch (limitErr) {
        res.setHeader('Retry-After', String(limitErr.retryAfter || 1));
        return res.status(429).send('failed');
    }

    const { code } = req.params;
    const { msg_signature, timestamp, nonce } = req.query;

    if (!msg_signature || !timestamp || !nonce) {
        return res.status(400).json({ error: '缺少必要的验证参数' });
    }

    try {
        const encryptedData = req.body ? (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body)) : '';
        notifier.assertCallbackBodySize(Buffer.byteLength(encryptedData, 'utf8'));

        const result = await notifier.handleCallbackMessage(code, encryptedData, msg_signature, timestamp, nonce);
        if (result.success) {
            res.send('ok');
        } else {
            res.status(400).send('failed');
        }
    } catch (err) {
        const status = err.statusCode || 500;
        res.status(status).send('failed');
    }
});

// REV-004：周期清理通知与回调限流器内存（已超限的桶也会被清理）。
if (process.env.NODE_ENV !== 'test') {
    setInterval(() => {
        notifyLimiter.cleanup();
        callbackLimiter.cleanup();
    }, 5 * 60 * 1000).unref();
}

module.exports = router;
