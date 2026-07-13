// 真实服务器集成测试（第三轮复验 P0-02/P1-06 重建版）。
//
// 安全说明：本文件不得包含真实部署地址、用户名或密码明文。
// 凭据只从进程环境变量读取。历史版本曾写入真实值，已于 2026-07-04 清除并轮换。
// 详见 docs/SECURITY_INCIDENT_2026-07-04.md。
//
// 与旧版的关键差异（第三轮复验 §3 P0-02 + §4 P1-06）：
//   1. 默认 npm test 不收集本文件（位于 test/live/，需 npm run test:live）。
//   2. 三重确认：显式 mutation token + 服务端认证探针 + 精确 TEST_INSTANCE_ID；
//      任一不满足都在任何业务写入前失败退出（不得 SKIP 假绿）。
//   3. 不读取/修改任意既有业务应用；所有 fixture 带 run id，全部由本轮创建。
//   4. 真正构造两个已完成测试应用并执行 AgentID 抢占编辑，断言 409 APP_IDENTITY_CONFLICT。
//   5. test.after 统一清理（规则→应用逆序）；清理失败让套件失败并输出非敏感 run id。
//   6. 业务前置条件不满足用 t.skip(reason)，禁止空 return / assert.ok(true) 冒充通过。
//
// 用法（隔离测试实例）：
//   QYWX_LIVE_BASE=https://your-test-instance \
//   QYWX_LIVE_USER=your-test-admin QYWX_LIVE_PASS=REPLACE_ME \
//   QYWX_LIVE_ALLOW_MUTATION=I_UNDERSTAND_TEST_ONLY \
//   QYWX_LIVE_EXPECT_INSTANCE=your-random-test-instance-id \
//   npm run test:live

const assert = require('assert/strict');
const test = require('node:test');

const BASE = process.env.QYWX_LIVE_BASE;
const USER = process.env.QYWX_LIVE_USER;
const PASS = process.env.QYWX_LIVE_PASS;
const ALLOW_MUTATION = process.env.QYWX_LIVE_ALLOW_MUTATION;
const EXPECTED_INSTANCE = process.env.QYWX_LIVE_EXPECT_INSTANCE;
const REQUIRED_MUTATION_TOKEN = 'I_UNDERSTAND_TEST_ONLY';

