const assert = require('assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const test = require('node:test');

async function reservePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function waitForReady(base, child, output) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`server exited early (${child.exitCode}): ${output.join('')}`);
        }
        try {
            const res = await fetch(`${base}/health/ready`);
            if (res.status === 200) return;
        } catch (_e) {
            // 启动窗口内连接失败属预期，继续轮询具体健康状态。
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`server readiness timeout: ${output.join('')}`);
}

test('runtime server: API no-store、稳定登录错误码、测试实例探针与版本信息', async t => {
    const port = await reservePort();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qywx-runtime-'));
    const dbPath = path.join(tempDir, 'runtime.db');
    const output = [];
    const child = spawn(process.execPath, ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(port),
            DB_PATH: dbPath,
            ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
            ADMIN_USERNAME: 'runtime-admin',
            ADMIN_PASSWORD: 'runtime-password-2026',
            NODE_ENV: 'production',
            TEST_INSTANCE_ID: 'runtime-test-instance-0123456789',
            APP_REVISION: 'runtime-test-revision',
            APP_VERSION: '2.0.0-test'
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    child.stdout.on('data', chunk => output.push(chunk.toString()));
    child.stderr.on('data', chunk => output.push(chunk.toString()));

    t.after(async () => {
        if (child.exitCode === null) child.kill();
        await new Promise(resolve => {
            if (child.exitCode !== null) return resolve();
            child.once('exit', resolve);
            setTimeout(resolve, 3000).unref();
        });
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const base = `http://127.0.0.1:${port}`;
    await waitForReady(base, child, output);

    let res = await fetch(`${base}/api/auth-status`, {
        headers: { 'If-None-Match': 'W/"stale"' }
    });
    assert.equal(res.status, 200, 'API 不得因条件请求返回 304');
    assert.equal(res.headers.get('cache-control'), 'no-store, private');
    assert.equal(res.headers.get('pragma'), 'no-cache');
    assert.equal(res.headers.get('surrogate-control'), 'no-store');
    assert.equal(res.headers.get('etag'), null);

    res = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'INVALID_INPUT');

    res = await fetch(`${base}/api/test-environment`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'AUTH_REQUIRED');

    res = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'runtime-admin', password: 'runtime-password-2026' })
    });
    assert.equal(res.status, 200);
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie.startsWith('session='));

    res = await fetch(`${base}/api/test-environment`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
        test_env: true,
        instance_id: 'runtime-test-instance-0123456789'
    });

    res = await fetch(`${base}/health/version`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
        version: '2.0.0-test',
        revision: 'runtime-test-revision'
    });

    res = await fetch(`${base}/favicon.ico`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /image\/svg\+xml/);
});
