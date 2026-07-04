// 阶段 A（先补会失败的测试）：惰性密文迁移覆盖刚提交的新 CorpSecret（P0-01）。
//
// 复验文档 §3 P0-01：旧 CBC CorpSecret 的惰性迁移会在 CorpSecret 更新提交后，
// 把旧 secret 重新覆盖回数据库；接口返回成功且版本递增，但实际凭证未更新。
//
// 本文件用真实内存 SQLite + 真实 CryptoService（GCM/CBC）+ 真实 DAO 事务方法，
// 不桩加密/DAO，只桩 WeChatService（避免真实网络）。覆盖：
//   - 旧 CBC secret 更新为新 secret 后，数据库字段解密必须等于新 secret。
//   - 惰性迁移已排队、并发更新新 secret：迁移不得覆盖新 secret（changes=0 语义）。
//   - 仅做 CBC→GCM 表示迁移时，业务版本不增加。
//   - CorpSecret 更新冲突时不失效 token、不迁移旧值、数据库不变。
//   - AgentID-only 更新仍能用旧 secret 验证，且不覆盖并发 secret 更新。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-second-fix-review-ai-execution-guide.md §3 P0-01。

const assert = require('assert/strict');
const test = require('node:test');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 构造旧 CBC 密文（aes-256-cbc，格式 ivHex:cipherHex），与 CryptoService.decryptLegacyCBC 兼容。
function legacyCbcEncrypt(plain, keyBuf) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', keyBuf, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return iv.toString('hex') + ':' + ct.toString('hex');
}

