// 多应用（第三轮复验 P1-03）：完整 server.js parser 链的 413/400 必须有稳定业务码。
//
// 生产顺序：json parser → bodyParserErrorHandler → urlencoded parser → callback raw → routes。
// bodyParserErrorHandler 只能接住它之前 json parser 的异常；urlencoded/raw 的 413 绕过它，
// 返回框架英文 "request entity too large"，缺少 PAYLOAD_TOO_LARGE code。
//
// 本测试复刻 server.js 的完整 parser 顺序，对畸形/超限的 urlencoded 与 callback raw
// 断言返回稳定 JSON code。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-third-fix-review-ai-execution-guide.md §4 P1-03。

const assert = require('assert/strict');
const http = require('http');
const test = require('node:test');

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

// 复刻 server.js 的完整 parser 链顺序。
function buildApp(t) {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const express = require('express');
    const { jsonBodyParser, bodyParserErrorHandler } = require('../src/core/body-parser');
    const auth = require('../src/core/auth');
    const notifier = require('../src/services/notifier');

    replaceForTest(t, auth, 'verifyToken', () => true);
    replaceForTest(t, auth, 'verifySession', () => true);

    const app = express();
    // 复刻 server.js 新顺序：json parser → urlencoded → raw → handler → routes → global handler。
    // handler 必须在所有 parser 之后，才能接住任意 parser 抛出的 400/413。
    app.use(...jsonBodyParser({ limit: '256kb' }));
    app.use(express.urlencoded({ extended: true, limit: '256kb' }));
    const CALLBACK_MAX = Number(process.env.CALLBACK_MAX_BODY_BYTES || 102400);
    app.use('/api/callback', express.raw({
        type: ['text/xml', 'application/xml', 'text/plain'],
        limit: CALLBACK_MAX
    }));
    app.use(bodyParserErrorHandler);
    const routes = require('../src/api/routes');
    app.use('/', routes);
    // 全局兜底错误中间件（复刻 server.js 新版：413 归一化为 PAYLOAD_TOO_LARGE）。
    app.use((err, _req, res, _next) => {
        const status = err && (err.statusCode || err.status) || 500;
        const errType = err && (err.type || (err.constructor && err.constructor.name)) || '';
        if (status === 413 || errType === 'entity.too.large' || /entity too large/i.test(err && err.message || '')) {
            return res.status(413).json({ error: '请求体超过大小限制', code: 'PAYLOAD_TOO_LARGE' });
        }
        const body = { error: (err && err.message) || '请求失败' };
        if (err && err.businessCode) body.code = err.businessCode;
        if (status < 500 && !body.code) body.code = 'INVALID_INPUT';
        if (status >= 500 && !body.code) body.code = 'INTERNAL_ERROR';
        res.status(status).json(body);
    });
    return app;
}

async function startServer(app) {
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    return server;
}

async function rawReq(server, method, path, { body, headers = {} } = {}) {
    const { port } = server.address();
    return await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        body
    });
}

test('P1-03: JSON 畸形返回 400 INVALID_INPUT（json parser 链路，已覆盖）', async t => {
    const app = buildApp(t);
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));
    const res = await rawReq(server, 'PUT', '/api/configuration/x', {
        body: '{bad json',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json', 'if-match': '1' }
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'INVALID_INPUT');
});

test('P1-03: urlencoded 超限返回 413 PAYLOAD_TOO_LARGE（当前失败：绕过 handler）', async t => {
    const app = buildApp(t);
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));
    // 构造超过 256kb 的 urlencoded body。
    const big = 'a='.repeat(300 * 1024);
    const res = await rawReq(server, 'POST', '/api/login', {
        body: big,
        headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    assert.equal(res.status, 413, 'urlencoded 超限应 413');
    const body = await res.json();
    assert.equal(body.code, 'PAYLOAD_TOO_LARGE', 'urlencoded 413 应有 PAYLOAD_TOO_LARGE code（当前绕过 handler）');
    // 不应泄漏框架英文错误。
    assert.ok(!/request entity too large/i.test(JSON.stringify(body)), '不应泄漏框架英文错误');
});

test('P1-03: callback raw 超限返回 413 PAYLOAD_TOO_LARGE（当前失败）', async t => {
    // 用很小的 limit 触发 raw 超限。
    withEnv(t, 'CALLBACK_MAX_BODY_BYTES', '100');
    const app = buildApp(t);
    const server = await startServer(app);
    t.after(() => new Promise(r => server.close(r)));
    const big = 'x'.repeat(200);
    const res = await rawReq(server, 'POST', '/api/callback/some-code?msg_signature=s&timestamp=1&nonce=n', {
        body: big,
        headers: { 'content-type': 'text/xml' }
    });
    assert.equal(res.status, 413, 'callback raw 超限应 413');
    // raw 路由返回 'failed' 文本，但也应有 JSON code 契约——本测试要求 413 JSON code。
    const text = await res.text();
    assert.ok(
        text.includes('PAYLOAD_TOO_LARGE') || (res.headers.get('content-type') || '').includes('application/json'),
        'callback raw 413 应返回 JSON 含 PAYLOAD_TOO_LARGE code（当前返回纯文本 failed）'
    );
});
