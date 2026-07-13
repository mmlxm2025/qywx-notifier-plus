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

function withEnv(t, key, value) {
    const hadValue = Object.prototype.hasOwnProperty.call(process.env, key);
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => {
        if (hadValue) {
            process.env[key] = original;
        } else {
            delete process.env[key];
        }
    });
}

function completedConfig(overrides = {}) {
    return {
        code: 'base-code',
        corpid: 'corp-1',
        encrypted_corpsecret: 'encrypted-secret',
        agentid: 100001,
        touser: 'default-user',
        description: 'base config',
        callback_token: null,
        encrypted_encoding_aes_key: null,
        callback_enabled: 0,
        ...overrides
    };
}

function incompleteConfig(overrides = {}) {
    return completedConfig({
        code: 'callback-only',
        encrypted_corpsecret: '',
        agentid: 0,
        touser: '',
        description: '',
        callback_enabled: 1,
        ...overrides
    });
}

function ruleRow(overrides = {}) {
    return {
        id: 7,
        config_code: 'base-code',
        api_code: 'rule-code',
        name: 'Ops',
        touser: 'alice|bob',
        toparty: '2',
        totag: '9',
        is_all: 0,
        estimated_count: 2,
        created_at: '2026-06-25 00:00:00',
        updated_at: '2026-06-25 00:00:00',
        ...overrides
    };
}

