// /api/configure 兼容入口必须在线校验企业微信凭证（与 completeConfiguration 对齐）。

const assert = require('assert/strict');
const test = require('node:test');

function clearModule(modulePath) {
    delete require.cache[require.resolve(modulePath)];
}

function replaceForTest(t, object, property, value) {
    const had = Object.prototype.hasOwnProperty.call(object, property);
    const original = object[property];
    object[property] = value;
    t.after(() => {
        if (had) object[property] = original;
        else delete object[property];
    });
}

function withEnv(t, key, value) {
    const had = Object.prototype.hasOwnProperty.call(process.env, key);
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => {
        if (had) process.env[key] = original;
        else delete process.env[key];
    });
}

test('createConfiguration 凭证无效时返回 WECHAT_CREDENTIAL_INVALID 且不落库', async t => {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const Database = require('../src/core/database');
    const WeChatService = require('../src/core/wechat');
    const calls = { inserts: 0, getToken: 0 };

    replaceForTest(t, Database.prototype, 'init', async function init() {});
    replaceForTest(t, Database.prototype, 'findCompletedByCorpidAgentId', async () => null);
    replaceForTest(t, Database.prototype, 'createConfigurationAtomic', async function () {
        calls.inserts += 1;
        return { id: 1, code: 'x' };
    });
    replaceForTest(t, WeChatService.prototype, 'getToken', async () => {
        calls.getToken += 1;
        throw new Error('获取token失败: invalid credential (错误码: 40001)');
    });
    replaceForTest(t, WeChatService.prototype, 'getAgentInfo', async () => ({ agentid: 1 }));
    replaceForTest(t, WeChatService.prototype, 'getAgentVisibleUsers', async () => []);

    clearModule('../src/services/notifier');
    t.after(() => clearModule('../src/services/notifier'));
    const notifier = require('../src/services/notifier');

    let err;
    try {
        await notifier.createConfiguration({
            corpid: 'corp',
            corpsecret: 'bad',
            agentid: 100001,
            touser: 'alice'
        });
    } catch (e) { err = e; }

    assert.ok(err, '应拒绝无效凭证');
    assert.equal(err.statusCode, 400);
    assert.equal(err.businessCode, 'WECHAT_CREDENTIAL_INVALID');
    assert.equal(calls.inserts, 0, '校验失败不得落库');
    assert.ok(calls.getToken >= 1, '应尝试在线校验');
});

test('createConfiguration 凭证有效时才创建', async t => {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');
    const calls = { inserts: 0 };

    replaceForTest(t, Database.prototype, 'init', async function init() {});
    replaceForTest(t, Database.prototype, 'findCompletedByCorpidAgentId', async () => null);
    replaceForTest(t, Database.prototype, 'createConfigurationAtomic', async function (cfg) {
        calls.inserts += 1;
        return { id: 1, code: cfg.code };
    });
    replaceForTest(t, CryptoService.prototype, 'encrypt', (v) => 'enc-' + v);
    replaceForTest(t, WeChatService.prototype, 'getToken', async () => 'tok');
    replaceForTest(t, WeChatService.prototype, 'getAgentInfo', async () => ({ agentid: 100001 }));
    replaceForTest(t, WeChatService.prototype, 'getAgentVisibleUsers', async () => []);

    clearModule('../src/services/notifier');
    t.after(() => clearModule('../src/services/notifier'));
    const notifier = require('../src/services/notifier');

    const result = await notifier.createConfiguration({
        corpid: 'corp',
        corpsecret: 'good',
        agentid: 100001,
        touser: 'alice'
    });
    assert.ok(result.code);
    assert.equal(calls.inserts, 1);
});
