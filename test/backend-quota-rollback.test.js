// 多应用（二次复验 P1-05）：成员限频拒绝不应永久占用当日应用额度。
//
// 复验文档 §4 P1-05：trackAppDaily 先执行，随后 trackExplicitMembers 可直接抛错；
// 这个抛错发生在现有 try/catch 之前，当日额度没有回滚。结果：第二次请求没有发送，
// 但第三次发给另一个成员也被每日额度拒绝。
//
// 本测试用桩 WeChat + 桩 DB，模拟 member minute limit 触发，
// 断言：成员限频失败后，当日额度（trackAppDaily 的预占）被回滚。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-second-fix-review-ai-execution-guide.md §4 P1-05。

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
        code: 'app-quota',
        corpid: 'corp-quota',
        encrypted_corpsecret: 'encrypted-secret',
        agentid: 100001,
        touser: 'alice',
        description: '',
        callback_enabled: 0,
        code_send_enabled: 1,
        app_enabled: 1,
        version: 1,
        ...overrides
    };
}

function setupNotifier(t, { config } = {}) {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    // P1-05：设置小的额度阈值便于触发。
    withEnv(t, 'WECHAT_APP_DAILY_PERSON_LIMIT', '2');
    withEnv(t, 'WECHAT_MEMBER_MINUTE_LIMIT', '1');

    const Database = require('../src/core/database');
    const CryptoService = require('../src/core/crypto');
    const WeChatService = require('../src/core/wechat');

    // 支持 code -> config 映射（可塞入多个 code 测试不同接收人）。
    const cfgStore = { [config.code]: { ...config } };
    const calls = { sent: [], tokens: [] };

    replaceForTest(t, Database.prototype, 'init', async function () {});
    replaceForTest(t, Database.prototype, 'getConfigurationByCode', async function (code) {
        const r = cfgStore[code];
        return r ? { ...r } : null;
    });
    replaceForTest(t, Database.prototype, 'getNotificationRuleByApiCode', async function () { return null; });

    replaceForTest(t, CryptoService.prototype, 'decrypt', function (v) { return String(v).replace(/^encrypted-/, ''); });
    replaceForTest(t, CryptoService.prototype, 'encrypt', function (v) { return `encrypted-${v}`; });
    replaceForTest(t, CryptoService.prototype, 'isLegacyCiphertext', function () { return false; });

    replaceForTest(t, WeChatService.prototype, 'getToken', async function (corpid, secret) {
        calls.tokens.push({ corpid, secret });
        return 'access-token';
    });
    replaceForTest(t, WeChatService.prototype, 'getAgentInfo', async (tok, id) => ({ agentid: id }));
    replaceForTest(t, WeChatService.prototype, 'getAgentVisibleUsers', async () => []);
    replaceForTest(t, WeChatService.prototype, 'sendTextMessage', async function (tok, agentid, recipient, msg) {
        calls.sent.push({ tok, agentid, recipient, msg });
        return { errcode: 0, errmsg: 'ok', msgid: 'm-' + calls.sent.length };
    });
    replaceForTest(t, WeChatService.prototype, 'invalidateToken', async () => {});

    clearModule('../src/services/notifier');
    t.after(() => {
        clearModule('../src/services/notifier');
        clearModule('../src/api/routes');
    });
    const notifier = require('../src/services/notifier');
    return { notifier, calls, cfgStore };
}

test('P1-05: 成员限频失败后回滚当日额度，不永久占用', async t => {
    // 用两个不同 code 避免发送去重缓存/目标缓存互相干扰；
    // 但同 (corpid, agentid) 共享当日额度桶。
    const aliceConfig = completedConfig({ code: 'app-alice', touser: 'alice' });
    const { notifier, calls, cfgStore } = setupNotifier(t, { config: aliceConfig });
    cfgStore['app-bob'] = completedConfig({ code: 'app-bob', touser: 'bob' });

    // 第一次：alice 成功发送（消耗 1 次当日额度，并预占 alice 每分钟额度）。
    await notifier.sendNotification('app-alice', 't1', 'c1', { msgType: 'text' });
    assert.equal(calls.sent.length, 1, '第一次应成功发送');

    // 第二次：alice 再次发送——同分钟内触发 MEMBER_MINUTE_LIMIT=1，应抛 429。
    // 关键：这次 trackAppDaily 预占了当日额度，但 trackExplicitMembers 抛错；
    // P1-05 要求：trackExplicitMembers 失败后回滚 trackAppDaily 的预占，否则当日额度被幽灵占用。
    // 用 force 避免被发送去重缓存吞掉（同一内容会被去重）。
    let caught2 = null;
    try {
        await notifier.sendNotification('app-alice', 't2', 'c2-unique', { msgType: 'text', force: true });
    } catch (err) { caught2 = err; }
    assert.ok(caught2, '第二次（成员限频）应抛错');
    assert.equal(caught2.statusCode, 429, '应为 429 限频');
    assert.equal(calls.sent.length, 1, '成员限频时不应实际发送');

    // 第三次：改发给 bob（不同成员，无每分钟限制）。
    // P1-05 核心：如果第二次的当日额度已回滚，第三次应成功（额度剩余 2-1=1）。
    // 如果没回滚（bug），第三次会因当日额度耗尽（2 已被前两次占用）而 429。
    const res3 = await notifier.sendNotification('app-bob', 't3', 'c3', { msgType: 'text' });
    assert.ok(res3, '第三次（bob）应成功发送，证明成员限频失败已回滚当日额度');
    assert.equal(calls.sent.length, 2, 'bob 发送应实际调用企业微信');
});
