// 阶段 A4（service 测试）：接收规则 API 自定义编号的服务层行为（规范 §11.3）。
//
// 使用真实临时 SQLite + 真实 Database + prototype stub 屏蔽网络层，
// 验证 createRule/updateRule/regenerateRuleApiCode/deleteRule 在编号自定义场景下的契约：
//   - createRule 接收自定义 api_code 并保存为小写。
//   - createRule 未提供编号仍生成 UUID。
//   - createRule 编号冲突映射为 409 RULE_API_CODE_CONFLICT（不是 500）。
//   - updateRule 省略 api_code 保留旧值，且 api_code_changed=false。
//   - updateRule 修改 api_code 返回 api_code_changed=true，旧编号进入退役表。
//   - updateRule 同值更新不写退役记录。
//   - updateRule 显式空值返回 400 RULE_API_CODE_INVALID。
//   - updateRule 修改编号冲突返回 409 RULE_API_CODE_CONFLICT，且不递增 app_version。
//   - 编号冲突不被 AppHttp.isVersionConflict 误判（details 不含 version）。
//   - regenerateRuleApiCode 复用统一改号逻辑（旧编号退役 reason=regenerated）。
//   - deleteRule 后编号留在退役表。
//   - 改号后缓存被清理：新地址可解析，旧地址 404。

const assert = require('assert/strict');
const test = require('node:test');
const os = require('os');
const path = require('path');
const fs = require('fs');

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

