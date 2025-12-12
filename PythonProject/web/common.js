/**
 * 共享工具函数和功能
 * 用于首页和分析页
 */

// ==================== 工具函数 ====================

function getSelectedDeviceId() {
    const fromWindow = window.selectedDeviceId;
    if (fromWindow) {
        return String(fromWindow).toUpperCase();
    }
    try {
        const params = new URLSearchParams(window.location.search || "");
        const paramId = params.get("device_id");
        if (paramId) {
            return paramId.toUpperCase();
        }
    } catch {
    }
    return "D01";
}

function ensureDeviceParam(url) {
    const deviceId = getSelectedDeviceId();
    if (!deviceId) return url;
    if (/([?&])device_id=/i.test(url)) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}device_id=${encodeURIComponent(deviceId)}`;
}

if (!window.getSelectedDeviceId) {
    window.getSelectedDeviceId = getSelectedDeviceId;
}
if (!window.ensureDeviceParam) {
    window.ensureDeviceParam = ensureDeviceParam;
}

/**
 * 简化 querySelector
 */
function qs(selector) {
    return document.querySelector(selector);
}

/**
 * 获取CSS变量值
 */
function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * 获取更新日志中的最新版本
 */
function getLatestChangelogVersion() {
    const list = typeof CHANGELOG_DATA !== 'undefined'
        ? CHANGELOG_DATA
        : (typeof window !== 'undefined' ? window.CHANGELOG_DATA : null);
    if (Array.isArray(list) && list.length > 0) {
        const latest = list[0];
        if (latest && typeof latest.version === 'string') {
            return latest.version;
        }
    }
    return '';
}

/**
 * 同步页面中需要展示最新版本号的元素
 */
function syncLatestVersionLabels() {
    if (typeof document === 'undefined') return;
    const version = getLatestChangelogVersion();
    if (!version) return;
    document.querySelectorAll('[data-latest-version]').forEach(el => {
        el.textContent = version;
    });
}

// 敏感操作（如远程控制）统一密码
const CONTROL_PANEL_PASSWORD = '0517';

// 控制面板密码弹窗（复用 confirm-modal 风格）
const ControlPasswordPrompt = {
    modal: null,
    messageEl: null,
    inputEl: null,
    errorEl: null,
    confirmBtn: null,
    cancelBtn: null,
    resolver: null,
    ensureTemplate() {
        if (this.modal) return;
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
        <div id="controlPasswordModal" class="confirm-modal" aria-hidden="true">
            <div class="confirm-content control-password-content" role="dialog" aria-modal="true" aria-labelledby="controlPasswordTitle">
                <div class="confirm-icon">🔐</div>
                <div class="confirm-title" id="controlPasswordTitle">安全确认</div>
                <div class="confirm-message" id="controlPasswordMessage">请输入密码以继续操作</div>
                <div class="control-password-field">
                    <input type="password" id="controlPasswordInput" class="form-input" placeholder="输入访问密码" autocomplete="off">
                </div>
                <div class="control-password-error" id="controlPasswordError" aria-live="polite"></div>
                <div class="confirm-actions">
                    <button class="confirm-btn confirm-btn-cancel" data-action="cancel">取消</button>
                    <button class="confirm-btn confirm-btn-danger" data-action="confirm">确认操作</button>
                </div>
            </div>
        </div>`;
        document.body.appendChild(wrapper.firstElementChild);
        this.modal = document.getElementById('controlPasswordModal');
        this.messageEl = document.getElementById('controlPasswordMessage');
        this.inputEl = document.getElementById('controlPasswordInput');
        this.errorEl = document.getElementById('controlPasswordError');
        this.confirmBtn = this.modal.querySelector('[data-action="confirm"]');
        this.cancelBtn = this.modal.querySelector('[data-action="cancel"]');
        this.confirmBtn.addEventListener('click', () => this.handleSubmit());
        this.cancelBtn.addEventListener('click', () => this.handleCancel());
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.handleCancel();
            }
        });
        this.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.handleSubmit();
            }
        });
    },
    open(message) {
        this.ensureTemplate();
        return new Promise((resolve) => {
            this.resolver = resolve;
            this.clearError();
            this.inputEl.value = '';
            this.messageEl.textContent = message || '请输入密码以继续操作';
            this.modal.classList.add('show');
            this.modal.setAttribute('aria-hidden', 'false');
            setTimeout(() => this.inputEl?.focus(), 20);
        });
    },
    close() {
        if (!this.modal) return;
        this.modal.classList.remove('show');
        this.modal.setAttribute('aria-hidden', 'true');
        this.clearError();
        if (this.inputEl) this.inputEl.value = '';
        this.resolver = null;
    },
    handleSubmit() {
        if (!this.resolver) return;
        const value = this.inputEl?.value.trim();
        if (!value) {
            this.showError('请输入密码');
            return;
        }
        if (value !== CONTROL_PANEL_PASSWORD) {
            this.showError('密码错误，请重试');
            showNotification('❌ 密码错误，请重试', true);
            this.inputEl?.select();
            return;
        }
        const resolve = this.resolver;
        this.close();
        resolve(true);
    },
    handleCancel() {
        if (!this.resolver) {
            this.close();
            return;
        }
        const resolve = this.resolver;
        this.close();
        resolve(false);
    },
    showError(text) {
        if (!this.errorEl) return;
        this.errorEl.textContent = text;
        this.errorEl.classList.add('show');
    },
    clearError() {
        if (!this.errorEl) return;
        this.errorEl.textContent = '';
        this.errorEl.classList.remove('show');
    }
};

/**
 * 执行敏感操作前的密码校验
 * @param {string} message 提示文案
 * @returns {Promise<boolean>} 是否通过验证
 */
function requireControlPassword(message = '请输入远程控制密码') {
    return ControlPasswordPrompt.open(message);
}

// ==================== 时间格式化工具 ====================

/**
 * 全局时间戳跟踪器（由调用方初始化和管理）
 * 用于跟踪数据的时间跨度，以便智能格式化时间标签
 */
window.timeStampTracker = {
    firstTimestamp: 0,
    lastTimestamp: 0,

    /**
     * 更新时间戳范围
     * @param {number} timestamp - 时间戳（秒）
     */
    update: function (timestamp) {
        if (!timestamp || timestamp <= 0) return;
        if (this.firstTimestamp === 0 || timestamp < this.firstTimestamp) {
            this.firstTimestamp = timestamp;
        }
        if (timestamp > this.lastTimestamp) {
            this.lastTimestamp = timestamp;
        }
    },

    /**
     * 重置时间戳跟踪器
     */
    reset: function () {
        this.firstTimestamp = 0;
        this.lastTimestamp = 0;
    },

    /**
     * 获取时间跨度（秒）
     * @returns {number} 时间跨度（秒）
     */
    getTimeSpan: function () {
        if (this.firstTimestamp > 0 && this.lastTimestamp > 0) {
            return this.lastTimestamp - this.firstTimestamp;
        }
        return 0;
    }
};

/**
 * 智能格式化时间标签（根据数据跨度自动选择格式）
 * @param {number} timestamp - 时间戳（秒）
 * @returns {string} 格式化后的时间字符串
 */
function formatTimeLabel(timestamp) {
    if (!timestamp || timestamp <= 0) return '';

    const date = new Date(timestamp * 1000);
    const now = new Date();

    // 检查时间戳是否不是今天（优先判断，无论时间跨度如何）
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dataDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const isNotToday = dataDate.getTime() !== today.getTime();

    // 如果数据不是今天，直接显示日期（不需要计算时间跨度）
    if (isNotToday) {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hour = String(date.getHours()).padStart(2, '0');
        const minute = String(date.getMinutes()).padStart(2, '0');
        return `${month}-${day} ${hour}:${minute}`;
    }

    // 如果数据是今天的，计算时间跨度来决定格式
    let timeSpan = 0;
    if (window.timeStampTracker) {
        timeSpan = window.timeStampTracker.getTimeSpan();
    }

    // 如果时间跨度还未计算出来（为0），但时间戳跟踪器有数据，尝试判断
    if (timeSpan === 0 && window.timeStampTracker) {
        const firstTs = window.timeStampTracker.firstTimestamp;
        const lastTs = window.timeStampTracker.lastTimestamp;

        // 如果两个时间戳都存在，计算跨度
        if (firstTs > 0 && lastTs > 0) {
            timeSpan = lastTs - firstTs;
        }
    }

    // 根据时间跨度选择格式
    // 如果跨度超过1天，显示日期+时间
    if (timeSpan > 86400) { // 超过1天
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hour = String(date.getHours()).padStart(2, '0');
        const minute = String(date.getMinutes()).padStart(2, '0');
        return `${month}-${day} ${hour}:${minute}`;
    }
    // 跨度在1天内，只显示时间
    else {
        return date.toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }
}

/**
 * 创建图表的时间轴标签格式化回调函数
 * @returns {function} Chart.js tick callback 函数
 */
function makeTimeLabelFormatter() {
    return function (value, index, ticks) {
        const label = this.getLabelForValue(value);
        if (!label) return '';

        // 如果标签是时间戳格式，需要转换
        // 尝试解析时间戳（可能是数字字符串）
        let timestamp = null;
        if (typeof label === 'string') {
            // 尝试从标签中提取时间戳（如果标签是时间戳）
            const labelLower = label.toLowerCase();
            if (labelLower.includes(':')) {
                // 已经是格式化的时间标签，直接返回
                return label;
            }
            // 尝试解析为数字
            const num = parseFloat(label);
            if (!isNaN(num) && num > 1000000000) {
                timestamp = num;
            }
        } else if (typeof label === 'number' && label > 1000000000) {
            timestamp = label;
        }

        // 如果是时间戳，使用格式化函数
        if (timestamp) {
            return formatTimeLabel(timestamp);
        }

        // 否则直接返回标签
        return label;
    };
}

// ==================== 主题系统 ====================

const root = document.documentElement;
const THEME_KEY = 'sensor_theme';

/**
 * 应用主题
 */
function applyTheme(mode) {
    root.setAttribute('data-theme', mode);
    // 通知图表更新颜色（如果存在）
    if (window.updateChartColors) {
        setTimeout(() => window.updateChartColors(), 100);
    }
    if (window.updateAllCharts && typeof window.updateAllCharts === 'function') {
        setTimeout(() => window.updateAllCharts(), 100);
    }
}

/**
 * 初始化主题（从 localStorage 读取）
 */
function initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || 'auto';
    applyTheme(saved);
}

/**
 * 获取主题的友好名称和图标
 */
function getThemeDisplayName(theme) {
    const themeMap = {
        'auto': {name: '跟随系统', icon: '🌗'},
        'light': {name: '浅色模式', icon: '☀️'},
        'dark': {name: '深色模式', icon: '🌙'}
    };
    return themeMap[theme] || themeMap['auto'];
}

/**
 * 切换主题
 */
function toggleTheme() {
    const cur = root.getAttribute('data-theme') || 'auto';
    const next = cur === 'auto' ? 'light' : (cur === 'light' ? 'dark' : 'auto');
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);

    // 显示主题切换通知
    const themeInfo = getThemeDisplayName(next);
    showNotification(`${themeInfo.icon} 已切换至${themeInfo.name}`);
}

/**
 * 设置主题切换按钮
 */
function setupThemeToggle(buttonId = 'themeBtn') {
    const themeBtn = document.getElementById(buttonId);
    if (themeBtn) {
        themeBtn.onclick = function (e) {
            e.stopPropagation();
            toggleTheme();
        };
    }
}

// 页面加载时自动初始化主题
document.addEventListener('DOMContentLoaded', function () {
    initTheme();
    syncLatestVersionLabels();
});

// ==================== 通知系统 ====================

/**
 * 显示通知
 * @param {string} message - 通知消息
 * @param {boolean} isError - 是否为错误通知
 */
function showNotification(message, isError = false) {
    // 创建通知元素
    const notification = document.createElement('div');
    notification.className = 'app-notification' + (isError ? ' error' : '');
    notification.textContent = message;

    // 设置样式
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: var(--card);
        color: var(--text);
        padding: 15px 20px;
        padding-right: 45px;
        border-radius: 8px;
        box-shadow: var(--shadow);
        border-left: 4px solid ${isError ? 'var(--bad)' : 'var(--good)'};
        z-index: 10000;
        animation: slideIn 0.3s ease-out;
        font-size: 14px;
        max-width: 300px;
        cursor: pointer;
        user-select: none;
        transition: all 0.2s ease;
    `;

    // 创建关闭按钮
    const closeBtn = document.createElement('span');
    closeBtn.innerHTML = '✕';
    closeBtn.style.cssText = `
        position: absolute;
        top: 50%;
        right: 12px;
        transform: translateY(-50%);
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        background: transparent;
        color: var(--muted);
        font-size: 16px;
        font-weight: 700;
        cursor: pointer;
        transition: all 0.2s ease;
    `;

    // 关闭按钮悬停效果
    closeBtn.addEventListener('mouseenter', () => {
        closeBtn.style.background = 'var(--bg)';
        closeBtn.style.color = 'var(--text)';
        closeBtn.style.transform = 'translateY(-50%) scale(1.1)';
    });

    closeBtn.addEventListener('mouseleave', () => {
        closeBtn.style.background = 'transparent';
        closeBtn.style.color = 'var(--muted)';
        closeBtn.style.transform = 'translateY(-50%) scale(1)';
    });

    notification.appendChild(closeBtn);

    // 注入动画样式（只注入一次）
    if (!document.getElementById('notification-animations')) {
        const style = document.createElement('style');
        style.id = 'notification-animations';
        style.textContent = `
            @keyframes slideIn {
                from {
                    transform: translateX(400px);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }
            
            @keyframes slideOut {
                from {
                    transform: translateX(0);
                    opacity: 1;
                }
                to {
                    transform: translateX(400px);
                    opacity: 0;
                }
            }
            
            .app-notification:hover {
                transform: translateY(-2px);
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
            }
        `;
        document.head.appendChild(style);
    }

    // 关闭通知的函数
    const closeNotification = () => {
        notification.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => notification.remove(), 300);
    };

    // 点击通知本身关闭
    notification.addEventListener('click', (e) => {
        closeNotification();
    });

    // 添加到页面
    document.body.appendChild(notification);

    // 3秒后自动移除
    const autoCloseTimer = setTimeout(() => {
        closeNotification();
    }, 3000);

    // 如果用户手动关闭，清除自动关闭定时器
    notification.addEventListener('click', () => {
        clearTimeout(autoCloseTimer);
    }, {once: true});
}

// ==================== 科普弹窗系统 ====================

/**
 * 显示科普弹窗
 */
function showInfo(key) {
    // 需要在各页面中定义 infoData
    if (typeof infoData === 'undefined' || !infoData[key]) {
        console.error('科普数据未定义:', key);
        return;
    }

    const data = infoData[key];
    const modal = document.getElementById('infoModal');
    const icon = document.getElementById('infoIcon');
    const title = document.getElementById('infoTitle');
    const body = document.getElementById('infoBody');

    if (modal && title && body) {
        if (icon) {
            icon.textContent = data.icon;
        }
        title.textContent = data.title;
        body.innerHTML = data.content;
        modal.classList.add('show');
    }
}

/**
 * 关闭科普弹窗
 */
function closeInfo() {
    const modal = document.getElementById('infoModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

/**
 * 设置科普弹窗点击外部关闭
 */
function setupInfoModalClickOutside() {
    const modal = document.getElementById('infoModal');
    if (modal) {
        modal.addEventListener('click', function (e) {
            if (e.target === modal) {
                closeInfo();
            }
        });
        console.log('✅ 科普弹窗点击外部关闭已设置');
    }
}

// ==================== 图表交互系统 ====================

/**
 * 基础图表配置（包含zoom功能）
 */
function makeBaseChartOptions() {
    return {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: {mode: 'nearest', intersect: false, axis: 'x'},
        hover: {mode: 'nearest', intersect: false, animationDuration: 200},
        elements: {
            point: {radius: 0, hoverRadius: 5, hoverBorderWidth: 2},
            line: {tension: 0.4, borderWidth: 2}
        },
        scales: {
            x: {
                ticks: {
                    maxRotation: 0, // 不旋转标签
                    autoSkip: true,
                    autoSkipPadding: 20,
                    maxTicksLimit: 8,
                    callback: function (value, index, ticks) {
                        // 如果 makeTimeLabelFormatter 可用，使用它；否则使用简单格式化
                        if (typeof makeTimeLabelFormatter === 'function') {
                            const formatter = makeTimeLabelFormatter();
                            return formatter.call(this, value, index, ticks);
                        }
                        const label = this.getLabelForValue(value);
                        return label || '';
                    }
                },
                grid: {color: css('--chart-grid')}
            },
            y: {position: 'left', grid: {color: css('--chart-grid')}},
            y1: {position: 'right', grid: {drawOnChartArea: false}}
        },
        plugins: {
            zoom: {
                limits: {x: {min: 'original', max: 'original'}},
                pan: {
                    enabled: true,
                    mode: 'x',
                    threshold: 4
                },
                zoom: {
                    wheel: {enabled: true, speed: 0.2},
                    pinch: {
                        enabled: true,
                        threshold: 0.1,
                        speed: 0.5,
                        mode: 'x'
                    },
                    drag: {
                        enabled: true,
                        modifierKey: 'alt',
                        backgroundColor: 'rgba(125,125,125,.12)',
                        borderColor: 'rgba(125,125,125,.3)',
                        threshold: 6
                    },
                    mode: 'x'
                }
            }
        }
    };
}

/**
 * 通用单轴图表配置生成器
 */
function makeSingleAxisChartOptions() {
    const opts = makeBaseChartOptions();
    opts.scales = {
        x: {
            ticks: {
                maxRotation: 0, // 不旋转标签
                autoSkip: true,
                autoSkipPadding: 20,
                maxTicksLimit: 8,
                callback: function (value, index, ticks) {
                    // 如果 makeTimeLabelFormatter 可用，使用它；否则使用简单格式化
                    if (typeof makeTimeLabelFormatter === 'function') {
                        const formatter = makeTimeLabelFormatter();
                        return formatter.call(this, value, index, ticks);
                    }
                    const label = this.getLabelForValue(value);
                    return label || '';
                }
            },
            grid: {color: css('--chart-grid')}
        },
        y: {position: 'left', grid: {color: css('--chart-grid')}}
    };
    // 只禁用插件平移（保留 Alt+框选放大功能），使用自定义窗口拖动
    if (opts?.plugins?.zoom?.pan) {
        opts.plugins.zoom.pan.enabled = false;
    }
    return opts;
}

/**
 * 通用按钮绑定函数
 */
function bindChartButtons(chartName, chart, configKey) {
    qs(`#zoomIn${chartName}`)?.addEventListener('click', () => chart?.zoom(1.2));
    qs(`#zoomOut${chartName}`)?.addEventListener('click', () => chart?.zoom(0.8));
    qs(`#panLeft${chartName}`)?.addEventListener('click', () => {
        if (window.chartConfig && window.chartConfig[configKey]) {
            window.chartConfig[configKey].followLatest = false;
        }
        chart?.pan({x: 120});
    });
    qs(`#panRight${chartName}`)?.addEventListener('click', () => {
        chart?.pan({x: -120});
        const s = chart?.options?.scales?.x;
        const N = chart?.data?.labels?.length || 0;
        if (s && N && window.chartConfig && window.chartConfig[configKey] && (s.max ?? (N - 1)) >= N - 1 - 0.5) {
            window.chartConfig[configKey].followLatest = true;
        }
    });
    qs(`#reset${chartName}`)?.addEventListener('click', () => hardReset(chart));
}

/**
 * 硬重置图表
 */
function hardReset(chart) {
    if (!chart) return;
    try {
        if (chart.resetZoom) {
            chart.resetZoom();
        }
        // 确保scales重置
        if (chart.options?.scales?.x) {
            chart.options.scales.x.min = undefined;
            chart.options.scales.x.max = undefined;
        }
        if (chart.options?.scales?.y) {
            chart.options.scales.y.min = undefined;
            chart.options.scales.y.max = undefined;
        }
        // 使用'none'模式更新，避免动画和事件重绑定问题
        chart.update('none');
    } catch (e) {
        console.warn('重置图表时出错:', e);
    }
}

/**
 * 图表到配置的映射
 */
const chartConfigMap = new Map();

/**
 * 兜底：左键拖动平移（直接改 x.min/x.max），避免与 Alt 框选冲突
 */
function enableManualDragPan(canvas, chart, configKey) {
    if (!canvas || !chart) return;

    // 注册图表和其配置的映射
    chartConfigMap.set(chart, configKey);

    // 取 X 轴（兼容不同命名）
    const getXScale = () => {
        const sc = chart.scales || {};
        return sc.x || sc['x-axis-0'] || Object.values(sc).find(s => s.isHorizontal?.()) || Object.values(sc)[0];
    };

    let dragging = false;
    let lastX = 0;

    function panByPixels(dxPixels) {
        const scale = getXScale();
        const N = chart.data.labels.length || 0;
        if (!scale || !N) return;

        // 当前窗口
        let curMin = (chart.options.scales.x.min ?? 0);
        let curMax = (chart.options.scales.x.max ?? (N - 1));
        if (!Number.isFinite(curMin) || !Number.isFinite(curMax)) {
            curMin = 0;
            curMax = N - 1;
        }

        const range = Math.max(1, curMax - curMin);
        const pxPerIndex = Math.max(1, (scale.right - scale.left) / range);
        let shiftIdx = dxPixels / pxPerIndex;

        let newMin = curMin + shiftIdx;
        let newMax = curMax + shiftIdx;

        if (newMin < 0) {
            const d = -newMin;
            newMin += d;
            newMax += d;
        }
        if (newMax > N - 1) {
            const d = newMax - (N - 1);
            newMin -= d;
            newMax -= d;
        }

        // 温湿度已与亮度对齐：仍使用插件/轴平移逻辑
        chart.options.scales.x.min = newMin;
        chart.options.scales.x.max = newMax;
        chart.update('none');
    }

    // 鼠标事件
    canvas.addEventListener('mousedown', (e) => {
        if (e.altKey || e.button !== 0) return; // Alt 是框选放大，右键不处理
        dragging = true;
        lastX = e.clientX;
        canvas.style.cursor = 'grabbing';

        // 确保窗口位置已初始化（防止拖动时被重置）
        const s = chart.options?.scales?.x;
        const N = chart.data.labels?.length || 0;
        if (s && N && (s.min === undefined || s.max === undefined)) {
            s.min = Math.max(0, N - 100); // 默认窗口大小
            s.max = N - 1;
        }
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - lastX;
        lastX = e.clientX;
        panByPixels(-dx); // 向右拖 => 看更早数据
    });

    canvas.addEventListener('mouseup', () => {
        dragging = false;
        canvas.style.cursor = 'grab';
    });

    canvas.addEventListener('mouseleave', () => {
        dragging = false;
        canvas.style.cursor = 'grab';
    });

    // 设置初始光标
    canvas.style.cursor = 'grab';
}

/**
 * 全屏弹窗控制函数
 */
function openOverlay(overlayId) {
    const overlay = document.getElementById(overlayId);
    if (overlay) {
        overlay.classList.add('show');
        overlay.setAttribute('aria-hidden', 'false');
    }
}

function closeOverlay(overlayId) {
    const overlay = document.getElementById(overlayId);
    if (overlay) {
        overlay.classList.remove('show');
        overlay.setAttribute('aria-hidden', 'true');
    }
}

/**
 * 创建全屏图表
 */
function createFullscreenChart(chartId, chartType, data, options) {
    const canvas = document.getElementById(chartId);
    if (!canvas) return null;

    const ctx = canvas.getContext('2d');

    // 对于散点图和柱状图，直接使用原始配置，不添加zoom
    // 只有折线图需要添加zoom功能
    let fullOptions;
    if (chartType === 'line') {
        fullOptions = {...options, ...makeBaseChartOptions()};
        // 全屏图允许插件平移（保留 Alt+框选放大功能、滚轮/双指缩放）
        if (fullOptions?.plugins?.zoom?.pan) {
            fullOptions.plugins.zoom.pan.enabled = true;
        }
    } else {
        // 散点图和柱状图使用原始配置
        fullOptions = JSON.parse(JSON.stringify(options)); // 深拷贝
    }

    const chart = new Chart(ctx, {
        type: chartType,
        data: data,
        options: fullOptions
    });

    // 只为折线图绑定手动拖动平移
    if (chartType === 'line') {
        try {
            const c = chart.canvas;
            if (c) {
                c.style.cursor = 'grab';
                c.addEventListener('mousedown', () => {
                    c.style.cursor = 'grabbing';
                });
                window.addEventListener('mouseup', () => {
                    c.style.cursor = 'grab';
                });
            }
        } catch (e) {
        }

        enableManualDragPan(canvas, chart);
    }

    return chart;
}

// ==================== 数据加载系统 ====================

// 数据加载器配置
let dataLoaderConfig = {
    onDataLoaded: null,  // 数据加载完成回调
    clearFirst: true      // 加载前是否清空数据
};

let pendingLoadParams = null; // 存储待加载的参数
let isDataLoading = false;    // 加载状态标志（防止重复加载）

/**
 * 初始化数据加载器
 * @param {Object} config - 配置对象
 * @param {Function} config.onDataLoaded - 数据加载完成的回调函数 (data, count)
 * @param {boolean} config.clearFirst - 是否在加载前清空数据，默认true
 */
function initDataLoader(config) {
    dataLoaderConfig = Object.assign(dataLoaderConfig, config);
    console.log('✅ 数据加载器已初始化');
    // 确保已存在的弹窗也设置了事件监听器（如 index.html 中已定义的 confirmModal）
    // 延迟执行，确保DOM已加载
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupModalClickOutside);
    } else {
        setupModalClickOutside();
    }
}

/**
 * 打开加载数据弹窗
 */
function openLoadModal() {
    ensureLoadModalExists();
    const modal = document.getElementById('loadModal');
    if (modal) {
        // 重置到选择界面
        showLoadChoiceView();
        modal.classList.add('show');
    }
}

/**
 * 关闭加载数据弹窗
 */
