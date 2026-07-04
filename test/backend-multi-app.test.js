// 阶段 0：多应用管理契约测试（冻结不变量与错误码）。
//
// 本文件用 TDD 锁定 2026-07-04 多应用管理设计文档中的核心契约：
//   - 草稿隔离：同企业已完成应用不被新建流程当成草稿复用。
//   - 草稿查询只命中真正未完成的行。
//   - completeConfiguration 仅允许完成草稿。
//   - (corpid, agentid) 身份判重阻止覆盖已完成应用。
//   - 统一序列化输出 lifecycle_status / capabilities / warnings / version。
//   - 稳定业务错误码（businessCode）与 details。
//   - corpid 创建后不可修改。
//   - 应用总开关 app_enabled。
//
// 阶段 0 时这些用例预期失败（实现尚未落地），用于冻结契约；
// 阶段 1/2 落地后必须全部转绿。

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

// 复用 backend-rules-cache 中的行结构，避免在多处复制字段约定。
function completedConfig(overrides = {}) {
    return {
        code: 'app-a',
        corpid: 'corp-1',
        encrypted_corpsecret: 'encrypted-secret',
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
        created_at: '2026-07-01 00:00:00',
        ...overrides
    };
}

function draftConfig(overrides = {}) {
    return completedConfig({
        code: 'draft-1',
        encrypted_corpsecret: '',
        agentid: 0,
        touser: '',
        description: '',
        ...overrides
    });
}

// 与 notifier.normalizeTouser 语义一致的去空去重。
function splitTouser(value) {
    const list = Array.isArray(value) ? value : String(value || '').split('|');
    return [...new Set(list.map(item => String(item).trim()).filter(Boolean))];
}
function isTouserEmpty(value) {
    return splitTouser(value).length === 0;
}

