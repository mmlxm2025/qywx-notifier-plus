// 阶段 A（先补会失败的测试）：body version 缺失/非法/冲突三分契约（R-P1-05）。
//
// 复验指南 §5 R-P1-05：草稿更新/完成的请求体 version 字段必须区分：
//   - 缺失/null/空值：428 APP_VERSION_REQUIRED
//   - 已提供但不是正整数（"abc"、0、-1、1.5）：400 INVALID_INPUT
//   - 正整数但与当前版本不符：409 APP_VERSION_CONFLICT + 最新 version
// 当前实现把“未提供”和“格式非法”都返回 null → 428，导致 "abc"/0 也报 428。
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

function draftConfig(overrides = {}) {
    return {
        code: 'draft-1',
        corpid: 'corp-1',
        encrypted_corpsecret: '',
        agentid: 0,
        touser: '',
        description: '',
        callback_enabled: 1,
        encrypted_callback_token: 'enc',
        encrypted_encoding_aes_key: 'enc',
        notify_key_hash: null,
        version: 3,
        created_at: '2026-07-01 00:00:00',
        ...overrides
    };
}

function setupNotifier(t, { configs = {} } = {}) {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');

    const cfgByCode = { ...configs };

    replaceForTest(t, Database.prototype, 'init', async function () {});
    replaceForTest(t, Database.prototype, 'getConfigurationByCode', async function (code) {
        const r = cfgByCode[code];
        return r ? { ...r } : null;
    });
    replaceForTest(t, Database.prototype, 'findCompletedByCorpidAgentId', async function () { return null; });
    replaceForTest(t, Database.prototype, 'getIncompleteConfigurationByCorpId', async function () { return null; });
    replaceForTest(t, Database.prototype, 'countRulesByConfigCodes', async function () { return {}; });
    // 草稿更新原子事务：CAS。
    replaceForTest(t, Database.prototype, 'updateDraftCallbackAtomic', async function (code, fields, expectedVersion) {
        const row = cfgByCode[code];
        if (!row) { const e = new Error('m'); e.__draftCause = 'missing'; throw e; }
        if (Number(row.version) !== Number(expectedVersion)) {
            const e = new Error('v'); e.__draftCause = 'version_conflict'; e.__currentVersion = row.version; throw e;
        }
        Object.assign(row, fields);
        row.version += 1;
        return { code, version: row.version };
    });
    // 完成草稿原子事务：CAS。
    replaceForTest(t, Database.prototype, 'completeConfigurationAtomic', async function (code, fields, expectedVersion, opts = {}) {
        const row = cfgByCode[code];
        if (!row) { const e = new Error('m'); e.__completeCause = 'missing'; throw e; }
        if (Number(row.version) !== Number(expectedVersion)) {
            const e = new Error('v'); e.__completeCause = 'version_conflict'; e.__currentVersion = row.version; throw e;
        }
        Object.assign(row, fields);
        row.version += 1;
        return { code, version: row.version };
    });
    replaceForTest(t, Database.prototype, 'createDraftCallbackAtomic', async function (cfg) {
        cfgByCode[cfg.code] = { ...cfg, version: 1 };
        return { code: cfg.code };
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
    const notifier = require('../src/services/notifier');
    return { notifier };
}

async function capture(fn) {
    try { await fn(); return null; }
    catch (err) { return err; }
}

// ─── createCallbackConfiguration（更新草稿）body version 三分 ────────────

test('R-P1-05: 草稿更新缺 version 返回 428', async t => {
    const { notifier } = setupNotifier(t, { configs: { 'draft-1': draftConfig({ version: 3 }) } });
    const err = await capture(() => notifier.createCallbackConfiguration({
        corpid: 'corp-1', callback_token: 't', encoding_aes_key: 'A'.repeat(43), draft_code: 'draft-1'
    }));
    assert.ok(err);
    assert.equal(err.statusCode, 428);
    assert.equal(err.businessCode, 'APP_VERSION_REQUIRED');
});

test('R-P1-05: 草稿更新 version="abc" 返回 400 INVALID_INPUT（非 428）', async t => {
    const { notifier } = setupNotifier(t, { configs: { 'draft-1': draftConfig({ version: 3 }) } });
    const err = await capture(() => notifier.createCallbackConfiguration({
        corpid: 'corp-1', callback_token: 't', encoding_aes_key: 'A'.repeat(43), draft_code: 'draft-1', version: 'abc'
    }));
    assert.ok(err);
    assert.equal(err.statusCode, 400);
    assert.equal(err.businessCode, 'INVALID_INPUT');
});

test('R-P1-05: 草稿更新 version=0 返回 400 INVALID_INPUT', async t => {
    const { notifier } = setupNotifier(t, { configs: { 'draft-1': draftConfig({ version: 3 }) } });
    const err = await capture(() => notifier.createCallbackConfiguration({
        corpid: 'corp-1', callback_token: 't', encoding_aes_key: 'A'.repeat(43), draft_code: 'draft-1', version: 0
    }));
    assert.ok(err);
    assert.equal(err.statusCode, 400);
    assert.equal(err.businessCode, 'INVALID_INPUT');
});

test('R-P1-05: 草稿更新 version=null 返回 428', async t => {
    const { notifier } = setupNotifier(t, { configs: { 'draft-1': draftConfig({ version: 3 }) } });
    const err = await capture(() => notifier.createCallbackConfiguration({
        corpid: 'corp-1', callback_token: 't', encoding_aes_key: 'A'.repeat(43), draft_code: 'draft-1', version: null
    }));
    assert.ok(err);
    assert.equal(err.statusCode, 428);
    assert.equal(err.businessCode, 'APP_VERSION_REQUIRED');
});

test('R-P1-05: 草稿更新 version 旧版本返回 409 含最新 version', async t => {
    const { notifier } = setupNotifier(t, { configs: { 'draft-1': draftConfig({ version: 3 }) } });
    const err = await capture(() => notifier.createCallbackConfiguration({
        corpid: 'corp-1', callback_token: 't', encoding_aes_key: 'A'.repeat(43), draft_code: 'draft-1', version: 1
    }));
    assert.ok(err);
    assert.equal(err.statusCode, 409);
    assert.equal(err.businessCode, 'APP_VERSION_CONFLICT');
    assert.equal(err.details && err.details.version, 3);
});

// ─── completeConfiguration body version 三分 ────────────────────────────

test('R-P1-05: complete 缺 version 返回 428', async t => {
    const { notifier } = setupNotifier(t, { configs: { 'draft-1': draftConfig({ version: 3 }) } });
    const err = await capture(() => notifier.completeConfiguration({
        code: 'draft-1', corpsecret: 's', agentid: 100001, touser: 'alice'
    }));
    assert.ok(err);
    assert.equal(err.businessCode, 'APP_VERSION_REQUIRED');
    assert.equal(err.statusCode, 428);
});

test('R-P1-05: complete version="abc" 返回 400', async t => {
    const { notifier } = setupNotifier(t, { configs: { 'draft-1': draftConfig({ version: 3 }) } });
    const err = await capture(() => notifier.completeConfiguration({
        code: 'draft-1', corpsecret: 's', agentid: 100001, touser: 'alice', version: 'abc'
    }));
    assert.ok(err);
    assert.equal(err.statusCode, 400);
    assert.equal(err.businessCode, 'INVALID_INPUT');
});

test('R-P1-05: complete version=0 返回 400', async t => {
    const { notifier } = setupNotifier(t, { configs: { 'draft-1': draftConfig({ version: 3 }) } });
    const err = await capture(() => notifier.completeConfiguration({
        code: 'draft-1', corpsecret: 's', agentid: 100001, touser: 'alice', version: 0
    }));
    assert.ok(err);
    assert.equal(err.statusCode, 400);
    assert.equal(err.businessCode, 'INVALID_INPUT');
});

test('R-P1-05: complete 旧版本返回 409', async t => {
    const { notifier } = setupNotifier(t, { configs: { 'draft-1': draftConfig({ version: 3 }) } });
    const err = await capture(() => notifier.completeConfiguration({
        code: 'draft-1', corpsecret: 's', agentid: 100001, touser: 'alice', version: 1
    }));
    assert.ok(err);
    assert.equal(err.statusCode, 409);
    assert.equal(err.businessCode, 'APP_VERSION_CONFLICT');
});
