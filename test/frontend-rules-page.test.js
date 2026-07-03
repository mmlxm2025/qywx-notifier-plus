const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'rules.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'rules.js'), 'utf8');

test('rules page selects an existing configuration code from a list', () => {
    assert.match(html, /<select[^>]+id="config-code"/);
    assert.doesNotMatch(html, /<input[^>]+id="config-code"/);
    assert.match(script, /\/api\/configurations/);
});

test('rules page marks invisible or deleted members with red labels', () => {
    assert.match(script, /成员不可见或成员已删除/);
    assert.match(script, /badge-error|bg-error/);
});
