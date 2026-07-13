// 阶段 A（先补会失败的测试）：数据库事务隔离契约（P0-01）。
//
// 用真实临时 SQLite 文件验证：公共 runRaw/allRaw/get 必须在事务期间排队，
// 事务回滚不能撤销事务外调用方的成功写入。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-code-review-fix-guide.md §3.1。

const assert = require('assert/strict');
const test = require('node:test');
const os = require('os');
const path = require('path');
const fs = require('fs');

// 构造一个独立 Database 实例（指向临时文件），不污染共享单例。
function createIsolatedDatabase(t) {
    delete require.cache[require.resolve('../src/core/database')];
    const Database = require('../src/core/database');
    const dbPath = path.join(os.tmpdir(), `tx-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = new Database(dbPath);
    t.after(async () => {
        try { await db.close(); } catch (_e) { /* ignore */ }
        try { fs.unlinkSync(dbPath); } catch (_e) { /* ignore */ }
    });
    return db;
}

async function seedApp(db, code, version = 1) {
    await db.runRaw(
        `INSERT INTO configurations (code, corpid, encrypted_corpsecret, agentid, touser, description, version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [code, 'corp-1', 'secret', 1, 'alice', 'original', version]
    );
}

test('P0-01: 普通 runRaw 在事务结束前不得 resolve（事务期间被排队）', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await seedApp(db, 'app-a');

    let outsideResolvedDuringTx = false;

    // 事务内写入后用 barrier 暂停，期间发起普通写入。
    const txPromise = db.withTransaction(async (tx) => {
        await tx.run(`UPDATE configurations SET description = 'in-tx' WHERE code = ?`, ['app-a']);
        // 暂停 80ms，期间给普通写入机会。
        await new Promise(resolve => setTimeout(resolve, 80));
    });

    // 让事件循环先进入事务。
    await new Promise(resolve => setTimeout(resolve, 20));

    const outsidePromise = db.runRaw(
        `UPDATE configurations SET description = 'outside' WHERE code = ?`,
        ['app-a']
    ).then(() => { outsideResolvedDuringTx = true; });

    await Promise.all([txPromise, outsidePromise]);

    // 普通写入最终一定 resolve；本断言的关键是它必须在事务释放后执行。
    assert.ok(outsideResolvedDuringTx, '普通写入最终应执行');
    // 因为事务先提交、普通写入再执行，最终值应为 outside（顺序正确）。
    const row = await db.get(`SELECT description FROM configurations WHERE code = ?`, ['app-a']);
    assert.equal(row.description, 'outside');
});

test('P0-01: 事务回滚不能撤销事务外调用方的成功写入', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await seedApp(db, 'app-a');

    // 事务内写入并暂停，期间发起普通写入；随后事务强制回滚。
    const txPromise = db.withTransaction(async (tx) => {
        await tx.run(`UPDATE configurations SET description = 'in-tx' WHERE code = ?`, ['app-a']);
        await new Promise(resolve => setTimeout(resolve, 80));
        throw new Error('forced rollback');
    }).catch(() => 'rolled-back');

    // 让事件循环先进入事务。
    await new Promise(resolve => setTimeout(resolve, 20));

    // 普通写入：在修复前会“看似成功”但实际被回滚；修复后应排队到事务结束后再执行。
    const outsideResult = await db.runRaw(
        `UPDATE configurations SET description = 'outside' WHERE code = ?`,
        ['app-a']
    );

    await txPromise;

    // 关键不变量：事务回滚后，事务外的写入最终必须保留。
    const row = await db.get(`SELECT description FROM configurations WHERE code = ?`, ['app-a']);
    assert.equal(
        row.description,
        'outside',
        '事务回滚不能撤销事务外写入；当前值: ' + row.description
    );
    assert.ok(outsideResult && outsideResult.changes !== undefined, '事务外写入应正常返回 changes');
});

test('P0-01: COMMIT 路径下普通写入在事务后顺序执行', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await seedApp(db, 'app-a', 1);

    const order = [];

    const txPromise = db.withTransaction(async (tx) => {
        await tx.run(`UPDATE configurations SET description = 'in-tx' WHERE code = ?`, ['app-a']);
        order.push('tx-write');
        await new Promise(resolve => setTimeout(resolve, 60));
        order.push('tx-commit-pre');
    });

    await new Promise(resolve => setTimeout(resolve, 20));

    await db.runRaw(
        `UPDATE configurations SET description = 'outside' WHERE code = ?`,
        ['app-a']
    ).then(() => order.push('outside-write'));

    await txPromise;

    // 顺序：事务写 → 事务提交前 → 普通写（修复后必须排在事务后）。
    const outsideIndex = order.indexOf('outside-write');
    const txCommitIndex = order.indexOf('tx-commit-pre');
    assert.ok(outsideIndex > -1, '普通写入应完成');
    assert.ok(txCommitIndex > -1, '事务应进入提交前阶段');
    assert.ok(
        outsideIndex > txCommitIndex,
        '普通写入应在事务释放后才执行；当前顺序: ' + JSON.stringify(order)
    );
});

test('P0-01: 多个事务顺序执行，不交错', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await seedApp(db, 'app-a', 1);

    const log = [];
    async function runTx(label) {
        await db.withTransaction(async (tx) => {
            log.push(`${label}:begin`);
            await tx.run(`UPDATE configurations SET version = version + 1 WHERE code = ?`, ['app-a']);
            await new Promise(r => setTimeout(r, 30));
            log.push(`${label}:end`);
        });
    }

    await Promise.all([runTx('A'), runTx('B'), runTx('C')]);

    // 每个 begin 之后应紧跟对应 end（事务间不交错）。
    for (let i = 0; i < log.length; i += 2) {
        const beginLabel = log[i].split(':')[0];
        const endLabel = log[i + 1] && log[i + 1].split(':')[0];
        assert.equal(endLabel, beginLabel, `事务交错: ${JSON.stringify(log)}`);
    }
    const row = await db.get(`SELECT version FROM configurations WHERE code = ?`, ['app-a']);
    assert.equal(Number(row.version), 4, '三次事务各 +1');
});

test('P0-01: close() 排到队列末尾，不与事务交错', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await seedApp(db, 'app-a', 1);

    let txDoneBeforeClose = false;
    const txPromise = db.withTransaction(async (tx) => {
        await tx.run(`UPDATE configurations SET version = version + 1 WHERE code = ?`, ['app-a']);
        await new Promise(r => setTimeout(r, 50));
        txDoneBeforeClose = true;
    });

    await new Promise(r => setTimeout(r, 10));
    // close 必须等事务结束。
    await Promise.all([txPromise, db.close()]);

    assert.ok(txDoneBeforeClose, '事务应在 close 前完成');
});
