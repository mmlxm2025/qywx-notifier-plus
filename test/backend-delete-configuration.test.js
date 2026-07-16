// 阶段 0：删除配置事务与发送防绕过契约测试（冻结不变量）。
//
// 覆盖设计文档 §6.2（事务）、§6.6（删除）、§4.4（三层发送开关）与 §10.1 第 11/12/13 项：
//   - 级联删除：配置 + N 条规则一起删除，返回计数准确。
//   - 事务回滚：规则删除成功但配置删除失败时配置与规则都保留。
//   - 版本校验：删除携带 If-Match，冲突返回 APP_VERSION_CONFLICT。
//   - 防绕过：notifier 内部发送入口也受 app_enabled / 草稿 / code_send / rule.enabled 限制。
//   - 命名空间损坏：规则与配置 Code 大小写冲突时拒绝发送。
//   - 缓存失效：删除成功后清理 token 缓存（尽力）。

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
        code: 'app-a',
        corpid: 'corp-1',
        encrypted_corpsecret: 'enc-secret',
        agentid: 100001,
        touser: 'alice',
        description: '告警应用',
        callback_token: null,
        encrypted_callback_token: 'enc-token',
        encrypted_encoding_aes_key: 'enc-aes',
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

// 事务桩：通过 failStep 控制在第几步抛错，用于回滚验证。
function setupNotifier(t, { store = {}, failStep = null, invalidateTokenCalls = [] } = {}) {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');

    const cfgByCode = store.configs || {};
    const rulesByConfigCode = store.rulesByConfigCode || {};
    const calls = {
        txStarted: 0,
        txCommitted: 0,
        txRolledBack: 0,
        rulesDeletedArgs: null,
        configsDeletedArgs: null,
        cascade: null,
        sent: [],
        tokenInvalidated: []
    };

    replaceForTest(t, Database.prototype, 'init', async function init() {});
    // 与生产 DAO 一致：编号查询大小写不敏感，返回库内权威大小写行。
    replaceForTest(t, Database.prototype, 'getConfigurationByCode', async function getConfigurationByCode(code) {
        if (code === undefined || code === null || String(code).trim() === '') return null;
        const key = Object.keys(cfgByCode).find(k => String(k).toLowerCase() === String(code).toLowerCase());
        return key ? { ...cfgByCode[key] } : null;
    });
    replaceForTest(t, Database.prototype, 'listNotificationRules', async function listNotificationRules(configCode) {
        return (rulesByConfigCode[configCode] || []).map(r => ({ ...r }));
    });
    replaceForTest(t, Database.prototype, 'getNotificationRuleByApiCode', async function getNotificationRuleByApiCode(apiCode) {
        if (apiCode === undefined || apiCode === null || String(apiCode).trim() === '') return null;
        const needle = String(apiCode).toLowerCase();
        for (const list of Object.values(rulesByConfigCode)) {
            const hit = list.find(r => String(r.api_code).toLowerCase() === needle);
            if (hit) return { ...hit };
        }
        return null;
    });

    // 事务接口（阶段2落地）。事务期间的语句使用 tx 句柄；本桩模拟两步删除。
    replaceForTest(t, Database.prototype, 'withTransaction', async function withTransaction(fn) {
        calls.txStarted++;
        const tx = {
            async run(sql, params) {
                const s = String(sql || '').toUpperCase();
                if (s.includes('NOTIFICATION_RULES')) {
                    calls.rulesDeletedArgs = { sql, params };
                    if (failStep === 'rules') throw new Error('inject: rules delete failed');
                    return { changes: (rulesByConfigCode[params[0]] || []).length };
                }
                if (s.includes('CONFIGURATIONS')) {
                    calls.configsDeletedArgs = { sql, params };
                    if (failStep === 'configs') throw new Error('inject: config delete failed');
                    return { changes: 1 };
                }
                return { changes: 0 };
            },
            async get(sql, params) {
                // 事务内重新校验版本：当 SQL 含 version 过滤时只在版本匹配时返回行。
                if (String(sql).toUpperCase().includes('CONFIGURATIONS')) {
                    const code = params[0];
                    const row = cfgByCode[code];
                    if (!row) return null;
                    if (String(sql).toUpperCase().includes('VERSION')) {
                        const expected = Number(params[1]);
                        if (Number(row.version) !== expected) return null;
                    }
                    return { ...row };
                }
                return null;
            }
        };
        try {
            const ret = await fn(tx);
            calls.txCommitted++;
            return ret;
        } catch (err) {
            calls.txRolledBack++;
            throw err;
        }
    });
    replaceForTest(t, Database.prototype, 'deleteConfigurationCascade', async function deleteConfigurationCascade(code, expectedVersion) {
        calls.cascade = { code, expectedVersion };
        // 委托 withTransaction 以复用回滚语义。
        return Database.prototype.withTransaction(async (tx) => {
            const row = await tx.get('SELECT * FROM configurations WHERE code = ? AND version = ?', [code, expectedVersion]);
            if (!row) {
                // 区分 404 / 409 由 service 层处理；这里直接抛供 service 翻译。
                const exists = cfgByCode[code];
                const e = new Error(exists ? 'version mismatch' : 'not found');
                e.__deleteCause = exists ? 'version' : 'missing';
                throw e;
            }
            const rules = rulesByConfigCode[code] || [];
            await tx.run('DELETE FROM notification_rules WHERE config_code = ?', [code]);
            await tx.run('DELETE FROM configurations WHERE code = ? AND version = ?', [code, expectedVersion]);
            return { configurations_deleted: 1, rules_deleted: rules.length };
        });
    });

    replaceForTest(t, CryptoService.prototype, 'decrypt', function decrypt(v) { return String(v).replace(/^enc-/, ''); });
    replaceForTest(t, CryptoService.prototype, 'encrypt', function encrypt(v) { return `enc-${v}`; });

    replaceForTest(t, WeChatService.prototype, 'getToken', async function getToken() { return 'access-token'; });
    replaceForTest(t, WeChatService.prototype, 'getAgentInfo', async function getAgentInfo(token, agentid) { return { agentid }; });
    replaceForTest(t, WeChatService.prototype, 'getAgentVisibleUsers', async function getAgentVisibleUsers() { return [{ userid: 'alice', name: 'Alice' }]; });
    replaceForTest(t, WeChatService.prototype, 'sendTextMessage', async function sendTextMessage(token, args) {
        calls.sent.push({ token, args });
        return { errcode: 0, errmsg: 'ok', msgid: 'm-1' };
    });
    replaceForTest(t, WeChatService.prototype, 'invalidateToken', async function invalidateToken(corpid, secret) {
        calls.tokenInvalidated.push({ corpid, secret });
        invalidateTokenCalls.push({ corpid, secret });
    });

    clearModule('../src/services/notifier');
    t.after(() => {
        clearModule('../src/services/notifier');
        clearModule('../src/api/routes');
    });
    const notifier = require('../src/services/notifier');
    return { notifier, calls };
}