function closeLoadModal() {
    const modal = document.getElementById('loadModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

/**
 * 显示加载方式选择界面
 */
function showLoadChoiceView() {
    document.getElementById('loadChoiceView').style.display = 'block';
    document.getElementById('loadChoiceActions').style.display = 'flex';
    document.getElementById('loadFormCount').style.display = 'none';
    document.getElementById('loadFormTime').style.display = 'none';
    document.getElementById('loadFormRange').style.display = 'none';
    document.getElementById('loadModalTitle').textContent = '选择加载方式';
}

/**
 * 显示加载表单
 */
function showLoadForm(type) {
    document.getElementById('loadChoiceView').style.display = 'none';
    document.getElementById('loadChoiceActions').style.display = 'none';

    const forms = {
        'count': {id: 'loadFormCount', title: '按最近条数加载', deviceGroup: 'deviceSelectGroup'},
        'time': {id: 'loadFormTime', title: '按最近时间加载', deviceGroup: 'deviceSelectGroupTime'},
        'range': {id: 'loadFormRange', title: '自定义时间范围', deviceGroup: 'deviceSelectGroupRange'}
    };

    if (forms[type]) {
        document.getElementById(forms[type].id).style.display = 'block';
        document.getElementById('loadModalTitle').textContent = forms[type].title;
        
        // 如果是 analysis.html 页面，显示设备选择
        const isAnalysisPage = window.location.pathname.includes('analysis.html');
        const deviceGroup = document.getElementById(forms[type].deviceGroup);
        if (deviceGroup) {
            deviceGroup.style.display = isAnalysisPage ? 'block' : 'none';
            if (isAnalysisPage) {
                // 根据类型获取对应的 select ID
                const selectIdMap = {
                    'count': 'loadDeviceSelect',
                    'time': 'loadDeviceSelectTime',
                    'range': 'loadDeviceSelectRange'
                };
                const selectId = selectIdMap[type];
                if (selectId) {
                    updateDeviceSelectOptions(selectId);
                }
            }
        }
    }
}

/**
 * 更新设备选择下拉框选项
 */
async function updateDeviceSelectOptions(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;
    
    try {
        const res = await fetch('/api/devices');
        if (res.ok) {
            const data = await res.json();
            if (data.success && data.devices) {
                // 保留"全部设备"选项
                select.innerHTML = '<option value="all">全部设备</option>';
                // 添加各个设备选项
                data.devices.forEach(device => {
                    const option = document.createElement('option');
                    option.value = device.id || device.device_id || '';
                    option.textContent = `${device.name || ('设备 ' + device.id)} (${device.id})`;
                    select.appendChild(option);
                });
            }
        }
    } catch (error) {
        console.warn('获取设备列表失败：', error);
    }
}

/**
 * 通用设备选择器（类似ControlPasswordPrompt的实现方式）
 */
const DevicePicker = {
    modal: null,
    hintEl: null,
    listEl: null,
    cancelBtn: null,
    resolver: null,
    devicesCache: [],
    lastSelectedDeviceId: '',
    ensureTemplate() {
        if (this.modal) return;
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
        <div id="commonDeviceSelectModal" class="confirm-modal" aria-hidden="true">
            <div class="confirm-content device-select-content" role="dialog" aria-modal="true" aria-labelledby="commonDeviceSelectTitle">
                <div class="confirm-icon">📟</div>
                <div class="confirm-title" id="commonDeviceSelectTitle">选择设备</div>
                <div class="device-select-hint" id="commonDeviceSelectHint">请选择要进行操作的目标设备</div>
                <div class="device-select-list" id="commonDeviceSelectList"></div>
                <div class="confirm-actions">
                    <button class="confirm-btn confirm-btn-cancel" data-device-select-cancel>取消</button>
                </div>
            </div>
        </div>`;
        document.body.appendChild(wrapper.firstElementChild);
        this.modal = document.getElementById('commonDeviceSelectModal');
        this.hintEl = document.getElementById('commonDeviceSelectHint');
        this.listEl = document.getElementById('commonDeviceSelectList');
        this.cancelBtn = this.modal.querySelector('[data-device-select-cancel]');
        this.cancelBtn.addEventListener('click', () => this.handleCancel());
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.handleCancel();
            }
        });
        // 阻止弹窗内容区域的点击事件冒泡
        const content = this.modal.querySelector('.confirm-content');
        if (content) {
            content.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }
    },
    async loadDevices() {
        try {
            const res = await fetch('/api/devices');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!data.success) throw new Error(data.error || '获取设备列表失败');
            this.devicesCache = (data.devices || []).map((d) => {
                const originalId = d.id || d.device_id || '';
                const normalizedId = String(originalId).trim().toUpperCase();
                return {
                    ...d,
                    id: normalizedId
                };
            });
            return this.devicesCache;
        } catch (error) {
            console.error('加载设备列表失败：', error);
            return [];
        }
    },
    updateList(selectedDeviceId) {
        if (!this.listEl) return;
        let selected = '';
        if (typeof selectedDeviceId === 'string' || typeof selectedDeviceId === 'number') {
            selected = String(selectedDeviceId).trim().toUpperCase();
        } else if (selectedDeviceId === undefined && this.lastSelectedDeviceId) {
            selected = this.lastSelectedDeviceId;
        } else {
            selected = '';
        }
        this.lastSelectedDeviceId = selected;
        if (!this.devicesCache.length) {
            this.listEl.innerHTML = '<div style="text-align: center; color: var(--muted); padding: 20px;">暂无可选设备</div>';
            return;
        }
        this.listEl.innerHTML = this.devicesCache.map((dev) => {
            // 确保dev.id也是大写格式进行比较，避免错误匹配
            const devId = String(dev.id || '').trim().toUpperCase();
            const isActive = selected && devId && selected === devId;
            const transports = [];
            if (dev.has_ble) transports.push('BLE');
            if (dev.has_mqtt) transports.push('MQTT');
            const viaList = dev.via || transports;
            const viaText = viaList && viaList.length ? viaList.join(' / ') : '未知链路';
            const status = dev.online ? '在线' : '离线';
            const unreadCount = window.MessageCenter && typeof window.MessageCenter.getDeviceUnreadCount === 'function'
                ? window.MessageCenter.getDeviceUnreadCount(devId)
                : 0;
            const unreadBadge = unreadCount > 0
                ? `<span class="device-select-unread" aria-label="未读警告">${unreadCount > 99 ? '99+' : unreadCount}</span>`
                : '';
            return `
                <button type="button" class="device-select-item ${isActive ? 'active' : ''}" data-device-id="${dev.id}">
                    ${unreadBadge}
                    <div class="device-select-meta">
                        <span class="device-select-name">${dev.name || ('设备 ' + dev.id)}</span>
                        <span class="device-select-id">ID: ${dev.id}</span>
                    </div>
                    <span class="device-select-status">${status}</span>
                </button>
            `;
        }).join('');
        // 绑定点击事件
        this.listEl.querySelectorAll('.device-select-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const deviceId = item.getAttribute('data-device-id');
                this.handleSelect(deviceId);
            });
        });
    },
    async open(hintText, selectedDeviceId = null) {
        this.ensureTemplate();
        // 加载设备列表
        await this.loadDevices();
        if (!this.devicesCache.length) {
            if (typeof window.showNotification === 'function') {
                window.showNotification('暂无可选设备', true);
            }
            return Promise.resolve(null);
        }
        return new Promise((resolve) => {
            this.resolver = resolve;
            if (this.hintEl) {
                this.hintEl.textContent = hintText || '请选择要操作的设备';
            }
            // 不传递selectedDeviceId，避免默认选中某个设备（用户还没选择）
            this.updateList(null);
            this.modal.classList.add('show');
            this.modal.setAttribute('aria-hidden', 'false');
        });
    },
    close() {
        if (!this.modal) return;
        this.modal.classList.remove('show');
        this.modal.setAttribute('aria-hidden', 'true');
        this.resolver = null;
    },
    handleSelect(deviceId) {
        if (!this.resolver) return;
        const resolve = this.resolver;
        this.close();
        resolve(deviceId || null);
    },
    handleCancel() {
        if (!this.resolver) {
            this.close();
            return;
        }
        const resolve = this.resolver;
        this.close();
        resolve(null);
    }
};

// 导出到全局，供其他页面使用
if (typeof window !== 'undefined') {
    // 如果页面已经有openDevicePicker函数（如devices.html），则优先使用页面的实现
    // 否则使用通用的DevicePicker
    if (!window.openDevicePicker) {
        window.openDevicePicker = function(hintText, selectedDeviceId) {
            return DevicePicker.open(hintText, selectedDeviceId);
        };
    }
    window.addEventListener('messagecenter:unread-update', () => {
        if (DevicePicker.modal && DevicePicker.modal.classList.contains('show')) {
            DevicePicker.updateList();
        }
    });
}

/**
 * 返回选择界面
 */
function backToChoice() {
    showLoadChoiceView();
}

/**
 * 按条数加载
 */
async function loadByCount() {
    const count = parseInt(document.getElementById('loadCountInput').value);

    if (!count || count < 1) {
        alert('请输入有效的数据条数（大于0）');
        return;
    }

    // 获取设备选择（仅在 analysis.html 页面）
    const isAnalysisPage = window.location.pathname.includes('analysis.html');
    let deviceId = null;
    if (isAnalysisPage) {
        const deviceSelect = document.getElementById('loadDeviceSelect');
        const deviceGroup = document.getElementById('deviceSelectGroup');
        if (deviceSelect && deviceGroup && deviceGroup.style.display !== 'none') {
            deviceId = deviceSelect.value;
            if (deviceId === 'all') deviceId = null;
        }
    }

    console.log(`📊 按条数加载：最近 ${count} 条数据${deviceId ? ` (设备: ${deviceId})` : ' (全部设备)'}`);
    closeLoadModal();

    // 检查数据量是否过大
    if (count > 20000) {
        console.warn(`⚠️ 数据量过大: ${count} 条`);
        showLargeDataWarning(count, {limit: count, customUrl: null, deviceId: deviceId});
        return;
    }

    let url = `/api/history?limit=${count}`;
    if (deviceId) {
        url += `&device_id=${encodeURIComponent(deviceId)}`;
    }
    // 注意：在 analysis.html 页面，如果 deviceId 是 null（全部设备），不应该添加 device_id 参数
    
    // 保存设备信息到全局变量（用于 AI 分析）
    if (isAnalysisPage && window.setAnalysisDeviceInfo) {
        await window.setAnalysisDeviceInfo(deviceId);
    }
    
    await executeDataLoad(url);
}

/**
 * 按时间加载
 */
async function loadByTime() {
    const value = parseInt(document.getElementById('loadTimeValue').value);
    const unit = document.getElementById('loadTimeUnit').value;

    if (!value || value < 1) {
        alert('请输入有效的时间数量（大于0）');
        return;
    }

    // 计算时间范围（秒）
    let seconds = 0;
    switch (unit) {
        case 'minute':
            seconds = value * 60;
            break;
        case 'hour':
            seconds = value * 60 * 60;
            break;
        case 'day':
            seconds = value * 24 * 60 * 60;
            break;
        case 'month':
            seconds = value * 30 * 24 * 60 * 60;
            break;
    }

    const unitNames = {
        minute: '分钟', hour: '小时', day: '天', month: '月'
    };

    // 获取设备选择（仅在 analysis.html 页面）
    const isAnalysisPage = window.location.pathname.includes('analysis.html');
    let deviceId = null;
    if (isAnalysisPage) {
        const deviceSelect = document.getElementById('loadDeviceSelectTime');
        const deviceGroup = document.getElementById('deviceSelectGroupTime');
        if (deviceSelect && deviceGroup && deviceGroup.style.display !== 'none') {
            deviceId = deviceSelect.value;
            if (deviceId === 'all') deviceId = null;
        }
    }

    console.log(`⏱️ 按时间加载：最近 ${value} ${unitNames[unit]}${deviceId ? ` (设备: ${deviceId})` : ' (全部设备)'}`);

    const endTime = Math.floor(Date.now() / 1000);
    const startTime = endTime - seconds;
    let apiUrl = `/api/history/range?start=${startTime}&end=${endTime}`;
    if (deviceId) {
        apiUrl += `&device_id=${encodeURIComponent(deviceId)}`;
    }
    // 注意：在 analysis.html 页面，如果 deviceId 是 null（全部设备），不应该添加 device_id 参数
    
    // 保存设备信息到全局变量（用于 AI 分析）
    if (isAnalysisPage && window.setAnalysisDeviceInfo) {
        await window.setAnalysisDeviceInfo(deviceId);
    }

    try {
        // 显示检查进度
        showLoadingProgress('正在检查数据量...', 10);
        closeLoadModal();

        // 先获取数据量
        console.log('🔍 检查数据量...');
        const response = await fetch(apiUrl);

        updateLoadingProgress('正在分析数据范围...', 20);
        const result = await response.json();

        if (result.success) {
            const dataCount = result.count || 0;
            console.log(`📊 该时间范围内有 ${dataCount} 条数据`);

            // 如果数据量过大，显示警告
            if (dataCount > 20000) {
                console.warn(`⚠️ 数据量过大: ${dataCount} 条`);
                // 隐藏进度条，让用户可以点击警告弹窗
                hideLoadingProgress();
                showLargeDataWarning(dataCount, {limit: -1, customUrl: apiUrl});
                return;
            }

            // 数据量合理，直接加载（从30%开始）
            await executeDataLoad(apiUrl, 30);
        } else {
            hideLoadingProgress();
            alert(`检查数据失败：${result.error || '未知错误'}`);
        }
    } catch (error) {
        console.error('❌ 检查数据量失败:', error);
        hideLoadingProgress();
        alert(`检查数据量失败：${error.message}`);
    }
}

/**
 * 按自定义范围加载
 */
async function loadByRange() {
    const startTimeStr = document.getElementById('loadStartTime').value;
    const endTimeStr = document.getElementById('loadEndTime').value;

    if (!startTimeStr || !endTimeStr) {
        alert('请选择开始时间和结束时间');
        return;
    }

    const startTime = Math.floor(new Date(startTimeStr).getTime() / 1000);
    const endTime = Math.floor(new Date(endTimeStr).getTime() / 1000);

    if (startTime >= endTime) {
        alert('开始时间必须早于结束时间');
        return;
    }

    // 获取设备选择（仅在 analysis.html 页面）
    const isAnalysisPage = window.location.pathname.includes('analysis.html');
    let deviceId = null;
    if (isAnalysisPage) {
        const deviceSelect = document.getElementById('loadDeviceSelectRange');
        const deviceGroup = document.getElementById('deviceSelectGroupRange');
        if (deviceSelect && deviceGroup && deviceGroup.style.display !== 'none') {
            deviceId = deviceSelect.value;
            if (deviceId === 'all') deviceId = null;
        }
    }

    console.log(`📅 按自定义范围加载：${startTimeStr} ~ ${endTimeStr}${deviceId ? ` (设备: ${deviceId})` : ' (全部设备)'}`);

    let apiUrl = `/api/history/range?start=${startTime}&end=${endTime}`;
    if (deviceId) {
        apiUrl += `&device_id=${encodeURIComponent(deviceId)}`;
    }
    // 注意：在 analysis.html 页面，如果 deviceId 是 null（全部设备），不应该添加 device_id 参数
    
    // 保存设备信息到全局变量（用于 AI 分析）
    if (isAnalysisPage && window.setAnalysisDeviceInfo) {
        await window.setAnalysisDeviceInfo(deviceId);
    }

    try {
        // 显示检查进度
        showLoadingProgress('正在检查数据量...', 10);
        closeLoadModal();

        // 先获取数据量
        console.log('🔍 检查数据量...');
        const response = await fetch(apiUrl);

        updateLoadingProgress('正在分析数据范围...', 20);
        const result = await response.json();

        if (result.success) {
            const dataCount = result.count || 0;
            console.log(`📊 该时间范围内有 ${dataCount} 条数据`);

            // 如果数据量过大，显示警告
            if (dataCount > 20000) {
                console.warn(`⚠️ 数据量过大: ${dataCount} 条`);
                // 隐藏进度条，让用户可以点击警告弹窗
                hideLoadingProgress();
                showLargeDataWarning(dataCount, {limit: -1, customUrl: apiUrl});
                return;
            }

            // 数据量合理，直接加载（从30%开始）
            await executeDataLoad(apiUrl, 30);
        } else {
            hideLoadingProgress();
            alert(`检查数据失败：${result.error || '未知错误'}`);
        }
    } catch (error) {
        console.error('❌ 检查数据量失败:', error);
        hideLoadingProgress();
        alert(`检查数据量失败：${error.message}`);
    }
}

/**
 * 显示加载全部确认框
 */
async function showLoadAllConfirm() {
    closeLoadModal();
    
    // 如果是 analysis.html 页面，先让用户选择设备
    const isAnalysisPage = window.location.pathname.includes('analysis.html');
    if (isAnalysisPage) {
        // 创建一个临时的设备选择确认框
        const deviceSelectHtml = `
            <div id="loadAllDeviceSelectModal" class="load-modal" style="display: block;">
                <div class="load-content">
                    <div class="load-title">
                        <span>📊</span>
                        <span>选择设备</span>
                    </div>
                    <div class="form-group">
                        <label class="form-label">选择要加载数据的设备</label>
                        <div class="form-input-group">
                            <select class="form-input" id="loadAllDeviceSelect">
                                <option value="all">全部设备</option>
                            </select>
                        </div>
                    </div>
                    <div class="load-actions">
                        <button class="load-btn load-btn-secondary" onclick="closeLoadAllDeviceSelect()">取消</button>
                        <button class="load-btn load-btn-primary" onclick="confirmLoadAllDeviceSelect()">继续</button>
                    </div>
                </div>
            </div>
        `;
        
        // 如果已存在，先移除
        const existing = document.getElementById('loadAllDeviceSelectModal');
        if (existing) existing.remove();
        
        document.body.insertAdjacentHTML('beforeend', deviceSelectHtml);
        await updateDeviceSelectOptions('loadAllDeviceSelect');
        return;
    }
    
    // 不需要调用 ensureConfirmModalExists()，因为 index.html 中已经有 confirmModal 了
    const modal = document.getElementById('confirmModal');
    if (modal) {
        modal.classList.add('show');
    } else {
        console.error('❌ 找不到 confirmModal 元素');
    }
}

/**
 * 关闭加载全部数据的设备选择框
 */
function closeLoadAllDeviceSelect() {
    const modal = document.getElementById('loadAllDeviceSelectModal');
    if (modal) {
        modal.remove();
    }
}

/**
 * 确认加载全部数据的设备选择
 */
async function confirmLoadAllDeviceSelect() {
    const deviceSelect = document.getElementById('loadAllDeviceSelect');
    if (!deviceSelect) return;
    
    let deviceId = deviceSelect.value;
    if (deviceId === 'all') deviceId = null;
    
    closeLoadAllDeviceSelect();
    
    // 保存设备信息到全局变量（用于 AI 分析）
    if (window.setAnalysisDeviceInfo) {
        await window.setAnalysisDeviceInfo(deviceId);
    }
    
    // 显示确认框
    const modal = document.getElementById('confirmModal');
    if (modal) {
        // 保存设备ID到确认框，供 confirmLoadAll 使用
        modal.dataset.selectedDeviceId = deviceId || 'all';
        modal.classList.add('show');
    } else {
        console.error('❌ 找不到 confirmModal 元素');
    }
}

/**
 * 关闭确认框
 */
function closeConfirmModal() {
    const modal = document.getElementById('confirmModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

/**
 * 确认加载全部
 */
async function confirmLoadAll() {
    closeConfirmModal();
    
    // 获取设备选择（仅在 analysis.html 页面）
    const isAnalysisPage = window.location.pathname.includes('analysis.html');
    let deviceId = null;
    if (isAnalysisPage) {
        const modal = document.getElementById('confirmModal');
        if (modal && modal.dataset.selectedDeviceId) {
            deviceId = modal.dataset.selectedDeviceId === 'all' ? null : modal.dataset.selectedDeviceId;
        }
    }
    
    console.log(`🔄 开始加载全部历史数据${deviceId ? ` (设备: ${deviceId})` : ' (全部设备)'}...`);
    
    let url = '/api/history?limit=-1';
    if (deviceId) {
        url += `&device_id=${encodeURIComponent(deviceId)}`;
    }
    // 注意：在 analysis.html 页面，如果 deviceId 是 null（全部设备），不应该添加 device_id 参数
    
    await executeDataLoad(url);
}

/**
 * 显示数据量过大警告
 */
function showLargeDataWarning(count, params) {
    pendingLoadParams = params;
    ensureLargeDataWarningModalExists();

    console.log('⚠️ 显示大数据警告弹窗:', count, '条数据');

    const countElement = document.getElementById('largeDataCount');
    if (countElement) {
        countElement.textContent = count.toLocaleString();
    } else {
        console.error('❌ 找不到 largeDataCount 元素');
    }

    const modal = document.getElementById('largeDataWarningModal');
    if (modal) {
        modal.classList.add('show');
        console.log('✅ 大数据警告弹窗已显示');
    } else {
        console.error('❌ 找不到 largeDataWarningModal 元素');
    }
}

/**
 * 关闭数据量过大警告
 */
function closeLargeDataWarning() {
    pendingLoadParams = null;
    const modal = document.getElementById('largeDataWarningModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

/**
 * 确认加载大数据
 */
async function confirmLargeDataLoad() {
    console.log('🔄 用户点击确认加载大数据...');

    // 先检查参数，再关闭弹窗
    if (!pendingLoadParams) {
        console.error('❌ 没有待加载的参数');
        closeLargeDataWarning();
        showNotification('❌ 加载参数丢失，请重试', true);
        return;
    }

    const {limit, customUrl, deviceId} = pendingLoadParams;
    console.log('📋 加载参数:', {limit, customUrl, deviceId});
    
    // 构建 URL
    let url = customUrl || `/api/history?limit=${limit}`;
    const isAnalysisPage = window.location.pathname.includes('analysis.html');
    
    // 如果有设备ID，添加到URL
    if (deviceId) {
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}device_id=${encodeURIComponent(deviceId)}`;
    }
    // 注意：在 analysis.html 页面，如果 deviceId 是 null（全部设备），不应该添加 device_id 参数
    
    // 保存设备信息到全局变量（用于 AI 分析）
    if (isAnalysisPage && window.setAnalysisDeviceInfo) {
        await window.setAnalysisDeviceInfo(deviceId || null);
    }
    
    console.log('🌐 请求URL:', url);

    // 关闭弹窗（此时参数已经保存到局部变量）
    closeLargeDataWarning();

    // 从30%开始显示进度（因为已经检查过数据量了）
    try {
        await executeDataLoad(url, 30);
    } catch (error) {
        console.error('❌ 执行加载失败:', error);
        showNotification('❌ 加载失败: ' + error.message, true);
    }
}

/**
 * 执行数据加载（核心函数）
 * @param {string} url - API URL
 * @param {number} startProgress - 起始进度（0-100），默认为0
 */
async function executeDataLoad(url, startProgress = 0) {
    // 防止重复加载
    if (isDataLoading) {
        console.warn('⚠️ 数据正在加载中，请勿重复操作');
        showNotification('⚠️ 数据正在加载中，请稍候...', true);
        return;
    }

    try {
        // 设置加载状态
        isDataLoading = true;
        disableLoadButtons();

        // 关闭所有可能打开的模态框
        closeLoadModal();
        closeConfirmModal();
        closeLargeDataWarning();

        // 检查 URL 是否已经包含 device_id 参数
        // 如果已经包含，说明是明确选择的结果（全部设备或指定设备），不应该再调用 ensureDeviceParam
        // 另外，如果在 analysis.html 页面且 URL 中没有 device_id，说明用户明确选择了"全部设备"，也不应该调用 ensureDeviceParam
        const hasDeviceIdParam = /([?&])device_id=/i.test(url);
        const isAnalysisPage = window.location.pathname.includes('analysis.html');
        const shouldUseEnsureDeviceParam = ensureDeviceParam && !hasDeviceIdParam && !isAnalysisPage;
        const finalUrl = shouldUseEnsureDeviceParam ? ensureDeviceParam(url) : url;
        console.log('📡 请求API:', finalUrl);

        // 显示进度条（无论startProgress是多少，都重新显示）
        showLoadingProgress('正在加载数据...', startProgress);
        await new Promise(resolve => setTimeout(resolve, 50));

        // 模拟进度增长（让用户看到进度在动）
        const progressStep = (60 - startProgress) / 3;
        updateLoadingProgress('正在请求数据...', startProgress + progressStep);

        const response = await fetch(finalUrl);

        // 更新进度：数据接收中
        updateLoadingProgress('正在接收数据...', startProgress + progressStep * 2);

        const result = await response.json();

        if (result.success && result.data) {
            // 检查是否使用了聚合
            const isAggregated = result.aggregated === true;
            const originalCount = result.original_count || result.count;
            const interval = result.interval;

            if (isAggregated) {
                const intervalText = interval >= 3600 ? `${interval / 3600}小时` :
                    interval >= 60 ? `${interval / 60}分钟` : `${interval}秒`;
                console.log(`✅ 成功获取 ${result.count} 条聚合数据（原始数据 ${originalCount} 条，聚合间隔：${intervalText}）`);
                console.log(`📊 数据已优化，从 ${originalCount} 条聚合到 ${result.count} 条，提升性能`);
            } else {
                console.log(`✅ 成功获取 ${result.count} 条数据`);
            }

            // 更新进度：数据处理中
            updateLoadingProgress('正在处理数据...', 75);

            // 模拟处理时间，让用户看到进度
            await new Promise(resolve => setTimeout(resolve, 100));
            updateLoadingProgress('正在渲染图表...', 90);

            // 调用回调函数（使用try-catch确保即使回调出错也不影响整体流程）
            let callbackError = null;
            if (dataLoaderConfig.onDataLoaded) {
                try {
                    await dataLoaderConfig.onDataLoaded(result.data, result.count);
                } catch (error) {
                    console.error('⚠️ 数据加载回调函数执行时出错（但数据已成功获取）:', error);
                    callbackError = error;
                    // 不抛出错误，因为数据已经成功获取，只是处理时出现问题
                }
            }

            // 完成
            updateLoadingProgress('加载完成！', 100);

            // 延迟关闭进度提示
            // 即使回调函数出错，数据也已经成功获取，所以显示成功消息
            setTimeout(() => {
                hideLoadingProgress();
                if (callbackError) {
                    console.warn('⚠️ 数据已成功加载，但处理过程中出现了一些问题:', callbackError);
                    // 仍然显示成功消息，因为数据已经加载
                }
                if (isAggregated) {
                    const intervalText = interval >= 3600 ? `${interval / 3600}小时` :
                        interval >= 60 ? `${interval / 60}分钟` : `${interval}秒`;
                    showNotification(`✅ 已加载 ${result.count} 条数据（原始 ${originalCount} 条，已聚合优化，间隔：${intervalText}）`, false, 5000);
                } else {
                    showNotification(`✅ 成功加载 ${result.count} 条数据`);
                }
            }, 500);
        } else {
            console.error('❌ API返回失败:', result);
            hideLoadingProgress();
            showNotification(`❌ 加载数据失败: ${result.error || '未知错误'}`, true);
        }
    } catch (error) {
        console.error('❌ 加载数据出错：', error);
        hideLoadingProgress();
        showNotification(`❌ 加载数据出错: ${error.message}`, true);
    } finally {
        // 恢复加载状态
        isDataLoading = false;
        enableLoadButtons();
    }
}

/**
 * 禁用所有加载按钮
 */
function disableLoadButtons() {
    // 禁用模态框中的所有按钮
    const buttons = document.querySelectorAll('.load-btn-primary, .load-btn-secondary, .load-option, .confirm-btn');
    buttons.forEach(btn => {
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.style.cursor = 'not-allowed';
        btn.style.pointerEvents = 'none';
    });

    // 禁用主加载按钮
    const mainLoadBtn = document.querySelector('[onclick*="openLoadModal"]');
    if (mainLoadBtn) {
        mainLoadBtn.disabled = true;
        mainLoadBtn.style.opacity = '0.5';
        mainLoadBtn.style.cursor = 'not-allowed';
        mainLoadBtn.style.pointerEvents = 'none';
    }
}

/**
 * 启用所有加载按钮
 */
function enableLoadButtons() {
    // 启用模态框中的所有按钮
    const buttons = document.querySelectorAll('.load-btn-primary, .load-btn-secondary, .load-option, .confirm-btn');
    buttons.forEach(btn => {
        btn.disabled = false;
        btn.style.opacity = '';
        btn.style.cursor = '';
        btn.style.pointerEvents = '';
    });

    // 启用主加载按钮
    const mainLoadBtn = document.querySelector('[onclick*="openLoadModal"]');
    if (mainLoadBtn) {
        mainLoadBtn.disabled = false;
        mainLoadBtn.style.opacity = '';
        mainLoadBtn.style.cursor = '';
        mainLoadBtn.style.pointerEvents = '';
    }
}

/**
 * 确保加载模态框存在
 */
function ensureLoadModalExists() {
    if (document.getElementById('loadModal')) return;

    const html = `
    <div id="loadModal" class="load-modal">
        <div class="load-content">
            <div class="load-title">
                <span>📊</span>
                <span id="loadModalTitle">选择加载方式</span>
            </div>

            <!-- 选择加载方式 -->
            <div id="loadChoiceView">
                <div class="load-option" onclick="showLoadForm('count')">
                    <div class="load-option-title"><span>📝</span><span>按最近条数加载</span></div>
                    <div class="load-option-desc">加载最近的N条数据记录</div>
                </div>
                <div class="load-option" onclick="showLoadForm('time')">
                    <div class="load-option-title"><span>⏱️</span><span>按最近时间加载</span></div>
                    <div class="load-option-desc">加载最近几分钟/小时/天/月的数据</div>
                </div>
                <div class="load-option" onclick="showLoadForm('range')">
                    <div class="load-option-title"><span>📅</span><span>自定义时间范围</span></div>
                    <div class="load-option-desc">选择开始和结束时间，精确加载</div>
                </div>
                <div class="load-option" onclick="showLoadAllConfirm()">
                    <div class="load-option-title"><span>⚠️</span><span>加载全部数据</span></div>
                    <div class="load-option-desc">加载数据库中的所有历史数据（可能需要较长时间）</div>
                </div>
            </div>

            <!-- 按最近条数加载表单 -->
            <div id="loadFormCount" class="load-form-view" style="display: none;">
                <div id="deviceSelectGroup" class="form-group" style="display: none;">
                    <label class="form-label">选择设备</label>
                    <div class="form-input-group">
                        <select class="form-input" id="loadDeviceSelect">
                            <option value="all">全部设备</option>
                        </select>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">数据条数</label>
                    <div class="form-input-group">
                        <input type="number" class="form-input" id="loadCountInput" placeholder="例如：1000" min="1" value="1000">
                        <span style="color: var(--muted); font-size: 13px;">条</span>
                    </div>
                </div>
                <div class="load-actions">
                    <button class="load-btn load-btn-secondary" onclick="backToChoice()">返回</button>
                    <button class="load-btn load-btn-primary" onclick="loadByCount()">加载数据</button>
                </div>
            </div>

            <!-- 按时间段加载表单 -->
            <div id="loadFormTime" class="load-form-view" style="display: none;">
                <div id="deviceSelectGroupTime" class="form-group" style="display: none;">
                    <label class="form-label">选择设备</label>
                    <div class="form-input-group">
                        <select class="form-input" id="loadDeviceSelectTime">
                            <option value="all">全部设备</option>
                        </select>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">时间数量</label>
                    <div class="form-input-group">
                        <input type="number" class="form-input" id="loadTimeValue" placeholder="例如：1" min="1" value="1">
                        <select class="form-input" id="loadTimeUnit">
                            <option value="minute">分钟</option>
                            <option value="hour" selected>小时</option>
                            <option value="day">天</option>
                            <option value="month">月</option>
                        </select>
                    </div>
                </div>
                <div class="load-actions">
                    <button class="load-btn load-btn-secondary" onclick="backToChoice()">返回</button>
                    <button class="load-btn load-btn-primary" onclick="loadByTime()">加载数据</button>
                </div>
            </div>

            <!-- 自定义时间范围表单 -->
            <div id="loadFormRange" class="load-form-view" style="display: none;">
                <div id="deviceSelectGroupRange" class="form-group" style="display: none;">
                    <label class="form-label">选择设备</label>
                    <div class="form-input-group">
                        <select class="form-input" id="loadDeviceSelectRange">
                            <option value="all">全部设备</option>
                        </select>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">开始时间</label>
                    <input type="datetime-local" class="form-input" id="loadStartTime">
                </div>
                <div class="form-group">
                    <label class="form-label">结束时间</label>
                    <input type="datetime-local" class="form-input" id="loadEndTime">
                </div>
                <div class="load-actions">
                    <button class="load-btn load-btn-secondary" onclick="backToChoice()">返回</button>
                    <button class="load-btn load-btn-primary" onclick="loadByRange()">加载数据</button>
                </div>
            </div>

            <!-- 取消按钮（仅在选择界面显示） -->
            <div class="load-actions" id="loadChoiceActions">
                <button class="load-btn load-btn-secondary" onclick="closeLoadModal()">取消</button>
            </div>
        </div>
    </div>
    `;

    document.body.insertAdjacentHTML('beforeend', html);

    // 设置点击外部关闭（统一使用 setupModalClickOutside）
    setupModalClickOutside();
}

/**
 * 确保确认模态框存在
 */
function ensureConfirmModalExists() {
    if (document.getElementById('confirmModal')) {
        // 如果弹窗已存在，确保事件监听器已设置
        setupModalClickOutside();
        return;
    }

    const html = `
    <div id="confirmModal" class="confirm-modal">
        <div class="confirm-content">
            <div class="confirm-icon">⚠️</div>
            <div class="confirm-title">加载全部数据</div>
            <div class="confirm-message">
                您即将加载数据库中的<strong>全部历史数据</strong>。<br>
                这可能包含数千甚至数万条记录，将会：<br>
                • 清空当前图表中的数据<br>
                • 需要较长的加载时间<br>
                • 可能导致页面卡顿<br><br>
                确定要继续吗？
            </div>
            <div class="confirm-actions">
                <button class="confirm-btn confirm-btn-cancel" onclick="closeConfirmModal()">取消</button>
                <button class="confirm-btn confirm-btn-danger" onclick="confirmLoadAll()">确定加载</button>
            </div>
        </div>
    </div>
    `;

    document.body.insertAdjacentHTML('beforeend', html);

    // 设置点击外部关闭（统一使用 setupModalClickOutside）
    setupModalClickOutside();
}

/**
 * 确保数据量警告模态框存在
 */
function ensureLargeDataWarningModalExists() {
    if (document.getElementById('largeDataWarningModal')) {
        // 如果弹窗已存在，确保事件监听器已设置
        setupModalClickOutside();
        return;
    }

    const html = `
    <div id="largeDataWarningModal" class="confirm-modal">
        <div class="confirm-content">
            <div class="confirm-icon">⚠️</div>
            <div class="confirm-title">数据量较大</div>
            <div class="confirm-message">
                该时间范围内有 <strong id="largeDataCount">0</strong> 条数据。<br>
                加载大量数据可能会：<br>
                • 需要较长的加载时间<br>
                • 导致页面卡顿<br>
                • 影响浏览体验<br><br>
                <strong style="color: var(--warn);">建议：</strong><br>
                • 缩小时间范围<br>
                • 或使用"按条数加载"功能<br><br>
                确定要继续加载吗？
            </div>
            <div class="confirm-actions">
                <button class="confirm-btn confirm-btn-cancel" onclick="closeLargeDataWarning()">取消</button>
                <button class="confirm-btn confirm-btn-danger" onclick="confirmLargeDataLoad()">确定加载</button>
            </div>
        </div>
    </div>
    `;

    document.body.insertAdjacentHTML('beforeend', html);

    // 设置点击外部关闭（统一使用 setupModalClickOutside）
    setupModalClickOutside();
}

/**
 * 设置弹窗点击外部关闭功能
 * 统一管理所有加载数据相关弹窗的事件监听器
 * 使用 data-click-outside-setup 属性避免重复添加事件监听器
 */
function setupModalClickOutside() {
    // 1. 加载数据主弹窗
    const loadModal = document.getElementById('loadModal');
    if (loadModal && !loadModal.hasAttribute('data-click-outside-setup')) {
        loadModal.setAttribute('data-click-outside-setup', 'true');
        loadModal.addEventListener('click', function (e) {
            if (e.target === loadModal) {
                closeLoadModal();
            }
        });

        const loadContent = loadModal.querySelector('.load-content');
        if (loadContent) {
            loadContent.addEventListener('click', function (e) {
                e.stopPropagation();
            });
        }
    }

    // 2. 加载全部数据确认框
    const confirmModal = document.getElementById('confirmModal');
    if (confirmModal && !confirmModal.hasAttribute('data-click-outside-setup')) {
        confirmModal.setAttribute('data-click-outside-setup', 'true');
        confirmModal.addEventListener('click', function (e) {
            if (e.target === confirmModal) {
                closeConfirmModal();
            }
        });

        const confirmContent = confirmModal.querySelector('.confirm-content');
        if (confirmContent) {
            confirmContent.addEventListener('click', function (e) {
                e.stopPropagation();
            });
        }
    }

    // 3. 数据量过大警告框
    const largeDataWarningModal = document.getElementById('largeDataWarningModal');
    if (largeDataWarningModal && !largeDataWarningModal.hasAttribute('data-click-outside-setup')) {
        largeDataWarningModal.setAttribute('data-click-outside-setup', 'true');
        largeDataWarningModal.addEventListener('click', function (e) {
            if (e.target === largeDataWarningModal) {
                closeLargeDataWarning();
            }
        });

        const warningContent = largeDataWarningModal.querySelector('.confirm-content');
        if (warningContent) {
            warningContent.addEventListener('click', function (e) {
                e.stopPropagation();
            });
        }
    }
}

// ==================== 加载进度提示 ====================

/**
 * 显示加载进度
 */
function showLoadingProgress(message = '正在加载...', percent = 0) {
    ensureLoadingProgressExists();

    const modal = document.getElementById('loadingProgressModal');
    const messageEl = document.getElementById('loadingProgressMessage');
    const percentEl = document.getElementById('loadingProgressPercent');
    const barEl = document.getElementById('loadingProgressBar');

    if (modal) {
        modal.classList.add('show');
    }

    if (messageEl) {
        messageEl.textContent = message;
    }

    if (percentEl) {
        percentEl.textContent = `${Math.round(percent)}%`;
    }

    if (barEl) {
        barEl.style.width = `${percent}%`;
    }
}

/**
 * 更新加载进度
 */
function updateLoadingProgress(message, percent) {
    const messageEl = document.getElementById('loadingProgressMessage');
    const percentEl = document.getElementById('loadingProgressPercent');
    const barEl = document.getElementById('loadingProgressBar');

    if (messageEl) {
        messageEl.textContent = message;
    }

    if (percentEl) {
        percentEl.textContent = `${Math.round(percent)}%`;
    }

    if (barEl) {
        barEl.style.width = `${percent}%`;
    }
}

/**
 * 隐藏加载进度
 */
function hideLoadingProgress() {
    const modal = document.getElementById('loadingProgressModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

/**
 * 确保加载进度模态框存在
 */
function ensureLoadingProgressExists() {
    if (document.getElementById('loadingProgressModal')) return;

    const html = `
    <div id="loadingProgressModal" class="loading-progress-modal">
        <div class="loading-progress-content">
            <div class="loading-progress-spinner">
                <div class="spinner"></div>
            </div>
            <div class="loading-progress-message" id="loadingProgressMessage">正在加载...</div>
            <div class="loading-progress-bar-container">
                <div class="loading-progress-bar" id="loadingProgressBar"></div>
            </div>
            <div class="loading-progress-percent" id="loadingProgressPercent">0%</div>
        </div>
    </div>
    `;

    document.body.insertAdjacentHTML('beforeend', html);

    // 添加样式
    if (!document.getElementById('loadingProgressStyles')) {
        const style = document.createElement('style');
        style.id = 'loadingProgressStyles';
        style.textContent = `
            .loading-progress-modal {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                display: none;
                align-items: center;
                justify-content: center;
                z-index: 10000;
                backdrop-filter: blur(4px);
            }
            
            .loading-progress-modal.show {
                display: flex;
                animation: fadeIn 0.2s ease;
            }
            
            .loading-progress-content {
                background: var(--card);
                border-radius: 16px;
                padding: 32px 40px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
                min-width: 320px;
                text-align: center;
                animation: slideUp 0.3s ease;
            }
            
            .loading-progress-spinner {
                margin-bottom: 20px;
            }
            
            .spinner {
                width: 48px;
                height: 48px;
                margin: 0 auto;
                border: 4px solid var(--bd);
                border-top-color: var(--primary);
                border-radius: 50%;
                animation: spin 1s linear infinite;
            }
            
            @keyframes spin {
                to { transform: rotate(360deg); }
            }
            
            @keyframes fadeIn {
                from {
                    opacity: 0;
                }
                to {
                    opacity: 1;
                }
            }
            
            @keyframes slideUp {
                from {
                    opacity: 0;
                    transform: translateY(20px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }
            
            .loading-progress-message {
                font-size: 16px;
                font-weight: 500;
                color: var(--text);
                margin-bottom: 16px;
            }
            
            .loading-progress-bar-container {
                width: 100%;
                height: 8px;
                background: var(--bd);
                border-radius: 4px;
                overflow: hidden;
                margin-bottom: 12px;
            }
            
            .loading-progress-bar {
                height: 100%;
                background: linear-gradient(90deg, var(--primary), var(--good));
                border-radius: 4px;
                width: 0%;
                transition: width 0.3s ease;
            }
            
            .loading-progress-percent {
                font-size: 24px;
                font-weight: 700;
                color: var(--primary);
                font-variant-numeric: tabular-nums;
            }
        `;
        document.head.appendChild(style);
    }
}

// ==================== 帮助弹窗系统 ====================

// 防止重复初始化的标志
let helpModalInitialized = false;
let aboutModalInitialized = false;

// ==================== 更新日志数据 ====================
// 更新日志数据已迁移至 web/changelog-data.js 并作为全局常量提供。
/**
 * 生成使用帮助弹窗的HTML
 * @returns {string} HTML字符串
 */
function generateHelpModalHTML() {
    return `
    <!-- 帮助弹窗 -->
    <div id="helpModal" class="help-modal">
        <div class="help-content">
            <div class="help-header">
                <div class="help-title">
                    <span>💡</span>
                    <span>使用帮助</span>
                </div>
                <button class="help-close-btn" onclick="closeHelp()" title="关闭">×</button>
            </div>
            <div class="help-body">
                <div class="help-section">
                    <div class="help-section-title">
                        <span>🎯</span>
                        <span>系统功能</span>
                    </div>
                    <div class="help-section-content">
                        本系统是基于 STM32 和物联网的智能环境监测系统，可以实时监测和分析环境数据，支持多设备管理。
                        <div class="help-feature">
                            <div class="help-feature-title">📱 设备总览</div>
                            <div class="help-feature-desc">首页显示所有已配置的设备，实时显示每个设备的在线状态、最新数据和警告信息，点击设备卡片可查看详细数据</div>
                        </div>
                        <div class="help-feature">
                            <div class="help-feature-title">📊 实时监测</div>
                            <div class="help-feature-desc">实时显示温度、湿度、亮度、烟雾浓度和大气压数据，通过 WebSocket 自动更新，支持蓝牙和MQTT双数据源</div>
                        </div>
                        <div class="help-feature">
                            <div class="help-feature-title">📈 数据可视化</div>
                            <div class="help-feature-desc">提供多种图表展示历史数据趋势，支持缩放、拖拽、Alt+框选放大和全屏查看，支持查看最多5万条数据</div>
                        </div>
                        <div class="help-feature">
                            <div class="help-feature-title">📉 数据分析</div>
                            <div class="help-feature-desc">统计分析功能，查看平均值、最大值、最小值等数据指标，支持多维度数据分析，集成AI助手提供智能分析</div>
                        </div>
                        <div class="help-feature">
                            <div class="help-feature-title">💾 历史数据</div>
                            <div class="help-feature-desc">支持多种方式加载历史数据：按条数、按时间段或自定义范围，系统会根据数据量自动优化加载速度</div>
                        </div>
                        <div class="help-feature">
                            <div class="help-feature-title">🔋 省电控制</div>
                            <div class="help-feature-desc">支持远程控制MQ2烟雾传感器、BMP180气压传感器、BH1750亮度传感器、BLE蓝牙和OLED显示屏的开关，提供多种省电模式（省电/平衡/安全/不省电）</div>
                        </div>
                        <div class="help-feature">
                            <div class="help-feature-title">📍 设备定位</div>
                            <div class="help-feature-desc">支持通过LBS基站定位获取设备位置，集成高德地图API实时显示设备地理位置</div>
                        </div>
                        <div class="help-feature">
                            <div class="help-feature-title">🔔 消息中心</div>
                            <div class="help-feature-desc">实时接收来自STM32的异常数据警告，支持警告类型筛选、状态筛选、日期筛选，所有警告记录保存在数据库中</div>
                        </div>
                        <div class="help-feature">
                            <div class="help-feature-title">⚠️ 智能预警</div>
                            <div class="help-feature-desc">当传感器数据超出安全阈值时，系统会自动发出警告，卡片会显示橙色或红色边框提醒，危险状态会有跑马灯效果</div>
                        </div>
                    </div>
                </div>

                <div class="help-section">
                    <div class="help-section-title">
                        <span>🚀</span>
                        <span>快速开始</span>
                    </div>
                    <div class="help-section-content">
                        <ul class="help-list">
                            <li><strong>设备总览页面</strong>：首页显示所有设备，点击设备卡片可进入实时数据页面</li>
                            <li>系统会自动连接 WebSocket 服务器，连接成功后状态会显示为"已连接"</li>
                            <li>点击连接状态徽章可以查看详细连接信息（WebSocket、蓝牙、MQTT）</li>
                            <li>实时数据页面显示最新的传感器数据和趋势变化</li>
                            <li>点击图表右上角的 ⤢ 按钮可以半全屏查看图表详情</li>
                            <li>使用鼠标滚轮或双指手势可以缩放图表</li>
                            <li>点击右上角"⚙️ 功能"菜单可以访问更多功能（数据分析、消息中心、省电控制等）</li>
                            <li>点击"📊 加载数据"可以从数据库加载历史数据</li>
                            <li>点击"🔋 省电控制"可以远程控制传感器和模块的开关</li>
                        </ul>
                    </div>
                </div>

                <div class="help-section">
                    <div class="help-section-title">
                        <span>📚</span>
                        <span>功能说明</span>
                    </div>
                    <div class="help-section-content">
                        <ul class="help-list">
                            <li><strong>设备总览</strong>：首页显示所有已配置的设备，实时显示在线状态、最新数据和警告信息</li>
                            <li><strong>数据分析</strong>：查看详细的统计分析和数据报告，包括各传感器的平均值、最大值、最小值等，集成AI助手提供智能分析</li>
                            <li><strong>加载数据</strong>：从数据库加载历史数据到图表中，支持按条数、按时间段、自定义范围或加载全部</li>
                            <li><strong>省电控制</strong>：远程控制MQ2、BMP180、BH1750、BLE和OLED的开关，支持多种省电模式（省电/平衡/安全/不省电）</li>
                            <li><strong>消息中心</strong>：查看所有警告消息，支持按类型、状态和日期筛选，所有警告记录保存在数据库中</li>
                            <li><strong>设备定位</strong>：获取并显示设备的地理位置，支持在地图上查看，集成高德地图API</li>
                            <li><strong>切换主题</strong>：在明亮和深色主题之间切换，支持跟随系统设置</li>
                            <li><strong>科普按钮 (i)</strong>：点击每个传感器旁边的 i 按钮了解相关知识</li>
                            <li><strong>趋势指示</strong>：每个数据卡片下方显示数据变化趋势（上升/下降/稳定）</li>
                            <li><strong>连接状态</strong>：实时显示WebSocket、蓝牙和MQTT连接状态，支持查看详细信息</li>
                            <li><strong>多设备支持</strong>：系统支持同时管理多个设备（D01、D02等），每个设备独立显示数据</li>
                        </ul>
                    </div>
                </div>

                <div class="help-section">
                    <div class="help-section-title">
                        <span>⌨️</span>
                        <span>图表操作</span>
                    </div>
                    <div class="help-section-content">
                        <ul class="help-list">
                            <li><strong>鼠标滚轮</strong>：在图表上滚动可以缩放图表（仅X轴）</li>
                            <li><strong>拖拽</strong>：按住鼠标左键拖动可以平移图表查看不同时间段的数据</li>
                            <li><strong>Alt(⌥) + 框选</strong>：按住Alt键并框选区域可以精确放大选中区域</li>
                            <li><strong>双击</strong>：双击图表可以重置图表到初始状态</li>
                            <li><strong>缩放按钮</strong>：使用图表上方的 🔍+ 和 🔍- 按钮可以放大和缩小</li>
                            <li><strong>平移按钮</strong>：使用 ← 和 → 按钮可以左右平移查看历史数据</li>
                            <li><strong>重置按钮</strong>：点击 🔄 按钮可以恢复图表到初始状态并开启实时跟随</li>
                            <li><strong>全屏按钮</strong>：点击图表右下角的 ⤢ 按钮可以半全屏查看图表详情</li>
                        </ul>
                    </div>
                </div>

                <div class="help-section">
                    <div class="help-section-title">
                        <span>📱</span>
                        <span>移动端支持</span>
                    </div>
                    <div class="help-section-content">
                        <ul class="help-list">
                            <li>系统完全支持移动端访问，响应式设计适配各种屏幕尺寸</li>
                            <li>支持双指手势缩放图表，单指拖动平移查看数据</li>
                            <li>支持添加到主屏幕，可作为PWA应用使用</li>
                            <li>移动端优化了连接状态弹窗的显示位置，确保不超出屏幕</li>
                        </ul>
                    </div>
                </div>

                <div class="help-section">
                    <div class="help-section-title">
                        <span>💬</span>
                        <span>提示</span>
                    </div>
                    <div class="help-section-content">
                        如有问题，请检查 WebSocket 连接状态。系统会自动重连，如果长时间无法连接，请检查：
                        <ul class="help-list" style="margin-top: 8px;">
                            <li>网络连接是否正常</li>
                            <li>后端服务器是否正在运行</li>
                            <li>防火墙是否阻止了WebSocket连接</li>
                            <li>浏览器控制台是否有错误信息</li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    </div>
    `;
}

/**
 * 创建使用帮助弹窗（动态插入到页面）
 */
function createHelpModal() {
    // 检查是否已经存在
    if (document.getElementById('helpModal')) {
        console.log('⚠️ 帮助弹窗已存在，跳过创建');
        return;
    }

    // 创建临时容器来解析HTML
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = generateHelpModalHTML();

    // 将弹窗插入到body中
    const helpModal = tempDiv.firstElementChild;
    document.body.appendChild(helpModal);

    console.log('✅ 使用帮助弹窗已创建');
}

/**
 * 生成关于项目弹窗的HTML
 * @returns {string} HTML字符串
 */
function generateAboutModalHTML() {
    const changelogHTML = CHANGELOG_DATA.map(item => `
        <div class="changelog-item">
            <div class="changelog-version">${item.version}${item.isImportant === 1 ? ' <img src="/resource/important.svg" alt="重要" class="important-icon" style="width: 20px; height: 20px; vertical-align: middle;margin-bottom: 3px" title="重要更新">' : ''}</div>
            <div class="changelog-date">${item.date}</div>
            <ul class="changelog-content">
                ${item.items.map(li => `<li>${li}</li>`).join('')}
            </ul>
        </div>
    `).join('');

    return `
    <!-- 关于项目弹窗 -->
    <div id="aboutModal" class="help-modal">
        <div class="help-content">
            <div class="help-header">
                <div class="help-title">
                    <span>ℹ️</span>
                    <span>关于项目</span>
                </div>
                <button class="help-close-btn" onclick="closeAbout()" title="关闭">×</button>
            </div>
            <div class="help-body">
                <!-- 头像区域 -->
                <div style="display: flex; justify-content: center; margin-bottom: 24px;">
                    <img id="aboutAvatar" src="/resource/img.jpg" alt="头像" style="width: 120px; height: 120px; border-radius: 50%; object-fit: cover; border: 3px solid var(--bd); box-shadow: var(--shadow); cursor: pointer; transition: transform 0.3s ease, box-shadow 0.3s ease;" title="点击查看彩蛋 🎉">
                </div>
                
                <!-- 图标链接区域 -->
                <div style="display: flex; justify-content: center; align-items: center; gap: 16px; margin-bottom: 24px; flex-wrap: wrap;">
                    <a href="https://github.com/longmxuc" target="_blank" rel="noopener noreferrer" class="about-link-btn" style="display: flex; align-items: center; gap: 8px; text-decoration: none; color: var(--text); padding: 10px 18px; border: 1px solid var(--bd); border-radius: 8px; transition: all 0.2s ease; background: var(--bg);">
                        <img src="/resource/github.svg" alt="GitHub" style="width: 20px; height: 20px; filter: brightness(0.9);">
                        <span style="font-size: 14px; font-weight: 500;">GitHub</span>
                    </a>
                    <a href="https://gitee.com/Cdaozi" target="_blank" rel="noopener noreferrer" class="about-link-btn" style="display: flex; align-items: center; gap: 8px; text-decoration: none; color: var(--text); padding: 10px 18px; border: 1px solid var(--bd); border-radius: 8px; transition: all 0.2s ease; background: var(--bg);">
                        <img src="/resource/gitee.svg" alt="Gitee" style="width: 20px; height: 20px; filter: brightness(0.9);">
                        <span style="font-size: 14px; font-weight: 500;">Gitee</span>
                    </a>
                    <button onclick="openHelp()" class="about-help-btn" style="display: flex; align-items: center; gap: 8px; padding: 10px 18px; border: 1px solid var(--bd); border-radius: 8px; background: var(--bg); color: var(--text); cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s ease;">
                        <span>❓</span>
                        <span>使用帮助</span>
                    </button>
                </div>
                
                <!-- 项目介绍 -->
                <div style="background: var(--bg); border: 1px solid var(--bd); border-radius: 8px; padding: 16px; margin-bottom: 24px; text-align: left;">
                    <div style="color: var(--text); font-size: 14px; line-height: 1.6;text-indent: 2em;text-align: justify">
                        本项目是一个基于STM32和物联网技术的智能环境监测系统，实现了温度、湿度、亮度、烟雾浓度和大气压等多参数实时监测。主要使用技术栈:嵌入式C语言、数字电子技术、模拟电子技术、MQTT、FastAPI、WebSocket、HTML5、ECMAScrip6、MySQL8.0、Docker
                    </div>
                </div>
                
                <!-- 分隔线 -->
                <div style="height: 1px; background: var(--bd); margin: 24px 0;"></div>
                
                <!-- 更新日志区域 -->
                <div class="help-section">
                    <div class="help-section-title">
                        <span>📝</span>
                        <span>更新日志</span>
                    </div>
                    <div class="help-section-content" style="max-height: 700px; overflow-y: auto; margin-left: 0;">
                        <div class="changelog-list">
                            ${changelogHTML}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    `;
}

/**
 * 创建关于项目弹窗（动态插入到页面）
 */
function createAboutModal() {
    // 检查是否已经存在
    if (document.getElementById('aboutModal')) {
        console.log('⚠️ 关于项目弹窗已存在，跳过创建');
        return;
    }

    // 创建临时容器来解析HTML
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = generateAboutModalHTML();

    // 将弹窗插入到body中
    const aboutModal = tempDiv.firstElementChild;
    document.body.appendChild(aboutModal);

    console.log('✅ 关于项目弹窗已创建');
}

/**
 * 打开帮助弹窗
 */
function openHelp() {
    const helpModal = document.getElementById('helpModal');
    if (helpModal) {
        // 如果关于项目弹窗是打开的，先关闭它
        closeAbout();
        helpModal.classList.add('show');
        document.body.style.overflow = 'hidden';
        console.log('💡 打开帮助弹窗');
    } else {
        console.error('❌ 帮助弹窗元素未找到');
    }
}

/**
 * 关闭帮助弹窗
 */
function closeHelp() {
    const helpModal = document.getElementById('helpModal');
    if (helpModal) {
        helpModal.classList.remove('show');
        document.body.style.overflow = '';
        console.log('💡 关闭帮助弹窗');
    }
}

/**
 * 初始化帮助弹窗
 */
function initHelpModal() {
    // 防止重复初始化
    if (helpModalInitialized) {
        console.log('⚠️ 帮助弹窗已初始化，跳过重复初始化');
        return;
    }

    // 先创建弹窗（如果不存在）
    createHelpModal();

    const helpModal = document.getElementById('helpModal');

    if (helpModal) {
        // 点击背景关闭帮助弹窗
        helpModal.addEventListener('click', function (e) {
            // 点击的是遮罩层本身（不是内容区域）
            if (e.target === helpModal || e.target.classList.contains('help-modal')) {
                closeHelp();
                console.log('💡 点击背景关闭帮助弹窗');
            }
        });

        // 防止点击内容区域关闭弹窗
        const helpContent = helpModal.querySelector('.help-content');
        if (helpContent) {
            helpContent.addEventListener('click', function (e) {
                e.stopPropagation();
            });
        }

        helpModalInitialized = true;
        console.log('✅ 帮助弹窗已初始化');
    } else {
        console.error('❌ 帮助弹窗元素未找到');
    }
}

/**
 * 打开关于项目弹窗
 */
function openAbout() {
    const aboutModal = document.getElementById('aboutModal');
    if (aboutModal) {
        aboutModal.classList.add('show');
        document.body.style.overflow = 'hidden';
        console.log('ℹ️ 打开关于项目弹窗');
    } else {
        console.error('❌ 关于项目弹窗元素未找到');
    }
}

/**
 * 关闭关于项目弹窗
 */
function closeAbout() {
    const aboutModal = document.getElementById('aboutModal');
    if (aboutModal) {
        aboutModal.classList.remove('show');
        document.body.style.overflow = '';
        console.log('ℹ️ 关闭关于项目弹窗');
    }
}

/**
 * 初始化关于项目弹窗
 */
function initAboutModal() {
    // 防止重复初始化
    if (aboutModalInitialized) {
        console.log('⚠️ 关于项目弹窗已初始化，跳过重复初始化');
        return;
    }

    // 先创建弹窗（如果不存在）
    createAboutModal();

    const aboutModal = document.getElementById('aboutModal');

    if (aboutModal) {
        // 点击背景关闭关于项目弹窗
        aboutModal.addEventListener('click', function (e) {
            // 点击的是遮罩层本身（不是内容区域）
            if (e.target === aboutModal || e.target.classList.contains('help-modal')) {
                closeAbout();
                console.log('ℹ️ 点击背景关闭关于项目弹窗');
            }
        });

        // 防止点击内容区域关闭弹窗
        const aboutContent = aboutModal.querySelector('.help-content');
        if (aboutContent) {
            aboutContent.addEventListener('click', function (e) {
                e.stopPropagation();
            });
        }

        // 为头像添加点击事件（彩蛋）
        const aboutAvatar = aboutModal.querySelector('#aboutAvatar');
        if (aboutAvatar) {
            // 添加悬停效果
            aboutAvatar.addEventListener('mouseenter', function () {
                this.style.transform = 'scale(1.1)';
                this.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.3)';
            });
            aboutAvatar.addEventListener('mouseleave', function () {
                this.style.transform = 'scale(1)';
                this.style.boxShadow = 'var(--shadow)';
            });

            // 点击头像跳转到彩蛋页面
            aboutAvatar.addEventListener('click', function () {
                // 先关闭关于项目弹窗
                closeAbout();

                // 延迟一点时间后跳转到彩蛋页面，让弹窗关闭动画完成
                setTimeout(() => {
                    window.location.href = '/easter.html';
                }, 300);
            });
        }

        aboutModalInitialized = true;
        console.log('✅ 关于项目弹窗已初始化');
    } else {
        console.error('❌ 关于项目弹窗元素未找到');
    }
}


/**
 * 检查首次访问并显示帮助
 */
function checkFirstVisit() {
    const hasVisited = localStorage.getItem('lab-monitor-visited');
    if (!hasVisited) {
        // 首次访问，延迟1秒显示帮助弹窗
        setTimeout(() => {
            openHelp();
            // 标记为已访问
            localStorage.setItem('lab-monitor-visited', 'true');
            console.log('🎉 首次访问，显示帮助弹窗');
        }, 1000);
    }
}

// ==================== 功能菜单系统 ====================

// 防止重复初始化的标志
let functionMenuInitialized = false;

/**
 * 初始化功能菜单
 */
function initFunctionMenu() {
    // 防止重复初始化
    if (functionMenuInitialized) {
        console.log('⚠️ 功能菜单已初始化，跳过重复初始化');
        return;
    }

    const menuBtn = document.getElementById('menuBtn');
    const menuDropdown = document.getElementById('menuDropdown');
    const menuArrow = document.getElementById('menuArrow');

    if (menuBtn && menuDropdown) {
        // 确保初始状态正确：菜单应该是关闭的
        menuDropdown.classList.remove('show');
        menuBtn.classList.remove('active');
        if (menuArrow) {
            menuArrow.style.transform = 'rotate(0deg)';
        }
        console.log('🔧 重置菜单初始状态为关闭');

        // 点击菜单按钮
        menuBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            const isShowing = menuDropdown.classList.toggle('show');
            menuBtn.classList.toggle('active', isShowing);
            if (menuArrow) {
                menuArrow.style.transform = isShowing ? 'rotate(180deg)' : 'rotate(0deg)';
            }
        });

        // 点击页面其他地方关闭菜单
        document.addEventListener('click', function (e) {
            // 排除设备选择弹窗和其他弹窗
            const deviceSelectModal = qs('#deviceSelectModal');
            const isInDeviceSelectModal = deviceSelectModal && (deviceSelectModal.contains(e.target) || deviceSelectModal === e.target);
            
            // 如果点击的不是菜单相关元素，也不是设备选择弹窗，则关闭菜单
            if (!menuBtn.contains(e.target) && !menuDropdown.contains(e.target) && !isInDeviceSelectModal) {
                if (menuDropdown.classList.contains('show')) {
                    menuDropdown.classList.remove('show');
                    menuBtn.classList.remove('active');
                    if (menuArrow) {
                        menuArrow.style.transform = 'rotate(0deg)';
                    }
                    console.log('🔘 点击外部，关闭菜单');
                }
            }
        });

        // 防止点击菜单内容关闭菜单
        menuDropdown.addEventListener('click', function (e) {
            e.stopPropagation();
        });

        functionMenuInitialized = true;
        console.log('✅ 功能菜单已初始化');
    } else {
        console.error('❌ 功能菜单元素未找到');
    }

    // 绑定关于项目按钮（兼容新旧ID）
    const aboutBtn = document.getElementById('aboutBtn');
    const helpBtn = document.getElementById('helpBtn'); // 兼容旧的使用帮助按钮

    // 优先绑定aboutBtn，如果没有则绑定helpBtn（用于analysis.html的过渡）
    const targetBtn = aboutBtn || helpBtn;

    if (targetBtn) {
        // 如果是helpBtn，更新其显示文本和图标
        if (helpBtn && !aboutBtn) {
            helpBtn.id = 'aboutBtn'; // 更新ID
            const iconSpan = helpBtn.querySelector('span:first-child');
            const textSpan = helpBtn.querySelector('span:last-child');
            if (iconSpan) iconSpan.textContent = 'ℹ️';
            if (textSpan) textSpan.textContent = '关于项目';
            helpBtn.title = '关于项目';
        }

        targetBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            // 关闭菜单
            if (menuDropdown) {
                menuDropdown.classList.remove('show');
                if (menuBtn) {
                    menuBtn.classList.remove('active');
                }
                if (menuArrow) {
                    menuArrow.style.transform = 'rotate(0deg)';
                }
            }
            // 打开关于项目弹窗
            openAbout();
            console.log('ℹ️ 打开关于项目弹窗');
        });
        console.log('✅ 关于项目按钮已绑定');
    }
}

