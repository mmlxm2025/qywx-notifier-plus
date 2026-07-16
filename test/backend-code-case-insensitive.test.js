// 配置 code 读写大小写一致：GET 已 lower()，写路径/规则归属也必须 lower()。
// 历史 bug：getConfigurationByCode 不敏感，但 delete/listRules/atomic update 用精确匹配，
// 混大小写请求会出现「能读不能删 / 规则列表为空」。

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

function withEnv(t, key, value) {
    const had = Object.prototype.hasOwnProperty.call(process.env, key);
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => {
        if (had) process.env[key] = original;
        else delete process.env[key];
    });
}

function clearModule(p) {
    delete require.cache[require.resolve(p)];
}

async function setupRealDb(t) {
    withEnv(t, 'NODE_ENV', 'test');
    withEnv(t, 'SKIP_RUNTIME_VALIDATION', '1');
    withEnv(t, 'ENCRYPTION_KEY', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    withEnv(t, 'ADMIN_USERNAME', 'admin');
    withEnv(t, 'ADMIN_PASSWORD', 'TestPassword123!');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qywx-case-'));
    withEnv(t, 'DB_PATH', path.join(tmp, 't.db'));
    t.after(() => {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    });

    clearModule('../src/core/crypto-instance');
    clearModule('../src/core/database');
    clearModule('../src/services/notifier');

    const CryptoService = require('../src/core/crypto');
    const cs = new CryptoService(Buffer.from(process.env.ENCRYPTION_KEY, 'hex'));
    const Database = require('../src/core/database');
    const db = new Database(process.env.DB_PATH);
    await db.init();
    const enc = cs.encrypt('secret-value-for-case-test');
    await db.runRaw(
        `INSERT INTO configurations (
            code, corpid, encrypted_corpsecret, agentid, touser, description,
            callback_enabled, version, app_enabled, code_send_enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['App-Case-A', 'corp-case', enc, 100001, 'alice', 'case', 0, 3, 1, 1]
    );
    await db.runRaw(
        `INSERT INTO notification_rules (
            config_code, api_code, name, touser, toparty, totag, is_all, estimated_count, enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['App-Case-A', 'rule-case-1', 'R1', 'alice', '', '', 0, 1, 1]
    );
    await db.close();

    clearModule('../src/services/notifier');
    const notifier = require('../src/services/notifier');
    await notifier.ensureDbReady();
    t.after(async () => {
        try { await notifier._internal.db.close(); } catch (_e) { /* ignore */ }
        clearModule('../src/services/notifier');
    });
    return notifier;
}

test('混大小写 GET 配置与规则列表均命中权威 code', async t => {
    const notifier = await setupRealDb(t);
    const cfg = await notifier.getConfiguration('app-case-a');
    assert.ok(cfg);
    assert.equal(cfg.code, 'App-Case-A');

    const listed = await notifier.listRules('APP-CASE-A');
    assert.ok(listed.rules);
    assert.equal(listed.rules.length, 1);
    assert.equal(listed.rules[0].api_code, 'rule-case-1');
});

test('混大小写 deleteConfiguration 成功级联删除', async t => {
    const notifier = await setupRealDb(t);
    const result = await notifier.deleteConfiguration('APP-CASE-A', 3);
    assert.equal(result.configurations_deleted, 1);
    assert.equal(result.rules_deleted, 1);
    const gone = await notifier.getConfiguration('App-Case-A');
    assert.equal(gone, null);
});

test('混大小写 updateConfigurationAtomic 可更新', async t => {
    const notifier = await setupRealDb(t);
    const res = await notifier.updateConfiguration(
        'app-case-a',
        { description: 'updated-by-mixed-case' },
        { expectedVersion: 3 }
    );
    assert.equal(res.version, 4);
    const cfg = await notifier.getConfiguration('APP-CASE-A');
    assert.equal(cfg.description, 'updated-by-mixed-case');
    assert.equal(cfg.code, 'App-Case-A');
});
