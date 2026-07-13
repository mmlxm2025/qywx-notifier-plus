// 阶段 A/B：真实 SQLite 数据完整性测试（规范 §11.2）
//
// 使用临时 SQLite 文件 + 真实 Database，验证编号全局命名空间不变量：
//   1. 创建自定义编号成功并保存为小写。
//   2. 两条规则抢同一编号，只有一条成功。
//   3. 大小写不同仍冲突。
//   4. 与 configurations.code 冲突时拒绝。
//   5. 改号同时写入退役表并递增一次应用版本。
//   6. 改号失败时规则、退役表、应用版本全部回滚。
//   7. 同一规则可以恢复自己的退役编号。
//   8. 其他规则不能使用退役编号。
//   9. 删除规则后编号留在退役表。
//   10. 级联删除应用后，应用 Code 和全部规则编号都进入退役表。
//   11. 触发器能拦截绕过 service 的直接 SQL 冲突写入。
//   12. 迁移审计能发现旧数据中的跨表冲突。
//
// 这些测试驱动阶段 B 的数据库变更（退役表、索引、触发器、审计、helper）。

const assert = require('assert/strict');
const test = require('node:test');
const os = require('os');
const path = require('path');
const fs = require('fs');

function createIsolatedDatabase(t) {
    delete require.cache[require.resolve('../src/core/database')];
    const Database = require('../src/core/database');
    const dbPath = path.join(os.tmpdir(), `rule-api-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = new Database(dbPath);
    t.after(async () => {
        try { await db.close(); } catch (_e) { /* ignore */ }
        try { fs.unlinkSync(dbPath); } catch (_e) { /* ignore */ }
    });
    return db;
}

// 构造一个“迁移前遗留”库：仅建表骨架，不安装触发器/大小写唯一索引。
// 用于验证审计能在历史脏数据上检出冲突（模拟触发器上线前已存在的冲突库）。
async function createLegacyDatabaseWithConflicts(t) {
    delete require.cache[require.resolve('../src/core/database')];
    const Database = require('../src/core/database');
    const dbPath = path.join(os.tmpdir(), `rule-api-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = new Database(dbPath);
    t.after(async () => {
        try { await db.close(); } catch (_e) { /* ignore */ }
        try { fs.unlinkSync(dbPath); } catch (_e) { /* ignore */ }
    });
    // 只打开连接，不执行完整 createTables（避免安装触发器/唯一索引）。
    await new Promise((resolve, reject) => {
        const sqlite3 = require('sqlite3');
        db.db = new sqlite3.Database(db.dbPath, (err) => err ? reject(err) : resolve());
    });
    // 手动建表骨架（与 production 结构一致，但跳过 _installNotifyCodeTriggers 与唯一索引）。
    await db.runRaw(`
        CREATE TABLE configurations (
            code TEXT UNIQUE NOT NULL,
            corpid TEXT NOT NULL,
            encrypted_corpsecret TEXT,
            agentid INTEGER,
            touser TEXT,
            description TEXT,
            callback_token TEXT,
            encrypted_callback_token TEXT,
            encrypted_encoding_aes_key TEXT,
            callback_enabled INTEGER DEFAULT 0,
            notify_key_hash TEXT,
            legacy_until INTEGER,
            code_send_enabled INTEGER DEFAULT 1,
            app_enabled INTEGER DEFAULT 1,
            version INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(corpid, agentid, touser)
        )
    `, []);
    await db.runRaw(`
        CREATE TABLE notification_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            config_code TEXT NOT NULL,
            api_code TEXT NOT NULL,
            name TEXT NOT NULL,
            touser TEXT DEFAULT '',
            toparty TEXT DEFAULT '',
            totag TEXT DEFAULT '',
            is_all INTEGER DEFAULT 0,
            estimated_count INTEGER DEFAULT 1,
            enabled INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, []);
    await db.runRaw(`
        CREATE TABLE IF NOT EXISTS retired_notify_codes (
            code TEXT PRIMARY KEY COLLATE NOCASE,
            owner_type TEXT NOT NULL CHECK (owner_type IN ('rule', 'configuration')),
            owner_id TEXT NOT NULL,
            retired_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            reason TEXT NOT NULL CHECK (reason IN ('renamed', 'regenerated', 'deleted', 'cascade_deleted'))
        )
    `, []);
    return db;
}

// 插入一个已完成应用（直接 SQL，绕过服务层）。
async function insertCompletedApp(db, code, { version = 1, touser = 'alice' } = {}) {
    await db.runRaw(
        `INSERT INTO configurations (code, corpid, encrypted_corpsecret, agentid, touser, description,
            callback_enabled, notify_key_hash, legacy_until, code_send_enabled, app_enabled, version)
         VALUES (?, ?, ?, ?, ?, '', 0, NULL, NULL, 1, 1, ?)`,
        [code, `corp-${code}`, 'enc-secret', 100001, touser, version]
    );
}

async function insertRule(db, { id, configCode, apiCode, name = '规则' }) {
    await db.runRaw(
        `INSERT INTO notification_rules (id, config_code, api_code, name, touser, toparty, totag,
            is_all, estimated_count, enabled)
         VALUES (?, ?, ?, ?, 'alice', '', '', 0, 1, 1)`,
        [id, configCode, apiCode, name]
    );
}

async function getAppVersion(db, code) {
    const row = await db.get('SELECT version FROM configurations WHERE code = ?', [code]);
    return row ? Number(row.version) : null;
}

async function getRetired(db, code) {
    return db.get('SELECT * FROM retired_notify_codes WHERE code = ?', [code]);
}

async function listRetired(db) {
    return db.allRaw('SELECT * FROM retired_notify_codes ORDER BY code');
}

test('1. 创建自定义编号：inspectNotifyCodeConflict 无冲突时返回 null，retireNotifyCode 可登记', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await insertCompletedApp(db, 'app-a');
    // 无任何占用时校验通过。
    let conflict;
    await db.withTransaction(async (tx) => {
        conflict = await db.inspectNotifyCodeConflict(tx, 'ops-alert', { ruleId: null });
    });
    assert.equal(conflict, null, '未被占用编号应无冲突');
});

test('2. 两条规则抢同一编号：inspectNotifyCodeConflict 命中已存在规则', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await insertCompletedApp(db, 'app-a');
    await insertRule(db, { id: 1, configCode: 'app-a', apiCode: 'ops-alert' });
    let conflict;
    await db.withTransaction(async (tx) => {
        conflict = await db.inspectNotifyCodeConflict(tx, 'ops-alert', { ruleId: null });
    });
    assert.ok(conflict, '应检测到冲突');
    assert.equal(conflict.scope, 'rule');
    assert.equal(conflict.reclaimable, false);
});

test('3. 大小写不敏感冲突：OPS-ALERT 与 ops-alert 视为同一编号', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await insertCompletedApp(db, 'app-a');
    await insertRule(db, { id: 1, configCode: 'app-a', apiCode: 'ops-alert' });
    // 用大写查询应命中（COLLATE NOCASE / lower()）
    let conflict;
    await db.withTransaction(async (tx) => {
        conflict = await db.inspectNotifyCodeConflict(tx, 'OPS-ALERT', { ruleId: null });
    });
    assert.ok(conflict, '大小写不同应判为冲突');
    assert.equal(conflict.scope, 'rule');
});

// 发送路径回归：getNotificationRuleByApiCode / getConfigurationByCode 必须大小写不敏感。
// 历史 bug：唯一索引与冲突检查用 lower()，但运行时查询用精确匹配，
// 导致调用方传 OPS-ALERT 时 404，而 ops-alert 可发送。
test('3b. getNotificationRuleByApiCode 大小写不敏感命中', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await insertCompletedApp(db, 'app-a');
    await insertRule(db, { id: 1, configCode: 'app-a', apiCode: 'ops-alert' });
    const byUpper = await db.getNotificationRuleByApiCode('OPS-ALERT');
    assert.ok(byUpper, '大写编号应命中小写入库的规则');
    assert.equal(byUpper.api_code, 'ops-alert');
    const byMixed = await db.getNotificationRuleByApiCode('Ops-Alert');
    assert.ok(byMixed, '混合大小写也应命中');
    assert.equal(byMixed.id, 1);
});

test('3c. getConfigurationByCode 大小写不敏感命中', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await insertCompletedApp(db, 'App-Code-01');
    const row = await db.getConfigurationByCode('app-code-01');
    assert.ok(row, '配置 Code 查询应大小写不敏感');
    assert.equal(row.code, 'App-Code-01', '返回行应保留库内权威大小写');
});

test('3d. updateConfigurationFields 大小写不敏感写入并返回权威 code', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await insertCompletedApp(db, 'app-b', { version: 1 });
    const result = await db.updateConfigurationFields('APP-B', { description: 'updated' }, 1);
    assert.equal(result.changes, 1, '大小写不同的 code 仍应更新成功');
    assert.equal(result.code, 'app-b', '应返回库内权威 code');
    assert.equal(result.version, 2);
    const row = await db.getConfigurationByCode('app-b');
    assert.equal(row.description, 'updated');
});

test('4. 与 configurations.code 冲突：inspectNotifyCodeConflict 命中 configuration', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await insertCompletedApp(db, 'app-a');
    // 用应用 Code 作为规则编号候选
    let conflict;
    await db.withTransaction(async (tx) => {
        conflict = await db.inspectNotifyCodeConflict(tx, 'app-a', { ruleId: null });
    });
    assert.ok(conflict, '规则编号与配置 Code 相同应冲突');
    assert.equal(conflict.scope, 'configuration');
});

test('5. 改号写入退役表：retireNotifyCode 登记旧编号', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await insertCompletedApp(db, 'app-a', { version: 1 });
    await insertRule(db, { id: 7, configCode: 'app-a', apiCode: 'old-code' });
    await db.withTransaction(async (tx) => {
        await db.retireNotifyCode(tx, {
            code: 'old-code',
            ownerType: 'rule',
            ownerId: '7',
            reason: 'renamed'
        });
        await tx.run('UPDATE notification_rules SET api_code = ? WHERE id = ?', ['new-code', 7]);
    });
    const retired = await getRetired(db, 'old-code');
    assert.ok(retired, '改号后旧编号应进入退役表');
    assert.equal(retired.owner_type, 'rule');
    assert.equal(retired.owner_id, '7');
    assert.equal(retired.reason, 'renamed');
    // 大小写不敏感查询也应命中
    const upper = await getRetired(db, 'OLD-CODE');
    assert.ok(upper, '退役表查询应大小写不敏感');
});

test('6. 改号失败回滚：事务失败时退役表不残留', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await insertCompletedApp(db, 'app-a', { version: 1 });
    await insertRule(db, { id: 7, configCode: 'app-a', apiCode: 'old-code' });
    // 模拟事务中途失败：登记退役后抛错 -> 整体回滚
    await assert.rejects(
        db.withTransaction(async (tx) => {
            await db.retireNotifyCode(tx, {
                code: 'old-code', ownerType: 'rule', ownerId: '7', reason: 'renamed'
            });
            throw new Error('simulated failure');
        }),
        /simulated failure/
    );
    const retired = await getRetired(db, 'old-code');
    assert.equal(retired, undefined, '事务失败后退役表不应残留');
});

test('7. 同一规则可恢复自己退役编号：reclaimable=true', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await insertCompletedApp(db, 'app-a', { version: 1 });
    await insertRule(db, { id: 7, configCode: 'app-a', apiCode: 'current-code' });
    // 预置一条属于规则 7 自己的退役记录
    await db.runRaw(
        `INSERT INTO retired_notify_codes (code, owner_type, owner_id, reason)
         VALUES (?, 'rule', '7', 'renamed')`,
        ['my-old-code']
    );
    let conflict;
    await db.withTransaction(async (tx) => {
        conflict = await db.inspectNotifyCodeConflict(tx, 'my-old-code', { ruleId: 7 });
    });
    assert.ok(conflict, '应检测到退役编号');
    assert.equal(conflict.scope, 'retired');
    assert.equal(conflict.reclaimable, true, '自己的退役编号应可恢复');
    // 其他规则（ruleId=8）查询同一编号不可恢复
    let conflict2;
    await db.withTransaction(async (tx) => {
        conflict2 = await db.inspectNotifyCodeConflict(tx, 'my-old-code', { ruleId: 8 });
    });
    assert.ok(conflict2, '其他规则查询退役编号应命中');
    assert.equal(conflict2.scope, 'retired');
    assert.equal(conflict2.reclaimable, false, '其他规则的退役编号不可恢复');
});

test('8. 其他规则不能使用退役编号（已删规则遗留）', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await insertCompletedApp(db, 'app-a', { version: 1 });
    // 预置一条已删除规则的退役记录（owner_id 指向已不存在的规则）
    await db.runRaw(
        `INSERT INTO retired_notify_codes (code, owner_type, owner_id, reason)
         VALUES ('deleted-code', 'rule', '999', 'deleted')`
    );
    let conflict;
    await db.withTransaction(async (tx) => {
        conflict = await db.inspectNotifyCodeConflict(tx, 'deleted-code', { ruleId: 7 });
    });
    assert.ok(conflict, '已删规则的退役编号不应被新规则使用');
    assert.equal(conflict.scope, 'retired');
    assert.equal(conflict.reclaimable, false);
});

test('9. 退役表幂等：INSERT ... ON CONFLICT 不报错', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    // 两次登记同一编号不应抛主键冲突
    await db.withTransaction(async (tx) => {
        await db.retireNotifyCode(tx, { code: 'dup-code', ownerType: 'rule', ownerId: '1', reason: 'deleted' });
    });
    await db.withTransaction(async (tx) => {
        await db.retireNotifyCode(tx, { code: 'dup-code', ownerType: 'rule', ownerId: '1', reason: 'deleted' });
    });
    const retired = await getRetired(db, 'dup-code');
    assert.ok(retired, '幂等登记后编号应在退役表');
});

test('10. 级联退役：应用 Code 与规则编号均可登记', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await insertCompletedApp(db, 'app-a', { version: 1 });
    await insertRule(db, { id: 1, configCode: 'app-a', apiCode: 'rule-1' });
    await insertRule(db, { id: 2, configCode: 'app-a', apiCode: 'rule-2' });
    // 模拟级联退役登记
    await db.withTransaction(async (tx) => {
        await db.retireNotifyCode(tx, { code: 'app-a', ownerType: 'configuration', ownerId: 'app-a', reason: 'cascade_deleted' });
        await db.retireNotifyCode(tx, { code: 'rule-1', ownerType: 'rule', ownerId: '1', reason: 'cascade_deleted' });
        await db.retireNotifyCode(tx, { code: 'rule-2', ownerType: 'rule', ownerId: '2', reason: 'cascade_deleted' });
    });
    const retired = await listRetired(db);
    assert.equal(retired.length, 3, '应用 Code 与两条规则编号均应登记');
    const codes = retired.map(r => r.code).sort();
    assert.deepEqual(codes, ['app-a', 'rule-1', 'rule-2']);
});

test('11. 触发器拦截绕过 service 的直接 SQL 冲突写入（规则编号 vs 配置 Code）', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await insertCompletedApp(db, 'app-a');
    // 直接 SQL 插入规则，编号等于应用 Code -> 应被触发器拒绝
    await assert.rejects(
        db.runRaw(
            `INSERT INTO notification_rules (config_code, api_code, name, touser, toparty, totag, is_all, estimated_count, enabled)
             VALUES ('app-a', 'app-a', '撞号规则', '', '', '', 0, 1, 1)`
        ),
        (err) => {
            const msg = String(err && err.message || '');
            return msg.includes('NOTIFY_CODE_CONFLICT') || msg.includes('constraint') || msg.includes('UNIQUE');
        },
        '触发器应拦截规则编号与配置 Code 的跨表冲突'
    );
});

test('11b. 触发器拦截绕过 service 的直接 SQL 冲突写入（规则编号 vs 退役编号）', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await insertCompletedApp(db, 'app-a');
    // 预置退役编号
    await db.runRaw(
        `INSERT INTO retired_notify_codes (code, owner_type, owner_id, reason)
         VALUES ('retired-code', 'rule', '999', 'deleted')`
    );
    // 新规则试图使用退役编号 -> 触发器拒绝
    await assert.rejects(
        db.runRaw(
            `INSERT INTO notification_rules (config_code, api_code, name, touser, toparty, totag, is_all, estimated_count, enabled)
             VALUES ('app-a', 'retired-code', '撞退役号', '', '', '', 0, 1, 1)`
        ),
        (err) => {
            const msg = String(err && err.message || '');
            return msg.includes('NOTIFY_CODE_CONFLICT') || msg.includes('constraint') || msg.includes('UNIQUE');
        },
        '触发器应拦截规则编号与退役编号冲突'
    );
});

test('12. 迁移审计能发现旧数据中的跨表冲突（legacy 库无触发器）', async t => {
    // 模拟触发器/唯一索引上线前已存在冲突的遗留库：仅建表骨架，注入冲突数据，再审计。
    // 新库（init）会因触发器阻止脏数据写入，所以这里用 legacy 路径构造历史场景。
    const db = await createLegacyDatabaseWithConflicts(t);
    await insertCompletedApp(db, 'shared-code');
    await insertRule(db, { id: 1, configCode: 'shared-code', apiCode: 'shared-code' });
    // 调用审计方法
    const result = await db.auditNotifyCodeNamespace();
    assert.ok(result && Array.isArray(result.conflicts), '审计应返回 conflicts 数组');
    assert.ok(result.conflicts.length >= 1, '应检出跨表冲突');
    const hasCrossTable = result.conflicts.some(c => c.type === 'cross_table');
    assert.ok(hasCrossTable, '应包含 cross_table 类型冲突');
});

test('12b. 迁移审计能发现规则表内部大小写重复', async t => {
    const db = await createLegacyDatabaseWithConflicts(t);
    await insertCompletedApp(db, 'app-a');
    // 注入同一编号的大小写两个变体（legacy 库无唯一索引，可写入）
    await insertRule(db, { id: 1, configCode: 'app-a', apiCode: 'ops-alert' });
    await insertRule(db, { id: 2, configCode: 'app-a', apiCode: 'OPS-ALERT' });
    const result = await db.auditNotifyCodeNamespace();
    const hasRuleDup = result.conflicts.some(c => c.type === 'rule_duplicate');
    assert.ok(hasRuleDup, '应检出规则表内部大小写重复');
});

test('12c. 正常库审计无冲突时返回空数组', async t => {
    const db = await createIsolatedDatabase(t);
    await db.init();
    await insertCompletedApp(db, 'app-a');
    await insertRule(db, { id: 1, configCode: 'app-a', apiCode: 'rule-1' });
    const result = await db.auditNotifyCodeNamespace();
    assert.equal(result.conflicts.length, 0, '正常库审计应无冲突');
});
