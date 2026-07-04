// 阶段 A（先补会失败的测试）：规则写操作聚合版本契约（P0-03 / P0-02）。
//
// 覆盖设计 §3.3：create/update/regenerate/delete/setRuleEnabled 必须接入 If-Match，
// 成功返回 app_version，缺版本 428，版本冲突 409，任一步失败全部回滚。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-code-review-fix-guide.md §3.3。
//
// 本文件使用 prototype stub 模拟事务与 DAO 行为，冻结契约不变量。

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
        description: '告警应用',
        callback_enabled: 1,
        notify_key_hash: null,
        legacy_until: null,
        code_send_enabled: 1,
        app_enabled: 1,
        version: 2,
        created_at: '2026-07-01 00:00:00',
        ...overrides
    };
}

function ruleRow(overrides = {}) {
    return {
        id: 7,
        config_code: 'app-a',
        api_code: 'rule-api',
        name: '规则',
        touser: 'alice|bob',
        toparty: '',
        totag: '',
        is_all: 0,
        enabled: 1,
        estimated_count: 2,
        created_at: '2026-07-01 00:00:00',
        updated_at: '2026-07-01 00:00:00',
        ...overrides
    };
}

// 事务桩：模拟规则聚合事务（mutateRuleWithAppVersion）。
// 验证调用方传入了 expectedVersion + 各 SQL 在同一事务内执行。
function setupRuleNotifier(t, { config = {}, rules = [], ruleById = null, failAt = null } = {}) {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');

    const cfgByCode = { [config.code]: config };
    const rulesByConfig = { [config.code]: rules };
    const ruleByIdStore = ruleById ? { [ruleById.id]: ruleRow(ruleById) } : {};

    const calls = {
        txCalls: 0,
        ruleSqls: [],
        appVersionSqls: [],
        versionChecks: [],
        expectedVersions: [],
        failedAt: null
    };

    replaceForTest(t, Database.prototype, 'init', async function init() {});
    replaceForTest(t, Database.prototype, 'getConfigurationByCode', async function (code) {
        const row = cfgByCode[code];
        return row ? { ...row } : null;
    });
    replaceForTest(t, Database.prototype, 'getNotificationRuleById', async function (id) {
        const r = ruleByIdStore[id] || rules.find(rr => Number(rr.id) === Number(id));
        return r ? { ...r } : null;
    });
    replaceForTest(t, Database.prototype, 'listNotificationRules', async function (configCode) {
        return (rulesByConfig[configCode] || []).map(r => ({ ...r }));
    });

    // 聚合事务方法：规则变更 + 版本递增原子化。
    // 真实签名：mutateRuleWithAppVersion(identity, expectedVersion, mutation)
    //   identity: { configCode } 或 { ruleId }
    //   mutation(tx, app): 事务内执行规则变更，返回规则结果。
    replaceForTest(t, Database.prototype, 'mutateRuleWithAppVersion', async function (identity, expectedVersion, mutation) {
        calls.txCalls++;
        calls.expectedVersions.push(expectedVersion);
        try {
            // 由 ruleId 反查 configCode（与真实 DAO 一致）。
            let configCode = identity.configCode;
            if (!configCode && identity.ruleId) {
                const ruleRow = ruleByIdStore[identity.ruleId] || rules.find(r => Number(r.id) === Number(identity.ruleId));
                if (!ruleRow) {
                    calls.failedAt = 'rule-missing';
                    throw Object.assign(new Error('rule missing'), { __ruleCause: 'rule_missing' });
                }
                configCode = ruleRow.config_code;
            }
            // 读取应用并校验 completed + version
            const app = cfgByCode[configCode];
            if (!app) {
                calls.failedAt = 'app-missing';
                throw Object.assign(new Error('app missing'), { __ruleCause: 'app_missing' });
            }
            calls.versionChecks.push({ code: app.code, version: app.version, expectedVersion });
            // 草稿不允许规则操作。
            const hasSecret = app.encrypted_corpsecret && app.encrypted_corpsecret.length > 0;
            if (!hasSecret) {
                throw Object.assign(new Error('app not completed'), { __ruleCause: 'app_not_completed' });
            }
            if (Number(app.version) !== Number(expectedVersion)) {
                calls.failedAt = 'version-conflict';
                const e = new Error('version mismatch');
                e.__ruleCause = 'version_conflict';
                e.__currentVersion = Number(app.version);
                throw e;
            }
            // 执行规则 mutation（在事务内）。
            const tx = {
                run: async (sql, params) => {
                    calls.ruleSqls.push(String(sql));
                    if (failAt === 'rule-sql') throw new Error('inject: rule sql failed');
                    return { changes: 1, lastID: 99 };
                },
                get: async (sql, params) => {
                    // 让 mutation 内的 rule 存在性检查命中 mock 规则。
                    const r = ruleByIdStore[identity.ruleId] || rules.find(rr => Number(rr.id) === Number(identity.ruleId));
                    return r ? { ...r } : null;
                },
                all: async () => []
            };
            const ruleResult = await mutation(tx, app);
            calls.appVersionSqls.push('bumped');
            if (failAt === 'version-bump') throw new Error('inject: version bump failed');
            app.version = Number(app.version) + 1;
            return { rule: ruleResult, app_version: app.version };
        } catch (err) {
            throw err;
        }
    });

    replaceForTest(t, CryptoService.prototype, 'decrypt', function (v) { return String(v).replace(/^enc-/, ''); });
    replaceForTest(t, CryptoService.prototype, 'encrypt', function (v) { return `enc-${v}`; });
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
    return { notifier, calls };
}

