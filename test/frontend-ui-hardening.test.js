const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const pages = ['login.html', 'index.html', 'wizard.html', 'edit.html', 'rules.html', 'api-docs.html'];

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function relativeLuminance(hex) {
    const channels = hex.slice(1).match(/.{2}/g).map(value => {
        const channel = Number.parseInt(value, 16) / 255;
        return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(first, second) {
    const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
    const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
    return (lighter + 0.05) / (darker + 0.05);
}

test('all pages use the self-hosted frontend bundle and qywx theme', () => {
    for (const page of pages) {
        const html = read(`public/${page}`);
        assert.match(html, /data-theme="qywx"/, `${page} should use the qywx theme`);
        assert.match(html, /href="\/public\/app\.css"/, `${page} should load the local Tailwind bundle`);
        assert.match(html, /href="\/public\/styles\.css"/, `${page} should load shared local styles`);
        assert.match(html, /src="\/public\/vendor\/lucide\.min\.js"/, `${page} should load local icons`);
        assert.match(html, /href="\/public\/favicon\.svg"/, `${page} should declare the local favicon`);
        assert.doesNotMatch(html, /<(?:script|link)\b[^>]+(?:src|href)="https?:\/\//i,
            `${page} must not depend on a remote script or stylesheet`);
    }
});

test('strict CSP is compatible with the frontend sources', () => {
    for (const page of pages) {
        const html = read(`public/${page}`);
        assert.doesNotMatch(html, /<style\b/i, `${page} must not contain an inline style block`);
        assert.doesNotMatch(html, /\sstyle\s*=/i, `${page} must not contain an inline style attribute`);
    }

    for (const script of ['public/components/modal.js', 'public/components/toast.js']) {
        assert.doesNotMatch(read(script), /\.style(?:\.|\[|\s*=)/, `${script} must not set inline styles`);
    }

    const { buildCsp } = require('../src/core/security-headers');
    const csp = buildCsp();
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:\/\//i);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'/);
});

test('generated frontend assets exist and are non-empty', () => {
    const appCss = path.join(root, 'public', 'app.css');
    const lucide = path.join(root, 'public', 'vendor', 'lucide.min.js');
    assert.ok(fs.statSync(appCss).size > 20_000, 'compiled CSS bundle is unexpectedly small');
    assert.ok(fs.statSync(lucide).size > 100_000, 'local Lucide bundle is unexpectedly small');
    assert.match(read('public/app.css'), /tailwindcss v3\.4\.16/);
});

test('theme foreground/background pairs meet WCAG AA normal-text contrast', () => {
    const { qywxTheme } = require('../tailwind.config');
    for (const [background, foreground] of [
        ['primary', 'primary-content'],
        ['info', 'info-content'],
        ['success', 'success-content'],
        ['warning', 'warning-content'],
        ['error', 'error-content']
    ]) {
        const ratio = contrastRatio(qywxTheme[background], qywxTheme[foreground]);
        assert.ok(ratio >= 4.5, `${background}/${foreground} contrast ${ratio.toFixed(2)} is below 4.5:1`);
    }
});

test('narrow-screen overflow, labels and edit action regressions stay fixed', () => {
    const rules = read('public/rules.html');
    assert.match(rules, /id="rule-api-code"[^>]*class="[^"]*min-w-0[^"]*w-0/);
    assert.match(rules, /<label\s+for="rule-api-code"/);
    assert.match(rules, /id="member-filter"[^>]*aria-label="筛选成员"/);
    const rulesScript = read('public/rules.js');
    assert.match(rulesScript, /checked \? '禁用' : '启用'/);
    assert.match(rulesScript, /setAttribute\('aria-label', label\)/);
    // 规则列表使用响应式卡片，避免移动端宽表横向溢出。
    assert.match(rulesScript, /app-rule-card/);
    assert.doesNotMatch(rulesScript, /table-zebra/);

    const edit = read('public/edit.html');
    assert.doesNotMatch(edit, /class="[^"]*\bsticky\b/);

    const apiDocs = read('public/api-docs.html');
    assert.match(apiDocs, /api-docs-card[^\n]*min-w-0/);
    assert.doesNotMatch(apiDocs, /http:\/\/your-server/);
    assert.match(apiDocs, /https:\/\/your-server\.example/);

    const styles = read('public/styles.css');
    assert.match(styles, /#status \.alert > \*[\s\S]*?overflow-wrap:\s*anywhere/,
        'long backend errors must wrap inside the status banner');
});

test('responsive type scale uses rem with 16px PC base', () => {
    const styles = read('public/styles.css');
    assert.match(styles, /html\s*\{[\s\S]*?font-size:\s*100%/);
    assert.match(styles, /--text-base:\s*1rem/);
    assert.match(styles, /\.app-type-page\s*\{[\s\S]*?font-size:\s*var\(--text-xl\)/);
    assert.match(styles, /@media\s*\(min-width:\s*640px\)[\s\S]*?\.app-type-page[\s\S]*?--text-2xl/);

    const tailwind = read('tailwind.config.js');
    assert.match(tailwind, /base:\s*\[\s*'1rem'/);

    for (const page of pages) {
        const html = read(`public/${page}`);
        assert.match(html, /viewport/, `${page} needs viewport meta`);
        assert.doesNotMatch(html, /font-size:\s*\d+px/, `${page} must not hardcode px font-size`);
    }
});
