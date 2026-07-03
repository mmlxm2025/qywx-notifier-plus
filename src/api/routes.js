// Express路由定义
// 包含所有API端点的路由配置

const express = require('express');
const path = require('path');
const notifier = require('../services/notifier');
const WeChatService = require('../core/wechat');
const CryptoService = require('../core/crypto');
const auth = require('../core/auth');

const router = express.Router();

// 环境变量
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-key-for-development-only';
const wechat = new WeChatService();
const crypto = new CryptoService(ENCRYPTION_KEY);

// 认证中间件
const requireAuth = (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (!auth.verifyToken(token)) {
        return res.status(401).json({ error: '未登录或登录已过期' });
    }
    next();
};

function getConfigurationUsersStatus(err) {
    if (err.statusCode) return err.statusCode;

    const message = err.message || '';
    if (message.includes('\u672a\u627e\u5230\u914d\u7f6e')) return 404;
    if (message.includes('\u914d\u7f6e\u5c1a\u672a\u5b8c\u6210')) return 400;
    if (message.includes('\u83b7\u53d6\u6210\u5458\u5217\u8868\u5931\u8d25')) return 400;
    if (message.includes('\u83b7\u53d6token\u5931\u8d25')) return 400;
    return 500;
}

function getUpdateConfigurationStatus(err) {
    if (err.statusCode) return err.statusCode;

    const message = err.message || '';
    if (message.includes('\u672a\u627e\u5230\u914d\u7f6e')) return 404;
    if (message.includes('\u8bf7\u81f3\u5c11\u9009\u62e9\u4e00\u4e2a\u6210\u5458')) return 400;
    if (message.includes('\u914d\u7f6e\u5df2\u5b58\u5728')) return 409;
    return 500;
}

function getRuleStatus(err) {
    if (err.statusCode) return err.statusCode;

    const message = err.message || '';
    if (message.includes('\u672a\u627e\u5230\u914d\u7f6e') || message.includes('\u672a\u627e\u5230\u89c4\u5219')) return 404;
    if (message.includes('\u63a5\u6536\u8303\u56f4') || message.includes('\u89c4\u5219\u540d\u79f0')) return 400;
    return 500;
}

// 1. GET / 返回前端页面
router.get('/', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (!auth.verifyToken(token)) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, '../../public/index.html'));
});

router.get('/rules', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/rules.html'));
});

router.get('/api-docs.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/api-docs.html'));
});

// 2. POST /api/validate 验证凭证并获取成员列表
router.post('/api/validate', requireAuth, async (req, res) => {
    const { corpid, corpsecret, agentid } = req.body;
    const numericAgentid = Number(agentid);
    if (!corpid || !corpsecret || !Number.isInteger(numericAgentid) || numericAgentid <= 0) {
        return res.status(400).json({ error: '参数不完整，请填写CorpID、CorpSecret和AgentID' });
    }
    try {
        const accessToken = await wechat.getToken(corpid, corpsecret);
        const agentInfo = await wechat.getAgentInfo(accessToken, numericAgentid);
        const users = await wechat.getAgentVisibleUsers(accessToken, agentInfo);
        res.json({ agentid: numericAgentid, users });
    } catch (err) {
        res.status(400).json({ error: err.message || '凭证无效或API请求失败' });
    }
});

// 2.1 POST /api/generate-callback 生成回调URL
router.post('/api/generate-callback', requireAuth, async (req, res) => {
    const { corpid, callback_token, encoding_aes_key } = req.body;
    if (!corpid || !callback_token || !encoding_aes_key) {
        return res.status(400).json({ error: '回调配置参数不完整' });
    }
    if (encoding_aes_key.length !== 43) {
        return res.status(400).json({ error: 'EncodingAESKey必须是43位字符' });
    }
    try {
        // 生成回调配置（不需要成员列表）
        const result = await notifier.createCallbackConfiguration({
            corpid,
            callback_token,
            encoding_aes_key
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message || '生成回调URL失败' });
    }
});

// 3. POST /api/complete-config 完善配置（第二步）
router.post('/api/complete-config', requireAuth, async (req, res) => {
    try {
        const { code, corpsecret, agentid, touser, description } = req.body;
        const result = await notifier.completeConfiguration({ code, corpsecret, agentid, touser, description });
        res.status(201).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message || '完善配置失败' });
    }
});

// 3.1 POST /api/configure 保存配置并生成唯一code（保持兼容性）
router.post('/api/configure', requireAuth, async (req, res) => {
    try {
        const { corpid, corpsecret, agentid, touser, description } = req.body;
        const result = await notifier.createConfiguration({ corpid, corpsecret, agentid, touser, description });
        res.status(201).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message || '配置保存失败' });
    }
});

