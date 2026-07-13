// 企业微信API交互模块
// 封装与企业微信API的HTTP请求
//
// SEC-008 整改：
// - 统一 axios 实例，配置连接/响应超时、最大响应体、禁止重定向。
// - apiBase 由 config 注入并校验（生产仅允许 HTTPS / 可信主机）。
// - access_token 失效（40014/42001）时清缓存并仅重试一次。
// - 缓存键不再包含完整 corpsecret，改用其哈希，降低内存敏感面。

const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');
const fs = require('fs');

const DEFAULT_API_BASE = 'https://qyapi.weixin.qq.com';
// access_token 失效相关错误码
const TOKEN_INVALID_CODES = new Set([40014, 42001, 40001]);

function hashSecret(secret) {
    return crypto.createHash('sha256').update(String(secret || '')).digest('hex').slice(0, 16);
}

// SEC-008：生产环境严格校验 apiBase。
function validateApiBase(apiBase, nodeEnv) {
    if (!apiBase || typeof apiBase !== 'string') {
        throw new Error('WECHAT_API_BASE 未配置');
    }
    let parsed;
    try {
        parsed = new URL(apiBase);
    } catch (err) {
        throw new Error(`WECHAT_API_BASE 无效: ${apiBase}`);
    }
    if (nodeEnv === 'production') {
        if (parsed.protocol !== 'https:') {
            throw new Error('生产环境 WECHAT_API_BASE 必须使用 HTTPS');
        }
        // 仅允许默认官方域名；如需自建网关，可在非生产环境配置。
        const host = parsed.hostname;
        if (host !== 'qyapi.weixin.qq.com' && process.env.WECHAT_ALLOW_CUSTOM_API_BASE !== '1') {
            throw new Error(`生产环境不允许非官方 API 主机: ${host}（如确需自建网关，设置 WECHAT_ALLOW_CUSTOM_API_BASE=1）`);
        }
    }
    return apiBase.replace(/\/+$/, '');
}

class WeChatService {
    constructor(apiBase) {
        // 兼容旧调用：未传 apiBase 时回退到官方地址或环境变量。
        const nodeEnv = process.env.NODE_ENV || 'development';
        const rawBase = apiBase || process.env.WECHAT_API_BASE || DEFAULT_API_BASE;
        // 测试场景下构造可能失败；保持向后兼容——无效时退回默认，运行期再暴露错误。
        try {
            this.apiBase = validateApiBase(rawBase, nodeEnv);
        } catch (err) {
            if (nodeEnv === 'production') throw err;
            this.apiBase = rawBase.replace(/\/+$/, '');
        }
        this.tokenCache = new Map(); // 缓存 access_token
        this.axios = axios.create({
            timeout: Number(process.env.WECHAT_HTTP_TIMEOUT_MS || 10000),
            maxContentLength: Number(process.env.WECHAT_MAX_RESPONSE_BYTES || 5 * 1024 * 1024),
            maxBodyLength: Number(process.env.WECHAT_MAX_REQUEST_BYTES || 5 * 1024 * 1024),
            maxRedirects: 0,
            // 不自动转发 axios 默认 header
            headers: { 'User-Agent': 'qywx-notifier-plus' }
        });
    }

    formatRecipientField(value) {
        const values = Array.isArray(value) ? value : [value];
        const seen = new Set();

        return values
            .flatMap(item => String(item || '').split(/[|,，;；\s]+/))
            .map(item => item.trim())
            .filter(item => {
                if (!item || seen.has(item)) return false;
                seen.add(item);
                return true;
            })
            .join('|');
    }

    buildRecipientFields(recipient) {
        if (recipient && typeof recipient === 'object' && !Array.isArray(recipient)) {
            if (recipient.is_all || recipient.isAll) {
                return { touser: '@all' };
            }

            const fields = {};
            const touser = this.formatRecipientField(recipient.touser);
            const toparty = this.formatRecipientField(recipient.toparty);
            const totag = this.formatRecipientField(recipient.totag);

            if (touser) fields.touser = touser;
            if (toparty) fields.toparty = toparty;
            if (totag) fields.totag = totag;
            return fields;
        }

        return {
            touser: this.formatRecipientField(recipient)
        };
    }

    // 获取访问凭证
    async getToken(corpid, corpsecret) {
        const cacheKey = `${corpid}_${hashSecret(corpsecret)}`;
        const cached = this.tokenCache.get(cacheKey);

        if (cached && cached.expires > Date.now()) {
            return cached.token;
        }

        const response = await this.axios.get(`${this.apiBase}/cgi-bin/gettoken`, {
            params: {
                corpid: corpid,
                corpsecret: corpsecret
            }
        });

        const { data } = response;

        if (data.errcode !== 0) {
            throw new Error(`获取token失败: ${data.errmsg} (错误码: ${data.errcode})`);
        }

        const expiresIn = (data.expires_in || 7200) * 1000;
        this.tokenCache.set(cacheKey, {
            token: data.access_token,
            expires: Date.now() + expiresIn - 300000 // 提前5分钟过期
        });

        return data.access_token;
    }

