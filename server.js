// 企业微信通知转发服务 - 主入口文件
// 作者: AI Assistant
// 创建时间: 2025-01-05

require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('express').json;
const routes = require('./src/api/routes');
const auth = require('./src/core/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 为回调接口使用原始文本解析器
app.use('/api/callback', express.raw({ type: 'text/xml' }));
app.use('/api/callback', express.raw({ type: 'application/xml' }));
app.use('/api/callback', express.raw({ type: 'text/plain' }));

// 解析JSON请求体（其他接口）
app.use(bodyParser());

// 静态资源服务
app.use('/public', express.static(path.join(__dirname, 'public')));

// 登录页面（未登录时重定向）
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/login.html'));
});

// 登录状态验证
app.get('/api/auth-status', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    const isLoggedIn = auth.verifyToken(token);
    res.json({ 
        loggedIn: isLoggedIn, 
        configured: auth.isConfigured() 
    });
});

// 登录
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    const result = auth.login(username, password);
    if (result.success) {
        res.json({ success: true, token: result.token });
    } else {
        res.status(401).json({ error: result.error });
    }
});

// 登出
app.post('/api/logout', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.body.token;
    auth.logout(token);
    res.json({ success: true });
});

// 认证中间件
const requireAuth = (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (!auth.verifyToken(token)) {
        return res.status(401).json({ error: '未登录或登录已过期' });
    }
    next();
};

// 挂载认证中间件到 req
app.use((req, res, next) => {
    req.requireAuth = requireAuth;
    next();
});

// 路由
app.use('/', routes);

// 404处理
app.use((req, res) => {
    res.status(404).json({ error: '未找到资源' });
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`企业微信通知服务已启动，端口: ${PORT}`);
}); 