// 装配 notifier + 注入桩 DAO/WeChat，默认全部返回空。
// 各用例通过 store 自定义按 code/字段 返回的行。
function setupNotifier(t, { store = {} } = {}) {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');

    // 可变 store：updateConfigurationFields/setAppEnabled 等会真实修改行并递增版本，
    // 以便服务层“重新读取最新摘要”的语义在测试中成立。
    const cfgByCode = {};                               // code -> row（深拷贝初始值）
    for (const [code, row] of Object.entries(store.configs || {})) {
        cfgByCode[code] = { ...row };
    }
    const drafts = store.drafts || {};                  // corpid -> [draft rows]
    const completedByIdentity = store.completedByIdentity || {}; // "corpid|agentid" -> row
    const rulesByConfigCode = store.rulesByConfigCode || {};     // config_code -> [rule rows]

    const calls = {
        saveCallback: [],
        completed: [],
        validateToken: []
    };

    replaceForTest(t, Database.prototype, 'init', async function init() {});
    replaceForTest(t, Database.prototype, 'getConfigurationByCode', async function getConfigurationByCode(code) {
        const row = cfgByCode[code];
        return row ? { ...row } : null;
    });
    // 新增：真正的草稿查询（阶段1落地）。阶段0默认未实现 → 返回 null 模拟旧行为。
    replaceForTest(t, Database.prototype, 'getIncompleteConfigurationByCorpId', async function getIncompleteConfigurationByCorpId(corpid) {
        // 优先查显式 drafts；否则在 cfgByCode 中找符合草稿定义的行。
        const list = drafts[corpid] || [];
        if (list.length) return { ...list[list.length - 1] };
        const inStore = Object.values(cfgByCode).find(r =>
            r.corpid === corpid && !r.encrypted_corpsecret
            && Number(r.agentid) === 0 && isTouserEmpty(r.touser));
        return inStore ? { ...inStore } : null;
    });
    // 旧查询（错误实现），仍保留以证明阶段1已停止使用它。
    replaceForTest(t, Database.prototype, 'getCallbackConfiguration', async function getCallbackConfiguration(corpid) {
        // 旧行为：返回同 corpid 下任意 callback_enabled=1 的最新行（含已完成应用）。
        const all = Object.values(cfgByCode).filter(r => r.corpid === corpid && r.callback_enabled === 1);
        all.sort((a, b) => (a.id || 0) - (b.id || 0));
        return all.length ? { ...all[all.length - 1] } : null;
    });
    replaceForTest(t, Database.prototype, 'saveCallbackConfiguration', async function saveCallbackConfiguration(input) {
        calls.saveCallback.push({ ...input });
        cfgByCode[input.code] = {
            code: input.code, corpid: input.corpid,
            encrypted_corpsecret: '', agentid: 0, touser: '', description: '',
            encrypted_callback_token: input.encrypted_callback_token,
            encrypted_encoding_aes_key: input.encrypted_encoding_aes_key,
            callback_enabled: 1, version: 1, app_enabled: 1
        };
        return { code: input.code };
    });
    // 多应用（P0-04/P0-05）：草稿回调原子事务 mock。
    replaceForTest(t, Database.prototype, 'createDraftCallbackAtomic', async function createDraftCallbackAtomic(input) {
        // 模拟事务内检查同 corpid 未完成草稿。
        const existing = Object.values(cfgByCode).find(r =>
            r.corpid === input.corpid && (!r.encrypted_corpsecret)
            && Number(r.agentid) === 0 && isTouserEmpty(r.touser));
        if (existing) {
            const e = new Error('draft exists');
            e.__draftCreateCause = 'exists';
            e.__existingCode = existing.code;
            throw e;
        }
        const list = drafts[input.corpid] || [];
        if (list.length) {
            const e = new Error('draft exists');
            e.__draftCreateCause = 'exists';
            e.__existingCode = list[list.length - 1].code;
            throw e;
        }
        calls.saveCallback.push({ ...input });
        cfgByCode[input.code] = {
            code: input.code, corpid: input.corpid,
            encrypted_corpsecret: '', agentid: 0, touser: '', description: '',
            encrypted_callback_token: input.encrypted_callback_token,
            encrypted_encoding_aes_key: input.encrypted_encoding_aes_key,
            callback_enabled: 1, version: 1, app_enabled: 1
        };
        return { code: input.code };
    });
    // 多应用（P0-04/P0-05）：完成草稿原子事务 mock。
    replaceForTest(t, Database.prototype, 'completeConfigurationAtomic', async function completeConfigurationAtomic(code, fields, expectedVersion, opts = {}) {
        const row = cfgByCode[code];
        if (!row) {
            const e = new Error('missing'); e.__completeCause = 'missing'; throw e;
        }
        const hasSecret = row.encrypted_corpsecret && row.encrypted_corpsecret.length > 0;
        if (hasSecret) {
            const e = new Error('already completed'); e.__completeCause = 'already_completed'; throw e;
        }
        if (expectedVersion !== undefined && expectedVersion !== null && Number(row.version) !== Number(expectedVersion)) {
            const e = new Error('version conflict'); e.__completeCause = 'version_conflict';
            e.__currentVersion = Number(row.version); throw e;
        }
        // 事务内身份判重（排除自身）。
        const numericAgentid = (opts && opts.numericAgentid) || fields.agentid;
        const conflict = Object.values(cfgByCode).find(r =>
            r.code !== code && r.corpid === row.corpid && Number(r.agentid) === Number(numericAgentid)
            && r.encrypted_corpsecret);
        if (!conflict) {
            const hit = completedByIdentity[`${row.corpid}|${numericAgentid}`];
            if (hit && (!hit.code || hit.code !== code)) {
                const e = new Error('identity conflict');
                e.__completeCause = 'identity_conflict';
                e.__existingCode = hit.code;
                throw e;
            }
        } else {
            const e = new Error('identity conflict');
            e.__completeCause = 'identity_conflict';
            e.__existingCode = conflict.code;
            throw e;
        }
        Object.assign(row, fields);
        row.version = (Number(row.version) || 1) + 1;
        return { code, version: row.version };
    });
    replaceForTest(t, Database.prototype, 'createConfigurationAtomic', async function createConfigurationAtomic(input) {
        const existing = Object.values(cfgByCode).find(r =>
            r.corpid === input.corpid && Number(r.agentid) === Number(input.agentid) && r.encrypted_corpsecret);
        if (existing) {
            const e = new Error('identity conflict');
            e.__createCause = 'identity_conflict';
            e.__existingCode = existing.code;
            throw e;
        }
        cfgByCode[input.code] = { ...input, version: 1, app_enabled: 1 };
        return { code: input.code };
    });
    // 旧 completeConfiguration（阶段1已停止使用，保留兼容以观测未被调用）。
    replaceForTest(t, Database.prototype, 'completeConfiguration', async function completeConfiguration(input) {
        calls.completed.push({ ...input });
        return { code: input.code };
    });
    replaceForTest(t, Database.prototype, 'getConfigurationByFields', async function getConfigurationByFields(corpid, agentid, touser) {
        // 旧三元判重（保留兼容，但阶段1身份判重改用新方法）。
        const hit = Object.values(cfgByCode).find(r => r.corpid === corpid && r.agentid === agentid && r.touser === touser);
        return hit ? { ...hit } : null;
    });
    // 新增：按 (corpid, agentid) 身份判重（阶段1落地）。排除 excludeCode。
    replaceForTest(t, Database.prototype, 'findCompletedByCorpidAgentId', async function findCompletedByCorpidAgentId(corpid, agentid, excludeCode) {
        const fromStore = Object.values(cfgByCode).find(r =>
            r.corpid === corpid && Number(r.agentid) === Number(agentid)
            && r.encrypted_corpsecret && (!excludeCode || r.code !== excludeCode));
        if (fromStore) return { ...fromStore };
        const hit = completedByIdentity[`${corpid}|${agentid}`];
        return hit && (!excludeCode || hit.code !== excludeCode) ? { ...hit } : null;
    });
    replaceForTest(t, Database.prototype, 'listConfigurations', async function listConfigurations() {
        return Object.values(cfgByCode).map(r => ({ ...r }));
    });
    replaceForTest(t, Database.prototype, 'listNotificationRules', async function listNotificationRules(configCode) {
        return (rulesByConfigCode[configCode] || []).map(r => ({ ...r }));
    });
    replaceForTest(t, Database.prototype, 'countRulesByConfigCodes', async function countRulesByConfigCodes(codes) {
        const map = {};
        for (const code of codes) {
            const list = rulesByConfigCode[code] || [];
            map[code] = {
                rule_count: list.length,
                enabled_rule_count: list.filter(r => r.enabled === 1 || r.enabled === true).length
            };
        }
        return map;
    });
    // touched-field 更新 + 乐观锁：真实修改 cfgByCode 并递增版本。
    replaceForTest(t, Database.prototype, 'updateConfigurationFields', async function updateConfigurationFields(code, fields, expectedVersion) {
        const row = cfgByCode[code];
        if (!row) return { code, changes: 0, version: null };
        if (expectedVersion !== undefined && expectedVersion !== null && Number(row.version) !== Number(expectedVersion)) {
            return { code, changes: 0, version: Number(row.version) };
        }
        for (const [k, v] of Object.entries(fields)) row[k] = v;
        row.version = (Number(row.version) || 1) + 1;
        return { code, changes: 1, version: row.version };
    });
    // 多应用（R-P0-01）：编辑应用的原子身份事务桩，CAS + 身份判重 + 递增版本。
    replaceForTest(t, Database.prototype, 'updateConfigurationAtomic', async function updateConfigurationAtomic(code, fields, expectedVersion, opts = {}) {
        const row = cfgByCode[code];
        if (!row) {
            const e = new Error('missing'); e.__updateCause = 'missing'; throw e;
        }
        if (expectedVersion !== undefined && expectedVersion !== null && Number(row.version) !== Number(expectedVersion)) {
            const e = new Error('version_conflict'); e.__updateCause = 'version_conflict';
            e.__currentVersion = Number(row.version); throw e;
        }
        // 身份判重（事务内）：若目标 AgentID 与其他完成应用冲突。
        if (opts && opts.checkIdentity && opts.targetAgentid) {
            const conflict = Object.values(cfgByCode).find(r =>
                r.code !== code && r.corpid === row.corpid
                && Number(r.agentid) === Number(opts.targetAgentid)
                && r.encrypted_corpsecret);
            if (conflict) {
                const e = new Error('identity_conflict'); e.__updateCause = 'identity_conflict';
                e.__existingCode = conflict.code; throw e;
            }
        }
        for (const [k, v] of Object.entries(fields)) row[k] = v;
        row.version = (Number(row.version) || 1) + 1;
        return { code, version: row.version };
    });
    replaceForTest(t, Database.prototype, 'runRaw', async function runRaw() {
        return { lastID: 1, changes: 1 };
    });

    replaceForTest(t, CryptoService.prototype, 'decrypt', function decrypt(v) { return String(v).replace(/^enc-/, ''); });
    replaceForTest(t, CryptoService.prototype, 'encrypt', function encrypt(v) { return `enc-${v}`; });

    replaceForTest(t, WeChatService.prototype, 'getToken', async function getToken(corpid, corpsecret) {
        calls.validateToken.push({ corpid, corpsecret });
        return 'access-token';
    });
    replaceForTest(t, WeChatService.prototype, 'getAgentInfo', async function getAgentInfo(token, agentid) {
        return { agentid, name: '应用' };
    });
    replaceForTest(t, WeChatService.prototype, 'getAgentVisibleUsers', async function getAgentVisibleUsers() {
        return [{ userid: 'alice', name: 'Alice' }];
    });
    replaceForTest(t, WeChatService.prototype, 'invalidateToken', async function invalidateToken() {});

    clearModule('../src/services/notifier');
    t.after(() => {
        clearModule('../src/services/notifier');
        clearModule('../src/api/routes');
    });
    const notifier = require('../src/services/notifier');
    return { notifier, calls };
}