function patchNotifierDependencies(t, {
    config = completedConfig(),
    configList = [completedConfig()],
    rule = null,
    ruleById = null,
    saveRuleId = 11,
    sendResponse = { errcode: 0, errmsg: 'ok', msgid: 'msg-1' }
} = {}) {
    // SEC-001/SEC-005：注入合法 32 字节加密密钥，供 GCM 加解密单例使用。
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');

    const calls = {
        savedRule: null,
        updatedRule: null,
        regeneratedRule: null,
        deletedRuleId: null,
        listConfigurations: false,
        listConfigCode: null,
        sentRecipients: [],
        sentMessages: []
    };

    replaceForTest(t, Database.prototype, 'init', async function init() {});
    replaceForTest(t, Database.prototype, 'listConfigurations', async function listConfigurations() {
        calls.listConfigurations = true;
        return configList.map(item => ({ ...item }));
    });
    replaceForTest(t, Database.prototype, 'getConfigurationByCode', async function getConfigurationByCode(code) {
        if (!config || code !== config.code) return null;
        return { ...config };
    });
    replaceForTest(t, Database.prototype, 'getNotificationRuleByApiCode', async function getNotificationRuleByApiCode(apiCode) {
        if (!rule || apiCode !== rule.api_code) return null;
        return { ...rule };
    });
    replaceForTest(t, Database.prototype, 'getNotificationRuleById', async function getNotificationRuleById(id) {
        const source = ruleById || rule;
        if (!source || Number(id) !== Number(source.id)) return null;
        return { ...source };
    });
    replaceForTest(t, Database.prototype, 'listNotificationRules', async function listNotificationRules(configCode) {
        calls.listConfigCode = configCode;
        return rule ? [{ ...rule }] : [];
    });
    // 多应用（2026-07-04）：列表序列化批量规则计数与重复身份标记所需桩。
    replaceForTest(t, Database.prototype, 'countRulesByConfigCodes', async function countRulesByConfigCodes(codes) {
        const map = {};
        for (const code of codes) map[code] = { rule_count: 0, enabled_rule_count: 0 };
        return map;
    });
    replaceForTest(t, Database.prototype, 'findCompletedByCorpidAgentId', async function findCompletedByCorpidAgentId() { return null; });
    replaceForTest(t, Database.prototype, 'findDuplicatesByCorpidAgentId', async function findDuplicatesByCorpidAgentId() { return []; });
    // 多应用（P0-03）：规则聚合事务桩。identity={configCode}|{ruleId}；mutation(tx, app) 执行规则写。
    // 桩内复用 saveNotificationRule/updateNotificationRule/regenerate/delete 的存档逻辑以兼容旧断言。
    replaceForTest(t, Database.prototype, 'mutateRuleWithAppVersion', async function mutateRuleWithAppVersion(identity, expectedVersion, mutation) {
        const app = { ...config };
        return { rule: await mutation({
            run: async (sql, params) => {
                const s = String(sql || '').toUpperCase();
                if (s.includes('INSERT')) {
                    calls.savedRule = {
                        config_code: identity.configCode,
                        api_code: params[1],
                        name: params[2],
                        touser: params[3],
                        toparty: params[4],
                        totag: params[5],
                        is_all: params[6],
                        estimated_count: params[7]
                    };
                    return { lastID: saveRuleId, changes: 1 };
                }
                if (s.includes('UPDATE') && s.includes('API_CODE')) {
                    calls.regeneratedRule = { id: params[1], apiCode: params[0] };
                    return { changes: 1 };
                }
                if (s.includes('UPDATE') && s.includes('ENABLED')) {
                    return { changes: 1 };
                }
                if (s.includes('UPDATE')) {
                    calls.updatedRule = {
                        id: params[6],
                        name: params[0],
                        touser: params[1],
                        toparty: params[2],
                        totag: params[3],
                        is_all: params[4],
                        estimated_count: params[5]
                    };
                    return { changes: 1 };
                }
                if (s.includes('DELETE')) {
                    calls.deletedRuleId = identity.ruleId;
                    return { changes: 1 };
                }
                return { changes: 0 };
            },
            get: async (sql, params) => {
                const source = ruleById || rule;
                if (source && Number(params[0]) === Number(source.id)) return { ...source };
                return null;
            },
            all: async () => []
        }, app), app_version: (Number(config.version) || 1) + 1 };
    });
    replaceForTest(t, Database.prototype, 'saveNotificationRule', async function saveNotificationRule(saved) {
        calls.savedRule = { ...saved };
        return { id: saveRuleId, api_code: saved.api_code };
    });
    replaceForTest(t, Database.prototype, 'updateNotificationRule', async function updateNotificationRule(updated) {
        calls.updatedRule = { ...updated };
        return { id: updated.id };
    });
    replaceForTest(t, Database.prototype, 'regenerateNotificationRuleApiCode', async function regenerateNotificationRuleApiCode(id, apiCode) {
        calls.regeneratedRule = { id, apiCode };
        return { id, api_code: apiCode };
    });
    replaceForTest(t, Database.prototype, 'deleteNotificationRule', async function deleteNotificationRule(id) {
        calls.deletedRuleId = id;
        return { id };
    });

    replaceForTest(t, CryptoService.prototype, 'decrypt', function decrypt(value) {
        assert.equal(value, 'encrypted-secret');
        return 'plain-secret';
    });

    replaceForTest(t, WeChatService.prototype, 'getToken', async function getToken(corpid, corpsecret) {
        assert.equal(corpid, 'corp-1');
        assert.equal(corpsecret, 'plain-secret');
        return 'access-token';
    });
    replaceForTest(t, WeChatService.prototype, 'sendTextMessage', async function sendTextMessage(accessToken, agentid, recipient, content, safe) {
        assert.equal(accessToken, 'access-token');
        assert.equal(agentid, 100001);
        calls.sentRecipients.push(recipient);
        calls.sentMessages.push({ content, safe });
        return { ...sendResponse };
    });

    clearModule('../src/services/notifier');
    t.after(() => {
        clearModule('../src/services/notifier');
        clearModule('../src/api/routes');
    });

    return {
        notifier: require('../src/services/notifier'),
        calls
    };
}

async function request(app, method, path, body, extraHeaders = {}) {
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
                    } : {}),
                    ...extraHeaders
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

test('WeChatService formats rule recipient fields with official scope keys', () => {
    const WeChatService = require('../src/core/wechat');
    const wechat = new WeChatService();

    assert.deepEqual(wechat.buildRecipientFields({ is_all: true, touser: 'alice', toparty: '2' }), {
        touser: '@all'
    });
    assert.deepEqual(wechat.buildRecipientFields({
        touser: ['alice', 'bob', 'alice'],
        toparty: '2, 3',
        totag: ['9', '10']
    }), {
        touser: 'alice|bob',
        toparty: '2|3',
        totag: '9|10'
    });
});

