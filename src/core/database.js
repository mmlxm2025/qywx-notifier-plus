// 数据库初始化与操作模块
// 管理SQLite数据库连接和表结构

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class Database {
    constructor(dbPath) {
        this.dbPath = dbPath;
        this.db = null;
    }

    // 初始化数据库连接和表结构
    async init() {
        return new Promise((resolve, reject) => {
            // 确保数据库目录存在
            const dbDir = path.dirname(this.dbPath);
            const fs = require('fs');
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }

            // 创建数据库连接
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    console.error('数据库连接失败:', err.message);
                    reject(err);
                    return;
                }
                console.log('SQLite数据库连接成功');

                // 创建configurations表
                this.createTables()
                    .then(() => resolve())
                    .catch(reject);
            });
        });
    }

    // 创建数据表
    async createTables() {
        return new Promise((resolve, reject) => {
            let settled = false;
            const fail = (label, err) => {
                if (settled) return;
                settled = true;
                console.error(`${label}:`, err.message);
                reject(err);
            };
            const done = () => {
                if (settled) return;
                settled = true;
                console.log('数据表创建成功');
                resolve();
            };
            const createConfigurationsSQL = `
                CREATE TABLE IF NOT EXISTS configurations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    code TEXT UNIQUE NOT NULL,
                    corpid TEXT NOT NULL,
                    encrypted_corpsecret TEXT NOT NULL,
                    agentid INTEGER NOT NULL,
                    touser TEXT NOT NULL,
                    description TEXT,
                    callback_token TEXT,
                    encrypted_encoding_aes_key TEXT,
                    callback_enabled BOOLEAN DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(corpid, agentid, touser)
                )
            `;
            const createRulesSQL = `
                CREATE TABLE IF NOT EXISTS notification_rules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    config_code TEXT NOT NULL,
                    api_code TEXT UNIQUE NOT NULL,
                    name TEXT NOT NULL,
                    touser TEXT DEFAULT '',
                    toparty TEXT DEFAULT '',
                    totag TEXT DEFAULT '',
                    is_all INTEGER DEFAULT 0,
                    estimated_count INTEGER DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `;
            const createConfigIndexSQL = `
                CREATE INDEX IF NOT EXISTS idx_notification_rules_config_code
                ON notification_rules(config_code)
            `;
            const createApiCodeIndexSQL = `
                CREATE INDEX IF NOT EXISTS idx_notification_rules_api_code
                ON notification_rules(api_code)
            `;

            this.db.serialize(() => {
                this.db.run(createConfigurationsSQL, (err) => {
                    if (err) {
                        fail('创建configurations表失败', err);
                    }
                });
                this.db.run(createRulesSQL, (err) => {
                    if (err) {
                        fail('创建notification_rules表失败', err);
                    }
                });
                this.db.run(createConfigIndexSQL, (err) => {
                    if (err) {
                        fail('创建规则配置索引失败', err);
                    }
                });
                this.db.run(createApiCodeIndexSQL, (err) => {
                    if (err) {
                        fail('创建规则API索引失败', err);
                        return;
                    }
                    done();
                });
            });
        });
    }

    // 保存配置
    async saveConfiguration(config) {
        return new Promise((resolve, reject) => {
            const { 
                code, corpid, encrypted_corpsecret, agentid, touser, description,
                callback_token, encrypted_encoding_aes_key, callback_enabled 
            } = config;
            const sql = `
                INSERT INTO configurations (
                    code, corpid, encrypted_corpsecret, agentid, touser, description,
                    callback_token, encrypted_encoding_aes_key, callback_enabled
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            this.db.run(sql, [
                code, corpid, encrypted_corpsecret, agentid, touser, description,
                callback_token, encrypted_encoding_aes_key, callback_enabled || 0
            ], function(err) {
                if (err) {
                    console.error('保存配置失败:', err.message);
                    reject(err);
                    return;
                }
                console.log('配置保存成功, ID:', this.lastID);
                resolve({ id: this.lastID, code });
            });
        });
    }

    // 根据code获取配置
    async getConfigurationByCode(code) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM configurations WHERE code = ?`;

            this.db.get(sql, [code], (err, row) => {
                if (err) {
                    console.error('查询配置失败:', err.message);
                    reject(err);
                    return;
                }
                resolve(row);
            });
        });
    }

    async listConfigurations() {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT code, agentid, touser, description, created_at
                FROM configurations
                ORDER BY id DESC
            `;
            this.db.all(sql, [], (err, rows) => {
                if (err) {
                    console.error('查询配置列表失败:', err.message);
                    reject(err);
                    return;
                }
                resolve(rows || []);
            });
        });
    }

    // 更新配置
    async updateConfiguration(config) {
        return new Promise((resolve, reject) => {
            const { 
                code, corpid, encrypted_corpsecret, agentid, touser, description,
                callback_token, encrypted_encoding_aes_key, callback_enabled 
            } = config;
            const sql = `
                UPDATE configurations 
                SET corpid = ?, encrypted_corpsecret = ?, agentid = ?, touser = ?, description = ?,
                    callback_token = ?, encrypted_encoding_aes_key = ?, callback_enabled = ?
                WHERE code = ?
            `;
            this.db.run(sql, [
                corpid, encrypted_corpsecret, agentid, touser, description,
                callback_token, encrypted_encoding_aes_key, callback_enabled,
                code
            ], function(err) {
                if (err) {
                    console.error('更新配置失败:', err.message);
                    reject(err);
                    return;
                }
                console.log('配置更新成功, code:', code);
                resolve({ code });
            });
        });
    }

    // 根据字段查询配置
    async getConfigurationByFields(corpid, agentid, touser) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM configurations WHERE corpid = ? AND agentid = ? AND touser = ?`;
            this.db.get(sql, [corpid, agentid, touser], (err, row) => {
                if (err) {
                    console.error('查询配置失败:', err.message);
                    reject(err);
                    return;
                }
                resolve(row);
            });
        });
    }

    // 根据完整字段查询配置（包括回调配置）
    async getConfigurationByCompleteFields(corpid, agentid, touser, callback_enabled, callback_token) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM configurations WHERE corpid = ? AND agentid = ? AND touser = ? AND callback_enabled = ? AND (callback_token = ? OR (callback_token IS NULL AND ? IS NULL))`;
            this.db.get(sql, [corpid, agentid, touser, callback_enabled, callback_token, callback_token], (err, row) => {
                if (err) {
                    console.error('查询完整配置失败:', err.message);
                    reject(err);
                    return;
                }
                resolve(row);
            });
        });
    }

    // 保存回调配置（第一步）
    async saveCallbackConfiguration(config) {
        return new Promise((resolve, reject) => {
            const { code, corpid, callback_token, encrypted_encoding_aes_key } = config;
            const sql = `
                INSERT INTO configurations (
                    code, corpid, callback_token, encrypted_encoding_aes_key, callback_enabled,
                    encrypted_corpsecret, agentid, touser, description
                )
                VALUES (?, ?, ?, ?, 1, '', 0, '', '')
            `;

            this.db.run(sql, [code, corpid, callback_token, encrypted_encoding_aes_key], function(err) {
                if (err) {
                    console.error('保存回调配置失败:', err.message);
                    reject(err);
                    return;
                }
                console.log('回调配置保存成功, ID:', this.lastID);
                resolve({ id: this.lastID, code });
            });
        });
    }

    // 查询回调配置
    async getCallbackConfiguration(corpid, callback_token) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM configurations WHERE corpid = ? AND callback_token = ? AND callback_enabled = 1`;
            this.db.get(sql, [corpid, callback_token], (err, row) => {
                if (err) {
                    console.error('查询回调配置失败:', err.message);
                    reject(err);
                    return;
                }
                resolve(row);
            });
        });
    }

    // 完善配置（第二步）
    async completeConfiguration(config) {
        return new Promise((resolve, reject) => {
            const { code, encrypted_corpsecret, agentid, touser, description } = config;
            const sql = `
                UPDATE configurations
                SET encrypted_corpsecret = ?, agentid = ?, touser = ?, description = ?
                WHERE code = ?
            `;
            this.db.run(sql, [encrypted_corpsecret, agentid, touser, description, code], function(err) {
                if (err) {
                    console.error('完善配置失败:', err.message);
                    reject(err);
                    return;
                }
                console.log('配置完善成功, code:', code);
                resolve({ code });
            });
        });
    }

    async listNotificationRules(configCode) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM notification_rules WHERE config_code = ? ORDER BY id DESC`;
            this.db.all(sql, [configCode], (err, rows) => {
                if (err) {
                    console.error('查询通知规则失败:', err.message);
                    reject(err);
                    return;
                }
                resolve(rows || []);
            });
        });
    }

    async getNotificationRuleByApiCode(apiCode) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM notification_rules WHERE api_code = ?`;
            this.db.get(sql, [apiCode], (err, row) => {
                if (err) {
                    console.error('按API code查询通知规则失败:', err.message);
                    reject(err);
                    return;
                }
                resolve(row);
            });
        });
    }

    async getNotificationRuleById(id) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM notification_rules WHERE id = ?`;
            this.db.get(sql, [id], (err, row) => {
                if (err) {
                    console.error('按ID查询通知规则失败:', err.message);
                    reject(err);
                    return;
                }
                resolve(row);
            });
        });
    }

    async saveNotificationRule(rule) {
        return new Promise((resolve, reject) => {
            const {
                config_code, api_code, name, touser, toparty, totag,
                is_all, estimated_count
            } = rule;
            const sql = `
                INSERT INTO notification_rules (
                    config_code, api_code, name, touser, toparty, totag,
                    is_all, estimated_count
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `;

            this.db.run(sql, [
                config_code, api_code, name, touser, toparty, totag,
                is_all || 0, estimated_count || 1
            ], function(err) {
                if (err) {
                    console.error('保存通知规则失败:', err.message);
                    reject(err);
                    return;
                }
                resolve({ id: this.lastID, api_code });
            });
        });
    }

    async updateNotificationRule(rule) {
        return new Promise((resolve, reject) => {
            const {
                id, name, touser, toparty, totag, is_all, estimated_count
            } = rule;
            const sql = `
                UPDATE notification_rules
                SET name = ?, touser = ?, toparty = ?, totag = ?,
                    is_all = ?, estimated_count = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `;

            this.db.run(sql, [
                name, touser, toparty, totag,
                is_all || 0, estimated_count || 1, id
            ], function(err) {
                if (err) {
                    console.error('更新通知规则失败:', err.message);
                    reject(err);
                    return;
                }
                resolve({ id });
            });
        });
    }

    async regenerateNotificationRuleApiCode(id, apiCode) {
        return new Promise((resolve, reject) => {
            const sql = `
                UPDATE notification_rules
                SET api_code = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `;

            this.db.run(sql, [apiCode, id], function(err) {
                if (err) {
                    console.error('重新生成通知规则API失败:', err.message);
                    reject(err);
                    return;
                }
                resolve({ id, api_code: apiCode });
            });
        });
    }

    async deleteNotificationRule(id) {
        return new Promise((resolve, reject) => {
            const sql = `DELETE FROM notification_rules WHERE id = ?`;
            this.db.run(sql, [id], function(err) {
                if (err) {
                    console.error('删除通知规则失败:', err.message);
                    reject(err);
                    return;
                }
                resolve({ id });
            });
        });
    }

    // 关闭数据库连接
    close() {
        if (this.db) {
            this.db.close((err) => {
                if (err) {
                    console.error('关闭数据库失败:', err.message);
                } else {
                    console.log('数据库连接已关闭');
                }
            });
        }
    }
}

module.exports = Database; 
