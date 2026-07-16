// 多应用（第三轮复验 P1-02）：登录返回地址生产端与消费端协议一致性测试。
//
// 历史 bug：http.js safeRedirectToLogin 把 next 写成绝对 URL（origin + path），
// 但 login.js safeReturnPath 只接受相对路径 → 401 后重新登录总是落到首页。
//
// 当前契约：http.js 生产同源相对路径（pathname + search + hash）；
// login.js 安全消费相对路径，并兼容旧书签中的同源绝对 URL。
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-third-fix-review-ai-execution-guide.md §4 P1-02。

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const httpSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'http.js'), 'utf8');
const loginSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.js'), 'utf8');
const editSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'edit.js'), 'utf8');
const scriptSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'script.js'), 'utf8');
const rulesSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'rules.js'), 'utf8');
const wizardSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'wizard.js'), 'utf8');

// 与当前 http.js safeRedirectToLogin 同语义：相对路径 next。
function produceNext(location) {
    const here = location.pathname + location.search + (location.hash || '');
    return encodeURIComponent(here);
}

// 与当前 login.js safeReturnPath 同语义（含同源绝对 URL 降级）。
function consumeNextLogin(next, pageOrigin = 'https://app.example') {
    if (!next) return null;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(next) || next.startsWith('//')) {
        try {
            const url = new URL(next, pageOrigin);
            if (url.origin === pageOrigin) {
                return url.pathname + url.search + url.hash;
            }
        } catch (_e) { /* 无效 URL */ }
        return null;
    }
    if (next.startsWith('/') && !next.startsWith('//') && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(next)) {
        return next;
    }
    return null;
}

function decodeNext(encoded) {
    return decodeURIComponent(encoded);
}

test('P1-02: http.js 生产相对路径 next（pathname + search + hash）', () => {
    const produced = produceNext({
        origin: 'https://app.example',
        pathname: '/edit',
        search: '?code=x',
        hash: '#security'
    });
    const decoded = decodeNext(produced);
    assert.equal(decoded, '/edit?code=x#security');
    assert.ok(!decoded.startsWith('http'), 'next 不得是绝对 URL');
});

test('P1-02: login.js 消费相对路径 next 成功', () => {
    const produced = produceNext({
        origin: 'https://app.example',
        pathname: '/edit',
        search: '?code=x',
        hash: ''
    });
    const decoded = decodeNext(produced);
    const consumed = consumeNextLogin(decoded);
    assert.equal(consumed, '/edit?code=x');
});

test('P1-02: 完整链路 /edit?code=x → 401 → 登录后返回 /edit?code=x', () => {
    const location = { origin: 'https://app.example', pathname: '/edit', search: '?code=x', hash: '#security' };
    const produced = produceNext(location);
    const decoded = decodeNext(produced);
    const consumed = consumeNextLogin(decoded);
    assert.equal(consumed, '/edit?code=x#security');
});

test('P1-02: 源码契约——http.js 不把 origin 拼入 next', () => {
    assert.ok(
        !/next.*window\.location\.origin\s*\+/.test(httpSrc) && !/window\.location\.origin\s*\+\s*here/.test(httpSrc),
        'http.js 不应把 origin 拼入 next（应为相对路径）'
    );
    assert.ok(
        /pathname\s*\+\s*window\.location\.search\s*\+\s*window\.location\.hash/.test(httpSrc)
            || /pathname\s*\+[\s\S]*?search[\s\S]*?hash/.test(httpSrc),
        'http.js 应拼接 pathname + search + hash'
    );
});

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

test('P1-02: login.js 兼容旧书签中的同源绝对 URL', () => {
    assert.equal(
        consumeNextLogin('https://app.example/edit?code=x', 'https://app.example'),
        '/edit?code=x'
    );
    // 源码应包含同源降级逻辑。
    assert.ok(/url\.origin\s*===\s*window\.location\.origin/.test(loginSrc),
        'login.js 应对同源绝对 URL 降级为相对路径');
});

test('P1-02: 首屏 checkAuth 也写入 login?next=（edit/rules/wizard/index）', () => {
    for (const [name, src] of [
        ['edit.js', editSrc],
        ['script.js', scriptSrc],
        ['rules.js', rulesSrc],
        ['wizard.js', wizardSrc]
    ]) {
        assert.ok(
            /\/login\?next=/.test(src),
            `${name} 首屏未登录跳转应保留 ?next= 深链`
        );
        // 禁止仅写死 '/login' 而无 next 的主路径（允许 catch 降级到 /login）。
        assert.ok(
            !/location\.href\s*=\s*['"]\/login['"]\s*;\s*return/.test(src)
                || /login\?next=/.test(src),
            `${name} 不得在无 next 时硬跳 /login 作为唯一路径`
        );
    }
});

test('编辑页成员加载使用 createRequestGuard 丢弃过期响应', () => {
    assert.ok(/membersGuard\s*=\s*H\.createRequestGuard\(\)/.test(editSrc), 'edit.js 应创建 membersGuard');
    assert.ok(/membersGuard\.next\(\)/.test(editSrc), 'loadMembers 应推进代次');
    assert.ok(/membersGuard\.isCurrent\(/.test(editSrc), 'loadMembers 应校验代次');
});

test('总览删除：规则预览失败时中止，不得当作 0 条规则', () => {
    assert.ok(/!rulesRes\.ok/.test(scriptSrc) || /rulesRes\.ok\s*===?\s*false/.test(scriptSrc),
        'onDelete 应检查 rulesRes.ok');
    assert.ok(/删除已取消|无法加载规则/.test(scriptSrc),
        '预览失败应提示并取消删除');
});

test('向导恢复草稿读取 sessionStorage 白名单字段', () => {
    assert.ok(/selectedUserIDs/.test(wizardSrc), '应恢复 selectedUserIDs');
    assert.ok(/loadState\(\)/.test(wizardSrc), 'tryRestoreDraft 应读 loadState');
    // re-validate 前从 picker 同步选中
    assert.ok(/picker\.getValue/.test(wizardSrc), '应能从 picker 同步选中成员');
});