// 4. POST /api/notify/:code 发送通知
router.post('/api/notify/:code', async (req, res) => {
    const { code } = req.params;
    const { 
        title, 
        content, 
        msgType = 'text',
        mediaId,
        url,
        btntxt,
        articles,
        safe = 0
    } = req.body;

    if (!content && msgType !== 'image' && msgType !== 'file' && msgType !== 'news') {
        return res.status(400).json({ error: '消息内容不能为空' });
    }

    try {
        const options = { msgType, mediaId, url, btntxt, articles, safe, force: req.body.force === true };
        const result = await notifier.sendNotification(code, title, content, options);
        res.json({ message: '发送成功', response: result });
    } catch (err) {
        const status = err.statusCode || ((err.message || '').includes('未找到配置') ? 404 : 500);
        res.status(status).json({ error: err.message || '消息发送失败' });
    }
});

// 5. GET /api/configuration/:code 获取配置信息
router.get('/api/configuration/:code/users', requireAuth, async (req, res) => {
    const { code } = req.params;
    try {
        const result = await notifier.getConfigMembers(code, { refresh: req.query.refresh === '1' });
        res.json(result);
    } catch (err) {
        res.status(getConfigurationUsersStatus(err)).json({ error: err.message || '获取成员列表失败' });
    }
});

router.get('/api/configurations', requireAuth, async (req, res) => {
    try {
        const result = await notifier.listConfigurations();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message || '获取配置列表失败' });
    }
});

router.get('/api/configuration/:code/rules', requireAuth, async (req, res) => {
    const { code } = req.params;
    try {
        const result = await notifier.listRules(code);
        res.json(result);
    } catch (err) {
        res.status(getRuleStatus(err)).json({ error: err.message || '获取规则失败' });
    }
});

router.post('/api/configuration/:code/rules', requireAuth, async (req, res) => {
    const { code } = req.params;
    try {
        const result = await notifier.createRule(code, req.body);
        res.status(201).json(result);
    } catch (err) {
        res.status(getRuleStatus(err)).json({ error: err.message || '创建规则失败' });
    }
});

router.put('/api/rules/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await notifier.updateRule(id, req.body);
        res.json(result);
    } catch (err) {
        res.status(getRuleStatus(err)).json({ error: err.message || '更新规则失败' });
    }
});

router.delete('/api/rules/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await notifier.deleteRule(id);
        res.json(result);
    } catch (err) {
        res.status(getRuleStatus(err)).json({ error: err.message || '删除规则失败' });
    }
});

router.post('/api/rules/:id/regenerate', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await notifier.regenerateRuleApiCode(id);
        res.json(result);
    } catch (err) {
        res.status(getRuleStatus(err)).json({ error: err.message || '重新生成API失败' });
    }
});

router.get('/api/configuration/:code', requireAuth, async (req, res) => {
    const { code } = req.params;
    try {
        const config = await notifier.getConfiguration(code);
        if (!config) {
            return res.status(404).json({ error: '未找到配置' });
        }
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: err.message || '获取配置失败' });
    }
});

// 6. PUT /api/configuration/:code 更新配置
router.put('/api/configuration/:code', requireAuth, async (req, res) => {
    const { code } = req.params;
    try {
        const result = await notifier.updateConfiguration(code, req.body);
        res.json(result);
    } catch (err) {
        res.status(getUpdateConfigurationStatus(err)).json({ error: err.message || '更新配置失败' });
    }
});

// 7. GET /api/callback/:code 企业微信回调验证
router.get('/api/callback/:code', async (req, res) => {
    const { code } = req.params;
    const { msg_signature, timestamp, nonce, echostr } = req.query;

    if (!msg_signature || !timestamp || !nonce || !echostr) {
        return res.status(400).json({ error: '缺少必要的验证参数' });
    }

    try {
        const result = await notifier.handleCallbackVerification(code, msg_signature, timestamp, nonce, echostr);
        if (result.success) {
            res.send(result.data);
        } else {
            console.error('回调验证失败:', result.error);
            res.status(400).send('failed');
        }
    } catch (err) {
        console.error('回调验证异常:', err.message);
        res.status(500).send('failed');
    }
});

// 8. POST /api/callback/:code 企业微信回调消息接收
router.post('/api/callback/:code', async (req, res) => {
    const { code } = req.params;
    const { msg_signature, timestamp, nonce } = req.query;

    if (!msg_signature || !timestamp || !nonce) {
        return res.status(400).json({ error: '缺少必要的验证参数' });
    }

    try {
        // 获取加密的消息数据（从原始body转换为字符串）
        const encryptedData = req.body ? req.body.toString('utf8') : '';
        if (!encryptedData) {
            return res.status(400).json({ error: '消息数据为空' });
        }

        const result = await notifier.handleCallbackMessage(code, encryptedData, msg_signature, timestamp, nonce);
        if (result.success) {
            console.log('回调消息处理成功:', result.message);
            res.send('ok');
        } else {
            console.error('回调消息处理失败:', result.error);
            res.status(400).send('failed');
        }
    } catch (err) {
        console.error('回调消息处理异常:', err.message);
        res.status(500).send('failed');
    }
});

module.exports = router;
