// regenerateRuleApiCode 不得把 app_missing / rule_missing 等掩成 503 GENERATION_FAILED。

const assert = require('assert/strict');
const test = require('node:test');

function clearModule(modulePath) {
    delete require.cache[require.resolve(modulePath)];
}

function replaceForTest(t, object, property, value) {
    const had = Object.prototype.hasOwnProperty.call(object, property);
    const original = object[property];
    object[property] = value;
    t.after(() => {
        if (had) object[property] = original;
        else delete object[property];
    });
}

function withEnv(t, key, value) {
    const had = Object.prototype.hasOwnProperty.call(process.env, key);
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => {
        if (had) process.env[key] = original;
        else delete process.env[key];
    });
}

function setup(t, { cause = 'app_missing' } = {}) {
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
        withEnv(t, 'ENCRYPTION_KEY', 'a'.repeat(32));
    }
    const Database = require('../src/core/database');
    replaceForTest(t, Database.prototype, 'init', async function init() {});
    replaceForTest(t, Database.prototype, 'mutateRuleWithAppVersion', async function () {
        const e = new Error(cause);
        e.__ruleCause = cause;
        if (cause === 'version_conflict') e.__currentVersion = 9;
        throw e;
    });
    clearModule('../src/services/notifier');
    t.after(() => clearModule('../src/services/notifier'));
    return require('../src/services/notifier');
}

test('regenerate：app_missing → 404 APP_NOT_FOUND（非 503）', async t => {
    const notifier = setup(t, { cause: 'app_missing' });
    let err;
    try {
        await notifier.regenerateRuleApiCode(1, { expectedVersion: 1 });
    } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.statusCode, 404);
    assert.equal(err.businessCode, 'APP_NOT_FOUND');
});

test('regenerate：rule_missing → 404 RULE_NOT_FOUND（非 503）', async t => {
    const notifier = setup(t, { cause: 'rule_missing' });
    let err;
    try {
        await notifier.regenerateRuleApiCode(99, { expectedVersion: 1 });
    } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.statusCode, 404);
    assert.equal(err.businessCode, 'RULE_NOT_FOUND');
});

test('regenerate：app_not_completed → 409 APP_NOT_COMPLETED', async t => {
    const notifier = setup(t, { cause: 'app_not_completed' });
    let err;
    try {
        await notifier.regenerateRuleApiCode(1, { expectedVersion: 1 });
    } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.statusCode, 409);
    assert.equal(err.businessCode, 'APP_NOT_COMPLETED');
});

test('regenerate：version_conflict → 409 APP_VERSION_CONFLICT', async t => {
    const notifier = setup(t, { cause: 'version_conflict' });
    let err;
    try {
        await notifier.regenerateRuleApiCode(1, { expectedVersion: 1 });
    } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.statusCode, 409);
    assert.equal(err.businessCode, 'APP_VERSION_CONFLICT');
    assert.equal(err.details.version, 9);
});
