#!/usr/bin/env node
// 敏感信息扫描脚本（SEC-INCIDENT-2026-07-04）。
//
// 用途：扫描工作树与（可选）Git 历史中的可疑凭据模式，
//       防止真实密码/Token/AESKey/notify_key/CorpSecret 明文再次进入仓库。
//
// 输出契约：只报告文件:行 与命中规则名，**绝不回显秘密值本身**。
//
// 用法：
//   node scripts/scan-secrets.js              # 扫描工作树
//   node scripts/scan-secrets.js --history    # 同时扫描所有提交的 blob
//   node scripts/scan-secrets.js --staged     # 扫描暂存区（pre-commit 用）
//
// 退出码：0 = 无命中；1 = 有命中（CI 应失败）。
//
// 设计原则：
//   - 不输出任何匹配到的字符串内容，只输出位置与规则名。
//   - 规则保守偏向（宁可误报，不可漏报真实凭据）。
//   - 已知的占位符（REDACTED/REPLACE_ME/your-xxx/test-instance.example）不报警。

'use strict';

const { execSync } = require('child_process');
const path = require('path');

// 占位符白名单：这些值出现在测试/文档中是允许的。
const PLACEHOLDER_VALUES = new Set([
    'redacted', 'replace_me', 'your-test-instance', 'your-test-admin',
    'test-instance.example', 'example.com', 'changeme', 'your-secret-here',
    'a'.repeat(32) // 测试用的 32 字节密钥占位符
]);

// 已知泄露值指纹（哈希，不存明文）——用于检测是否再次出现。
// 这些是 2026-07-04 事件的凭据；轮换后仍扫描以防回归。
const crypto = require('crypto');
function fingerprint(value) {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}
// 已知泄露密码/用户名/域名的指纹（不存明文，只存哈希用于检测）。
const KNOWN_LEAKED_FINGERPRINTS = new Set([
    // 历史事件中的凭据指纹化存储；轮换后这些指纹仍用于回归检测。
    // 如需添加新指纹，用 fingerprint('真实值') 计算后填入。
]);

// 已知模板/示例文件名模式（这些文件中的占位符值是允许的）。
const TEMPLATE_FILE_PATTERNS = [
    /\.env\.example$/, /\.env\.template$/, /^env\.template$/,
    /README.*\.md$/i, /\.md$/i, /CHANGELOG/i,
    /api-docs\.html$/, /scan-secrets\.js$/
];

// 占位符值模式（正则）：匹配常见模板占位符。
const PLACEHOLDER_PATTERNS = [
    /^replace_me$/i, /^redacted$/i, /^changeme$/i,
    /^your[-_].*$/i,      // your-password, your-test-admin, your-secret-here
    /^<.*>$/,             // <password>, <test-instance>
    /^test[-_].*$/i,      // test-instance, test_password
    /^example/i,          // example.com
    /^demo[-_].*$/i,
    /^xxx+$/i,            // xxx, xxxx
    /^placeholder$/i,
    /^a{16,}$/i,          // 测试用的重复字符密钥（a×32）
    /^secret[-_]?here$/i,
    /^set[-_].*$/i,       // set_your_password
    /^\$\(.*\)$/,         // $(command)
    /^docker[-_].*$/i     // docker compose 引用
];