// ─── 草稿隔离 ────────────────────────────────────────────────────────────

test('createCallbackConfiguration 不复用同企业已完成应用（草稿隔离）', async t => {
    // 现状：corp-1 已有一个完成的应用 app-a。再次为 corp-1 生成回调必须新建独立草稿，
    // 而不是把 app-a 当作已存在回调配置返回。
    const { notifier, calls } = setupNotifier(t, {
        store: { configs: { 'app-a': completedConfig({ id: 1 }) } }
    });

    const result = await notifier.createCallbackConfiguration({
        corpid: 'corp-1',
        callback_token: 'new-token',
        encoding_aes_key: 'A'.repeat(43)
    });

    // 必须新建，返回全新 code（不能是 app-a）。
    assert.notEqual(result.code, 'app-a');
    assert.ok(result.callbackUrl.endsWith(result.code));
    assert.equal(calls.saveCallback.length, 1);
    assert.equal(calls.saveCallback[0].corpid, 'corp-1');
});

test('同企业已有草稿时再次生成回调返回 APP_DRAFT_EXISTS 与 existing_code', async t => {
    const draft = draftConfig({ id: 2, corpid: 'corp-1', code: 'draft-1' });
    const { notifier } = setupNotifier(t, {
        store: { drafts: { 'corp-1': [draft] } }
    });

    let caught = null;
    try {
        await notifier.createCallbackConfiguration({
            corpid: 'corp-1',
            callback_token: 'another-token',
            encoding_aes_key: 'A'.repeat(43)
        });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught, '应抛出冲突错误');
    assert.equal(caught.statusCode, 409);
    assert.equal(caught.businessCode, 'APP_DRAFT_EXISTS');
    assert.equal(caught.details && caught.details.existing_code, 'draft-1');
});

