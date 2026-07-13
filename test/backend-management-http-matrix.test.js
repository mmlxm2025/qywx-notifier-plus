// 阶段 A（先补会失败的测试）：真实 HTTP 管理写路由矩阵（§6.1）。
//
// 复验指南 §6.1：现有“管理路由”测试只在 service 层调用，没有经过 HTTP 路由。
// 必须新增真实 HTTP 集成测试，覆盖 requireAuth/requireIfMatch 中间件顺序、
// 路由转发 draft_code/version/expectedVersion、HTTP 状态码与响应结构。
// 使用 Node 内置 fetch + 临时端口，不新增 supertest 依赖。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-fix-verification-ai-execution-guide.md §6.1。

const assert = require('assert/strict');
const test = require('node:test');
const http = require('http');

function clearModule(modulePath) {
    delete require.cache[require.resolve(modulePath)];
}

function replaceForTest(t, object, property, value) {
    const hadProperty = Object.prototype.hasOwnProperty.call(object, property);
    const original = object[property];
    object[property] = value;
    t.after(() => {
        if (hadProperty) object[property] = original;
        else delete object[property];
    });
}

function withEnv(t, key, value) {
    const hadValue = Object.prototype.hasOwnProperty.call(process.env, key);
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => {
        if (hadValue) process.env[key] = original;
        else delete process.env[key];
    });
}

function completedConfig(overrides = {}) {
    return {
        code: 'app-a',
        corpid: 'corp-1',
        encrypted_corpsecret: 'enc-secret',
        agentid: 100001,
        touser: 'alice',
        description: '',
        callback_enabled: 0,
        notify_key_hash: null,
        legacy_until: null,
        code_send_enabled: 1,
        app_enabled: 1,
        version: 2,
        created_at: '2026-07-01 00:00:00',
        ...overrides
    };
}

