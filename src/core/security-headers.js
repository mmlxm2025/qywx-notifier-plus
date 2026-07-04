// SEC-011：安全响应头中间件
//
// 不依赖 helmet（避免引入额外依赖），手工设置关键安全头。
// 前端静态资产全部随镜像自托管，CSP 不再放行第三方脚本或内联样式。

function buildCsp() {
    return [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'"
    ].join('; ');
}

function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Content-Security-Policy', buildCsp());
    // HSTS 仅在 HTTPS 下生效（浏览器对 http 响应忽略）
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-XSS-Protection', '0'); // 现代浏览器依赖 CSP；关闭可能引入缺陷的旧 X-XSS-Protection
    next();
}

module.exports = { securityHeaders, buildCsp };