// ─── 完成配置保护 ────────────────────────────────────────────────────────

test('completeConfiguration 拒绝覆盖已完成应用（APP_ALREADY_COMPLETED）', async t => {
    // app-a 已完成；再次调用 completeConfiguration('app-a', ...) 必须拒绝。
    const { notifier } = setupNotifier(t, {
        store: { configs: { 'app-a': completedConfig({ id: 1 }) } }
    });

    let caught = null;
    try {
        await notifier.completeConfiguration({
            code: 'app-a',
            corpsecret: 'leaked-secret',
            agentid: 999999,
            touser: ['attacker']
        });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught, '已完成应用不应被再次完成');
    assert.equal(caught.statusCode, 409);
    assert.equal(caught.businessCode, 'APP_ALREADY_COMPLETED');
});

test('completeConfiguration 仅接受草稿并按 (corpid, agentid) 身份判重', async t => {
    // 已存在完成应用 app-a (corp-1, 100001)。
    // 草稿 draft-2 在 corp-1 下，但提交时 AgentID=100001 与 app-a 冲突 → APP_IDENTITY_CONFLICT。
    const { notifier } = setupNotifier(t, {
        store: {
            configs: {
                'app-a': completedConfig({ id: 1, agentid: 100001 }),
                'draft-2': draftConfig({ id: 2, code: 'draft-2', corpid: 'corp-1', version: 1 })
            },
            completedByIdentity: { 'corp-1|100001': completedConfig({ code: 'app-a' }) }
        }
    });

    let caught = null;
    try {
        await notifier.completeConfiguration({
            code: 'draft-2',
            corpsecret: 'secret-2',
            agentid: 100001,        // 与 app-a 冲突
            touser: ['alice'],
            version: 1
        });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught, '同身份冲突应拒绝');
    assert.equal(caught.statusCode, 409);
    assert.equal(caught.businessCode, 'APP_IDENTITY_CONFLICT');
    assert.equal(caught.details && caught.details.existing_code, 'app-a');
});

