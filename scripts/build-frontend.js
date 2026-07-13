'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'node_modules', 'lucide', 'dist', 'umd', 'lucide.min.js');
const vendorDir = path.join(root, 'public', 'vendor');
const target = path.join(vendorDir, 'lucide.min.js');

if (!fs.existsSync(source)) {
    throw new Error('缺少 lucide 构建依赖，请先运行 npm ci');
}

fs.mkdirSync(vendorDir, { recursive: true });
const content = fs.readFileSync(source, 'utf8')
    .replace(/\r?\n?\/\/# sourceMappingURL=lucide\.min\.js\.map\s*$/, '');
fs.writeFileSync(target, content + '\n', 'utf8');

console.log('[build:frontend] 已生成 public/app.css 与 public/vendor/lucide.min.js');
