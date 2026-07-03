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
        if (hadProperty) {
            object[property] = original;
        } else {
            delete object[property];
        }
    });
}

function patchNotifierDependencies(t, { config, duplicate = null, memberError = null } = {}) {
    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');

    const calls = {
        duplicateLookup: null,
        updatedConfig: null,
        agentInfo: null,
        visibleUsers: null
    };

    replaceForTest(t, Database.prototype, 'init', async function init() {});
    replaceForTest(t, Database.prototype, 'getConfigurationByCode', async function getConfigurationByCode(code) {
        if (!config || code !== config.code) return null;
        return { ...config };
    });
    replaceForTest(t, Database.prototype, 'getConfigurationByFields', async function getConfigurationByFields(corpid, agentid, touser) {
        calls.duplicateLookup = { corpid, agentid, touser };
        return duplicate;
    });
    replaceForTest(t, Database.prototype, 'updateConfiguration', async function updateConfiguration(updated) {
        calls.updatedConfig = { ...updated };
        return { code: updated.code };
    });

    replaceForTest(t, CryptoService.prototype, 'decrypt', function decrypt(value) {
        assert.equal(value, 'encrypted-secret');
        return 'plain-secret';
    });
    replaceForTest(t, CryptoService.prototype, 'encrypt', function encrypt(value) {
        return `encrypted:${value}`;
    });

    replaceForTest(t, WeChatService.prototype, 'getToken', async function getToken(corpid, corpsecret) {
        assert.equal(corpid, 'corp-1');
        assert.equal(corpsecret, 'plain-secret');
        return 'access-token';
    });
    replaceForTest(t, WeChatService.prototype, 'getAgentInfo', async function getAgentInfo(accessToken, agentid) {
        calls.agentInfo = { accessToken, agentid };
        return { agentid, name: '告警应用' };
    });
    replaceForTest(t, WeChatService.prototype, 'getAgentVisibleUsers', async function getAgentVisibleUsers(accessToken, agentInfo) {
        calls.visibleUsers = { accessToken, agentInfo };
        if (memberError) throw memberError;
        assert.equal(accessToken, 'access-token');
        return [
            { userid: 'alice', name: 'Alice', mobile: 'hidden' },
            { userid: 'bob', name: '', email: 'hidden' }
        ];
    });

    clearModule('../src/services/notifier');
    t.after(() => {
        clearModule('../src/services/notifier');
        clearModule('../src/api/routes');
    });
    const notifier = require('../src/services/notifier');
    return { notifier, calls };
}

function completedConfig(overrides = {}) {
    return {
        code: 'code-1',
        corpid: 'corp-1',
        encrypted_corpsecret: 'encrypted-secret',
        agentid: 100001,
        touser: 'alice|missing|| ',
        description: 'old description',
        callback_token: 'old-token',
        encrypted_encoding_aes_key: 'old-key',
        callback_enabled: 1,
        ...overrides
    };
}