// ─── 级联删除 ────────────────────────────────────────────────────────────

test('deleteConfiguration 级联删除配置与规则，返回准确计数', async t => {
    const { notifier, calls } = setupNotifier(t, {
        store: {
            configs: { 'app-a': completedConfig({ version: 2 }) },
            rulesByConfigCode: {
                'app-a': [ruleRow({ id: 1 }), ruleRow({ id: 2, api_code: 'rule-2' })]
            }
        }
    });

    const result = await notifier.deleteConfiguration('app-a', 2);

    assert.deepEqual(result, { code: 'app-a', configurations_deleted: 1, rules_deleted: 2 });
    assert.equal(calls.txCommitted, 1);
    assert.equal(calls.txRolledBack, 0);
    // 删除成功后应失效旧 token（尽力）。
    assert.ok(calls.tokenInvalidated.length >= 1, '删除后应清理旧 token 缓存');
});

test('deleteConfiguration 配置不存在返回 APP_NOT_FOUND', async t => {
    const { notifier } = setupNotifier(t, { store: { configs: {} } });

    let caught = null;
    try {
        await notifier.deleteConfiguration('missing', 1);
    } catch (err) {
        caught = err;
    }
    assert.ok(caught);
    assert.equal(caught.statusCode, 404);
    assert.equal(caught.businessCode, 'APP_NOT_FOUND');
});

test('deleteConfiguration 版本不匹配返回 APP_VERSION_CONFLICT', async t => {
    const { notifier } = setupNotifier(t, {
        store: { configs: { 'app-a': completedConfig({ version: 5 }) } }
    });

    let caught = null;
    try {
        await notifier.deleteConfiguration('app-a', 2);
    } catch (err) {
        caught = err;
    }
    assert.ok(caught);
    assert.equal(caught.statusCode, 409);
    assert.equal(caught.businessCode, 'APP_VERSION_CONFLICT');
});

// ─── 事务回滚 ────────────────────────────────────────────────────────────

test('规则删除成功但配置删除失败时回滚，配置与规则都保留', async t => {
    const { notifier, calls } = setupNotifier(t, {
        store: {
            configs: { 'app-a': completedConfig({ version: 2 }) },
            rulesByConfigCode: { 'app-a': [ruleRow()] }
        },
        failStep: 'configs'
    });

    let caught = null;
    try {
        await notifier.deleteConfiguration('app-a', 2);
    } catch (err) {
        caught = err;
    }

    // 注入故障必须向前端报错，不能报成功。
    assert.ok(caught, '第二步删除故障必须抛出');
    assert.equal(calls.txRolledBack, 1);
    assert.equal(calls.txCommitted, 0);
    // 失败后不得清理 token（保留以备排查）。
    assert.equal(calls.tokenInvalidated.length, 0);
});

