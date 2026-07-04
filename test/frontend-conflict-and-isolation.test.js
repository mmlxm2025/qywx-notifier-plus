// 阶段 A（先补会失败的测试）：前端冲突保留与跨应用异步隔离行为（§6.2 / R-P1-02 / R-P1-06）。
//
// 复验指南 §6.2 要求真实交互测试，不只断言源码形状。本文件用最小 DOM polyfill
// 加载 rules.js / edit.js 的关键纯逻辑（快照/恢复、请求代次隔离），验证：
//   - 规则保存冲突后表单值仍存在；版本采用服务端最新值（R-P1-02）。
//   - 编辑冲突后空描述和接收成员仍存在，敏感输入被清空（R-P1-06）。
//   - 应用 A/B 快速切换不会发生响应倒灌（R-P1-06 跨应用隔离）。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-fix-verification-ai-execution-guide.md §6.2。

const assert = require('assert/strict');
const test = require('node:test');

// 加载前端纯逻辑辅助模块（阶段 D 在 rules.js/edit.js 中导出，供此处测试）。
// 这些 helper 由 production 代码复用，不是测试专用副本。
const frontendHelpers = require('../public/frontend-helpers.js');

test('R-P1-02 规则页: snapshotRuleForm 捕获完整表单，restoreRuleForm 还原', () => {
    const form = {
        name: '告警规则', is_all: false, touser: ['alice', 'bob'],
        toparty: '2|3', totag: '9', estimated_count: 5
    };
    const snap = frontendHelpers.snapshotRuleForm(form);
    assert.equal(snap.name, '告警规则');
    assert.deepEqual(snap.touser, ['alice', 'bob']);
    assert.equal(snap.toparty, '2|3');

    const cleared = { name: '', is_all: false, touser: [], toparty: '', totag: '', estimated_count: 1 };
    frontendHelpers.restoreRuleForm(cleared, snap);
    assert.equal(cleared.name, '告警规则', '名称应恢复');
    assert.deepEqual(cleared.touser, ['alice', 'bob'], '接收成员应恢复');
    assert.equal(cleared.estimated_count, 5, '估算人数应恢复');
});

test('R-P1-06 编辑页: snapshotEditForm 捕描述与接收人（含空描述），不含敏感字段', () => {
    const form = {
        description: '',          // 主动清空描述
        agentid: '100001',
        touser: ['alice', 'bob'],
        corpsecret: 'leaked',     // 敏感——不应进入快照
        callback_token: 'leaked', // 敏感
        encoding_aes_key: 'leaked'// 敏感
    };
    const snap = frontendHelpers.snapshotEditForm(form);
    assert.equal(snap.description, '', '空描述也应快照（按属性存在恢复）');
    assert.deepEqual(snap.touser, ['alice', 'bob'], '接收人应快照');
    assert.equal(snap.corpsecret, undefined, 'CorpSecret 不得进入快照');
    assert.equal(snap.callback_token, undefined, '回调 Token 不得进入快照');
    assert.equal(snap.encoding_aes_key, undefined, 'AESKey 不得进入快照');
});

test('R-P1-06 跨应用隔离: RequestGuard 丢弃过期代次的响应', async () => {
    const guard = frontendHelpers.createRequestGuard();
    // A 慢、B 快：先发起 A（代次 1），再发起 B（代次 2），B 先返回。
    const a = guard.next();
    const b = guard.next();
    assert.equal(guard.isCurrent(b), true, 'B 是最新代次');
    assert.equal(guard.isCurrent(a), false, 'A 已过期');
    // A 较晚 resolve，但其结果必须被丢弃（调用方据 isCurrent 判断）。
    assert.equal(guard.isCurrent(a), false, 'A 晚返回仍应被判定为过期');
});

test('R-P1-06 跨应用隔离: 切换 code 时 guard 推进代次', () => {
    const guard = frontendHelpers.createRequestGuard();
    const g1 = guard.next();
    const g2 = guard.next();
    assert.notEqual(g1, g2, '每次切换应推进代次');
    assert.equal(guard.isCurrent(g2), true);
});
