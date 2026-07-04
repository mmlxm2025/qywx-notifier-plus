// 阶段 A（先补会失败的测试）：应用身份不变量原子事务（P0-05）。
//
// 覆盖设计 §3.4：
//   - /api/configure 不能创建重复 (corpid, agentid)（不能仅靠 touser 区分）。
//   - 并发完成请求只能一个成功（原子身份检查 + UPDATE）。
//   - 完成草稿必须在事务内重新读取身份冲突（避免 TOCTOU）。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-code-review-fix-guide.md §3.4。

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
        encrypted_corpsecret: 'enc-secret',
        agentid: 100001,
        touser: 'alice',
        description: '',
        callback_enabled: 1,
        encrypted_callback_token: 'enc',
        encrypted_encoding_aes_key: 'enc',
        notify_key_hash: null,
        legacy_until: null,
        code_send_enabled: 1,
        app_enabled: 1,
        version: 1,
        created_at: '2026-07-01 00:00:00',
        ...overrides
    };
}

function draftConfig(overrides = {}) {
    return completedConfig({
        code: 'draft-1',
        corpid: 'corp-1',
        encrypted_corpsecret: '',
        agentid: 0,
        touser: '',
        version: 1,
        ...overrides
    });
}

// 设置可配置的身份冲突响应（用于验证事务内的二次检查）。
function setupNotifier(t, { configs = {}, conflictConfig = null, completeChanges = 1, identityConflictByCorpidAgent = {} } = {}) {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');

    const cfgByCode = { ...configs };
    const calls = { identityChecks: [], completeTx: 0, saves: [] };

    replaceForTest(t, Database.prototype, 'init', async function () {});
    replaceForTest(t, Database.prototype, 'getConfigurationByCode', async function (code) {
        const r = cfgByCode[code];
        return r ? { ...r } : null;
    });
    replaceForTest(t, Database.prototype, 'findCompletedByCorpidAgentId', async function (corpid, agentid, excludeCode) {
        calls.identityChecks.push({ corpid, agentid, excludeCode });
        // createConfiguration 身份判重（excludeCode 为 null 时）。
        if (excludeCode === null || excludeCode === undefined) {
            const key = `${corpid}|${agentid}`;
            if (identityConflictByCorpidAgent[key]) {
                return cfgByCode[identityConflictByCorpidAgent[key]] || (conflictConfig ? { ...conflictConfig } : null);
            }
        }
        if (conflictConfig) return { ...conflictConfig };
        return null;
    });
    replaceForTest(t, Database.prototype, 'createConfigurationAtomic', async function (cfg) {
        // 模拟事务内身份检查。
        const existing = Object.values(cfgByCode).find(c =>
            c.corpid === cfg.corpid && c.agentid === cfg.agentid && c.encrypted_corpsecret
        );
        if (existing) {
            const e = new Error('identity conflict');
            e.__createCause = 'identity_conflict';
            e.__existingCode = existing.code;
            throw e;
        }
        cfgByCode[cfg.code] = { ...cfg, version: 1 };
        return { id: Object.keys(cfgByCode).length, code: cfg.code };
    });
    // 多应用（P0-05）：完成草稿原子事务 mock。
    replaceForTest(t, Database.prototype, 'completeConfigurationAtomic', async function (code, fields, expectedVersion, opts = {}) {
        const row = cfgByCode[code];
        if (!row) {
            const e = new Error('missing'); e.__completeCause = 'missing'; throw e;
        }
        const hasSecret = row.encrypted_corpsecret && row.encrypted_corpsecret.length > 0;
        if (hasSecret) {
            const e = new Error('already completed'); e.__completeCause = 'already_completed'; throw e;
        }
        const match = Number(row.version) === Number(expectedVersion);
        const changes = match ? completeChanges : 0;
        if (changes === 0) {
            const e = new Error('version conflict'); e.__completeCause = 'version_conflict';
            e.__currentVersion = Number(row.version); throw e;
        }
        // 身份冲突（事务内二次检查）。
        if (conflictConfig) {
            const e = new Error('identity conflict');
            e.__completeCause = 'identity_conflict';
            e.__existingCode = conflictConfig.code;
            throw e;
        }
        Object.assign(row, fields);
        row.version = Number(row.version) + 1;
        return { code, version: row.version };
    });
    replaceForTest(t, Database.prototype, 'saveCallbackConfiguration', async function (cfg) {
        cfgByCode[cfg.code] = { ...cfg, version: 1 };
        return { id: 1, code: cfg.code };
    });
    replaceForTest(t, Database.prototype, 'getIncompleteConfigurationByCorpId', async function () { return null; });
    replaceForTest(t, Database.prototype, 'countRulesByConfigCodes', async function () { return {}; });
    replaceForTest(t, Database.prototype, 'updateConfigurationFields', async function (code, fields, expectedVersion) {
        const row = cfgByCode[code];
        if (!row) return { code, changes: 0, version: null };
        const match = expectedVersion === undefined || Number(row.version) === Number(expectedVersion);
        const changes = match ? completeChanges : 0;
        if (changes > 0) {
            Object.assign(row, fields);
            row.version = Number(row.version) + 1;
        }
        return { code, changes, version: Number(row.version) };
    });

    replaceForTest(t, CryptoService.prototype, 'decrypt', function (v) { return String(v).replace(/^enc-/, ''); });
    replaceForTest(t, CryptoService.prototype, 'encrypt', function (v) { return `enc-${v}`; });
    replaceForTest(t, CryptoService.prototype, 'isLegacyCiphertext', function () { return false; });
    replaceForTest(t, WeChatService.prototype, 'getToken', async () => 't');
    replaceForTest(t, WeChatService.prototype, 'getAgentInfo', async (tok, id) => ({ agentid: id }));
    replaceForTest(t, WeChatService.prototype, 'getAgentVisibleUsers', async () => []);
    replaceForTest(t, WeChatService.prototype, 'invalidateToken', async () => {});

    clearModule('../src/services/notifier');
    t.after(() => {
        clearModule('../src/services/notifier');
        clearModule('../src/api/routes');
    });
    return { get notifier() { return require('../src/services/notifier'); }, calls, cfgByCode };
}

