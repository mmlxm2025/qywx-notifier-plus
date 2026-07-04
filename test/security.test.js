// 安全整改专项测试（SEC-001/002/003/005/006/009/013）
//
// 覆盖：
// - 启动配置校验（SEC-001）
// - AES-GCM 认证加密 + CBC 遗留迁移 + 篡改检测（SEC-005）
// - 通知密钥分离 + HMAC + 重放保护（SEC-003）
// - 回调重放/超时保护（SEC-013）
// - 输入校验严格性（SEC-009）

const assert = require('assert/strict');
const test = require('node:test');
const crypto = require('crypto');

function withEnv(t, key, value) {
    const hadValue = Object.prototype.hasOwnProperty.call(process.env, key);
    const original = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
        if (hadValue) process.env[key] = original;
        else delete process.env[key];
    });
}

// ---------- SEC-001：启动配置校验 ----------

test('SEC-001 validateRuntime rejects placeholder encryption key', t => {
    delete require.cache[require.resolve('../src/core/config')];
    withEnv(t, 'ENCRYPTION_KEY', 'change-this-to-a-random-32-char-string');
    withEnv(t, 'ADMIN_PASSWORD', 'strong-password-1');
    const config = require('../src/core/config');
    assert.throws(() => config.validateRuntime(), /ENCRYPTION_KEY/);
});

test('SEC-001 validateRuntime rejects env.template placeholder too', t => {
    delete require.cache[require.resolve('../src/core/config')];
    withEnv(t, 'ENCRYPTION_KEY', 'your-32-character-encryption-key-here');
    withEnv(t, 'ADMIN_PASSWORD', 'strong-password-1');
    const config = require('../src/core/config');
    assert.throws(() => config.validateRuntime(), /ENCRYPTION_KEY/);
});

test('SEC-001 validateRuntime rejects missing encryption key', t => {
    delete require.cache[require.resolve('../src/core/config')];
    withEnv(t, 'ENCRYPTION_KEY', undefined);
    withEnv(t, 'ADMIN_PASSWORD', 'strong-password-1');
    const config = require('../src/core/config');
    assert.throws(() => config.validateRuntime(), /ENCRYPTION_KEY/);
});

test('SEC-001 validateRuntime rejects invalid key length', t => {
    delete require.cache[require.resolve('../src/core/config')];
    withEnv(t, 'ENCRYPTION_KEY', 'too-short');
    withEnv(t, 'ADMIN_PASSWORD', 'strong-password-1');
    const config = require('../src/core/config');
    assert.throws(() => config.validateRuntime(), /格式无效/);
});

test('SEC-001 validateRuntime rejects weak admin password', t => {
    delete require.cache[require.resolve('../src/core/config')];
    withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    withEnv(t, 'ADMIN_PASSWORD', '123');
    const config = require('../src/core/config');
    assert.throws(() => config.validateRuntime(), /ADMIN_PASSWORD/);
});

test('SEC-001 validateRuntime rejects placeholder admin password', t => {
    delete require.cache[require.resolve('../src/core/config')];
    withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    withEnv(t, 'ADMIN_PASSWORD', 'change-this-to-a-strong-password');
    const config = require('../src/core/config');
    assert.throws(() => config.validateRuntime(), /ADMIN_PASSWORD/);
});

test('SEC-001 validateRuntime accepts valid hex key and strong password', t => {
    delete require.cache[require.resolve('../src/core/config')];
    withEnv(t, 'ENCRYPTION_KEY', crypto.randomBytes(32).toString('hex'));
    withEnv(t, 'ADMIN_PASSWORD', 'a-very-strong-password');
    const config = require('../src/core/config');
    assert.doesNotThrow(() => config.validateRuntime());
});

test('SEC-001 decodeEncryptionKey accepts hex, base64, and 32-char string', () => {
    const { decodeEncryptionKey } = require('../src/core/config');
    assert.equal(decodeEncryptionKey('ab'.repeat(32)).length, 32);
    // base64 of 32 bytes -> 44 chars ending with '='
    const b64 = crypto.randomBytes(32).toString('base64');
    assert.equal(decodeEncryptionKey(b64).length, 32);
    assert.equal(decodeEncryptionKey('a'.repeat(32)).length, 32);
    assert.equal(decodeEncryptionKey('too-short'), null);
    assert.equal(decodeEncryptionKey(''), null);
});

