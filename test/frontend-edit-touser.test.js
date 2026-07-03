const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const scriptPath = path.join(__dirname, '..', 'public', 'script.js');
const source = fs.readFileSync(scriptPath, 'utf8');

function decodeHtml(value) {
    return String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function parseAttributes(raw) {
    const attrs = {};
    const attrPattern = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let match;
    while ((match = attrPattern.exec(raw))) {
        attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
    }
    return attrs;
}

class ClassList {
    constructor(element) {
        this.element = element;
    }

    values() {
        return this.element.className.split(/\s+/).filter(Boolean);
    }

    contains(name) {
        return this.values().includes(name);
    }

    add(name) {
        if (!this.contains(name)) {
            this.element.className = [...this.values(), name].join(' ');
        }
    }

    remove(name) {
        this.element.className = this.values().filter(item => item !== name).join(' ');
    }
}

class Element {
    constructor(document, tagName, attrs = {}) {
        this.document = document;
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.listeners = {};
        this.attributes = {};
        this.dataset = {};
        this.className = '';
        this.id = '';
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this._innerHTML = '';
        this.openingHTML = '';
        this.textContent = '';
        this.classList = new ClassList(this);
        Object.entries(attrs).forEach(([name, value]) => this.setAttribute(name, value));
        this.document.register(this);
    }

    setAttribute(name, value) {
        const decoded = decodeHtml(value);
        this.attributes[name] = decoded;
        if (name === 'id') this.id = decoded;
        if (name === 'class') this.className = decoded;
        if (name === 'value') this.value = decoded;
        if (name === 'checked') this.checked = true;
        if (name === 'disabled') this.disabled = true;
        if (name.startsWith('data-')) {
            const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
            this.dataset[key] = decoded;
        }
    }

    get innerHTML() {
        return this._innerHTML;
    }

    set innerHTML(html) {
        this.children.forEach(child => child.unregisterDeep());
        this.children = [];
        this._innerHTML = String(html || '');
        this.document.parseInto(this, this._innerHTML);
    }

    unregisterDeep() {
        this.children.forEach(child => child.unregisterDeep());
        this.document.unregister(this);
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    remove() {
        if (this.parentNode) {
            this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        }
        this.unregisterDeep();
    }

    insertAdjacentHTML(position, html) {
        const holder = new Element(this.document, 'div');
        holder.innerHTML = html;
        const newChildren = holder.children.slice();
        newChildren.forEach(child => {
            child.parentNode = this.parentNode;
        });

        if (this.parentNode && position === 'afterend') {
            const index = this.parentNode.children.indexOf(this);
            this.parentNode.children.splice(index + 1, 0, ...newChildren);
        } else {
            newChildren.forEach(child => this.appendChild(child));
        }
        holder.children = [];
        this.document.unregister(holder);
    }

    addEventListener(type, handler) {
        this.listeners[type] = this.listeners[type] || [];
        this.listeners[type].push(handler);
    }

    async dispatchEvent(event) {
        event.target = event.target || this;
        event.currentTarget = this;
        event.preventDefault = event.preventDefault || function () {};
        const handlers = this.listeners[event.type] || [];
        for (const handler of handlers) {
            await handler(event);
        }
    }

    click() {
        return this.dispatchEvent({ type: 'click', target: this });
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
        return this.document.findAll(this, selector);
    }
}

class TestDocument {
    constructor() {
        this.byId = new Map();
        this.all = new Set();
        this.domListeners = {};
        this.body = new Element(this, 'body', { id: 'document-body' });
    }

    register(element) {
        this.all.add(element);
        if (element.id) this.byId.set(element.id, element);
    }

    unregister(element) {
        this.all.delete(element);
        if (element.id && this.byId.get(element.id) === element) {
            this.byId.delete(element.id);
        }
    }

    createElement(tagName) {
        return new Element(this, tagName);
    }

    getElementById(id) {
        return this.byId.get(id) || null;
    }

    addEventListener(type, handler) {
        this.domListeners[type] = this.domListeners[type] || [];
        this.domListeners[type].push(handler);
    }

    async fireDOMContentLoaded() {
        for (const handler of this.domListeners.DOMContentLoaded || []) {
            await handler();
        }
    }

    querySelector(selector) {
        return this.body.querySelector(selector);
    }

    querySelectorAll(selector) {
        return this.body.querySelectorAll(selector);
    }

    getElementsByTagName(tagName) {
        const upper = tagName.toUpperCase();
        return Array.from(this.all).filter(element => element.tagName === upper && this.isConnected(element));
    }

    isConnected(element) {
        let current = element;
        while (current) {
            if (current === this.body) return true;
            current = current.parentNode;
        }
        return false;
    }

    parseInto(parent, html) {
        const tagPattern = /<([a-zA-Z][\w-]*)([^>]*)>/g;
        let match;
        while ((match = tagPattern.exec(html))) {
            if (match[0].startsWith('</')) continue;
            const element = new Element(this, match[1], parseAttributes(match[2]));
            element.openingHTML = match[0];
            parent.appendChild(element);
        }
    }

    findAll(root, selector) {
        const descendants = [];
        function walk(element) {
            element.children.forEach(child => {
                descendants.push(child);
                walk(child);
            });
        }
        walk(root);
        return descendants.filter(element => this.matches(element, selector));
    }

    matches(element, selector) {
        let current = selector.trim();
        const needsChecked = current.endsWith(':checked');
        const needsUnchecked = current.endsWith(':not(:checked)');
        current = current.replace(':not(:checked)', '').replace(':checked', '');

        if (needsChecked && !element.checked) return false;
        if (needsUnchecked && element.checked) return false;

        if (current.startsWith('.')) {
            return element.classList.contains(current.slice(1));
        }

        const attrMatch = current.match(/^([a-zA-Z0-9-]+)\[([^=]+)=['"]?([^'"\]]+)['"]?\]$/);
        if (attrMatch) {
            return element.tagName === attrMatch[1].toUpperCase()
                && String(element.attributes[attrMatch[2]] || '') === attrMatch[3];
        }

        return element.tagName === current.toUpperCase();
    }
}

function createResponse(ok, data) {
    return {
        ok,
        json: async () => data
    };
}

function createLocalStorage() {
    const store = new Map([['authToken', 'test-token']]);
    return {
        getItem: key => store.get(key) || null,
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: key => store.delete(key)
    };
}

async function createApp(routeHandler) {
    const document = new TestDocument();
    const calls = [];
    const toasts = [];
    const clipboard = [];

    function addRoot(id, tagName = 'div') {
        const element = new Element(document, tagName, { id });
        document.body.appendChild(element);
        return element;
    }

    const callbackForm = addRoot('callbackForm', 'form');
    callbackForm.corpid = new Element(document, 'input');
    callbackForm.callback_token = new Element(document, 'input');
    callbackForm.encoding_aes_key = new Element(document, 'input');

    const configForm = addRoot('configForm', 'form');
    configForm.corpsecret = new Element(document, 'input');
    configForm.agentid = new Element(document, 'input');
    configForm.description = new Element(document, 'input');

    const lookupForm = addRoot('lookupForm', 'form');
    lookupForm.code = new Element(document, 'input');

    [
        'validateBtn',
        'userListSection',
        'userList',
        'lookup-result',
        'result',
        'save-alert',
        'step1-container',
        'step2-container',
        'callbackResult',
        'logout-btn'
    ].forEach(id => addRoot(id, id.endsWith('Btn') || id === 'validateBtn' ? 'button' : 'div'));

    const context = {
        document,
        window: {
            location: {
                search: '',
                href: '',
                origin: 'https://example.test'
            }
        },
        localStorage: createLocalStorage(),
        navigator: {
            clipboard: {
                writeText: text => clipboard.push(text)
            }
        },
        URLSearchParams,
        fetch: async (url, options = {}) => {
            calls.push({ url, options });
            if (url === '/api/auth-status') {
                return createResponse(true, { loggedIn: true });
            }
            return routeHandler(url, options, calls);
        },
        lucide: {
            createIcons() {}
        },
        gsap: {
            from() {},
            fromTo() {},
            to(_target, options) {
                if (options && typeof options.onComplete === 'function') options.onComplete();
            }
        },
        setTimeout() {
            return 1;
        },
        clearTimeout() {},
        console
    };

    const originalAppendChild = document.body.appendChild.bind(document.body);
    document.body.appendChild = child => {
        if (child.classList && child.classList.contains('toast')) {
            toasts.push(child);
        }
        return originalAppendChild(child);
    };

    vm.runInNewContext(source, context, { filename: scriptPath });
    await document.fireDOMContentLoaded();

    return {
        document,
        calls,
        toasts,
        clipboard,
        lookupForm,
        async lookup(code) {
            lookupForm.code.value = code;
            await lookupForm.dispatchEvent({ type: 'submit' });
        },
        async click(id) {
            const element = document.getElementById(id);
            assert(element, `missing element #${id}`);
            await element.click();
            await flushAsyncWork();
            return element;
        },
        async change(element) {
            await element.dispatchEvent({ type: 'change', target: element });
        },
        async input(id, value) {
            const element = document.getElementById(id);
            assert(element, `missing input #${id}`);
            element.value = value;
            await element.dispatchEvent({ type: 'input', target: element });
        }
    };
}

async function flushAsyncWork() {
    for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
    }
}

function baseConfig(overrides = {}) {
    return {
        code: 'cfg1',
        corpid: 'corp1',
        agentid: 100,
        touser: ['u1', 'old_user'],
        description: 'normal',
        callback_enabled: true,
        callback_token: 'callback-token',
        created_at: '2026-06-22T00:00:00.000Z',
        ...overrides
    };
}

function memberPayload(overrides = {}) {
    return {
        users: [
            { userid: 'u1', displayName: 'Alice Visible' },
            { userid: 'u2', name: 'Bob Name' },
            { userid: 'charlie_user' }
        ],
        current: ['u1', 'old_user'],
        orphan: ['old_user', 'old_user'],
        ...overrides
    };
}

function standardRoutes({ config = baseConfig(), members = memberPayload(), saveOk = true, saveError = 'save failed', refreshed = baseConfig({ touser: ['u1', 'u2', 'old_user'] }) } = {}) {
    return async (url, options) => {
        const method = options.method || 'GET';
        if (url === '/api/configuration/cfg1' && method === 'GET') {
            const hasPut = standardRoutes._calls && standardRoutes._calls.hasPut;
            return createResponse(true, hasPut ? refreshed : config);
        }
        if (url === '/api/configuration/cfg1/users') {
            return createResponse(true, members);
        }
        if (url === '/api/configuration/cfg1' && method === 'PUT') {
            standardRoutes._calls = { hasPut: true };
            return createResponse(saveOk, saveOk ? { ok: true } : { error: saveError });
        }
        throw new Error(`unexpected fetch ${method} ${url}`);
    };
}

async function run(name, fn) {
    try {
        await fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        console.error(`not ok - ${name}`);
        throw error;
    }
}

(async () => {
    await run('second-step validation sends AgentID with corp credentials', async () => {
        let validateBody = null;
        const app = await createApp(async (url, options) => {
            if (url === '/api/validate') {
                validateBody = JSON.parse(options.body);
                return createResponse(true, {
                    agentid: 100001,
                    users: [{ userid: 'alice', name: 'Alice' }]
                });
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        app.document.getElementById('callbackForm').corpid.value = 'corp-1';
        app.document.getElementById('configForm').corpsecret.value = 'secret-1';
        app.document.getElementById('configForm').agentid.value = '100001';
        await app.click('validateBtn');

        assert.deepStrictEqual(validateBody, {
            corpid: 'corp-1',
            corpsecret: 'secret-1',
            agentid: 100001
        });
        assert(!app.document.getElementById('userListSection').classList.contains('hidden'), 'member list should be visible');
    });

    await run('completed edit fetches members with Authorization', async () => {
        const app = await createApp(standardRoutes());
        await app.lookup('cfg1');
        assert(app.document.getElementById('lookup-detail-card'), 'lookup detail card should render');
        await app.click('edit-config-btn');

        const memberCall = app.calls.find(call => call.url === '/api/configuration/cfg1/users');
        assert(memberCall, 'member endpoint was not requested');
        assert.strictEqual(memberCall.options.headers.Authorization, 'Bearer test-token');
    });

    await run('incomplete config does not fetch members and shows a toast', async () => {
        const app = await createApp(standardRoutes({
            config: baseConfig({ agentid: 0, touser: [] })
        }));
        await app.lookup('cfg1');
        await app.click('edit-config-btn');

        assert(!app.calls.some(call => call.url === '/api/configuration/cfg1/users'), 'member endpoint should not be requested');
        assert(app.toasts.some(toast => toast.innerHTML.includes('暂不能编辑发送人员')), 'expected incomplete-config toast');
    });

    await run('rendering selects current visible users and orphan defaults, with filtering and select-all scope', async () => {
        const app = await createApp(standardRoutes());
        await app.lookup('cfg1');
        await app.click('edit-config-btn');

        assert(app.document.getElementById('edit-section'), `edit section should render; ids=${Array.from(app.document.byId.keys()).join(',')} calls=${app.calls.map(call => call.url).join(',')} toasts=${app.toasts.map(toast => toast.innerHTML).join('|')}`);
        assert(app.document.getElementById('edit-user-list'), 'edit user list should render');
        let userChecks = app.document.querySelectorAll('.edit-user-checkbox');
        const byValue = value => userChecks.find(checkbox => checkbox.value === value);
        assert(userChecks.length > 0, `expected rendered user checkboxes, got list html: ${app.document.getElementById('edit-user-list').innerHTML}`);
        assert.strictEqual(byValue('u1').checked, true, 'current visible user should be checked');
        assert.strictEqual(byValue('u2').checked, false, 'non-current visible user should not be checked');

        const orphanChecks = app.document.querySelectorAll('.edit-orphan-checkbox');
        assert(orphanChecks.length >= 1, 'orphan checkboxes should render');
        assert(orphanChecks.every(checkbox => checkbox.checked), 'orphan checkboxes should default checked');

        await app.input('edit-user-filter', 'bob');
        let listHtml = app.document.getElementById('edit-user-list').innerHTML;
        assert(listHtml.includes('Bob Name'), 'filter should match name');
        assert(!listHtml.includes('Alice Visible'), 'filter should hide non-matching displayName');

        await app.input('edit-user-filter', 'charlie_user');
        listHtml = app.document.getElementById('edit-user-list').innerHTML;
        assert(listHtml.includes('charlie_user'), 'filter should match userid');

        await app.input('edit-user-filter', 'missing-person');
        assert(app.document.getElementById('edit-user-list').innerHTML.includes('没有匹配的成员'), 'empty filter result should show a message');

        orphanChecks[0].checked = false;
        await app.change(orphanChecks[0]);
        await app.input('edit-user-filter', 'bob');
        await app.click('edit-select-all');
        userChecks = app.document.querySelectorAll('.edit-user-checkbox');
        assert(userChecks.find(checkbox => checkbox.value === 'u2').checked, 'select-all should select filtered visible user');
        assert.strictEqual(orphanChecks[0].checked, false, 'select-all must not affect orphan checkbox state');
    });

    await run('save merges checked visible users and orphan, dedupes, puts exact body, and refreshes', async () => {
        standardRoutes._calls = null;
        const app = await createApp(standardRoutes());
        await app.lookup('cfg1');
        await app.click('edit-config-btn');
        await app.input('edit-user-filter', 'bob');
        await app.click('edit-select-all');
        await app.click('edit-save');

        const putCall = app.calls.find(call => call.url === '/api/configuration/cfg1' && call.options.method === 'PUT');
        assert(putCall, 'PUT should be sent');
        assert.deepStrictEqual(JSON.parse(putCall.options.body), { touser: ['u1', 'u2', 'old_user'] });

        const getAfterPut = app.calls.findIndex(call => call === putCall);
        assert(app.calls.slice(getAfterPut + 1).some(call => call.url === '/api/configuration/cfg1' && !call.options.method), 'successful save should refresh configuration detail');
        assert.strictEqual(app.document.getElementById('edit-section'), null, 'successful save should collapse edit section');
    });

    await run('empty save does not send PUT', async () => {
        const app = await createApp(standardRoutes());
        await app.lookup('cfg1');
        await app.click('edit-config-btn');

        app.document.querySelectorAll('.edit-user-checkbox').forEach(checkbox => {
            checkbox.checked = false;
        });
        app.document.querySelectorAll('.edit-orphan-checkbox').forEach(checkbox => {
            checkbox.checked = false;
        });
        await app.click('edit-save');

        assert(!app.calls.some(call => call.options.method === 'PUT'), 'empty save must not send PUT');
        assert(app.document.getElementById('edit-error').innerHTML.includes('请至少选择一个成员'), 'empty save should show frontend validation error');
    });

    await run('failed save keeps edit section and escapes server error', async () => {
        const badError = '<img src=x onerror=alert(1)>';
        const app = await createApp(standardRoutes({ saveOk: false, saveError: badError }));
        await app.lookup('cfg1');
        await app.click('edit-config-btn');
        await app.click('edit-save');

        const errorHtml = app.document.getElementById('edit-error').innerHTML;
        assert(app.document.getElementById('edit-section'), 'failed save should keep edit section');
        assert(!errorHtml.includes(badError), 'raw server error should not be injected');
        assert(errorHtml.includes('&lt;img'), 'server error should be escaped');
    });

    await run('dynamic detail, member, orphan, and toast content is escaped', async () => {
        const raw = '<img src=x onerror=alert(1)>';
        const scriptRaw = '<script>alert(1)</script>';
        const route = async (url, options) => {
            if (url === '/api/configuration/cfg1' && (options.method || 'GET') === 'GET') {
                return createResponse(true, baseConfig({
                    corpid: raw,
                    agentid: raw,
                    touser: [raw],
                    description: scriptRaw,
                    callback_token: raw
                }));
            }
            if (url === '/api/configuration/cfg1/users') {
                return createResponse(true, {
                    users: [{ userid: raw, displayName: scriptRaw }],
                    current: [raw, 'orphan<bad>'],
                    orphan: ['orphan<bad>']
                });
            }
            throw new Error(`unexpected fetch ${url}`);
        };

        const app = await createApp(route);
        await app.lookup('cfg1');
        const detailHtml = app.document.getElementById('lookup-result').innerHTML;
        assert(!detailHtml.includes(raw), 'detail should not contain raw malicious string');
        assert(!detailHtml.includes(scriptRaw), 'detail should not contain raw script string');
        assert(detailHtml.includes('&lt;img'), 'detail should contain escaped malicious string');

        await app.click('edit-config-btn');
        const orphanOpeningHtml = app.document.querySelectorAll('.edit-orphan-checkbox').map(checkbox => checkbox.openingHTML).join('');
        const editHtml = [
            app.document.getElementById('edit-section').innerHTML,
            app.document.getElementById('edit-user-list').innerHTML,
            app.document.getElementById('edit-orphan-list').innerHTML,
            orphanOpeningHtml
        ].join('');
        assert(!editHtml.includes(raw), 'edit section should not contain raw malicious member userid/name');
        assert(!editHtml.includes(scriptRaw), 'edit section should not contain raw malicious displayName');
        assert(editHtml.includes('&lt;img') && editHtml.includes('orphan&lt;bad&gt;'), 'member and orphan values should be escaped');
        assert.strictEqual(app.document.getElementsByTagName('script').length, 0, 'escaped script should not become a script element');
        assert.strictEqual(app.document.getElementsByTagName('img').length, 0, 'escaped img should not become an img element');

        const errorRoute = async (url) => {
            if (url === '/api/configuration/cfg1') return createResponse(true, baseConfig());
            if (url === '/api/configuration/cfg1/users') return createResponse(false, { error: raw });
            throw new Error(`unexpected fetch ${url}`);
        };
        const errorApp = await createApp(errorRoute);
        await errorApp.lookup('cfg1');
        await errorApp.click('edit-config-btn');
        assert(errorApp.toasts.some(toast => toast.innerHTML.includes('&lt;img')), 'toast error should be escaped');
        assert(!errorApp.toasts.some(toast => toast.innerHTML.includes(raw)), 'toast should not contain raw error HTML');
    });

    console.log('frontend-edit-touser behavior validation passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