// 装配 Express app + 注入桩 DAO/WeChat。notifier 方法仍走真实实现，验证中间件链路。
function buildApp(t, { authenticated = true, config = completedConfig() } = {}) {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const auth = require('../src/core/auth');
    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');

    replaceForTest(t, auth, 'verifyToken', () => authenticated);
    replaceForTest(t, auth, 'verifySession', () => authenticated);

    // 多应用（二次复验 P1-06）：config 可为 null（用于测试 APP_NOT_FOUND 路径）。
    const cfgStore = config ? { [config.code]: { ...config } } : {};
    replaceForTest(t, Database.prototype, 'init', async function () {});
    replaceForTest(t, Database.prototype, 'getConfigurationByCode', async function (code) {
        const r = cfgStore[code];
        return r ? { ...r } : null;
    });
    replaceForTest(t, Database.prototype, 'findCompletedByCorpidAgentId', async function () { return null; });
    replaceForTest(t, Database.prototype, 'findDuplicatesByCorpidAgentId', async function () { return []; });
    replaceForTest(t, Database.prototype, 'countRulesByConfigCodes', async function () { return {}; });
    replaceForTest(t, Database.prototype, 'listNotificationRules', async function () { return []; });
    // updateConfigurationFields：CAS。
    replaceForTest(t, Database.prototype, 'updateConfigurationFields', async function (code, fields, expectedVersion) {
        const row = cfgStore[code];
        if (!row) return { code, changes: 0, version: null };
        const match = Number(row.version) === Number(expectedVersion);
        const changes = match ? 1 : 0;
        if (changes > 0) {
            Object.assign(row, fields);
            row.version = Number(row.version) + 1;
        }
        return { code, changes, version: Number(row.version) };
    });
    // updateConfigurationAtomic 桩（R-P0-01 阶段 B 落地后接入）。
    replaceForTest(t, Database.prototype, 'updateConfigurationAtomic', async function (code, fields, expectedVersion) {
        const row = cfgStore[code];
        if (!row) { const e = new Error('m'); e.__updateCause = 'missing'; throw e; }
        if (Number(row.version) !== Number(expectedVersion)) {
            const e = new Error('v'); e.__updateCause = 'version_conflict'; e.__currentVersion = row.version; throw e;
        }
        Object.assign(row, fields);
        row.version = Number(row.version) + 1;
        return { code, version: row.version };
    });
    replaceForTest(t, Database.prototype, 'deleteConfigurationCascade', async function (code, expectedVersion) {
        return { configurations_deleted: 1, rules_deleted: 0 };
    });
    // 接收规则 API 自定义编号（规范 §11.3）：桩支持新 SQL——默认无冲突、退役登记空操作。
    // 该矩阵测试聚焦中间件链路与版本契约，编号冲突由专门测试覆盖。
    replaceForTest(t, Database.prototype, 'inspectNotifyCodeConflict', async function () { return null; });
    replaceForTest(t, Database.prototype, 'retireNotifyCode', async function () { /* noop */ });
    // 规则聚合事务桩：CAS 校验版本。
    replaceForTest(t, Database.prototype, 'mutateRuleWithAppVersion', async function (identity, expectedVersion, mutation) {
        if (Number(expectedVersion) !== Number(config.version)) {
            const e = new Error('version_conflict');
            e.__ruleCause = 'version_conflict';
            e.__currentVersion = Number(config.version);
            throw e;
        }
        const app = { ...config };
        return { rule: await mutation({ run: async () => ({ changes: 1, lastID: 9 }), get: async () => ({ id: 1, config_code: config.code, api_code: 'r' }), all: async () => [] }, app), app_version: (Number(config.version) || 1) + 1 };
    });
    replaceForTest(t, Database.prototype, 'getNotificationRuleById', async function () { return null; });

    replaceForTest(t, CryptoService.prototype, 'decrypt', function (v) { return String(v).replace(/^enc-/, ''); });
    replaceForTest(t, CryptoService.prototype, 'encrypt', function (v) { return `enc-${v}`; });
    replaceForTest(t, CryptoService.prototype, 'isLegacyCiphertext', function () { return false; });
    replaceForTest(t, WeChatService.prototype, 'getToken', async () => 't');
    replaceForTest(t, WeChatService.prototype, 'getAgentInfo', async (tok, id) => ({ agentid: id }));
    replaceForTest(t, WeChatService.prototype, 'getAgentVisibleUsers', async () => []);
    replaceForTest(t, WeChatService.prototype, 'invalidateToken', async () => {});

    clearModule('../src/services/notifier');
    clearModule('../src/api/routes');
    t.after(() => {
        clearModule('../src/services/notifier');
        clearModule('../src/api/routes');
    });
    require('../src/services/notifier');
    const routes = require('../src/api/routes');
    const express = require('express');
    const { jsonBodyParser, bodyParserErrorHandler } = require('../src/core/body-parser');
    const app = express();
    // 多应用（二次复验 P1-01）：使用生产 body parser + 错误中间件，验证真实链路。
    app.use(...jsonBodyParser({ limit: '256kb' }));
    app.use(bodyParserErrorHandler);
    // 兜底：未预期 5xx 返回 JSON INTERNAL_ERROR（与 server.js 一致）。
    app.use((err, _req, res, _next) => {
        const status = err && (err.statusCode || err.status) || 500;
        const body = { error: (err && err.message) || '请求失败' };
        if (err && err.businessCode) body.code = err.businessCode;
        if (status >= 500 && !body.code) body.code = 'INTERNAL_ERROR';
        res.status(status).json(body);
    });
    app.use(routes);
    return app;
}

async function startServer(app) {
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    return server;
}

async function req(server, method, path, { body, headers = {} } = {}) {
    const { port } = server.address();
    const payload = body === undefined ? null : JSON.stringify(body);
    return await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
            authorization: 'Bearer test-token',
            ...(payload ? { 'content-type': 'application/json' } : {}),
            ...headers
        },
        body: payload
    });
}

// ─── PUT /api/configuration/:code/app-enabled ──────────────────────────

