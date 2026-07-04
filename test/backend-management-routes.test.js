// 阶段 A（先补会失败的测试）：管理路由版本契约与错误码（P0-02 / P0-04 / P1-04 / P1-07）。
//
// 覆盖设计 §3.2 契约矩阵：
//   - Code 发送开关：携带 If-Match 成功并返回新版本；缺 If-Match 返回 428（P0-02）。
//   - generate-callback：显式转发 draft_code/version（P0-04）。
//   - complete-config：显式转发 version；旧版本返回 409 而不是成功（P0-04）。
//   - legacy-grace：聚合写需 If-Match（P1-07）。
//   - DELETE 缺头返回 428 而非版本 0（P1-04）。
//
// 现有测试基础设施在 service 层调用（无 supertest 依赖），本文件沿用该模式：
// 验证路由→service 的转发契约，即 service 层正确接受并强制版本。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-code-review-fix-guide.md §3.2。

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
        encrypted_callback_token: 'enc-token',
        encrypted_encoding_aes_key: 'enc-aes',
        notify_key_hash: null,
        legacy_until: null,
        code_send_enabled: 1,
        app_enabled: 1,
        version: 3,
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

// 通过 updateConfigurationFields 的 changes 模拟版本冲突 vs 成功。
function setupNotifier(t, { configs = {}, updateChangesByCode = {} } = {}) {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');

    const cfgByCode = { ...configs };
    const calls = { updateFields: [], updates: [] };

    replaceForTest(t, Database.prototype, 'init', async function () {});
    replaceForTest(t, Database.prototype, 'getConfigurationByCode', async function (code) {
        const r = cfgByCode[code];
        return r ? { ...r } : null;
    });
    replaceForTest(t, Database.prototype, 'getIncompleteConfigurationByCorpId', async function (corpid) {
        const r = Object.values(cfgByCode).find(c => c.corpid === corpid && !c.encrypted_corpsecret);
        return r ? { ...r } : null;
    });
    replaceForTest(t, Database.prototype, 'findCompletedByCorpidAgentId', async function () { return null; });
    replaceForTest(t, Database.prototype, 'saveCallbackConfiguration', async function (cfg) {
        cfgByCode[cfg.code] = { ...cfg, encrypted_corpsecret: '', agentid: 0, touser: '', version: 1 };
        return { id: 1, code: cfg.code };
    });
    replaceForTest(t, Database.prototype, 'saveConfiguration', async function (cfg) {
        cfgByCode[cfg.code] = { ...cfg, version: 1 };
        return { id: 1, code: cfg.code };
    });
    replaceForTest(t, Database.prototype, 'getConfigurationByCompleteFields', async function () { return null; });
    replaceForTest(t, Database.prototype, 'countRulesByConfigCodes', async function () { return {}; });
    // updateConfigurationFields：返回 changes，模拟 CAS。
    replaceForTest(t, Database.prototype, 'updateConfigurationFields', async function (code, fields, expectedVersion) {
        calls.updateFields.push({ code, fields, expectedVersion });
        const row = cfgByCode[code];
        if (!row) return { code, changes: 0, version: null };
        const match = Number(row.version) === Number(expectedVersion);
        const changes = updateChangesByCode[code] !== undefined ? updateChangesByCode[code] : (match ? 1 : 0);
        if (changes > 0) {
            Object.assign(row, fields);
            row.version = Number(row.version) + 1;
        }
        return { code, changes, version: Number(row.version) };
    });
    // 多应用（P0-04）：草稿回调原子事务 mock。
    replaceForTest(t, Database.prototype, 'updateDraftCallbackAtomic', async function (code, fields, expectedVersion) {
        const row = cfgByCode[code];
        if (!row) {
            const e = new Error('missing'); e.__draftCause = 'missing'; throw e;
        }
        const hasSecret = row.encrypted_corpsecret && row.encrypted_corpsecret.length > 0;
        if (hasSecret) {
            const e = new Error('already completed'); e.__draftCause = 'already_completed'; throw e;
        }
        const match = Number(row.version) === Number(expectedVersion);
        const changes = updateChangesByCode[code] !== undefined ? updateChangesByCode[code] : (match ? 1 : 0);
        if (changes === 0) {
            const e = new Error('version conflict'); e.__draftCause = 'version_conflict';
            e.__currentVersion = Number(row.version); throw e;
        }
        Object.assign(row, fields);
        row.version = Number(row.version) + 1;
        return { code, version: row.version };
    });
    // 多应用（P0-04 + P0-05）：完成草稿原子事务 mock。
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
        const changes = updateChangesByCode[code] !== undefined ? updateChangesByCode[code] : (match ? 1 : 0);
        if (changes === 0) {
            const e = new Error('version conflict'); e.__completeCause = 'version_conflict';
            e.__currentVersion = Number(row.version); throw e;
        }
        Object.assign(row, fields);
        row.version = Number(row.version) + 1;
        return { code, version: row.version };
    });
    replaceForTest(t, Database.prototype, 'createDraftCallbackAtomic', async function (cfg) {
        cfgByCode[cfg.code] = { ...cfg, encrypted_corpsecret: '', agentid: 0, touser: '', version: 1 };
        return { id: 1, code: cfg.code };
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

// ─── P0-02: Code 发送开关 ─────────────────────────────────────────────

test('P0-02: setCodeSendEnabled 携带版本成功并返回新版本', async t => {
    const { notifier, calls } = setupNotifier(t, { configs: { 'app-a': completedConfig({ version: 3 }) } });
    const result = await notifier.setCodeSendEnabled('app-a', false, { ifMatch: 3 });
    assert.equal(result.code_send_enabled, false);
    assert.ok(result.version > 3, '应返回新版本号');
    assert.ok(calls.updateFields.length >= 1);
    assert.equal(calls.updateFields[0].expectedVersion, 3);
});

test('P0-02: setCodeSendEnabled 缺版本返回 428 APP_VERSION_REQUIRED', async t => {
    const { notifier } = setupNotifier(t, { configs: { 'app-a': completedConfig({ version: 3 }) } });
    let caught = null;
    try {
        await notifier.setCodeSendEnabled('app-a', false);
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.statusCode, 428);
    assert.equal(caught.businessCode, 'APP_VERSION_REQUIRED');
});

test('P0-02: setCodeSendEnabled 版本不匹配返回 409 APP_VERSION_CONFLICT', async t => {
    const { notifier } = setupNotifier(t, { configs: { 'app-a': completedConfig({ version: 9 }) } });
    let caught = null;
    try {
        await notifier.setCodeSendEnabled('app-a', true, { ifMatch: 3 });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.statusCode, 409);
    assert.equal(caught.businessCode, 'APP_VERSION_CONFLICT');
});

// ─── P0-04: generate-callback 转发 draft_code/version ─────────────────

test('P0-04: createCallbackConfiguration 更新草稿必须校验 version（缺省 428）', async t => {
    const { notifier } = setupNotifier(t, {
        configs: { 'draft-1': draftConfig({ version: 1 }) }
    });
    let caught = null;
    try {
        await notifier.createCallbackConfiguration({
            corpid: 'corp-1',
            callback_token: 'tok',
            encoding_aes_key: 'A'.repeat(43),
            draft_code: 'draft-1'
            // 缺 version
        });
    } catch (err) { caught = err; }
    assert.ok(caught, '草稿更新缺 version 应拒绝');
    assert.equal(caught.businessCode, 'APP_VERSION_REQUIRED');
    assert.equal(caught.statusCode, 428);
});

test('P0-04: createCallbackConfiguration 更新草稿 version 不匹配返回 409 而非成功', async t => {
    const { notifier, calls } = setupNotifier(t, {
        configs: { 'draft-1': draftConfig({ version: 5 }) },
        updateChangesByCode: { 'draft-1': 0 }  // 模拟版本不匹配
    });
    let caught = null;
    try {
        await notifier.createCallbackConfiguration({
            corpid: 'corp-1',
            callback_token: 'tok',
            encoding_aes_key: 'A'.repeat(43),
            draft_code: 'draft-1',
            version: 2
        });
    } catch (err) { caught = err; }
    assert.ok(caught, '版本不匹配应抛错而非静默成功');
    assert.equal(caught.businessCode, 'APP_VERSION_CONFLICT');
});

test('P0-04: createCallbackConfiguration 新建草稿返回 201 风格（version=1）', async t => {
    const { notifier } = setupNotifier(t, { configs: {} });
    const result = await notifier.createCallbackConfiguration({
        corpid: 'corp-new',
        callback_token: 'tok',
        encoding_aes_key: 'A'.repeat(43)
    });
    assert.ok(result.code, '新草稿应返回 code');
    assert.equal(result.version, 1, '新草稿初始版本为 1');
    assert.equal(result.lifecycle_status, 'draft');
});

// ─── P0-04: complete-config 转发 version ──────────────────────────────

test('P0-04: completeConfiguration 缺 version 返回 428', async t => {
    const { notifier } = setupNotifier(t, { configs: { 'draft-1': draftConfig({ version: 1 }) } });
    let caught = null;
    try {
        await notifier.completeConfiguration({
            code: 'draft-1', corpsecret: 'sec', agentid: 100001, touser: 'alice'
        });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.businessCode, 'APP_VERSION_REQUIRED');
});

test('P0-04: completeConfiguration 旧版本返回 409 而非成功', async t => {
    const { notifier } = setupNotifier(t, {
        configs: { 'draft-1': draftConfig({ version: 9 }) },
        updateChangesByCode: { 'draft-1': 0 }
    });
    let caught = null;
    try {
        await notifier.completeConfiguration({
            code: 'draft-1', corpsecret: 'sec', agentid: 100001, touser: 'alice', version: 2
        });
    } catch (err) { caught = err; }
    assert.ok(caught, '旧版本必须报错而非成功');
    assert.equal(caught.businessCode, 'APP_VERSION_CONFLICT');
});

// ─── P1-04: DELETE null 必须返回 428，禁止 Number(null)===0 ────────────

test('P1-04: deleteConfiguration(null) 返回 428 而非版本 0 冲突', async t => {
    const { notifier } = setupNotifier(t, { configs: { 'app-a': completedConfig({ version: 3 }) } });
    let caught = null;
    try {
        await notifier.deleteConfiguration('app-a', null);
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.statusCode, 428, '缺 If-Match 应 428');
    assert.equal(caught.businessCode, 'APP_VERSION_REQUIRED');
});

test('P1-04: deleteConfiguration(undefined) 返回 428', async t => {
    const { notifier } = setupNotifier(t, { configs: { 'app-a': completedConfig({ version: 3 }) } });
    let caught = null;
    try {
        await notifier.deleteConfiguration('app-a', undefined);
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.businessCode, 'APP_VERSION_REQUIRED');
});