// ==================== 初始化 ====================

// 将图表交互函数暴露到全局作用域
window.makeBaseChartOptions = makeBaseChartOptions;
window.makeSingleAxisChartOptions = makeSingleAxisChartOptions;
window.bindChartButtons = bindChartButtons;
window.hardReset = hardReset;
window.enableManualDragPan = enableManualDragPan;
window.openOverlay = openOverlay;
window.closeOverlay = closeOverlay;
window.createFullscreenChart = createFullscreenChart;

// 将数据加载相关函数暴露到全局作用域
window.openLoadModal = openLoadModal;
window.showLoadForm = showLoadForm;
window.backToChoice = backToChoice;
window.loadByCount = loadByCount;
window.loadByTime = loadByTime;
window.loadByRange = loadByRange;
window.showLoadAllConfirm = showLoadAllConfirm;
window.confirmLoadAll = confirmLoadAll;
window.closeLoadAllDeviceSelect = closeLoadAllDeviceSelect;
window.confirmLoadAllDeviceSelect = confirmLoadAllDeviceSelect;
window.closeLargeDataWarning = closeLargeDataWarning;
window.confirmLargeDataLoad = confirmLargeDataLoad;

// 将帮助弹窗和菜单相关函数暴露到全局作用域
window.openHelp = openHelp;
window.closeHelp = closeHelp;
window.initHelpModal = initHelpModal;
window.createHelpModal = createHelpModal;
window.generateHelpModalHTML = generateHelpModalHTML;
window.openAbout = openAbout;
window.closeAbout = closeAbout;
window.initAboutModal = initAboutModal;
window.createAboutModal = createAboutModal;
window.generateAboutModalHTML = generateAboutModalHTML;
window.checkFirstVisit = checkFirstVisit;
window.initFunctionMenu = initFunctionMenu;

