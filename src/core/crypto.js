// 加密/解密模块
//
// 安全整改（SEC-005）：
// - 新数据使用 AES-256-GCM 带认证标签，格式 v2:<nonceHex>:<tagHex>:<ciphertextHex>。
// - 保留对旧 CBC 密文（格式 <ivHex>:<ciphertextHex>，无版本前缀）的读取能力，
//   解密成功后由调用方决定是否重新加密为 GCM，实现平滑迁移。
// - 密钥必须为 32 字节；缺失时构造抛错，禁止再退化为补零弱密钥（SEC-001）。

const crypto = require('crypto');

const KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const VERSION = 'v2';

class CryptoService {
    constructor(encryptionKey) {
        let key;
        // 同时兼容 Buffer（来自 config 解码）与字符串/未配置输入。
        if (Buffer.isBuffer(encryptionKey)) {
            key = encryptionKey;
        } else if (typeof encryptionKey === 'string') {
            // 兼容旧调用：直接按 utf8 取字节，必须正好 32 字节。
            key = Buffer.from(encryptionKey, 'utf8');
        }
        if (!key || key.length !== KEY_BYTES) {
            throw new Error('加密密钥无效：必须是 32 字节。请通过环境变量 ENCRYPTION_KEY 提供合法密钥。');
        }
        this.key = key;
        this.algorithm = 'aes-256-gcm';
        this.legacyAlgorithm = 'aes-256-cbc';
        this.nonceLength = GCM_NONCE_BYTES;
    }

    // 加密：返回 v2:<nonce>:<tag>:<ciphertext>
    encrypt(text) {
        if (typeof text !== 'string') {
            throw new Error('加密失败：明文必须是字符串');
        }
        try {
            const nonce = crypto.randomBytes(this.nonceLength);
            const cipher = crypto.createCipheriv(this.algorithm, this.key, nonce);
            const ciphertext = Buffer.concat([
                cipher.update(text, 'utf8'),
                cipher.final()
            ]);
            const tag = cipher.getAuthTag();
            return [VERSION, nonce.toString('hex'), tag.toString('hex'), ciphertext.toString('hex')].join(':');
        } catch (error) {
            // 不泄露密钥相关细节
            throw new Error('数据加密失败');
        }
    }

    // 解密：自动识别 v2 (GCM) 与遗留 CBC（无版本前缀）。
    decrypt(encryptedText) {
        if (typeof encryptedText !== 'string' || encryptedText.length === 0) {
            throw new Error('数据解密失败');
        }

        // GCM 分支
        if (encryptedText.startsWith(VERSION + ':')) {
            const parts = encryptedText.split(':');
            // v2 : nonce : tag : ciphertext
            if (parts.length !== 4) {
                throw new Error('数据解密失败');
            }
            const [, nonceHex, tagHex, ciphertextHex] = parts;
            try {
                const nonce = Buffer.from(nonceHex, 'hex');
                const tag = Buffer.from(tagHex, 'hex');
                const ciphertext = Buffer.from(ciphertextHex, 'hex');
                if (nonce.length !== this.nonceLength || tag.length !== 16 || ciphertext.length === 0) {
                    throw new Error('数据解密失败');
                }
                const decipher = crypto.createDecipheriv(this.algorithm, this.key, nonce);
                decipher.setAuthTag(tag);
                const plain = Buffer.concat([
                    decipher.update(ciphertext),
                    decipher.final()
                ]);
                return plain.toString('utf8');
            } catch (error) {
                // 任意篡改（nonce/tag/ciphertext）都会在此失败，统一对外语义。
                throw new Error('数据解密失败');
            }
        }

        // 遗留 CBC 分支：<ivHex>:<ciphertextHex>
        const legacyParts = encryptedText.split(':');
        if (legacyParts.length === 2) {
            return this.decryptLegacyCBC(legacyParts[0], legacyParts[1]);
        }

        throw new Error('数据解密失败');
    }

    decryptLegacyCBC(ivHex, ciphertextHex) {
        try {
            const iv = Buffer.from(ivHex, 'hex');
            const ciphertext = Buffer.from(ciphertextHex, 'hex');
            if (iv.length !== 16 || ciphertext.length === 0) {
                throw new Error('数据解密失败');
            }
            const decipher = crypto.createDecipheriv(this.legacyAlgorithm, this.key, iv);
            const plain = Buffer.concat([
                decipher.update(ciphertext),
                decipher.final()
            ]);
            return plain.toString('utf8');
        } catch (error) {
            throw new Error('数据解密失败');
        }
    }

    // 判断是否为旧 CBC 密文（用于迁移期识别并重新加密）。
    isLegacyCiphertext(encryptedText) {
        if (typeof encryptedText !== 'string' || encryptedText.length === 0) return false;
        if (encryptedText.startsWith(VERSION + ':')) return false;
        return encryptedText.split(':').length === 2;
    }

    // 若为旧格式，解密后重新加密为 GCM；否则原样返回。
    reencryptIfLegacy(encryptedText) {
        if (!this.isLegacyCiphertext(encryptedText)) return encryptedText;
        const plain = this.decrypt(encryptedText);
        return this.encrypt(plain);
    }

    // 生成随机密钥（hex，32 字节 -> 64 位 hex 字符串）。
    static generateKey() {
        return crypto.randomBytes(KEY_BYTES).toString('hex');
    }
}

module.exports = CryptoService;
