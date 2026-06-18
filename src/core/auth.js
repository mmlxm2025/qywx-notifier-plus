// 简单的认证模块
// 使用内存存储 token，支持管理员登录

const crypto = require('crypto');

class AuthService {
    constructor() {
        this.tokens = new Map();
        this.username = process.env.ADMIN_USERNAME || 'admin';
        this.password = process.env.ADMIN_PASSWORD || '';
    }

    generateToken() {
        return crypto.randomBytes(32).toString('hex');
    }

    login(username, password) {
        if (!this.password) {
            return { success: false, error: '管理员未配置密码，请设置 ADMIN_PASSWORD 环境变量' };
        }

        if (username === this.username && password === this.password) {
            const token = this.generateToken();
            const expires = Date.now() + 24 * 60 * 60 * 1000;
            this.tokens.set(token, { expires, username });
            return { success: true, token };
        }
        return { success: false, error: '用户名或密码错误' };
    }

    verifyToken(token) {
        if (!token) return false;
        
        const tokenData = this.tokens.get(token);
        if (!tokenData) return false;
        
        if (Date.now() > tokenData.expires) {
            this.tokens.delete(token);
            return false;
        }
        
        return true;
    }

    logout(token) {
        if (token) {
            this.tokens.delete(token);
        }
        return true;
    }

    isConfigured() {
        return !!this.password;
    }
}

module.exports = new AuthService();