// 将时间格式化函数暴露到全局作用域
window.formatTimeLabel = formatTimeLabel;
window.makeTimeLabelFormatter = makeTimeLabelFormatter;

// ==================== 消息中心功能 ====================

/**
 * 消息中心管理器
 */
window.MessageCenter = {
    unreadWarningCount: 0,
    readMessageIds: new Set(), // 已读消息ID集合
    deviceUnreadMap: new Map(), // 每个设备的未读数量
    refreshInterval: null, // 自动刷新定时器
    selectedDate: null, // 选中的日期（格式：YYYY-MM-DD）
    warningDates: [], // 有数据的日期列表（格式：[{date: "YYYY-MM-DD", count: 数量}, ...]）
    currentDeviceId: null, // 当前筛选的设备ID（大写，如 D01）
    beforeOpenHook: null, // 自定义打开前钩子
    collapsedYears: new Set(), // 折叠的年份集合
    collapsedMonths: new Set(), // 折叠的月份集合（格式：YYYY-MM）

    /**
     * 设置打开前钩子
     * @param {Function|null} hook
     */
    setBeforeOpenHook: function (hook) {
        if (typeof hook === 'function') {
            this.beforeOpenHook = hook;
        } else {
            this.beforeOpenHook = null;
        }
    },

    /**
     * 从localStorage加载已读消息ID
     */
    loadReadMessageIds: function () {
        try {
            const readIds = localStorage.getItem('messageCenter_readIds');
            if (readIds) {
                this.readMessageIds = new Set(JSON.parse(readIds));
            }
        } catch (error) {
            console.error('加载已读消息ID失败:', error);
            this.readMessageIds = new Set();
        }
    },

    /**
     * 保存已读消息ID到localStorage
     */
    saveReadMessageIds: function () {
        try {
            localStorage.setItem('messageCenter_readIds', JSON.stringify(Array.from(this.readMessageIds)));
        } catch (error) {
            console.error('保存已读消息ID失败:', error);
        }
    },

    /**
     * 标记消息为已读
     */
    markAsRead: function (messageId, deviceId = null) {
        if (!messageId || this.readMessageIds.has(messageId)) {
            return;
        }
        this.readMessageIds.add(messageId);
        this.saveReadMessageIds();

        // 根据已读消息即时更新全局未读计数，提升反馈速度
        if (this.unreadWarningCount > 0) {
            this.unreadWarningCount = Math.max(0, this.unreadWarningCount - 1);
        }

        const normalizedDeviceId = this.normalizeDeviceId(deviceId);
        if (normalizedDeviceId && this.deviceUnreadMap.has(normalizedDeviceId)) {
            const next = this.deviceUnreadMap.get(normalizedDeviceId) - 1;
            if (next > 0) {
                this.deviceUnreadMap.set(normalizedDeviceId, next);
            } else {
                this.deviceUnreadMap.delete(normalizedDeviceId);
            }
        }

        this.updateUnreadCount();
        this.notifyDeviceUnreadUpdate();
    },

    /**
     * 获取当前活动的设备ID（优先使用人工选择的，其次使用页面上下文）
     */
    getActiveDeviceId: function () {
        if (this.currentDeviceId) {
            return this.currentDeviceId;
        }
        if (typeof window.getSelectedDeviceId === 'function') {
            const fallback = window.getSelectedDeviceId();
            if (fallback) {
                return String(fallback).trim().toUpperCase();
            }
        }
        return null;
    },

    /**
     * 统一设备ID格式
     */
    normalizeDeviceId: function (deviceId) {
        if (!deviceId && deviceId !== 0) return null;
        const normalized = String(deviceId).trim().toUpperCase();
        return normalized || null;
    },

    /**
     * 获取指定设备的未读数量
     */
    getDeviceUnreadCount: function (deviceId) {
        const normalized = this.normalizeDeviceId(deviceId);
        if (!normalized) return 0;
        return this.deviceUnreadMap.get(normalized) || 0;
    },

    /**
     * 获取所有有未读的设备列表
     */
    getDeviceUnreadSummary: function () {
        const list = [];
        this.deviceUnreadMap.forEach((count, deviceId) => {
            if (count > 0) {
                list.push({deviceId, count});
            }
        });
        return list.sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            return a.deviceId.localeCompare(b.deviceId);
        });
    },

    /**
     * 更新内部设备未读映射
     */
    setDeviceUnreadMap: function (messages) {
        this.deviceUnreadMap = new Map();
        (messages || []).forEach(msg => {
            const deviceId = this.normalizeDeviceId(msg.device_id);
            if (!deviceId) return;
            const prev = this.deviceUnreadMap.get(deviceId) || 0;
            this.deviceUnreadMap.set(deviceId, prev + 1);
        });
        this.notifyDeviceUnreadUpdate();
    },

    /**
     * 分发设备未读更新事件，供设备选择器侦听
     */
    notifyDeviceUnreadUpdate: function () {
        if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
            return;
        }
        try {
            window.dispatchEvent(new CustomEvent('messagecenter:unread-update', {
                detail: {
                    total: this.unreadWarningCount,
                    devices: this.getDeviceUnreadSummary()
                }
            }));
        } catch (error) {
            console.warn('派发 messagecenter:unread-update 事件失败:', error);
        }
    },

    /**
     * 设置消息中心的设备筛选
     * @param {string|null} deviceId - 设备ID（如 D01），为空则查看全部
     */
    setDeviceFilter: function (deviceId) {
        const normalized = deviceId && String(deviceId).trim()
            ? String(deviceId).trim().toUpperCase()
            : null;
        this.currentDeviceId = normalized;
        this.updateDeviceIndicator();
        const panel = qs('#messageCenterPanel');
        if (panel && panel.classList.contains('open')) {
            this.loadWarningDates();
            this.loadWarningMessages();
        }
    },

    /**
     * 更新消息中心标题旁的设备指示器
     */
    updateDeviceIndicator: function () {
        const panel = qs('#messageCenterPanel');
        if (!panel) return;
        const header = panel.querySelector('.message-center-title');
        if (!header) return;
        let indicator = header.querySelector('.message-device-indicator');
        if (!indicator) {
            indicator = document.createElement('span');
            indicator.className = 'message-device-indicator';
            indicator.style.marginLeft = '8px';
            indicator.style.fontSize = '12px';
            indicator.style.color = 'var(--muted)';
            indicator.style.display = 'none';
            header.appendChild(indicator);
        }
        const deviceId = this.getActiveDeviceId();
        if (deviceId) {
            indicator.textContent = `· 设备 ${deviceId}`;
            indicator.style.display = 'inline-flex';
        } else {
            indicator.textContent = '';
            indicator.style.display = 'none';
        }
    },

    /**
     * 打开消息中心
     */
    open: async function () {
        if (typeof this.beforeOpenHook === 'function') {
            try {
                const hookResult = await this.beforeOpenHook();
                if (hookResult === false) {
                    return;
                }
                if (hookResult && typeof hookResult === 'string' && typeof this.setDeviceFilter === 'function') {
                    this.setDeviceFilter(hookResult);
                } else if (hookResult && typeof hookResult === 'object' && hookResult.deviceId && typeof this.setDeviceFilter === 'function') {
                    this.setDeviceFilter(hookResult.deviceId);
                }
            } catch (error) {
                console.error('消息中心 beforeOpenHook 执行失败:', error);
                return;
            }
        }
        const panel = qs('#messageCenterPanel');
        if (panel) {
            panel.classList.add('open');
            this.updateDeviceIndicator();
            // 初始化日历（如果还没有创建）
            this.initCalendar();
            // 加载有数据的日期列表
            this.loadWarningDates();
            this.loadWarningMessages();

            // 已移除自动刷新功能，避免用户滚动查看数据时列表被重新拉回顶部
            // 用户可以通过点击刷新按钮手动刷新消息列表
        }
    },

    /**
     * 关闭消息中心
     */
    close: function () {
        const panel = qs('#messageCenterPanel');
        if (panel) {
            panel.classList.remove('open');
            // 停止自动刷新
            this.stopAutoRefresh();
        }
    },

    /**
     * 开始自动刷新
     */
    startAutoRefresh: function () {
        this.stopAutoRefresh(); // 先停止之前的定时器
        this.refreshInterval = setInterval(() => {
            if (qs('#messageCenterPanel')?.classList.contains('open')) {
                this.loadWarningMessages();
            }
        }, 5000); // 每5秒刷新一次
    },

    /**
     * 停止自动刷新
     */
    stopAutoRefresh: function () {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    },

    /**
     * 加载警告消息
     */
    loadWarningMessages: async function () {
        const loadingEl = qs('#messageLoading');
        const emptyEl = qs('#messageEmpty');
        const listEl = qs('#messageList');
        const typeFilter = qs('#warningTypeFilter');
        const statusFilter = qs('#warningStatusFilter');

        if (!loadingEl || !emptyEl || !listEl) return;

        loadingEl.style.display = 'block';
        emptyEl.style.display = 'none';
        listEl.innerHTML = '';

        try {
            const type = typeFilter?.value || '';
            const status = statusFilter?.value || '';
            const params = new URLSearchParams();
            params.append('limit', '100');
            if (type) params.append('warning_type', type);
            if (status !== '') params.append('is_resolved', status);
            if (this.selectedDate) params.append('date', this.selectedDate);
            const deviceId = this.getActiveDeviceId();
            if (deviceId) params.append('device_id', deviceId);

            const response = await fetch(`/api/warnings?${params.toString()}`);
            const result = await response.json();

            loadingEl.style.display = 'none';

            if (result.success && result.data && result.data.length > 0) {
                this.renderWarningMessages(result.data);
                this.updateDeviceIndicator();
            } else {
                emptyEl.style.display = 'block';
            }
        } catch (error) {
            console.error('加载警告消息失败:', error);
            loadingEl.style.display = 'none';
            emptyEl.style.display = 'block';
            emptyEl.textContent = '加载失败，请重试';
        }
    },

    /**
     * 渲染警告消息列表
     */
    renderWarningMessages: function (messages) {
        const listEl = qs('#messageList');
        if (!listEl) return;

        listEl.innerHTML = '';

        const typeNames = {
            'T': '温度',
            'H': '湿度',
            'B': '亮度',
            'S': 'PPM',
            'P': '大气压'
        };

        const units = {
            'T': '°C',
            'H': '%',
            'B': 'lux',
            'S': 'ppm',
            'P': 'hPa'
        };

        messages.forEach(msg => {
            const item = document.createElement('div');
            item.className = `message-item ${msg.is_resolved ? 'resolved' : 'unresolved'}`;

            // 点击消息时标记为已读
            item.addEventListener('click', () => {
                this.markAsRead(msg.id, msg.device_id);
            });

            const typeName = typeNames[msg.warning_type] || msg.warning_type;
            const unit = units[msg.warning_type] || '';
            const statusText = msg.is_resolved ? '已恢复' : '未恢复';

            // 检查是否已读
            const isRead = this.readMessageIds.has(msg.id);
            if (isRead) {
                item.style.opacity = '0.6';
            }

            const startTime = msg.warning_start_time ? new Date(msg.warning_start_time * 1000).toLocaleString('zh-CN') : '--';
            const resolvedTime = msg.warning_resolved_time ? new Date(msg.warning_resolved_time * 1000).toLocaleString('zh-CN') : '--';

            item.innerHTML = `
                <div class="message-item-header">
                    <div class="message-item-type">
                        <span>${msg.is_resolved ? '✅' : '⚠️'}</span>
                        <span>${typeName}异常</span>
                        ${!isRead ? '<span style="display: inline-block; width: 8px; height: 8px; background: var(--primary); border-radius: 50%; margin-left: 8px;"></span>' : ''}
                    </div>
                    <span class="message-item-status ${msg.is_resolved ? 'resolved' : 'unresolved'}">${statusText}</span>
                </div>
                ${msg.warning_value !== null ? `<div class="message-item-value">异常值: ${msg.warning_value}${unit}</div>` : ''}
                <div class="message-item-time">异常时间: ${startTime}</div>
                ${msg.is_resolved ? `<div class="message-item-time">恢复时间: ${resolvedTime}</div>` : ''}
            `;

            listEl.appendChild(item);
        });

        // 渲染后更新未读计数
        this.updateUnreadCount();
    },

    /**
     * 创建通用通知（复用 showNotification 样式）
     * @param {Object} options - 通知选项
     * @param {string} options.title - 通知标题
     * @param {string} options.desc - 通知描述
     * @param {boolean} options.isError - 是否为错误通知（决定颜色）
     * @param {number} options.autoCloseDelay - 自动关闭延迟（毫秒），默认5000
     * @param {Function} options.onClick - 点击通知的回调函数
     */
    _createNotification: function (options) {
        const {title, desc, isError = false, autoCloseDelay = 5000, onClick = null} = options;

        // 如果已有通知，先移除
        const existingNotification = document.querySelector('.warning-message-notification');
        if (existingNotification) {
            existingNotification.remove();
        }

        // 创建通知元素
        const notification = document.createElement('div');
        notification.className = 'warning-message-notification app-notification' + (isError ? ' error' : '');

        // 创建内容容器（支持标题+描述）
        const contentWrapper = document.createElement('div');
        contentWrapper.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 4px;
        `;

        // 创建标题
        const titleEl = document.createElement('div');
        titleEl.textContent = title;
        titleEl.style.cssText = `
            font-weight: 600;
            font-size: 14px;
            line-height: 1.4;
        `;

        // 创建描述
        const descEl = document.createElement('div');
        descEl.textContent = desc;
        descEl.style.cssText = `
            color: var(--muted);
            font-size: 13px;
            line-height: 1.4;
        `;

        contentWrapper.appendChild(titleEl);
        contentWrapper.appendChild(descEl);

        // 设置通知样式（复用 showNotification 的样式）
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: var(--card);
            color: var(--text);
            padding: 15px 20px;
            padding-right: 45px;
            border-radius: 8px;
            box-shadow: var(--shadow);
            border-left: 4px solid ${isError ? 'var(--bad)' : 'var(--good)'};
            z-index: 10000;
            animation: slideIn 0.3s ease-out;
            font-size: 14px;
            max-width: 300px;
            cursor: pointer;
            user-select: none;
            transition: all 0.2s ease;
        `;

        notification.appendChild(contentWrapper);

        // 创建关闭按钮（复用 showNotification 的关闭按钮样式）
        const closeBtn = document.createElement('span');
        closeBtn.innerHTML = '✕';
        closeBtn.className = 'warning-notification-close';
        closeBtn.style.cssText = `
            position: absolute;
            top: 50%;
            right: 12px;
            transform: translateY(-50%);
            width: 20px;
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            background: transparent;
            color: var(--muted);
            font-size: 16px;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.2s ease;
            z-index: 1;
        `;

        // 关闭按钮悬停效果
        closeBtn.addEventListener('mouseenter', () => {
            closeBtn.style.background = 'var(--bg)';
            closeBtn.style.color = 'var(--text)';
            closeBtn.style.transform = 'translateY(-50%) scale(1.1)';
        });

        closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.background = 'transparent';
            closeBtn.style.color = 'var(--muted)';
            closeBtn.style.transform = 'translateY(-50%) scale(1)';
        });

        notification.appendChild(closeBtn);

        // 关闭通知的函数（提前定义，以便在事件处理中使用）
        let autoCloseTimer;
        const closeNotification = () => {
            if (autoCloseTimer) clearTimeout(autoCloseTimer);
            notification.style.animation = 'slideOut 0.3s ease-out';
            setTimeout(() => notification.remove(), 300);
        };

        // 在内容容器上添加点击事件，确保点击标题或描述也能触发
        contentWrapper.addEventListener('click', (e) => {
            // 如果点击的是关闭按钮，不处理
            if (e.target === closeBtn || e.target.closest('.warning-notification-close')) {
                return;
            }
            // 阻止事件冒泡
            e.stopPropagation();
            // 如果有自定义点击回调，执行它
            if (onClick && typeof onClick === 'function') {
                console.log('📢 点击通知内容，准备打开消息中心');
                closeNotification();
                try {
                    onClick();
                    console.log('✅ 消息中心打开回调已执行');
                } catch (error) {
                    console.error('❌ 打开消息中心时出错:', error);
                }
            } else {
                console.warn('⚠️ onClick 回调不存在或不是函数:', onClick);
            }
        });
        contentWrapper.style.cursor = 'pointer';

        // 确保动画样式已注入（复用 showNotification 的动画）
        if (!document.getElementById('notification-animations')) {
            const style = document.createElement('style');
            style.id = 'notification-animations';
            style.textContent = `
                @keyframes slideIn {
                    from {
                        transform: translateX(400px);
                        opacity: 0;
                    }
                    to {
                        transform: translateX(0);
                        opacity: 1;
                    }
                }
                
                @keyframes slideOut {
                    from {
                        transform: translateX(0);
                        opacity: 1;
                    }
                    to {
                        transform: translateX(400px);
                        opacity: 0;
                    }
                }
                
                .app-notification:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
                }
            `;
            document.head.appendChild(style);
        }

        // 添加到页面
        document.body.appendChild(notification);

        // 自动关闭
        if (autoCloseDelay > 0) {
            autoCloseTimer = setTimeout(() => {
                closeNotification();
            }, autoCloseDelay);
        }

        // 点击关闭按钮关闭通知
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeNotification();
        });

        // 点击通知内容的处理
        notification.addEventListener('click', (e) => {
            // 如果点击的是关闭按钮，不处理（已在上面的 closeBtn 事件中处理）
            if (e.target === closeBtn || e.target.closest('.warning-notification-close')) {
                return;
            }
            // 阻止事件冒泡
            e.stopPropagation();
            // 如果有自定义点击回调，执行它
            if (onClick && typeof onClick === 'function') {
                console.log('📢 点击通知，准备打开消息中心');
                closeNotification();
                try {
                    onClick();
                    console.log('✅ 消息中心打开回调已执行');
                } catch (error) {
                    console.error('❌ 打开消息中心时出错:', error);
                }
            } else {
                console.warn('⚠️ onClick 回调不存在或不是函数:', onClick);
            }
        });

        return {notification, closeNotification};
    },

    /**
     * 显示警告通知弹窗（复用 showNotification 样式）
     */
    showWarningNotification: function (warningData) {
        const self = this;
        // 确保 warning_value 为 0 时也能正确显示
        const valueText = warningData.warning_value !== null && warningData.warning_value !== undefined
            ? `${warningData.warning_value}${warningData.warning_unit || ''}`
            : '未知';
        this._createNotification({
            title: `${warningData.warning_name}异常`,
            desc: `当前值: ${valueText}`,
            isError: true,
            autoCloseDelay: 5000,
            onClick: function () {
                console.log('🔔 警告通知点击回调被触发，self:', self);
                if (self && typeof self.open === 'function') {
                    self.open();
                } else {
                    console.error('❌ self.open 不存在或不是函数，self:', self);
                }
            }
        });
    },

    /**
     * 显示恢复通知弹窗（复用 showNotification 样式）
     */
    showResolvedNotification: function (resolvedData) {
        const self = this;
        this._createNotification({
            title: `${resolvedData.warning_name}已恢复`,
            desc: `异常已恢复正常状态`,
            isError: false,
            autoCloseDelay: 5000,
            onClick: function () {
                console.log('🔔 恢复通知点击回调被触发，self:', self);
                if (self && typeof self.open === 'function') {
                    self.open();
                } else {
                    console.error('❌ self.open 不存在或不是函数，self:', self);
                }
            }
        });
    },

    /**
     * 关闭警告通知弹窗（兼容旧代码）
     */
    closeWarningNotification: function () {
        // 查找所有警告消息通知并移除
        const notifications = document.querySelectorAll('.warning-message-notification');
        notifications.forEach(notification => {
            notification.style.animation = 'slideOut 0.3s ease-out';
            setTimeout(() => notification.remove(), 300);
        });
    },

    /**
     * 更新未读消息数
     */
    updateUnreadCount: function () {
        // 更新菜单项内的徽章
        const badge = qs('#messageBadge');
        if (badge) {
            if (this.unreadWarningCount > 0) {
                badge.style.display = 'inline-flex';
                badge.textContent = this.unreadWarningCount > 99 ? '99+' : this.unreadWarningCount;
            } else {
                badge.style.display = 'none';
            }
        }

        // 更新功能按钮上的红点徽章
        const menuBtnBadge = qs('#menuBtnBadge');
        if (menuBtnBadge) {
            if (this.unreadWarningCount > 0) {
                menuBtnBadge.classList.add('show');
                menuBtnBadge.textContent = this.unreadWarningCount > 99 ? '99+' : this.unreadWarningCount;
            } else {
                menuBtnBadge.classList.remove('show');
            }
        }
    },

    /**
     * 加载未读警告消息数（考虑已读状态）
     */
    loadUnreadWarningCount: async function () {
        try {
            const response = await fetch('/api/warnings?limit=1000&is_resolved=0');
            const result = await response.json();
            if (result.success && result.data) {
                // 过滤掉已读的消息
                const unreadMessages = result.data.filter(msg => !this.readMessageIds.has(msg.id));
                this.unreadWarningCount = unreadMessages.length;
                this.setDeviceUnreadMap(unreadMessages);
                this.updateUnreadCount();
            }
        } catch (error) {
            console.error('加载未读警告数失败:', error);
        }
    },

    /**
     * 初始化消息中心
     */
    init: function () {
        // 加载已读消息ID
        this.loadReadMessageIds();

        // 绑定消息中心按钮
        const messageCenterBtn = qs('#messageCenterBtn');
        if (messageCenterBtn) {
            messageCenterBtn.addEventListener('click', () => this.open());
        }

        // 绑定筛选器变化事件
        const typeFilter = qs('#warningTypeFilter');
        const statusFilter = qs('#warningStatusFilter');
        if (typeFilter) {
            typeFilter.addEventListener('change', () => this.loadWarningMessages());
        }
        if (statusFilter) {
            statusFilter.addEventListener('change', () => this.loadWarningMessages());
        }

        // 绑定关闭按钮
        const closeBtn = qs('.message-center-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.close());
        }

        // 绑定刷新按钮
        const refreshBtn = qs('.message-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => this.loadWarningMessages());
        }

        // 点击弹窗外部区域关闭消息中心
        const panel = qs('#messageCenterPanel');
        if (panel) {
            // 使用事件委托，避免重复绑定
            if (!this.messageCenterClickHandler) {
                this.messageCenterClickHandler = (e) => {
                    // 如果消息中心是打开的
                    if (panel.classList.contains('open')) {
                        // 检查点击的目标
                        const target = e.target;
                        // 如果点击的不是弹窗本身或其子元素，也不是打开按钮，则关闭
                        if (!panel.contains(target) &&
                            !target.closest('#messageCenterBtn') &&
                            !target.closest('.date-list-popup')) {
                            this.close();
                        }
                    }
                };
                document.addEventListener('click', this.messageCenterClickHandler);
            }
        }

        // 日历相关事件在initCalendar中绑定，这里不需要重复绑定

        // 定期刷新未读计数（每30秒）
        setInterval(() => {
            this.loadUnreadWarningCount();
        }, 30000);

        // 初始化时加载一次未读计数
        this.loadUnreadWarningCount();
    },

    /**
     * 处理WebSocket警告消息
     */
    handleWarningMessage: function (msg) {
        console.log('⚠️ 收到警告通知:', msg);
        this.showWarningNotification(msg);
        // 不直接增加计数，而是重新加载未读数（确保准确性）
        this.loadUnreadWarningCount();

        // 如果消息中心已打开，刷新消息列表
        const panel = qs('#messageCenterPanel');
        if (panel && panel.classList.contains('open')) {
            this.loadWarningMessages();
        }
    },

    /**
     * 处理WebSocket恢复消息
     */
    handleResolvedMessage: function (msg) {
        console.log('✅ 收到恢复通知:', msg);
        this.showResolvedNotification(msg);
        // 重新加载未读数
        this.loadUnreadWarningCount();

        // 如果消息中心已打开，刷新消息列表
        const panel = qs('#messageCenterPanel');
        if (panel && panel.classList.contains('open')) {
            this.loadWarningMessages();
        }
    },


    /**
     * 初始化日历组件（使用原生日期选择器）
     */
    initCalendar: function () {
        const wrapper = qs('#calendarWrapper');
        if (!wrapper || wrapper.querySelector('.date-hint-btn')) {
            // 已经初始化过了，只需要更新日期列表
            this.loadWarningDates();
            return;
        }

        // 创建容器（用于定位弹出框）
        const container = document.createElement('div');
        container.style.display = 'flex';
        container.style.gap = '8px';
        container.style.alignItems = 'center';
        container.style.flex = '0 0 auto';
        container.style.position = 'relative'; // 重要：用于定位弹出框

        // 创建有数据日期提示按钮
        const dateHintBtn = document.createElement('button');
        dateHintBtn.className = 'date-hint-btn';
        dateHintBtn.innerHTML = '📅 选择日期';
        dateHintBtn.title = '查看有数据的日期';
        dateHintBtn.style.cssText = 'padding: 8px 12px; background: var(--card); border: 1px solid var(--bd); border-radius: 8px; cursor: pointer; font-size: 14px; transition: all 0.2s; color: var(--text); white-space: nowrap;';
        dateHintBtn.addEventListener('mouseenter', function () {
            this.style.background = 'var(--primary)';
            this.style.color = 'white';
            this.style.borderColor = 'var(--primary)';
        });
        dateHintBtn.addEventListener('mouseleave', function () {
            this.style.background = 'var(--card)';
            this.style.color = 'var(--text)';
            this.style.borderColor = 'var(--bd)';
        });

        // 创建日期列表弹出框
        const dateListPopup = document.createElement('div');
        dateListPopup.className = 'date-list-popup';
        dateListPopup.id = 'dateListPopup';
        dateListPopup.style.cssText = 'position: absolute; top: calc(100% + 8px); left: 0; background: var(--card); border: 1px solid var(--bd); border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 10000; max-height: 300px; overflow-y: auto; min-width: 220px; opacity: 0; transform: translateY(-10px); pointer-events: none; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);';

        const dateListContent = document.createElement('div');
        dateListContent.id = 'dateListContent';
        dateListContent.style.cssText = 'padding: 8px;';
        dateListPopup.appendChild(dateListContent);

        // 点击按钮显示/隐藏日期列表
        dateHintBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const isVisible = dateListPopup.style.opacity === '1';
            if (isVisible) {
                // 关闭动画
                dateListPopup.style.opacity = '0';
                dateListPopup.style.transform = 'translateY(-10px)';
                dateListPopup.style.pointerEvents = 'none';
            } else {
                // 打开动画
                this.updateDateList();
                dateListPopup.style.display = 'block';
                // 使用requestAnimationFrame确保display先设置
                requestAnimationFrame(() => {
                    dateListPopup.style.opacity = '1';
                    dateListPopup.style.transform = 'translateY(0)';
                    dateListPopup.style.pointerEvents = 'auto';
                });
            }
        });

        // 点击外部关闭
        if (!this.dateListClickHandler) {
            this.dateListClickHandler = (e) => {
                const popup = qs('#dateListPopup');
                const btn = qs('.date-hint-btn');
                if (popup && btn &&
                    !popup.contains(e.target) &&
                    !btn.contains(e.target) &&
                    popup.style.opacity === '1') {
                    // 关闭动画
                    popup.style.opacity = '0';
                    popup.style.transform = 'translateY(-10px)';
                    popup.style.pointerEvents = 'none';
                    setTimeout(() => {
                        popup.style.display = 'none';
                    }, 300);
                }
            };
            document.addEventListener('click', this.dateListClickHandler);
        }

        container.appendChild(dateHintBtn);
        container.appendChild(dateListPopup); // 弹出框添加到container内，这样定位才正确
        wrapper.appendChild(container);

        // 加载有数据的日期列表
        this.loadWarningDates();
    },

    /**
     * 加载有警告数据的日期列表
     */
    loadWarningDates: async function () {
        try {
            const deviceId = this.getActiveDeviceId();
            const url = deviceId
                ? `/api/warnings/dates?device_id=${encodeURIComponent(deviceId)}`
                : '/api/warnings/dates';
            const response = await fetch(url);
            const result = await response.json();
            if (result.success && result.data) {
                this.warningDates = result.data;
                this.updateDateList();
            }
        } catch (error) {
            console.error('加载警告日期列表失败:', error);
            this.warningDates = [];
        }
    },

    /**
     * 更新日期列表显示
     */
    updateDateList: function () {
        const content = qs('#dateListContent');
        if (!content) {
            console.warn('dateListContent not found');
            return;
        }

        if (!this.warningDates || this.warningDates.length === 0) {
            content.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--muted); font-size: 13px;">暂无数据</div>';
            return;
        }

        // 添加"全部日期"选项（放在最上面）
        let html = `
            <div class="date-list-item" data-date="" style="
                padding: 8px 12px;
                cursor: pointer;
                border-radius: 4px;
                transition: all 0.2s;
                margin-bottom: 4px;
                ${!this.selectedDate ? 'background: var(--primary); color: white;' : ''}
            " onmouseover="this.style.background=this.style.background.includes('primary')?'var(--primary)':'var(--bd)'" 
               onmouseout="this.style.background=this.style.background.includes('primary')?'var(--primary)':'transparent'">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span>📋 全部日期</span>
                    ${!this.selectedDate ? '<span>✓</span>' : ''}
                </div>
            </div>
        `;

        // 在"有数据的日期："标题上面添加分隔线
        html += '<div style="border-top: 1px solid var(--bd); margin: 8px 0 4px 0;"></div>';
        html += '<div style="padding: 4px 0; font-size: 12px; color: var(--muted); margin-bottom: 4px; padding-bottom: 4px;">有数据的日期：</div>';

        // 按年份和月份分组显示日期
        const datesByYear = {};
        this.warningDates.forEach(item => {
            const dateStr = typeof item === 'string' ? item : item.date;
            const date = new Date(dateStr + 'T00:00:00');
            const year = date.getFullYear();
            const month = date.getMonth() + 1; // 1-12
            
            if (!datesByYear[year]) {
                datesByYear[year] = {};
            }
            if (!datesByYear[year][month]) {
                datesByYear[year][month] = [];
            }
            datesByYear[year][month].push(item);
        });

        // 按年份倒序排列（最新的年份在前）
        const years = Object.keys(datesByYear).sort((a, b) => parseInt(b) - parseInt(a));

        // 渲染每个年份
        years.forEach(year => {
            const yearCollapsed = this.collapsedYears.has(year);
            const yearKey = year;
            
            // 计算该年份总共的消息数量
            let yearTotalCount = 0;
            Object.values(datesByYear[year]).forEach(monthDates => {
                monthDates.forEach(item => {
                    yearTotalCount += (typeof item === 'object' && item.count) ? item.count : 0;
                });
            });

            // 添加年份标题（可点击折叠/展开）
            html += `
                <div class="date-year-header" data-year="${year}" style="
                    padding: 8px 12px;
                    font-size: 13px;
                    font-weight: 600;
                    color: var(--primary);
                    margin-top: 8px;
                    cursor: pointer;
                    border-radius: 4px;
                    transition: all 0.2s;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    user-select: none;
                " onmouseover="this.style.background='var(--bd)'" 
                   onmouseout="this.style.background='transparent'">
                    <span>
                        <span style="display: inline-block; transition: transform 0.2s; transform: rotate(${yearCollapsed ? '-90deg' : '0deg'});">▼</span>
                        ${year}年
                    </span>
                    <span style="font-size: 11px; color: var(--muted); font-weight: normal;">(${yearTotalCount}条)</span>
                </div>
            `;

            // 如果年份未折叠，显示月份列表
            if (!yearCollapsed) {
                // 按月份倒序排列（最新的月份在前）
                const months = Object.keys(datesByYear[year]).sort((a, b) => parseInt(b) - parseInt(a));
                
                months.forEach(month => {
                    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
                    const monthCollapsed = this.collapsedMonths.has(monthKey);
                    
                    // 计算该月份总共的消息数量
                    let monthTotalCount = 0;
                    datesByYear[year][month].forEach(item => {
                        monthTotalCount += (typeof item === 'object' && item.count) ? item.count : 0;
                    });

                    // 添加月份标题（可点击折叠/展开）
                    html += `
                        <div class="date-month-header" data-month="${monthKey}" style="
                            padding: 6px 12px 6px 24px;
                            font-size: 12px;
                            font-weight: 600;
                            color: var(--text);
                            cursor: pointer;
                            border-radius: 4px;
                            transition: all 0.2s;
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                            user-select: none;
                            margin-top: 4px;
                        " onmouseover="this.style.background='var(--bd)'" 
                           onmouseout="this.style.background='transparent'">
                            <span>
                                <span style="display: inline-block; transition: transform 0.2s; transform: rotate(${monthCollapsed ? '-90deg' : '0deg'}); font-size: 10px;">▼</span>
                                ${month}月
                            </span>
                            <span style="font-size: 10px; color: var(--muted); font-weight: normal;">(${monthTotalCount}条)</span>
                        </div>
                    `;

                    // 如果月份未折叠，显示日期列表
                    if (!monthCollapsed) {
                        // 按日期倒序排列（最新的日期在前）
                        const sortedDates = datesByYear[year][month].sort((a, b) => {
                            const dateA = typeof a === 'string' ? a : a.date;
                            const dateB = typeof b === 'string' ? b : b.date;
                            return dateB.localeCompare(dateA);
                        });

                        sortedDates.forEach(item => {
                            const dateStr = typeof item === 'string' ? item : item.date;
                            const countNum = typeof item === 'object' && item.count ? item.count : 0;
                            const date = new Date(dateStr + 'T00:00:00');
                            const day = date.getDate();
                            const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
                            const weekday = weekdays[date.getDay()];
                            const isSelected = this.selectedDate === dateStr;

                            html += `
                                <div class="date-list-item" data-date="${dateStr}" style="
                                    padding: 6px 12px 6px 40px;
                                    cursor: pointer;
                                    border-radius: 4px;
                                    transition: all 0.2s;
                                    font-size: 12px;
                                    ${isSelected ? 'background: var(--primary); color: white;' : ''}
                                " onmouseover="this.style.background=this.style.background.includes('primary')?'var(--primary)':'var(--bd)'" 
                                   onmouseout="this.style.background=this.style.background.includes('primary')?'var(--primary)':'transparent'">
                                    <div style="display: flex; justify-content: space-between; align-items: center;">
                                        <span>${day}日 周${weekday} <span style="color: ${isSelected ? 'rgba(255,255,255,0.8)' : 'var(--muted)'}; font-size: 10px; margin-left: 4px;">(${countNum}条)</span></span>
                                        ${isSelected ? '<span>✓</span>' : ''}
                                    </div>
                                </div>
                            `;
                        });
                    }
                });
            }
        });

        content.innerHTML = html;

        // 绑定年份折叠/展开事件
        content.querySelectorAll('.date-year-header').forEach(header => {
            header.addEventListener('click', (e) => {
                e.stopPropagation();
                const year = header.getAttribute('data-year');
                if (this.collapsedYears.has(year)) {
                    this.collapsedYears.delete(year);
                } else {
                    this.collapsedYears.add(year);
                }
                this.updateDateList(); // 重新渲染
            });
        });

        // 绑定月份折叠/展开事件
        content.querySelectorAll('.date-month-header').forEach(header => {
            header.addEventListener('click', (e) => {
                e.stopPropagation();
                const monthKey = header.getAttribute('data-month');
                if (this.collapsedMonths.has(monthKey)) {
                    this.collapsedMonths.delete(monthKey);
                } else {
                    this.collapsedMonths.add(monthKey);
                }
                this.updateDateList(); // 重新渲染
            });
        });

        // 绑定日期点击事件
        content.querySelectorAll('.date-list-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const date = item.getAttribute('data-date');
                // 如果date为空字符串，表示选择"全部日期"
                this.selectedDate = date || null;
                this.loadWarningMessages();
                this.updateDateList(); // 更新选中状态

                // 关闭弹出框（带动画）
                const popup = qs('#dateListPopup');
                if (popup) {
                    popup.style.opacity = '0';
                    popup.style.transform = 'translateY(-10px)';
                    popup.style.pointerEvents = 'none';
                    setTimeout(() => {
                        popup.style.display = 'none';
                    }, 300);
                }
            });
        });
    },

};