test('createRule normalizes recipient fields and creates an independent API code', async t => {
    const { notifier, calls } = patchNotifierDependencies(t, { config: completedConfig() });

    assert.equal(typeof notifier.createRule, 'function');
    const result = await notifier.createRule('base-code', {
        name: ' Ops ',
        touser: ' alice, bob\nalice ',
        toparty: '2| 3',
        totag: '',
        estimated_count: '2'
    }, { expectedVersion: 1 });

    assert.equal(calls.savedRule.config_code, 'base-code');
    assert.equal(calls.savedRule.name, 'Ops');
    assert.equal(calls.savedRule.touser, 'alice|bob');
    assert.equal(calls.savedRule.toparty, '2|3');
    assert.equal(calls.savedRule.totag, '');
    assert.equal(calls.savedRule.is_all, 0);
    assert.equal(calls.savedRule.estimated_count, 2);
    assert.match(calls.savedRule.api_code, /^[0-9a-f-]{36}$/);
    assert.equal(result.id, 11);
    assert.equal(result.apiUrl, `/api/notify/${calls.savedRule.api_code}`);
});

test('listConfigurations returns unified lifecycle/warnings/capabilities per row', async t => {
    const { notifier, calls } = patchNotifierDependencies(t, {
        configList: [
            completedConfig({ code: 'base-code', description: '基础告警', version: 1, app_enabled: 1 }),
            incompleteConfig({ code: 'callback-only', description: '回调待完善', version: 1, app_enabled: 1 })
        ]
    });

    assert.equal(typeof notifier.listConfigurations, 'function');
    const result = await notifier.listConfigurations();

    assert.equal(calls.listConfigurations, true);
    const byCode = Object.fromEntries(result.configurations.map(c => [c.code, c]));

    // 多应用：每行统一输出 lifecycle/capabilities/warnings/version（前端不再自行推导）。
    assert.equal(byCode['base-code'].lifecycle_status, 'active');
    assert.equal(byCode['base-code'].completed, true);
    assert.equal(byCode['base-code'].version, 1);
    assert.equal(byCode['base-code'].app_enabled, true);
    assert.ok(Array.isArray(byCode['base-code'].warnings));
    assert.ok(typeof byCode['base-code'].capabilities === 'object');

    assert.equal(byCode['callback-only'].lifecycle_status, 'draft');
    assert.equal(byCode['callback-only'].completed, false);
    // 草稿不能管理规则/切换。
    assert.equal(byCode['callback-only'].capabilities.can_manage_rules, false);
    assert.equal(byCode['callback-only'].capabilities.can_toggle, false);
});

test('createRule stores all-member rules as touser @all semantics', async t => {
    const { notifier, calls } = patchNotifierDependencies(t, { config: completedConfig() });

    await notifier.createRule('base-code', {
        name: 'all',
        is_all: true,
        touser: ['alice'],
        toparty: ['2'],
        totag: ['9']
    }, { expectedVersion: 1 });

    assert.equal(calls.savedRule.is_all, 1);
    assert.equal(calls.savedRule.touser, '');
    assert.equal(calls.savedRule.toparty, '');
    assert.equal(calls.savedRule.totag, '');
    assert.equal(calls.savedRule.estimated_count, 1);
});

test('updateRule keeps existing all-member scope when is_all is omitted', async t => {
    const { notifier, calls } = patchNotifierDependencies(t, {
        config: completedConfig(),
        rule: ruleRow({
            is_all: 1,
            touser: '',
            toparty: '',
            totag: '',
            estimated_count: 3
        })
    });

    await notifier.updateRule(7, { name: 'Renamed' }, { expectedVersion: 1 });

    assert.equal(calls.updatedRule.name, 'Renamed');
    assert.equal(calls.updatedRule.is_all, 1);
    assert.equal(calls.updatedRule.touser, '');
    assert.equal(calls.updatedRule.toparty, '');
    assert.equal(calls.updatedRule.totag, '');
    assert.equal(calls.updatedRule.estimated_count, 3);
});

test('sendNotification resolves rule api code and sends with rule recipient scope', async t => {
    const { notifier, calls } = patchNotifierDependencies(t, {
        config: completedConfig(),
        rule: ruleRow()
    });

    const result = await notifier.sendNotification('rule-code', 'Title', 'Body');

    assert.deepEqual(calls.sentRecipients[0], {
        is_all: false,
        touser: 'alice|bob',
        toparty: '2',
        totag: '9'
    });
    assert.deepEqual(calls.sentMessages[0], {
        content: 'Title\nBody',
        safe: 0
    });
    assert.deepEqual(result, { errcode: 0, errmsg: 'ok', msgid: 'msg-1' });
});