test('规则删除失败时同样回滚', async t => {
    const { notifier, calls } = setupNotifier(t, {
        store: {
            configs: { 'app-a': completedConfig({ version: 2 }) },
            rulesByConfigCode: { 'app-a': [ruleRow()] }
        },
        failStep: 'rules'
    });

    await assert.rejects(() => notifier.deleteConfiguration('app-a', 2));
    assert.equal(calls.txRolledBack, 1);
    assert.equal(calls.txCommitted, 0);
});

// ─── 发送防绕过 ──────────────────────────────────────────────────────────

test('发送入口在 app_enabled=0 时返回 APP_DISABLED（即使子开关全开）', async t => {
    const { notifier, calls } = setupNotifier(t, {
        store: {
            configs: { 'app-a': completedConfig({ app_enabled: 0, code_send_enabled: 1, version: 2 }) }
        }
    });

    let caught = null;
    try {
        // 实际签名：sendNotification(code, title, content, options)。
        await notifier.sendNotification('app-a', 'hi', 'hello', { msgType: 'text' });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught, '暂停应用不应发送');
    assert.equal(caught.statusCode, 403);
    assert.equal(caught.businessCode, 'APP_DISABLED');
    // 关键：不得实际调用企业微信发送。
    assert.equal(calls.sent.length, 0);
});

test('草稿应用发送返回 APP_NOT_COMPLETED', async t => {
    const { notifier } = setupNotifier(t, {
        store: {
            configs: {
                'draft-1': completedConfig({
                    code: 'draft-1', encrypted_corpsecret: '', agentid: 0, touser: '', app_enabled: 1
                })
            }
        }
    });

    let caught = null;
    try {
        await notifier.sendNotification('draft-1', 'hi', 'hello', { msgType: 'text' });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught);
    assert.equal(caught.statusCode, 409);
    assert.equal(caught.businessCode, 'APP_NOT_COMPLETED');
});

// 业务逻辑漏洞：isDraftConfig 只匹配「纯草稿」(无 secret AND 无 agent AND 无 touser)。
// 半完成配置（仅有 secret、或 secret+agent 但无 touser）不是 isDraft，也不是 isCompleted。
// 发送闸门必须用 !isCompletedConfig，否则会错误放行并调用企业微信（空接收人/非法 agentid）。
test('半完成配置(仅有 secret)发送必须 APP_NOT_COMPLETED 且不调用企业微信', async t => {
    const { notifier, calls } = setupNotifier(t, {
        store: {
            configs: {
                'partial-secret': completedConfig({
                    code: 'partial-secret',
                    encrypted_corpsecret: 'enc-secret',
                    agentid: 0,
                    touser: '',
                    app_enabled: 1
                })
            }
        }
    });

    assert.equal(notifier.isDraftConfig(completedConfig({
        encrypted_corpsecret: 'enc-secret', agentid: 0, touser: ''
    })), false, '半完成配置不得被 isDraftConfig 判为草稿');
    assert.equal(notifier.isCompletedConfig(completedConfig({
        encrypted_corpsecret: 'enc-secret', agentid: 0, touser: ''
    })), false);

    let caught = null;
    try {
        await notifier.sendNotification('partial-secret', 'hi', 'hello', { msgType: 'text' });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught, '半完成配置不得发送');
    assert.equal(caught.statusCode, 409);
    assert.equal(caught.businessCode, 'APP_NOT_COMPLETED');
    assert.equal(calls.sent.length, 0);
});

test('半完成配置(有 secret+agent 无 touser)发送必须 APP_NOT_COMPLETED', async t => {
    const { notifier, calls } = setupNotifier(t, {
        store: {
            configs: {
                'partial-agent': completedConfig({
                    code: 'partial-agent',
                    encrypted_corpsecret: 'enc-secret',
                    agentid: 100001,
                    touser: '',
                    app_enabled: 1
                })
            }
        }
    });

    let caught = null;
    try {
        await notifier.sendNotification('partial-agent', 'hi', 'hello', { msgType: 'text' });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught);
    assert.equal(caught.statusCode, 409);
    assert.equal(caught.businessCode, 'APP_NOT_COMPLETED');
    assert.equal(calls.sent.length, 0);
});

