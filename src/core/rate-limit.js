// SEC-006：轻量级内存限流器
//
// 设计：
// - 按 key（如 用户名+IP、API Key+IP、配置 code+IP）维护滑动窗口计数。
// - 超限返回 429 并附带 Retry-After 秒数。
// - 进程内 Map 存储；多实例部署需替换为 Redis 等共享存储（见 SEC-006 整改要求 5）。
// - 周期清理过期桶，避免无界增长。

class RateLimiter {
    constructor({ windowMs, max, message, maxKeys = 10000 }) {
        this.windowMs = windowMs;
        this.max = max;
        this.maxKeys = maxKeys;
        this.message = message || '请求过于频繁，请稍后再试';
        this.buckets = new Map();
    }

    hit(key) {
        const now = Date.now();
        const cutoff = now - this.windowMs;
        let entries = this.buckets.get(key);
        if (!entries) {
            entries = [];
            this.buckets.set(key, entries);
        }
        // 清理过期
        while (entries.length > 0 && entries[0] <= cutoff) {
            entries.shift();
        }
        entries.push(now);
        // REV-004：硬上限保护，超限时淘汰最旧 key（LRU 近似）。
        if (this.buckets.size > this.maxKeys) {
            this.cleanup();
            if (this.buckets.size > this.maxKeys) {
                const firstKey = this.buckets.keys().next().value;
                this.buckets.delete(firstKey);
            }
        }
        return entries.length;
    }

    check(key) {
        const count = this.hit(key);
        if (count > this.max) {
            const oldest = this.buckets.get(key)[0];
            const retryAfterMs = oldest + this.windowMs - Date.now();
            const error = new Error(this.message);
            error.statusCode = 429;
            error.retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
            throw error;
        }
    }

    // 周期清理（由调用方 setInterval 触发）。
    cleanup() {
        const cutoff = Date.now() - this.windowMs;
        for (const [key, entries] of this.buckets) {
            while (entries.length > 0 && entries[0] <= cutoff) {
                entries.shift();
            }
            if (entries.length === 0) {
                this.buckets.delete(key);
            }
        }
    }
}

// 递增退避的登录限流器：失败次数越多，等待越久。
class LoginRateLimiter {
    constructor({ baseWindowMs, maxAttempts, message, maxKeys = 10000 }) {
        this.windowMs = baseWindowMs;
        this.maxAttempts = maxAttempts;
        this.maxKeys = maxKeys;
        this.message = message || '登录尝试过于频繁，请稍后再试';
        this.failures = new Map(); // key -> [time]
    }

    recordFailure(key) {
        const now = Date.now();
        let entries = this.failures.get(key);
        if (!entries) {
            entries = [];
            this.failures.set(key, entries);
        }
        entries.push(now);
        return entries.length;
    }

    check(key) {
        const now = Date.now();
        const cutoff = now - this.windowMs;
        let entries = this.failures.get(key);
        if (entries) {
            entries = entries.filter(t => t > cutoff);
            if (entries.length === 0) this.failures.delete(key);
        }
        const count = entries ? entries.length : 0;
        if (count >= this.maxAttempts) {
            const oldest = entries[0];
            const retryAfterMs = oldest + this.windowMs - now;
            const error = new Error(this.message);
            error.statusCode = 429;
            error.retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
            throw error;
        }
    }

    reset(key) {
        this.failures.delete(key);
    }

    cleanup() {
        const cutoff = Date.now() - this.windowMs;
        for (const [key, entries] of this.failures) {
            const kept = entries.filter(t => t > cutoff);
            if (kept.length === 0) {
                this.failures.delete(key);
            } else {
                this.failures.set(key, kept);
            }
        }
    }
}

module.exports = { RateLimiter, LoginRateLimiter };
