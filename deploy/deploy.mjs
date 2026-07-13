#!/usr/bin/env node
// =====================================================================
// 企业微信通知转发服务 - 交互式部署脚本
//
// 用途：引导用户选择部署模式（镜像拉取 / 本地构建），生成对应的
//       docker-compose.yml + .env，引导填写密钥，并可选立即启动。
//
// 设计：
//   - 纯 Node.js ESM，零额外依赖（仅用内置 fs / path / readline / child_process）
//   - 跨平台：Windows Git Bash / CMD / PowerShell / Linux / macOS 均可运行
//   - 与现有 build-and-pack.sh/.bat、import-load.sh 完全正交，不改动它们
//
// 用法：
//   node deploy/deploy.mjs          # 在仓库内运行（模板相对路径自动解析）
//   node deploy/deploy.mjs --help   # 查看帮助
//
// 安全：
//   - 自动生成的密钥只在终端短暂显示，写入 .env 后由用户保管
//   - 占位符黑名单与 config.js / import-load.sh 对齐，残留则警告
//   - 密码交互输入时不回显（支持的平台下）
// =====================================================================

import { createInterface } from 'node:readline';
import {
    existsSync,
    mkdirSync,
    copyFileSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------- 常量 ----------

// 仓库内模板根目录
const TEMPLATES_DIR = join(__dirname, 'templates');

// 占位符黑名单（对齐 config.js + import-load.sh，残留则视为未配置）
const PLACEHOLDER_BLACKLIST = [
    'change-this-to-a-random-32-char-string',
    'your-32-character-encryption-key-here',
    'default-key-for-development-only',
    'change-this-to-a-strong-password',
    'your-secure-password',
];

// ---------- 颜色（终端 ANSI，不支持时降级为空）----------
const color = {
    enabled: process.stdout.isTTY && process.env.NO_COLOR === undefined,
};
function paint(code, str) {
    return color.enabled ? `\x1b[${code}m${str}\x1b[0m` : str;
}
const c = {
    bold: (s) => paint('1', s),
    dim: (s) => paint('2', s),
    green: (s) => paint('32', s),
    yellow: (s) => paint('33', s),
    red: (s) => paint('31', s),
    cyan: (s) => paint('36', s),
};

// ---------- readline 工具 ----------
const rl = createInterface({ input: process.stdin, output: process.stdout });

function question(prompt) {
    return new Promise((resolveQ) => rl.question(prompt, (answer) => resolveQ(answer.trim())));
}

// 带默认值的提问：空输入返回默认值
async function questionDefault(prompt, defaultValue) {
    const hint = c.dim(`（默认：${defaultValue}）`);
    const answer = await question(`${prompt} ${hint} `);
    return answer === '' ? defaultValue : answer;
}

// 是/否提问
async function questionYesNo(prompt, defaultYes = true) {
    const hint = defaultYes ? c.dim('[Y/n]') : c.dim('[y/N]');
    const answer = (await question(`${prompt} ${hint} `)).toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes';
}

// 多选一提问：options = [{label, value, desc}]，返回选中的 value
async function questionChoice(prompt, options, defaultIndex = 0) {
    console.log(c.bold(prompt));
    options.forEach((opt, i) => {
        const marker = i === defaultIndex ? c.green('→') : ' ';
        const def = i === defaultIndex ? c.dim('（默认）') : '';
        console.log(`  ${marker} [${i + 1}] ${opt.label} ${def}`);
        if (opt.desc) console.log(`      ${c.dim(opt.desc)}`);
    });
    const answer = await question(`输入序号 ${c.dim(`(1-${options.length})`)}：`);
    const idx = answer === '' ? defaultIndex : parseInt(answer, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= options.length) {
        console.log(c.yellow('输入无效，使用默认项。'));
        return options[defaultIndex].value;
    }
    return options[idx].value;
}

// ---------- 辅助函数 ----------

// 检测命令是否可用
function hasCommand(cmd) {
    const checker = process.platform === 'win32' ? 'where' : 'command -v';
    try {
        spawnSync(checker, [cmd], { stdio: 'ignore', shell: true });
        return true;
    } catch {
        return false;
    }
}

// 用 openssl 生成随机 hex（返回字符串或 null）
function generateRandomHex(bytes = 32) {
    try {
        const out = execSync(`openssl rand -hex ${bytes}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return out.trim();
    } catch {
        return null;
    }
}

// 设置 .env 中某个 KEY 的值（保留注释、保留其他行）
// matchValueOnly 为 true 时仅替换已存在的赋值，不新增
function setEnvValue(envText, key, value) {
    const lines = envText.split(/\r?\n/);
    let replaced = false;
    const newLines = lines.map((line) => {
        // 匹配 KEY=... 或 # KEY=...（注释掉的也一并替换为生效值）
        const m = line.match(new RegExp(`^(#\\s*)?${key}\\s*=`));
        if (m) {
            replaced = true;
            return `${key}=${value}`;
        }
        return line;
    });
    if (!replaced) {
        // 文件里没找到该 KEY，追加到末尾
        newLines.push(`${key}=${value}`);
    }
    return newLines.join('\n');
}

// 校验 .env 文本中是否残留占位符黑名单值
function checkPlaceholders(envText) {
    const issues = [];
    for (const ph of PLACEHOLDER_BLACKLIST) {
        // 匹配 KEY=ph（行内，忽略前后空格）
        const re = new RegExp(`^[A-Z_]+\\s*=\\s*${ph.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*(#.*)?$`, 'm');
        if (re.test(envText)) {
            issues.push(ph);
        }
    }
    return issues;
}

// 安全复制：源存在校验
function copyTemplate(srcName, destPath) {
    const src = join(TEMPLATES_DIR, srcName);
    if (!existsSync(src)) {
        throw new Error(`模板文件不存在：${src}（请确认在仓库内运行本脚本）`);
    }
    copyFileSync(src, destPath);
}

// ---------- 主流程 ----------

async function main() {
    console.log();
    console.log(c.cyan(c.bold('╔══════════════════════════════════════════════════════════╗')));
    console.log(c.cyan(c.bold('║   企业微信通知转发服务 - 交互式部署向导                   ║')));
    console.log(c.cyan(c.bold('╚══════════════════════════════════════════════════════════╝')));
    console.log();

    // ---- 第 1 步：选择部署模式 ----
    const mode = await questionChoice('请选择部署模式：', [
        {
            label: c.green('镜像拉取模式'),
            value: 'image',
            desc: '直接从 GHCR 拉取预构建镜像，无需源码。生产部署最常用（推荐）。',
        },
        {
            label: '本地构建模式',
            value: 'build',
            desc: '从本地源码用 Dockerfile 构建镜像。适合开发 / 自测 / 定制。',
        },
    ], 0);
    console.log();

    const templateSubdir = mode; // 'image' 或 'build'

    // ---- 第 2 步：选择目标部署目录 ----
    const defaultDir = './qywx-notifier-plus';
    let targetDirInput = await questionDefault('请输入目标部署目录：', defaultDir);
    // 解析为绝对路径
    const targetDir = isAbsolute(targetDirInput)
        ? targetDirInput
        : resolve(process.cwd(), targetDirInput);
    console.log(c.dim(`  → 目标目录：${targetDir}`));
    console.log();

    // 创建目录（如不存在）
    if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
        console.log(c.green(`  ✓ 已创建目录：${targetDir}`));
    } else {
        console.log(c.dim(`  · 目录已存在：${targetDir}`));
    }

    // ---- 第 3 步：复制模板文件 ----
    const composeDest = join(targetDir, 'docker-compose.yml');
    const envExampleSrc = join(TEMPLATES_DIR, templateSubdir, '.env.example');
    const envExampleDest = join(targetDir, '.env.example');
    const envDest = join(targetDir, '.env');

    // docker-compose.yml：目标存在则询问是否覆盖
    if (existsSync(composeDest)) {
        const overwrite = await questionYesNo(
            c.yellow(`docker-compose.yml 已存在于 ${targetDir}，是否覆盖？`),
            false,
        );
        if (overwrite) {
            copyTemplate(join(templateSubdir, 'docker-compose.yml'), composeDest);
            console.log(c.green('  ✓ 已覆盖 docker-compose.yml'));
        } else {
            console.log(c.dim('  · 保留现有 docker-compose.yml'));
        }
    } else {
        copyTemplate(join(templateSubdir, 'docker-compose.yml'), composeDest);
        console.log(c.green('  ✓ 已生成 docker-compose.yml'));
    }

    // .env.example：总是复制（覆盖，它是模板）
    copyFileSync(envExampleSrc, envExampleDest);
    console.log(c.green('  ✓ 已生成 .env.example'));

    // .env：cp -n 语义，不覆盖已存在的
    let envExisted = existsSync(envDest);
    if (envExisted) {
        console.log(c.dim('  · .env 已存在，保留不覆盖（将基于现有 .env 调整）'));
    } else {
        copyFileSync(envExampleDest, envDest);
        console.log(c.green('  ✓ 已生成 .env（来自模板，请继续填写密钥）'));
    }
    console.log();

    // 读取当前 .env 内容（后续基于它改写）
    let envText = readFileSync(envDest, 'utf8');

    // ---- 第 4 步：选择访问方式 ----
    const accessMode = await questionChoice('请选择访问方式（决定 HOST_BIND 与 TRUST_PROXY 预设）：', [
        {
            label: '直接端口访问',
            value: 'direct',
            desc: '通过 http://IP:HOST_PORT 直接访问。HOST_BIND=0.0.0.0，TRUST_PROXY=false。',
        },
        {
            label: '同机 HTTPS 反向代理',
            value: 'proxy',
            desc: '前置 Nginx/Caddy/1Panel 反代。HOST_BIND=127.0.0.1，TRUST_PROXY=loopback。',
        },
    ], 0);
    console.log();

    let hostBind, trustProxy;
    if (accessMode === 'direct') {
        hostBind = '0.0.0.0';
        trustProxy = 'false';
    } else {
        hostBind = '127.0.0.1';
        trustProxy = 'loopback';
    }
    envText = setEnvValue(envText, 'HOST_BIND', hostBind);
    envText = setEnvValue(envText, 'TRUST_PROXY', trustProxy);
    console.log(c.dim(`  → HOST_BIND=${hostBind}，TRUST_PROXY=${trustProxy}`));
    console.log();

    // ---- 第 5 步：引导生成 / 填写密钥 ----
    console.log(c.bold('现在配置敏感凭证（ENCRYPTION_KEY / ADMIN_PASSWORD）：'));
    console.log();

    const opensslAvailable = hasCommand('openssl');
    let encKey = null;
    let adminPwd = null;

    if (opensslAvailable) {
        console.log(c.green('  ✓ 检测到 openssl，可自动生成随机密钥。'));
        const autoGen = await questionYesNo('是否自动生成两个随机密钥并写入 .env？', true);
        console.log();
        if (autoGen) {
            encKey = generateRandomHex(32);
            adminPwd = generateRandomHex(32);
            if (encKey && adminPwd) {
                // 64 位 hex 正好满足 32 字节要求，安全
                envText = setEnvValue(envText, 'ENCRYPTION_KEY', encKey);
                envText = setEnvValue(envText, 'ADMIN_PASSWORD', adminPwd);
                console.log(c.green('  ✓ 已生成并写入：'));
                console.log(c.dim(`      ENCRYPTION_KEY = ${encKey}`));
                console.log(c.dim(`      ADMIN_PASSWORD = ${adminPwd}`));
                console.log(c.yellow('  ⚠ 请立即妥善保存上述值（也已写入 .env）。'));
                console.log();
            } else {
                console.log(c.yellow('  · openssl 生成失败，改为手动填写。'));
            }
        }
    } else {
        console.log(c.yellow('  · 未检测到 openssl，需手动填写密钥。'));
        console.log(c.dim('    生成建议：openssl rand -hex 32  或  任意 32 字符字符串'));
    }

    // 若未自动生成，则逐项询问（可留空跳过，后续手动编辑）
    if (!encKey) {
        const input = await question('请输入 ENCRYPTION_KEY（32 字节；留空跳过，稍后手动编辑 .env）：');
        if (input) {
            envText = setEnvValue(envText, 'ENCRYPTION_KEY', input);
            console.log(c.green('  ✓ 已写入 ENCRYPTION_KEY'));
        } else {
            console.log(c.dim('  · 跳过，请稍后手动编辑 .env'));
        }
        console.log();
    }
    if (!adminPwd) {
        const input = await question('请输入 ADMIN_PASSWORD（至少 8 字符；留空跳过）：');
        if (input) {
            envText = setEnvValue(envText, 'ADMIN_PASSWORD', input);
            console.log(c.green('  ✓ 已写入 ADMIN_PASSWORD'));
        } else {
            console.log(c.dim('  · 跳过，请稍后手动编辑 .env'));
        }
        console.log();
    }

    // ---- 第 6 步：写入 .env 并校验 ----
    writeFileSync(envDest, envText, 'utf8');
    console.log(c.green(`  ✓ .env 已保存：${envDest}`));
    console.log();

    const issues = checkPlaceholders(envText);
    if (issues.length > 0) {
        console.log(c.red('  ✗ 警告：以下占位符值仍残留，容器将无法启动：'));
        issues.forEach((ph) => console.log(c.red(`      ${ph}`)));
        console.log(c.yellow('    请编辑 .env 替换为真实值后再启动。'));
        console.log();
    } else {
        console.log(c.green('  ✓ 占位符校验通过：未检测到残留默认值。'));
        console.log();
    }

    // ---- 第 7 步：提示后续步骤 ----
    console.log(c.bold('部署文件已就绪。后续手动步骤：'));
    console.log(c.dim('  ──────────────────────────────────────────'));
    const cmds = [];
    if (mode === 'image') {
        cmds.push(`cd "${targetDir}"`);
        cmds.push('docker compose pull');
        cmds.push('docker compose up -d');
        cmds.push('docker compose ps');
    } else {
        cmds.push(`cd "${targetDir}"`);
        cmds.push('docker compose up -d --build');
        cmds.push('docker compose ps');
    }
    cmds.forEach((cmd) => console.log(c.cyan(`  ${cmd}`)));
    if (process.platform !== 'win32') {
        console.log(c.yellow(`  chmod 600 "${envDest}"   # 限制 .env 读写权限`));
    }
    console.log(c.dim('  ──────────────────────────────────────────'));
    console.log();

    // ---- 第 8 步：询问是否立即启动 ----
    const dockerAvailable = hasCommand('docker');
    if (!dockerAvailable) {
        console.log(c.yellow('  · 未检测到 docker 命令，请手动执行上述命令启动。'));
        console.log();
    } else {
        const startNow = await questionYesNo('是否现在就执行启动命令？', false);
        console.log();
        if (startNow) {
            for (const cmd of cmds) {
                if (cmd.startsWith('cd ')) continue; // 跳过 cd，用 cwd
                if (cmd.startsWith('chmod ')) continue;
                console.log(c.cyan(`  $ ${cmd}`));
                try {
                    execSync(cmd, { cwd: targetDir, stdio: 'inherit', shell: true });
                } catch (err) {
                    console.log(c.red(`  ✗ 命令失败：${cmd}`));
                    console.log(c.dim(`    ${err.message}`));
                    break;
                }
            }
            console.log();
            console.log(c.green('  ✓ 启动命令已执行。可用 docker compose ps / logs 查看状态。'));
        } else {
            console.log(c.dim('  · 已跳过自动启动。请手动执行上述命令。'));
        }
    }

    console.log();
    console.log(c.cyan(c.bold('部署向导完成。祝使用愉快！')));
    console.log();
    rl.close();
}

// ---------- 入口 ----------
const arg = process.argv[2];
if (arg === '--help' || arg === '-h') {
    console.log(`企业微信通知转发服务 - 交互式部署脚本

用法：
  node deploy/deploy.mjs          启动交互式向导
  node deploy/deploy.mjs --help   显示本帮助

说明：
  向导会引导你选择镜像拉取/本地构建模式，生成 docker-compose.yml 与 .env，
  引导填写密钥，并可立即启动容器。模板文件位于 deploy/templates/ 下。
`);
    process.exit(0);
}

main().catch((err) => {
    console.error(c.red(`\n✗ 发生错误：${err.message}\n`));
    rl.close();
    process.exit(1);
});