// ---------- SEC-005：AES-GCM 认证加密 ----------

function makeCrypto(t) {
    withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    delete require.cache[require.resolve('../src/core/crypto-instance')];
    const { getCrypto } = require('../src/core/crypto-instance');
    return getCrypto();
}

test('SEC-005 encrypt produces v2 GCM format with auth tag', t => {
    const c = makeCrypto(t);
    const enc = c.encrypt('plaintext-secret');
    const parts = enc.split(':');
    assert.equal(parts[0], 'v2');
    assert.equal(parts.length, 4);
    assert.equal(Buffer.from(parts[1], 'hex').length, 12, 'nonce 12 bytes');
    assert.equal(Buffer.from(parts[2], 'hex').length, 16, 'tag 16 bytes');
});

test('SEC-005 decrypt roundtrips GCM ciphertext', t => {
    const c = makeCrypto(t);
    assert.equal(c.decrypt(c.encrypt('hello-world')), 'hello-world');
});

test('SEC-005 tampering any of nonce/tag/ciphertext fails authentication', t => {
    const c = makeCrypto(t);
    const enc = c.encrypt('secret');
    const parts = enc.split(':');

    // 翻转末字节的最低位（异或 0x01），保证一定篡改原值。
    // 此前用 'ff' 覆盖末字节，当原值恰好为 0xff 时不改变，导致随机失败。
    const flipLastByte = (hex) => {
        const last = parseInt(hex.slice(-2), 16);
        return hex.slice(0, -2) + (last ^ 0x01).toString(16).padStart(2, '0');
    };

    // tamper tag
    let tampered = parts[0] + ':' + parts[1] + ':' + flipLastByte(parts[2]) + ':' + parts[3];
    assert.throws(() => c.decrypt(tampered), /数据解密失败/);

    // tamper ciphertext
    tampered = parts[0] + ':' + parts[1] + ':' + parts[2] + ':' + flipLastByte(parts[3]);
    assert.throws(() => c.decrypt(tampered), /数据解密失败/);

    // tamper nonce
    tampered = parts[0] + ':' + flipLastByte(parts[1]) + ':' + parts[2] + ':' + parts[3];
    assert.throws(() => c.decrypt(tampered), /数据解密失败/);
});

test('SEC-005 decrypts legacy CBC ciphertext (iv:ct hex) for migration', t => {
    const c = makeCrypto(t);
    // 构造旧格式 CBC 密文
    const key = Buffer.from('a'.repeat(32));
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let enc = cipher.update('legacy-data', 'utf8', 'hex');
    enc += cipher.final('hex');
    const legacy = iv.toString('hex') + ':' + enc;

    assert.equal(c.isLegacyCiphertext(legacy), true);
    assert.equal(c.decrypt(legacy), 'legacy-data');
});

test('SEC-005 reencryptIfLegacy converts CBC to GCM', t => {
    const c = makeCrypto(t);
    const key = Buffer.from('a'.repeat(32));
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let enc = cipher.update('migrate-me', 'utf8', 'hex');
    enc += cipher.final('hex');
    const legacy = iv.toString('hex') + ':' + enc;

    const reencrypted = c.reencryptIfLegacy(legacy);
    assert.equal(reencrypted.startsWith('v2:'), true);
    assert.equal(c.decrypt(reencrypted), 'migrate-me');
    // GCM ciphertext is not re-encrypted again
    assert.equal(c.reencryptIfLegacy(reencrypted), reencrypted);
});

test('SEC-005 crypto rejects key not 32 bytes', () => {
    const CryptoService = require('../src/core/crypto');
    assert.throws(() => new CryptoService('short'), /32 字节/);
    assert.throws(() => new CryptoService('a'.repeat(31)), /32 字节/);
    assert.doesNotThrow(() => new CryptoService(Buffer.from('a'.repeat(32))));
});

