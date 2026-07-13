// 多应用管理（2026-07-04 §7.4）：编辑页静态契约冒烟测试。
//
// 对 edit.html / edit.js 做静态检查：五分区结构、If-Match 版本、touched-field payload、
// 版本冲突保留输入、敏感项不回填、公共组件与稳定错误码。

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'edit.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'edit.js'), 'utf8');

test('edit.html 包含五个分区与公共组件脚本', () => {
    // 五个分区（§7.4）：基本信息/企业凭证/回调配置/默认接收人/安全设置。
    assert.ok(html.includes('基本信息'), '应包含基本信息分区');
    assert.ok(html.includes('企业凭证'), '应包含企业凭证分区');
    assert.ok(html.includes('回调配置'), '应包含回调配置分区');
    assert.ok(html.includes('默认接收成员'), '应包含默认接收人分区');
    assert.ok(html.includes('安全设置'), '应包含安全设置分区');
    // 公共组件依赖。
    assert.ok(html.includes('/public/components/recipient-picker.js'), '应引入 recipient-picker');
    assert.ok(html.includes('/public/http.js'), '应引入 AppHttp');
    assert.ok(html.includes('/public/components/modal.js'), '应引入 AppModal');
});

test('edit.html 固定 CDN 版本，不使用 @latest', () => {
    const srcMatches = html.match(/(?:src|href)=["'][^"']*@latest[^"']*["']/g) || [];
    assert.equal(srcMatches.length, 0, 'edit.html 禁止引用 @latest CDN');
    const bareTailwind = html.match(/cdn\.tailwindcss\.com(?!\/\d)/g) || [];
    assert.equal(bareTailwind.length, 0, 'edit.html 必须固定 tailwind 版本');
});

test('edit.js 实现版本乐观锁与 touched-field payload', () => {
    // 携带当前版本（If-Match via AppHttp version 选项）。
    assert.ok(/version\s*[,;]/.test(script) && script.includes('{ version'), '应携带版本发起请求');
    // touched-field：只把变化字段加入 payload（diff 原值）。
    assert.ok(script.includes('buildPayload'), '应有 buildPayload 构造局部 payload');
    assert.ok(script.includes('!=='), '应与原值比较决定是否发送字段');
    // CorpSecret 空值不发送。
    assert.ok(/corpsecret\.value\)/.test(script), 'CorpSecret 非空才发送');
});

test('edit.js 处理版本冲突保留输入与稳定错误码', () => {
    // 版本冲突保留输入、提示加载最新值。
    assert.ok(script.includes('APP_VERSION_CONFLICT'), '应处理版本冲突');
    assert.ok(script.includes('加载最新'), '版本冲突应提示加载最新值');
    // 稳定错误码分支（不匹配中文文案）。
    assert.ok(script.includes('CORPID_IMMUTABLE'), '应处理 CORPID_IMMUTABLE');
    assert.ok(script.includes('APP_IDENTITY_CONFLICT'), '应处理身份冲突');
    assert.ok(script.includes('WECHAT_CREDENTIAL_INVALID'), '应处理凭证无效');
});

test('edit.js 敏感项不回填、安全设置走独立接口', () => {
    // 敏感输入不回填（值置空）。
    assert.ok(/corpsecret\.value\s*=\s*['"]['"]/.test(script), 'CorpSecret 不回填');
    assert.ok(/callbackToken\.value\s*=\s*['"]['"]/.test(script), '回调 Token 不回填');
    // corpid 只读（CORPID_IMMUTABLE 配套）。
    assert.ok(html.includes('readonly'), 'corpid 输入应只读');
    // 安全设置（Code 开关、通知密钥）走独立接口。
    assert.ok(script.includes('/code-send'), 'Code 发送开关应走独立接口');
    assert.ok(script.includes('/notify-key'), '通知密钥应走独立接口');
    // 通知密钥操作用 AppModal 确认（非 window.confirm）。
    assert.ok(script.includes('modal.confirm'), '通知密钥操作应用 AppModal');
    assert.ok(!/window\.confirm\s*\(/.test(script), '禁止调用 window.confirm()');
});

test('edit.js 关闭回调后清空 callback URL 展示', () => {
    // 历史 bug：仅在 d.callbackUrl 有值时写入，关闭回调后旧 URL 残留。
    assert.ok(
        /callbackUrlDisplay\.textContent\s*=\s*['"]['"]/.test(script),
        '无 callbackUrl 时应清空展示文本'
    );
});