const PowerControlModal = {
    overlay: null,
    currentDeviceId: null, // 保存当前选择的设备ID
    init() {
        this.overlay = document.getElementById('powerControlModal');
        if (!this.overlay) return;
        this.bindTriggers();
        const closeBtn = this.overlay.querySelector('[data-close-power-control]');
        closeBtn?.addEventListener('click', () => this.close());
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) this.close();
        });
        this.overlay.querySelectorAll('[data-power-sensor]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const sensor = btn.dataset.powerSensor;
                this.close();
                
                // 使用在打开省电控制中心时已选择的设备ID
                let deviceId = this.currentDeviceId;
                
                // 如果没有保存的设备ID，才需要选择设备（这种情况理论上不应该发生）
                if (!deviceId) {
                    if (typeof window.openDevicePicker === 'function') {
                        // 获取当前已选择的设备ID（如果有）
                        const currentDeviceId = window.getSelectedDeviceId ? window.getSelectedDeviceId() : (window.selectedDeviceId || null);
                        deviceId = await window.openDevicePicker('请选择要控制的设备', currentDeviceId);
                        if (!deviceId) return; // 用户取消选择
                        // 保存选择的设备ID
                        this.currentDeviceId = deviceId;
                    } else {
                        // 如果没有设备选择器，使用当前页面的设备ID或默认值
                        deviceId = window.getSelectedDeviceId ? window.getSelectedDeviceId() : (window.selectedDeviceId || 'D01');
                        this.currentDeviceId = deviceId;
                    }
                }
                
                const normalizedDeviceId = deviceId ? deviceId.toString().trim().toUpperCase() : null;
                
                // 根据传感器类型打开对应的控制面板
                if (sensor === 'mq2') {
                    if (window.MQ2Control && normalizedDeviceId) {
                        window.MQ2Control.setDeviceId(normalizedDeviceId);
                    }
                    if (typeof window.openOverlayMQ2 === 'function') {
                        window.openOverlayMQ2();
                    }
                } else if (sensor === 'bmp180') {
                    if (window.BMP180Control && normalizedDeviceId) {
                        window.BMP180Control.setDeviceId(normalizedDeviceId);
                    }
                    if (typeof window.openOverlayBMP180 === 'function') {
                        window.openOverlayBMP180();
                    }
                } else if (sensor === 'bh1750') {
                    if (window.BH1750Control && normalizedDeviceId) {
                        window.BH1750Control.setDeviceId(normalizedDeviceId);
                    }
                    if (typeof window.openOverlayBH1750 === 'function') {
                        window.openOverlayBH1750();
                    }
                } else if (sensor === 'ble') {
                    if (window.BLEControl && normalizedDeviceId) {
                        window.BLEControl.setDeviceId(normalizedDeviceId);
                    }
                    if (typeof window.openOverlayBLE === 'function') {
                        window.openOverlayBLE();
                    }
                } else if (sensor === 'oled') {
                    if (window.OLEDControl && normalizedDeviceId) {
                        window.OLEDControl.setDeviceId(normalizedDeviceId);
                    }
                    if (typeof window.openOverlayOLED === 'function') {
                        window.openOverlayOLED();
                    }
                }
            });
        });
    },
    bindTriggers() {
        document.querySelectorAll('[data-power-control-trigger]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault?.();
                this.open();
            });
        });
    },
    async open(providedDeviceId = null) {
        if (!this.overlay) return;
        
        // 如果已经提供了设备ID（例如从devices.html传递过来的），直接使用，不要覆盖
        let deviceId = providedDeviceId;
        
        // 如果没有提供设备ID，尝试从多个来源获取
        if (!deviceId) {
            // 1. 优先检查URL中是否有device_id参数（index.html等页面）
            const urlParams = new URLSearchParams(window.location.search || "");
            const urlDeviceId = urlParams.get("device_id");
            
            if (urlDeviceId) {
                // 如果URL中有device_id参数，直接使用，不需要再选择设备
                deviceId = urlDeviceId.toUpperCase();
            } else {
                // 2. 尝试从全局变量获取（index.html等页面会设置）
                if (window.getSelectedDeviceId && typeof window.getSelectedDeviceId === 'function') {
                    deviceId = window.getSelectedDeviceId();
                } else if (window.selectedDeviceId) {
                    deviceId = window.selectedDeviceId;
                }
                
                // 3. 如果还是没有，尝试从localStorage获取（devices.html等页面会保存）
                if (!deviceId) {
                    try {
                        const saved = localStorage.getItem('device_overview_selected');
                        if (saved) {
                            deviceId = saved.toString().trim().toUpperCase();
                        }
                    } catch (e) {
                        // 忽略localStorage错误
                    }
                }
                
                // 4. 如果仍然没有设备ID，设置为null，让用户在点击传感器按钮时再选择
                if (deviceId) {
                    deviceId = deviceId.toString().trim().toUpperCase();
                }
            }
        } else {
            // 如果提供了设备ID，确保格式正确
            deviceId = deviceId.toString().trim().toUpperCase();
        }
        
        // 保存选择的设备ID，供传感器按钮点击时使用
        this.currentDeviceId = deviceId;
        
        // 设置 MQ2Control 的设备ID（确保使用正确的设备ID）
        // 注意：使用this.currentDeviceId而不是局部变量deviceId，避免闭包问题
        const normalizedDeviceId = deviceId ? deviceId.toString().trim().toUpperCase() : null;
        
        // 确保MQ2Control已初始化（如果还没初始化，先初始化）
        if (!window.MQ2Control) {
            // 尝试初始化MQ2Control
            if (typeof ensureMq2OverlayTemplate === 'function') {
                ensureMq2OverlayTemplate();
            }
            if (window.MQ2Control && typeof window.MQ2Control.init === 'function') {
                window.MQ2Control.init();
            }
        }
        
        const setMQ2DeviceId = (targetDeviceId) => {
            if (window.MQ2Control && targetDeviceId) {
                const normalized = targetDeviceId.toString().trim().toUpperCase();
                window.MQ2Control.setDeviceId(normalized);
                // setDeviceId()已经会更新标题，这里不需要再调用updateTitleWithDeviceName()
            } else if (!window.MQ2Control) {
                // 如果MQ2Control还没初始化，等待一下再设置
                setTimeout(() => {
                    // 使用this.currentDeviceId确保使用正确的设备ID
                    const deviceIdToSet = this.currentDeviceId || targetDeviceId;
                    if (window.MQ2Control && deviceIdToSet) {
                        const normalized = deviceIdToSet.toString().trim().toUpperCase();
                        window.MQ2Control.setDeviceId(normalized);
                    }
                }, 200);
            }
        };
        setMQ2DeviceId(normalizedDeviceId);
        
        this.overlay.classList.add('show');
        this.overlay.setAttribute('aria-hidden', 'false');
    },
    close() {
        if (!this.overlay) return;
        this.overlay.classList.remove('show');
        this.overlay.setAttribute('aria-hidden', 'true');
    }
};

