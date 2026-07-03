// 企业微信API交互模块
// 封装与企业微信API的HTTP请求

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

class WeChatService {
    constructor(apiBase = 'https://qyapi.weixin.qq.com') {
        this.apiBase = apiBase;
        this.tokenCache = new Map(); // 缓存access_token
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
        try {
            // 检查缓存
            const cacheKey = `${corpid}_${corpsecret}`;
            const cached = this.tokenCache.get(cacheKey);
            
            if (cached && cached.expires > Date.now()) {
                console.log('使用缓存的access_token');
                return cached.token;
            }

            // 调用企业微信API获取token
            const response = await axios.get(`${this.apiBase}/cgi-bin/gettoken`, {
                params: {
                    corpid: corpid,
                    corpsecret: corpsecret
                }
            });

            const { data } = response;
            
            if (data.errcode !== 0) {
                throw new Error(`获取token失败: ${data.errmsg} (错误码: ${data.errcode})`);
            }

            // 缓存token (提前5分钟过期)
            const expiresIn = (data.expires_in || 7200) * 1000;
            this.tokenCache.set(cacheKey, {
                token: data.access_token,
                expires: Date.now() + expiresIn - 300000 // 提前5分钟过期
            });

            console.log('获取access_token成功');
            return data.access_token;
        } catch (error) {
            console.error('获取access_token失败:', error.message);
            throw error;
        }
    }

    // 上传临时素材
    async uploadMedia(accessToken, type, filePath) {
        try {
            const form = new FormData();
            form.append('media', fs.createReadStream(filePath));

            const response = await axios.post(
                `${this.apiBase}/cgi-bin/media/upload?access_token=${accessToken}&type=${type}`,
                form,
                {
                    headers: {
                        ...form.getHeaders()
                    }
                }
            );

            const { data } = response;
            
            if (data.errcode !== 0) {
                throw new Error(`上传素材失败: ${data.errmsg} (错误码: ${data.errcode})`);
            }

            console.log(`素材上传成功, media_id: ${data.media_id}`);
            return data;
        } catch (error) {
            console.error('上传素材失败:', error.message);
            throw error;
        }
    }

    // 上传图片素材（用于图文消息中的图片）
    async uploadImage(accessToken, filePath) {
        try {
            const form = new FormData();
            form.append('media', fs.createReadStream(filePath));

            const response = await axios.post(
                `${this.apiBase}/cgi-bin/media/uploadimg?access_token=${accessToken}`,
                form,
                {
                    headers: {
                        ...form.getHeaders()
                    }
                }
            );

            const { data } = response;
            
            if (data.errcode !== 0) {
                throw new Error(`上传图片失败: ${data.errmsg} (错误码: ${data.errcode})`);
            }

            console.log(`图片上传成功, url: ${data.url}`);
            return data;
        } catch (error) {
            console.error('上传图片失败:', error.message);
            throw error;
        }
    }

    // 发送文本消息
    async sendTextMessage(accessToken, agentid, touser, content, safe = 0) {
        try {
            const messageBody = {
                ...this.buildRecipientFields(touser),
                msgtype: 'text',
                agentid: agentid,
                text: {
                    content: content
                },
                safe: safe
            };

            const response = await axios.post(
                `${this.apiBase}/cgi-bin/message/send?access_token=${accessToken}`,
                messageBody
            );

            const { data } = response;
            
            if (data.errcode !== 0) {
                throw new Error(`发送文本消息失败: ${data.errmsg} (错误码: ${data.errcode})`);
            }

            console.log('文本消息发送成功');
            return data;
        } catch (error) {
            console.error('发送文本消息失败:', error.message);
            throw error;
        }
    }

    // 发送Markdown消息
    async sendMarkdownMessage(accessToken, agentid, touser, content, safe = 0) {
        try {
            const messageBody = {
                ...this.buildRecipientFields(touser),
                msgtype: 'markdown',
                agentid: agentid,
                markdown: {
                    content: content
                },
                safe: safe
            };

            const response = await axios.post(
                `${this.apiBase}/cgi-bin/message/send?access_token=${accessToken}`,
                messageBody
            );

            const { data } = response;
            
            if (data.errcode !== 0) {
                throw new Error(`发送Markdown消息失败: ${data.errmsg} (错误码: ${data.errcode})`);
            }

            console.log('Markdown消息发送成功');
            return data;
        } catch (error) {
            console.error('发送Markdown消息失败:', error.message);
            throw error;
        }
    }

    // 发送图片消息
    async sendImageMessage(accessToken, agentid, touser, mediaId, safe = 0) {
        try {
            const messageBody = {
                ...this.buildRecipientFields(touser),
                msgtype: 'image',
                agentid: agentid,
                image: {
                    media_id: mediaId
                },
                safe: safe
            };

            const response = await axios.post(
                `${this.apiBase}/cgi-bin/message/send?access_token=${accessToken}`,
                messageBody
            );

            const { data } = response;
            
            if (data.errcode !== 0) {
                throw new Error(`发送图片消息失败: ${data.errmsg} (错误码: ${data.errcode})`);
            }

            console.log('图片消息发送成功');
            return data;
        } catch (error) {
            console.error('发送图片消息失败:', error.message);
            throw error;
        }
    }