test('HTTP 矩阵 app-enabled: 成功/缺版本/非法版本/旧版本/无认证', async t => {
    const app = buildApp(t);
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));

    // 成功。
    let res = await req(server, 'PUT', '/api/configuration/app-a/app-enabled', { body: { enabled: false }, headers: { 'If-Match': '2' } });
    assert.equal(res.status, 200);
    // 缺版本。
    res = await req(server, 'PUT', '/api/configuration/app-a/app-enabled', { body: { enabled: false } });
    assert.equal(res.status, 428);
    assert.equal((await res.json()).code, 'APP_VERSION_REQUIRED');
    // 非法版本。
    res = await req(server, 'PUT', '/api/configuration/app-a/app-enabled', { body: { enabled: false }, headers: { 'If-Match': 'abc' } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'INVALID_INPUT');
    // 旧版本（服务端 version=2，传 1）。
    res = await req(server, 'PUT', '/api/configuration/app-a/app-enabled', { body: { enabled: true }, headers: { 'If-Match': '1' } });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'APP_VERSION_CONFLICT');
    // 无认证。
    const { port } = server.address();
    res = await fetch(`http://127.0.0.1:${port}/api/configuration/app-a/app-enabled`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'If-Match': '2' },
        body: JSON.stringify({ enabled: false })
    });
    assert.equal(res.status, 401);
});

// ─── PUT /api/configuration/:code/code-send ─────────────────────────────

test('HTTP 矩阵 code-send: 成功/缺版本/非法版本/旧版本', async t => {
    const app = buildApp(t);
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));

    let res = await req(server, 'PUT', '/api/configuration/app-a/code-send', { body: { enabled: false }, headers: { 'If-Match': '2' } });
    assert.equal(res.status, 200);
    res = await req(server, 'PUT', '/api/configuration/app-a/code-send', { body: { enabled: false } });
    assert.equal(res.status, 428);
    res = await req(server, 'PUT', '/api/configuration/app-a/code-send', { body: { enabled: false }, headers: { 'If-Match': '0' } });
    assert.equal(res.status, 400);
    res = await req(server, 'PUT', '/api/configuration/app-a/code-send', { body: { enabled: true }, headers: { 'If-Match': '99' } });
    assert.equal(res.status, 409);
});

// ─── rules create/update/delete/regenerate/enabled ──────────────────────

test('HTTP 矩阵 rules: create 成功/缺版本/非法/旧版本', async t => {
    const app = buildApp(t);
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));

    let res = await req(server, 'POST', '/api/configuration/app-a/rules', { body: { name: 'r', touser: 'alice' }, headers: { 'If-Match': '2' } });
    assert.equal(res.status, 201);
    res = await req(server, 'POST', '/api/configuration/app-a/rules', { body: { name: 'r', touser: 'alice' } });
    assert.equal(res.status, 428);
    res = await req(server, 'POST', '/api/configuration/app-a/rules', { body: { name: 'r', touser: 'alice' }, headers: { 'If-Match': 'x' } });
    assert.equal(res.status, 400);
    res = await req(server, 'POST', '/api/configuration/app-a/rules', { body: { name: 'r', touser: 'alice' }, headers: { 'If-Match': '1' } });
    assert.equal(res.status, 409);
});

// ─── configuration PUT/DELETE ────────────────────────────────────────────

test('HTTP 矩阵 configuration PUT: 成功/缺版本/非法/旧版本', async t => {
    const app = buildApp(t);
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));

    let res = await req(server, 'PUT', '/api/configuration/app-a', { body: { description: 'new' }, headers: { 'If-Match': '2' } });
    assert.equal(res.status, 200);
    res = await req(server, 'PUT', '/api/configuration/app-a', { body: { description: 'new' } });
    assert.equal(res.status, 428);
    res = await req(server, 'PUT', '/api/configuration/app-a', { body: { description: 'new' }, headers: { 'If-Match': '-1' } });
    assert.equal(res.status, 400);
});

test('HTTP 矩阵 configuration DELETE: 缺版本 428', async t => {
    const app = buildApp(t);
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));

    const res = await req(server, 'DELETE', '/api/configuration/app-a');
    assert.equal(res.status, 428);
    assert.equal((await res.json()).code, 'APP_VERSION_REQUIRED');
});

// ─── notify-key POST/DELETE ─────────────────────────────────────────────

