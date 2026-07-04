// 阶段 A（先补会失败的测试）：新建向导路由契约（P0-04 前端侧）。
//
// 验证 wizard.js 在与后端交互时正确传递版本与草稿标识：
//   - generate-callback 更新草稿时携带 draft_code + version（P0-04）。
//   - complete-config 携带 version（P0-04）。
//   - 跳转 /new?code=、/edit?code= 一致。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-code-review-fix-guide.md §3.2。

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const wizard = fs.readFileSync(path.join(__dirname, '..', 'public', 'wizard.js'), 'utf8');

test('P0-04: wizard generate-callback 更新草稿时携带 draft_code 与 version', () => {
    // 回调生成请求体应包含 draft_code 与 version（当已有草稿时）。
    assert.match(wizard, /draft_code/, '应发送 draft_code');
    assert.match(wizard, /version/, '应发送 version');
    // 更新草稿分支：if (draft.code) 注入 draft_code + version。
    assert.match(wizard, /if\s*\(\s*draft\.code\s*\)/, '应在已有草稿时注入 draft_code/version');
});

test('P0-04: wizard complete-config 携带 version', () => {
    assert.match(wizard, /\/api\/complete-config/, '应调用 complete-config');
    // 请求体应包含 version: draft.version。
    assert.match(wizard, /version:\s*draft\.version/, '完成请求应携带 version');
});

test('P0-04: wizard 成功后采用服务端返回的 version（不本地 +1）', () => {
    // generate-callback 成功分支应保存 res.data.version 到 draft.version。
    assert.match(wizard, /draft\.version\s*=\s*res\.data\.version/, '应采用服务端版本，而非本地 +1');
});

test('wizard 跳转使用 /new?code= 与 /edit?code= 一致', () => {
    assert.match(wizard, /\/new\?code=/);
    assert.match(wizard, /\/edit\?code=/);
});

test('wizard 不本地猜版本号（不出现 version + 1 之类本地推导）', () => {
    // 禁止在客户端推导版本号：必须采用服务端返回值。
    assert.doesNotMatch(wizard, /version\s*\+\s*1/, '禁止本地 version + 1 推导');
});