test('规则 API 在所属应用半完成时同样 APP_NOT_COMPLETED', async t => {
    const { notifier, calls } = setupNotifier(t, {
        store: {
            configs: {
                'app-a': completedConfig({
                    code: 'app-a',
                    encrypted_corpsecret: 'enc-secret',
                    agentid: 100001,
                    touser: '',
                    app_enabled: 1
                })
            },
            rulesByConfigCode: {
                'app-a': [ruleRow({ api_code: 'rule-on-partial', enabled: 1 })]
            }
        }
    });

    let caught = null;
    try {
        await notifier.sendNotification('rule-on-partial', 'hi', 'hello', { msgType: 'text' });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught);
    assert.equal(caught.statusCode, 409);
    assert.equal(caught.businessCode, 'APP_NOT_COMPLETED');
    assert.equal(calls.sent.length, 0);
});

test('规则 API 在应用暂停时同样 APP_DISABLED', async t => {
    const { notifier, calls } = setupNotifier(t, {
        store: {
            configs: { 'app-a': completedConfig({ app_enabled: 0, version: 2 }) },
            rulesByConfigCode: { 'app-a': [ruleRow({ api_code: 'rule-api', enabled: 1 })] }
        }
    });

    let caught = null;
    try {
        await notifier.sendNotification('rule-api', 'hi', 'hello', { msgType: 'text' });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught);
    assert.equal(caught.statusCode, 403);
    assert.equal(caught.businessCode, 'APP_DISABLED');
    assert.equal(calls.sent.length, 0);
});

// ─── P2-A：service 层子开关防绕过（assertSendAllowed）────────────────

test('P2-A: code_send_enabled=0 时直接 sendNotification 返回 DIRECT_SEND_DISABLED', async t => {
    const { notifier, calls } = setupNotifier(t, {
        store: {
            configs: { 'app-a': completedConfig({ code_send_enabled: 0, app_enabled: 1, version: 2 }) }
        }
    });

    let caught = null;
    try {
        await notifier.sendNotification('app-a', 'hi', 'hello', { msgType: 'text' });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught, '关闭 Code 直发后 service 层不得放行');
    assert.equal(caught.statusCode, 403);
    assert.equal(caught.businessCode, 'DIRECT_SEND_DISABLED');
    assert.equal(calls.sent.length, 0);
});

test('P2-A: rule.enabled=0 时直接 sendNotification 返回 RULE_DISABLED', async t => {
    const { notifier, calls } = setupNotifier(t, {
        store: {
            configs: { 'app-a': completedConfig({ app_enabled: 1, code_send_enabled: 1, version: 2 }) },
            rulesByConfigCode: { 'app-a': [ruleRow({ api_code: 'rule-api', enabled: 0 })] }
        }
    });

    let caught = null;
    try {
        await notifier.sendNotification('rule-api', 'hi', 'hello', { msgType: 'text' });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught, '禁用规则后 service 层不得放行');
    assert.equal(caught.statusCode, 403);
    assert.equal(caught.businessCode, 'RULE_DISABLED');
    assert.equal(calls.sent.length, 0);
});

// ─── P2-B：命名空间损坏检测大小写不敏感 ──────────────────────────────

test('P2-B: 规则与配置 Code 仅大小写不同时返回 NOTIFY_CODE_NAMESPACE_CORRUPTED', async t => {
    const { notifier, calls } = setupNotifier(t, {
        store: {
            configs: {
                'app-a': completedConfig({ code: 'app-a', agentid: 100001, version: 2 }),
                // 与规则 api_code「ops-alert」仅大小写不同 → 命名空间损坏
                'OPS-ALERT': completedConfig({ code: 'OPS-ALERT', agentid: 100002, version: 1 })
            },
            rulesByConfigCode: {
                'app-a': [ruleRow({ api_code: 'ops-alert', enabled: 1 })]
            }
        }
    });

    let caught = null;
    try {
        await notifier.sendNotification('ops-alert', 'hi', 'hello', { msgType: 'text' });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught, '大小写冲突必须拒绝发送');
    assert.equal(caught.statusCode, 500);
    assert.equal(caught.businessCode, 'NOTIFY_CODE_NAMESPACE_CORRUPTED');
    assert.equal(calls.sent.length, 0);
});

test('P2-B: 规则与配置 Code 完全相同时仍返回 NOTIFY_CODE_NAMESPACE_CORRUPTED', async t => {
    const { notifier, calls } = setupNotifier(t, {
        store: {
            configs: {
                'app-a': completedConfig({ code: 'app-a', agentid: 100001, version: 2 }),
                'same-code': completedConfig({ code: 'same-code', agentid: 100002, version: 1 })
            },
            rulesByConfigCode: {
                'app-a': [ruleRow({ api_code: 'same-code', enabled: 1 })]
            }
        }
    });

    let caught = null;
    try {
        await notifier.sendNotification('same-code', 't', 'c', { msgType: 'text' });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught);
    assert.equal(caught.businessCode, 'NOTIFY_CODE_NAMESPACE_CORRUPTED');
    assert.equal(calls.sent.length, 0);
});