async function request(app, method, path, body) {
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const { port } = server.address();

    try {
        return await new Promise((resolve, reject) => {
            const payload = body === undefined ? null : JSON.stringify(body);
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path,
                method,
                headers: {
                    authorization: 'Bearer test-token',
                    ...(payload ? {
                        'content-type': 'application/json',
                        'content-length': Buffer.byteLength(payload)
                    } : {})
                }
            }, res => {
                let responseBody = '';
                res.setEncoding('utf8');
                res.on('data', chunk => {
                    responseBody += chunk;
                });
                res.on('end', () => {
                    resolve({ statusCode: res.statusCode, body: responseBody });
                });
            });
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

function buildApp(t, { authenticated = true } = {}) {
    const express = require('express');
    const auth = require('../src/core/auth');
    replaceForTest(t, auth, 'verifyToken', () => authenticated);

    clearModule('../src/api/routes');
    const routes = require('../src/api/routes');
    const app = express();
    app.use(express.json());
    app.use(routes);
    return app;
}

test('WeChatService.getDepartmentUsers calls user/simplelist with fetch_child=1', async t => {
    const axios = require('axios');
    const originalGet = axios.get;
    t.after(() => {
        axios.get = originalGet;
    });

    let call;
    axios.get = async (url, options) => {
        call = { url, options };
        return {
            data: {
                errcode: 0,
                userlist: [{ userid: 'alice', name: 'Alice' }]
            }
        };
    };

    const WeChatService = require('../src/core/wechat');
    const wechat = new WeChatService('https://qyapi.example');

    assert.equal(typeof wechat.getDepartmentUsers, 'function');
    const users = await wechat.getDepartmentUsers('token-1', 7);

    assert.deepEqual(users, [{ userid: 'alice', name: 'Alice' }]);
    assert.equal(call.url, 'https://qyapi.example/cgi-bin/user/simplelist');
    assert.deepEqual(call.options.params, {
        access_token: 'token-1',
        department_id: 7,
        fetch_child: 1
    });
});

test('WeChatService.getDepartmentUsers throws formatted error when WeChat returns nonzero errcode', async t => {
    const axios = require('axios');
    const originalGet = axios.get;
    t.after(() => {
        axios.get = originalGet;
    });

    axios.get = async () => ({
        data: {
            errcode: 60011,
            errmsg: 'no permission'
        }
    });

    const WeChatService = require('../src/core/wechat');
    const wechat = new WeChatService('https://qyapi.example');

    await assert.rejects(
        () => wechat.getDepartmentUsers('token-1'),
        error => error.message === '\u83b7\u53d6\u6210\u5458\u5217\u8868\u5931\u8d25: no permission (\u9519\u8bef\u7801: 60011)'
    );
});

test('WeChatService.getAgentInfo calls agent/get with AgentID', async t => {
    const axios = require('axios');
    const originalGet = axios.get;
    t.after(() => {
        axios.get = originalGet;
    });

    let call;
    axios.get = async (url, options) => {
        call = { url, options };
        return {
            data: {
                errcode: 0,
                agentid: 100001,
                name: '告警应用'
            }
        };
    };

    const WeChatService = require('../src/core/wechat');
    const wechat = new WeChatService('https://qyapi.example');

    assert.equal(typeof wechat.getAgentInfo, 'function');
    const result = await wechat.getAgentInfo('token-1', 100001);

    assert.deepEqual(result, {
        errcode: 0,
        agentid: 100001,
        name: '告警应用'
    });
    assert.equal(call.url, 'https://qyapi.example/cgi-bin/agent/get');
    assert.deepEqual(call.options.params, {
        access_token: 'token-1',
        agentid: 100001
    });
});

test('WeChatService.getAgentVisibleUsers includes explicit app visible users when departments are empty', async t => {
    const WeChatService = require('../src/core/wechat');
    const wechat = new WeChatService('https://qyapi.example');

    replaceForTest(t, wechat, 'getDepartmentUsers', async function getDepartmentUsers() {
        throw new Error('department users should not be fetched without visible departments');
    });

    assert.equal(typeof wechat.getAgentVisibleUsers, 'function');
    const users = await wechat.getAgentVisibleUsers('token-1', {
        allow_userinfos: {
            user: [{ userid: 'alice' }, { userid: 'bob' }, { userid: 'alice' }]
        },
        allow_partys: { partyid: [] },
        allow_tags: { tagid: [] }
    });

    assert.deepEqual(users, [
        { userid: 'alice', name: 'alice' },
        { userid: 'bob', name: 'bob' }
    ]);
});

test('WeChatService.getAgentVisibleUsers merges app visible users, departments, and tags', async t => {
    const WeChatService = require('../src/core/wechat');
    const wechat = new WeChatService('https://qyapi.example');

    const calls = { departments: [], tags: [] };
    replaceForTest(t, wechat, 'getDepartmentUsers', async function getDepartmentUsers(accessToken, departmentId) {
        calls.departments.push({ accessToken, departmentId });
        return [
            { userid: 'dept-user', name: 'Dept User' },
            { userid: 'alice', name: 'Alice From Dept' }
        ];
    });
    replaceForTest(t, wechat, 'getTagUsers', async function getTagUsers(accessToken, tagId) {
        calls.tags.push({ accessToken, tagId });
        return [
            { userid: 'tag-user', name: 'Tag User' },
            { userid: 'dept-user', name: 'Dept User Duplicate' }
        ];
    });

    const users = await wechat.getAgentVisibleUsers('token-1', {
        allow_userinfos: { user: [{ userid: 'alice' }] },
        allow_partys: { partyid: [7] },
        allow_tags: { tagid: [9] }
    });

    assert.deepEqual(calls.departments, [{ accessToken: 'token-1', departmentId: 7 }]);
    assert.deepEqual(calls.tags, [{ accessToken: 'token-1', tagId: 9 }]);
    assert.deepEqual(users, [
        { userid: 'alice', name: 'alice' },
        { userid: 'dept-user', name: 'Dept User' },
        { userid: 'tag-user', name: 'Tag User' }
    ]);
});

test('notifier.getConfigMembers returns sanitized users, current, and orphan ids', async t => {
    const { notifier, calls } = patchNotifierDependencies(t, { config: completedConfig() });

    assert.equal(typeof notifier.getConfigMembers, 'function');
    const result = await notifier.getConfigMembers('code-1');

    assert.deepEqual(calls.agentInfo, { accessToken: 'access-token', agentid: 100001 });
    assert.deepEqual(calls.visibleUsers, {
        accessToken: 'access-token',
        agentInfo: { agentid: 100001, name: '告警应用' }
    });
    assert.deepEqual(result, {
        users: [
            { userid: 'alice', name: 'Alice', displayName: 'Alice' },
            { userid: 'bob', name: 'bob', displayName: 'bob' }
        ],
        current: ['alice', 'missing'],
        orphan: ['missing']
    });
});

test('notifier.getConfigMembers falls back to configured users when WeChat denies contact access', async t => {
    const memberError = new Error('获取成员列表失败: no privilege to access/modify contact/party/agent (错误码: 60011)');
    const { notifier } = patchNotifierDependencies(t, {
        config: completedConfig({ touser: 'alice|missing' }),
        memberError
    });

    const result = await notifier.getConfigMembers('code-1', { refresh: true });

    assert.deepEqual(result, {
        users: [
            { userid: 'alice', name: 'alice', displayName: 'alice' },
            { userid: 'missing', name: 'missing', displayName: 'missing' }
        ],
        current: ['alice', 'missing'],
        orphan: [],
        warning: '企业微信未授权读取通讯录，已仅显示当前配置中的 UserID。'
    });
});

test('notifier.getConfigMembers rejects unfinished configurations', async t => {
    const { notifier } = patchNotifierDependencies(t, {
        config: completedConfig({ encrypted_corpsecret: '', touser: 'alice' })
    });

    assert.equal(typeof notifier.getConfigMembers, 'function');
    await assert.rejects(
        () => notifier.getConfigMembers('code-1'),
        /配置尚未完成/
    );
});

test('notifier.getConfigMembers rejects empty code with 404 semantics', async t => {
    const { notifier } = patchNotifierDependencies(t, { config: completedConfig() });

    await assert.rejects(
        () => notifier.getConfigMembers(''),
        error => error.statusCode === 404 && /\u672a\u627e\u5230\u914d\u7f6e/.test(error.message)
    );
});

test('notifier.getConfigMembers rejects missing configuration with 404 semantics', async t => {
    const { notifier } = patchNotifierDependencies(t, { config: null });

    await assert.rejects(
        () => notifier.getConfigMembers('missing-code'),
        error => error.statusCode === 404 && /\u672a\u627e\u5230\u914d\u7f6e/.test(error.message)
    );
});

test('updateConfiguration normalizes touser and preserves other fields when only touser is passed', async t => {
    const { notifier, calls } = patchNotifierDependencies(t, { config: completedConfig() });

    await notifier.updateConfiguration('code-1', {
        touser: [' alice ', 'bob', '', 'alice', ' bob ']
    });

    assert.deepEqual(calls.duplicateLookup, {
        corpid: 'corp-1',
        agentid: 100001,
        touser: 'alice|bob'
    });
    assert.equal(calls.updatedConfig.corpid, 'corp-1');
    assert.equal(calls.updatedConfig.agentid, 100001);
    assert.equal(calls.updatedConfig.touser, 'alice|bob');
    assert.equal(calls.updatedConfig.description, 'old description');
    assert.equal(calls.updatedConfig.callback_token, 'old-token');
});

test('updateConfiguration rejects explicitly empty touser', async t => {
    const { notifier } = patchNotifierDependencies(t, { config: completedConfig() });

    await assert.rejects(
        () => notifier.updateConfiguration('code-1', { touser: [' ', ''] }),
        /请至少选择一个成员/
    );
});

test('updateConfiguration rejects duplicate target configuration with status 409', async t => {
    const { notifier } = patchNotifierDependencies(t, {
        config: completedConfig(),
        duplicate: { code: 'other-code' }
    });

    await assert.rejects(
        () => notifier.updateConfiguration('code-1', { touser: 'alice|bob' }),
        error => error.statusCode === 409 && /配置已存在/.test(error.message)
    );
});

test('GET /api/configuration/:code/users requires auth route and returns members', async t => {
    const { notifier } = patchNotifierDependencies(t, { config: completedConfig() });
    notifier.getConfigMembers = async code => {
        assert.equal(code, 'code-1');
        return {
            users: [{ userid: 'alice', name: 'Alice', displayName: 'Alice' }],
            current: ['alice'],
            orphan: []
        };
    };
    const app = buildApp(t);

    const res = await request(app, 'GET', '/api/configuration/code-1/users');

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        users: [{ userid: 'alice', name: 'Alice', displayName: 'Alice' }],
        current: ['alice'],
        orphan: []
    });
});