function ensureMq2OverlayTemplate() {
    if (document.getElementById('overlayMQ2')) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
    <div id="overlayMQ2" class="overlay" aria-hidden="true">
        <div class="modal mq2-modal" role="dialog" aria-modal="true" aria-labelledby="modalTitleMQ2">
            <div class="modal-head mq2-modal-head">
                <div class="mq2-title-with-info">
                    <div class="mq2-title-text">
                        <span class="mq2-title-icon">🔥</span>
                        <span id="modalTitleMQ2">烟雾传感器控制</span>
                    </div>
                    <span class="info-btn" onclick="showInfo('mq2-control')" title="为什么要单独控制 MQ2">i</span>
                </div>
                <div class="modal-actions">
                    <button id="closeOverlayMQ2" class="close-btn" title="关闭">✕</button>
                </div>
            </div>
            <div class="modal-body">
                <div class="mq2-body">
                    <div class="mq2-section mq2-meta">
                        <div>传感器：<strong>MQ2 烟雾浓度传感器</strong></div>
                        <div id="mq2ModeLine" class="mq2-subtle">运行模式：读取中...</div>
                        <div id="mq2StateLine">当前状态：读取中...</div>
                        <div id="mq2PhaseLine" class="mq2-subtle">当前阶段：--</div>
                        <div id="mq2NextRunLine" class="mq2-subtle">距离切换：--</div>
                        <div id="mq2UpdatedLine" class="mq2-subtle">最近操作：--</div>
                        <div id="mq2ViaLine" class="mq2-subtle"></div>
                    </div>

                    <div class="mq2-section mq2-mode-selector">
                        <div class="mq2-section-head" data-role="mq2-mode-head">运行模式</div>
                        <div class="mq2-mode-options">
                            <button class="mq2-mode-btn" data-mode="eco" title="开启5分钟 / 断电25分钟">
                                <span class="mode-icon">💤</span>
                                <div class="mode-text">
                                    <span class="mode-name">省电模式</span>
                                    <span class="mode-desc">开机5分钟 · 休眠25分钟</span>
                                </div>
                            </button>
                            <button class="mq2-mode-btn" data-mode="balance" title="开启15分钟 / 断电15分钟">
                                <span class="mode-icon">⚖️</span>
                                <div class="mode-text">
                                    <span class="mode-name">平衡模式</span>
                                    <span class="mode-desc">开机15分钟 · 休眠15分钟</span>
                                </div>
                            </button>
                            <button class="mq2-mode-btn" data-mode="safe" title="开启25分钟 / 断电5分钟">
                                <span class="mode-icon">🔥</span>
                                <div class="mode-text">
                                    <span class="mode-name">安全模式</span>
                                    <span class="mode-desc">开机25分钟 · 休眠5分钟</span>
                                </div>
                            </button>
                            <button class="mq2-mode-btn" data-mode="always" title="持续供电，不休眠">
                                <span class="mode-icon">⚡</span>
                                <div class="mode-text">
                                    <span class="mode-name">不省电</span>
                                    <span class="mode-desc">持续供电，快速响应</span>
                                </div>
                            </button>
                        </div>
                    </div>

                    <div class="mq2-section mq2-actions-card">
                        <div class="mq2-section-head">远程指令</div>
                        <div class="mq2-actions">
                            <button id="btnMq2On" class="btn" type="button" title="发送开启指令">开启传感器</button>
                            <button id="btnMq2Off" class="btn" type="button" title="发送关闭指令">关闭传感器</button>
                        </div>
                        <div id="mq2Feedback" class="mq2-feedback"></div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;
    document.body.appendChild(wrapper.firstElementChild);
}

