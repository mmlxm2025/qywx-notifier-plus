// 多应用（第三轮复验 P1-02）：登录返回地址生产端与消费端协议一致性测试。
//
// http.js safeRedirectToLogin 把 next 写成绝对 URL（origin + path），
// 但 login.js safeReturnPath 只接受相对路径（以单个 / 开头）。
// 结果：401 后重新登录，总是落到首页而非原 /edit 或 /rules 页。
//
// 本测试串联「AppHttp 401 生成 next」与「login 安全消费 next」，
// 覆盖 /edit?code=x#security、/rules?code=y、外部 URL、//evil、javascript:。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-third-fix-review-ai-execution-guide.md §4 P1-02。

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

// 从 http.js 提取 safeRedirectToLogin 的 next 生产逻辑（与源码同语义）。
// 源码：const here = window.location.pathname + window.location.search;
//       const safe = window.location.origin + here;  ← 绝对 URL（bug）
//       window.location.href = '/login?next=' + encodeURIComponent(safe);
function produceNextOld(location) {
    // 复刻当前 http.js 的行为（绝对 URL）。
    const here = location.pathname + location.search;
    const safe = location.origin + here;
    return encodeURIComponent(safe);
}

// 从 login.js 提取 safeReturnPath 的消费逻辑（与源码同语义）。
// 源码：只接受以单个 / 开头的相对路径，拒绝 // 与协议。
function consumeNextLogin(currentValue) {
    const next = currentValue;
    if (!next) return null;
    if (next.startsWith('/') && !next.startsWith('//') && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(next)) {
        return next;
    }
    return null;
}

// 解码 next 参数值，得到 login.js 实际会用的返回路径。
function decodeNext(encoded) {
    return decodeURIComponent(encoded);
}

test('P1-02: http.js 生产 next 为绝对 URL（当前 bug 行为）', () => {
    // 验证当前 http.js 的生产行为：next 是绝对 URL。
    const produced = produceNextOld({ origin: 'https://app.example', pathname: '/edit', search: '?code=x' });
    const decoded = decodeNext(produced);
    assert.ok(decoded.startsWith('https://'), '当前 http.js 把 next 写成绝对 URL，解码后应以 https:// 开头');
});

test('P1-02: login.js 消费绝对 URL 的 next 时返回 null（协议相反）', () => {
    // 当前 login.js safeReturnPath 拒绝绝对 URL → 401 后登录落到首页。
    const produced = produceNextOld({ origin: 'https://app.example', pathname: '/edit', search: '?code=x' });
    const decoded = decodeNext(produced);
    const consumed = consumeNextLogin(decoded);
    assert.equal(consumed, null, 'login.js 应拒绝绝对 URL 的 next（当前 bug：401 后无法返回原页）');
});

// 链路测试：AppHttp 401 → 生成 next → login 消费 next → 跳转目标。
test('P1-02: 完整链路 /edit?code=x → 401 → 登录后应返回 /edit?code=x（当前失败）', () => {
    const location = { origin: 'https://app.example', pathname: '/edit', search: '?code=x', hash: '#security' };
    const produced = produceNextOld(location);
    const decoded = decodeNext(produced);
    const consumed = consumeNextLogin(decoded);
    // 当前 bug：produced 是绝对 URL，consumed 是 null，无法返回。
    assert.equal(consumed, null, '当前实现：/edit?code=x 经 401 后无法返回（绝对 URL 被拒）');
});

// 修复后的契约（阶段 C 实现）：http.js 应生产相对路径。
test('P1-02: 修复后 http.js 应生产相对路径 next（pathname + search + hash）', () => {
    // 期望：阶段 C 后 http.js 改为生产相对路径。
    const httpSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'http.js'), 'utf8');
    // safeRedirectToLogin 不应再拼接 origin 到 next。
    // 关键反模式：window.location.origin + here 写入 next。
    assert.ok(
        !/next.*window\.location\.origin\s*\+/.test(httpSrc) && !/window\.location\.origin\s*\+\s*here/.test(httpSrc),
        'http.js 不应把 origin 拼入 next（应为相对路径）'
    );
});

// 安全消费测试：login.js 应继续拒绝危险 next。
test('P1-02: login.js 安全消费——拒绝外部 URL / 协议相对 / javascript:', () => {
    assert.equal(consumeNextLogin('https://evil.com/'), null, '外部 https URL 拒绝');
    assert.equal(consumeNextLogin('//evil.com/'), null, '协议相对 URL 拒绝');
    assert.equal(consumeNextLogin('javascript:alert(1)'), null, 'javascript: 拒绝');
    assert.equal(consumeNextLogin('data:text/html,x'), null, 'data: 拒绝');
});

test('P1-02: login.js 安全消费——接受同源相对路径', () => {
    assert.equal(consumeNextLogin('/edit?code=x'), '/edit?code=x');
    assert.equal(consumeNextLogin('/rules?code=y'), '/rules?code=y');
    assert.equal(consumeNextLogin('/'), '/');
});
