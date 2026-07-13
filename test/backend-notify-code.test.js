// 阶段 A：编号规范化单元测试（规范 §11.1）
//
// 覆盖 normalizeRuleApiCode / isValidRuleApiCode / generateNotifyCode 的全部边界。
// 这些测试锁定对外格式契约，前端必须镜像同一套规则。

const assert = require('assert/strict');
const test = require('node:test');

const {
    normalizeRuleApiCode,
    isValidRuleApiCode,
    generateNotifyCode,
    MIN_LENGTH,
    MAX_LENGTH
} = require('../src/core/notify-code');

test('normalizeRuleApiCode：大小写规范化与首尾空白裁剪', () => {
    assert.equal(normalizeRuleApiCode('Ops-Alert'), 'ops-alert');
    assert.equal(normalizeRuleApiCode('  Prod_001  '), 'prod_001');
    assert.equal(normalizeRuleApiCode('OPS_ALERT'), 'ops_alert');
});

test('normalizeRuleApiCode：合法编号', () => {
    assert.equal(normalizeRuleApiCode('abc'), 'abc');
    assert.equal(normalizeRuleApiCode('a_b'), 'a_b');
    assert.equal(normalizeRuleApiCode('10086'), '10086');
    assert.equal(normalizeRuleApiCode('ops-alert'), 'ops-alert');
    assert.equal(normalizeRuleApiCode('prod_001'), 'prod_001');
});

test('normalizeRuleApiCode：长度边界合法值', () => {
    // 3 位最小长度
    assert.equal(normalizeRuleApiCode('abc'), 'abc');
    // 64 位最大长度（中间允许 - 与 _）
    const max = 'a' + 'b'.repeat(62) + 'c';
    assert.equal(max.length, 64);
    assert.equal(normalizeRuleApiCode(max), max);
});

test('normalizeRuleApiCode：长度非法抛 RULE_API_CODE_INVALID', () => {
    for (const tooShort of ['ab', 'a1']) {
        assert.throws(
            () => normalizeRuleApiCode(tooShort),
            (err) => err.businessCode === 'RULE_API_CODE_INVALID'
                && err.statusCode === 400
                && err.details && err.details.min_length === MIN_LENGTH
        );
    }
    // 65 位
    const tooLong = 'a' + 'b'.repeat(63) + 'c';
    assert.equal(tooLong.length, 65);
    assert.throws(
        () => normalizeRuleApiCode(tooLong),
        (err) => err.businessCode === 'RULE_API_CODE_INVALID'
            && err.details && err.details.max_length === MAX_LENGTH
    );
});

test('normalizeRuleApiCode：首尾连字符/下划线非法', () => {
    for (const bad of ['-ops', 'ops-', '_ops', 'ops_', '-ops-', '_ops_']) {
        assert.throws(
            () => normalizeRuleApiCode(bad),
            (err) => err.businessCode === 'RULE_API_CODE_INVALID'
        );
    }
});

test('normalizeRuleApiCode：禁止字符非法', () => {
    const illegal = [
        '生产告警',       // 中文
        'ops alert',      // 空格
        'ops.alert',      // 点
        'ops/alert',      // 斜杠
        '%2F',            // URL 编码片段
        '/api/notify/ops', // 完整 URL 路径
        'ops?alert',      // 问号
        'ops#alert',      // 井号
        'a\\b',           // 反斜杠
        'ops%alert'       // 百分号
    ];
    for (const bad of illegal) {
        assert.throws(
            () => normalizeRuleApiCode(bad),
            (err) => err.businessCode === 'RULE_API_CODE_INVALID',
            `应拒绝非法编号: ${bad}`
        );
    }
});

test('normalizeRuleApiCode：null/对象/数组不产生有效编号', () => {
    // null/对象/数组应在规范化前被拒绝，绝不能产出 [object Object]
    assert.throws(() => normalizeRuleApiCode(null), (err) => err.businessCode === 'RULE_API_CODE_INVALID');
    assert.throws(() => normalizeRuleApiCode(undefined), (err) => err.businessCode === 'RULE_API_CODE_INVALID');
    assert.throws(() => normalizeRuleApiCode({ foo: 'bar' }), (err) => err.businessCode === 'RULE_API_CODE_INVALID');
    assert.throws(() => normalizeRuleApiCode(['ops-alert']), (err) => err.businessCode === 'RULE_API_CODE_INVALID');
    // 防御：确认对象输入不会产出 [object Object]
    let caught = null;
    try { normalizeRuleApiCode({ foo: 'bar' }); } catch (e) { caught = e; }
    assert.ok(caught, '对象输入应抛错');
    assert.ok(!/object Object/i.test(caught.message), '错误信息不得泄漏 [object Object] 作为编号');
});

test('normalizeRuleApiCode：空白串抛错（语义由上层解释）', () => {
    assert.throws(() => normalizeRuleApiCode('   '), (err) => err.businessCode === 'RULE_API_CODE_INVALID');
    assert.throws(() => normalizeRuleApiCode('\t\n'), (err) => err.businessCode === 'RULE_API_CODE_INVALID');
});

test('isValidRuleApiCode：纯布尔判定，不抛错', () => {
    assert.equal(isValidRuleApiCode('ops-alert'), true);
    assert.equal(isValidRuleApiCode('Ops-Alert'), true); // 内部规范化后判定
    assert.equal(isValidRuleApiCode('10086'), true);
    assert.equal(isValidRuleApiCode('ab'), false);        // 太短
    assert.equal(isValidRuleApiCode('-ops'), false);      // 首字符非法
    assert.equal(isValidRuleApiCode('ops alert'), false); // 空格
    assert.equal(isValidRuleApiCode(null), false);
    assert.equal(isValidRuleApiCode(undefined), false);
    assert.equal(isValidRuleApiCode({}), false);
    assert.equal(isValidRuleApiCode([1, 2]), false);
});

test('generateNotifyCode：返回 UUID 形式字符串', () => {
    const code = generateNotifyCode();
    assert.equal(typeof code, 'string');
    assert.match(code, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // 生成的 UUID 应能通过自身校验
    assert.equal(isValidRuleApiCode(code), true);
});