test('POST /api/validate requires AgentID and validates the selected app before listing members', async t => {
    patchNotifierDependencies(t, { config: completedConfig() });
    const WeChatService = require('../src/core/wechat');
    const calls = {};

    replaceForTest(t, WeChatService.prototype, 'getToken', async function getToken(corpid, corpsecret) {
        calls.token = { corpid, corpsecret };
        return 'access-token';
    });
    const agentInfo = { agentid: 100001, name: '告警应用' };
    replaceForTest(t, WeChatService.prototype, 'getAgentInfo', async function getAgentInfo(accessToken, agentid) {
        calls.agent = { accessToken, agentid };
        return agentInfo;
    });
    replaceForTest(t, WeChatService.prototype, 'getAgentVisibleUsers', async function getAgentVisibleUsers(accessToken, receivedAgentInfo) {
        calls.members = { accessToken, agentInfo: receivedAgentInfo };
        return [{ userid: 'alice', name: 'Alice' }];
    });

    const app = buildApp(t);
    const res = await request(app, 'POST', '/api/validate', {
        corpid: 'corp-1',
        corpsecret: 'secret-1',
        agentid: 100001
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.token, { corpid: 'corp-1', corpsecret: 'secret-1' });
    assert.deepEqual(calls.agent, { accessToken: 'access-token', agentid: 100001 });
    assert.deepEqual(calls.members, { accessToken: 'access-token', agentInfo });
    assert.deepEqual(JSON.parse(res.body), {
        agentid: 100001,
        users: [{ userid: 'alice', name: 'Alice' }]
    });
});

test('POST /api/validate rejects missing AgentID before calling WeChat', async t => {
    patchNotifierDependencies(t, { config: completedConfig() });
    const WeChatService = require('../src/core/wechat');
    let called = false;
    replaceForTest(t, WeChatService.prototype, 'getToken', async function getToken() {
        called = true;
        return 'access-token';
    });

    const app = buildApp(t);
    const res = await request(app, 'POST', '/api/validate', {
        corpid: 'corp-1',
        corpsecret: 'secret-1'
    });

    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /AgentID/);
    assert.equal(called, false);
});