test('HTTP 矩阵 notify-key: POST 缺版本 428', async t => {
    const app = buildApp(t);
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));

    const res = await req(server, 'POST', '/api/configuration/app-a/notify-key');
    assert.equal(res.status, 428);
});

// ─── legacy-grace（删除后应 404，不存在该路由） ─────────────────────────
// R-P1-04 决定删除 legacy-grace 能力：路由应不再存在。

test('HTTP 矩阵: legacy-grace 路由已删除返回 404', async t => {
    const app = buildApp(t);
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));

    const res = await req(server, 'POST', '/api/configuration/app-a/legacy-grace', { body: { seconds: 60 }, headers: { 'If-Match': '2' } });
    assert.equal(res.status, 404);
});

// ─── 健壮性：缺 body / 非 JSON body 不应 500（真实服务器测试发现） ────────

test('HTTP 矩阵: generate-callback 缺 body 返回 400 而非 500', async t => {
    const app = buildApp(t);
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));
    // 不发 body、不发 content-type。
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/generate-callback`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token' }
    });
    assert.equal(res.status, 400, '缺 body 应 400 而非 500');
    assert.equal((await res.json()).code, 'INVALID_INPUT');
});

test('HTTP 矩阵: complete-config 缺 body 返回错误码而非 500', async t => {
    const app = buildApp(t);
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/complete-config`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token' }
    });
    assert.ok(res.status < 500, '缺 body 不应 500，实际: ' + res.status);
});

// ─── 多应用（二次复验 P1-01）：请求体错误契约 ────────────────────────────
// 畸形 JSON、数组 body、primitive body、非 JSON Content-Type 均返回稳定 JSON code，
// 不返回 HTML/TypeError/堆栈。使用生产 jsonBodyParser + bodyParserErrorHandler。

test('P1-01: 畸形 JSON 返回 400 INVALID_INPUT JSON（非 HTML）', async t => {
    const app = buildApp(t);
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/configuration/app-a`, {
        method: 'PUT',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', 'If-Match': '2' },
        body: '{not valid json'
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = await res.json();
    assert.equal(body.code, 'INVALID_INPUT');
    assert.ok(!JSON.stringify(body).includes('SyntaxError'), '不得泄露 SyntaxError');
});

test('P1-01: 数组 body 返回 400 INVALID_INPUT（PUT configuration）', async t => {
    const app = buildApp(t);
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));
    const res = await req(server, 'PUT', '/api/configuration/app-a', { body: [1, 2, 3], headers: { 'If-Match': '2' } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'INVALID_INPUT');
});

test('P1-01: primitive body 返回 400 INVALID_INPUT', async t => {
    const app = buildApp(t);
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/configuration/app-a`, {
        method: 'PUT',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', 'If-Match': '2' },
        body: '"just a string"'
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'INVALID_INPUT');
});

test('P1-01: 缺 body 的 PUT configuration 返回 400 INVALID_INPUT', async t => {
    const app = buildApp(t);
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));
    const { port } = server.address();
    // 不发 body、不发 content-type。
    const res = await fetch(`http://127.0.0.1:${port}/api/configuration/app-a`, {
        method: 'PUT',
        headers: { authorization: 'Bearer test-token', 'If-Match': '2' }
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'INVALID_INPUT');
});

test('P1-01: 数组 body 的 rules create 返回 400 INVALID_INPUT', async t => {
    const app = buildApp(t);
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));
    const res = await req(server, 'POST', '/api/configuration/app-a/rules', { body: [], headers: { 'If-Match': '2' } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'INVALID_INPUT');
});

// ─── 多应用（二次复验 P1-06）：稳定错误码补齐 ──────────────────────────────

test('P1-06: requireAuth 401 包含 AUTH_REQUIRED code', async t => {
    const app = buildApp(t, { authenticated: false });
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));
    const res = await req(server, 'GET', '/api/configurations');
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'AUTH_REQUIRED');
});

test('P1-06: GET /api/configuration/:code 不存在返回 APP_NOT_FOUND code', async t => {
    const app = buildApp(t, { authenticated: true, config: null });
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));
    const res = await req(server, 'GET', '/api/configuration/missing-code');
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, 'APP_NOT_FOUND');
});