// ─── P0-05: createConfiguration 按 (corpid, agentid) 判重 ───────────────

test('P0-05: createConfiguration 同 (corpid, agentid) 不同 touser 视为冲突', async t => {
    const existing = completedConfig({ code: 'existing', touser: 'alice' });
    const { notifier, calls } = setupNotifier(t, {
        configs: { existing },
        identityConflictByCorpidAgent: { 'corp-1|100001': 'existing' }
    });
    let caught = null;
    try {
        await notifier.createConfiguration({
            corpid: 'corp-1', corpsecret: 'sec', agentid: 100001,
            touser: 'bob'  // 不同 touser，同 (corpid, agentid)
        });
    } catch (err) { caught = err; }
    assert.ok(caught, '同 (corpid, agentid) 不同 touser 应判为冲突');
    assert.equal(caught.businessCode, 'APP_IDENTITY_CONFLICT');
    assert.ok(caught.details && caught.details.existing_code, '应返回 existing_code');
});

test('P0-05: createConfiguration 不同 agentid 允许创建', async t => {
    const { notifier } = setupNotifier(t, { configs: {} });
    const result = await notifier.createConfiguration({
        corpid: 'corp-1', corpsecret: 'sec', agentid: 200002, touser: 'alice'
    });
    assert.ok(result.code);
});

// ─── P0-05: completeConfiguration 在事务内二次校验身份冲突 ──────────────

test('P0-05: completeConfiguration 命中身份冲突返回 APP_IDENTITY_CONFLICT', async t => {
    const { notifier } = setupNotifier(t, {
        configs: { 'draft-1': draftConfig({ version: 1 }) },
        conflictConfig: completedConfig({ code: 'other-app' })
    });
    let caught = null;
    try {
        await notifier.completeConfiguration({
            code: 'draft-1', corpsecret: 'sec', agentid: 100001, touser: 'alice', version: 1
        });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.businessCode, 'APP_IDENTITY_CONFLICT');
    assert.ok(caught.details && caught.details.existing_code === 'other-app');
});

// ─── P0-05: 并发完成只能一个成功 ────────────────────────────────────────
//
// 通过让两个完成请求竞争同一草稿，模拟事务原子性：
// 第一个 completeConfigurationAtomic 成功（CAS 命中 version=1），第二个因 version 已变（CAS 不命中）→ 409。

test('P0-05: 两个并发完成请求只能一个成功（CAS）', async t => {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');

    const cfg = draftConfig({ version: 1 });
    let version = 1;

    replaceForTest(t, Database.prototype, 'init', async function () {});
    replaceForTest(t, Database.prototype, 'getConfigurationByCode', async () => ({ ...cfg, version }));
    replaceForTest(t, Database.prototype, 'findCompletedByCorpidAgentId', async () => null);
    replaceForTest(t, Database.prototype, 'countRulesByConfigCodes', async () => ({}));
    // 原子事务：CAS 检查 version，只有第一个请求命中。
    replaceForTest(t, Database.prototype, 'completeConfigurationAtomic', async function (code, fields, expectedVersion, opts = {}) {
        if (Number(expectedVersion) !== Number(version)) {
            const e = new Error('version conflict');
            e.__completeCause = 'version_conflict';
            e.__currentVersion = version;
            throw e;
        }
        version += 1;
        return { code, version };
    });
    replaceForTest(t, CryptoService.prototype, 'decrypt', function (v) { return String(v).replace(/^enc-/, ''); });
    replaceForTest(t, CryptoService.prototype, 'encrypt', function (v) { return `enc-${v}`; });
    replaceForTest(t, CryptoService.prototype, 'isLegacyCiphertext', function () { return false; });
    replaceForTest(t, WeChatService.prototype, 'getToken', async () => 't');
    replaceForTest(t, WeChatService.prototype, 'getAgentInfo', async (tok, id) => ({ agentid: id }));
    replaceForTest(t, WeChatService.prototype, 'getAgentVisibleUsers', async () => []);

    clearModule('../src/services/notifier');
    t.after(() => {
        clearModule('../src/services/notifier');
        clearModule('../src/api/routes');
    });
    const notifier = require('../src/services/notifier');

    // 并发发起两个完成请求，都用 version=1。
    const results = await Promise.allSettled([
        notifier.completeConfiguration({ code: 'draft-1', corpsecret: 's', agentid: 100001, touser: 'alice', version: 1 }),
        notifier.completeConfiguration({ code: 'draft-1', corpsecret: 's', agentid: 100001, touser: 'alice', version: 1 })
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, '只能一个成功，实际: ' + JSON.stringify(results.map(r => r.status)));
    assert.equal(rejected.length, 1, '另一个必须失败');
    const rej = rejected[0].reason;
    assert.ok(rej.businessCode === 'APP_VERSION_CONFLICT' || rej.businessCode === 'APP_ALREADY_COMPLETED',
        '失败原因应是版本冲突或已完成，实际: ' + rej.businessCode);
});
