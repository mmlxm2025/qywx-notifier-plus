/*
 * 多应用管理（2026-07-04 §7.5）：统一 Toast 组件。
 *
 * 设计：
 *   - 全局单例容器，aria-live="polite"，屏幕阅读器可读（§7.5 可访问性）。
 *   - 消息文本通过 textContent 注入，避免不可信内容注入（§3 动态内容禁止 innerHTML）。
 *   - 不依赖 GSAP，纯 CSS 过渡，尊重 prefers-reduced-motion。
 *
 * 用法：AppToast.show('保存成功', { type: 'success' }); AppToast.show('失败', { type: 'error' });
 */
(function () {
    'use strict';

    let containerEl = null;

    function ensureContainer() {
        if (containerEl && document.body.contains(containerEl)) return containerEl;
        containerEl = document.createElement('div');
        containerEl.className = 'app-toast-container';
        containerEl.setAttribute('role', 'status');
        containerEl.setAttribute('aria-live', 'polite');
        Object.assign(containerEl.style, {
            position: 'fixed',
            top: '1rem',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: '9999',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            pointerEvents: 'none'
        });
        document.body.appendChild(containerEl);
        return containerEl;
    }

    const TYPE_STYLES = {
        success: { bg: '#16a34a', color: '#ffffff', icon: 'circle-check-big' },
        error: { bg: '#dc2626', color: '#ffffff', icon: 'circle-alert' },
        warn: { bg: '#f59e0b', color: '#1f2937', icon: 'triangle-alert' },
        info: { bg: '#3b82f6', color: '#ffffff', icon: 'info' }
    };

    function show(message, opts = {}) {
        const type = TYPE_STYLES[opts.type] ? opts.type : 'info';
        const style = TYPE_STYLES[type];
        const container = ensureContainer();

        const toast = document.createElement('div');
        toast.className = 'app-toast app-toast--' + type;
        Object.assign(toast.style, {
            background: style.bg,
            color: style.color,
            padding: '0.625rem 1rem',
            borderRadius: '0.5rem',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            fontSize: '0.875rem',
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            maxWidth: '90vw',
            opacity: '0',
            transform: 'translateY(-10px)',
            // §7 easing：进入用 ease-out（减速），退出更快（exit-faster-than-enter）。
            transition: 'opacity 0.22s cubic-bezier(0.16,1,0.3,1), transform 0.22s cubic-bezier(0.16,1,0.3,1)',
            pointerEvents: 'auto'
        });

        if (window.lucide) {
            const icon = document.createElement('i');
            icon.setAttribute('data-lucide', style.icon);
            icon.className = 'icon-sm';
            icon.style.flexShrink = '0';
            toast.appendChild(icon);
        }

        // 消息文本一律 textContent，禁止 innerHTML（安全）。
        const text = document.createElement('span');
        text.textContent = message;
        toast.appendChild(text);

        container.appendChild(toast);
        if (window.lucide) lucide.createIcons();

        // 入场（ease-out 减速进入）。
        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateY(0)';
        });

        const duration = opts.duration || 3000;
        setTimeout(() => {
            // 退出：更快（150ms < 进入 220ms），向上淡出（§7 exit-faster-than-enter）。
            toast.style.transition = 'opacity 0.15s ease-in, transform 0.15s ease-in';
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-6px)';
            setTimeout(() => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 160);
        }, duration);
    }

    window.AppToast = { show };
})();