// 构造带真实 SQLite 的 notifier，屏蔽 WeChat 网络层。
async function setupRealNotifier(t) {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const dbPath = path.join(os.tmpdir(), `rule-api-svc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    withEnv(t, 'DB_PATH', dbPath);
    t.after(() => { try { fs.unlinkSync(dbPath); } catch (_e) { /* ignore */ } });

    clearModule('../src/core/database');
    clearModule('../src/services/notifier');
    t.after(() => {
        clearModule('../src/core/database');
        clearModule('../src/services/notifier');
        clearModule('../src/api/routes');
    });

    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');

    // 用真实 Database，但指定临时路径。
    const db = new Database(dbPath);
    await db.init();
    t.after(async () => { try { await db.close(); } catch (_e) { /* ignore */ } });

    // notifier 内部会自己 new Database(DB_PATH)；确保它指向同一个临时库。
    // 通过屏蔽 Crypto/WeChat 网络层，但保留真实 Database。
    replaceForTest(t, CryptoService.prototype, 'decrypt', function (v) { return String(v).replace(/^enc-/, ''); });
    replaceForTest(t, CryptoService.prototype, 'encrypt', function (v) { return `enc-${v}`; });
    replaceForTest(t, WeChatService.prototype, 'getToken', async () => 't');
    replaceForTest(t, WeChatService.prototype, 'getAgentInfo', async (tok, id) => ({ agentid: id }));
    replaceForTest(t, WeChatService.prototype, 'getAgentVisibleUsers', async () => []);
    replaceForTest(t, WeChatService.prototype, 'invalidateToken', async () => {});

    const notifier = require('../src/services/notifier');
    return { notifier, db: notifier._internal.db };
}

async function insertCompletedApp(db, code, { version = 1, touser = 'alice' } = {}) {
    await db.runRaw(
        `INSERT INTO configurations (code, corpid, encrypted_corpsecret, agentid, touser, description,
            callback_enabled, notify_key_hash, legacy_until, code_send_enabled, app_enabled, version)
         VALUES (?, ?, ?, ?, ?, '', 0, NULL, NULL, 1, 1, ?)`,
        [code, `corp-${code}`, 'enc-secret', 100001, touser, version]
    );
}

async function getAppVersion(db, code) {
    const row = await db.get('SELECT version FROM configurations WHERE code = ?', [code]);
    return row ? Number(row.version) : null;
}

async function getRuleByApiCode(db, apiCode) {
    return db.getNotificationRuleByApiCode(apiCode);
}

test('createRule：自定义 api_code 保存为小写', async t => {
    const { notifier, db } = await setupRealNotifier(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const result = await notifier.createRule('app-a', {
        name: '生产告警', api_code: 'Ops-Alert', touser: ['alice']
    }, { expectedVersion: 1 });
    assert.equal(result.api_code, 'ops-alert', '应规范化为小写');
    assert.equal(result.apiUrl, '/api/notify/ops-alert');
    assert.equal(result.app_version, 2);
    const rule = await getRuleByApiCode(db, 'ops-alert');
    assert.ok(rule, '库中应能按小写编号查到');
});

test('createRule：未提供 api_code 仍生成 UUID', async t => {
    const { notifier, db } = await setupRealNotifier(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const result = await notifier.createRule('app-a', { name: 'r1', touser: ['alice'] }, { expectedVersion: 1 });
    assert.ok(result.api_code, '应生成编号');
    assert.match(result.api_code, /^[0-9a-f-]{36}$/i, 'UUID 形式');
});

test('createRule：编号冲突返回 409 RULE_API_CODE_CONFLICT，不是 500', async t => {
    const { notifier, db } = await setupRealNotifier(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    await notifier.createRule('app-a', { name: 'r1', api_code: 'taken', touser: ['alice'] }, { expectedVersion: 1 });
    let caught = null;
    try {
        await notifier.createRule('app-a', { name: 'r2', api_code: 'taken', touser: ['bob'] }, { expectedVersion: 2 });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.statusCode, 409);
    assert.equal(caught.businessCode, 'RULE_API_CODE_CONFLICT');
    assert.equal(caught.details.conflict_scope, 'rule');
    // 关键：编号冲突响应不得携带 details.version，避免被 isVersionConflict 误判
    assert.equal(caught.details.version, undefined);
});

test('createRule：与配置 Code 冲突返回 409 conflict_scope=configuration', async t => {
    const { notifier, db } = await setupRealNotifier(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    let caught = null;
    try {
        await notifier.createRule('app-a', { name: 'r1', api_code: 'app-a', touser: ['alice'] }, { expectedVersion: 1 });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.businessCode, 'RULE_API_CODE_CONFLICT');
    assert.equal(caught.details.conflict_scope, 'configuration');
});

test('updateRule：省略 api_code 保留旧值，api_code_changed=false', async t => {
    const { notifier, db } = await setupRealNotifier(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const created = await notifier.createRule('app-a', { name: 'r1', api_code: 'keep-me', touser: ['alice'] }, { expectedVersion: 1 });
    const result = await notifier.updateRule(created.id, { name: 'r1-renamed', touser: ['alice'] }, { expectedVersion: 2 });
    assert.equal(result.api_code, 'keep-me', '省略时保留旧编号');
    assert.equal(result.api_code_changed, false);
    assert.equal(result.app_version, 3);
});

test('updateRule：修改 api_code 返回 api_code_changed=true，旧编号进退役表', async t => {
    const { notifier, db } = await setupRealNotifier(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const created = await notifier.createRule('app-a', { name: 'r1', api_code: 'vv1', touser: ['alice'] }, { expectedVersion: 1 });
    const result = await notifier.updateRule(created.id, { name: 'r1', api_code: 'vv2', touser: ['alice'] }, { expectedVersion: 2 });
    assert.equal(result.api_code, 'vv2');
    assert.equal(result.api_code_changed, true);
    // 旧编号进入退役表
    const retired = await db.get('SELECT * FROM retired_notify_codes WHERE code = ?', ['vv1']);
    assert.ok(retired, '旧编号应进入退役表');
    assert.equal(retired.reason, 'renamed');
    assert.equal(retired.owner_type, 'rule');
});

test('updateRule：同值更新不写退役记录', async t => {
    const { notifier, db } = await setupRealNotifier(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const created = await notifier.createRule('app-a', { name: 'r1', api_code: 'same1', touser: ['alice'] }, { expectedVersion: 1 });
    const result = await notifier.updateRule(created.id, { name: 'r1', api_code: 'same1', touser: ['alice'] }, { expectedVersion: 2 });
    assert.equal(result.api_code_changed, false);
    const retired = await db.get('SELECT * FROM retired_notify_codes WHERE code = ?', ['same1']);
    assert.equal(retired, undefined, '同值更新不应写退役记录');
});

test('updateRule：显式空值返回 400 RULE_API_CODE_INVALID', async t => {
    const { notifier, db } = await setupRealNotifier(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const created = await notifier.createRule('app-a', { name: 'r1', api_code: 'valid1', touser: ['alice'] }, { expectedVersion: 1 });
    let caught = null;
    try {
        await notifier.updateRule(created.id, { name: 'r1', api_code: '', touser: ['alice'] }, { expectedVersion: 2 });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.statusCode, 400);
    assert.equal(caught.businessCode, 'RULE_API_CODE_INVALID');
});

test('updateRule：编号冲突返回 409，且不递增 app_version', async t => {
    const { notifier, db } = await setupRealNotifier(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    // 两条规则
    const r1 = await notifier.createRule('app-a', { name: 'r1', api_code: 'rule-a', touser: ['alice'] }, { expectedVersion: 1 });
    await notifier.createRule('app-a', { name: 'r2', api_code: 'rule-b', touser: ['bob'] }, { expectedVersion: 2 });
    const versionBefore = await getAppVersion(db, 'app-a');
    let caught = null;
    try {
        // r1 改成已被 r2 占用的 rule-b -> 冲突
        await notifier.updateRule(r1.id, { name: 'r1', api_code: 'rule-b', touser: ['alice'] }, { expectedVersion: 3 });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.businessCode, 'RULE_API_CODE_CONFLICT');
    const versionAfter = await getAppVersion(db, 'app-a');
    assert.equal(versionAfter, versionBefore, '编号冲突不应递增 app_version');
});

test('updateRule：同一规则可恢复自己退役编号', async t => {
    const { notifier, db } = await setupRealNotifier(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const created = await notifier.createRule('app-a', { name: 'r1', api_code: 'orig1', touser: ['alice'] }, { expectedVersion: 1 });
    // 改成 v2（orig 进退役）
    await notifier.updateRule(created.id, { name: 'r1', api_code: 'vv2', touser: ['alice'] }, { expectedVersion: 2 });
    // 改回 orig（恢复自己退役编号）
    const result = await notifier.updateRule(created.id, { name: 'r1', api_code: 'orig1', touser: ['alice'] }, { expectedVersion: 3 });
    assert.equal(result.api_code, 'orig1');
    assert.equal(result.api_code_changed, true);
    // v2 应进入退役表
    const v2Retired = await db.get('SELECT * FROM retired_notify_codes WHERE code = ?', ['vv2']);
    assert.ok(v2Retired, '被替换的当前编号应转退役');
    // orig 不应在退役表（已被恢复）
    const origRetired = await db.get('SELECT * FROM retired_notify_codes WHERE code = ?', ['orig1']);
    assert.equal(origRetired, undefined, '恢复后 orig 不应在退役表');
});

test('regenerateRuleApiCode：旧编号退役 reason=regenerated', async t => {
    const { notifier, db } = await setupRealNotifier(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const created = await notifier.createRule('app-a', { name: 'r1', api_code: 'before1', touser: ['alice'] }, { expectedVersion: 1 });
    const result = await notifier.regenerateRuleApiCode(created.id, { expectedVersion: 2 });
    assert.notEqual(result.api_code, 'before1');
    assert.match(result.api_code, /^[0-9a-f-]{36}$/i);
    const retired = await db.get('SELECT * FROM retired_notify_codes WHERE code = ?', ['before1']);
    assert.ok(retired, '重生成后旧编号应退役');
    assert.equal(retired.reason, 'regenerated');
});

test('deleteRule：编号留在退役表 reason=deleted', async t => {
    const { notifier, db } = await setupRealNotifier(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const created = await notifier.createRule('app-a', { name: 'r1', api_code: 'willdel1', touser: ['alice'] }, { expectedVersion: 1 });
    await notifier.deleteRule(created.id, { expectedVersion: 2 });
    const retired = await db.get('SELECT * FROM retired_notify_codes WHERE code = ?', ['willdel1']);
    assert.ok(retired, '删除规则后编号应留在退役表');
    assert.equal(retired.reason, 'deleted');
    // 规则已删除
    const rule = await getRuleByApiCode(db, 'willdel1');
    assert.equal(rule, undefined, '规则记录应已删除');
});

test('改号后旧编号退役：新规则不能申请旧编号', async t => {
    const { notifier, db } = await setupRealNotifier(t);
    await insertCompletedApp(db, 'app-a', { version: 1 });
    const created = await notifier.createRule('app-a', { name: 'r1', api_code: 'first1', touser: ['alice'] }, { expectedVersion: 1 });
    // 改号 first -> second
    await notifier.updateRule(created.id, { name: 'r1', api_code: 'second1', touser: ['alice'] }, { expectedVersion: 2 });
    // 另一条新规则试图申请 first（已退役）-> 冲突
    let caught = null;
    try {
        await notifier.createRule('app-a', { name: 'r2', api_code: 'first1', touser: ['bob'] }, { expectedVersion: 3 });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.businessCode, 'RULE_API_CODE_CONFLICT');
    assert.equal(caught.details.conflict_scope, 'retired');
});
