// 运行时缓存不变量：
//   1. clearRuntimeCaches 不得抹掉 inflightSends（否则并发相同 payload 重复发送）。
//   2. 异步 resolve 不得在 clear 之后把旧 target 重新 setCached（错误接收人毒化）。

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
        encrypted_corpsecret: 'encrypted-secret',
        agentid: 100001,
        touser: 'alice',
        description: 'app',
        callback_enabled: 0,
        app_enabled: 1,
        code_send_enabled: 1,
        version: 1,
        ...overrides
    };
}

function setup(t, { rule = null, slowRuleMs = 0, sendDelayMs = 40 } = {}) {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    withEnv(t, 'CONFIG_CACHE_TTL_MS', '60000');
    // 关闭结果去重，专注 in-flight / target 缓存行为。
    withEnv(t, 'SEND_DEDUP_TTL_MS', '0');

    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');

    let config = completedConfig();
    let ruleRow = rule;
    const calls = { sendCount: 0, lastRecipient: null, ruleReads: 0 };

    replaceForTest(t, Database.prototype, 'init', async function init() {});
    replaceForTest(t, Database.prototype, 'getConfigurationByCode', async function getConfigurationByCode(code) {
        const c = String(code || '').toLowerCase();
        if (c === String(config.code).toLowerCase()) return { ...config };
        if (ruleRow && c === String(ruleRow.config_code).toLowerCase()) return { ...config };
        // 规则路径二次检查“配置 code 是否与规则同名”时可能查 requestedCode。
        return null;
    });
    replaceForTest(t, Database.prototype, 'getNotificationRuleByApiCode', async function getNotificationRuleByApiCode(apiCode) {
        calls.ruleReads += 1;
        if (slowRuleMs > 0) {
            await new Promise(r => setTimeout(r, slowRuleMs));
        }
        if (!ruleRow || String(apiCode).toLowerCase() !== String(ruleRow.api_code).toLowerCase()) return null;
        return { ...ruleRow };
    });
    replaceForTest(t, CryptoService.prototype, 'decrypt', function decrypt() { return 'plain-secret'; });
    replaceForTest(t, CryptoService.prototype, 'isLegacyCiphertext', () => false);
    replaceForTest(t, WeChatService.prototype, 'getToken', async () => 'token');
    replaceForTest(t, WeChatService.prototype, 'withTokenRetry', async function withTokenRetry(_c, _s, fn) {
        return fn('token');
    });
    replaceForTest(t, WeChatService.prototype, 'sendTextMessage', async function sendTextMessage(_t, _a, recipient) {
        calls.sendCount += 1;
        calls.lastRecipient = recipient;
        if (sendDelayMs > 0) await new Promise(r => setTimeout(r, sendDelayMs));
        return { errcode: 0, errmsg: 'ok', msgid: 'm' + calls.sendCount };
    });

    clearModule('../src/services/notifier');
    t.after(() => clearModule('../src/services/notifier'));
    const notifier = require('../src/services/notifier');
    return {
        notifier,
        calls,
        setRule(next) { ruleRow = next; }
    };
}

test('clearRuntimeCaches 后 inflightSends 仍在，相同 payload 合并为一次发送', async t => {
    const { notifier, calls } = setup(t, { sendDelayMs: 50 });
    const p1 = notifier.sendNotification('app-a', 't', 'body-same', { msgType: 'text' });
    await new Promise(r => setTimeout(r, 5));
    assert.ok(notifier._internal.inflightSends.size >= 1, '发送中应有 in-flight 键');
    notifier._internal.clearRuntimeCaches();
    assert.ok(
        notifier._internal.inflightSends.size >= 1,
        'clearRuntimeCaches 不得抹掉 inflightSends'
    );
    const p2 = notifier.sendNotification('app-a', 't', 'body-same', { msgType: 'text' });
    await Promise.all([p1, p2]);
    assert.equal(calls.sendCount, 1, 'clear 后并发相同 payload 仍应合并为一次企业微信调用');
});

test('异步 resolve 在 clear 后不得把旧接收人写回 targetCache', async t => {
    const rule = {
        id: 1,
        config_code: 'app-a',
        api_code: 'rule-x',
        name: 'r',
        touser: 'alice',
        toparty: '',
        totag: '',
        is_all: 0,
        enabled: 1,
        estimated_count: 1
    };
    const { notifier, calls, setRule } = setup(t, { rule, slowRuleMs: 40, sendDelayMs: 5 });

    // 第一次 resolve 在慢查询中；期间管理写改接收人并 clear。
    const first = notifier.sendNotification('rule-x', 't', 'm1', { msgType: 'text', force: true });
    await new Promise(r => setTimeout(r, 10));
    setRule({ ...rule, touser: 'bob' });
    notifier._internal.clearRuntimeCaches();
    await first; // 首次可能仍发到 alice（在飞请求），但不得毒化缓存

    const cached = notifier._internal.targetCache.get('rule-x');
    if (cached && cached.value && cached.value.recipient) {
        assert.notEqual(
            String(cached.value.recipient.touser || ''),
            'alice',
            'clear 后不得用旧 alice 写回 targetCache'
        );
    }

    // 第二次 force 发送必须读到 bob
    await notifier.sendNotification('rule-x', 't', 'm2', { msgType: 'text', force: true });
    assert.ok(calls.lastRecipient, '应有发送记录');
    assert.equal(
        String(calls.lastRecipient.touser || ''),
        'bob',
        'clear 后新发送应使用更新后的接收人 bob'
    );
});