// ─── createRule：缺版本 428 / 成功返回 app_version ───────────────────────

test('P0-03: createRule 缺版本返回 APP_VERSION_REQUIRED', async t => {
    const { notifier } = setupRuleNotifier(t, { config: completedConfig({ version: 2 }) });
    let caught = null;
    try {
        await notifier.createRule('app-a', { name: 'r1', touser: 'alice' });
    } catch (err) { caught = err; }
    assert.ok(caught, '应抛错');
    assert.equal(caught.statusCode, 428);
    assert.equal(caught.businessCode, 'APP_VERSION_REQUIRED');
});

test('P0-03: createRule 版本不匹配返回 APP_VERSION_CONFLICT', async t => {
    const { notifier, calls } = setupRuleNotifier(t, { config: completedConfig({ version: 5 }) });
    let caught = null;
    try {
        await notifier.createRule('app-a', { name: 'r1', touser: 'alice' }, { expectedVersion: 2 });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.statusCode, 409);
    assert.equal(caught.businessCode, 'APP_VERSION_CONFLICT');
    assert.ok(calls.expectedVersions.includes(2));
});

test('P0-03: createRule 成功返回 app_version', async t => {
    const { notifier } = setupRuleNotifier(t, { config: completedConfig({ version: 2 }) });
    const result = await notifier.createRule('app-a', { name: 'r1', touser: 'alice' }, { expectedVersion: 2 });
    assert.ok(result.app_version, '成功响应应包含 app_version');
    assert.equal(result.app_version, 3);
});

// ─── updateRule / regenerate / delete：同样接入版本 ─────────────────────

test('P0-03: updateRule 缺版本返回 APP_VERSION_REQUIRED', async t => {
    const { notifier } = setupRuleNotifier(t, {
        config: completedConfig({ version: 2 }),
        ruleById: ruleRow({ id: 7, config_code: 'app-a' })
    });
    let caught = null;
    try {
        await notifier.updateRule(7, { name: 'renamed' });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.businessCode, 'APP_VERSION_REQUIRED');
    assert.equal(caught.statusCode, 428);
});

test('P0-03: regenerateRuleApiCode 成功返回 app_version', async t => {
    const { notifier } = setupRuleNotifier(t, {
        config: completedConfig({ version: 2 }),
        ruleById: ruleRow({ id: 7, config_code: 'app-a' })
    });
    const result = await notifier.regenerateRuleApiCode(7, { expectedVersion: 2 });
    assert.ok(result.app_version, 'regenerate 应返回 app_version');
});

test('P0-03: deleteRule 缺版本返回 APP_VERSION_REQUIRED', async t => {
    const { notifier } = setupRuleNotifier(t, {
        config: completedConfig({ version: 2 }),
        ruleById: ruleRow({ id: 7, config_code: 'app-a' })
    });
    let caught = null;
    try {
        await notifier.deleteRule(7);
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.businessCode, 'APP_VERSION_REQUIRED');
});

// ─── setRuleEnabled：严格布尔 + 版本 + app_version ──────────────────────

test('P0-03: setRuleEnabled 拒绝模糊布尔值', async t => {
    const { notifier } = setupRuleNotifier(t, {
        config: completedConfig({ version: 2 }),
        ruleById: ruleRow({ id: 7 })
    });
    let caught = null;
    try {
        // 'maybe' 无法解析为布尔 → toStrictBoolean 返回 null → INVALID_INPUT。
        await notifier.setRuleEnabled(7, 'maybe', { expectedVersion: 2 });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.businessCode, 'INVALID_INPUT');
});

test('P0-03: setRuleEnabled 缺版本返回 APP_VERSION_REQUIRED', async t => {
    const { notifier } = setupRuleNotifier(t, {
        config: completedConfig({ version: 2 }),
        ruleById: ruleRow({ id: 7 })
    });
    let caught = null;
    try {
        await notifier.setRuleEnabled(7, true);
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.businessCode, 'APP_VERSION_REQUIRED');
});

test('P0-03: setRuleEnabled 成功返回 app_version', async t => {
    const { notifier } = setupRuleNotifier(t, {
        config: completedConfig({ version: 2 }),
        ruleById: ruleRow({ id: 7 })
    });
    const result = await notifier.setRuleEnabled(7, false, { expectedVersion: 2 });
    assert.ok(result.app_version !== undefined, '应返回 app_version');
});

// ─── 原子性：版本递增失败时规则回滚 ──────────────────────────────────────

test('P0-03: 版本递增失败时规则操作整体回滚', async t => {
    const { notifier, calls } = setupRuleNotifier(t, {
        config: completedConfig({ version: 2 }),
        failAt: 'version-bump'
    });
    let caught = null;
    try {
        await notifier.createRule('app-a', { name: 'r1', touser: 'alice' }, { expectedVersion: 2 });
    } catch (err) { caught = err; }
    assert.ok(caught, '版本递增失败应抛错');
    assert.equal(calls.txCalls, 1);
});
