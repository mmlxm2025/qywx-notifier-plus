const daisyui = require('daisyui');

const qywxTheme = {
    primary: '#b80057',
    'primary-content': '#ffffff',
    secondary: '#1d4ed8',
    'secondary-content': '#ffffff',
    accent: '#0f766e',
    'accent-content': '#ffffff',
    neutral: '#1f2937',
    'neutral-content': '#ffffff',
    'base-100': '#ffffff',
    'base-200': '#f3f4f6',
    'base-300': '#e5e7eb',
    'base-content': '#111827',
    info: '#0369a1',
    'info-content': '#ffffff',
    success: '#15803d',
    'success-content': '#ffffff',
    warning: '#a84b08',
    'warning-content': '#ffffff',
    error: '#b91c1c',
    'error-content': '#ffffff',
    '--rounded-box': '1rem',
    '--rounded-btn': '0.5rem',
    '--rounded-badge': '9999px',
    '--animation-btn': '0.2s',
    '--animation-input': '0.2s',
    '--btn-focus-scale': '0.98',
    '--border-btn': '1px',
    '--tab-border': '1px',
    '--tab-radius': '0.5rem'
};

module.exports = {
    content: ['./public/**/*.html', './public/**/*.js'],
    theme: { extend: {} },
    plugins: [daisyui],
    daisyui: {
        logs: false,
        themes: [{ qywx: qywxTheme }]
    },
    qywxTheme
};
