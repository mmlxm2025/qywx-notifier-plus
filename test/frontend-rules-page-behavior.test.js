// 阶段 A（先补会失败的测试）：规则页公共组件迁移契约（P1-02）。
//
// 设计 §3.6 要求规则页迁移到共享基础设施：
//   - 删除重复安全设置（code-send-panel / notify-key-panel 应在编辑页唯一管理）。
//   - 用 AppHttp 取代本地 requestJson 和裸 fetch。
//   - 用 AppModal 取代 window.confirm。
//   - 规则写请求携带版本（If-Match），成功采用服务端 app_version。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-code-review-fix-guide.md §3.6。

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'rules.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'rules.js'), 'utf8');

// ─── P1-02: 删除重复安全设置 ────────────────────────────────────────────

test('P1-02: rules.html 不再包含重复的安全设置面板（code-send-panel / notify-key-panel）', () => {
    assert.ok(!html.includes('code-send-panel'),
        'Code 发送开关面板应移至编辑页，规则页不应重复：发现 code-send-panel');
    assert.ok(!html.includes('notify-key-panel'),
        '通知密钥面板应移至编辑页，规则页不应重复：发现 notify-key-panel');
});

test('P1-02: rules.html 保留前往编辑页管理安全设置的入口', () => {
    // 应用上下文区保留“在编辑页管理安全设置”链接（单一编辑位置）。
    assert.match(html, /安全设置/, '应保留前往编辑页管理安全设置的入口链接');
});

// ─── P1-02: 接入共享基础设施 ──────────────────────────────────────────

test('P1-02: rules.html 引入 styles.css / http.js / topnav / modal / toast', () => {
    assert.ok(html.includes('/public/styles.css'), '应引入统一 styles.css');
    assert.ok(html.includes('/public/http.js'), '应引入 AppHttp');
    assert.ok(html.includes('/public/topnav.js'), '应引入统一 topnav');
    assert.ok(html.includes('/public/components/modal.js'), '应引入 AppModal');
    assert.ok(html.includes('/public/components/toast.js'), '应引入 AppToast');
});

test('P1-02: rules.js 使用 AppHttp（不再定义本地 requestJson）', () => {
    assert.ok(!/function\s+requestJson\s*\(/.test(script),
        '应移除本地 requestJson，改用 window.AppHttp');
    assert.match(script, /window\.AppHttp|AppHttp/, '应使用 AppHttp');
});

test('P1-02: rules.js 不再使用裸 fetch 做管理操作', () => {
    // 管理读写（规则、配置、成员）应通过 AppHttp，不再定义本地 requestJson。
    // 唯一例外：/api/auth-status 首屏会话探测（与 edit.js 一致）允许使用原生 fetch。
    const fetchCount = (script.match(/\bfetch\s*\(/g) || []).length;
    assert.ok(fetchCount <= 1, `迁移后最多保留 1 处 auth-status fetch，实际: ${fetchCount}`);
    // 禁止在管理路径用 fetch（除 auth-status 外）。
    assert.doesNotMatch(script, /requestJson\s*=\s*async/, '禁止定义本地 requestJson');
});

test('P1-02: rules.js 不再使用 window.confirm / 裸 confirm', () => {
    // 禁止 window.confirm(...) 与裸 confirm(...)（直接作为函数调用）。
    // 允许 modal.confirm / AppModal.confirm（这些是公共组件方法）。
    assert.doesNotMatch(script, /window\.confirm\s*\(/, '禁止 window.confirm');
    // 裸 confirm：行首或非字母/点之后直接调用 confirm(。
    assert.doesNotMatch(script, /(^|[^.\w])confirm\s*\(/, '应使用 AppModal.confirm 取代裸 confirm');
});

test('P1-02: rules.js 危险操作使用 AppModal', () => {
    assert.match(script, /AppModal|modal\.confirm/, '危险操作（删除/重生成）应使用 AppModal');
});

// ─── P1-02 / P0-03: 规则写请求携带版本 ──────────────────────────────────

test('P0-03: rules.js 规则写操作携带版本（If-Match via AppHttp）', () => {
    // 规则增删改/启停/重生成应携带 version，不本地猜版本号。
    assert.match(script, /version/, '规则写应携带版本');
    // 至少一处规则写请求带 version 选项。
    assert.match(script, /\{\s*version/, '应通过 AppHttp 传入 version 选项');
});

test('P0-03: rules.js 成功后采用服务端 app_version（不本地 +1）', () => {
    // 服务端规则写返回 app_version，前端应采用 res.version / res.app_version。
    assert.match(script, /app_version|res\.version/, '应采用服务端返回的版本');
    assert.doesNotMatch(script, /currentAppVersion\s*\+\s*1|version\s*\+\s*1/,
        '禁止本地 +1 推导版本');
});
