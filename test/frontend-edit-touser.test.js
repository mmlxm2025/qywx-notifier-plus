// 多应用管理（2026-07-04 §7.2）：应用总览页 script.js 契约冒烟测试。
//
// 本文件原为旧版首页（两步创建 + 查找 + 内嵌编辑）的 DOM 模拟行为测试。
// 阶段4 已将首页重构为应用总览（创建迁移到 /new 向导、编辑迁移到 /edit），
// 旧的 lookupForm/edit-section 等结构已按设计文档 §7.1 删除。
//
// 这里改为对总览页 script.js 做静态契约检查：确保它只使用新契约，
// 不再引用已删除的旧元素，且依赖的公共组件与 API 路径正确。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const scriptPath = path.join(__dirname, '..', 'public', 'script.js');
const source = fs.readFileSync(scriptPath, 'utf8');

test('总览页 script.js 可加载且引用新 API 契约', () => {
    // 必须调用 /api/configurations（唯一的应用列表入口，§6.7）。
    assert.ok(source.includes('/api/configurations'), '应通过 /api/configurations 加载应用列表');
    // 必须读取服务端 lifecycle_status / capabilities / warnings（§4.5 单一事实来源）。
    assert.ok(source.includes('lifecycle_status'), '应读取 lifecycle_status');
    assert.ok(source.includes('capabilities'), '应读取 capabilities');
    assert.ok(source.includes('warnings'), '应读取 warnings');
    assert.ok(source.includes('duplicate_identity'), '应识别重复身份告警');
    // 总开关走 /app-enabled（§6.5）。
    assert.ok(source.includes('/app-enabled'), '总开关应调用 /app-enabled 路由');
    // 删除走 DELETE /api/configuration/:code（§6.6）。
    assert.ok(source.includes("'/api/configuration/'"), '删除应调用 DELETE /api/configuration/:code');
});

test('总览页 script.js 不再引用已删除的旧首页元素', () => {
    // 旧首页的 lookupForm / edit-section / 两步创建已迁移，不应残留引用（§7.1）。
    assert.ok(!source.includes('lookupForm'), '不应残留 lookupForm');
    assert.ok(!source.includes('edit-section'), '不应残留 edit-section');
    assert.ok(!source.includes('generate-callback'), '总览页不应直接创建（应跳转 /new 向导）');
    assert.ok(!source.includes('complete-config'), '总览页不应直接完成配置');
});

test('总览页 script.js 使用公共组件而非原生 confirm/fetch', () => {
    // 通过 AppHttp（含 If-Match、错误码解析、401 跳登录）发起请求（§7.5）。
    assert.ok(source.includes('AppHttp'), '应使用 AppHttp 公共客户端');
    // 删除确认走 AppModal，禁止 window.confirm（§7.3）。只匹配实际调用，排除注释。
    assert.ok(source.includes('AppModal'), '应使用 AppModal 而非 window.confirm');
    assert.ok(!/[^.]\bwindow\.confirm\s*\(/.test(source), '禁止调用 window.confirm()');
    assert.ok(source.includes('AppToast'), '应使用 AppToast');
});

test('总览页 script.js 动态文本用 textContent，不解析不可信 innerHTML', () => {
    // createElement / textContent 为主；innerHTML 仅用于完全静态、可信的图标占位。
    assert.ok(source.includes('textContent'), '应使用 textContent 注入动态文本');
    // 不应出现把后端字段直接拼进 innerHTML 的反模式。
    assert.ok(!/innerHTML\s*=\s*[^'"]*app\./.test(source), '不应把 app 字段直接写入 innerHTML');
});