// ---------- SEC-003：通知密钥分离 + HMAC ----------

test('SEC-003 notify-auth accepts valid HMAC signature', () => {
    const notifyAuth = require('../src/core/notify-auth');
    const key = crypto.randomBytes(32).toString('hex');
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(8).toString('hex');
    const body = '{"content":"hi"}';
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const msg = notifyAuth.canonicalSignatureMessage({ method: 'POST', path: '/api/notify/x', timestamp: ts, nonce, bodyHash });
    const sig = notifyAuth.computeSignature(key, msg);
    const r = notifyAuth.verifySignedRequest({
        headers: { 'x-notify-signature': sig, 'x-notify-timestamp': ts, 'x-notify-nonce': nonce },
        method: 'POST', path: '/api/notify/x', rawBody: body, notifyKey: key
    });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'hmac');
});

test('SEC-003 notify-auth rejects wrong signature with 401', () => {
    const notifyAuth = require('../src/core/notify-auth');
    const key = crypto.randomBytes(32).toString('hex');
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(8).toString('hex');
    const r = notifyAuth.verifySignedRequest({
        headers: { 'x-notify-signature': 'a'.repeat(64), 'x-notify-timestamp': ts, 'x-notify-nonce': nonce },
        method: 'POST', path: '/api/notify/x', rawBody: 'body', notifyKey: key
    });
    assert.equal(r.ok, false);
    assert.equal(r.statusCode, 401);
});

test('SEC-003 notify-auth rejects expired timestamp with 401', () => {
    const notifyAuth = require('../src/core/notify-auth');
    const key = crypto.randomBytes(32).toString('hex');
    const oldTs = String(Math.floor(Date.now() / 1000) - 99999);
    const nonce = crypto.randomBytes(8).toString('hex');
    const bodyHash = crypto.createHash('sha256').update('').digest('hex');
    const msg = notifyAuth.canonicalSignatureMessage({ method: 'POST', path: '/x', timestamp: oldTs, nonce, bodyHash });
    const sig = notifyAuth.computeSignature(key, msg);
    const r = notifyAuth.verifySignedRequest({
        headers: { 'x-notify-signature': sig, 'x-notify-timestamp': oldTs, 'x-notify-nonce': nonce },
        method: 'POST', path: '/x', rawBody: '', notifyKey: key
    });
    assert.equal(r.ok, false);
    assert.equal(r.statusCode, 401);
});

test('SEC-003 notify-auth rejects replayed nonce with 401', () => {
    const notifyAuth = require('../src/core/notify-auth');
    const key = crypto.randomBytes(32).toString('hex');
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(8).toString('hex');
    const bodyHash = crypto.createHash('sha256').update('b').digest('hex');
    const msg = notifyAuth.canonicalSignatureMessage({ method: 'POST', path: '/x', timestamp: ts, nonce, bodyHash });
    const sig = notifyAuth.computeSignature(key, msg);
    const headers = { 'x-notify-signature': sig, 'x-notify-timestamp': ts, 'x-notify-nonce': nonce };
    const opts = { headers, method: 'POST', path: '/x', rawBody: 'b', notifyKey: key };

    const first = notifyAuth.verifySignedRequest(opts);
    assert.equal(first.ok, true);
    const second = notifyAuth.verifySignedRequest(opts);
    assert.equal(second.ok, false);
    assert.equal(second.statusCode, 401);
    assert.match(second.error, /重放/);
});

test('SEC-003 notify-auth allows API-key-only mode (no signature headers)', () => {
    const notifyAuth = require('../src/core/notify-auth');
    const key = crypto.randomBytes(32).toString('hex');
    const r = notifyAuth.verifySignedRequest({
        headers: {}, method: 'POST', path: '/x', rawBody: 'b', notifyKey: key
    });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'apikey');
});

test('SEC-003 notify-auth hashes key with sha256 (never stores plaintext)', () => {
    const notifyAuth = require('../src/core/notify-auth');
    const key = crypto.randomBytes(32).toString('hex');
    const hash = notifyAuth.hashNotifyKey(key);
    assert.equal(hash.length, 64);
    assert.notEqual(hash, key);
});