test('GET /api/configuration/:code/users returns 401 when unauthenticated', async t => {
    patchNotifierDependencies(t, { config: completedConfig() });
    const app = buildApp(t, { authenticated: false });

    const res = await request(app, 'GET', '/api/configuration/code-1/users');

    assert.equal(res.statusCode, 401);
});

test('GET /api/configuration/:code/users maps missing code to 404', async t => {
    const { notifier } = patchNotifierDependencies(t, { config: completedConfig() });
    notifier.getConfigMembers = async () => {
        const error = new Error('\u65e0\u6548\u7684code\uff0c\u672a\u627e\u5230\u914d\u7f6e');
        error.statusCode = 404;
        throw error;
    };
    const app = buildApp(t);

    const res = await request(app, 'GET', '/api/configuration/missing/users');

    assert.equal(res.statusCode, 404);
});

test('GET /api/configuration/:code/users maps unfinished configuration to 400', async t => {
    const { notifier } = patchNotifierDependencies(t, { config: completedConfig() });
    notifier.getConfigMembers = async () => {
        const error = new Error('\u914d\u7f6e\u5c1a\u672a\u5b8c\u6210\uff0c\u8bf7\u5148\u5b8c\u6210\u7b2c\u4e8c\u6b65\u914d\u7f6e');
        error.statusCode = 400;
        throw error;
    };
    const app = buildApp(t);

    const res = await request(app, 'GET', '/api/configuration/code-1/users');

    assert.equal(res.statusCode, 400);
});

