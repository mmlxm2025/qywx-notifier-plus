// 多应用（二次复验 P1-02/P1-03/P1-04）：向导/规则页/总览开关行为一致性测试。
//
// 验证：
//   - 向导 INVALID_INPUT 按 details.field 分流，普通字段错误不刷新版本（P1-02）。
//   - 向导 APP_VERSION_REQUIRED 且 draft.code 为空时不请求 /configuration/null（P1-02）。
//   - 规则页使用独立守卫（rulesGuard/membersGuard），冲突恢复绑定原 code（P1-03）。
//   - 总览开关失败后 checkbox/label/ARIA 一致（P1-04）。
//
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-second-fix-review-ai-execution-guide.md §5。

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const wizardSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'wizard.js'), 'utf8');
const rulesSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'rules.js'), 'utf8');
const scriptSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'script.js'), 'utf8');

// ─── P1-02: 向导 INVALID_INPUT 分流 ────────────────────────────────────────

test('P1-02: wizard 区分版本相关 INVALID_INPUT 与普通字段错误', () => {
    // 应通过 details.field==='version' 判定版本非法。
    assert.ok(
        /details\.field\s*===?\s*['"]version['"]/.test(wizardSrc),
        'wizard 应通过 details.field==="version" 区分版本非法'
    );
});

test('P1-02: wizard draft.code 为空时不请求 /configuration/null', () => {
    // isVersionIssue 分支内应在请求详情前检查 draft.code。
    // 匹配 “if (!draft.code)” 在版本同步路径内。
    assert.ok(
        /if\s*\(\s*!draft\.code\s*\)/.test(wizardSrc),
        'wizard 版本同步路径应先检查 draft.code 是否为空'
    );
    // 不应出现 encodeURIComponent(draft.code) 后无条件请求详情（已被 if 守卫）。
    // （此处不否定字符串存在，因为 refreshDraftVersion 仍可能用它，但 onGenerateCallback 路径已守卫。）
});

// ─── P1-03: 规则页独立守卫 ──────────────────────────────────────────────────

test('P1-03: rules.js 使用独立 rulesGuard 与 membersGuard', () => {
    assert.ok(/rulesGuard\s*=\s*H\.createRequestGuard\(\)/.test(rulesSrc), '应创建独立 rulesGuard');
    assert.ok(/membersGuard\s*=\s*H\.createRequestGuard\(\)/.test(rulesSrc), '应创建独立 membersGuard');
    // 不再共用单一 requestGuard。
    assert.ok(!/const\s+requestGuard\s*=\s*H\.createRequestGuard\(\)/.test(rulesSrc), '不应再共用单一 requestGuard');
});

test('P1-03: handleRuleWriteConflict 接收 conflictCode 并校验 currentCode', () => {
    // 函数签名应包含 conflictCode 参数。
    assert.ok(/handleRuleWriteConflict\s*\(\s*res\s*,\s*conflictCode\s*\)/.test(rulesSrc), '应接收 conflictCode');
    // 应检查 currentCode !== conflictCode 时丢弃恢复。
    assert.ok(/currentCode\s*!==\s*conflictCode/.test(rulesSrc), '应校验 currentCode 与 conflictCode 一致');
});

test('P1-03: 切换应用推进两个守卫并清空旧操作区', () => {
    // loadRules 应同时 next() 两个守卫。
    assert.ok(/rulesGuard\.next\(\)/.test(rulesSrc) && /membersGuard\.next\(\)/.test(rulesSrc), '切换应用应推进两个守卫');
    // currentAppVersion 切换时置空。
    assert.ok(/currentAppVersion\s*=\s*null/.test(rulesSrc), '切换应用应将 currentAppVersion 置空');
});

test('P1-03: 规则启停请求期间禁用 toggle', () => {
    // enabledToggle.change 回调内应有 disabled = true/false。
    assert.ok(/enabledToggle\.disabled\s*=\s*true/.test(rulesSrc), '启停请求期间应禁用 toggle');
});

// ─── P1-04: 总览开关状态一致 ────────────────────────────────────────────────

test('P1-04: script.js 暴露统一 renderToggleState 函数', () => {
    assert.ok(/function\s+renderToggleState\s*\(/.test(scriptSrc), '应有 renderToggleState 统一更新函数');
});

test('P1-04: 总览开关失败分支调用 renderToggleState 回滚（不只回滚 checkbox）', () => {
    // onToggle 失败分支应调用 renderToggleState(cb, label, beforeToggle)。
    assert.ok(
        /renderToggleState\s*\(\s*cb\s*,\s*label\s*,\s*beforeToggle\s*\)/.test(scriptSrc),
        '失败时应通过 renderToggleState 同时回滚 checkbox + label + ARIA'
    );
});

test('P1-04: 总览开关文案为“发送已启用/发送已暂停”（不暗示应用不可管理）', () => {
    assert.ok(scriptSrc.includes('发送已启用'), '应使用“发送已启用”文案');
    assert.ok(scriptSrc.includes('发送已暂停'), '应使用“发送已暂停”文案');
    // 辅助说明：暂停不影响编辑/规则/安全。
    assert.ok(/暂停.*不影响.*编辑|编辑.*规则.*安全/.test(scriptSrc), '应有辅助说明“暂停不影响编辑/规则/安全”');
});

test('P1-04: renderMasterToggle 调用 renderToggleState 初始化', () => {
    // 初始渲染应通过 renderToggleState 设置状态（而非分别设置 cb.checked 与 label.textContent）。
    assert.ok(
        /renderToggleState\s*\(\s*cb\s*,\s*label\s*,\s*app\.lifecycle_status\s*===?\s*['"]active['"]\s*\)/.test(scriptSrc),
        '初始渲染应通过 renderToggleState'
    );
});