test('同 corpid 不同 AgentID 可各自完成并获得独立 code', async t => {
    // app-a 已完成 (corp-1, 100001)。draft-2 提交 AgentID=100002 应成功。
    const { notifier, calls } = setupNotifier(t, {
        store: {
            configs: {
                'app-a': completedConfig({ id: 1, agentid: 100001 }),
                'draft-2': draftConfig({ id: 2, code: 'draft-2', corpid: 'corp-1', version: 1 })
            }
            // 无 100002 身份冲突
        }
    });

    const result = await notifier.completeConfiguration({
        code: 'draft-2',
        corpsecret: 'secret-2',
        agentid: 100002,
        touser: ['bob'],
        version: 1
    });

    // 完成成功返回独立 code 与 active 生命周期。
    assert.equal(result.code, 'draft-2');
    assert.equal(result.lifecycle_status, 'active');
    assert.ok(result.version >= 2, '完成必须递增版本');
    // 凭证验证收口到 notifier 的 wechat 实例。
    assert.equal(calls.validateToken.length, 1);
    assert.equal(calls.validateToken[0].corpid, 'corp-1');
});

// ─── corpid 不可变 ───────────────────────────────────────────────────────

test('updateConfiguration 拒绝修改 corpid（CORPID_IMMUTABLE）', async t => {
    const { notifier } = setupNotifier(t, {
        store: { configs: { 'app-a': completedConfig({ id: 1 }) } }
    });

    let caught = null;
    try {
        await notifier.updateConfiguration('app-a', { corpid: 'corp-2', touser: ['alice'] });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught, 'corpid 不可通过编辑接口修改');
    assert.equal(caught.statusCode, 400);
    assert.equal(caught.businessCode, 'CORPID_IMMUTABLE');
});

// ─── 统一序列化：lifecycle / capabilities / warnings / version ──────────

test('listConfigurations 输出 lifecycle_status / capabilities / warnings / version', async t => {
    const { notifier } = setupNotifier(t, {
        store: {
            configs: {
                'app-a': completedConfig({ id: 1 }),
                'paused-b': completedConfig({ code: 'paused-b', id: 2, app_enabled: 0 }),
                'draft-3': draftConfig({ code: 'draft-3', id: 3 })
            },
            rulesByConfigCode: {
                'app-a': [{ id: 10, config_code: 'app-a', enabled: 1 }, { id: 11, config_code: 'app-a', enabled: 0 }]
            }
        }
    });

    const result = await notifier.listConfigurations();
    const byCode = Object.fromEntries(result.configurations.map(c => [c.code, c]));

    // 每行必须包含新字段。
    for (const row of result.configurations) {
        assert.ok(['draft', 'active', 'paused'].includes(row.lifecycle_status), `${row.code} lifecycle_status 缺失`);
        assert.ok(typeof row.capabilities === 'object', `${row.code} capabilities 缺失`);
        assert.ok(Array.isArray(row.warnings), `${row.code} warnings 缺失`);
        assert.ok(Number.isInteger(row.version) && row.version >= 1, `${row.code} version 缺失`);
    }

    assert.equal(byCode['app-a'].lifecycle_status, 'active');
    assert.equal(byCode['paused-b'].lifecycle_status, 'paused');
    assert.equal(byCode['draft-3'].lifecycle_status, 'draft');

    // 草稿不能管理规则/切换；active 可以。
    assert.equal(byCode['draft-3'].capabilities.can_manage_rules, false);
    assert.equal(byCode['draft-3'].capabilities.can_toggle, false);
    assert.equal(byCode['app-a'].capabilities.can_manage_rules, true);
    assert.equal(byCode['app-a'].capabilities.can_toggle, true);

    // 规则聚合数（避免 N+1，由序列化统一产出）。
    assert.equal(byCode['app-a'].rule_count, 2);
    assert.equal(byCode['app-a'].enabled_rule_count, 1);

    // 列表不得返回 CorpSecret、AESKey、通知密钥哈希或完整默认成员明文。
    assert.equal(byCode['app-a'].encrypted_corpsecret, undefined);
    assert.equal(byCode['app-a'].notify_key_hash, undefined);
    assert.equal(byCode['app-a'].encrypted_callback_token, undefined);
});

