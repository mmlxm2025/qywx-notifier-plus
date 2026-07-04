// UTF-8 自动兼容的 JSON body 解析中间件。
//
// 解决问题：Windows CMD/PowerShell 的 curl 默认按 GBK/GB2312 编码中文，发出的非 UTF-8
// 字节会被 express.json 强解成乱码（U+FFFD）后静默发给企业微信，导致消息乱码。
//
// 设计：
// - express.json 的 verify 钩子拿到原始 buffer，检测是否为合法 UTF-8。
// - 合法 UTF-8：round-trip 一致，直接用，零开销。
// - 非 UTF-8：用 GB18030（GBK 超集，Node 13+ 内置完整 ICU，零依赖）解码为字符串，
//   校验为合法 JSON 后存入 req._rawBody 并置 req._bodyTranscoded 标志。
// - 第二个中间件对标记请求用转码后的字符串重解析 req.body（express.json 内部仍用原始
//   buffer 解析，必须在此覆盖）。
// - req._rawBody 同时供 HMAC 签名校验使用（签名基于客户端实际发送的字节，转码场景下
//   HMAC 会因字节不一致而 401，这是安全失败，不会发乱码，可接受）。
//
// 失败回退：转码或 JSON.parse 失败时退回原始 UTF-8 解析，交由 express.json 按原逻辑处理/报错。

const express = require('express');

function isPureUtf8(buffer) {
    if (buffer.length === 0) return true;
    return buffer.equals(Buffer.from(buffer.toString('utf8'), 'utf8'));
}

function tryTranscodeFromGB18030(buffer) {
    try {
        const { TextDecoder } = require('util');
        const decoded = new TextDecoder('gb18030').decode(buffer);
        JSON.parse(decoded); // 必须是合法 JSON，否则视为误判
        return decoded;
    } catch (_e) {
        return null;
    }
}

// 返回一个数组，可直接 app.use(...jsonBodyParser())，保证 verify 与补正中间件成对挂载。
function jsonBodyParser(options = {}) {
    const limit = options.limit || '256kb';
    return [
        express.json({
            limit,
            verify: (req, _res, buffer) => {
                if (isPureUtf8(buffer)) {
                    req._rawBody = buffer.toString('utf8');
                    return;
                }
                const transcoded = tryTranscodeFromGB18030(buffer);
                if (transcoded !== null) {
                    req._rawBody = transcoded;
                    req._bodyTranscoded = true;
                    if (process.env.NODE_ENV !== 'test') {
                        console.log('[编码兼容] 检测到非 UTF-8 请求体，已自动从 GB18030 转码为 UTF-8');
                    }
                    return;
                }
                req._rawBody = buffer.toString('utf8');
            }
        }),
        (req, _res, next) => {
            if (req._bodyTranscoded && typeof req._rawBody === 'string') {
                try { req.body = JSON.parse(req._rawBody); } catch (_e) { /* 保持原 body */ }
            }
            next();
        }
    ];
}

// 多应用（二次复验 P1-01/P1-06）：JSON body parser 错误处理中间件。
//
// express.json 在以下情况抛错（Express 5 通过 reject 传递）：
//   - 畸形 JSON（SyntaxError，err.status=400）
//   - 超过 limit（PayloadTooLargeError，err.status=413）
// 默认 Express 会渲染 HTML 错误页或暴露堆栈，与 API 的 JSON 契约不一致。
// 本中间件捕获这些错误，返回稳定 JSON：
//   - 畸形/无法解析 → 400 INVALID_INPUT
//   - 超限 → 413 PAYLOAD_TOO_LARGE
// 不返回 TypeError/堆栈/SQL/路径。
//
// 应紧贴 jsonBodyParser 之后挂载（在其他路由之前），以拦截 parser 抛出的错误。
function bodyParserErrorHandler(err, _req, res, next) {
    if (!err) return next();
    const status = err.status || err.statusCode || 500;
    const type = err.type || (err.constructor && err.constructor.name) || '';
    // express.json 的解析错误标记为 'entity.parse.failed' 或 SyntaxError + status 400。
    if (status === 400 || type === 'entity.parse.failed' || err instanceof SyntaxError) {
        return res.status(400).json({ error: '请求体不是合法的 JSON', code: 'INVALID_INPUT' });
    }
    // 超限：'entity.too.large'。
    if (status === 413 || type === 'entity.too.large') {
        return res.status(413).json({ error: '请求体超过大小限制', code: 'PAYLOAD_TOO_LARGE' });
    }
    // 其他错误交由后续错误中间件处理（如全局 5xx 兜底）。
    return next(err);
}

module.exports = { jsonBodyParser, bodyParserErrorHandler, isPureUtf8, tryTranscodeFromGB18030 };