// ---------- SEC-006：限流 ----------

test('SEC-006 RateLimiter returns 429 with Retry-After over limit', () => {
    const { RateLimiter } = require('../src/core/rate-limit');
    const limiter = new RateLimiter({ windowMs: 1000, max: 2, message: 'too many' });
    limiter.check('k');
    limiter.check('k');
    let caught;
    try { limiter.check('k'); } catch (e) { caught = e; }
    assert.equal(caught.statusCode, 429);
    assert.equal(typeof caught.retryAfter, 'number');
    assert.match(caught.message, /too many/);
});

test('SEC-006 LoginRateLimiter blocks after max failures and resets on success', () => {
    const { LoginRateLimiter } = require('../src/core/rate-limit');
    const limiter = new LoginRateLimiter({ baseWindowMs: 60000, maxAttempts: 3 });
    limiter.recordFailure('u:ip');
    limiter.recordFailure('u:ip');
    limiter.check('u:ip'); // 2 failures, still allowed
    limiter.recordFailure('u:ip');
    let caught;
    try { limiter.check('u:ip'); } catch (e) { caught = e; }
    assert.equal(caught.statusCode, 429);

    // reset clears failures
    limiter.reset('u:ip');
    assert.doesNotThrow(() => limiter.check('u:ip'));
});

// ---------- SEC-002：Cookie 会话属性 ----------

test('SEC-002 buildSessionCookie sets HttpOnly, SameSite, and Secure when requested', () => {
    const auth = require('../src/core/auth');
    const cookie = auth.buildSessionCookie('abc123', { secure: true, sameSite: 'Strict' });
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=\d+/);
});

test('SEC-002 buildSessionCookie omits Secure when not https', () => {
    const auth = require('../src/core/auth');
    const cookie = auth.buildSessionCookie('abc123', { secure: false });
    assert.match(cookie, /HttpOnly/);
    assert.doesNotMatch(cookie, /Secure/);
});