function ensurePowerControlTemplate() {
    if (document.getElementById('powerControlModal')) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
    <div id="powerControlModal" class="overlay" aria-hidden="true">
        <div class="power-modal" role="dialog" aria-modal="true" aria-labelledby="powerControlTitle">
            <div class="power-modal-head">
                <div class="power-modal-title" id="powerControlTitle">🔋 省电控制中心</div>
                <button class="power-modal-close" type="button" data-close-power-control>✕</button>
            </div>
            <div class="power-modal-body">
                <div class="power-modal-desc">以下传感器支持定时唤醒和远程启停，点击即可进入对应的控制面板。</div>
                <div class="power-device-list">
                    <button class="power-device-card" type="button" data-power-sensor="mq2">
                        <div class="power-device-info">
                            <div class="power-device-name">🔥 MQ2 烟雾传感器</div>
                            <div class="power-device-meta">四种省电模式 · 支持BLE/MQTT 双备份</div>
                        </div>
                        <div class="power-device-badge">节能调度</div>
                    </button>
                    <button class="power-device-card" type="button" data-power-sensor="bmp180">
                        <div class="power-device-info">
                            <div class="power-device-name">🌡️ BMP180 气压传感器</div>
                            <div class="power-device-meta">四种省电模式 · 默认不省电</div>
                        </div>
                        <div class="power-device-badge">节能调度</div>
                    </button>
                    <button class="power-device-card" type="button" data-power-sensor="bh1750">
                        <div class="power-device-info">
                            <div class="power-device-name">💡 BH1750 亮度传感器</div>
                            <div class="power-device-meta">四种省电模式 · 默认不省电</div>
                        </div>
                        <div class="power-device-badge">节能调度</div>
                    </button>
                    <button class="power-device-card" type="button" data-power-sensor="ble">
                        <div class="power-device-info">
                            <div class="power-device-name">📶 BLE 蓝牙</div>
                            <div class="power-device-meta">远程控制 · 开启/关闭</div>
                        </div>
                        <div class="power-device-badge">远程控制</div>
                    </button>
                    <button class="power-device-card" type="button" data-power-sensor="oled">
                        <div class="power-device-info">
                            <div class="power-device-name">📺 OLED 显示屏</div>
                            <div class="power-device-meta">远程控制 · 开启/关闭</div>
                        </div>
                        <div class="power-device-badge">远程控制</div>
                    </button>
                </div>
            </div>
        </div>
    </div>`;
    document.body.appendChild(wrapper.firstElementChild);
}

const MQ2Control = {
    overlay: null,
    deviceId: null, // 当前控制的设备ID
    state: 'unknown',
    stateUpdatedAt: null,
    lastVia: null,
    currentMode: 'eco',
    phase: 'on',
    phaseMessage: '',
    phaseUntil: null,
    countdown: null,
    countdownRefreshAt: 0,
    pendingTimer: null,
    refreshPromise: null,
    setDeviceId(deviceId) {
        const normalizedId = deviceId ? deviceId.toString().trim().toUpperCase() : null;
        this.deviceId = normalizedId;
        
        // 立即更新标题显示设备信息
        if (this.deviceId) {
            // 如果overlay已经存在，立即更新标题
            if (this.overlay) {
                const titleEl = document.getElementById('modalTitleMQ2');
                if (titleEl) {
                    // 立即更新标题，不等待异步获取设备名称
                    titleEl.textContent = `🔥 ${this.deviceId} 烟雾传感器控制`;
                    // 异步获取设备名称（可选）
                    this.updateTitleWithDeviceName();
                }
            }
        }
    },
    async updateTitleWithDeviceName() {
        if (!this.deviceId) return;
        try {
            const res = await fetch('/api/devices');
            if (res.ok) {
                const data = await res.json();
                if (data.success && data.devices) {
                    const device = data.devices.find(d => {
                        const id = (d.id || d.device_id || '').toString().trim().toUpperCase();
                        return id === this.deviceId;
                    });
                    const titleEl = document.getElementById('modalTitleMQ2');
                    if (titleEl) {
                        // 格式：D02 烟雾传感器控制
                        titleEl.textContent = `${this.deviceId} 烟雾传感器控制`;
                    }
                }
            }
        } catch (error) {
            console.warn('获取设备名称失败：', error);
            const titleEl = document.getElementById('modalTitleMQ2');
            if (titleEl) {
                // 格式：🔥 D02 烟雾传感器控制
                titleEl.textContent = `🔥 ${this.deviceId} 烟雾传感器控制`;
            }
        }
    },
    getDeviceId() {
        // 优先使用已设置的设备ID（这是最重要的，确保使用用户选择的设备ID）
        if (this.deviceId) {
            return this.deviceId;
        }
        // 如果没有设置设备ID，尝试从当前页面获取（作为后备方案，但不应该依赖这个）
        // 注意：这个后备方案可能会导致问题，因为可能获取到错误的设备ID
        if (window.getSelectedDeviceId) {
            const id = window.getSelectedDeviceId();
            if (id) {
                const normalizedId = id.toString().trim().toUpperCase();
                this.deviceId = normalizedId;
                return this.deviceId;
            }
        }
        if (window.selectedDeviceId) {
            const id = window.selectedDeviceId;
            if (id) {
                const normalizedId = id.toString().trim().toUpperCase();
                this.deviceId = normalizedId;
                return this.deviceId;
            }
        }
        // 最后使用默认值（不应该到达这里，因为应该在open()之前设置设备ID）
        this.deviceId = 'D01';
        return this.deviceId;
    },
    init() {
        ensureMq2OverlayTemplate();
        this.overlay = document.getElementById('overlayMQ2');
        if (!this.overlay) return;
        this.modeLine = document.getElementById('mq2ModeLine');
        this.stateLine = document.getElementById('mq2StateLine');
        this.phaseLine = document.getElementById('mq2PhaseLine');
        this.nextRunLine = document.getElementById('mq2NextRunLine');
        this.updatedLine = document.getElementById('mq2UpdatedLine');
        this.viaLine = document.getElementById('mq2ViaLine');
        this.feedback = document.getElementById('mq2Feedback');
        this.modeButtons = Array.from(document.querySelectorAll('.mq2-mode-btn'));
        this.modeButtons.forEach(btn => {
            btn.addEventListener('click', async () => {
                const hasAccess = await requireControlPassword('请输入密码以切换运行模式');
                if (!hasAccess) return;
                const mode = btn.dataset.mode;
                if (mode) this.setMode(mode);
            });
        });
        this.modeHeader = this.overlay.querySelector('[data-role="mq2-mode-head"]');
        this.modeHeader?.addEventListener('click', async () => {
            const hasAccess = await requireControlPassword('请输入密码以切换到开发模式');
            if (!hasAccess) return;
            this.setMode('dev');
        });
        this.btnOn = document.getElementById('btnMq2On');
        this.btnOff = document.getElementById('btnMq2Off');
        this.btnOn?.addEventListener('click', async () => {
            const hasAccess = await requireControlPassword('请输入密码以开启传感器');
            if (!hasAccess) return;
            this.sendSwitch('on');
        });
        this.btnOff?.addEventListener('click', async () => {
            const hasAccess = await requireControlPassword('请输入密码以关闭传感器');
            if (!hasAccess) return;
            this.sendSwitch('off');
        });
        const closeBtn = document.getElementById('closeOverlayMQ2');
        closeBtn?.addEventListener('click', () => this.close());
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) this.close();
        });
        // 注意：init()时不要调用refresh()，因为此时设备ID可能还没有设置
        // refresh()会在open()时被调用，那时设备ID应该已经设置好了
        // this.refresh();
        this.updateButtons();
    },
    open() {
        if (!this.overlay) return;
        
        // 重要：优先检查PowerControlModal.currentDeviceId，这是用户最新选择的设备ID
        // 如果PowerControlModal有保存的设备ID，优先使用它（这是用户最新选择的）
        let targetDeviceId = this.deviceId;
        if (window.PowerControlModal && window.PowerControlModal.currentDeviceId) {
            const powerControlDeviceId = window.PowerControlModal.currentDeviceId;
            // 无论是否匹配，都使用PowerControlModal中的设备ID（这是用户最新选择的）
            if (powerControlDeviceId !== this.deviceId) {
                this.setDeviceId(powerControlDeviceId);
                targetDeviceId = powerControlDeviceId;
            } else {
                targetDeviceId = powerControlDeviceId;
            }
        }
        
        // 如果还是没有设备ID，尝试从页面获取（作为后备方案）
        if (!targetDeviceId) {
            const deviceId = this.getDeviceId();
            this.setDeviceId(deviceId);
            targetDeviceId = deviceId;
        }
        
        // 每次打开时都强制更新标题，确保显示正确的设备ID
        if (targetDeviceId) {
            const titleEl = document.getElementById('modalTitleMQ2');
            if (titleEl) {
                // 立即更新标题，不等待异步
                titleEl.textContent = `🔥 ${targetDeviceId} 烟雾传感器控制`;
            }
            // 异步获取设备名称（可选，用于显示设备名称）
            this.updateTitleWithDeviceName();
        }
        
        this.overlay.classList.add('show');
        this.overlay.setAttribute('aria-hidden', 'false');
        if (this.feedback) {
            this.feedback.textContent = '';
            this.feedback.style.maxHeight = '0';
            this.feedback.style.opacity = '0';
            this.feedback.style.marginTop = '0';
        }
        this.updateButtons();
        this.refresh();
        this.startCountdown();
    },
    close() {
        if (!this.overlay) return;
        this.overlay.classList.remove('show');
        this.overlay.setAttribute('aria-hidden', 'true');
        if (this.countdown) {
            clearInterval(this.countdown);
            this.countdown = null;
        }
        if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
    },
    async refresh() {
        if (!this.overlay) return;
        if (this.refreshPromise) return this.refreshPromise;
        const run = async () => {
            if (this.stateLine) this.stateLine.textContent = '当前状态：读取中...';
            if (this.modeLine) this.modeLine.textContent = '运行模式：读取中...';
            if (this.phaseLine) this.phaseLine.textContent = '当前阶段：--';
            if (this.nextRunLine) this.nextRunLine.textContent = '距离切换：--';
            if (this.updatedLine) this.updatedLine.textContent = '最近操作：--';
            if (this.viaLine) this.viaLine.textContent = '';
            const parseNullableNumber = (val) => {
                if (val === null || val === undefined) return null;
                const num = Number(val);
                return Number.isFinite(num) ? num : null;
            };
            try {
                const deviceId = this.getDeviceId();
                const resp = await fetch(`/api/mq2/state?device_id=${encodeURIComponent(deviceId)}`);
                const data = await resp.json();
                if (data?.success) {
                    this.state = (data.state || 'unknown').toLowerCase();
                    this.currentMode = data.mode || this.currentMode;
                    this.phase = data.phase || 'unknown';
                    this.phaseMessage = data.phase_message || '';
                    this.phaseUntil = parseNullableNumber(data.phase_until);
                    this.stateUpdatedAt = data.updated_at || null;
                    this.lastVia = data.last_via || null;
                    if (this.modeLine) {
                        this.modeLine.textContent = `运行模式：${data.mode_icon || ''} ${data.mode_name || '未知模式'}`;
                    }
                } else {
                    this.resetState();
                }
            } catch (e) {
                this.resetState();
            }
            this.updatePhaseLine();
            this.updateModeButtons();
            this.startCountdown();
            this.renderState();
            this.handlePendingPhase();
            this.updateButtons();
        };
        this.refreshPromise = run();
        try {
            await this.refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
    },
    renderState() {
        if (this.stateLine) {
            let text = '当前状态：';
            if (this.phase === 'manual') {
                text += '已关闭（手动）';
            } else if (this.state === 'on') {
                text += '已开启（实时监测）';
            } else if (this.state === 'off') {
                text += '自动休眠中';
            } else {
                text += '未知';
            }
            this.stateLine.textContent = text;
        }
        if (this.updatedLine) {
            if (this.stateUpdatedAt) {
                const date = new Date(this.stateUpdatedAt * 1000);
                this.updatedLine.textContent = `最近操作：${date.toLocaleString('zh-CN')}`;
            } else {
                this.updatedLine.textContent = '最近操作：--';
            }
        }
        if (this.viaLine) {
            if (this.lastVia) {
                const source = this.lastVia === 'BLE' ? '蓝牙' : (this.lastVia === 'MQTT' ? 'MQTT' : this.lastVia);
                this.viaLine.textContent = `指令来源：${source}`;
            } else {
                this.viaLine.textContent = '';
            }
        }
    },
    resetState() {
        this.state = 'unknown';
        this.currentMode = 'eco';
        this.phase = 'on';
        this.phaseMessage = '';
        this.phaseUntil = null;
        if (this.modeLine) this.modeLine.textContent = '运行模式：读取中...';
        if (this.phaseLine) this.phaseLine.textContent = '当前阶段：--';
        if (this.nextRunLine) this.nextRunLine.textContent = '距离切换：--';
        this.updateModeButtons();
        this.updatePhaseLine();
        this.stateUpdatedAt = null;
        this.lastVia = null;
        this.renderState();
    },
    handlePendingPhase() {
        const isPending = this.phase === 'pending' || (this.phaseMessage && this.phaseMessage.includes('模式切换中'));
        if (isPending) {
            if (this.pendingTimer) clearTimeout(this.pendingTimer);
            this.pendingTimer = setTimeout(() => {
                this.pendingTimer = null;
                this.refresh();
            }, 1500);
        } else if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
    },
    updateModeButtons() {
        this.modeButtons?.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === this.currentMode);
        });
    },
    updatePhaseLine() {
        if (!this.phaseLine) return;
        const baseMsg = this.phaseMessage || (this.phase === 'off' ? '休眠中' : '供电中');
        if (this.phase === 'manual') {
            this.phaseLine.textContent = `当前阶段：${this.phaseMessage || '手动关闭'}`;
        } else {
            this.phaseLine.textContent = `当前阶段：${baseMsg}`;
        }
    },
    startCountdown() {
        if (!this.nextRunLine) return;
        if (this.countdown) {
            clearInterval(this.countdown);
            this.countdown = null;
        }
        const updateLine = () => {
            if (this.phase === 'manual') {
                this.nextRunLine.textContent = '距离切换：--';
                return;
            }
            if (!this.phaseUntil) {
                this.nextRunLine.textContent = '距离切换：--';
                return;
            }
            const remaining = Math.max(0, Math.floor(this.phaseUntil - Date.now() / 1000));
            if (remaining <= 0) {
                this.nextRunLine.textContent = '距离切换：即将切换';
                const now = Date.now();
                if (!this.countdownRefreshAt || now - this.countdownRefreshAt > 5000) {
                    this.countdownRefreshAt = now;
                    this.refresh();
                }
            } else {
                this.nextRunLine.textContent = `距离切换：${this.formatDuration(remaining)}`;
            }
        };
        updateLine();
        if (this.phase === 'manual') return;
        this.countdown = setInterval(updateLine, 1000);
    },
    formatDuration(totalSeconds) {
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        if (minutes > 0) {
            return `${minutes}分${seconds}秒`;
        }
        return `${seconds}秒`;
    },
    async setMode(mode) {
        if (!mode || mode === this.currentMode) return;
        try {
            const deviceId = this.getDeviceId();
            const resp = await fetch('/api/mq2/mode', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({mode, device_id: deviceId})
            });
            const data = await resp.json();
            if (data?.success) {
                this.currentMode = mode;
                this.updateModeButtons();
                const msg = `已切换为：${data.mode_icon || ''} ${data.mode_name || ''}`.trim();
                this.showFeedback(msg);
                showNotification(`✅ ${msg}`);
                await this.refresh();
            } else {
                this.showFeedback(`切换失败：${data?.error || '未知错误'}`);
            }
        } catch (e) {
            this.showFeedback('切换失败，请检查连接');
        }
    },
    updateButtons() {
        const knowsState = this.state === 'on' || this.state === 'off';
        if (this.btnOn && this.btnOn.dataset.loading !== '1') this.btnOn.disabled = false;
        if (this.btnOff && this.btnOff.dataset.loading !== '1') this.btnOff.disabled = false;
        this.btnOn?.classList.toggle('active', this.state === 'on');
        this.btnOff?.classList.toggle('active', this.state === 'off');
        if (!knowsState) {
            this.btnOn?.classList.remove('active');
            this.btnOff?.classList.remove('active');
        }
    },
    async sendSwitch(action) {
        const targetBtn = action === 'on' ? this.btnOn : this.btnOff;
        if (!targetBtn) return;
        const originalText = targetBtn.textContent;
        try {
            targetBtn.disabled = true;
            targetBtn.dataset.loading = '1';
            targetBtn.textContent = '发送中...';
            this.showFeedback('', true);
            const deviceId = this.getDeviceId();
            const resp = await fetch('/api/mq2/switch', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({action, device_id: deviceId})
            });
            const res = await resp.json();
            if (res?.success) {
                this.state = (res.state || (action === 'off' ? 'off' : 'on')).toLowerCase();
                this.stateUpdatedAt = res.updated_at || null;
                this.lastVia = res.last_via || null;
                const via = res.via === 'BLE' ? '蓝牙' : res.via === 'MQTT' ? 'MQTT' : '接口';
                const msg = `已通过${via}发送${action === 'off' ? '关闭' : '开启'}指令`;
                this.showFeedback(msg);
                showNotification(`✅ ${msg}`);
            } else {
                this.showFeedback(`发送失败：${res?.error || '未知错误'}`);
            }
        } catch (e) {
            this.showFeedback('发送失败，请检查连接');
        } finally {
            targetBtn.textContent = originalText;
            targetBtn.dataset.loading = '0';
            targetBtn.disabled = false;
            await this.refresh();
        }
    },
    showFeedback(message, isReset = false) {
        if (!this.feedback) return;
        if (isReset || !message) {
            this.feedback.textContent = '';
            this.feedback.style.maxHeight = '0';
            this.feedback.style.opacity = '0';
            this.feedback.style.marginTop = '0';
            return;
        }
        this.feedback.textContent = message;
        const words = message.trim().split(/\s+/);
        const strength = Math.min(words.length * 4, 28);
        this.feedback.style.maxHeight = `${32 + strength}px`;
        this.feedback.style.opacity = '1';
        this.feedback.style.marginTop = '6px';
    }
};

// ============ BMP180 Control ============
function ensureBmp180OverlayTemplate() {
    if (document.getElementById('overlayBMP180')) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
    <div id="overlayBMP180" class="overlay" aria-hidden="true">
        <div class="modal mq2-modal" role="dialog" aria-modal="true" aria-labelledby="modalTitleBMP180">
            <div class="modal-head mq2-modal-head">
                <div class="mq2-title-with-info">
                    <div class="mq2-title-text">
                        <span class="mq2-title-icon">🌡️</span>
                        <span id="modalTitleBMP180">气压传感器控制</span>
                    </div>
                </div>
                <div class="modal-actions">
                    <button id="closeOverlayBMP180" class="close-btn" title="关闭">✕</button>
                </div>
            </div>
            <div class="modal-body">
                <div class="mq2-body">
                    <div class="mq2-section mq2-meta">
                        <div>传感器：<strong>BMP180 气压传感器</strong></div>
                        <div id="bmp180ModeLine" class="mq2-subtle">运行模式：读取中...</div>
                        <div id="bmp180StateLine">当前状态：读取中...</div>
                        <div id="bmp180PhaseLine" class="mq2-subtle">当前阶段：--</div>
                        <div id="bmp180NextRunLine" class="mq2-subtle">距离切换：--</div>
                        <div id="bmp180UpdatedLine" class="mq2-subtle">最近操作：--</div>
                        <div id="bmp180ViaLine" class="mq2-subtle"></div>
                    </div>
                    <div class="mq2-section mq2-mode-selector">
                        <div class="mq2-section-head" data-role="bmp180-mode-head">运行模式</div>
                        <div class="mq2-mode-options">
                            <button class="mq2-mode-btn" data-mode="eco">
                                <span class="mode-icon">💤</span>
                                <div class="mode-text">
                                    <span class="mode-name">省电模式</span>
                                    <span class="mode-desc">开机5分钟 · 休眠25分钟</span>
                                </div>
                            </button>
                            <button class="mq2-mode-btn" data-mode="balance">
                                <span class="mode-icon">⚖️</span>
                                <div class="mode-text">
                                    <span class="mode-name">平衡模式</span>
                                    <span class="mode-desc">开机15分钟 · 休眠15分钟</span>
                                </div>
                            </button>
                            <button class="mq2-mode-btn" data-mode="safe">
                                <span class="mode-icon">🔥</span>
                                <div class="mode-text">
                                    <span class="mode-name">安全模式</span>
                                    <span class="mode-desc">开机25分钟 · 休眠5分钟</span>
                                </div>
                            </button>
                            <button class="mq2-mode-btn" data-mode="always">
                                <span class="mode-icon">⚡</span>
                                <div class="mode-text">
                                    <span class="mode-name">不省电</span>
                                    <span class="mode-desc">持续供电，快速响应</span>
                                </div>
                            </button>
                        </div>
                    </div>
                    <div class="mq2-section mq2-actions-card">
                        <div class="mq2-section-head">远程指令</div>
                        <div class="mq2-actions">
                            <button id="btnBmp180On" class="btn" type="button">开启传感器</button>
                            <button id="btnBmp180Off" class="btn" type="button">关闭传感器</button>
                        </div>
                        <div id="bmp180Feedback" class="mq2-feedback"></div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;
    document.body.appendChild(wrapper.firstElementChild);
}

const BMP180Control = {
    overlay: null,
    deviceId: null,
    state: 'unknown',
    stateUpdatedAt: null,
    lastVia: null,
    currentMode: 'always',
    phase: 'on',
    phaseMessage: '',
    phaseUntil: null,
    countdown: null,
    countdownRefreshAt: 0,
    pendingTimer: null,
    refreshPromise: null,
    setDeviceId(deviceId) {
        const normalizedId = deviceId ? deviceId.toString().trim().toUpperCase() : null;
        this.deviceId = normalizedId;
        if (this.overlay && this.deviceId) {
            const titleEl = document.getElementById('modalTitleBMP180');
            if (titleEl) {
                // 只更新文本部分，不包含emoji（emoji已经在模板中）
                titleEl.textContent = `${this.deviceId} 气压传感器控制`;
            }
        }
    },
    getDeviceId() {
        if (this.deviceId) return this.deviceId;
        if (window.getSelectedDeviceId) {
            const id = window.getSelectedDeviceId();
            if (id) {
                this.deviceId = id.toString().trim().toUpperCase();
                return this.deviceId;
            }
        }
        this.deviceId = 'D01';
        return this.deviceId;
    },
    init() {
        ensureBmp180OverlayTemplate();
        this.overlay = document.getElementById('overlayBMP180');
        if (!this.overlay) return;
        this.modeLine = document.getElementById('bmp180ModeLine');
        this.stateLine = document.getElementById('bmp180StateLine');
        this.phaseLine = document.getElementById('bmp180PhaseLine');
        this.nextRunLine = document.getElementById('bmp180NextRunLine');
        this.updatedLine = document.getElementById('bmp180UpdatedLine');
        this.viaLine = document.getElementById('bmp180ViaLine');
        this.feedback = document.getElementById('bmp180Feedback');
        this.modeButtons = Array.from(document.querySelectorAll('#overlayBMP180 .mq2-mode-btn'));
        this.modeButtons.forEach(btn => {
            btn.addEventListener('click', async () => {
                const hasAccess = await requireControlPassword('请输入密码以切换运行模式');
                if (!hasAccess) return;
                const mode = btn.dataset.mode;
                if (mode) this.setMode(mode);
            });
        });
        this.modeHeader = this.overlay.querySelector('[data-role="bmp180-mode-head"]');
        this.modeHeader?.addEventListener('click', async () => {
            const hasAccess = await requireControlPassword('请输入密码以切换到开发模式');
            if (!hasAccess) return;
            this.setMode('dev');
        });
        this.btnOn = document.getElementById('btnBmp180On');
        this.btnOff = document.getElementById('btnBmp180Off');
        this.btnOn?.addEventListener('click', async () => {
            const hasAccess = await requireControlPassword('请输入密码以开启传感器');
            if (!hasAccess) return;
            this.sendSwitch('on');
        });
        this.btnOff?.addEventListener('click', async () => {
            const hasAccess = await requireControlPassword('请输入密码以关闭传感器');
            if (!hasAccess) return;
            this.sendSwitch('off');
        });
        const closeBtn = document.getElementById('closeOverlayBMP180');
        closeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.close();
        });
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                e.stopPropagation();
                this.close();
            }
        });
        // 阻止modal内部的点击事件冒泡到overlay
        const modal = this.overlay.querySelector('.modal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }
        this.updateButtons();
    },
    open() {
        if (!this.overlay) return;
        let targetDeviceId = this.deviceId;
        if (window.PowerControlModal && window.PowerControlModal.currentDeviceId) {
            targetDeviceId = window.PowerControlModal.currentDeviceId;
            this.setDeviceId(targetDeviceId);
        }
        if (!targetDeviceId) {
            const deviceId = this.getDeviceId();
            this.setDeviceId(deviceId);
            targetDeviceId = deviceId;
        }
        if (targetDeviceId) {
            const titleEl = document.getElementById('modalTitleBMP180');
            if (titleEl) {
                // 只更新文本部分，不包含emoji（emoji已经在模板中）
                titleEl.textContent = `${targetDeviceId} 气压传感器控制`;
            }
        }
        this.overlay.classList.add('show');
        this.overlay.setAttribute('aria-hidden', 'false');
        if (this.feedback) {
            this.feedback.textContent = '';
            this.feedback.style.maxHeight = '0';
            this.feedback.style.opacity = '0';
            this.feedback.style.marginTop = '0';
        }
        this.updateButtons();
        this.refresh();
        this.startCountdown();
    },
    close() {
        if (!this.overlay) return;
        this.overlay.classList.remove('show');
        this.overlay.setAttribute('aria-hidden', 'true');
        if (this.countdown) {
            clearInterval(this.countdown);
            this.countdown = null;
        }
        if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
    },
    async refresh() {
        if (!this.overlay) return;
        if (this.refreshPromise) return this.refreshPromise;
        const run = async () => {
            if (this.stateLine) this.stateLine.textContent = '当前状态：读取中...';
            if (this.modeLine) this.modeLine.textContent = '运行模式：读取中...';
            if (this.phaseLine) this.phaseLine.textContent = '当前阶段：--';
            if (this.nextRunLine) this.nextRunLine.textContent = '距离切换：--';
            if (this.updatedLine) this.updatedLine.textContent = '最近操作：--';
            if (this.viaLine) this.viaLine.textContent = '';
            try {
                const deviceId = this.getDeviceId();
                const resp = await fetch(`/api/bmp180/state?device_id=${encodeURIComponent(deviceId)}`);
                const data = await resp.json();
                if (data?.success) {
                    this.state = (data.state || 'unknown').toLowerCase();
                    this.currentMode = data.mode || this.currentMode;
                    this.phase = data.phase || 'unknown';
                    this.phaseMessage = data.phase_message || '';
                    // phase_until可能是时间戳（秒）或null
                    this.phaseUntil = data.phase_until ? (typeof data.phase_until === 'string' ? parseFloat(data.phase_until) : data.phase_until) : null;
                    this.stateUpdatedAt = data.updated_at || null;
                    this.lastVia = data.last_via || null;
                    if (this.modeLine) {
                        this.modeLine.textContent = `运行模式：${data.mode_icon || ''} ${data.mode_name || '未知模式'}`;
                    }
                } else {
                    this.resetState();
                }
            } catch (e) {
                this.resetState();
            }
            this.updatePhaseLine();
            this.updateModeButtons();
            this.startCountdown();
            this.renderState();
            this.handlePendingPhase();
            this.updateButtons();
        };
        this.refreshPromise = run();
        try {
            await this.refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
    },
    renderState() {
        if (this.stateLine) {
            let text = '当前状态：';
            if (this.phase === 'manual') {
                text += '已关闭（手动）';
            } else if (this.state === 'on') {
                text += '已开启（实时监测）';
            } else if (this.state === 'off') {
                text += '自动休眠中';
            } else {
                text += '未知';
            }
            this.stateLine.textContent = text;
        }
        if (this.updatedLine) {
            if (this.stateUpdatedAt) {
                // updated_at可能是时间戳（秒）或null
                const timestamp = typeof this.stateUpdatedAt === 'string' ? parseFloat(this.stateUpdatedAt) : this.stateUpdatedAt;
                if (timestamp && !isNaN(timestamp)) {
                    const date = new Date(timestamp * 1000);
                    this.updatedLine.textContent = `最近操作：${date.toLocaleString('zh-CN')}`;
                } else {
                    this.updatedLine.textContent = '最近操作：--';
                }
            } else {
                this.updatedLine.textContent = '最近操作：--';
            }
        }
        if (this.viaLine) {
            if (this.lastVia) {
                const source = this.lastVia === 'BLE' ? '蓝牙' : (this.lastVia === 'MQTT' ? 'MQTT' : this.lastVia);
                this.viaLine.textContent = `指令来源：${source}`;
            } else {
                this.viaLine.textContent = '';
            }
        }
    },
    resetState() {
        this.state = 'unknown';
        this.currentMode = 'always';
        this.phase = 'on';
        this.phaseMessage = '';
        this.phaseUntil = null;
        if (this.modeLine) this.modeLine.textContent = '运行模式：读取中...';
        if (this.phaseLine) this.phaseLine.textContent = '当前阶段：--';
        if (this.nextRunLine) this.nextRunLine.textContent = '距离切换：--';
        this.updateModeButtons();
        this.updatePhaseLine();
        this.stateUpdatedAt = null;
        this.lastVia = null;
        this.renderState();
    },
    handlePendingPhase() {
        const isPending = this.phase === 'pending' || (this.phaseMessage && this.phaseMessage.includes('模式切换中'));
        if (isPending) {
            if (this.pendingTimer) clearTimeout(this.pendingTimer);
            this.pendingTimer = setTimeout(() => {
                this.pendingTimer = null;
                this.refresh();
            }, 1500);
        } else if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
    },
    updateModeButtons() {
        this.modeButtons?.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === this.currentMode);
        });
    },
    updatePhaseLine() {
        if (!this.phaseLine) return;
        const baseMsg = this.phaseMessage || (this.phase === 'off' ? '休眠中' : '供电中');
        if (this.phase === 'manual') {
            this.phaseLine.textContent = `当前阶段：${this.phaseMessage || '手动关闭'}`;
        } else {
            this.phaseLine.textContent = `当前阶段：${baseMsg}`;
        }
    },
    startCountdown() {
        if (!this.nextRunLine) return;
        if (this.countdown) {
            clearInterval(this.countdown);
            this.countdown = null;
        }
        const updateLine = () => {
            if (this.phase === 'manual') {
                this.nextRunLine.textContent = '距离切换：--';
                return;
            }
            if (!this.phaseUntil) {
                this.nextRunLine.textContent = '距离切换：--';
                return;
            }
            const remaining = Math.max(0, Math.floor(this.phaseUntil - Date.now() / 1000));
            if (remaining <= 0) {
                this.nextRunLine.textContent = '距离切换：即将切换';
                const now = Date.now();
                if (!this.countdownRefreshAt || now - this.countdownRefreshAt > 5000) {
                    this.countdownRefreshAt = now;
                    this.refresh();
                }
            } else {
                this.nextRunLine.textContent = `距离切换：${this.formatDuration(remaining)}`;
            }
        };
        updateLine();
        if (this.phase === 'manual') return;
        this.countdown = setInterval(updateLine, 1000);
    },
    formatDuration(totalSeconds) {
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        if (minutes > 0) {
            return `${minutes}分${seconds}秒`;
        }
        return `${seconds}秒`;
    },
    async setMode(mode) {
        if (!mode || mode === this.currentMode) return;
        try {
            const deviceId = this.getDeviceId();
            const resp = await fetch('/api/bmp180/mode', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({mode, device_id: deviceId})
            });
            const data = await resp.json();
            if (data?.success) {
                this.currentMode = mode;
                this.updateModeButtons();
                const msg = `已切换为：${data.mode_icon || ''} ${data.mode_name || ''}`.trim();
                this.showFeedback(msg);
                showNotification(`✅ ${msg}`);
                await this.refresh();
            } else {
                this.showFeedback(`切换失败：${data?.error || '未知错误'}`);
            }
        } catch (e) {
            this.showFeedback('切换失败，请检查连接');
        }
    },
    updateButtons() {
        const knowsState = this.state === 'on' || this.state === 'off';
        if (this.btnOn && this.btnOn.dataset.loading !== '1') this.btnOn.disabled = false;
        if (this.btnOff && this.btnOff.dataset.loading !== '1') this.btnOff.disabled = false;
        this.btnOn?.classList.toggle('active', this.state === 'on');
        this.btnOff?.classList.toggle('active', this.state === 'off');
        if (!knowsState) {
            this.btnOn?.classList.remove('active');
            this.btnOff?.classList.remove('active');
        }
    },
    async sendSwitch(action) {
        const targetBtn = action === 'on' ? this.btnOn : this.btnOff;
        if (!targetBtn) return;
        const originalText = targetBtn.textContent;
        try {
            targetBtn.disabled = true;
            targetBtn.dataset.loading = '1';
            targetBtn.textContent = '发送中...';
            this.showFeedback('', true);
            const deviceId = this.getDeviceId();
            const resp = await fetch('/api/bmp180/switch', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({action, device_id: deviceId})
            });
            const res = await resp.json();
            if (res?.success) {
                this.state = (res.state || (action === 'off' ? 'off' : 'on')).toLowerCase();
                this.stateUpdatedAt = res.updated_at || null;
                this.lastVia = res.last_via || null;
                const via = res.via === 'BLE' ? '蓝牙' : res.via === 'MQTT' ? 'MQTT' : '接口';
                const msg = `已通过${via}发送${action === 'off' ? '关闭' : '开启'}指令`;
                this.showFeedback(msg);
                showNotification(`✅ ${msg}`);
            } else {
                this.showFeedback(`发送失败：${res?.error || '未知错误'}`);
            }
        } catch (e) {
            this.showFeedback('发送失败，请检查连接');
        } finally {
            targetBtn.textContent = originalText;
            targetBtn.dataset.loading = '0';
            targetBtn.disabled = false;
            await this.refresh();
        }
    },
    showFeedback(message, isReset = false) {
        if (!this.feedback) return;
        if (isReset || !message) {
            this.feedback.textContent = '';
            this.feedback.style.maxHeight = '0';
            this.feedback.style.opacity = '0';
            this.feedback.style.marginTop = '0';
            return;
        }
        this.feedback.textContent = message;
        const words = message.trim().split(/\s+/);
        const strength = Math.min(words.length * 4, 28);
        this.feedback.style.maxHeight = `${32 + strength}px`;
        this.feedback.style.opacity = '1';
        this.feedback.style.marginTop = '6px';
    }
};

// 由于代码长度限制，BH1750Control将使用类似的实现，但API路径不同
// 为了节省空间，我将创建一个简化的版本
const BH1750Control = JSON.parse(JSON.stringify(BMP180Control));
BH1750Control.overlay = null;
BH1750Control.deviceId = null;
BH1750Control.currentMode = 'always';
// 重写需要修改的方法
Object.assign(BH1750Control, {
    init() {
        // 需要创建BH1750的模板
        if (!document.getElementById('overlayBH1750')) {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = `
            <div id="overlayBH1750" class="overlay" aria-hidden="true">
                <div class="modal mq2-modal" role="dialog" aria-modal="true" aria-labelledby="modalTitleBH1750">
                    <div class="modal-head mq2-modal-head">
                        <div class="mq2-title-with-info">
                            <div class="mq2-title-text">
                                <span class="mq2-title-icon">💡</span>
                                <span id="modalTitleBH1750">亮度传感器控制</span>
                            </div>
                        </div>
                        <div class="modal-actions">
                            <button id="closeOverlayBH1750" class="close-btn" title="关闭">✕</button>
                        </div>
                    </div>
                    <div class="modal-body">
                        <div class="mq2-body">
                            <div class="mq2-section mq2-meta">
                                <div>传感器：<strong>BH1750 亮度传感器</strong></div>
                                <div id="bh1750ModeLine" class="mq2-subtle">运行模式：读取中...</div>
                                <div id="bh1750StateLine">当前状态：读取中...</div>
                                <div id="bh1750PhaseLine" class="mq2-subtle">当前阶段：--</div>
                                <div id="bh1750NextRunLine" class="mq2-subtle">距离切换：--</div>
                                <div id="bh1750UpdatedLine" class="mq2-subtle">最近操作：--</div>
                                <div id="bh1750ViaLine" class="mq2-subtle"></div>
                            </div>
                            <div class="mq2-section mq2-mode-selector">
                                <div class="mq2-section-head" data-role="bh1750-mode-head">运行模式</div>
                                <div class="mq2-mode-options">
                                    <button class="mq2-mode-btn" data-mode="eco">
                                        <span class="mode-icon">💤</span>
                                        <div class="mode-text">
                                            <span class="mode-name">省电模式</span>
                                            <span class="mode-desc">开机5分钟 · 休眠25分钟</span>
                                        </div>
                                    </button>
                                    <button class="mq2-mode-btn" data-mode="balance">
                                        <span class="mode-icon">⚖️</span>
                                        <div class="mode-text">
                                            <span class="mode-name">平衡模式</span>
                                            <span class="mode-desc">开机15分钟 · 休眠15分钟</span>
                                        </div>
                                    </button>
                                    <button class="mq2-mode-btn" data-mode="safe">
                                        <span class="mode-icon">🔥</span>
                                        <div class="mode-text">
                                            <span class="mode-name">安全模式</span>
                                            <span class="mode-desc">开机25分钟 · 休眠5分钟</span>
                                        </div>
                                    </button>
                                    <button class="mq2-mode-btn" data-mode="always">
                                        <span class="mode-icon">⚡</span>
                                        <div class="mode-text">
                                            <span class="mode-name">不省电</span>
                                            <span class="mode-desc">持续供电，快速响应</span>
                                        </div>
                                    </button>
                                </div>
                            </div>
                            <div class="mq2-section mq2-actions-card">
                                <div class="mq2-section-head">远程指令</div>
                                <div class="mq2-actions">
                                    <button id="btnBh1750On" class="btn" type="button">开启传感器</button>
                                    <button id="btnBh1750Off" class="btn" type="button">关闭传感器</button>
                                </div>
                                <div id="bh1750Feedback" class="mq2-feedback"></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>`;
            document.body.appendChild(wrapper.firstElementChild);
        }
        this.overlay = document.getElementById('overlayBH1750');
        if (!this.overlay) return;
        this.modeLine = document.getElementById('bh1750ModeLine');
        this.stateLine = document.getElementById('bh1750StateLine');
        this.phaseLine = document.getElementById('bh1750PhaseLine');
        this.nextRunLine = document.getElementById('bh1750NextRunLine');
        this.updatedLine = document.getElementById('bh1750UpdatedLine');
        this.viaLine = document.getElementById('bh1750ViaLine');
        this.feedback = document.getElementById('bh1750Feedback');
        this.modeButtons = Array.from(document.querySelectorAll('#overlayBH1750 .mq2-mode-btn'));
        this.modeButtons.forEach(btn => {
            btn.addEventListener('click', async () => {
                const hasAccess = await requireControlPassword('请输入密码以切换运行模式');
                if (!hasAccess) return;
                const mode = btn.dataset.mode;
                if (mode) this.setMode(mode);
            });
        });
        this.modeHeader = this.overlay.querySelector('[data-role="bh1750-mode-head"]');
        this.modeHeader?.addEventListener('click', async () => {
            const hasAccess = await requireControlPassword('请输入密码以切换到开发模式');
            if (!hasAccess) return;
            this.setMode('dev');
        });
        this.btnOn = document.getElementById('btnBh1750On');
        this.btnOff = document.getElementById('btnBh1750Off');
        this.btnOn?.addEventListener('click', async () => {
            const hasAccess = await requireControlPassword('请输入密码以开启传感器');
            if (!hasAccess) return;
            this.sendSwitch('on');
        });
        this.btnOff?.addEventListener('click', async () => {
            const hasAccess = await requireControlPassword('请输入密码以关闭传感器');
            if (!hasAccess) return;
            this.sendSwitch('off');
        });
        const closeBtn = document.getElementById('closeOverlayBH1750');
        closeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.close();
        });
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                e.stopPropagation();
                this.close();
            }
        });
        // 阻止modal内部的点击事件冒泡到overlay
        const modal = this.overlay.querySelector('.modal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }
        this.updateButtons();
    },
    setDeviceId(deviceId) {
        const normalizedId = deviceId ? deviceId.toString().trim().toUpperCase() : null;
        this.deviceId = normalizedId;
        if (this.overlay && this.deviceId) {
            const titleEl = document.getElementById('modalTitleBH1750');
            if (titleEl) {
                // 只更新文本部分，不包含emoji（emoji已经在模板中）
                titleEl.textContent = `${this.deviceId} 亮度传感器控制`;
            }
        }
    },
    getDeviceId() {
        if (this.deviceId) return this.deviceId;
        if (window.getSelectedDeviceId) {
            const id = window.getSelectedDeviceId();
            if (id) {
                this.deviceId = id.toString().trim().toUpperCase();
                return this.deviceId;
            }
        }
        this.deviceId = 'D01';
        return this.deviceId;
    },
    open() {
        if (!this.overlay) return;
        let targetDeviceId = this.deviceId;
        if (window.PowerControlModal && window.PowerControlModal.currentDeviceId) {
            targetDeviceId = window.PowerControlModal.currentDeviceId;
            this.setDeviceId(targetDeviceId);
        }
        if (!targetDeviceId) {
            const deviceId = this.getDeviceId();
            this.setDeviceId(deviceId);
            targetDeviceId = deviceId;
        }
        if (targetDeviceId) {
            const titleEl = document.getElementById('modalTitleBH1750');
            if (titleEl) {
                // 只更新文本部分，不包含emoji（emoji已经在模板中）
                titleEl.textContent = `${targetDeviceId} 亮度传感器控制`;
            }
        }
        this.overlay.classList.add('show');
        this.overlay.setAttribute('aria-hidden', 'false');
        if (this.feedback) {
            this.feedback.textContent = '';
            this.feedback.style.maxHeight = '0';
            this.feedback.style.opacity = '0';
            this.feedback.style.marginTop = '0';
        }
        this.updateButtons();
        this.refresh();
        this.startCountdown();
    },
    close() {
        if (!this.overlay) return;
        this.overlay.classList.remove('show');
        this.overlay.setAttribute('aria-hidden', 'true');
        if (this.countdown) {
            clearInterval(this.countdown);
            this.countdown = null;
        }
        if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
    },
    async refresh() {
        if (!this.overlay) return;
        if (this.refreshPromise) return this.refreshPromise;
        const run = async () => {
            if (this.stateLine) this.stateLine.textContent = '当前状态：读取中...';
            if (this.modeLine) this.modeLine.textContent = '运行模式：读取中...';
            if (this.phaseLine) this.phaseLine.textContent = '当前阶段：--';
            if (this.nextRunLine) this.nextRunLine.textContent = '距离切换：--';
            if (this.updatedLine) this.updatedLine.textContent = '最近操作：--';
            if (this.viaLine) this.viaLine.textContent = '';
            try {
                const deviceId = this.getDeviceId();
                const resp = await fetch(`/api/bh1750/state?device_id=${encodeURIComponent(deviceId)}`);
                const data = await resp.json();
                if (data?.success) {
                    this.state = (data.state || 'unknown').toLowerCase();
                    this.currentMode = data.mode || this.currentMode;
                    this.phase = data.phase || 'unknown';
                    this.phaseMessage = data.phase_message || '';
                    // phase_until可能是时间戳（秒）或null
                    this.phaseUntil = data.phase_until ? (typeof data.phase_until === 'string' ? parseFloat(data.phase_until) : data.phase_until) : null;
                    this.stateUpdatedAt = data.updated_at || null;
                    this.lastVia = data.last_via || null;
                    if (this.modeLine) {
                        this.modeLine.textContent = `运行模式：${data.mode_icon || ''} ${data.mode_name || '未知模式'}`;
                    }
                } else {
                    this.resetState();
                }
            } catch (e) {
                this.resetState();
            }
            this.updatePhaseLine();
            this.updateModeButtons();
            this.startCountdown();
            this.renderState();
            this.handlePendingPhase();
            this.updateButtons();
        };
        this.refreshPromise = run();
        try {
            await this.refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
    },
    async setMode(mode) {
        if (!mode || mode === this.currentMode) return;
        try {
            const deviceId = this.getDeviceId();
            const resp = await fetch('/api/bh1750/mode', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({mode, device_id: deviceId})
            });
            const data = await resp.json();
            if (data?.success) {
                this.currentMode = mode;
                this.updateModeButtons();
                const msg = `已切换为：${data.mode_icon || ''} ${data.mode_name || ''}`.trim();
                this.showFeedback(msg);
                showNotification(`✅ ${msg}`);
                await this.refresh();
            } else {
                this.showFeedback(`切换失败：${data?.error || '未知错误'}`);
            }
        } catch (e) {
            this.showFeedback('切换失败，请检查连接');
        }
    },
    async sendSwitch(action) {
        const targetBtn = action === 'on' ? this.btnOn : this.btnOff;
        if (!targetBtn) return;
        const originalText = targetBtn.textContent;
        try {
            targetBtn.disabled = true;
            targetBtn.dataset.loading = '1';
            targetBtn.textContent = '发送中...';
            this.showFeedback('', true);
            const deviceId = this.getDeviceId();
            const resp = await fetch('/api/bh1750/switch', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({action, device_id: deviceId})
            });
            const res = await resp.json();
            if (res?.success) {
                this.state = (res.state || (action === 'off' ? 'off' : 'on')).toLowerCase();
                this.stateUpdatedAt = res.updated_at || null;
                this.lastVia = res.last_via || null;
                const via = res.via === 'BLE' ? '蓝牙' : res.via === 'MQTT' ? 'MQTT' : '接口';
                const msg = `已通过${via}发送${action === 'off' ? '关闭' : '开启'}指令`;
                this.showFeedback(msg);
                showNotification(`✅ ${msg}`);
            } else {
                this.showFeedback(`发送失败：${res?.error || '未知错误'}`);
            }
        } catch (e) {
            this.showFeedback('发送失败，请检查连接');
        } finally {
            targetBtn.textContent = originalText;
            targetBtn.dataset.loading = '0';
            targetBtn.disabled = false;
            await this.refresh();
        }
    },
    renderState() {
        if (this.stateLine) {
            let text = '当前状态：';
            if (this.phase === 'manual') {
                text += '已关闭（手动）';
            } else if (this.state === 'on') {
                text += '已开启（实时监测）';
            } else if (this.state === 'off') {
                text += '自动休眠中';
            } else {
                text += '未知';
            }
            this.stateLine.textContent = text;
        }
        if (this.updatedLine) {
            if (this.stateUpdatedAt) {
                // updated_at可能是时间戳（秒）或null
                const timestamp = typeof this.stateUpdatedAt === 'string' ? parseFloat(this.stateUpdatedAt) : this.stateUpdatedAt;
                if (timestamp && !isNaN(timestamp)) {
                    const date = new Date(timestamp * 1000);
                    this.updatedLine.textContent = `最近操作：${date.toLocaleString('zh-CN')}`;
                } else {
                    this.updatedLine.textContent = '最近操作：--';
                }
            } else {
                this.updatedLine.textContent = '最近操作：--';
            }
        }
        if (this.viaLine) {
            if (this.lastVia) {
                const source = this.lastVia === 'BLE' ? '蓝牙' : (this.lastVia === 'MQTT' ? 'MQTT' : this.lastVia);
                this.viaLine.textContent = `指令来源：${source}`;
            } else {
                this.viaLine.textContent = '';
            }
        }
    },
    resetState() {
        this.state = 'unknown';
        this.currentMode = 'always';
        this.phase = 'on';
        this.phaseMessage = '';
        this.phaseUntil = null;
        if (this.modeLine) this.modeLine.textContent = '运行模式：读取中...';
        if (this.phaseLine) this.phaseLine.textContent = '当前阶段：--';
        if (this.nextRunLine) this.nextRunLine.textContent = '距离切换：--';
        this.updateModeButtons();
        this.updatePhaseLine();
        this.stateUpdatedAt = null;
        this.lastVia = null;
        this.renderState();
    },
    handlePendingPhase() {
        const isPending = this.phase === 'pending' || (this.phaseMessage && this.phaseMessage.includes('模式切换中'));
        if (isPending) {
            if (this.pendingTimer) clearTimeout(this.pendingTimer);
            this.pendingTimer = setTimeout(() => {
                this.pendingTimer = null;
                this.refresh();
            }, 1500);
        } else if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
    },
    updateModeButtons() {
        this.modeButtons?.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === this.currentMode);
        });
    },
    updatePhaseLine() {
        if (!this.phaseLine) return;
        const baseMsg = this.phaseMessage || (this.phase === 'off' ? '休眠中' : '供电中');
        if (this.phase === 'manual') {
            this.phaseLine.textContent = `当前阶段：${this.phaseMessage || '手动关闭'}`;
        } else {
            this.phaseLine.textContent = `当前阶段：${baseMsg}`;
        }
    },
    startCountdown() {
        if (!this.nextRunLine) return;
        if (this.countdown) {
            clearInterval(this.countdown);
            this.countdown = null;
        }
        const updateLine = () => {
            if (this.phase === 'manual') {
                this.nextRunLine.textContent = '距离切换：--';
                return;
            }
            if (!this.phaseUntil) {
                this.nextRunLine.textContent = '距离切换：--';
                return;
            }
            const remaining = Math.max(0, Math.floor(this.phaseUntil - Date.now() / 1000));
            if (remaining <= 0) {
                this.nextRunLine.textContent = '距离切换：即将切换';
                const now = Date.now();
                if (!this.countdownRefreshAt || now - this.countdownRefreshAt > 5000) {
                    this.countdownRefreshAt = now;
                    this.refresh();
                }
            } else {
                this.nextRunLine.textContent = `距离切换：${this.formatDuration(remaining)}`;
            }
        };
        updateLine();
        if (this.phase === 'manual') return;
        this.countdown = setInterval(updateLine, 1000);
    },
    formatDuration(totalSeconds) {
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        if (minutes > 0) {
            return `${minutes}分${seconds}秒`;
        }
        return `${seconds}秒`;
    },
    async setMode(mode) {
        if (!mode || mode === this.currentMode) return;
        try {
            const deviceId = this.getDeviceId();
            const resp = await fetch('/api/bh1750/mode', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({mode, device_id: deviceId})
            });
            const data = await resp.json();
            if (data?.success) {
                this.currentMode = mode;
                this.updateModeButtons();
                const msg = `已切换为：${data.mode_icon || ''} ${data.mode_name || ''}`.trim();
                this.showFeedback(msg);
                showNotification(`✅ ${msg}`);
                await this.refresh();
            } else {
                this.showFeedback(`切换失败：${data?.error || '未知错误'}`);
            }
        } catch (e) {
            this.showFeedback('切换失败，请检查连接');
        }
    },
    updateButtons() {
        const knowsState = this.state === 'on' || this.state === 'off';
        if (this.btnOn && this.btnOn.dataset.loading !== '1') this.btnOn.disabled = false;
        if (this.btnOff && this.btnOff.dataset.loading !== '1') this.btnOff.disabled = false;
        this.btnOn?.classList.toggle('active', this.state === 'on');
        this.btnOff?.classList.toggle('active', this.state === 'off');
        if (!knowsState) {
            this.btnOn?.classList.remove('active');
            this.btnOff?.classList.remove('active');
        }
    },
    showFeedback(message, isReset = false) {
        if (!this.feedback) return;
        if (isReset || !message) {
            this.feedback.textContent = '';
            this.feedback.style.maxHeight = '0';
            this.feedback.style.opacity = '0';
            this.feedback.style.marginTop = '0';
            return;
        }
        this.feedback.textContent = message;
        const words = message.trim().split(/\s+/);
        const strength = Math.min(words.length * 4, 28);
        this.feedback.style.maxHeight = `${32 + strength}px`;
        this.feedback.style.opacity = '1';
        this.feedback.style.marginTop = '6px';
    }
});

// 导出全局函数
window.openOverlayBMP180 = () => {
    if (window.BMP180Control) {
        // 确保已经初始化
        if (!window.BMP180Control.overlay) {
            window.BMP180Control.init();
        }
        window.BMP180Control.open();
    }
};

window.openOverlayBH1750 = () => {
    if (window.BH1750Control) {
        // 确保已经初始化
        if (!window.BH1750Control.overlay) {
            window.BH1750Control.init();
        }
        window.BH1750Control.open();
    }
};

// ============ BLE Control ============
const BLEControl = {
    overlay: null,
    deviceId: null,
    state: 'unknown',
    stateUpdatedAt: null,
    lastVia: null,
    setDeviceId(deviceId) {
        const normalizedId = deviceId ? deviceId.toString().trim().toUpperCase() : null;
        this.deviceId = normalizedId;
        if (this.overlay && this.deviceId) {
            const titleEl = document.getElementById('modalTitleBLE');
            if (titleEl) {
                // 只更新文本部分，不包含emoji（emoji已经在模板中）
                titleEl.textContent = `${this.deviceId} 蓝牙控制`;
            }
        }
    },
    getDeviceId() {
        if (this.deviceId) return this.deviceId;
        if (window.getSelectedDeviceId) {
            const id = window.getSelectedDeviceId();
            if (id) {
                this.deviceId = id.toString().trim().toUpperCase();
                return this.deviceId;
            }
        }
        this.deviceId = 'D01';
        return this.deviceId;
    },
    init() {
        if (!document.getElementById('overlayBLE')) {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = `
            <div id="overlayBLE" class="overlay" aria-hidden="true">
                <div class="modal mq2-modal" role="dialog" aria-modal="true" aria-labelledby="modalTitleBLE">
                    <div class="modal-head mq2-modal-head">
                        <div class="mq2-title-with-info">
                            <div class="mq2-title-text">
                                <span class="mq2-title-icon">📶</span>
                                <span id="modalTitleBLE">蓝牙控制</span>
                            </div>
                        </div>
                        <div class="modal-actions">
                            <button id="closeOverlayBLE" class="close-btn" title="关闭">✕</button>
                        </div>
                    </div>
                    <div class="modal-body">
                        <div class="mq2-body">
                            <div class="mq2-section mq2-meta">
                                <div>设备：<strong>BLE 蓝牙</strong></div>
                                <div id="bleStateLine">当前状态：读取中...</div>
                                <div id="bleUpdatedLine" class="mq2-subtle">最近操作：--</div>
                                <div id="bleViaLine" class="mq2-subtle"></div>
                            </div>
                            <div class="mq2-section mq2-actions-card">
                                <div class="mq2-section-head">远程指令</div>
                                <div class="mq2-actions">
                                    <button id="btnBleOn" class="btn" type="button">开启蓝牙</button>
                                    <button id="btnBleOff" class="btn" type="button">关闭蓝牙</button>
                                </div>
                                <div id="bleFeedback" class="mq2-feedback"></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>`;
            document.body.appendChild(wrapper.firstElementChild);
        }
        this.overlay = document.getElementById('overlayBLE');
        if (!this.overlay) return;
        this.stateLine = document.getElementById('bleStateLine');
        this.updatedLine = document.getElementById('bleUpdatedLine');
        this.viaLine = document.getElementById('bleViaLine');
        this.feedback = document.getElementById('bleFeedback');
        this.btnOn = document.getElementById('btnBleOn');
        this.btnOff = document.getElementById('btnBleOff');
        this.btnOn?.addEventListener('click', async () => {
            const hasAccess = await requireControlPassword('请输入密码以开启蓝牙');
            if (!hasAccess) return;
            this.sendSwitch('on');
        });
        this.btnOff?.addEventListener('click', async () => {
            const hasAccess = await requireControlPassword('请输入密码以关闭蓝牙');
            if (!hasAccess) return;
            this.sendSwitch('off');
        });
        const closeBtn = document.getElementById('closeOverlayBLE');
        closeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.close();
        });
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                e.stopPropagation();
                this.close();
            }
        });
        // 阻止modal内部的点击事件冒泡到overlay
        const modal = this.overlay.querySelector('.modal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }
        this.updateButtons();
    },
    open() {
        if (!this.overlay) return;
        let targetDeviceId = this.deviceId;
        if (window.PowerControlModal && window.PowerControlModal.currentDeviceId) {
            targetDeviceId = window.PowerControlModal.currentDeviceId;
            this.setDeviceId(targetDeviceId);
        }
        if (!targetDeviceId) {
            const deviceId = this.getDeviceId();
            this.setDeviceId(deviceId);
            targetDeviceId = deviceId;
        }
        if (targetDeviceId) {
            const titleEl = document.getElementById('modalTitleBLE');
            if (titleEl) {
                // 只更新文本部分，不包含emoji（emoji已经在模板中）
                titleEl.textContent = `${targetDeviceId} 蓝牙控制`;
            }
        }
        this.overlay.classList.add('show');
        this.overlay.setAttribute('aria-hidden', 'false');
        if (this.feedback) {
            this.feedback.textContent = '';
            this.feedback.style.maxHeight = '0';
            this.feedback.style.opacity = '0';
            this.feedback.style.marginTop = '0';
        }
        this.updateButtons();
        this.refresh();
    },
    close() {
        if (!this.overlay) return;
        this.overlay.classList.remove('show');
        this.overlay.setAttribute('aria-hidden', 'true');
    },
    async refresh() {
        if (!this.overlay) return;
        if (this.stateLine) this.stateLine.textContent = '当前状态：读取中...';
        if (this.updatedLine) this.updatedLine.textContent = '最近操作：--';
        if (this.viaLine) this.viaLine.textContent = '';
        try {
            const deviceId = this.getDeviceId();
            const resp = await fetch(`/api/ble/state?device_id=${encodeURIComponent(deviceId)}`);
            const data = await resp.json();
            if (data?.success) {
                this.state = (data.state || 'unknown').toLowerCase();
                this.stateUpdatedAt = data.updated_at || null;
                this.lastVia = data.last_via || null;
                if (this.stateLine) {
                    this.stateLine.textContent = `当前状态：${this.state === 'on' ? '已开启' : this.state === 'off' ? '已关闭' : '未知'}`;
                }
                if (this.updatedLine && this.stateUpdatedAt) {
                    // updated_at可能是时间戳（秒）或null
                    const timestamp = typeof this.stateUpdatedAt === 'string' ? parseFloat(this.stateUpdatedAt) : this.stateUpdatedAt;
                    if (timestamp && !isNaN(timestamp)) {
                        const date = new Date(timestamp * 1000);
                        this.updatedLine.textContent = `最近操作：${date.toLocaleString('zh-CN')}`;
                    } else {
                        this.updatedLine.textContent = '最近操作：--';
                    }
                }
                if (this.viaLine && this.lastVia) {
                    const source = this.lastVia === 'BLE' ? '蓝牙' : (this.lastVia === 'MQTT' ? 'MQTT' : this.lastVia);
                    this.viaLine.textContent = `指令来源：${source}`;
                }
            }
        } catch (e) {
            console.error('刷新BLE状态失败：', e);
        }
        this.updateButtons();
    },
    updateButtons() {
        const knowsState = this.state === 'on' || this.state === 'off';
        if (this.btnOn && this.btnOn.dataset.loading !== '1') this.btnOn.disabled = false;
        if (this.btnOff && this.btnOff.dataset.loading !== '1') this.btnOff.disabled = false;
        this.btnOn?.classList.toggle('active', this.state === 'on');
        this.btnOff?.classList.toggle('active', this.state === 'off');
        if (!knowsState) {
            this.btnOn?.classList.remove('active');
            this.btnOff?.classList.remove('active');
        }
    },
    async sendSwitch(action) {
        const targetBtn = action === 'on' ? this.btnOn : this.btnOff;
        if (!targetBtn) return;
        const originalText = targetBtn.textContent;
        try {
            targetBtn.disabled = true;
            targetBtn.dataset.loading = '1';
            targetBtn.textContent = '发送中...';
            this.showFeedback('', true);
            const deviceId = this.getDeviceId();
            const resp = await fetch('/api/ble/switch', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({action, device_id: deviceId})
            });
            const res = await resp.json();
            if (res?.success) {
                this.state = (res.state || (action === 'off' ? 'off' : 'on')).toLowerCase();
                this.stateUpdatedAt = res.updated_at || null;
                this.lastVia = res.last_via || null;
                const via = res.via === 'BLE' ? '蓝牙' : res.via === 'MQTT' ? 'MQTT' : '接口';
                const msg = `已通过${via}发送${action === 'off' ? '关闭' : '开启'}指令`;
                this.showFeedback(msg);
                showNotification(`✅ ${msg}`);
            } else {
                this.showFeedback(`发送失败：${res?.error || '未知错误'}`);
            }
        } catch (e) {
            this.showFeedback('发送失败，请检查连接');
        } finally {
            targetBtn.textContent = originalText;
            targetBtn.dataset.loading = '0';
            targetBtn.disabled = false;
            await this.refresh();
        }
    },
    showFeedback(message, isReset = false) {
        if (!this.feedback) return;
        if (isReset || !message) {
            this.feedback.textContent = '';
            this.feedback.style.maxHeight = '0';
            this.feedback.style.opacity = '0';
            this.feedback.style.marginTop = '0';
            return;
        }
        this.feedback.textContent = message;
        const words = message.trim().split(/\s+/);
        const strength = Math.min(words.length * 4, 28);
        this.feedback.style.maxHeight = `${32 + strength}px`;
        this.feedback.style.opacity = '1';
        this.feedback.style.marginTop = '6px';
    }
};

// ============ OLED Control ============
const OLEDControl = JSON.parse(JSON.stringify(BLEControl));
OLEDControl.overlay = null;
OLEDControl.deviceId = null;
Object.assign(OLEDControl, {
    setDeviceId(deviceId) {
        const normalizedId = deviceId ? deviceId.toString().trim().toUpperCase() : null;
        this.deviceId = normalizedId;
        if (this.overlay && this.deviceId) {
            const titleEl = document.getElementById('modalTitleOLED');
            if (titleEl) {
                // 只更新文本部分，不包含emoji（emoji已经在模板中）
                titleEl.textContent = `${this.deviceId} OLED显示屏控制`;
            }
        }
    },
    getDeviceId() {
        if (this.deviceId) return this.deviceId;
        if (window.getSelectedDeviceId) {
            const id = window.getSelectedDeviceId();
            if (id) {
                this.deviceId = id.toString().trim().toUpperCase();
                return this.deviceId;
            }
        }
        this.deviceId = 'D01';
        return this.deviceId;
    },
    init() {
        if (!document.getElementById('overlayOLED')) {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = `
            <div id="overlayOLED" class="overlay" aria-hidden="true">
                <div class="modal mq2-modal" role="dialog" aria-modal="true" aria-labelledby="modalTitleOLED">
                    <div class="modal-head mq2-modal-head">
                        <div class="mq2-title-with-info">
                            <div class="mq2-title-text">
                                <span class="mq2-title-icon">📺</span>
                                <span id="modalTitleOLED">OLED显示屏控制</span>
                            </div>
                        </div>
                        <div class="modal-actions">
                            <button id="closeOverlayOLED" class="close-btn" title="关闭">✕</button>
                        </div>
                    </div>
                    <div class="modal-body">
                        <div class="mq2-body">
                            <div class="mq2-section mq2-meta">
                                <div>设备：<strong>OLED 显示屏</strong></div>
                                <div id="oledStateLine">当前状态：读取中...</div>
                                <div id="oledUpdatedLine" class="mq2-subtle">最近操作：--</div>
                                <div id="oledViaLine" class="mq2-subtle"></div>
                            </div>
                            <div class="mq2-section mq2-actions-card">
                                <div class="mq2-section-head">远程指令</div>
                                <div class="mq2-actions">
                                    <button id="btnOledOn" class="btn" type="button">开启显示屏</button>
                                    <button id="btnOledOff" class="btn" type="button">关闭显示屏</button>
                                </div>
                                <div id="oledFeedback" class="mq2-feedback"></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>`;
            document.body.appendChild(wrapper.firstElementChild);
        }
        this.overlay = document.getElementById('overlayOLED');
        if (!this.overlay) return;
        this.stateLine = document.getElementById('oledStateLine');
        this.updatedLine = document.getElementById('oledUpdatedLine');
        this.viaLine = document.getElementById('oledViaLine');
        this.feedback = document.getElementById('oledFeedback');
        this.btnOn = document.getElementById('btnOledOn');
        this.btnOff = document.getElementById('btnOledOff');
        this.btnOn?.addEventListener('click', async () => {
            const hasAccess = await requireControlPassword('请输入密码以开启显示屏');
            if (!hasAccess) return;
            this.sendSwitch('on');
        });
        this.btnOff?.addEventListener('click', async () => {
            const hasAccess = await requireControlPassword('请输入密码以关闭显示屏');
            if (!hasAccess) return;
            this.sendSwitch('off');
        });
        const closeBtn = document.getElementById('closeOverlayOLED');
        closeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.close();
        });
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                e.stopPropagation();
                this.close();
            }
        });
        // 阻止modal内部的点击事件冒泡到overlay
        const modal = this.overlay.querySelector('.modal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }
        this.updateButtons();
    },
    open() {
        if (!this.overlay) return;
        let targetDeviceId = this.deviceId;
        if (window.PowerControlModal && window.PowerControlModal.currentDeviceId) {
            targetDeviceId = window.PowerControlModal.currentDeviceId;
            this.setDeviceId(targetDeviceId);
        }
        if (!targetDeviceId) {
            const deviceId = this.getDeviceId();
            this.setDeviceId(deviceId);
            targetDeviceId = deviceId;
        }
        if (targetDeviceId) {
            const titleEl = document.getElementById('modalTitleOLED');
            if (titleEl) {
                // 只更新文本部分，不包含emoji（emoji已经在模板中）
                titleEl.textContent = `${targetDeviceId} OLED显示屏控制`;
            }
        }
        this.overlay.classList.add('show');
        this.overlay.setAttribute('aria-hidden', 'false');
        if (this.feedback) {
            this.feedback.textContent = '';
            this.feedback.style.maxHeight = '0';
            this.feedback.style.opacity = '0';
            this.feedback.style.marginTop = '0';
        }
        this.updateButtons();
        this.refresh();
    },
    async refresh() {
        if (!this.overlay) return;
        if (this.stateLine) this.stateLine.textContent = '当前状态：读取中...';
        if (this.updatedLine) this.updatedLine.textContent = '最近操作：--';
        if (this.viaLine) this.viaLine.textContent = '';
        try {
            const deviceId = this.getDeviceId();
            const resp = await fetch(`/api/oled/state?device_id=${encodeURIComponent(deviceId)}`);
            const data = await resp.json();
            if (data?.success) {
                this.state = (data.state || 'unknown').toLowerCase();
                this.stateUpdatedAt = data.updated_at || null;
                this.lastVia = data.last_via || null;
                if (this.stateLine) {
                    this.stateLine.textContent = `当前状态：${this.state === 'on' ? '已开启' : this.state === 'off' ? '已关闭' : '未知'}`;
                }
                if (this.updatedLine && this.stateUpdatedAt) {
                    // updated_at可能是时间戳（秒）或null
                    const timestamp = typeof this.stateUpdatedAt === 'string' ? parseFloat(this.stateUpdatedAt) : this.stateUpdatedAt;
                    if (timestamp && !isNaN(timestamp)) {
                        const date = new Date(timestamp * 1000);
                        this.updatedLine.textContent = `最近操作：${date.toLocaleString('zh-CN')}`;
                    } else {
                        this.updatedLine.textContent = '最近操作：--';
                    }
                }
                if (this.viaLine && this.lastVia) {
                    const source = this.lastVia === 'BLE' ? '蓝牙' : (this.lastVia === 'MQTT' ? 'MQTT' : this.lastVia);
                    this.viaLine.textContent = `指令来源：${source}`;
                }
            }
        } catch (e) {
            console.error('刷新OLED状态失败：', e);
        }
        this.updateButtons();
    },
    async sendSwitch(action) {
        const targetBtn = action === 'on' ? this.btnOn : this.btnOff;
        if (!targetBtn) return;
        const originalText = targetBtn.textContent;
        try {
            targetBtn.disabled = true;
            targetBtn.dataset.loading = '1';
            targetBtn.textContent = '发送中...';
            this.showFeedback('', true);
            const deviceId = this.getDeviceId();
            const resp = await fetch('/api/oled/switch', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({action, device_id: deviceId})
            });
            const res = await resp.json();
            if (res?.success) {
                this.state = (res.state || (action === 'off' ? 'off' : 'on')).toLowerCase();
                this.stateUpdatedAt = res.updated_at || null;
                this.lastVia = res.last_via || null;
                const via = res.via === 'BLE' ? '蓝牙' : res.via === 'MQTT' ? 'MQTT' : '接口';
                const msg = `已通过${via}发送${action === 'off' ? '关闭' : '开启'}指令`;
                this.showFeedback(msg);
                showNotification(`✅ ${msg}`);
            } else {
                this.showFeedback(`发送失败：${res?.error || '未知错误'}`);
            }
        } catch (e) {
            this.showFeedback('发送失败，请检查连接');
        } finally {
            targetBtn.textContent = originalText;
            targetBtn.dataset.loading = '0';
            targetBtn.disabled = false;
            await this.refresh();
        }
    },
    close() {
        if (!this.overlay) return;
        this.overlay.classList.remove('show');
        this.overlay.setAttribute('aria-hidden', 'true');
    },
    updateButtons() {
        const knowsState = this.state === 'on' || this.state === 'off';
        if (this.btnOn && this.btnOn.dataset.loading !== '1') this.btnOn.disabled = false;
        if (this.btnOff && this.btnOff.dataset.loading !== '1') this.btnOff.disabled = false;
        this.btnOn?.classList.toggle('active', this.state === 'on');
        this.btnOff?.classList.toggle('active', this.state === 'off');
        if (!knowsState) {
            this.btnOn?.classList.remove('active');
            this.btnOff?.classList.remove('active');
        }
    },
    showFeedback(message, isReset = false) {
        if (!this.feedback) return;
        if (isReset || !message) {
            this.feedback.textContent = '';
            this.feedback.style.maxHeight = '0';
            this.feedback.style.opacity = '0';
            this.feedback.style.marginTop = '0';
            return;
        }
        this.feedback.textContent = message;
        const words = message.trim().split(/\s+/);
        const strength = Math.min(words.length * 4, 28);
        this.feedback.style.maxHeight = `${32 + strength}px`;
        this.feedback.style.opacity = '1';
        this.feedback.style.marginTop = '6px';
    }
});

// 导出全局函数
window.openOverlayBLE = () => {
    if (window.BLEControl) {
        // 确保已经初始化
        if (!window.BLEControl.overlay) {
            window.BLEControl.init();
        }
        window.BLEControl.open();
    }
};

window.openOverlayOLED = () => {
    if (window.OLEDControl) {
        // 确保已经初始化
        if (!window.OLEDControl.overlay) {
            window.OLEDControl.init();
        }
        window.OLEDControl.open();
    }
};

// 将控制对象暴露到全局
window.BMP180Control = BMP180Control;
window.BH1750Control = BH1750Control;
window.BLEControl = BLEControl;
window.OLEDControl = OLEDControl;

function initSharedControls() {
    const initAllControls = () => {
        ensurePowerControlTemplate();
        PowerControlModal.init();
        MQ2Control.init();
        // 初始化新的控制组件
        if (window.BMP180Control && typeof window.BMP180Control.init === 'function') {
            window.BMP180Control.init();
        }
        if (window.BH1750Control && typeof window.BH1750Control.init === 'function') {
            window.BH1750Control.init();
        }
        if (window.BLEControl && typeof window.BLEControl.init === 'function') {
            window.BLEControl.init();
        }
        if (window.OLEDControl && typeof window.OLEDControl.init === 'function') {
            window.OLEDControl.init();
        }
    };
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAllControls);
    } else {
        initAllControls();
    }
}

initSharedControls();

// 暴露全局对象和函数以便HTML调用
window.PowerControlModal = PowerControlModal;
window.MQ2Control = MQ2Control;
window.openOverlayMQ2 = () => MQ2Control.open();
window.closeOverlayMQ2 = () => MQ2Control.close();
window.openMessageCenter = () => window.MessageCenter.open();
window.closeMessageCenter = () => window.MessageCenter.close();
window.loadWarningMessages = () => window.MessageCenter.loadWarningMessages();
window.closeWarningNotification = () => window.MessageCenter.closeWarningNotification();

// 确保函数已正确暴露（调试用）
console.log('✅ 共享工具库已加载 (common.js)');
console.log('📦 可用功能: 主题系统、通知系统、科普弹窗、工具函数、数据加载系统、图表交互系统、帮助弹窗、功能菜单、时间格式化、消息中心、启动画面系统');
console.log('🔍 时间格式化函数检查:', {
    formatTimeLabel: typeof window.formatTimeLabel,
    makeTimeLabelFormatter: typeof window.makeTimeLabelFormatter,
    timeStampTracker: typeof window.timeStampTracker,
    MessageCenter: typeof window.MessageCenter
});

