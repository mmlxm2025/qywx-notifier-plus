// 共享的 CryptoService 单例（懒加载）
//
// 之所以每次按需构建（而非永久缓存实例）：
// - 业务模块在 require 阶段不应抛错，以便测试可以替换原型方法后再使用。
// - 真正的密钥校验发生在 server.js 启动期 (config.validateRuntime)。
// - 测试常通过 process.env.ENCRYPTION_KEY 注入密钥后再 clearModule/require，
//   每次重新读取环境变量可确保密钥变更后立即生效。
//
// 旧测试代码会 monkey-patch CryptoService.prototype.encrypt/decrypt，
// 这些补丁对所有实例生效，因此本文件每次 new 出的实例仍会使用被替换的方法。

const CryptoService = require('./crypto');
const config = require('./config');

function getCrypto() {
    const key = config.getEncryptionKey();
    if (!key) {
        // 缺少有效密钥时给出明确错误；调用方负责在测试环境注入密钥。
        throw new Error('加密服务不可用：未配置合法的 ENCRYPTION_KEY。');
    }
    return new CryptoService(key);
}

module.exports = { getCrypto, CryptoService };
