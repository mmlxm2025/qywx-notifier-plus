// 数据库初始化与操作模块
// 管理SQLite数据库连接和表结构

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// 多应用：updateConfigurationFields 允许局部更新的列白名单。
// 禁止通过 touched-field 接口修改 code（主键标识）和 version（仅由系统递增）。
// 多应用（二次复验 P2-03）：legacy-grace 能力已删除，legacy_until 不再允许运行时写入。
// 数据库列保留（回滚需要），但禁止通过白名单接口改写。
const UPDATE_FIELD_WHITELIST = new Set([
    'corpid', 'encrypted_corpsecret', 'agentid', 'touser', 'description',
    'callback_token', 'encrypted_callback_token', 'encrypted_encoding_aes_key',
    'callback_enabled', 'notify_key_hash',
    'code_send_enabled', 'app_enabled'
]);

class Database {
    constructor(dbPath) {
        this.dbPath = dbPath;
        this.db = null;
        // 多应用（§6.2 事务）：共享 sqlite 连接的全局操作队列。
        // 所有公共读写与事务都经过同一条 Promise 队列，保证事务期间其他请求的
        // 语句不会混入同一连接（避免“事务外写入被错误回滚”的数据一致性问题）。
        // exclusive=true 的事务占位会阻塞其后所有排队的读写，直到事务释放。
        this._opChain = Promise.resolve();
        this._inTransaction = false;
    }

