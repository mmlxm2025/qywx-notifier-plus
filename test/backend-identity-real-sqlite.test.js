// 阶段 F（真实 SQLite 回归）：身份不变量在真实数据库上的并发原子性（P0-05）。
//
// 指南 §5.4 / 阶段 D 验收要求：并发测试循环执行不少于 20 次，始终只有一个应用身份成功；
// 且不允许全部由 prototype stub 代替。本文件用真实临时 SQLite 文件 + 真实 DAO 事务方法验证。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-code-review-fix-guide.md §3.4 / §5.4。

const assert = require('assert/strict');
const test = require('node:test');
const os = require('os');
const path = require('path');
const fs = require('fs');

function createIsolatedDatabase(t) {
    delete require.cache[require.resolve('../src/core/database')];
    const Database = require('../src/core/database');
    const dbPath = path.join(os.tmpdir(), `identity-real-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = new Database(dbPath);
    t.after(async () => {
        try { await db.close(); } catch (_e) { /* ignore */ }
        try { fs.unlinkSync(dbPath); } catch (_e) { /* ignore */ }
    });
    return db;
}

test('P0-05 真实 SQLite: createConfigurationAtomic 并发同身份只能一个成功', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();

    const corpid = 'corp-real-1';
    const agentid = 200001;
    const encrypted = 'enc-secret';

    let successes = 0;
    let conflicts = 0;
    // 并发 20 次（指南 §阶段 D 验收门槛）。
    for (let i = 0; i < 20; i++) {
        const results = await Promise.allSettled([0, 1, 2].map(j =>
            db.createConfigurationAtomic({
                code: `app-${i}-${j}`,
                corpid,
                encrypted_corpsecret: encrypted,
                agentid,
                touser: `user-${j}`,
                description: '',
                encrypted_callback_token: null,
                encrypted_encoding_aes_key: null,
                callback_enabled: 0,
                notify_key_hash: null,
                legacy_until: null
            })
        ));
        for (const r of results) {
            if (r.status === 'fulfilled') successes++;
            else if (r.reason && r.reason.__createCause === 'identity_conflict') conflicts++;
        }
    }

    assert.equal(successes, 1, '20 轮并发中只能恰好一个应用身份创建成功');
    assert.ok(conflicts >= 1, '其余应被识别为身份冲突');

    // 验证最终表里同 (corpid, agentid) 只有一行完成应用。
    const rows = await db.allRaw(
        'SELECT code, touser FROM configurations WHERE corpid = ? AND agentid = ? AND encrypted_corpsecret != ?',
        [corpid, agentid, '']
    );
    assert.equal(rows.length, 1, '真实库中同 (corpid, agentid) 只能有一行');
});

test('P0-05 真实 SQLite: completeConfigurationAtomic 并发完成同一草稿只能一个成功', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    // 先建一个草稿。
    await db.runRaw(
        `INSERT INTO configurations (code, corpid, encrypted_corpsecret, agentid, touser, description, callback_enabled, version)
         VALUES (?, ?, '', 0, '', '', 0, 1)`,
        ['draft-real', 'corp-real-2']
    );

    let successes = 0;
    let failures = 0;
    for (let i = 0; i < 20; i++) {
        const results = await Promise.allSettled([0, 1].map(() =>
            db.completeConfigurationAtomic(
                'draft-real',
                {
                    encrypted_corpsecret: 'enc-sec',
                    agentid: 300001,
                    touser: 'alice',
                    description: 'done',
                    notify_key_hash: null,
                    legacy_until: null
                },
                1,
                { numericAgentid: 300001 }
            )
        ));
        for (const r of results) {
            if (r.status === 'fulfilled') successes++;
            else failures++;
        }
    }
    assert.equal(successes, 1, '并发完成只能一个成功');
    assert.ok(failures >= 1, '其余必须失败（版本冲突或已完成）');

    // 验证最终状态：草稿已完成，version=2。
    const row = await db.get('SELECT version, encrypted_corpsecret FROM configurations WHERE code = ?', ['draft-real']);
    assert.equal(Number(row.version), 2);
    assert.ok(row.encrypted_corpsecret.length > 0);
});

test('P0-03 真实 SQLite: mutateRuleWithAppVersion 原子性——规则失败时应用版本不变', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    // 建一个完成应用 + 一条规则。
    await db.runRaw(
        `INSERT INTO configurations (code, corpid, encrypted_corpsecret, agentid, touser, description, callback_enabled, version)
         VALUES (?, ?, ?, ?, ?, '', 0, 1)`,
        ['app-real', 'corp-3', 'enc-sec', 400001, 'alice']
    );
    await db.runRaw(
        `INSERT INTO notification_rules (config_code, api_code, name, touser, enabled, estimated_count)
         VALUES (?, ?, ?, ?, 1, 1)`,
        ['app-real', 'rule-real-1', '规则A', 'alice']
    );
    const ruleId = (await db.get('SELECT id FROM notification_rules WHERE api_code = ?', ['rule-real-1'])).id;

    // 正常更新：版本递增。
    const result = await db.mutateRuleWithAppVersion(
        { ruleId },
        1,
        async (tx, app) => {
            await tx.run('UPDATE notification_rules SET name = ? WHERE id = ?', ['规则A改', ruleId]);
            return { id: ruleId };
        }
    );
    assert.equal(result.app_version, 2, '成功后应用版本应 +1');
    const rule = await db.get('SELECT name FROM notification_rules WHERE id = ?', [ruleId]);
    assert.equal(rule.name, '规则A改');

    // mutation 抛错 → 应用版本不变（事务回滚）。
    let caught = null;
    try {
        await db.mutateRuleWithAppVersion(
            { ruleId },
            2,
            async () => { throw Object.assign(new Error('rule missing'), { __ruleCause: 'rule_missing' }); }
        );
    } catch (err) { caught = err; }
    assert.ok(caught);
    const app = await db.get('SELECT version FROM configurations WHERE code = ?', ['app-real']);
    assert.equal(Number(app.version), 2, 'mutation 失败时应用版本不变');
});

test('P0-05 真实 SQLite: completeConfigurationAtomic 版本冲突时草稿字段不变', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await db.runRaw(
        `INSERT INTO configurations (code, corpid, encrypted_corpsecret, agentid, touser, description, callback_enabled, version)
         VALUES (?, ?, '', 0, '', '', 0, 5)`,
        ['draft-v5', 'corp-v']
    );

    let caught = null;
    try {
        await db.completeConfigurationAtomic(
            'draft-v5',
            { encrypted_corpsecret: 'enc-new', agentid: 500001, touser: 'bob', description: 'x', notify_key_hash: null, legacy_until: null },
            1,  // 错误版本（实际是 5）
            { numericAgentid: 500001 }
        );
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.__completeCause, 'version_conflict');
    assert.equal(caught.__currentVersion, 5);
    // 草稿字段保持不变。
    const row = await db.get('SELECT version, touser FROM configurations WHERE code = ?', ['draft-v5']);
    assert.equal(Number(row.version), 5);
    assert.equal(row.touser, '');
});