    // 发送文件消息
    async sendFileMessage(accessToken, agentid, touser, mediaId, safe = 0) {
        try {
            const messageBody = {
                ...this.buildRecipientFields(touser),
                msgtype: 'file',
                agentid: agentid,
                file: {
                    media_id: mediaId
                },
                safe: safe
            };

            const response = await axios.post(
                `${this.apiBase}/cgi-bin/message/send?access_token=${accessToken}`,
                messageBody
            );

            const { data } = response;
            
            if (data.errcode !== 0) {
                throw new Error(`发送文件消息失败: ${data.errmsg} (错误码: ${data.errcode})`);
            }

            console.log('文件消息发送成功');
            return data;
        } catch (error) {
            console.error('发送文件消息失败:', error.message);
            throw error;
        }
    }

    // 发送文本卡片消息
    async sendTextCardMessage(accessToken, agentid, touser, title, description, url, btntxt = '详情', safe = 0) {
        try {
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

            const response = await axios.post(
                `${this.apiBase}/cgi-bin/message/send?access_token=${accessToken}`,
                messageBody
            );

            const { data } = response;
            
            if (data.errcode !== 0) {
                throw new Error(`发送文本卡片消息失败: ${data.errmsg} (错误码: ${data.errcode})`);
            }

            console.log('文本卡片消息发送成功');
            return data;
        } catch (error) {
            console.error('发送文本卡片消息失败:', error.message);
            throw error;
        }
    }

    // 发送图文消息
    async sendNewsMessage(accessToken, agentid, touser, articles, safe = 0) {
        try {
            const messageBody = {
                ...this.buildRecipientFields(touser),
                msgtype: 'news',
                agentid: agentid,
                news: {
                    articles: articles
                },
                safe: safe
            };

            const response = await axios.post(
                `${this.apiBase}/cgi-bin/message/send?access_token=${accessToken}`,
                messageBody
            );

            const { data } = response;
            
            if (data.errcode !== 0) {
                throw new Error(`发送图文消息失败: ${data.errmsg} (错误码: ${data.errcode})`);
            }

            console.log('图文消息发送成功');
            return data;
        } catch (error) {
            console.error('发送图文消息失败:', error.message);
            throw error;
        }
    }

    // 发送应用消息（兼容旧接口）
    async sendMessage(accessToken, agentid, touser, message) {
        return this.sendTextMessage(accessToken, agentid, touser, message);
    }

    // 获取部门列表
    async getDepartmentList(accessToken) {
        try {
            const response = await axios.get(`${this.apiBase}/cgi-bin/department/list`, {
                params: {
                    access_token: accessToken
                }
            });

            const { data } = response;
            
            if (data.errcode !== 0) {
                throw new Error(`获取部门列表失败: ${data.errmsg} (错误码: ${data.errcode})`);
            }

            return data.department || [];
        } catch (error) {
            console.error('获取部门列表失败:', error.message);
            throw error;
        }
    }

    // 获取应用详情，用于校验 AgentID 与当前应用凭证是否匹配
    async getAgentInfo(accessToken, agentid) {
        try {
            const response = await axios.get(`${this.apiBase}/cgi-bin/agent/get`, {
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
        } catch (error) {
            console.error('获取应用详情失败:', error.message);
            throw error;
        }
    }

    addUniqueUser(usersMap, user) {
        const userid = String(user && user.userid || '').trim();
        if (!userid || usersMap.has(userid)) return;

        usersMap.set(userid, {
            userid,
            name: user.name || userid
        });
    }

    // 根据应用可见范围获取成员，避免只查根部门导致成员为空
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
        try {
            const response = await axios.get(`${this.apiBase}/cgi-bin/tag/get`, {
                params: {
                    access_token: accessToken,
                    tagid: tagId
                }
            });

            const { data } = response;

            if (data.errcode !== 0) {
                throw new Error(`获取标签成员失败: ${data.errmsg} (错误码: ${data.errcode})`);
            }

            return data.userlist || [];
        } catch (error) {
            console.error('获取标签成员失败:', error.message);
            throw error;
        }
    }

    // 获取部门成员
    async getUserList(accessToken, departmentId = 1) {
        try {
            const response = await axios.get(`${this.apiBase}/cgi-bin/user/list`, {
                params: {
                    access_token: accessToken,
                    department_id: departmentId
                }
            });

            const { data } = response;
            
            if (data.errcode !== 0) {
                throw new Error(`获取成员列表失败: ${data.errmsg} (错误码: ${data.errcode})`);
            }

            return data.userlist || [];
        } catch (error) {
            console.error('获取成员列表失败:', error.message);
            throw error;
        }
    }

    // 获取部门成员简要列表
    async getDepartmentUsers(accessToken, departmentId = 1) {
        try {
            const response = await axios.get(`${this.apiBase}/cgi-bin/user/simplelist`, {
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
        } catch (error) {
            console.error('获取部门成员失败:', error.message);
            throw error;
        }
    }

    // 获取所有成员（遍历所有部门）
    async getAllUsers(accessToken) {
        try {
            const departments = await this.getDepartmentList(accessToken);
            const allUsers = [];
            const userSet = new Set(); // 用于去重

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
        } catch (error) {
            console.error('获取所有成员失败:', error.message);
            throw error;
        }
    }
}

module.exports = WeChatService;
