// 阶段 A（先补会失败的测试）：legacy-grace 能力完整删除（R-P1-04 决策：删除）。
//
// 复验指南 §5 R-P1-04 + §9 阶段 E：legacy-grace 当前是“写库但发送鉴权不读取”的假成功。
// 决策：完整删除该能力——路由、service 方法、字段文档、序列化输出，不留假成功端点。
// 本文件验证删除后：service 不再导出 grantLegacyGrace，路由不再存在，详情摘要不再返回 legacy_until。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-fix-verification-ai-execution-guide.md §5/§9。

const assert = require('assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');

function clearModule(modulePath) {
    delete require.cache[require.resolve(modulePath)];
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

test('R-P1-04: notifier 不再导出 grantLegacyGrace', t => {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    clearModule('../src/services/notifier');
    t.after(() => { clearModule('../src/services/notifier'); clearModule('../src/api/routes'); });
    const notifier = require('../src/services/notifier');
    assert.equal(typeof notifier.grantLegacyGrace, 'undefined', 'grantLegacyGrace 应已删除');
});

test('R-P1-04: routes.js 不再注册 legacy-grace 路由', () => {
    const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'routes.js'), 'utf8');
    assert.doesNotMatch(routes, /legacy-grace/, '不应再注册 /legacy-grace 路由');
    assert.doesNotMatch(routes, /grantLegacyGrace/, '不应再调用 grantLegacyGrace');
});

test('R-P1-04: api-docs 不再描述 legacy-grace 能力', () => {
    const docs = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-docs.html'), 'utf8');
    assert.doesNotMatch(docs, /legacy-grace/, 'api-docs 不应再描述 legacy-grace');
});

test('R-P1-04: 详情摘要不再输出 legacy_until 字段', async t => {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    function replaceForTest(t, o, p, v) {
        const had = Object.prototype.hasOwnProperty.call(o, p);
        const orig = o[p]; o[p] = v;
        t.after(() => { if (had) o[p] = orig; else delete o[p]; });
    }
    replaceForTest(t, Database.prototype, 'init', async function () {});
    replaceForTest(t, Database.prototype, 'getConfigurationByCode', async function () {
        return {
            code: 'app-a', corpid: 'corp-1', encrypted_corpsecret: 'enc', agentid: 100001,
            touser: 'alice', description: '', callback_enabled: 0,
            notify_key_hash: null, legacy_until: 9999999999, code_send_enabled: 1,
            app_enabled: 1, version: 1, created_at: '2026-07-01'
        };
    });
    replaceForTest(t, Database.prototype, 'findDuplicatesByCorpidAgentId', async function () { return []; });
    replaceForTest(t, Database.prototype, 'countRulesByConfigCodes', async function () { return {}; });
    replaceForTest(t, CryptoService.prototype, 'decrypt', function (v) { return String(v).replace(/^enc-/, ''); });
    replaceForTest(t, CryptoService.prototype, 'encrypt', function (v) { return `enc-${v}`; });

    clearModule('../src/services/notifier');
    t.after(() => { clearModule('../src/services/notifier'); clearModule('../src/api/routes'); });
    const notifier = require('../src/services/notifier');
    const summary = await notifier.getConfiguration('app-a');
    assert.equal(summary.legacy_until, undefined, '详情摘要不应再返回 legacy_until');
});
