// SEC-011：安全响应头中间件
//
// 不依赖 helmet（避免引入额外依赖），手工设置关键安全头。
// CSP 允许同源 + 必要的 CDN（已固定版本）；report-only 不阻断，便于观察。

function buildCsp({ allowInlineScriptNonce } = {}) {
    // tailwind cdn JIT 需要内联 style；lucide/gsap 已固定版本。
    // 不允许任意 remote script，CDN 域名收敛。
    return [
        "default-src 'self'",
        "script-src 'self' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://unpkg.com",
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "img-src 'self' data: https:",
        "font-src 'self' data:",
        // connect-src 含 https://unpkg.com：lucide 加载时会请求其 source map(.js.map)，
        // 缺失会触发 CSP 违规报错（非阻断但污染控制台）。
        "connect-src 'self' https://unpkg.com",
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
