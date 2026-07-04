// 多应用（二次复验 P2-01/P2-03/P2-04/P2-05）：技术债清理后的契约测试。
//
// 验证：
//   - P2-01: login.js 安全消费 ?next=（只接受同源相对路径，拒绝外部 URL）。
//   - P2-03: legacy-grace 运行时代码清理（notify-auth 不导出 LEGACY_GRACE_MS，
//            database 白名单不再含 legacy_until）。
//   - P2-04: notify-auth recordNonce 按 notifyKey 分区（接受 notifyKey 参数）。
//   - P2-05: modal.js busy 期间禁止 ESC/遮罩/取消关闭。
//
// 参考 docs/superpowers/specs/2026-07-04-multi-app-management-second-fix-review-ai-execution-guide.md §5。

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

// ─── P2-01: login.js 安全消费 next ──────────────────────────────────────────

const loginSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.js'), 'utf8');

test('P2-01: login.js 实现 safeReturnPath 只接受同源相对路径', () => {
    assert.ok(/function\s+safeReturnPath/.test(loginSrc), '应定义 safeReturnPath');
    // 应拒绝 // 开头（协议相对 URL）。
    assert.ok(/startsWith\('\/\/'\)/.test(loginSrc), '应拒绝 // 开头的协议相对 URL');
    // 登录成功后应使用 safeReturnPath() 而非固定 /。
    assert.ok(/safeReturnPath\(\)/.test(loginSrc), '登录成功应使用 safeReturnPath()');
});

// 重新实现 safeReturnPath 的纯逻辑，与 login.js 同语义，做属性测试。
function safeReturnPathImpl(next) {
    if (!next) return null;
    if (next.startsWith('/') && !next.startsWith('//') && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(next)) {
        return next;
    }
    return null;
}

test('P2-01: safeReturnPath 接受同源相对路径', () => {
    assert.equal(safeReturnPathImpl('/rules?code=x'), '/rules?code=x');
    assert.equal(safeReturnPathImpl('/edit?code=y'), '/edit?code=y');
    assert.equal(safeReturnPathImpl('/'), '/');
});

test('P2-01: safeReturnPath 拒绝外部 URL 与协议相对 URL', () => {
    assert.equal(safeReturnPathImpl('https://evil.com/'), null, '绝对 https URL 应拒绝');
    assert.equal(safeReturnPathImpl('//evil.com/'), null, '协议相对 URL 应拒绝');
    assert.equal(safeReturnPathImpl('javascript:alert(1)'), null, 'javascript: 应拒绝');
    assert.equal(safeReturnPathImpl('data:text/html,x'), null, 'data: 应拒绝');
    assert.equal(safeReturnPathImpl(null), null, 'null 应返回 null');
});

// ─── P2-03: legacy-grace 运行时代码清理 ─────────────────────────────────────

const notifyAuthSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'notify-auth.js'), 'utf8');
const databaseSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'database.js'), 'utf8');

test('P2-03: notify-auth 不再导出 LEGACY_GRACE_MS', () => {
    assert.ok(!/LEGACY_GRACE_MS/.test(notifyAuthSrc), 'notify-auth 不应再引用 LEGACY_GRACE_MS');
});

test('P2-03: database UPDATE_FIELD_WHITELIST 不再含 legacy_until', () => {
    // 白名单定义应在注释后紧接的 Set 中。
    const whitelistMatch = databaseSrc.match(/UPDATE_FIELD_WHITELIST\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(whitelistMatch, '应能找到 UPDATE_FIELD_WHITELIST 定义');
    assert.ok(!/legacy_until/.test(whitelistMatch[1]), '白名单不应再含 legacy_until');
});

// ─── P2-04: notify-auth recordNonce 按 notifyKey 分区 ───────────────────────

const notifyAuth = require('../src/core/notify-auth');

test('P2-04: recordNonce 接受 notifyKey 参数用于分区', () => {
    const src = notifyAuthSrc;
    assert.ok(/function\s+recordNonce\s*\(\s*nonce\s*,\s*notifyKey\s*\)/.test(src), 'recordNonce 应接受 notifyKey 参数');
    assert.ok(/hashNotifyKey\(notifyKey\)/.test(src), '应按 notifyKey 哈希分区');
});

test('P2-04: 不同 notifyKey 的相同 nonce 不互相拒绝', () => {
    // 直接调用 verifySignedRequest：两个不同 key 用同一 nonce + 签名都应成功。
    // 构造最小签名请求。
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = 'same-nonce-shared';
    const key1 = 'aaaa'.repeat(16);
    const key2 = 'bbbb'.repeat(16);
    const bodyHash = require('crypto').createHash('sha256').update('').digest('hex');
    const msg = notifyAuth.canonicalSignatureMessage({ method: 'POST', path: '/x', timestamp: ts, nonce, bodyHash });
    const sig1 = notifyAuth.computeSignature(key1, msg);
    const sig2 = notifyAuth.computeSignature(key2, msg);
    const headers1 = { 'x-notify-timestamp': ts, 'x-notify-nonce': nonce, 'x-notify-signature': sig1 };
    const headers2 = { 'x-notify-timestamp': ts, 'x-notify-nonce': nonce, 'x-notify-signature': sig2 };
    const r1 = notifyAuth.verifySignedRequest({ headers: headers1, method: 'POST', path: '/x', rawBody: '', notifyKey: key1 });
    const r2 = notifyAuth.verifySignedRequest({ headers: headers2, method: 'POST', path: '/x', rawBody: '', notifyKey: key2 });
    assert.equal(r1.ok, true, 'key1 + nonce 应通过');
    assert.equal(r2.ok, true, 'key2 + 相同 nonce 也应通过（按密钥分区）');
});

// ─── P2-05: modal.js busy 期间禁止关闭 ──────────────────────────────────────

const modalSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'modal.js'), 'utf8');

test('P2-05: modal busy 期间禁止 ESC/遮罩/取消关闭', () => {
    assert.ok(/activeModal\.busy/.test(modalSrc), '应有 busy 状态');
    // ESC 关闭应检查 busy。
    assert.ok(/if\s*\(\s*activeModal\.busy\)/.test(modalSrc), 'ESC 关闭应检查 busy');
    // 遮罩 mousedown 应检查 busy。
    assert.ok(/!isBusy\(\)/.test(modalSrc) || /!.*\.busy/.test(modalSrc), '遮罩关闭应检查 busy');
});
