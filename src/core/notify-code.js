// 通知编号规范模块（规范 §4.1 / §7.1）
//
// 集中处理规则 API 编号的语法校验与规范化，避免规则名称、接收人等无关逻辑混入。
// 对外仅导出三个职责单一的函数；错误采用稳定业务码 RULE_API_CODE_INVALID，
// 供路由层 sendError() 序列化为响应 code 字段，前端按 code 分支。
//
// 不变量：编号比较采用 ASCII 不区分大小写语义；新规则编号一律保存为小写。
// api_code 是路由标识，不是安全凭证（规范 §3.2.10）。

const crypto = require('crypto');

const MIN_LENGTH = 3;
const MAX_LENGTH = 64;
// 首尾为字母或数字，中间允许小写字母、数字、连字符、下划线。
const API_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$/;
// 允许字符说明（用于错误 details）。
const ALLOWED_DESC = '小写字母 a-z、数字 0-9、连字符 -、下划线 _';

// 构造 RULE_API_CODE_INVALID 错误（与 services/notifier.createError 形状一致）。
function invalidError(reason) {
    const error = new Error('API 编号格式不合法');
    error.statusCode = 400;
    error.businessCode = 'RULE_API_CODE_INVALID';
    error.details = {
        field: 'api_code',
        min_length: MIN_LENGTH,
        max_length: MAX_LENGTH,
        allowed: ALLOWED_DESC,
        reason: reason || 'invalid'
    };
    return error;
}

// 纯布尔判定：供单测和内部使用，不抛错。
// null/undefined/对象/数组等非字符串一律视为非法；不产生 [object Object]。
function isValidRuleApiCode(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'object') return false; // 含数组和普通对象
    const normalized = String(value).trim().toLowerCase();
    if (normalized.length < MIN_LENGTH || normalized.length > MAX_LENGTH) return false;
    return API_CODE_PATTERN.test(normalized);
}

// 规范化：非空值 -> 小写规范化字符串；非法 -> 抛 RULE_API_CODE_INVALID。
// 注意：本函数假定调用方已判定“非空”，空值（空串/纯空白）的语义由上层解释
// （创建场景=自动生成，编辑场景=显式空值报错）。
function normalizeRuleApiCode(value) {
    // 与 isValid 保持一致的输入防御，避免 [object Object] 进入比较。
    if (value === null || value === undefined || typeof value === 'object') {
        throw invalidError('not_string');
    }
    const normalized = String(value).trim().toLowerCase();
    if (normalized === '') {
        // 空白串：上层应在调用前区分语义；此处统一视为格式非法。
        throw invalidError('empty');
    }
    if (normalized.length < MIN_LENGTH) {
        throw invalidError('too_short');
    }
    if (normalized.length > MAX_LENGTH) {
        throw invalidError('too_long');
    }
    if (!API_CODE_PATTERN.test(normalized)) {
        throw invalidError('pattern');
    }
    return normalized;
}

// 生成随机编号：当前仍返回 crypto.randomUUID()。
// 随机生成发生冲突时的重试由调用方（createRule/regenerateRuleApiCode）负责。
function generateNotifyCode() {
    return crypto.randomUUID();
}

module.exports = {
    normalizeRuleApiCode,
    isValidRuleApiCode,
    generateNotifyCode,
    // 常量导出供需要前置判定的调用方/测试使用。
    MIN_LENGTH,
    MAX_LENGTH,
    API_CODE_PATTERN
};