    // 多应用（P0-01 修复）：把一个操作排到全局队列。
    // exclusive=true 表示独占（事务）：占位后，后续 enqueueOperation 必须等本任务 resolve。
    // exclusive=false（普通读写）：等待前一个独占事务释放后再执行。
    // 返回 Promise，resolve 时机由调用方提供的 task() 控制。
    enqueueOperation(task, { exclusive = false } = {}) {
        let release;
        const turn = new Promise(resolve => { release = resolve; });
        const previous = this._opChain;
        if (exclusive) {
            // 独占事务：占位本身要等前一个任务完成；其后任务须等 release。
            this._opChain = previous.then(() => turn);
        } else {
            // 普通操作：链尾追加（自然排在任何独占事务之后）。
            this._opChain = previous.then(() => turn);
        }
        const run = (async () => {
            await previous;
            try {
                return await task();
            } finally {
                release();
            }
        })();
        return run;
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

                this.createTables()
                    .then(() => resolve())
                    .catch(reject);
            });
        });
    }

    // 创建数据表
    async createTables() {
        await this.runRaw(`
            CREATE TABLE IF NOT EXISTS configurations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT UNIQUE NOT NULL,
                corpid TEXT NOT NULL,
                encrypted_corpsecret TEXT NOT NULL,
                agentid INTEGER NOT NULL,
                touser TEXT NOT NULL,
                description TEXT,
                callback_token TEXT,
                encrypted_callback_token TEXT,
                encrypted_encoding_aes_key TEXT,
                callback_enabled BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(corpid, agentid, touser)
            )
        `, []);

        await this.runRaw(`
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
        `, []);

        await this.runRaw(`
            CREATE INDEX IF NOT EXISTS idx_notification_rules_config_code
            ON notification_rules(config_code)
        `, []);
        await this.runRaw(`
            CREATE INDEX IF NOT EXISTS idx_notification_rules_api_code
            ON notification_rules(api_code)
        `, []);

        // SEC-003：通知发送密钥哈希（与回调 code 分离的独立 API Key）。
        await this.addColumnIfMissing('configurations', 'notify_key_hash', 'TEXT');
        // REV-003：历史无密钥配置的迁移截止时间（Unix 秒），过期后拒绝无 Key 调用。
        await this.addColumnIfMissing('configurations', 'legacy_until', 'INTEGER');

        // 向后兼容：为旧库补充 encrypted_callback_token 列。
        await this.addColumnIfMissing('configurations', 'encrypted_callback_token', 'TEXT');

        // 是否允许通过配置 Code 直接发送通知（默认开启，向后兼容）。
        // 关闭后 /api/notify/:code 返回 403，规则 API（/api/notify/:rule_api_code）不受影响。
        await this.addColumnIfMissing('configurations', 'code_send_enabled', 'INTEGER DEFAULT 1');
        // 旧库既有配置：未设置过的视为开启（保持向后兼容）。
        await this.runRaw(
            'UPDATE configurations SET code_send_enabled = 1 WHERE code_send_enabled IS NULL',
            []
        ).catch(() => {});

        // 规则启停开关：默认开启。禁用的规则其 API 地址发送返回 403，但规则本身保留（区别于删除）。
        await this.addColumnIfMissing('notification_rules', 'enabled', 'INTEGER DEFAULT 1');
        await this.runRaw(
            'UPDATE notification_rules SET enabled = 1 WHERE enabled IS NULL',
            []
        ).catch(() => {});

        // 多应用管理（2026-07-04）：应用总开关 + 应用聚合版本。
        // app_enabled：默认开启；为 0 时该应用的配置 Code 与全部规则 API 发送均被拒绝（外层判断）。
        await this.addColumnIfMissing('configurations', 'app_enabled', 'INTEGER DEFAULT 1');
        await this.runRaw(
            'UPDATE configurations SET app_enabled = 1 WHERE app_enabled IS NULL',
            []
        ).catch(() => {});
        // version：应用聚合版本号，除删除外的应用/规则/安全设置写操作成功时原子 +1，用于乐观锁。
        await this.addColumnIfMissing('configurations', 'version', 'INTEGER DEFAULT 1');
        await this.runRaw(
            'UPDATE configurations SET version = 1 WHERE version IS NULL OR version < 1',
            []
        ).catch(() => {});

        // 接收规则 API 自定义编号（规范 §6）：退役编号表 + 跨表命名空间防线。
        // 退役编号：曾经生效但已被修改/删除，不再能路由；保留以防止旧调用方误投到其他目标。
        await this.runRaw(`
            CREATE TABLE IF NOT EXISTS retired_notify_codes (
                code TEXT PRIMARY KEY COLLATE NOCASE,
                owner_type TEXT NOT NULL CHECK (owner_type IN ('rule', 'configuration')),
                owner_id TEXT NOT NULL,
                retired_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                reason TEXT NOT NULL CHECK (reason IN ('renamed', 'regenerated', 'deleted', 'cascade_deleted'))
            )
        `, []);
        await this.runRaw(`
            CREATE INDEX IF NOT EXISTS idx_retired_notify_codes_owner
            ON retired_notify_codes(owner_type, owner_id)
        `, []);

        // 大小写不敏感唯一索引（规范 §6.2）：ASCII 字符下 SQLite lower() 足够。
        // 用 try/catch 忽略“已存在”，保证幂等迁移；真实冲突会在审计阶段被发现。
        await this.runRaw(`
            CREATE UNIQUE INDEX IF NOT EXISTS ux_notification_rules_api_code_nocase
            ON notification_rules(lower(api_code))
        `, []).catch((err) => {
            const msg = String(err && err.message || '');
            if (!msg.includes('already exists')) throw err;
        });
        await this.runRaw(`
            CREATE UNIQUE INDEX IF NOT EXISTS ux_configurations_code_nocase
            ON configurations(lower(code))
        `, []).catch((err) => {
            const msg = String(err && err.message || '');
            if (!msg.includes('already exists')) throw err;
        });

        // 跨表/退役防冲突触发器（规范 §6.3）：服务层之外的兜底完整性防线。
        // 触发器使用固定错误标识 NOTIFY_CODE_CONFLICT，不拼接用户输入，避免 SQLite 错误文本泄漏。
        await this._installNotifyCodeTriggers();

        // 启动前迁移审计（规范 §6.4）：发现历史跨表/大小写冲突即失败，不静默改号。
        await this._auditNotifyCodeNamespaceOrThrow();
    }

    // 安装通知编号命名空间防冲突触发器（规范 §6.3）。
    // 这些触发器是服务层校验之外的最后防线，防止未来新增遗漏写路径破坏不变量。
    async _installNotifyCodeTriggers() {
        // 规则插入/改号时，拒绝与 configurations.code 冲突。
        // NEW.api_code vs configurations.code（大小写不敏感）。
        await this.runRaw(`
            CREATE TRIGGER IF NOT EXISTS trg_rules_code_vs_config_insert
            BEFORE INSERT ON notification_rules
            FOR EACH ROW
            WHEN EXISTS (SELECT 1 FROM configurations WHERE lower(code) = lower(NEW.api_code))
            BEGIN
                SELECT RAISE(ABORT, 'NOTIFY_CODE_CONFLICT');
            END
        `, []);
        await this.runRaw(`
            CREATE TRIGGER IF NOT EXISTS trg_rules_code_vs_config_update
            BEFORE UPDATE OF api_code ON notification_rules
            FOR EACH ROW
            WHEN EXISTS (SELECT 1 FROM configurations WHERE lower(code) = lower(NEW.api_code))
            BEGIN
                SELECT RAISE(ABORT, 'NOTIFY_CODE_CONFLICT');
            END
        `, []);
        // 规则插入/改号时，拒绝与不属于当前规则的退役编号冲突。
        // INSERT 时 NEW.id 为新规则，不存在“自己的退役编号”语义，全部退役编号都算冲突。
        await this.runRaw(`
            CREATE TRIGGER IF NOT EXISTS trg_rules_code_vs_retired_insert
            BEFORE INSERT ON notification_rules
            FOR EACH ROW
            WHEN EXISTS (
                SELECT 1 FROM retired_notify_codes
                WHERE lower(code) = lower(NEW.api_code)
                  AND NOT (owner_type = 'rule' AND owner_id = CAST(NEW.id AS TEXT))
            )
            BEGIN
                SELECT RAISE(ABORT, 'NOTIFY_CODE_CONFLICT');
            END
        `, []);
        // UPDATE 改号时，允许恢复当前规则（NEW.id）自己登记过的退役编号。
        await this.runRaw(`
            CREATE TRIGGER IF NOT EXISTS trg_rules_code_vs_retired_update
            BEFORE UPDATE OF api_code ON notification_rules
            FOR EACH ROW
            WHEN EXISTS (
                SELECT 1 FROM retired_notify_codes
                WHERE lower(code) = lower(NEW.api_code)
                  AND NOT (owner_type = 'rule' AND owner_id = CAST(NEW.id AS TEXT))
            )
            BEGIN
                SELECT RAISE(ABORT, 'NOTIFY_CODE_CONFLICT');
            END
        `, []);
        // 配置插入/改 Code 时，拒绝与规则编号冲突。
        await this.runRaw(`
            CREATE TRIGGER IF NOT EXISTS trg_config_code_vs_rules_insert
            BEFORE INSERT ON configurations
            FOR EACH ROW
            WHEN EXISTS (SELECT 1 FROM notification_rules WHERE lower(api_code) = lower(NEW.code))
            BEGIN
                SELECT RAISE(ABORT, 'NOTIFY_CODE_CONFLICT');
            END
        `, []);
        await this.runRaw(`
            CREATE TRIGGER IF NOT EXISTS trg_config_code_vs_rules_update
            BEFORE UPDATE OF code ON configurations
            FOR EACH ROW
            WHEN EXISTS (SELECT 1 FROM notification_rules WHERE lower(api_code) = lower(NEW.code))
            BEGIN
                SELECT RAISE(ABORT, 'NOTIFY_CODE_CONFLICT');
            END
        `, []);
        // 配置插入/改 Code 时，拒绝与任一退役编号冲突（应用 Code 退役后不可被任何对象接管）。
        await this.runRaw(`
            CREATE TRIGGER IF NOT EXISTS trg_config_code_vs_retired_insert
            BEFORE INSERT ON configurations
            FOR EACH ROW
            WHEN EXISTS (SELECT 1 FROM retired_notify_codes WHERE lower(code) = lower(NEW.code))
            BEGIN
                SELECT RAISE(ABORT, 'NOTIFY_CODE_CONFLICT');
            END
        `, []);
        await this.runRaw(`
            CREATE TRIGGER IF NOT EXISTS trg_config_code_vs_retired_update
            BEFORE UPDATE OF code ON configurations
            FOR EACH ROW
            WHEN EXISTS (SELECT 1 FROM retired_notify_codes WHERE lower(code) = lower(NEW.code))
            BEGIN
                SELECT RAISE(ABORT, 'NOTIFY_CODE_CONFLICT');
            END
        `, []);
    }

    // 迁移审计：返回 { conflicts: [{type, ...}] }；不抛错，供调用方决定（init 时抛错版本在此之上封装）。
    // 规范 §6.4：规则表内部大小写重复、配置表内部大小写重复、规则编号 vs 配置 Code 跨表冲突。
    async auditNotifyCodeNamespace() {
        const conflicts = [];
        // 规则表内部大小写重复
        const ruleDups = await this.allRaw(
            `SELECT lower(api_code) AS normalized_code, count(*) AS count, group_concat(id) AS ids
             FROM notification_rules GROUP BY lower(api_code) HAVING count(*) > 1`,
            []
        );
        for (const row of ruleDups) {
            conflicts.push({ type: 'rule_duplicate', normalized_code: row.normalized_code, ids: row.ids });
        }
        // 配置表内部大小写重复
        const configDups = await this.allRaw(
            `SELECT lower(code) AS normalized_code, count(*) AS count, group_concat(code) AS codes
             FROM configurations GROUP BY lower(code) HAVING count(*) > 1`,
            []
        );
        for (const row of configDups) {
            conflicts.push({ type: 'config_duplicate', normalized_code: row.normalized_code, codes: row.codes });
        }
        // 规则编号 vs 配置 Code 跨表冲突
        const crossTable = await this.allRaw(
            `SELECT r.id AS rule_id, r.api_code, c.code AS config_code
             FROM notification_rules r
             JOIN configurations c ON lower(r.api_code) = lower(c.code)`,
            []
        );
        for (const row of crossTable) {
            conflicts.push({
                type: 'cross_table',
                rule_id: row.rule_id,
                api_code: row.api_code,
                config_code: row.config_code
            });
        }
        return { conflicts };
    }

    // 启动期审计：发现冲突即抛清晰错误，列出冲突类型与对象 ID；不静默改号、不自动修复。
    async _auditNotifyCodeNamespaceOrThrow() {
        const { conflicts } = await this.auditNotifyCodeNamespace();
        if (conflicts.length === 0) return;
        const lines = conflicts.map((c) => {
            if (c.type === 'cross_table') {
                return `  - cross_table: 规则 id=${c.rule_id} api_code='${c.api_code}' 与配置 code='${c.config_code}' 冲突`;
            }
            if (c.type === 'rule_duplicate') {
                return `  - rule_duplicate: 规则编号 '${c.normalized_code}' 被多条规则占用 (ids=${c.ids})`;
            }
            return `  - config_duplicate: 配置 Code '${c.normalized_code}' 被多条配置占用 (codes=${c.codes})`;
        });
        throw new Error(
            '通知编号命名空间迁移审计发现历史冲突，无法安全启动；请人工确认归属并改号后再重启：\n'
            + lines.join('\n')
        );
    }

    async addColumnIfMissing(table, column, type) {
        try {
            await this.runRaw(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, []);
        } catch (err) {
            // REV-008：列已存在属正常（幂等），可忽略；其它错误必须抛出，避免结构未完成却误判就绪。
            const msg = String(err && err.message || '');
            if (msg.includes('duplicate column') || msg.includes('already exists')) {
                return;
            }
            throw err;
        }
    }

    // 多应用（P0-01 修复）：private direct 方法直接访问共享连接，不再入队。
    // 仅在事务内部（已独占连接）或其它确信已串行的路径使用，避免自锁。
    _allDirect(sql, params = []) {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject(new Error('数据库未初始化'));
            this.db.all(sql, params, (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            });
        });
    }

    _runDirect(sql, params = []) {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject(new Error('数据库未初始化'));
            this.db.run(sql, params, function (err) {
                if (err) return reject(err);
                resolve({ lastID: this && this.lastID, changes: this && this.changes });
            });
        });
    }

    _getDirect(sql, params = []) {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject(new Error('数据库未初始化'));
            this.db.get(sql, params, (err, row) => {
                if (err) return reject(err);
                resolve(row);
            });
        });
    }

    // 通用 raw 查询接口（供迁移使用）。所有公共读写经过全局队列，
    // 保证事务期间本请求的语句不会被另一请求的事务卷入。
    allRaw(sql, params = []) {
        return this.enqueueOperation(() => this._allDirect(sql, params));
    }

    runRaw(sql, params = []) {
        return this.enqueueOperation(() => this._runDirect(sql, params));
    }

    // 保存配置
    async saveConfiguration(config) {
        const {
            code, corpid, encrypted_corpsecret, agentid, touser, description,
            encrypted_callback_token, encrypted_encoding_aes_key, callback_enabled,
            notify_key_hash, legacy_until
        } = config;
        const sql = `
            INSERT INTO configurations (
                code, corpid, encrypted_corpsecret, agentid, touser, description,
                callback_token, encrypted_callback_token, encrypted_encoding_aes_key, callback_enabled,
                notify_key_hash, legacy_until
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const result = await this.runRaw(sql, [
            code, corpid, encrypted_corpsecret, agentid, touser, description,
            null, encrypted_callback_token, encrypted_encoding_aes_key, callback_enabled || 0,
            notify_key_hash || null, legacy_until || null
        ]);
        return { id: result.lastID, code };
    }

    // 根据 code 获取配置。
    // 规范 §4.1 / §6.2：编号比较 ASCII 不区分大小写（与 ux_*_nocase 唯一索引一致）。
    // 调用方应优先使用返回行中的 code 作为后续写操作的权威标识。
    async getConfigurationByCode(code) {
        if (code === undefined || code === null || String(code).trim() === '') return null;
        const sql = `SELECT * FROM configurations WHERE lower(code) = lower(?)`;
        return this.get(sql, [String(code)]);
    }

    async listConfigurations() {
        const sql = `
            SELECT code, corpid, agentid, touser, encrypted_corpsecret, description,
                   callback_enabled, code_send_enabled, app_enabled, version,
                   notify_key_hash, legacy_until, created_at
            FROM configurations
            ORDER BY id DESC
        `;
        return this.allRaw(sql, []);
    }

    // 更新配置
    async updateConfiguration(config) {
        const {
            code, corpid, encrypted_corpsecret, agentid, touser, description,
            encrypted_callback_token, encrypted_encoding_aes_key, callback_enabled
        } = config;
        const sql = `
            UPDATE configurations
            SET corpid = ?, encrypted_corpsecret = ?, agentid = ?, touser = ?, description = ?,
                callback_token = ?, encrypted_callback_token = ?, encrypted_encoding_aes_key = ?, callback_enabled = ?
            WHERE code = ?
        `;
        await this.runRaw(sql, [
            corpid, encrypted_corpsecret, agentid, touser, description,
            null, encrypted_callback_token, encrypted_encoding_aes_key, callback_enabled,
            code
        ]);
        return { code };
    }

    // 根据字段查询配置
    async getConfigurationByFields(corpid, agentid, touser) {
        const sql = `SELECT * FROM configurations WHERE corpid = ? AND agentid = ? AND touser = ?`;
        return this.get(sql, [corpid, agentid, touser]);
    }

    // 根据完整字段查询配置（包括回调配置）
    // 注意：回调 Token 现已加密存储，无法直接按明文匹配；这里改为忽略 token 维度，
    // 仅按 (corpid, agentid, touser, callback_enabled) 判重，避免明文 token 比对。
    async getConfigurationByCompleteFields(corpid, agentid, touser, callback_enabled, callback_token) {
        const sql = `SELECT * FROM configurations WHERE corpid = ? AND agentid = ? AND touser = ? AND callback_enabled = ?`;
        return this.get(sql, [corpid, agentid, touser, callback_enabled]);
    }

    // 保存回调配置（第一步）
    async saveCallbackConfiguration(config) {
        const { code, corpid, encrypted_callback_token, encrypted_encoding_aes_key } = config;
        const sql = `
            INSERT INTO configurations (
                code, corpid, encrypted_callback_token, encrypted_encoding_aes_key, callback_enabled,
                encrypted_corpsecret, agentid, touser, description
            )
            VALUES (?, ?, ?, ?, 1, '', 0, '', '')
        `;

        const result = await this.runRaw(sql, [code, corpid, encrypted_callback_token, encrypted_encoding_aes_key]);
        return { id: result.lastID, code };
    }

    // 查询回调配置（按 corpid；token 已加密，无法按明文匹配）
    // 历史方法：按 corpid + callback_enabled=1 取最新一行。
    // ⚠ 多应用支持注意：此查询会把同企业“已完成且启用回调的应用”也命中，
    //    不能用于判断“是否有未完成草稿”。草稿判断请改用 getIncompleteConfigurationByCorpId()。
    async getCallbackConfiguration(corpid) {
        const sql = `SELECT * FROM configurations WHERE corpid = ? AND callback_enabled = 1 ORDER BY id DESC LIMIT 1`;
        return this.get(sql, [corpid]);
    }

    // 多应用（2026-07-04）：草稿查询只命中真正未完成的行。
    // 草稿定义见设计文档 §4.2 不变量 5：有回调凭证但 encrypted_corpsecret 空、agentid=0、touser=''。
    // 不再用 callback_enabled=1 判断草稿，因为已完成且启用回调的应用同样满足该条件。
    async getIncompleteConfigurationByCorpId(corpid) {
        const sql = `
            SELECT * FROM configurations
            WHERE corpid = ?
              AND agentid = 0
              AND touser = ''
              AND (encrypted_corpsecret = '' OR encrypted_corpsecret IS NULL)
            ORDER BY id DESC
            LIMIT 1
        `;
        return this.get(sql, [corpid]);
    }

    // 多应用：按应用身份 (corpid, agentid) 查询其他“已完成”配置（排除指定 code）。
    // 仅用于身份判重（新建、完成、实际修改 AgentID 时）。历史重复项不自动合并。
    // excludeCode 为空时不过滤；只命中 isCompletedConfig 意义上的完成行，避免与草稿冲突误报。
    async findCompletedByCorpidAgentId(corpid, agentid, excludeCode = null) {
        const sql = `
            SELECT * FROM configurations
            WHERE corpid = ? AND agentid = ?
              AND encrypted_corpsecret != '' AND encrypted_corpsecret IS NOT NULL
              ${excludeCode ? 'AND code != ?' : ''}
            ORDER BY id DESC
            LIMIT 1
        `;
        const params = excludeCode ? [corpid, agentid, excludeCode] : [corpid, agentid];
        return this.get(sql, params);
    }

    // 多应用：找出与给定 (corpid, agentid) 冲突的所有完成行（用于总览 duplicate_identity 标记）。
    async findDuplicatesByCorpidAgentId(corpid, agentid) {
        const sql = `
            SELECT code FROM configurations
            WHERE corpid = ? AND agentid = ?
              AND encrypted_corpsecret != '' AND encrypted_corpsecret IS NOT NULL
            ORDER BY id ASC
        `;
        return this.allRaw(sql, [corpid, agentid]);
    }

    // 多应用：touched-field 局部更新 + 乐观锁。
    // fields 是 {列名: 值} 只包含本次实际修改的列；expectedVersion 缺省跳过版本检查；
    // 成功时同时 version = version + 1，返回 { code, changes, version }；版本不匹配 changes=0。
    async updateConfigurationFields(code, fields, expectedVersion) {
        const sets = [];
        const params = [];
        for (const [col, val] of Object.entries(fields)) {
            // 白名单：只允许更新应用级字段，禁止通过此接口改 code/version。
            if (!UPDATE_FIELD_WHITELIST.has(col)) continue;
            sets.push(`${col} = ?`);
            params.push(val);
        }
        if (sets.length === 0) {
            // 没有可更新列：视为无操作，直接读回当前版本。
            const row = await this.getConfigurationByCode(code);
            return { code, changes: 0, version: row ? (Number(row.version) || 1) : null };
        }
        sets.push('version = version + 1');
        params.push(String(code));
        // 与 getConfigurationByCode 一致：大小写不敏感匹配，避免 /Edit 路径大小写差异导致 0 行更新。
        let whereClause = 'WHERE lower(code) = lower(?)';
        if (expectedVersion !== undefined && expectedVersion !== null) {
            whereClause += ' AND version = ?';
            params.push(expectedVersion);
        }
        const sql = `UPDATE configurations SET ${sets.join(', ')} ${whereClause}`;
        const result = await this.runRaw(sql, params);
        // 读回新版本（无论是否命中，便于上层区分 404 与冲突）。
        const row = await this.getConfigurationByCode(code);
        return {
            // 返回库内权威 code（规范大小写），不回传调用方可能大小写不一致的入参。
            code: row ? row.code : code,
            changes: result.changes,
            version: row ? (Number(row.version) || 1) : null
        };
    }

    // 多应用：批量读取规则聚合数（避免列表 N+1 查询）。
    // 返回 { [configCode]: { rule_count, enabled_rule_count } }。
    async countRulesByConfigCodes(codes) {
        if (!codes || codes.length === 0) return {};
        const placeholders = codes.map(() => '?').join(',');
        const sql = `
            SELECT config_code,
                   COUNT(*) AS rule_count,
                   SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled_rule_count
            FROM notification_rules
            WHERE config_code IN (${placeholders})
            GROUP BY config_code
        `;
        const rows = await this.allRaw(sql, codes);
        const map = {};
        for (const r of rows) {
            map[r.config_code] = {
                rule_count: Number(r.rule_count) || 0,
                enabled_rule_count: Number(r.enabled_rule_count) || 0
            };
        }
        return map;
    }

    // 完善配置（第二步）
    async completeConfiguration(config) {
        const { code, encrypted_corpsecret, agentid, touser, description, notify_key_hash } = config;
        if (notify_key_hash) {
            const sql = `
                UPDATE configurations
                SET encrypted_corpsecret = ?, agentid = ?, touser = ?, description = ?, notify_key_hash = ?, legacy_until = NULL
                WHERE code = ?
            `;
            await this.runRaw(sql, [encrypted_corpsecret, agentid, touser, description, notify_key_hash, code]);
        } else {
            const sql = `
                UPDATE configurations
                SET encrypted_corpsecret = ?, agentid = ?, touser = ?, description = ?
                WHERE code = ?
            `;
            await this.runRaw(sql, [encrypted_corpsecret, agentid, touser, description, code]);
        }
        return { code };
    }

    async listNotificationRules(configCode) {
        const sql = `SELECT * FROM notification_rules WHERE config_code = ? ORDER BY id DESC`;
        return this.allRaw(sql, [configCode]);
    }

    // 按规则 API 编号查询。规范要求不区分大小写：自定义编号以小写入库，
    // 但调用方可能传入 OPS-ALERT 等变体，必须仍能命中 ops-alert。
    async getNotificationRuleByApiCode(apiCode) {
        if (apiCode === undefined || apiCode === null || String(apiCode).trim() === '') return null;
        const sql = `SELECT * FROM notification_rules WHERE lower(api_code) = lower(?)`;
        return this.get(sql, [String(apiCode)]);
    }

    async getNotificationRuleById(id) {
        const sql = `SELECT * FROM notification_rules WHERE id = ?`;
        return this.get(sql, [id]);
    }

    async saveNotificationRule(rule) {
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

        const result = await this.runRaw(sql, [
            config_code, api_code, name, touser, toparty, totag,
            is_all || 0, estimated_count || 1
        ]);
        return { id: result.lastID, api_code };
    }

    async updateNotificationRule(rule) {
        const {
            id, name, touser, toparty, totag, is_all, estimated_count
        } = rule;
        const sql = `
            UPDATE notification_rules
            SET name = ?, touser = ?, toparty = ?, totag = ?,
                is_all = ?, estimated_count = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `;

        await this.runRaw(sql, [
            name, touser, toparty, totag,
            is_all || 0, estimated_count || 1, id
        ]);
        return { id };
    }

    async regenerateNotificationRuleApiCode(id, apiCode) {
        const sql = `
            UPDATE notification_rules
            SET api_code = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `;

        await this.runRaw(sql, [apiCode, id]);
        return { id, api_code: apiCode };
    }

    async deleteNotificationRule(id) {
        const sql = `DELETE FROM notification_rules WHERE id = ?`;
        await this.runRaw(sql, [id]);
        return { id };
    }

    // 接收规则 API 自定义编号（规范 §7.2）：通知编号命名空间冲突检查与退役登记 helper。
    // 这两个 helper 接受事务句柄 tx（由 withTransaction/mutateRuleWithAppVersion 提供），
    // 在同一事务内执行，保证“校验→写入→版本递增”整体原子。

    // 检查候选编号是否被占用。返回 null（可用）或 { scope, reclaimable }。
    //   scope: 'rule' | 'configuration' | 'retired'
    //   reclaimable: 仅当命中“当前规则自己的退役编号”时为 true，其它一律 false。
    // 规范 §4.4 冲突矩阵：当前规则自己的退役编号允许恢复（reclaim），其它退役编号不可用。
    // ruleId：更新现有规则时传，用于判断 reclaimable；创建时传 null。
    async inspectNotifyCodeConflict(tx, apiCode, { ruleId = null } = {}) {
        const normalized = String(apiCode).toLowerCase();
        const ruleIdText = ruleId == null ? null : String(ruleId);
        // 1. 与其它当前规则的 api_code 冲突（大小写不敏感）。
        const ruleRow = await tx.get(
            `SELECT id FROM notification_rules WHERE lower(api_code) = ?`,
            [normalized]
        );
        if (ruleRow) {
            // 命中自己当前编号不算冲突（update 流程在调用前已处理同值情况，但此处保持稳健）。
            if (ruleIdText !== null && String(ruleRow.id) === ruleIdText) {
                return null;
            }
            return { scope: 'rule', reclaimable: false };
        }
        // 2. 与当前配置 Code 冲突。
        const configRow = await tx.get(
            `SELECT code FROM configurations WHERE lower(code) = ?`,
            [normalized]
        );
        if (configRow) {
            return { scope: 'configuration', reclaimable: false };
        }
        // 3. 与退役编号冲突：仅当前规则自己的退役编号可恢复。
        const retiredRow = await tx.get(
            `SELECT owner_type, owner_id FROM retired_notify_codes WHERE lower(code) = ?`,
            [normalized]
        );
        if (retiredRow) {
            const reclaimable = ruleIdText !== null
                && retiredRow.owner_type === 'rule'
                && retiredRow.owner_id === ruleIdText;
            return { scope: 'retired', reclaimable };
        }
        return null;
    }

    // 登记退役编号（幂等：INSERT ... ON CONFLICT(code) DO UPDATE）。
    // 规范 §6.5：改号/重生成/删除/级联删除都通过此 helper 维护退役表。
    // ownerType: 'rule' | 'configuration'；ownerId: 规则保存 String(rule.id)，应用保存其稳定 code。
    async retireNotifyCode(tx, { code, ownerType, ownerId, reason }) {
        const normalized = String(code).toLowerCase();
        await tx.run(
            `INSERT INTO retired_notify_codes (code, owner_type, owner_id, reason)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(code) DO UPDATE SET
                 owner_type = excluded.owner_type,
                 owner_id = excluded.owner_id,
                 reason = excluded.reason,
                 retired_at = CURRENT_TIMESTAMP`,
            [normalized, ownerType, String(ownerId), reason]
        );
    }

    // 多应用（§6.2 事务 + P0-01 修复）：串行化事务封装。
    //
    // sqlite3 共享连接默认串行排队单条语句，但 Node async/await 允许不同请求的语句
    // 在事务的 BEGIN...COMMIT 之间交错。为杜绝“第一条删除成功、第二条删除失败但语句
    // 来自其他请求混入”的情况，事务以 exclusive 方式排入全局队列：
    //   - 事务占位（exclusive）后，期间其它读写（enqueueOperation）排队到事务释放后。
    //   - BEGIN IMMEDIATE 立即获取写锁，避免升级死锁。
    //   - 异常执行 ROLLBACK；正常 COMMIT。任何路径都释放锁。
    //
    // fn 接收 tx 句柄（run/get/all），tx 句柄直接使用 private direct 方法（不再入队），
    // 避免事务内自锁。禁止在 fn 内回调 this.runRaw/get/allRaw 等公共接口（会重复入队导致死锁）。
    async withTransaction(fn) {
        return this.enqueueOperation(async () => {
            this._inTransaction = true;
            try {
                await this._runDirect('BEGIN IMMEDIATE', []);
                const tx = {
                    run: (sql, params) => this._runDirect(sql, params || []),
                    get: (sql, params) => this._getDirect(sql, params || []),
                    all: (sql, params) => this._allDirect(sql, params || [])
                };
                const result = await fn(tx);
                await this._runDirect('COMMIT', []);
                return result;
            } catch (err) {
                // 尽力回滚；回滚失败不应掩盖原始错误。
                try { await this._runDirect('ROLLBACK', []); } catch (_e) { /* ignore */ }
                throw err;
            } finally {
                this._inTransaction = false;
            }
        }, { exclusive: true });
    }

    // 多应用（§6.6 级联删除）：事务内校验版本 + 删除规则 + 删除配置。
    // 返回 { configurations_deleted, rules_deleted }。
    // 配置不存在时抛 { __deleteCause: 'missing' }；版本不匹配抛 { __deleteCause: 'version' }，
    // 由 service 层翻译成 APP_NOT_FOUND / APP_VERSION_CONFLICT。
    async deleteConfigurationCascade(code, expectedVersion) {
        return this.withTransaction(async (tx) => {
            const row = await tx.get(
                'SELECT version FROM configurations WHERE code = ?',
                [code]
            );
            if (!row) {
                const e = new Error('not found');
                e.__deleteCause = 'missing';
                throw e;
            }
            const currentVersion = Number(row.version) || 1;
            if (Number(expectedVersion) !== currentVersion) {
                const e = new Error('version mismatch');
                e.__deleteCause = 'version';
                throw e;
            }
            const rules = await tx.all(
                'SELECT id, api_code FROM notification_rules WHERE config_code = ?',
                [code]
            );
            const rulesDeleted = (rules || []).length;
            // 规范 §6.5：删除应用前，把应用 Code 与全部规则编号登记为退役（cascade_deleted），
            // 避免遗留调用方误发到后续新建的对象。全部步骤在同一事务完成。
            await this.retireNotifyCode(tx, {
                code, ownerType: 'configuration', ownerId: code, reason: 'cascade_deleted'
            });
            for (const r of rules || []) {
                await this.retireNotifyCode(tx, {
                    code: r.api_code,
                    ownerType: 'rule',
                    ownerId: String(r.id),
                    reason: 'cascade_deleted'
                });
            }
            await tx.run('DELETE FROM notification_rules WHERE config_code = ?', [code]);
            const configResult = await tx.run(
                'DELETE FROM configurations WHERE code = ? AND version = ?',
                [code, currentVersion]
            );
            if (configResult.changes !== 1) {
                // 版本在校验后到删除间被改动 → 触发回滚。
                const e = new Error('version changed mid-transaction');
                e.__deleteCause = 'version';
                throw e;
            }
            return { configurations_deleted: 1, rules_deleted: rulesDeleted };
        });
    }

    // 多应用（P0-03 §3.3）：规则变更与应用聚合版本原子提交。
    //
    // identity:
    //   - { configCode, ruleId }：update/regenerate/delete/setRuleEnabled 由 ruleId 找应用。
    //   - { configCode }：create 由 configCode 找应用。
    // expectedVersion: 应用当前期望版本（正整数）。
    // mutation(tx, app): 事务内执行规则 INSERT/UPDATE/DELETE；返回规则操作结果（任意结构）。
    //
    // 失败模式（service 翻译为稳定错误）：
    //   - 应用不存在：{ __ruleCause: 'app_missing' }
    //   - 应用仍是草稿：{ __ruleCause: 'app_not_completed' }
    //   - 版本不匹配：{ __ruleCause: 'version_conflict' }
    //   - 规则不存在：由 mutation 抛 { __ruleCause: 'rule_missing' }。
    // 任一步失败整体回滚；成功返回 { rule: mutationResult, app_version }。
    async mutateRuleWithAppVersion(identity, expectedVersion, mutation) {
        return this.withTransaction(async (tx) => {
            // 由 ruleId 反查所属 config_code（update/regenerate/delete/enabled）。
            let configCode = identity.configCode;
            if (!configCode && identity.ruleId) {
                const ruleRow = await tx.get(
                    'SELECT config_code FROM notification_rules WHERE id = ?',
                    [Number(identity.ruleId)]
                );
                if (!ruleRow) {
                    const e = new Error('rule missing');
                    e.__ruleCause = 'rule_missing';
                    throw e;
                }
                configCode = ruleRow.config_code;
            }
            const app = await tx.get(
                'SELECT code, version, encrypted_corpsecret, agentid, touser FROM configurations WHERE code = ?',
                [configCode]
            );
            if (!app) {
                const e = new Error('app missing');
                e.__ruleCause = 'app_missing';
                throw e;
            }
            // 草稿不允许规则操作（设计 §4.2 不变量 5）。
            const hasSecret = typeof app.encrypted_corpsecret === 'string' && app.encrypted_corpsecret.length > 0;
            const agentOk = Number.isInteger(Number(app.agentid)) && Number(app.agentid) > 0;
            const touserOk = String(app.touser || '').split('|').filter(Boolean).length > 0;
            const completed = hasSecret && agentOk && touserOk;
            if (!completed) {
                const e = new Error('app not completed');
                e.__ruleCause = 'app_not_completed';
                throw e;
            }
            const currentVersion = Number(app.version) || 1;
            if (Number(expectedVersion) !== currentVersion) {
                const e = new Error('version conflict');
                e.__ruleCause = 'version_conflict';
                e.__currentVersion = currentVersion;
                throw e;
            }
            // 执行规则变更。
            const ruleResult = await mutation(tx, app);
            // 原子递增应用版本（CAS：code + version 双条件）。
            const bumpResult = await tx.run(
                'UPDATE configurations SET version = version + 1 WHERE code = ? AND version = ?',
                [configCode, currentVersion]
            );
            if (bumpResult.changes !== 1) {
                // 版本在校验后到递增间被改动 → 触发回滚。
                const e = new Error('version changed mid-transaction');
                e.__ruleCause = 'version_conflict';
                throw e;
            }
            return { rule: ruleResult, app_version: currentVersion + 1 };
        });
    }

    // 多应用（P0-05 §3.4）：完成草稿的原子身份事务。
    //
    // 在事务内重新读取草稿 + 校验版本 + 检查 (corpid, agentid) 无其他完成应用，
    // 然后按 code + version + 草稿条件更新，version + 1。
    // 微信在线验证在事务外执行（避免长期持锁）；本方法只负责数据库阶段原子化。
    //
    // 失败模式：
    //   - 应用不存在：{ __completeCause: 'missing' }
    //   - 已完成（非草稿）：{ __completeCause: 'already_completed' }
    //   - 版本不匹配：{ __completeCause: 'version_conflict' }
    //   - 身份冲突：{ __completeCause: 'identity_conflict', __existingCode }
    // 任一步失败整体回滚；成功返回 { code, version }。
    async completeConfigurationAtomic(code, fields, expectedVersion, { numericAgentid } = {}) {
        return this.withTransaction(async (tx) => {
            const row = await tx.get(
                'SELECT code, corpid, encrypted_corpsecret, agentid, touser, version FROM configurations WHERE code = ?',
                [code]
            );
            if (!row) {
                const e = new Error('missing');
                e.__completeCause = 'missing';
                throw e;
            }
            // 草稿校验（与 isDraftConfig 一致）。
            const hasSecret = typeof row.encrypted_corpsecret === 'string' && row.encrypted_corpsecret.length > 0;
            const agentOk = Number.isInteger(Number(row.agentid)) && Number(row.agentid) > 0;
            const touserOk = String(row.touser || '').split('|').filter(Boolean).length > 0;
            if (hasSecret && agentOk && touserOk) {
                const e = new Error('already completed');
                e.__completeCause = 'already_completed';
                throw e;
            }
            const currentVersion = Number(row.version) || 1;
            if (Number(expectedVersion) !== currentVersion) {
                const e = new Error('version conflict');
                e.__completeCause = 'version_conflict';
                e.__currentVersion = currentVersion;
                throw e;
            }
            // 身份判重：同 (corpid, agentid) 的其他完成应用禁止再被覆盖。
            const conflict = await tx.get(
                `SELECT code FROM configurations
                 WHERE corpid = ? AND agentid = ?
                   AND encrypted_corpsecret != '' AND encrypted_corpsecret IS NOT NULL
                   AND code != ?
                 LIMIT 1`,
                [row.corpid, numericAgentid, code]
            );
            if (conflict) {
                const e = new Error('identity conflict');
                e.__completeCause = 'identity_conflict';
                e.__existingCode = conflict.code;
                throw e;
            }
            // 按 code + version + 草稿条件更新，version + 1。
            const sets = [];
            const params = [];
            for (const [col, val] of Object.entries(fields)) {
                if (!UPDATE_FIELD_WHITELIST.has(col)) continue;
                sets.push(`${col} = ?`);
                params.push(val);
            }
            sets.push('version = version + 1');
            params.push(code, currentVersion);
            const sql = `UPDATE configurations SET ${sets.join(', ')} WHERE code = ? AND version = ?`;
            const result = await tx.run(sql, params);
            if (result.changes !== 1) {
                const e = new Error('version changed mid-transaction');
                e.__completeCause = 'version_conflict';
                throw e;
            }
            return { code, version: currentVersion + 1 };
        });
    }

    // 多应用（R-P0-01 §4）：编辑应用的原子身份事务。
    //
    // 在事务内重新读取应用、校验版本；若 AgentID 实际变化，在同一事务内重新检查目标
    // (corpid, targetAgentid) 是否与其他完成应用冲突；最后按 code+version 更新 touched fields。
    // 微信在线验证在事务外执行（禁止网络调用占用写事务）；本方法只负责数据库阶段原子化。
    //
    // opts:
    //   - targetAgentid: 实际变更后的 AgentID（正整数）。未变化/不校验时传 null/undefined。
    //   - checkIdentity: 是否执行身份判重。AgentID 未变化时传 false（允许治理历史重复）。
    //
    // 失败模式：
    //   - 应用不存在：{ __updateCause: 'missing' }
    //   - 版本不匹配：{ __updateCause: 'version_conflict', __currentVersion }
    //   - 身份冲突：{ __updateCause: 'identity_conflict', __existingCode }
    // 任一步失败整体回滚；成功返回 { code, version }。
    async updateConfigurationAtomic(code, fields, expectedVersion, opts = {}) {
        const { targetAgentid = null, checkIdentity = false } = opts;
        return this.withTransaction(async (tx) => {
            const row = await tx.get(
                'SELECT code, corpid, agentid, version FROM configurations WHERE code = ?',
                [code]
            );
            if (!row) {
                const e = new Error('missing');
                e.__updateCause = 'missing';
                throw e;
            }
            const currentVersion = Number(row.version) || 1;
            if (Number(expectedVersion) !== currentVersion) {
                const e = new Error('version conflict');
                e.__updateCause = 'version_conflict';
                e.__currentVersion = currentVersion;
                throw e;
            }
            // 仅当 AgentID 实际变化时才在同一事务内重新检查目标身份。
            if (checkIdentity && targetAgentid) {
                const conflict = await tx.get(
                    `SELECT code FROM configurations
                     WHERE corpid = ? AND agentid = ?
                       AND encrypted_corpsecret != '' AND encrypted_corpsecret IS NOT NULL
                       AND code != ?
                     LIMIT 1`,
                    [row.corpid, Number(targetAgentid), code]
                );
                if (conflict) {
                    const e = new Error('identity conflict');
                    e.__updateCause = 'identity_conflict';
                    e.__existingCode = conflict.code;
                    throw e;
                }
            }
            // 按 code + version 更新 touched fields，version + 1。
            const sets = [];
            const params = [];
            for (const [col, val] of Object.entries(fields)) {
                if (!UPDATE_FIELD_WHITELIST.has(col)) continue;
                sets.push(`${col} = ?`);
                params.push(val);
            }
            if (sets.length === 0) {
                // 没有可更新列：幂等无操作，不增版本。
                return { code, version: currentVersion };
            }
            sets.push('version = version + 1');
            params.push(code, currentVersion);
            const sql = `UPDATE configurations SET ${sets.join(', ')} WHERE code = ? AND version = ?`;
            const result = await tx.run(sql, params);
            if (result.changes !== 1) {
                const e = new Error('version changed mid-transaction');
                e.__updateCause = 'version_conflict';
                e.__currentVersion = currentVersion;
                throw e;
            }
            return { code, version: currentVersion + 1 };
        });
    }

    // 多应用（P0-05 §3.4）：createConfiguration 的原子身份事务。
    //
    // 在事务内检查 (corpid, agentid) 完成应用，无冲突才 INSERT。
    // 失败模式：
    //   - 身份冲突：{ __createCause: 'identity_conflict', __existingCode }
    //   - 唯一约束竞争失败（并发创建同身份）：{ __createCause: 'identity_conflict' }
    // 成功返回 { code, id }。
    async createConfigurationAtomic(config) {
        const {
            code, corpid, encrypted_corpsecret, agentid, touser, description,
            encrypted_callback_token, encrypted_encoding_aes_key, callback_enabled,
            notify_key_hash, legacy_until
        } = config;
        return this.withTransaction(async (tx) => {
            // 按 (corpid, agentid) 判重（不再按 touser 区分应用身份）。
            const conflict = await tx.get(
                `SELECT code FROM configurations
                 WHERE corpid = ? AND agentid = ?
                   AND encrypted_corpsecret != '' AND encrypted_corpsecret IS NOT NULL
                 LIMIT 1`,
                [corpid, agentid]
            );
            if (conflict) {
                const e = new Error('identity conflict');
                e.__createCause = 'identity_conflict';
                e.__existingCode = conflict.code;
                throw e;
            }
            try {
                const result = await tx.run(
                    `INSERT INTO configurations (
                        code, corpid, encrypted_corpsecret, agentid, touser, description,
                        callback_token, encrypted_callback_token, encrypted_encoding_aes_key, callback_enabled,
                        notify_key_hash, legacy_until
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [code, corpid, encrypted_corpsecret, agentid, touser, description,
                     null, encrypted_callback_token, encrypted_encoding_aes_key, callback_enabled || 0,
                     notify_key_hash || null, legacy_until || null]
                );
                return { id: result.lastID, code };
            } catch (err) {
                const msg = String(err && err.message || '');
                // 规范 §6.6：通知命名空间冲突（触发器）单独标识，不误报为身份冲突。
                // 随机 Code 冲突时由服务层重试，不得向用户返回 APP_IDENTITY_CONFLICT。
                if (msg.includes('NOTIFY_CODE_CONFLICT')) {
                    const e = new Error('notify code conflict');
                    e.__createCause = 'notify_code_conflict';
                    throw e;
                }
                // 唯一约束竞争失败（并发同身份或同 code）翻译为身份冲突。
                if (msg.includes('UNIQUE') || err && err.code === 'SQLITE_CONSTRAINT') {
                    const e = new Error('identity conflict');
                    e.__createCause = 'identity_conflict';
                    throw e;
                }
                throw err;
            }
        });
    }

    // 多应用（P0-04）：草稿回调更新的原子事务。
    //
    // 在事务内重新读取草稿 + 校验版本 + 更新回调凭证，version + 1。
    // 失败模式：
    //   - 应用不存在：{ __draftCause: 'missing' }
    //   - 已完成（非草稿）：{ __draftCause: 'already_completed' }
    //   - 版本不匹配：{ __draftCause: 'version_conflict' }
    // 成功返回 { code, version }。
    async updateDraftCallbackAtomic(code, fields, expectedVersion) {
        return this.withTransaction(async (tx) => {
            const row = await tx.get(
                'SELECT code, encrypted_corpsecret, agentid, touser, version FROM configurations WHERE code = ?',
                [code]
            );
            if (!row) {
                const e = new Error('missing');
                e.__draftCause = 'missing';
                throw e;
            }
            const hasSecret = typeof row.encrypted_corpsecret === 'string' && row.encrypted_corpsecret.length > 0;
            const agentOk = Number.isInteger(Number(row.agentid)) && Number(row.agentid) > 0;
            const touserOk = String(row.touser || '').split('|').filter(Boolean).length > 0;
            if (hasSecret && agentOk && touserOk) {
                const e = new Error('already completed');
                e.__draftCause = 'already_completed';
                throw e;
            }
            const currentVersion = Number(row.version) || 1;
            if (Number(expectedVersion) !== currentVersion) {
                const e = new Error('version conflict');
                e.__draftCause = 'version_conflict';
                e.__currentVersion = currentVersion;
                throw e;
            }
            const sets = [];
            const params = [];
            for (const [col, val] of Object.entries(fields)) {
                if (!UPDATE_FIELD_WHITELIST.has(col)) continue;
                sets.push(`${col} = ?`);
                params.push(val);
            }
            sets.push('version = version + 1');
            params.push(code, currentVersion);
            const sql = `UPDATE configurations SET ${sets.join(', ')} WHERE code = ? AND version = ?`;
            const result = await tx.run(sql, params);
            if (result.changes !== 1) {
                const e = new Error('version changed mid-transaction');
                e.__draftCause = 'version_conflict';
                throw e;
            }
            return { code, version: currentVersion + 1 };
        });
    }

    // 多应用（P0-05）：并发草稿创建的原子检查 + INSERT。
    // 在事务内检查同 corpid 的未完成草稿，无则 INSERT。
    // 失败模式：
    //   - 已有草稿：{ __draftCreateCause: 'exists', __existingCode }
    async createDraftCallbackAtomic(config) {
        const { code, corpid, encrypted_callback_token, encrypted_encoding_aes_key } = config;
        return this.withTransaction(async (tx) => {
            const existing = await tx.get(
                `SELECT code FROM configurations
                 WHERE corpid = ? AND agentid = 0 AND touser = ''
                   AND (encrypted_corpsecret = '' OR encrypted_corpsecret IS NULL)
                 ORDER BY id DESC LIMIT 1`,
                [corpid]
            );
            if (existing) {
                const e = new Error('draft exists');
                e.__draftCreateCause = 'exists';
                e.__existingCode = existing.code;
                throw e;
            }
            const result = await tx.run(
                `INSERT INTO configurations (
                    code, corpid, encrypted_callback_token, encrypted_encoding_aes_key, callback_enabled,
                    encrypted_corpsecret, agentid, touser, description
                ) VALUES (?, ?, ?, ?, 1, '', 0, '', '')`,
                [code, corpid, encrypted_callback_token, encrypted_encoding_aes_key]
            );
            return { id: result.lastID, code };
        });
    }

    // 轻量级就绪探测（SEC-007）：能成功执行即视为数据库可读。
    async ping() {
        await this.runRaw('SELECT 1', []);
    }

    get(sql, params) {
        return this.enqueueOperation(() => this._getDirect(sql, params));
    }

    // 关闭数据库连接。返回 Promise，便于优雅退出时 await。
    // close() 排到全局队列末尾，确保进行中的事务先完成，不与事务交错（P0-01）。
    // 仅在关闭成功后才置空句柄并 resolve；失败（如 SQLITE_BUSY）则 reject，
    // 上层可据此决定是否重试或记录，避免误报关闭成功。
    // 多次调用安全：成功关闭后 this.db 为 null，后续直接 resolve。
    close() {
        return this.enqueueOperation(() => new Promise((resolve, reject) => {
            if (!this.db) return resolve();
            const handle = this.db;
            handle.close((err) => {
                if (err) {
                    // 关闭失败时保留句柄，便于上层诊断或重试。
                    console.error('关闭数据库失败:', err.message);
                    reject(err);
                } else {
                    this.db = null;
                    resolve();
                }
            });
        }));
    }
}

module.exports = Database;