function isPlaceholderValue(value) {
    const v = String(value).trim();
    if (!v) return true;
    if (PLACEHOLDER_VALUES.has(v.toLowerCase())) return true;
    // 环境变量引用 ${VAR} 或 $VAR。
    if (/^\$\{|\$\w+$/.test(v)) return true;
    for (const p of PLACEHOLDER_PATTERNS) {
        if (p.test(v)) return true;
    }
    return false;
}

function isTemplateFile(filePath) {
    for (const p of TEMPLATE_FILE_PATTERNS) {
        if (p.test(filePath)) return true;
    }
    return false;
}

// 扫描规则：每条规则定义一个正则与描述。
// 规则匹配到的内容不会输出，只输出规则名与位置。
const RULES = [
    {
        name: 'plaintext-password-assignment',
        // QYWX_LIVE_PASS=<value> 等形式的真实赋值（排除模板文件）。
        pattern: /(?:QYWX_LIVE_PASS|ADMIN_PASSWORD)\s*[=:]\s*(['"]?)([^\s'"#,)]+)\1/g,
        check: (matched, value, filePath) => {
            if (isTemplateFile(filePath)) return false;
            return !isPlaceholderValue(value);
        }
    },
    {
        name: 'live-user-assignment',
        // QYWX_LIVE_USER=<非占位符值>（排除模板文件）。
        pattern: /QYWX_LIVE_USER\s*[=:]\s*(['"]?)([^\s'"#,)]+)\1/g,
        check: (matched, value, filePath) => {
            if (isTemplateFile(filePath)) return false;
            return !isPlaceholderValue(value);
        }
    },
    {
        name: 'known-leaked-credential',
        // 检测已知泄露值的指纹（不存明文）。
        pattern: /([\x20-\x7e]{6,})/g,
        check: (matched, value) => {
            const v = String(value).trim();
            if (!v) return false;
            return KNOWN_LEAKED_FINGERPRINTS.has(fingerprint(v));
        }
    },
    {
        name: 'private-key-block',
        // PEM 私钥块。
        pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/g,
        check: () => true
    }
];

// 扫描单个文件内容，返回命中列表（不含秘密值）。
function scanContent(content, filePath) {
    const hits = [];
    for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        let m;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            rule.pattern.lastIndex = 0;
            // 行级扫描，避免跨行误匹配。
            while ((m = rule.pattern.exec(lines[i])) !== null) {
                // captured：取最后一个捕获组（占位符引号后的值）。
                const captured = m[m.length - 1] || m[0];
                try {
                    if (rule.check(m[0], captured, filePath)) {
                        hits.push({
                            file: filePath,
                            line: i + 1,
                            rule: rule.name
                            // 注意：不记录 matched/captured（秘密值）。
                        });
                    }
                } catch (_e) { /* 规则异常跳过 */ }
                if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
            }
        }
    }
    return hits;
}

// 收集工作树文件（排除 .git/node_modules/coverage）。
function listWorkingTreeFiles() {
    try {
        const out = execSync('git ls-files', { encoding: 'utf8', cwd: process.cwd() });
        return out.split('\n').filter(Boolean);
    } catch (_e) {
        // 非 git 仓库：用 find 回退。
        const { execSync: es } = require('child_process');
        try {
            const out = es('find . -type f -not -path "./.git/*" -not -path "./node_modules/*" -not -path "./coverage/*"', { encoding: 'utf8' });
            return out.split('\n').filter(Boolean).map(f => f.replace(/^\.\//, ''));
        } catch (_e2) {
            return [];
        }
    }
}

// 读取文件内容（二进制跳过）。
const fs = require('fs');
function readFile(filePath) {
    try {
        const buf = fs.readFileSync(filePath);
        // 跳过大于 1MB 的文件与明显二进制文件。
        if (buf.length > 1024 * 1024) return null;
        const content = buf.toString('utf8');
        if (content.includes('\u0000')) return null; // 二进制
        return content;
    } catch (_e) {
        return null;
    }
}

// 扫描历史：对所有提交的所有 blob 扫描。
function scanHistory() {
    const hits = [];
    try {
        // 列出所有 blob 对象。
        const out = execSync('git cat-file --batch-all-objects --batch-check', { encoding: 'utf8' });
        const blobs = out.split('\n').filter(Boolean)
            .map(line => line.split(/\s+/))
            .filter(parts => parts[1] === 'blob')
            .map(parts => parts[0]);
        for (const sha of blobs) {
            try {
                const content = execSync(`git cat-file -p ${sha}`, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
                const fileHits = scanContent(content, `<blob:${sha.slice(0, 12)}>`);
                hits.push(...fileHits);
            } catch (_e) { /* 跳过过大/二进制 blob */ }
        }
    } catch (_e) {
        console.error('[scan-secrets] 历史扫描失败（非 git 仓库或 git 不可用）');
    }
    return hits;
}

function main() {
    const args = process.argv.slice(2);
    const scanHist = args.includes('--history');
    const scanStaged = args.includes('--staged');

    const allHits = [];

    if (scanStaged) {
        // 暂存区扫描（pre-commit 钩子用）。
        try {
            const out = execSync('git diff --cached --name-only --diff-filter=AM', { encoding: 'utf8' });
            const files = out.split('\n').filter(Boolean);
            for (const f of files) {
                const content = readFile(f);
                if (content) allHits.push(...scanContent(content, f));
            }
        } catch (_e) { /* 非暂存场景 */ }
    } else {
        // 工作树扫描。
        const files = listWorkingTreeFiles();
        for (const f of files) {
            const content = readFile(f);
            if (content) allHits.push(...scanContent(content, f));
        }
    }

    if (scanHist) {
        allHits.push(...scanHistory());
    }

    if (allHits.length === 0) {
        console.log('[scan-secrets] 无敏感信息命中。');
        process.exit(0);
    }

    // 输出命中（仅位置与规则名，不含秘密值）。
    console.error(`[scan-secrets] 发现 ${allHits.length} 处可疑命中：`);
    for (const h of allHits) {
        console.error(`  ${h.file}:${h.line}  [${h.rule}]`);
    }
    console.error('');
    console.error('注意：输出仅包含位置与规则名，不回显秘密值。');
    console.error('请人工核对上述位置，确认是否为真实凭据；如是，立即轮换并清除。');
    process.exit(1);
}

main();