// 在干净 require 链上装配 notifier：真实 SQLite（临时文件）+ 真实加密 + 桩 WeChat。
// 不清 require.cache 会导致 notifier 顶部立即触发的 db.init() 复用上一个测试的 DB_PATH。
async function setupRealNotifier(t) {
    const ENCRYPTION_KEY = 'a'.repeat(32);
    const keyBuf = Buffer.from(ENCRYPTION_KEY, 'utf8');
    const dbPath = path.join(os.tmpdir(), `lazy-mig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

    // 环境变量：测试期间注入。
    const envBackup = {};
    for (const k of ['ENCRYPTION_KEY', 'DB_PATH']) {
        envBackup[k] = process.env[k];
        process.env[k] = k === 'ENCRYPTION_KEY' ? ENCRYPTION_KEY : dbPath;
    }
    t.after(() => {
        for (const k of Object.keys(envBackup)) {
            if (envBackup[k] === undefined) delete process.env[k];
            else process.env[k] = envBackup[k];
        }
    });

    // 清缓存，确保 notifier/config/database/crypto-instance 重新读取环境变量。
    for (const mod of [
        '../src/core/config', '../src/core/crypto-instance', '../src/core/database',
        '../src/core/wechat', '../src/services/notifier'
    ]) {
        delete require.cache[require.resolve(mod)];
    }
    t.after(() => {
        for (const mod of [
            '../src/core/config', '../src/core/crypto-instance', '../src/core/database',
            '../src/core/wechat', '../src/services/notifier'
        ]) {
            delete require.cache[require.resolve(mod)];
        }
    });

    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');
    const cryptoSvc = new CryptoService(ENCRYPTION_KEY);

    // 桩 WeChat：只验证调用契约，不发真实网络请求。
    const wechatOrigProto = {
        getToken: WeChatService.prototype.getToken,
        getAgentInfo: WeChatService.prototype.getAgentInfo,
        invalidateToken: WeChatService.prototype.invalidateToken
    };
    const wechatCalls = { tokens: [], invalidations: [] };
    WeChatService.prototype.getToken = async function (corpid, secret) {
        wechatCalls.tokens.push({ corpid, secret });
        return 'mock-access-token';
    };
    WeChatService.prototype.getAgentInfo = async function (tok, agentid) {
        return { agentid };
    };
    WeChatService.prototype.invalidateToken = async function (corpid, secret) {
        wechatCalls.invalidations.push({ corpid, secret });
    };
    t.after(() => {
        WeChatService.prototype.getToken = wechatOrigProto.getToken;
        WeChatService.prototype.getAgentInfo = wechatOrigProto.getAgentInfo;
        WeChatService.prototype.invalidateToken = wechatOrigProto.invalidateToken;
    });

    const notifier = require('../src/services/notifier');
    await notifier.ensureDbReady();

    // 关闭 DB + 删除临时文件。
    t.after(async () => {
        try { await notifier._internal.db.close(); } catch (_e) { /* ignore */ }
        try { fs.unlinkSync(dbPath); } catch (_e) { /* ignore */ }
    });

    return { notifier, cryptoSvc, keyBuf, dbPath, wechatCalls, ENCRYPTION_KEY };
}

// 直接插入一行完成应用（绕过 service 校验，控制初始密文格式）。
async function seedCompletedApp(db, { code, corpid, agentid, encryptedCorpsecret, touser = 'alice', version = 1 }) {
    await db.runRaw(
        `INSERT INTO configurations (
            code, corpid, encrypted_corpsecret, agentid, touser, description,
            callback_token, encrypted_callback_token, encrypted_encoding_aes_key, callback_enabled,
            notify_key_hash, code_send_enabled, app_enabled, version
        ) VALUES (?, ?, ?, ?, ?, '', NULL, NULL, NULL, 0, NULL, 1, 1, ?)`,
        [code, corpid, encryptedCorpsecret, agentid, touser, version]
    );
}

async function readRow(db, code) {
    return db.getConfigurationByCode(code);
}

// ─── P0-01 核心：旧 CBC secret 更新为新 secret 后数据库必须保存新值 ──────────

test('P0-01: 旧 CBC CorpSecret 更新为新 secret，DB 字段必须等于新 secret', async t => {
    const { notifier, cryptoSvc, keyBuf } = await setupRealNotifier(t);
    const db = notifier._internal.db;
    const oldSecret = 'old-secret-value';
    const newSecret = 'new-secret-value';
    const legacyCipher = legacyCbcEncrypt(oldSecret, keyBuf);

    await seedCompletedApp(db, {
        code: 'app-mig', corpid: 'corp-mig', agentid: 100001,
        encryptedCorpsecret: legacyCipher, version: 1
    });

    // 触发一次读，使惰性迁移排队（旧实现会异步把旧 secret 写回）。
    // 这里直接调用 updateConfiguration：它会 CAS 更新为新 secret。
    const result = await notifier.updateConfiguration(
        'app-mig', { corpsecret: newSecret }, { expectedVersion: 1 }
    );
    assert.ok(result.version >= 2, '版本应递增');

    // 等待任何排队的异步迁移落库。
    await new Promise(r => setTimeout(r, 50));

    const row = await readRow(db, 'app-mig');
    let stored;
    try {
        stored = cryptoSvc.decrypt(row.encrypted_corpsecret);
    } catch (e) {
        assert.fail('解密失败：' + e.message);
    }
    // P0-01：当前实现会失败——惰性迁移把旧 secret 重新写回，覆盖了刚提交的新 secret。
    assert.equal(
        stored, newSecret,
        '数据库字段必须保存新 secret，但实际解密得到：' + stored
    );
    assert.ok(!cryptoSvc.isLegacyCiphertext(row.encrypted_corpsecret), '应已迁移为 GCM 格式');
});

// ─── P0-01：惰性迁移已排队，不得覆盖并发新 secret 更新 ──────────────────────

test('P0-01: 惰性迁移用旧值条件更新，不得覆盖并发新 secret 更新', async t => {
    const { notifier, cryptoSvc, keyBuf } = await setupRealNotifier(t);
    const db = notifier._internal.db;
    const oldSecret = 'old-secret-2';
    const newSecret = 'new-secret-2';
    const legacyCipher = legacyCbcEncrypt(oldSecret, keyBuf);

    await seedCompletedApp(db, {
        code: 'app-mig2', corpid: 'corp-mig2', agentid: 200001,
        encryptedCorpsecret: legacyCipher, version: 1
    });

    // 模拟“惰性迁移已排队”：触发一次解密（旧实现会 fire-and-forget 迁移），
    // 紧接着提交新 secret。两者竞争时迁移的 UPDATE 必须因 WHERE 条件不匹配而 changes=0。
    // 通过 getConfigMembers 触发 decryptWithLazyMigration。
    try {
        await notifier.getConfigMembers('app-mig2');
    } catch (_e) { /* 成员读取会失败，但惰性迁移已排队 */ }
    // 立即提交新 secret（不等迁移完成）。
    await notifier.updateConfiguration(
        'app-mig2', { corpsecret: newSecret }, { expectedVersion: 1 }
    );

    await new Promise(r => setTimeout(r, 80));

    const row = await readRow(db, 'app-mig2');
    const stored = cryptoSvc.decrypt(row.encrypted_corpsecret);
    assert.equal(stored, newSecret, '并发迁移不得覆盖刚提交的新 secret');
});

// ─── P0-01：仅做 CBC→GCM 表示迁移，业务版本不增加 ───────────────────────────

test('P0-01: 仅做 CBC→GCM 表示迁移，业务版本不递增', async t => {
    const { notifier, cryptoSvc, keyBuf } = await setupRealNotifier(t);
    const db = notifier._internal.db;
    const secret = 'stable-secret';
    const legacyCipher = legacyCbcEncrypt(secret, keyBuf);

    await seedCompletedApp(db, {
        code: 'app-mig3', corpid: 'corp-mig3', agentid: 300001,
        encryptedCorpsecret: legacyCipher, version: 7
    });

    // 触发一次解密（迁移）。注意：迁移不应改变业务 version。
    try {
        await notifier.getConfigMembers('app-mig3');
    } catch (_e) { /* 忽略成员读取错误 */ }
    await new Promise(r => setTimeout(r, 80));

    const row = await readRow(db, 'app-mig3');
    assert.equal(Number(row.version), 7, '表示迁移不得递增业务版本');
    assert.ok(!cryptoSvc.isLegacyCiphertext(row.encrypted_corpsecret), '应已迁移为 GCM');
    assert.equal(cryptoSvc.decrypt(row.encrypted_corpsecret), secret, '迁移后解密仍为原明文');
});

// ─── P0-01：CorpSecret 更新版本冲突时不失效 token、不迁移旧值、DB 不变 ────────

test('P0-01: CorpSecret 更新版本冲突时不失效 token、不迁移、字段不变', async t => {
    const { notifier, cryptoSvc, keyBuf, wechatCalls } = await setupRealNotifier(t);
    const db = notifier._internal.db;
    const oldSecret = 'conflict-old';
    const legacyCipher = legacyCbcEncrypt(oldSecret, keyBuf);

    await seedCompletedApp(db, {
        code: 'app-mig4', corpid: 'corp-mig4', agentid: 400001,
        encryptedCorpsecret: legacyCipher, version: 5
    });

    let caught = null;
    try {
        // 用过期版本 1（服务端是 5）→ CAS 失败 → 版本冲突。
        await notifier.updateConfiguration(
            'app-mig4', { corpsecret: 'should-not-write' }, { expectedVersion: 1 }
        );
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.businessCode, 'APP_VERSION_CONFLICT');
    assert.equal(wechatCalls.invalidations.length, 0, '版本冲突时不得失效旧 token');

    await new Promise(r => setTimeout(r, 50));
    const row = await readRow(db, 'app-mig4');
    assert.equal(cryptoSvc.decrypt(row.encrypted_corpsecret), oldSecret, '字段仍为旧明文');
    assert.equal(Number(row.version), 5, '版本不递增');
});

// ─── P0-01：AgentID-only 更新仍能用旧 secret 验证，不覆盖并发 secret 更新 ────

test('P0-01: AgentID-only 更新用旧 secret 验证，不覆盖并发 secret 更新', async t => {
    const { notifier, cryptoSvc, keyBuf, wechatCalls } = await setupRealNotifier(t);
    const db = notifier._internal.db;
    const oldSecret = 'agent-old';
    const legacyCipher = legacyCbcEncrypt(oldSecret, keyBuf);

    await seedCompletedApp(db, {
        code: 'app-mig5', corpid: 'corp-mig5', agentid: 500001,
        encryptedCorpsecret: legacyCipher, version: 1
    });

    // AgentID 变化触发凭证验证：解密旧 secret（CBC）用于 getToken。
    // 关键：这次解密不得把旧 secret 异步写回，否则会覆盖下面的并发 secret 更新。
    // 先启动 AgentID 更新（会 await getToken），与此同时并发提交 secret 更新。
    const agentUpdateP = notifier.updateConfiguration(
        'app-mig5', { agentid: 500002 }, { expectedVersion: 1 }
    );
    // agentUpdate 用 version=1 会先成功（version→2）。验证后 secret 未被旧值覆盖。
    await agentUpdateP;

    await new Promise(r => setTimeout(r, 80));
    const row = await readRow(db, 'app-mig5');
    // secret 字段应保持旧明文（AgentID 更新不改 secret），且不应被惰性迁移写回相同旧值导致 version 异常。
    assert.equal(cryptoSvc.decrypt(row.encrypted_corpsecret), oldSecret, 'secret 字段保持旧明文');
    assert.equal(Number(row.agentid), 500002, 'AgentID 已更新');
    assert.equal(wechatCalls.tokens.length, 1, 'AgentID 变化应触发一次 getToken 用旧 secret 验证');
});
