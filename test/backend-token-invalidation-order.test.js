// 阶段 A（先补会失败的测试）：CorpSecret 更新失败不失效旧 token（R-P1-01）。
//
// 复验指南 §5 R-P1-01：版本冲突/身份冲突/验证失败时 token 失效次数必须为 0；
// 只有数据库提交成功后才执行 invalidateToken。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-fix-verification-ai-execution-guide.md §5。

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
        code: 'app-a',
        corpid: 'corp-1',
        encrypted_corpsecret: 'enc-old-secret',
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

// setup：配置 CAS 结果 + token 失效计数。
function setupNotifier(t, { config, updateChanges = 1, updateVersion = null } = {}) {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');

    const calls = { invalidations: [], updateFieldsCalls: [] };
    const cfgStore = { [config.code]: { ...config } };

    replaceForTest(t, Database.prototype, 'init', async function () {});
    replaceForTest(t, Database.prototype, 'getConfigurationByCode', async function (code) {
        const r = cfgStore[code];
        return r ? { ...r } : null;
    });
    replaceForTest(t, Database.prototype, 'findCompletedByCorpidAgentId', async function () { return null; });
    replaceForTest(t, Database.prototype, 'countRulesByConfigCodes', async function () { return {}; });
    replaceForTest(t, Database.prototype, 'updateConfigurationFields', async function (code, fields, expectedVersion) {
        calls.updateFieldsCalls.push({ code, fields, expectedVersion });
        const row = cfgStore[code];
        if (!row) return { code, changes: 0, version: null };
        const match = Number(row.version) === Number(expectedVersion);
        const changes = match ? updateChanges : 0;
        if (changes > 0) {
            Object.assign(row, fields);
            row.version = updateVersion !== null ? updateVersion : (Number(row.version) + 1);
        }
        return { code, changes, version: Number(row.version) };
    });
    // 多应用（R-P0-01）：updateConfigurationAtomic 桩，CAS 一致。
    replaceForTest(t, Database.prototype, 'updateConfigurationAtomic', async function (code, fields, expectedVersion, opts = {}) {
        const row = cfgStore[code];
        if (!row) {
            const e = new Error('missing'); e.__updateCause = 'missing'; throw e;
        }
        const match = Number(row.version) === Number(expectedVersion);
        if (!match) {
            const e = new Error('version_conflict'); e.__updateCause = 'version_conflict';
            e.__currentVersion = Number(row.version); throw e;
        }
        Object.assign(row, fields);
        row.version = updateVersion !== null ? updateVersion : (Number(row.version) + 1);
        return { code, version: row.version };
    });

    replaceForTest(t, CryptoService.prototype, 'decrypt', function (v) { return String(v).replace(/^enc-/, ''); });
    replaceForTest(t, CryptoService.prototype, 'encrypt', function (v) { return `enc-${v}`; });
    replaceForTest(t, CryptoService.prototype, 'isLegacyCiphertext', function () { return false; });
    replaceForTest(t, WeChatService.prototype, 'getToken', async () => 't');
    replaceForTest(t, WeChatService.prototype, 'getAgentInfo', async (tok, id) => ({ agentid: id }));
    replaceForTest(t, WeChatService.prototype, 'getAgentVisibleUsers', async () => []);
    replaceForTest(t, WeChatService.prototype, 'invalidateToken', async function (corpid, secret) {
        calls.invalidations.push({ corpid, secret });
    });

    clearModule('../src/services/notifier');
    t.after(() => {
        clearModule('../src/services/notifier');
        clearModule('../src/api/routes');
    });
    const notifier = require('../src/services/notifier');
    return { notifier, calls };
}

test('R-P1-01: CorpSecret 更新版本冲突时旧 token 失效次数为 0', async t => {
    const { notifier, calls } = setupNotifier(t, {
        config: completedConfig({ version: 5 })  // 服务端版本已是 5
    });
    let caught = null;
    try {
        // 客户端用旧版本 2 → CAS 失败 → 版本冲突。
        await notifier.updateConfiguration('app-a', { corpsecret: 'new-secret' }, { expectedVersion: 2 });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.businessCode, 'APP_VERSION_CONFLICT');
    assert.equal(calls.invalidations.length, 0, '版本冲突时不得失效旧 token');
});

test('R-P1-01: CorpSecret 更新成功时才失效旧 token 一次', async t => {
    const { notifier, calls } = setupNotifier(t, {
        config: completedConfig({ version: 2 }),
        updateChanges: 1
    });
    const result = await notifier.updateConfiguration('app-a', { corpsecret: 'new-secret' }, { expectedVersion: 2 });
    assert.ok(result.version);
    assert.equal(calls.invalidations.length, 1, '成功更新后才失效旧 token 一次');
});

test('R-P1-01: 只改 AgentID（不改 CorpSecret）不失效 token', async t => {
    const { notifier, calls } = setupNotifier(t, {
        config: completedConfig({ version: 2 })
    });
    await notifier.updateConfiguration('app-a', { agentid: 200002 }, { expectedVersion: 2 });
    assert.equal(calls.invalidations.length, 0, '仅改 AgentID 不应失效 token（secret 未变）');
});