test('sendNotification returns cached result for duplicate payloads within the dedupe window', async t => {
    withEnv(t, 'SEND_DEDUP_TTL_MS', '60000');
    const { notifier, calls } = patchNotifierDependencies(t, {
        config: completedConfig(),
        rule: ruleRow({ touser: 'alice', toparty: '', totag: '', estimated_count: 1 })
    });

    const first = await notifier.sendNotification('rule-code', 'Title', 'Same body');
    const second = await notifier.sendNotification('rule-code', 'Title', 'Same body');

    assert.equal(calls.sentRecipients.length, 1);
    assert.equal(first.cached, undefined);
    assert.equal(second.cached, true);
    assert.equal(second.msgid, 'msg-1');
});

test('sendNotification rejects explicit member sends above the per-minute local guard', async t => {
    withEnv(t, 'SEND_DEDUP_TTL_MS', '0');
    const { notifier, calls } = patchNotifierDependencies(t, {
        config: completedConfig(),
        rule: ruleRow({ touser: 'alice', toparty: '', totag: '', estimated_count: 1 })
    });

    for (let index = 0; index < 30; index += 1) {
        await notifier.sendNotification('rule-code', 'Title', `Body ${index}`);
    }

    await assert.rejects(
        () => notifier.sendNotification('rule-code', 'Title', 'Body 31'),
        error => error.statusCode === 429 && /alice/.test(error.message)
    );
    assert.equal(calls.sentRecipients.length, 30);
});

test('rule management routes require auth and regenerate API code', async t => {
    const sourceRule = ruleRow();
    const { calls } = patchNotifierDependencies(t, {
        config: completedConfig(),
        rule: sourceRule,
        ruleById: sourceRule
    });
    const app = buildApp(t);

    let res = await request(app, 'GET', '/api/configuration/base-code/rules');
    assert.equal(res.statusCode, 200);
    assert.equal(calls.listConfigCode, 'base-code');
    assert.deepEqual(JSON.parse(res.body).rules[0].apiUrl, '/api/notify/rule-code');

    res = await request(app, 'POST', '/api/rules/7/regenerate', undefined, { 'If-Match': '1' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.match(body.api_code, /^[0-9a-f-]{36}$/);
    assert.equal(body.apiUrl, `/api/notify/${body.api_code}`);
    assert.equal(calls.regeneratedRule.id, 7);
});

test('configuration list route requires auth and returns selectable codes', async t => {
    const { calls } = patchNotifierDependencies(t, {
        configList: [completedConfig({ code: 'base-code', description: '基础告警', version: 1, app_enabled: 1 })]
    });
    const app = buildApp(t);

    const res = await request(app, 'GET', '/api/configurations');

    assert.equal(res.statusCode, 200);
    assert.equal(calls.listConfigurations, true);
    const body = JSON.parse(res.body);
    assert.equal(body.configurations.length, 1);
    // 多应用：列表返回统一 lifecycle/版本/能力字段。
    const row = body.configurations[0];
    assert.equal(row.code, 'base-code');
    assert.equal(row.description, '基础告警');
    assert.equal(row.completed, true);
    assert.equal(row.lifecycle_status, 'active');
    assert.ok(Number.isInteger(row.version));
});

test('api docs route is available from the documented top-level path', async t => {
    patchNotifierDependencies(t);
    const app = buildApp(t);

    const res = await request(app, 'GET', '/api-docs.html');

    assert.equal(res.statusCode, 200);
    assert.match(res.body, /接收规则 API/);
    assert.match(res.body, /\/api\/configurations/);
});

test('rule management routes return 401 when unauthenticated', async t => {
    patchNotifierDependencies(t, {
        config: completedConfig(),
        rule: ruleRow(),
        ruleById: ruleRow()
    });
    const app = buildApp(t, { authenticated: false });

    const res = await request(app, 'GET', '/api/configuration/base-code/rules');

    assert.equal(res.statusCode, 401);
});