// run id：唯一标识本次测试运行，用于 fixture 命名与清理。
const RUN_ID = `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
// 收集本次创建的 fixture（用于 after 清理）。
const createdApps = []; // { code, version } 完成应用（可删除）
const createdRules = []; // { id, code } 规则
const createdDrafts = []; // { code } 草稿（可能无法删除，记录用于报告）
let cleanupFailures = [];

// 前置条件缺失必须让进程非零退出；不能用 test.skip 让 0 项执行仍显示成功。
const prereqErrors = [];
if (!BASE) prereqErrors.push('QYWX_LIVE_BASE 未设置（需指向隔离测试实例）');
if (!USER || !PASS) prereqErrors.push('QYWX_LIVE_USER/QYWX_LIVE_PASS 未设置');
if (ALLOW_MUTATION !== REQUIRED_MUTATION_TOKEN) {
    prereqErrors.push(`QYWX_LIVE_ALLOW_MUTATION 必须为 "${REQUIRED_MUTATION_TOKEN}"`);
}
if (!EXPECTED_INSTANCE || EXPECTED_INSTANCE.length < 16) {
    prereqErrors.push('QYWX_LIVE_EXPECT_INSTANCE 未设置或少于 16 个字符');
}
if (prereqErrors.length > 0) {
    throw new Error('live 测试前置条件失败：\n- ' + prereqErrors.join('\n- '));
}

// 创建会话：登录返回带 cookie 的 fetch 包装。
async function createSession() {
    const res = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USER, password: PASS })
    });
    assert.equal(res.status, 200, '登录应成功');
    const setCookie = res.headers.get('set-cookie') || '';
    const session = (setCookie.split(';')[0] || '').trim();
    assert.ok(session.startsWith('session='), '应返回 session cookie');
    const authHeaders = { cookie: session };
    const api = async (method, path, { body, headers = {}, ifMatch } = {}) => {
        const h = { ...authHeaders, ...headers };
        if (ifMatch !== undefined) h['if-match'] = String(ifMatch);
        if (body !== undefined) h['content-type'] = 'application/json';
        return await fetch(`${BASE}${path}`, {
            method,
            headers: h,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    };
    return { api };
}

let preflightPromise = null;
function ensureTestTarget() {
    if (!preflightPromise) {
        preflightPromise = (async () => {
            const { api } = await createSession();
            const res = await api('GET', '/api/test-environment');
            assert.equal(res.status, 200, '目标未启用认证后的测试环境探针，禁止执行 live 写测试');
            const body = await res.json();
            assert.equal(body.test_env, true, '目标未声明为隔离测试实例');
            assert.equal(body.instance_id, EXPECTED_INSTANCE, '测试实例 ID 不匹配，禁止执行 live 写测试');
        })();
    }
    return preflightPromise;
}

async function login() {
    await ensureTestTarget();
    return createSession();
}

// 创建一个完成应用（用 /api/configure 兼容入口，带 run id 标识）。
// 返回 { code, version }。注意：此 fixture 需要 corpid+corpsecret+agentid+touser。
async function createCompletedApp(api, { agentid, touser }) {
    const corpid = `${RUN_ID}-corp-${agentid}`;
    const res = await api('POST', '/api/configure', {
        body: {
            corpid,
            corpsecret: `${RUN_ID}-secret`,
            agentid,
            touser,
            description: `${RUN_ID} app ${agentid}`
        }
    });
    if (res.status === 409) {
        // 身份冲突：说明同 (corpid, agentid) 已存在（前次未清理）。
        const body = await res.json();
        const e = new Error(`createCompletedApp 身份冲突: ${JSON.stringify(body && body.details)}`);
        e.conflict = true;
        throw e;
    }
    assert.equal(res.status, 201, `创建完成应用应 201，实际 ${res.status}`);
    const body = await res.json();
    assert.ok(body.code, '应返回 code');
    const app = { code: body.code, version: 1 };
    createdApps.push(app);
    return app;
}

// 读取应用详情，返回最新版本号。
async function getAppVersion(api, code) {
    const res = await api('GET', `/api/configuration/${encodeURIComponent(code)}`);
    assert.equal(res.status, 200, `读取 ${code} 详情应 200`);
    const body = await res.json();
    return Number(body.version) || 1;
}

// 统一清理：规则 → 应用逆序删除。失败记录到 cleanupFailures（让最终报告反映）。
async function cleanupFixture(api) {
    // 先删规则。
    for (const r of [...createdRules].reverse()) {
        try {
            const version = await getAppVersion(api, r.code).catch(() => null);
            if (version) {
                const res = await api('DELETE', `/api/rules/${encodeURIComponent(r.id)}`, { ifMatch: version });
                if (!res.ok && res.status !== 404) {
                    cleanupFailures.push(`删除规则 ${r.id} 失败: ${res.status}`);
                }
            }
        } catch (e) { cleanupFailures.push(`删除规则 ${r.id} 异常: ${e.message}`); }
    }
    // 再删应用。
    for (const a of [...createdApps].reverse()) {
        try {
            const version = await getAppVersion(api, a.code).catch(() => null);
            if (version) {
                const res = await api('DELETE', `/api/configuration/${encodeURIComponent(a.code)}`, { ifMatch: version });
                if (!res.ok && res.status !== 404) {
                    cleanupFailures.push(`删除应用 ${a.code} 失败: ${res.status}`);
                }
            }
        } catch (e) { cleanupFailures.push(`删除应用 ${a.code} 异常: ${e.message}`); }
    }
}

// ─── 套件级 setup/teardown ──────────────────────────────────────────────────

test.before(async () => {
    await ensureTestTarget();
});

test('真实服务器: 登录成功且未认证请求返回 401', async () => {
    await login();
    const res = await fetch(`${BASE}/api/configuration/any/code-send`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': '1' },
        body: JSON.stringify({ enabled: false })
    });
    assert.equal(res.status, 401);
    // 多应用（第三轮 P1-06）：401 应有 AUTH_REQUIRED code。
    const body = await res.json();
    assert.equal(body.code, 'AUTH_REQUIRED');
});

test('真实服务器: legacy-grace 路由已删除返回 404', async () => {
    const { api } = await login();
    const res = await api('POST', '/api/configuration/any/legacy-grace', { body: { seconds: 60 }, ifMatch: 1 });
    assert.equal(res.status, 404, 'legacy-grace 应已删除');
});

test('真实服务器: 管理写路由 If-Match 三分（自有 fixture）', async t => {
    const { api } = await login();
    // 创建专属 fixture（带 run id），不依赖既有应用。
    const app = await createCompletedApp(api, { agentid: 900001, touser: 'live-u1' });
    const version = await getAppVersion(api, app.code);

    // 缺版本 428。
    let res = await api('PUT', `/api/configuration/${app.code}/app-enabled`, { body: { enabled: true } });
    assert.equal(res.status, 428);
    assert.equal((await res.json()).code, 'APP_VERSION_REQUIRED');
    // 非法版本 400。
    res = await api('PUT', `/api/configuration/${app.code}/app-enabled`, { body: { enabled: true }, ifMatch: 'abc' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'INVALID_INPUT');
    // 未来版本（高于当前）409——验证 !== 快速失败（第三轮 P1-04）。
    res = await api('PUT', `/api/configuration/${app.code}/app-enabled`, { body: { enabled: true }, ifMatch: 999999 });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'APP_VERSION_CONFLICT');
    // 正确版本成功 200。
    res = await api('PUT', `/api/configuration/${app.code}/app-enabled`, { body: { enabled: false }, ifMatch: version });
    assert.equal(res.status, 200);
});

test('真实服务器: 规则创建携带版本成功并返回 app_version（自有 fixture）', async t => {
    const { api } = await login();
    const app = await createCompletedApp(api, { agentid: 900002, touser: 'live-u2' });
    const version = await getAppVersion(api, app.code);
    // 缺版本 428。
    let res = await api('POST', `/api/configuration/${app.code}/rules`, { body: { name: `${RUN_ID}-rule`, touser: 'live-u2' } });
    assert.equal(res.status, 428);
    // 携带正确版本 201 + app_version。
    res = await api('POST', `/api/configuration/${app.code}/rules`, {
        body: { name: `${RUN_ID}-rule`, touser: 'live-u2' }, ifMatch: version
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.app_version, '应返回 app_version');
    assert.ok(body.app_version > version, 'app_version 应递增');
    // 记录规则用于清理。
    if (body.id) createdRules.push({ id: body.id, code: app.code });
});

test('真实服务器: 编辑 AgentID 抢占身份冲突返回 APP_IDENTITY_CONFLICT', async t => {
    const { api } = await login();
    // 创建两个不同 AgentID 的完成应用（同 corpid 由 createCompletedApp 按 agentid 区分）。
    // 注意：createCompletedApp 用 corpid = RUN_ID-corp-agentid，两者 corpid 不同。
    // 要触发身份冲突，需要同 corpid + 同 agentid。这里用 /api/configure 直接构造同 corpid 不同 code。
    const corpid = `${RUN_ID}-conflict-corp`;
    // 第一个应用：agentid 900010。
    const app1Res = await api('POST', '/api/configure', {
        body: { corpid, corpsecret: `${RUN_ID}-s1`, agentid: 900010, touser: 'u1', description: `${RUN_ID} conflict-1` }
    });
    assert.equal(app1Res.status, 201, '第一个应用应创建成功');
    const app1 = await app1Res.json();
    createdApps.push({ code: app1.code, version: 1 });

    // 第二个应用：同 corpid，不同 agentid 900011。
    const app2Res = await api('POST', '/api/configure', {
        body: { corpid, corpsecret: `${RUN_ID}-s2`, agentid: 900011, touser: 'u2', description: `${RUN_ID} conflict-2` }
    });
    assert.equal(app2Res.status, 201, '第二个应用（不同 AgentID）应创建成功');
    const app2 = await app2Res.json();
    createdApps.push({ code: app2.code, version: 1 });

    // 读取 app2 的版本与 corpid 详情。
    const app2Version = await getAppVersion(api, app2.code);

    // 真实抢占：使用当前正确版本，把 app2 的 AgentID 改成 app1 的 900010。
    // 服务先识别已有身份冲突（事务内仍有并发兜底），不得用版本冲突冒充身份冲突。
    const res = await api('PUT', `/api/configuration/${app2.code}`, {
        body: { agentid: 900010 }, ifMatch: app2Version
    });
    assert.equal(res.status, 409, '抢占 AgentID 应返回 409');
    const body = await res.json();
    assert.equal(body.code, 'APP_IDENTITY_CONFLICT');
    assert.equal(body.details.existing_code, app1.code);
});

test('真实服务器: 详情摘要不含敏感字段与 legacy_until', async t => {
    const { api } = await login();
    const app = await createCompletedApp(api, { agentid: 900003, touser: 'live-u3' });
    const res = await api('GET', `/api/configuration/${app.code}`);
    const detail = await res.json();
    assert.equal(detail.legacy_until, undefined, '详情不应返回 legacy_until');
    // 敏感字段不回显明文。
    assert.ok(!detail.encrypted_corpsecret, '详情不应回显加密 CorpSecret');
    assert.ok(!detail.encrypted_callback_token, '详情不应回显加密 Token');
});

test('真实服务器: 自定义 api_code 创建→改号→旧地址失效（自有 fixture）', async t => {
    const { api } = await login();
    const app = await createCompletedApp(api, { agentid: 900004, touser: 'live-u4' });
    const version = await getAppVersion(api, app.code);
    // 用包含 run id 的唯一自定义编号创建规则。
    const code1 = `${RUN_ID}-code1`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    const code2 = `${RUN_ID}-code2`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    // 确保长度 >=3（RUN_ID 足够长）
    const apiCode1 = code1.length >= 3 ? code1 : `${code1}pad`;
    const apiCode2 = code2.length >= 3 ? code2 : `${code2}pad`;

    let res = await api('POST', `/api/configuration/${app.code}/rules`, {
        body: { name: `${RUN_ID}-api-rule`, api_code: apiCode1, touser: 'live-u4' }, ifMatch: version
    });
    assert.equal(res.status, 201, '自定义编号创建应成功');
    const created = await res.json();
    assert.equal(created.api_code, apiCode1, '应返回规范化编号');
    assert.equal(created.apiUrl, `/api/notify/${apiCode1}`);
    createdRules.push({ id: created.id, code: app.code });

    // 改号：apiCode1 -> apiCode2，旧地址立即失效。
    res = await api('PUT', `/api/rules/${created.id}`, {
        body: { name: `${RUN_ID}-api-rule`, api_code: apiCode2, touser: 'live-u4' }, ifMatch: created.app_version
    });
    assert.equal(res.status, 200, '改号应成功');
    const updated = await res.json();
    assert.equal(updated.api_code, apiCode2);
    assert.equal(updated.api_code_changed, true);

    // 旧编号不能被新规则申请（已退役）。
    res = await api('POST', `/api/configuration/${app.code}/rules`, {
        body: { name: `${RUN_ID}-api-rule2`, api_code: apiCode1, touser: 'live-u4' }, ifMatch: updated.app_version
    });
    assert.equal(res.status, 409, '退役编号应被拒绝');
    const conflictBody = await res.json();
    assert.equal(conflictBody.code, 'RULE_API_CODE_CONFLICT');
    assert.equal(conflictBody.details.conflict_scope, 'retired');
});

test('真实服务器: 清理本次创建的 fixture', async t => {
    // 多应用（第三轮 P0-02）：真正的清理——删除规则与应用，失败记录到 cleanupFailures。
    const { api } = await login();
    await cleanupFixture(api);
    // 草稿无法通过 API 删除（删除需已完成 + If-Match）；
    // 真实部署使用一次性数据卷，测试后销毁整个卷。
    // 此处不伪造成功：如果有清理失败，断言失败并输出非敏感 run id。
    if (cleanupFailures.length > 0) {
        assert.fail(`清理失败 ${cleanupFailures.length} 项（run_id=${RUN_ID}）:\n` + cleanupFailures.join('\n'));
    }
    // 草稿残留说明（如果有）。
    if (createdDrafts.length > 0) {
        // 草稿残留需通过一次性数据卷销毁，不算清理失败但需报告。
        console.log(`[live] ${createdDrafts.length} 个草稿残留（run_id=${RUN_ID}），需在一次性数据卷中销毁`);
    }
});

// 套件级 after：确保即使中途断言失败也尝试清理。
test.after(async () => {
    if (createdApps.length === 0 && createdRules.length === 0) return;
    try {
        const { api } = await login();
        // 只在尚未清理时尝试（避免重复）。
        if (cleanupFailures.length === 0) {
            await cleanupFixture(api);
        }
    } catch (e) {
        console.error(`[live] after 清理异常（run_id=${RUN_ID}）: ${e.message}`);
    }
    // 产出脱敏报告。
    console.log(JSON.stringify({
        live_report: true,
        run_id: RUN_ID,
        target: BASE ? BASE.replace(/\/\/.*@/, '//***@') : null,
        created_apps: createdApps.length,
        created_rules: createdRules.length,
        created_drafts: createdDrafts.length,
        cleanup_failures: cleanupFailures.length
    }));
});
