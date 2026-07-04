// SEC-003：通知发送凭证与回调标识分离
//
// 设计：
// - 每个配置额外生成 notify_key（仅用于发送通知），与回调 callback_id（code）分离。
// - notify_key 作为 API Key，DB 中只存哈希；轮换后旧 key 立即失效。
// - 高安全场景支持 HMAC 签名：X-Notify-Timestamp + X-Notify-Nonce + X-Notify-Signature，
//   签名内容为 method\npath\ntimestamp\nnonce\nsha256(body)。校验时间窗口与 nonce 重放。

const crypto = require('crypto');

const SIGNATURE_HEADER = 'x-notify-signature';
const TIMESTAMP_HEADER = 'x-notify-timestamp';
const NONCE_HEADER = 'x-notify-nonce';
const KEY_HEADER = 'x-notify-key';

const TIMESTAMP_TOLERANCE_SEC = Number(process.env.NOTIFY_TIMESTAMP_TOLERANCE_SEC || 300);
const NONCE_TTL_MS = Number(process.env.NOTIFY_NONCE_TTL_MS || 600000);

const seenNonces = new Map();

function generateNotifyKey() {
    return crypto.randomBytes(32).toString('hex');
}

function hashNotifyKey(key) {
    return crypto.createHash('sha256').update(String(key || '')).digest('hex');
}

function timingSafeEqualHex(a, b) {
    const ba = Buffer.from(String(a), 'hex');
    const bb = Buffer.from(String(b), 'hex');
    if (ba.length !== bb.length || ba.length === 0) return false;
    return crypto.timingSafeEqual(ba, bb);
}

function canonicalSignatureMessage({ method, path, timestamp, nonce, bodyHash }) {
    return [method, path, timestamp, nonce, bodyHash].join('\n');
}

function computeSignature(secret, message) {
    return crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(message).digest('hex');
}

// 多应用（二次复验 P2-04 + 第三轮 P2-1）：HMAC nonce 按密钥分区 + 真正硬容量上限。
// 旧实现按裸 nonce 全局判重，不同应用相同 nonce 会互相拒绝；且超过 10000 时只删过期项，
// 全部未过期时仍无限增长。改为：
//   1. hash(notifyKey):nonce 复合键，隔离不同应用/密钥的 nonce 空间。
//   2. 硬容量上限：超过 NONCE_HARD_LIMIT 时，先删过期项；仍超限则按插入顺序淘汰最旧（LRU），
//      保证最终大小有界，不依赖全部过期。
const NONCE_HARD_LIMIT = Number(process.env.NOTIFY_NONCE_HARD_LIMIT || 10000);
function recordNonce(nonce, notifyKey) {
    if (!nonce) return;
    // 复合键：按 notifyKey 哈希分区，避免不同应用相同 nonce 互相拒绝。
    const keyPart = notifyKey ? hashNotifyKey(notifyKey) : 'global';
    const compositeKey = `${keyPart}:${nonce}`;
    const exists = seenNonces.get(compositeKey);
    if (exists && exists > Date.now()) {
        return false; // 重放
    }
    seenNonces.set(compositeKey, Date.now() + NONCE_TTL_MS);
    // 硬容量：超过上限时先删过期项。
    if (seenNonces.size > NONCE_HARD_LIMIT) {
        const cutoff = Date.now();
        for (const [k, exp] of seenNonces) {
            if (exp <= cutoff) seenNonces.delete(k);
        }
        // 仍超限：按插入顺序淘汰最旧（Map 保持插入顺序，即 LRU 语义）。
        while (seenNonces.size > NONCE_HARD_LIMIT) {
            const firstKey = seenNonces.keys().next().value;
            seenNonces.delete(firstKey);
        }
    }
    return true;
}

// 校验 HMAC 签名（若调用方提供了签名头，则必须正确；否则退化为 API Key 校验）。
//
// REV-005 整改要点：
// - 必须先校验时间戳与签名正确性，确认无误后再登记 nonce；
//   错误签名/过期时间戳不得占用 nonce，否则攻击者可用伪造签名耗尽 nonce 空间。
// - rawBody 必须是客户端签名的原始字节（由 express.json verify 钩子捕获），而非重建的 JSON。
function verifySignedRequest({ headers, method, path, rawBody, notifyKey }) {
    const signature = headers[SIGNATURE_HEADER];
    const timestamp = headers[TIMESTAMP_HEADER];
    const nonce = headers[NONCE_HEADER];

    if (signature || timestamp || nonce) {
        if (!signature || !timestamp || !nonce) {
            return { ok: false, statusCode: 401, error: '缺少完整的签名头（timestamp/nonce/signature）' };
        }
        const now = Math.floor(Date.now() / 1000);
        const ts = Number(timestamp);
        if (!Number.isFinite(ts) || Math.abs(now - ts) > TIMESTAMP_TOLERANCE_SEC) {
            return { ok: false, statusCode: 401, error: '时间戳超出允许范围' };
        }
        // REV-005：先验签，再登记 nonce。
        const bodyHash = crypto.createHash('sha256').update(rawBody || '').digest('hex');
        const message = canonicalSignatureMessage({ method, path, timestamp, nonce, bodyHash });
        const expected = computeSignature(notifyKey, message);
        if (!timingSafeEqualHex(expected, signature)) {
            return { ok: false, statusCode: 401, error: '签名校验失败' };
        }
        // 签名正确后才登记 nonce，防止伪造签名污染缓存。
        // 多应用（二次复验 P2-04）：按 notifyKey 分区登记，隔离不同应用。
        if (!recordNonce(nonce, notifyKey)) {
            return { ok: false, statusCode: 401, error: '检测到请求重放' };
        }
        return { ok: true, mode: 'hmac' };
    }
    return { ok: true, mode: 'apikey' };
}

module.exports = {
    generateNotifyKey,
    hashNotifyKey,
    computeSignature,
    verifySignedRequest,
    canonicalSignatureMessage,
    KEY_HEADER,
    SIGNATURE_HEADER,
    TIMESTAMP_HEADER,
    NONCE_HEADER
};
