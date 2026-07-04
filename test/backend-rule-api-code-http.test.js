// 阶段 A5（HTTP 合约测试）：接收规则 API 自定义编号的 HTTP 合约（规范 §11.4）。
//
// 使用真实临时 SQLite + 真实 Express app + 临时端口，验证完整 HTTP 链路：
//   - 创建/更新自定义编号成功。
//   - 创建/更新仍要求认证和 If-Match。
//   - 缺版本 428、非法版本 400、旧版本 409。
//   - 非法编号 400 RULE_API_CODE_INVALID。
//   - 占用编号 409 RULE_API_CODE_CONFLICT。
//   - 编号冲突不被 AppHttp.isVersionConflict 误判。
//   - availability 未登录 401、非法格式 400、四类结果 200。
//   - 更新不存在规则 404。

const assert = require('assert/strict');
const test = require('node:test');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

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

// 装配真实 Express app + 真实 SQLite（临时库）+ 屏蔽网络层。返回 { app, db, baseUrl }。
async function buildRealApp(t, { authenticated = true } = {}) {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const dbPath = path.join(os.tmpdir(), `rule-api-http-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    withEnv(t, 'DB_PATH', dbPath);
    t.after(() => { try { fs.unlinkSync(dbPath); } catch (_e) { /* ignore */ } });

    clearModule('../src/core/database');
    clearModule('../src/services/notifier');
    clearModule('../src/api/routes');
    t.after(() => {
        clearModule('../src/core/database');
        clearModule('../src/services/notifier');
        clearModule('../src/api/routes');
    });

    const auth = require('../src/core/auth');
    replaceForTest(t, auth, 'verifyToken', () => authenticated);
    replaceForTest(t, auth, 'verifySession', () => authenticated);
    replaceForTest(t, auth, 'parseSessionFromCookie', () => 'test-session');

    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');
    replaceForTest(t, CryptoService.prototype, 'decrypt', function (v) { return String(v).replace(/^enc-/, ''); });
    replaceForTest(t, CryptoService.prototype, 'encrypt', function (v) { return `enc-${v}`; });
    replaceForTest(t, CryptoService.prototype, 'isLegacyCiphertext', function () { return false; });
    replaceForTest(t, WeChatService.prototype, 'getToken', async () => 't');
    replaceForTest(t, WeChatService.prototype, 'getAgentInfo', async (tok, id) => ({ agentid: id }));
    replaceForTest(t, WeChatService.prototype, 'getAgentVisibleUsers', async () => []);
    replaceForTest(t, WeChatService.prototype, 'invalidateToken', async () => {});

    const notifier = require('../src/services/notifier');
    await notifier.ensureDbReady();
    const db = notifier._internal.db;
    t.after(async () => { try { await db.close(); } catch (_e) { /* ignore */ } });

    const routes = require('../src/api/routes');
    const express = require('express');
    const { jsonBodyParser, bodyParserErrorHandler } = require('../src/core/body-parser');
    const app = express();
    app.use(...jsonBodyParser({ limit: '256kb' }));
    app.use(bodyParserErrorHandler);
    app.use((err, _req, res, _next) => {
        const status = err && (err.statusCode || err.status) || 500;
        const body = { error: (err && err.message) || '请求失败' };
        if (err && err.businessCode) body.code = err.businessCode;
        if (err && err.details) body.details = err.details;
        if (status >= 500 && !body.code) body.code = 'INTERNAL_ERROR';
        res.status(status).json(body);
    });
    app.use(routes);

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    t.after(() => { try { server.close(); } catch (_e) { /* ignore */ } });
    const baseUrl = `http://127.0.0.1:${port}`;
    return { notifier, db, baseUrl };
}

async function insertCompletedApp(db, code, { version = 1, touser = 'alice' } = {}) {
    await db.runRaw(
        `INSERT INTO configurations (code, corpid, encrypted_corpsecret, agentid, touser, description,
            callback_enabled, notify_key_hash, legacy_until, code_send_enabled, app_enabled, version)
         VALUES (?, ?, ?, ?, ?, '', 0, NULL, NULL, 1, 1, ?)`,
        [code, `corp-${code}`, 'enc-secret', 100001, touser, version]
    );
}

async function req(baseUrl, method, path, { headers = {}, body } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (_e) { /* ignore */ }
    return { status: res.status, data };
}

const AUTH_HEADERS = { 'Authorization': 'Bearer test-token', 'Content-Type': 'application/json' };

test('创建自定义编号：成功返回 201 + 规范化编号', async t => {
    const { db, baseUrl } = await buildRealApp(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const res = await req(baseUrl, 'POST', '/api/configuration/app-a/rules', {
        headers: { ...AUTH_HEADERS, 'If-Match': '1' },
        body: { name: '生产告警', api_code: 'Ops-Alert', touser: ['alice'] }
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.api_code, 'ops-alert');
    assert.equal(res.data.apiUrl, '/api/notify/ops-alert');
    assert.equal(res.data.app_version, 2);
});

test('创建规则仍要求 If-Match：缺失返回 428', async t => {
    const { db, baseUrl } = await buildRealApp(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const res = await req(baseUrl, 'POST', '/api/configuration/app-a/rules', {
        headers: AUTH_HEADERS,
        body: { name: 'r1', touser: ['alice'] }
    });
    assert.equal(res.status, 428);
    assert.equal(res.data.code, 'APP_VERSION_REQUIRED');
});

test('创建规则要求认证：未登录返回 401', async t => {
    const app = await buildRealApp(t, { authenticated: false });
    const res = await req(app.baseUrl, 'POST', '/api/configuration/app-a/rules', {
        headers: { 'Content-Type': 'application/json', 'If-Match': '1' },
        body: { name: 'r1', touser: ['alice'] }
    });
    assert.equal(res.status, 401);
    assert.equal(res.data.code, 'AUTH_REQUIRED');
});

test('非法编号返回 400 RULE_API_CODE_INVALID', async t => {
    const { db, baseUrl } = await buildRealApp(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const res = await req(baseUrl, 'POST', '/api/configuration/app-a/rules', {
        headers: { ...AUTH_HEADERS, 'If-Match': '1' },
        body: { name: 'r1', api_code: 'ab', touser: ['alice'] }
    });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'RULE_API_CODE_INVALID');
    assert.equal(res.data.details.field, 'api_code');
});

test('占用编号返回 409 RULE_API_CODE_CONFLICT', async t => {
    const { db, baseUrl } = await buildRealApp(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    await req(baseUrl, 'POST', '/api/configuration/app-a/rules', {
        headers: { ...AUTH_HEADERS, 'If-Match': '1' },
        body: { name: 'r1', api_code: 'taken', touser: ['alice'] }
    });
    const res = await req(baseUrl, 'POST', '/api/configuration/app-a/rules', {
        headers: { ...AUTH_HEADERS, 'If-Match': '2' },
        body: { name: 'r2', api_code: 'taken', touser: ['bob'] }
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'RULE_API_CODE_CONFLICT');
    assert.equal(res.data.details.conflict_scope, 'rule');
    // 编号冲突不得携带 details.version（避免被 isVersionConflict 误判）
    assert.equal(res.data.details.version, undefined);
});

test('更新不存在规则返回 404 RULE_NOT_FOUND', async t => {
    const { db, baseUrl } = await buildRealApp(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const res = await req(baseUrl, 'PUT', '/api/rules/9999', {
        headers: { ...AUTH_HEADERS, 'If-Match': '1' },
        body: { name: 'r1', touser: ['alice'] }
    });
    assert.equal(res.status, 404);
    assert.equal(res.data.code, 'RULE_NOT_FOUND');
});

test('更新版本冲突返回 409 APP_VERSION_CONFLICT', async t => {
    const { db, baseUrl } = await buildRealApp(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const created = await req(baseUrl, 'POST', '/api/configuration/app-a/rules', {
        headers: { ...AUTH_HEADERS, 'If-Match': '1' },
        body: { name: 'r1', api_code: 'valid1', touser: ['alice'] }
    });
    // 用过期的 If-Match（1 而非 2）
    const res = await req(baseUrl, 'PUT', `/api/rules/${created.data.id}`, {
        headers: { ...AUTH_HEADERS, 'If-Match': '1' },
        body: { name: 'r1', touser: ['alice'] }
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'APP_VERSION_CONFLICT');
    assert.ok(res.data.details.version !== undefined, '版本冲突应携带 details.version');
});

test('更新自定义编号成功返回 api_code_changed', async t => {
    const { db, baseUrl } = await buildRealApp(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const created = await req(baseUrl, 'POST', '/api/configuration/app-a/rules', {
        headers: { ...AUTH_HEADERS, 'If-Match': '1' },
        body: { name: 'r1', api_code: 'first1', touser: ['alice'] }
    });
    const res = await req(baseUrl, 'PUT', `/api/rules/${created.data.id}`, {
        headers: { ...AUTH_HEADERS, 'If-Match': '2' },
        body: { name: 'r1', api_code: 'second1', touser: ['alice'] }
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.api_code, 'second1');
    assert.equal(res.data.api_code_changed, true);
});

test('availability：未登录 401', async t => {
    const app = await buildRealApp(t, { authenticated: false });
    const res = await req(app.baseUrl, 'GET', '/api/rule-api-codes/availability?api_code=test123');
    assert.equal(res.status, 401);
    assert.equal(res.data.code, 'AUTH_REQUIRED');
});

test('availability：非法格式 400', async t => {
    const { db, baseUrl } = await buildRealApp(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const res = await req(baseUrl, 'GET', '/api/rule-api-codes/availability?api_code=ab', {
        headers: { 'Authorization': 'Bearer test-token' }
    });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'RULE_API_CODE_INVALID');
});

test('availability：可用编号返回 200 available=true', async t => {
    const { db, baseUrl } = await buildRealApp(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const res = await req(baseUrl, 'GET', '/api/rule-api-codes/availability?api_code=free123', {
        headers: { 'Authorization': 'Bearer test-token' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.available, true);
    assert.equal(res.data.reason, null);
    assert.equal(res.data.api_code, 'free123');
});

test('availability：被规则占用返回 reason=rule', async t => {
    const { db, baseUrl } = await buildRealApp(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    await req(baseUrl, 'POST', '/api/configuration/app-a/rules', {
        headers: { ...AUTH_HEADERS, 'If-Match': '1' },
        body: { name: 'r1', api_code: 'occupied', touser: ['alice'] }
    });
    const res = await req(baseUrl, 'GET', '/api/rule-api-codes/availability?api_code=occupied', {
        headers: { 'Authorization': 'Bearer test-token' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.available, false);
    assert.equal(res.data.reason, 'rule');
});

test('availability：与配置 Code 冲突返回 reason=configuration', async t => {
    const { db, baseUrl } = await buildRealApp(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const res = await req(baseUrl, 'GET', '/api/rule-api-codes/availability?api_code=app-a', {
        headers: { 'Authorization': 'Bearer test-token' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.available, false);
    assert.equal(res.data.reason, 'configuration');
});

test('availability：被退役编号占用返回 reason=retired', async t => {
    const { db, baseUrl } = await buildRealApp(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    // 创建后改号，使旧编号退役
    const created = await req(baseUrl, 'POST', '/api/configuration/app-a/rules', {
        headers: { ...AUTH_HEADERS, 'If-Match': '1' },
        body: { name: 'r1', api_code: 'before1', touser: ['alice'] }
    });
    await req(baseUrl, 'PUT', `/api/rules/${created.data.id}`, {
        headers: { ...AUTH_HEADERS, 'If-Match': '2' },
        body: { name: 'r1', api_code: 'after1', touser: ['alice'] }
    });
    const res = await req(baseUrl, 'GET', '/api/rule-api-codes/availability?api_code=before1', {
        headers: { 'Authorization': 'Bearer test-token' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.available, false);
    assert.equal(res.data.reason, 'retired');
});

test('availability：编辑时传自己的 rule_id，当前值视为可用', async t => {
    const { db, baseUrl } = await buildRealApp(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const created = await req(baseUrl, 'POST', '/api/configuration/app-a/rules', {
        headers: { ...AUTH_HEADERS, 'If-Match': '1' },
        body: { name: 'r1', api_code: 'mine01', touser: ['alice'] }
    });
    const res = await req(baseUrl, 'GET', `/api/rule-api-codes/availability?api_code=mine01&rule_id=${created.data.id}`, {
        headers: { 'Authorization': 'Bearer test-token' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.available, true, '编辑时自己的当前编号应视为可用');
});