test('SEC-002 buildClearCookie clears session (Max-Age=0)', () => {
    const auth = require('../src/core/auth');
    const cookie = auth.buildClearCookie({ secure: true });
    assert.match(cookie, /Max-Age=0/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
});

test('SEC-002 parseSessionFromCookie extracts session id', () => {
    const auth = require('../src/core/auth');
    assert.equal(auth.parseSessionFromCookie('session=abc; other=def'), 'abc');
    assert.equal(auth.parseSessionFromCookie('foo=bar'), null);
    assert.equal(auth.parseSessionFromCookie(''), null);
});

test('SEC-002 session lifecycle: login creates session, verify, revoke', () => {
    const AuthService = require('../src/core/auth').constructor;
    const svc = new AuthService();
    svc.password = 'p@ssword12';
    svc.username = 'admin';
    const result = svc.login('admin', 'p@ssword12');
    assert.equal(result.success, true);
    assert.equal(svc.verifySession(result.sessionId), true);
    svc.logout(result.sessionId);
    assert.equal(svc.verifySession(result.sessionId), false);
});

test('SEC-002 wrong password does not create session', () => {
    const AuthService = require('../src/core/auth').constructor;
    const svc = new AuthService();
    svc.password = 'p@ssword12';
    svc.username = 'admin';
    const result = svc.login('admin', 'wrong');
    assert.equal(result.success, false);
});

test('SEC-006 password version change invalidates existing sessions', () => {
    const AuthService = require('../src/core/auth').constructor;
    const svc = new AuthService();
    svc.password = 'p@ssword12';
    svc.username = 'admin';
    const result = svc.login('admin', 'p@ssword12');
    assert.equal(svc.verifySession(result.sessionId), true);
    svc.passwordVersion += 1; // 模拟密码变更
    assert.equal(svc.verifySession(result.sessionId), false);
});

test('SEC-006 listSessions / revokeAllSessions work', () => {
    const AuthService = require('../src/core/auth').constructor;
    const svc = new AuthService();
    svc.password = 'p@ssword12';
    svc.username = 'admin';
    const a = svc.login('admin', 'p@ssword12');
    const b = svc.login('admin', 'p@ssword12');
    assert.equal(svc.listSessions().length, 2);
    svc.revokeSession(a.sessionId);
    assert.equal(svc.listSessions().length, 1);
    svc.revokeAllSessions();
    assert.equal(svc.listSessions().length, 0);
});

// ---------- SEC-009：输入校验严格性 ----------

test('SEC-009 toStrictBoolean rejects ambiguous string "false"', () => {
    const { toStrictBoolean } = require('../src/services/notifier');
    assert.equal(toStrictBoolean('false'), false);
    assert.equal(toStrictBoolean('true'), true);
    assert.equal(toStrictBoolean('0'), false);
    assert.equal(toStrictBoolean(1), true);
    assert.equal(toStrictBoolean('random-string'), null);
    assert.equal(toStrictBoolean(undefined), null);
    assert.equal(toStrictBoolean(true), true);
});

test('SEC-009 parsePositiveInt rejects zero, negative, non-integer', () => {
    const { parsePositiveInt } = require('../src/services/notifier');
    assert.equal(parsePositiveInt(0), null);
    assert.equal(parsePositiveInt(-1), null);
    assert.equal(parsePositiveInt(1.5), null);
    assert.equal(parsePositiveInt('abc'), null);
    assert.equal(parsePositiveInt(100001), 100001);
    assert.equal(parsePositiveInt('100001'), 100001);
});

test('SEC-009 validateEncodingAesKey enforces 43 alphanumeric chars', () => {
    const { validateEncodingAesKey } = require('../src/services/notifier');
    assert.equal(validateEncodingAesKey('a'.repeat(43)), true);
    assert.equal(validateEncodingAesKey('a'.repeat(42)), false);
    assert.equal(validateEncodingAesKey('a'.repeat(44)), false);
    assert.equal(validateEncodingAesKey('!'.repeat(43)), false);
    assert.equal(validateEncodingAesKey(''), false);
});

test('SEC-009 isCompletedConfig requires secret + positive agentid + touser', () => {
    const { isCompletedConfig } = require('../src/services/notifier');
    assert.equal(isCompletedConfig({ encrypted_corpsecret: 'x', agentid: 100, touser: 'a' }), true);
    assert.equal(isCompletedConfig({ encrypted_corpsecret: '', agentid: 100, touser: 'a' }), false);
    assert.equal(isCompletedConfig({ encrypted_corpsecret: 'x', agentid: 0, touser: 'a' }), false);
    assert.equal(isCompletedConfig({ encrypted_corpsecret: 'x', agentid: 100, touser: '' }), false);
    assert.equal(isCompletedConfig(null), false);
});

test('SEC-009 validateMessagePayload rejects unsupported/missing fields', () => {
    const { validateMessagePayload } = require('../src/services/notifier');
    // unsupported type
    assert.throws(() => validateMessagePayload({ msgType: 'bogus' }), /不支持的消息类型/);
    // text missing content
    assert.throws(() => validateMessagePayload({ msgType: 'text' }), /消息内容不能为空/);
    // image missing mediaId
    assert.throws(() => validateMessagePayload({ msgType: 'image' }), /media_id/);
    // news missing articles
    assert.throws(() => validateMessagePayload({ msgType: 'news' }), /articles/);
    // news malformed article
    assert.throws(() => validateMessagePayload({ msgType: 'news', articles: [{ title: 'x' }] }), /title 和 url/);
    // valid text
    assert.doesNotThrow(() => validateMessagePayload({ msgType: 'text', content: 'hi' }));
});

// ---------- SEC-013：回调重放/大小保护 ----------

test('SEC-013 assertCallbackBodySize rejects oversized and empty bodies', () => {
    const { assertCallbackBodySize } = require('../src/services/notifier');
    assert.throws(() => assertCallbackBodySize(0), /为空/);
    assert.throws(() => assertCallbackBodySize(10 * 1024 * 1024), /超过大小限制/);
    assert.doesNotThrow(() => assertCallbackBodySize(100));
});