test('GET /api/configuration/:code/users maps WeChat permission failures to 400', async t => {
    const { notifier } = patchNotifierDependencies(t, { config: completedConfig() });
    notifier.getConfigMembers = async () => {
        throw new Error('\u83b7\u53d6\u6210\u5458\u5217\u8868\u5931\u8d25: no permission (\u9519\u8bef\u7801: 60011)');
    };
    const app = buildApp(t);

    const res = await request(app, 'GET', '/api/configuration/code-1/users');

    assert.equal(res.statusCode, 400);
});

test('GET /api/configuration/:code/users maps unknown failures to 500', async t => {
    const { notifier } = patchNotifierDependencies(t, { config: completedConfig() });
    notifier.getConfigMembers = async () => {
        throw new Error('database exploded');
    };
    const app = buildApp(t);

    const res = await request(app, 'GET', '/api/configuration/code-1/users');

    assert.equal(res.statusCode, 500);
});

test('PUT /api/configuration/:code maps known errors to 404, 400, and 409', async t => {
    const { notifier } = patchNotifierDependencies(t, { config: completedConfig() });
    const app = buildApp(t);

    notifier.updateConfiguration = async () => {
        throw new Error('无效的code，未找到配置');
    };
    let res = await request(app, 'PUT', '/api/configuration/missing', { touser: ['alice'] });
    assert.equal(res.statusCode, 404);

    notifier.updateConfiguration = async () => {
        throw new Error('请至少选择一个成员');
    };
    res = await request(app, 'PUT', '/api/configuration/code-1', { touser: [] });
    assert.equal(res.statusCode, 400);

    notifier.updateConfiguration = async () => {
        const error = new Error('相同企业、应用和接收人员的配置已存在');
        error.statusCode = 409;
        throw error;
    };
    res = await request(app, 'PUT', '/api/configuration/code-1', { touser: ['alice'] });
    assert.equal(res.statusCode, 409);
});
