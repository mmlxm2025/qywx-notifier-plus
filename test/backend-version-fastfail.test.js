// 多应用（第三轮复验 P1-04）：未来版本号仍会先调用企业微信。
//
// completeConfiguration/updateConfiguration 的事务外快速失败用 expectedVersion < currentVersion，
// 但乐观锁要求任何不相等都冲突。当前版本=3、请求版本=999 时，两条路径都先调用一次企业微信，
// 最后才由 CAS 返回 409。
//
// 应改为 expectedVersion !== currentVersion。分别测试低于和高于当前版本，
// 断言 getToken/getAgentInfo 调用次数均为 0；等于当前版本才允许验证。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-third-fix-review-ai-execution-guide.md §4 P1-04。

const assert = require('assert/strict');
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

function completedConfig(overrides = {}) {
    return {
        code: 'app-ver', corpid: 'corp-ver', encrypted_corpsecret: 'enc-secret',
        agentid: 100001, touser: 'alice', description: '', callback_enabled: 0,
        notify_key_hash: null, code_send_enabled: 1, app_enabled: 1, version: 3,
        ...overrides
    };
}

function setupNotifier(t, { config }) {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');

    const calls = { tokens: [], agentInfo: [] };
    const cfgStore = { [config.code]: { ...config } };

    replaceForTest(t, Database.prototype, 'init', async function () {});
    replaceForTest(t, Database.prototype, 'getConfigurationByCode', async function (code) {
        const r = cfgStore[code];
        return r ? { ...r } : null;
    });
    replaceForTest(t, Database.prototype, 'findCompletedByCorpidAgentId', async function () { return null; });
    replaceForTest(t, Database.prototype, 'findDuplicatesByCorpidAgentId', async function () { return []; });
    replaceForTest(t, Database.prototype, 'countRulesByConfigCodes', async function () { return {}; });
    // updateConfigurationAtomic：CAS 失败抛 version_conflict。
    replaceForTest(t, Database.prototype, 'updateConfigurationAtomic', async function (code, fields, expectedVersion) {
        if (Number(expectedVersion) !== Number(config.version)) {
            const e = new Error('version_conflict');
            e.__updateCause = 'version_conflict';
            e.__currentVersion = Number(config.version);
            throw e;
        }
        return { code, version: Number(config.version) + 1 };
    });

    replaceForTest(t, CryptoService.prototype, 'decrypt', function (v) { return String(v).replace(/^enc-/, ''); });
    replaceForTest(t, CryptoService.prototype, 'encrypt', function (v) { return `enc-${v}`; });
    replaceForTest(t, CryptoService.prototype, 'isLegacyCiphertext', function () { return false; });

    replaceForTest(t, WeChatService.prototype, 'getToken', async function (corpid, secret) {
        calls.tokens.push({ corpid, secret });
        return 'access-token';
    });
    replaceForTest(t, WeChatService.prototype, 'getAgentInfo', async function (tok, agentid) {
        calls.agentInfo.push({ tok, agentid });
        return { agentid };
    });
    replaceForTest(t, WeChatService.prototype, 'getAgentVisibleUsers', async () => []);
    replaceForTest(t, WeChatService.prototype, 'invalidateToken', async () => {});

    clearModule('../src/services/notifier');
    t.after(() => {
        clearModule('../src/services/notifier');
        clearModule('../src/api/routes');
    });
    const notifier = require('../src/services/notifier');
    return { notifier, calls };
}

// ─── updateConfiguration：未来版本（高于当前）不应调用企业微信 ──────────────

test('P1-04: updateConfiguration 未来版本(999 > 当前 3) 不调用企业微信', async t => {
    const { notifier, calls } = setupNotifier(t, { config: completedConfig({ version: 3 }) });
    let caught = null;
    try {
        await notifier.updateConfiguration('app-ver', { corpsecret: 'new-secret' }, { expectedVersion: 999 });
    } catch (err) { caught = err; }
    assert.ok(caught, '应抛错');
    assert.equal(caught.businessCode, 'APP_VERSION_CONFLICT');
    assert.equal(calls.tokens.length, 0, '未来版本不应调用 getToken（当前会调用）');
    assert.equal(calls.agentInfo.length, 0, '未来版本不应调用 getAgentInfo');
});

test('P1-04: updateConfiguration 旧版本(1 < 当前 3) 不调用企业微信', async t => {
    const { notifier, calls } = setupNotifier(t, { config: completedConfig({ version: 3 }) });
    let caught = null;
    try {
        await notifier.updateConfiguration('app-ver', { corpsecret: 'new-secret' }, { expectedVersion: 1 });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.businessCode, 'APP_VERSION_CONFLICT');
    assert.equal(calls.tokens.length, 0, '旧版本不应调用 getToken');
});

test('P1-04: updateConfiguration 等于当前版本(3) 才允许调用企业微信', async t => {
    const { notifier, calls } = setupNotifier(t, { config: completedConfig({ version: 3 }) });
    // 等于当前版本：允许进入验证（凭证变化才调用企业微信）。
    await notifier.updateConfiguration('app-ver', { corpsecret: 'new-secret' }, { expectedVersion: 3 });
    assert.equal(calls.tokens.length, 1, '等于当前版本应调用 getToken 验证凭证');
    assert.equal(calls.agentInfo.length, 1, '等于当前版本应调用 getAgentInfo');
});

// ─── completeConfiguration：未来版本不应调用企业微信 ────────────────────────
// completeConfiguration 需要 corpid 与草稿状态；构造草稿 config。

test('P1-04: completeConfiguration 未来版本(999 > 当前 3) 不调用企业微信', async t => {
    // 草稿配置：无 secret、agentid=0、touser 空。
    const draftConfig = completedConfig({
        version: 3, encrypted_corpsecret: '', agentid: 0, touser: ''
    });
    const { notifier, calls } = setupNotifier(t, { config: draftConfig });
    let caught = null;
    try {
        await notifier.completeConfiguration({
            code: 'app-ver', corpsecret: 'secret', agentid: 100002,
            touser: ['alice'], version: 999
        });
    } catch (err) { caught = err; }
    assert.ok(caught, '应抛错');
    assert.equal(caught.businessCode, 'APP_VERSION_CONFLICT');
    assert.equal(calls.tokens.length, 0, '未来版本不应调用 getToken');
    assert.equal(calls.agentInfo.length, 0, '未来版本不应调用 getAgentInfo');
});
