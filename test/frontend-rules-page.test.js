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

// SEC-011 / SEC-002 回归保护：禁止 @latest CDN，禁止 token 进 URL/localStorage
test('SEC-011 all frontend pages use pinned CDN versions (no @latest in script src)', () => {
    const pages = ['login.html', 'index.html', 'rules.html', 'api-docs.html'];
    for (const page of pages) {
        const content = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
        // 匹配脚本/样式引用中的 @latest，忽略注释文字
        const srcMatches = content.match(/(?:src|href)=["'][^"']*@latest[^"']*["']/g) || [];
        assert.equal(srcMatches.length, 0, `${page} must not reference @latest CDN in src/href: ${srcMatches.join(', ')}`);
        // cdn.tailwindcss.com 必须带版本号（禁止裸 JIT 编译器）
        const bareTailwind = content.match(/cdn\.tailwindcss\.com(?!\/\d)/g) || [];
        assert.equal(bareTailwind.length, 0, `${page} must pin tailwind version`);
    }
});

test('SEC-002 frontend scripts do not persist token in localStorage or URL', () => {
    const scripts = ['script.js', 'rules.js'];
    for (const file of scripts) {
        const content = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
        // 允许出现 localStorage.removeItem('authToken')（清理历史），禁止 setItem 写入
        assert.doesNotMatch(content, /localStorage\.setItem\(['"]authToken['"]/, `${file} must not write authToken to localStorage`);
    }
    // login.html 不再把 token 拼到 URL
    const login = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
    assert.doesNotMatch(login, /\?token=/, 'login.html must not redirect with ?token= in URL');
});

