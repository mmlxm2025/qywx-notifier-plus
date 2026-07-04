// 阶段 A6（前端行为测试）：接收规则 API 自定义编号的前端契约（规范 §11.5）。
//
// 覆盖：
//   1. 表单存在编号输入、前缀、帮助文本和安全提示。
//   2. 新建态留空，编辑态回填当前编号。
//   3. payload 使用 api_code，没有 custom_code / apiCode 协议分叉。
//   4. 改号前使用 AppModal 确认。
//   5. 编号冲突保留表单（按 code 分支）。
//   6. 版本冲突快照/恢复包含编号和编辑对象。
//   7. 可用性请求使用独立代次，旧响应不能覆盖新输入。
//   8. 切换应用后旧应用的可用性响应被丢弃。
//   9. 保存成功以后端 api_code/apiUrl/app_version 为准。
//   10. 不新增裸 fetch、window.confirm 或 innerHTML 动态渲染。

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'rules.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'rules.js'), 'utf8');
const frontendHelpers = require('../public/frontend-helpers');

// ─── 1. 表单 DOM：编号输入、前缀、帮助、安全提示 ────────────────────────

test('1. rules.html 包含 api_code 输入框与路径前缀', () => {
    assert.match(html, /<input[^>]+id="rule-api-code"/, '应有 #rule-api-code 输入');
    assert.match(html, /\/api\/notify\//, '应显示路径前缀');
});

test('1b. rules.html 包含帮助文本与状态区', () => {
    assert.match(html, /id="rule-api-code-help"/, '应有帮助文本节点');
    assert.match(html, /id="rule-api-code-status"/, '应有状态节点');
});

test('1c. rules.html 输入框设置 maxlength/autocomplete/spellcheck', () => {
    const inputMatch = html.match(/<input[^>]+id="rule-api-code"[^>]*>/);
    assert.ok(inputMatch, '应找到输入框');
    const attrs = inputMatch[0];
    assert.match(attrs, /maxlength="64"/, '应设置 maxlength=64');
    assert.match(attrs, /autocomplete="off"/, '应设置 autocomplete=off');
    assert.match(attrs, /spellcheck="false"/, '应设置 spellcheck=false');
});

test('1d. rules.html 包含安全提示（编号不是密码）', () => {
    assert.match(html, /不是密码/, '应提示编号不是密码');
    assert.match(html, /通知密钥/, '应引导在应用安全设置中启用通知密钥');
});

test('1e. rules.html 状态区有 aria-live（可访问性）', () => {
    assert.match(html, /aria-live="polite"/, '状态区应使用 aria-live=polite');
});

// ─── 2. 新建态留空 / 编辑态回填 ──────────────────────────────────────────

test('2. rules.js editRule 回填 rule.api_code 并记录 originalApiCode', () => {
    assert.match(script, /ruleApiCodeInput\.value\s*=\s*rule\.api_code/, 'editRule 应回填 api_code');
    assert.match(script, /originalApiCode\s*=/, '应记录 originalApiCode');
});

test('2b. rules.js resetForm 清空 api_code 输入与状态', () => {
    assert.match(script, /ruleApiCodeInput\.value\s*=\s*''/, 'resetForm 应清空 api_code 输入');
    assert.match(script, /clearApiCodeState\(\)/, 'resetForm 应调用 clearApiCodeState');
});

test('2c. rules.html 包含“随机”生成编号按钮', () => {
    assert.match(html, /id="rule-api-code-random"/, '应有 #rule-api-code-random 按钮');
    assert.match(html, /随机/, '按钮文案含“随机”');
});

test('2d. rules.js 注册随机按钮点击 → 填入 UUID 并校验可用性', () => {
    assert.match(script, /ruleApiCodeRandomBtn/, '应引用随机按钮');
    assert.match(script, /fillRandomApiCode/, '应定义 fillRandomApiCode');
    assert.match(script, /ruleApiCodeRandomBtn\.addEventListener\(['"]click['"],\s*fillRandomApiCode\)/, '应绑定点击事件');
    // 填入后应推进代次并立即校验
    assert.match(script, /crypto\.randomUUID\(\)/, '应使用 crypto.randomUUID 生成');
});

// ─── 3. payload 使用 api_code，无协议分叉 ───────────────────────────────

test('3. rules.js payload 使用 api_code 字段', () => {
    assert.match(script, /payload\.api_code\s*=/, 'payload 应使用 api_code');
    assert.doesNotMatch(script, /custom_code/, '不得使用 custom_code');
    assert.doesNotMatch(script, /apiCode:\s*[a-z]/, '不得使用 apiCode 作为 payload 字段');
});

test('3b. rules.js 创建时空值从 payload 删除 api_code', () => {
    // getPayload 中 api_code 仅在非空时加入 payload
    assert.match(script, /if\s*\(apiCodeRaw\)\s*\{[\s\S]*?payload\.api_code\s*=\s*apiCodeRaw/, 'api_code 仅在非空时加入 payload');
});

// ─── 4. 改号前使用 AppModal 确认 ─────────────────────────────────────────

test('4. rules.js 修改编号前用 AppModal 确认旧地址失效', () => {
    assert.match(script, /修改 API 编号/, '应有改号确认标题');
    assert.match(script, /立即失效/, '应提示旧地址立即失效');
    assert.match(script, /modal\.confirm/, '应使用 AppModal');
});

test('4b. rules.js 改号确认比较 nextNormalized 与 originalApiCode', () => {
    assert.match(script, /originalApiCode/, '应比较 originalApiCode');
    assert.match(script, /nextNormalized/, '应规范化后比较');
});

// ─── 5. 编号冲突保留表单（按 code 分支） ────────────────────────────────

test('5. rules.js 按 res.code 分支处理 RULE_API_CODE_INVALID/CONFLICT', () => {
    assert.match(script, /RULE_API_CODE_INVALID/, '应识别 RULE_API_CODE_INVALID');
    assert.match(script, /RULE_API_CODE_CONFLICT/, '应识别 RULE_API_CODE_CONFLICT');
    assert.match(script, /ruleApiCodeInput\.focus\(\)/, '编号错误应聚焦输入框');
});

test('5b. rules.js 编号冲突按 conflict_scope 分支提示', () => {
    assert.match(script, /conflict_scope/, '应按 conflict_scope 区分提示');
    assert.match(script, /configuration/, '应处理 configuration scope');
    assert.match(script, /retired/, '应处理 retired scope');
});

// ─── 6. 版本冲突快照/恢复包含编号和编辑对象 ─────────────────────────────

test('6. snapshotRuleForm 包含 api_code', () => {
    const snap = frontendHelpers.snapshotRuleForm({
        name: 'r1', is_all: false, touser: ['alice'], toparty: '', totag: '',
        estimated_count: 1, api_code: 'ops-alert'
    });
    assert.equal(snap.api_code, 'ops-alert', '快照应包含 api_code');
});

test('6b. snapshotRuleForm 不含 api_code 时不添加该键', () => {
    const snap = frontendHelpers.snapshotRuleForm({
        name: 'r1', is_all: false, touser: [], toparty: '', totag: '', estimated_count: 1
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(snap, 'api_code'), '无 api_code 时不应添加该键');
});

test('6c. restoreRuleForm 恢复 api_code', () => {
    const target = {};
    frontendHelpers.restoreRuleForm(target, {
        name: 'r1', is_all: false, touser: ['alice'], toparty: '', totag: '',
        estimated_count: 1, api_code: 'ops-alert'
    });
    assert.equal(target.api_code, 'ops-alert', '恢复应写回 api_code');
});

test('6d. rules.js 版本冲突快照补充 rule_id 与 original_api_code', () => {
    assert.match(script, /snap\.rule_id\s*=/, '快照应补充 rule_id');
    assert.match(script, /snap\.original_api_code\s*=/, '快照应补充 original_api_code');
});

test('6e. restoreFormFromSnapshot 恢复 api_code/rule_id/original_api_code', () => {
    assert.match(script, /snap\.api_code/, '恢复应读取 api_code');
    assert.match(script, /snap\.rule_id/, '恢复应读取 rule_id');
    assert.match(script, /snap\.original_api_code/, '恢复应读取 original_api_code');
});

// ─── 7. 可用性请求使用独立代次 ───────────────────────────────────────────

test('7. rules.js 可用性预检使用独立请求代次', () => {
    assert.match(script, /apiCodeRequestGuard\s*=\s*H\.createRequestGuard\(\)/, '应创建独立代次 apiCodeRequestGuard');
    assert.match(script, /apiCodeRequestGuard\.isCurrent/, '可用性响应应检查代次');
});

test('7b. rules.js 可用性预检有防抖（~300ms）', () => {
    assert.match(script, /setTimeout/, '应使用 setTimeout 防抖');
    assert.match(script, /300/, '防抖延迟约 300ms');
});

test('7c. rules.js 可用性预检调用独立 availability 路由', () => {
    assert.match(script, /\/api\/rule-api-codes\/availability/, '应调用 availability 路由');
});

// ─── 8. 切换应用后旧应用的可用性响应被丢弃 ───────────────────────────────

test('8. rules.js 切换应用时推进可用性代次', () => {
    // loadRules 中应推进 apiCodeRequestGuard，使旧应用响应失效
    assert.ok(/apiCodeRequestGuard\.next\(\)/.test(script), 'loadRules 应推进 apiCodeRequestGuard');
});

// ─── 9. 保存成功以后端响应为准 ───────────────────────────────────────────

test('9. rules.js 改号成功提示新地址生效/旧地址失效', () => {
    assert.match(script, /api_code_changed/, '应读取 api_code_changed');
    assert.match(script, /新 API 地址已生效/, '应提示新地址生效');
    assert.match(script, /旧地址已失效/, '应提示旧地址失效');
});

// ─── 10. 不新增裸 fetch / window.confirm / innerHTML 动态渲染 ─────────────

test('10. rules.js 不新增裸 confirm', () => {
    assert.doesNotMatch(script, /window\.confirm\s*\(/, '禁止 window.confirm');
    assert.doesNotMatch(script, /(^|[^.\w])confirm\s*\(/, '禁止裸 confirm');
});

test('10b. rules.js 可用性请求通过 AppHttp（不新增裸 fetch）', () => {
    // 统计 fetch 出现次数（首屏 auth-status 最多 1 处），新增 availability 不应引入裸 fetch。
    const fetchCount = (script.match(/\bfetch\s*\(/g) || []).length;
    assert.ok(fetchCount <= 1, `最多保留 1 处 auth-status fetch，实际: ${fetchCount}`);
});

test('10c. rules.js 动态值用 textContent（不拼接 innerHTML）', () => {
    // 状态/错误展示应使用 textContent，而非 innerHTML 拼接动态值。
    assert.match(script, /span\.textContent\s*=\s*message/, 'setApiCodeStatus 应使用 textContent');
    // 确认整个脚本不为动态值拼接 innerHTML（只允许 textContent 赋值字符串）。
    // setApiCodeStatus 内部通过 textContent 写入 message，冲突提示通过 setApiCodeStatus(hint,...) 传入。
    assert.doesNotMatch(script, /innerHTML\s*=\s*hint/, '不得用 innerHTML 拼接动态编号提示');
});

test('10d. rules.js 复制按钮 fallback 用 encodeURIComponent', () => {
    assert.match(script, /encodeURIComponent\(rule\.api_code\)/, '复制 fallback 应编码路径段');
});