    invalidateToken(corpid, corpsecret) {
        this.tokenCache.delete(`${corpid}_${hashSecret(corpsecret)}`);
    }

    // SEC-008：access_token 失效时清缓存并仅重试一次（仅对幂等/读取类调用）。
    async withTokenRetry(corpid, corpsecret, requestFn) {
        try {
            return await requestFn(await this.getToken(corpid, corpsecret));
        } catch (err) {
            if (isTokenInvalidError(err) || hasInvalidTokenResponse(err)) {
                this.invalidateToken(corpid, corpsecret);
                return await requestFn(await this.getToken(corpid, corpsecret));
            }
            throw err;
        }
    }

    // 上传临时素材
    async uploadMedia(accessToken, type, filePath) {
        const form = new FormData();
        form.append('media', fs.createReadStream(filePath));

        const response = await this.axios.post(
            `${this.apiBase}/cgi-bin/media/upload?access_token=${accessToken}&type=${type}`,
            form,
            { headers: { ...form.getHeaders() } }
        );

        const { data } = response;
        if (data.errcode !== 0 && data.errcode !== undefined) {
            throw new Error(`上传素材失败: ${data.errmsg} (错误码: ${data.errcode})`);
        }
        return data;
    }

    // 上传图片素材
    async uploadImage(accessToken, filePath) {
        const form = new FormData();
        form.append('media', fs.createReadStream(filePath));

        const response = await this.axios.post(
            `${this.apiBase}/cgi-bin/media/uploadimg?access_token=${accessToken}`,
            form,
            { headers: { ...form.getHeaders() } }
        );

        const { data } = response;
        if (data.errcode !== 0 && data.errcode !== undefined) {
            throw new Error(`上传图片失败: ${data.errmsg} (错误码: ${data.errcode})`);
        }
        return data;
    }

    // 发送文本消息
    async sendTextMessage(accessToken, agentid, touser, content, safe = 0) {
        const messageBody = {
            ...this.buildRecipientFields(touser),
            msgtype: 'text',
            agentid: agentid,
            text: { content },
            safe: safe
        };
        const { data } = await this.axios.post(
            `${this.apiBase}/cgi-bin/message/send?access_token=${accessToken}`,
            messageBody
        );
        if (data.errcode !== 0) {
            throw new Error(`发送文本消息失败: ${data.errmsg} (错误码: ${data.errcode})`);
        }
        return data;
    }

    // 发送Markdown消息
    async sendMarkdownMessage(accessToken, agentid, touser, content, safe = 0) {
        const messageBody = {
            ...this.buildRecipientFields(touser),
            msgtype: 'markdown',
            agentid: agentid,
            markdown: { content },
            safe: safe
        };
        const { data } = await this.axios.post(
            `${this.apiBase}/cgi-bin/message/send?access_token=${accessToken}`,
            messageBody
        );
        if (data.errcode !== 0) {
            throw new Error(`发送Markdown消息失败: ${data.errmsg} (错误码: ${data.errcode})`);
        }
        return data;
    }

    // 发送图片消息
    async sendImageMessage(accessToken, agentid, touser, mediaId, safe = 0) {
        const messageBody = {
            ...this.buildRecipientFields(touser),
            msgtype: 'image',
            agentid: agentid,
            image: { media_id: mediaId },
            safe: safe
        };
        const { data } = await this.axios.post(
            `${this.apiBase}/cgi-bin/message/send?access_token=${accessToken}`,
            messageBody
        );
        if (data.errcode !== 0) {
            throw new Error(`发送图片消息失败: ${data.errmsg} (错误码: ${data.errcode})`);
        }
        return data;
    }

    // 发送文件消息
    async sendFileMessage(accessToken, agentid, touser, mediaId, safe = 0) {
        const messageBody = {
            ...this.buildRecipientFields(touser),
            msgtype: 'file',
            agentid: agentid,
            file: { media_id: mediaId },
            safe: safe
        };
        const { data } = await this.axios.post(
            `${this.apiBase}/cgi-bin/message/send?access_token=${accessToken}`,
            messageBody
        );
        if (data.errcode !== 0) {
            throw new Error(`发送文件消息失败: ${data.errmsg} (错误码: ${data.errcode})`);
        }
        return data;
    }

    // 发送文本卡片消息
    async sendTextCardMessage(accessToken, agentid, touser, title, description, url, btntxt = '详情', safe = 0) {
        const messageBody = {
            ...this.buildRecipientFields(touser),
            msgtype: 'textcard',
            agentid: agentid,
            textcard: {
                title: title,
                description: description,
                url: url,
                btntxt: btntxt
            },
            safe: safe
        };
        const { data } = await this.axios.post(
            `${this.apiBase}/cgi-bin/message/send?access_token=${accessToken}`,
            messageBody
        );
        if (data.errcode !== 0) {
            throw new Error(`发送文本卡片消息失败: ${data.errmsg} (错误码: ${data.errcode})`);
        }
        return data;
    }

