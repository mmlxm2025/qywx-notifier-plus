// 多应用（第三轮复验 P1-05）：规则页旧应用写响应会污染新应用状态。
//
// 读取路径已用 rulesGuard/membersGuard，但写路径只在冲突处理时检查 writeCode。
// 保存/启停/重生成/删除成功会无条件更新 currentAppVersion、清空表单并 loadRules()。
// 若用户在应用 A 的写请求等待期间切换到 B，A 的晚响应仍可改写 B 的版本和表单。
//
// 本测试用受控 Promise 模拟：A 写挂起 → 切换 B 完成读取 → A 写成功返回 →
// 断言 B 的 currentAppVersion、规则列表、表单均不变。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-third-fix-review-ai-execution-guide.md §4 P1-05。

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const rulesSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'rules.js'), 'utf8');

// 模拟规则页写响应归属的状态机（与 rules.js 成功分支语义一致）。
// 捕获 writeCode/writeGeneration，响应到达后只有上下文仍匹配才修改状态。
function makeRulesPageState() {
    return {
        currentCode: null,
        currentAppVersion: null,
        writeContext: null,  // { writeCode, writeGeneration }
        // 模拟的 DOM 状态。
        rulesList: [],
        formName: ''
    };
}

// 模拟当前 rules.js 的成功分支（bug 版）：无条件更新 currentAppVersion 并 loadRules。
function applyWriteSuccessBuggy(state, res, writeCode) {
    if (res.ok) {
        // BUG：不检查 writeCode === currentCode。
        if (res.version) state.currentAppVersion = res.version;
        state.rulesList = ['reloaded-for-' + state.currentCode];
        state.formName = '';
        return true;
    }
    return false;
}

// 修复后的成功分支（阶段 E）：检查 writeCode === currentCode。
function applyWriteSuccessFixed(state, res, writeCode) {
    if (res.ok) {
        if (writeCode && state.currentCode !== writeCode) {
            // 写发起时的应用已不是当前应用：不修改当前状态。
            return true;
        }
        if (res.version) state.currentAppVersion = res.version;
        state.rulesList = ['reloaded-for-' + state.currentCode];
        state.formName = '';
        return true;
    }
    return false;
}

test('P1-05: bug 复现——A 写成功晚返回会改写已切换到 B 的状态', async () => {
    const state = makeRulesPageState();
    // 初始在应用 A，版本 1。
    state.currentCode = 'app-A';
    state.currentAppVersion = 1;
    state.rulesList = ['rule-a1'];
    const writeCode = 'app-A';

    // 用户在 A 发起写请求（挂起）。
    // 同时切换到 B 并完成读取：currentCode=app-B, version=5。
    state.currentCode = 'app-B';
    state.currentAppVersion = 5;
    state.rulesList = ['rule-b1', 'rule-b2'];

    // A 的写成功响应晚返回（版本 2）。
    const aResponse = { ok: true, version: 2 };
    applyWriteSuccessBuggy(state, aResponse, writeCode);

    // BUG：A 的响应把 B 的 currentAppVersion 改成了 2，规则列表也被重载。
    assert.equal(state.currentAppVersion, 2, 'bug：B 的版本被 A 的响应覆盖为 2');
    assert.deepEqual(state.rulesList, ['reloaded-for-app-B'], 'bug：B 的规则被按 A 的触发重载');
});

test('P1-05: 修复后——A 写成功晚返回不改写 B 的状态', async () => {
    const state = makeRulesPageState();
    state.currentCode = 'app-A';
    state.currentAppVersion = 1;
    state.rulesList = ['rule-a1'];
    const writeCode = 'app-A';

    // 切换到 B。
    state.currentCode = 'app-B';
    state.currentAppVersion = 5;
    state.rulesList = ['rule-b1', 'rule-b2'];

    // A 的写成功响应晚返回。
    const aResponse = { ok: true, version: 2 };
    applyWriteSuccessFixed(state, aResponse, writeCode);

    // 修复后：B 的状态不变。
    assert.equal(state.currentAppVersion, 5, '修复后：B 的版本保持 5，不被 A 的响应影响');
    assert.deepEqual(state.rulesList, ['rule-b1', 'rule-b2'], '修复后：B 的规则列表不变');
});

test('P1-05: 修复后——同一应用内写成功正常更新', async () => {
    const state = makeRulesPageState();
    state.currentCode = 'app-A';
    state.currentAppVersion = 1;
    state.rulesList = ['rule-a1'];
    const writeCode = 'app-A';

    // 未切换，A 的写成功返回。
    applyWriteSuccessFixed(state, { ok: true, version: 2 }, writeCode);
    assert.equal(state.currentAppVersion, 2, '同应用内写成功应更新版本');
});

// 源码契约：rules.js 的写成功分支应检查 writeCode === currentCode。
test('P1-05: rules.js 写成功分支应检查 writeCode === currentCode（阶段 E 实现）', () => {
    // 当前 rules.js 的成功分支（saveRule/toggle/regenerate/delete）不检查 writeCode。
    // 阶段 E 应在成功分支加入 writeCode === currentCode 守卫。
    // 查找：success 分支内应有 currentCode === writeCode 或 writeCode === currentCode 检查。
    // 当前源码只在 handleRuleWriteConflict 中检查（冲突路径），成功路径不检查。
    const hasSuccessGuard = /if\s*\(\s*res\.ok\s*\)\s*\{[^}]*writeCode\s*===?\s*currentCode|currentCode\s*===?\s*writeCode/s.test(rulesSrc)
        || /writeCode\s*!==\s*currentCode|currentCode\s*!==\s*writeCode/.test(rulesSrc);
    // 注意：当前 handleRuleWriteConflict 已有 currentCode !== conflictCode 检查（冲突路径），
    // 但成功路径缺少。本断言要求成功路径也有守卫。
    // 简化：查找 saveRule 成功分支内是否有 writeCode 守卫。
    const saveRuleSuccessBlock = rulesSrc.match(/if\s*\(\s*res\.ok\s*\)\s*\{[\s\S]*?resetForm\(\)/);
    let successHasGuard = false;
    if (saveRuleSuccessBlock) {
        successHasGuard = /currentCode\s*[!=]==?\s*writeCode|writeCode\s*[!=]==?\s*currentCode/.test(saveRuleSuccessBlock[0]);
    }
    assert.ok(
        successHasGuard,
        'saveRule 成功分支应检查 writeCode === currentCode（阶段 E 实现，当前缺失）'
    );
});