test('重复 (corpid, agentid) 历史应用标记 duplicate_identity 但不关闭能力', async t => {
    // 历史上 corp-1/100001 有两行（不应发生但可能），允许各自维护、暂停、删除。
    const dupA = completedConfig({ code: 'dup-a', id: 1, agentid: 100001, corpid: 'corp-1' });
    const dupB = completedConfig({ code: 'dup-b', id: 2, agentid: 100001, corpid: 'corp-1' });
    const { notifier } = setupNotifier(t, {
        store: {
            configs: { 'dup-a': dupA, 'dup-b': dupB },
            completedByIdentity: { 'corp-1|100001': dupA } // 仅示例：标记逻辑由序列化内部判定
        }
    });

    const result = await notifier.listConfigurations();
    const dupBRow = result.configurations.find(c => c.code === 'dup-b');

    assert.ok(dupBRow, '重复行应出现在列表');
    // 主状态仍是 active/paused，重复身份仅作为告警。
    assert.ok(['active', 'paused'].includes(dupBRow.lifecycle_status));
    assert.ok(dupBRow.warnings.includes('duplicate_identity'), '重复身份应进入 warnings');
    assert.equal(dupBRow.capabilities.can_pause, true);
    assert.equal(dupBRow.capabilities.can_delete, true);
    assert.equal(dupBRow.capabilities.can_edit, true);
});

// ─── 应用总开关 ──────────────────────────────────────────────────────────

test('setAppEnabled 切换总开关并返回新版本，草稿拒绝切换', async t => {
    const { notifier } = setupNotifier(t, {
        store: { configs: { 'app-a': completedConfig({ id: 1, version: 3 }) } }
    });

    const result = await notifier.setAppEnabled('app-a', false, { expectedVersion: 3 });

    assert.equal(result.app_enabled, false);
    assert.ok(result.version > 3, '总开关切换必须递增应用版本');
});

test('setAppEnabled 草稿切换返回 APP_NOT_COMPLETED', async t => {
    const { notifier } = setupNotifier(t, {
        store: { configs: { 'draft-3': draftConfig({ code: 'draft-3', id: 3 }) } }
    });

    let caught = null;
    try {
        await notifier.setAppEnabled('draft-3', false, { expectedVersion: 1 });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught);
    assert.equal(caught.statusCode, 409);
    assert.equal(caught.businessCode, 'APP_NOT_COMPLETED');
});

test('setAppEnabled 拒绝非严格布尔值（数字 2）', async t => {
    const { notifier } = setupNotifier(t, {
        store: { configs: { 'app-a': completedConfig({ id: 1 }) } }
    });

    let caught = null;
    try {
        // toStrictBoolean 接受 "true"/"false"/1/0；数字 2 必须被拒绝。
        await notifier.setAppEnabled('app-a', 2, { expectedVersion: 1 });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught);
    assert.equal(caught.statusCode, 400);
    assert.equal(caught.businessCode, 'INVALID_INPUT');
});

// ─── 版本乐观锁 ──────────────────────────────────────────────────────────

test('updateConfiguration 缺少 expectedVersion 返回 APP_VERSION_REQUIRED', async t => {
    const { notifier } = setupNotifier(t, {
        store: { configs: { 'app-a': completedConfig({ id: 1, version: 3 }) } }
    });

    let caught = null;
    try {
        await notifier.updateConfiguration('app-a', { description: 'new' });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught);
    assert.equal(caught.statusCode, 428);
    assert.equal(caught.businessCode, 'APP_VERSION_REQUIRED');
});

test('updateConfiguration 版本不匹配返回 APP_VERSION_CONFLICT', async t => {
    const { notifier } = setupNotifier(t, {
        store: { configs: { 'app-a': completedConfig({ id: 1, version: 5 }) } }
    });

    let caught = null;
    try {
        await notifier.updateConfiguration('app-a', { description: 'new' }, { expectedVersion: 3 });
    } catch (err) {
        caught = err;
    }

    assert.ok(caught);
    assert.equal(caught.statusCode, 409);
    assert.equal(caught.businessCode, 'APP_VERSION_CONFLICT');
});

test('updateConfiguration 成功后返回新版本（不得由前端猜测递增）', async t => {
    const { notifier } = setupNotifier(t, {
        store: { configs: { 'app-a': completedConfig({ id: 1, version: 5 }) } }
    });

    const result = await notifier.updateConfiguration('app-a', { description: 'new' }, { expectedVersion: 5 });

    assert.ok(result.version > 5, '成功更新必须返回服务端递增后的新版本');
});