    // 发送图文消息
    async sendNewsMessage(accessToken, agentid, touser, articles, safe = 0) {
        const messageBody = {
            ...this.buildRecipientFields(touser),
            msgtype: 'news',
            agentid: agentid,
            news: { articles: articles },
            safe: safe
        };
        const { data } = await this.axios.post(
            `${this.apiBase}/cgi-bin/message/send?access_token=${accessToken}`,
            messageBody
        );
        if (data.errcode !== 0) {
            throw new Error(`发送图文消息失败: ${data.errmsg} (错误码: ${data.errcode})`);
        }
        return data;
    }

    // 发送应用消息（兼容旧接口）
    async sendMessage(accessToken, agentid, touser, message) {
        return this.sendTextMessage(accessToken, agentid, touser, message);
    }

    // 获取部门列表
    async getDepartmentList(accessToken) {
        const response = await this.axios.get(`${this.apiBase}/cgi-bin/department/list`, {
            params: { access_token: accessToken }
        });
        const { data } = response;
        if (data.errcode !== 0) {
            throw new Error(`获取部门列表失败: ${data.errmsg} (错误码: ${data.errcode})`);
        }
        return data.department || [];
    }

    // 获取应用详情
    async getAgentInfo(accessToken, agentid) {
        const response = await this.axios.get(`${this.apiBase}/cgi-bin/agent/get`, {
            params: {
                access_token: accessToken,
                agentid: Number(agentid)
            }
        });
        const { data } = response;
        if (data.errcode !== 0) {
            throw new Error(`获取应用详情失败: ${data.errmsg} (错误码: ${data.errcode})`);
        }
        return data;
    }

    addUniqueUser(usersMap, user) {
        const userid = String(user && user.userid || '').trim();
        if (!userid || usersMap.has(userid)) return;
        usersMap.set(userid, { userid, name: user.name || userid });
    }

    async getAgentVisibleUsers(accessToken, agentInfo) {
        const usersMap = new Map();
        const directUsers = agentInfo?.allow_userinfos?.user || [];
        const partyIds = agentInfo?.allow_partys?.partyid || [];
        const tagIds = agentInfo?.allow_tags?.tagid || [];
        const hasVisibleScope = directUsers.length > 0 || partyIds.length > 0 || tagIds.length > 0;

        directUsers.forEach(user => this.addUniqueUser(usersMap, user));

        for (const departmentId of partyIds) {
            const departmentUsers = await this.getDepartmentUsers(accessToken, departmentId);
            departmentUsers.forEach(user => this.addUniqueUser(usersMap, user));
        }

        for (const tagId of tagIds) {
            const tagUsers = await this.getTagUsers(accessToken, tagId);
            tagUsers.forEach(user => this.addUniqueUser(usersMap, user));
        }

        if (!hasVisibleScope) {
            const users = await this.getDepartmentUsers(accessToken);
            users.forEach(user => this.addUniqueUser(usersMap, user));
        }

        return Array.from(usersMap.values());
    }

    // 获取标签成员
    async getTagUsers(accessToken, tagId) {
        const response = await this.axios.get(`${this.apiBase}/cgi-bin/tag/get`, {
            params: { access_token: accessToken, tagid: tagId }
        });
        const { data } = response;
        if (data.errcode !== 0) {
            throw new Error(`获取标签成员失败: ${data.errmsg} (错误码: ${data.errcode})`);
        }
        return data.userlist || [];
    }

    // 获取成员列表
    async getUserList(accessToken, departmentId = 1) {
        const response = await this.axios.get(`${this.apiBase}/cgi-bin/user/list`, {
            params: { access_token: accessToken, department_id: departmentId }
        });
        const { data } = response;
        if (data.errcode !== 0) {
            throw new Error(`获取成员列表失败: ${data.errmsg} (错误码: ${data.errcode})`);
        }
        return data.userlist || [];
    }

    // 获取部门成员简要列表
    async getDepartmentUsers(accessToken, departmentId = 1) {
        const response = await this.axios.get(`${this.apiBase}/cgi-bin/user/simplelist`, {
            params: {
                access_token: accessToken,
                department_id: departmentId,
                fetch_child: 1
            }
        });
        const { data } = response;
        if (data.errcode !== 0) {
            throw new Error(`获取成员列表失败: ${data.errmsg} (错误码: ${data.errcode})`);
        }
        return data.userlist || [];
    }

    // 获取所有成员（遍历所有部门）
    async getAllUsers(accessToken) {
        const departments = await this.getDepartmentList(accessToken);
        const allUsers = [];
        const userSet = new Set();

        for (const dept of departments) {
            const users = await this.getUserList(accessToken, dept.id);
            users.forEach(user => {
                if (!userSet.has(user.userid)) {
                    userSet.add(user.userid);
                    allUsers.push({
                        userid: user.userid,
                        name: user.name,
                        department: dept.name
                    });
                }
            });
        }

        return allUsers;
    }
}

function isTokenInvalidError(err) {
    const msg = (err && err.message) || '';
    return TOKEN_INVALID_CODES.size > 0 && Array.from(TOKEN_INVALID_CODES).some(code => msg.includes(`错误码: ${code}`));
}

function hasInvalidTokenResponse(err) {
    const data = err && err.response && err.response.data;
    return data && TOKEN_INVALID_CODES.has(data.errcode);
}

module.exports = WeChatService;
