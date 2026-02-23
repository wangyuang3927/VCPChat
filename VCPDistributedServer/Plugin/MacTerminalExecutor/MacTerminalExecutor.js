const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { BrowserWindow, ipcMain, clipboard } = require('electron');
const chokidar = require('chokidar');

// --- GUI Window Management ---
let guiWindow = null;

function ensureGuiWindow() {
    if (guiWindow && !guiWindow.isDestroyed()) {
        guiWindow.focus();
        return;
    }

    guiWindow = new BrowserWindow({
        width: 800,
        height: 600,
        title: 'VCP macOS Terminal',
        frame: false,
        titleBarStyle: 'hiddenInset', // macOS 原生红绿灯按钮
        trafficLightPosition: { x: 12, y: 12 },
        vibrancy: 'under-window', // macOS 毛玻璃效果
        webPreferences: {
            preload: path.join(__dirname, 'gui', 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            spellcheck: false,
            additionalArguments: [`--node-modules-path=${path.join(__dirname, '..', '..', '..', '..', 'node_modules')}`]
        },
        autoHideMenuBar: true,
    });

    guiWindow.loadFile(path.join(__dirname, 'gui', 'TerminalViewer.html'));

    guiWindow.on('closed', () => {
        guiWindow = null;
        if (ptyProcess) {
            try {
                ptyProcess.kill();
                console.log('[MacTerminalExecutor] GUI closed, associated pty process terminated.');
            } catch (e) {
                console.error('[MacTerminalExecutor] Error terminating pty process on GUI close:', e);
            }
        }
    });
}

// --- 主题管理与文件监视 ---
const settingsPath = path.join(__dirname, '..', '..', '..', 'AppData', 'settings.json');
let settingsWatcher = null;
let lastSentTheme = null;

function sendThemeUpdate(targetWebContents, forceSend = false) {
    if (!targetWebContents || targetWebContents.isDestroyed()) {
        return;
    }
    try {
        let currentTheme = 'dark';
        if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
            currentTheme = settings.currentThemeMode || 'dark';
        }

        if (currentTheme !== lastSentTheme || forceSend) {
            targetWebContents.send('terminal-theme-init', { themeName: currentTheme });
            lastSentTheme = currentTheme;
            console.log(`[MacTerminalExecutor] Theme updated to: ${currentTheme}`);
        }
    } catch (error) {
        console.error('[MacTerminalExecutor] Error reading or sending theme settings:', error);
    }
}

function setupThemeWatcher() {
    if (settingsWatcher) {
        settingsWatcher.close();
    }
    settingsWatcher = chokidar.watch(settingsPath, {
        persistent: true,
        ignoreInitial: true
    });

    settingsWatcher.on('change', () => {
        if (guiWindow && !guiWindow.isDestroyed()) {
            sendThemeUpdate(guiWindow.webContents);
        }
    });
}

setupThemeWatcher();

// 监听来自GUI的"就绪"信号
ipcMain.on('mac-terminal-gui-ready', (event) => {
    sendThemeUpdate(event.sender, true);
});

// 监听来自GUI的用户命令
ipcMain.on('mac-terminal-command', (event, command) => {
    if (ptyProcess && command) {
        ptyProcess.write(`${command}\r`);
    }
});

// 监听来自GUI的复制请求
ipcMain.on('mac-terminal-copy', (event, text) => {
    if (text) {
        clipboard.writeText(text);
    }
});

// 监听来自GUI的尺寸调整请求
ipcMain.on('mac-terminal-resize', (event, { cols, rows }) => {
    if (ptyProcess) {
        try {
            ptyProcess.resize(cols, rows);
        } catch (e) {
            console.error('[MacTerminalExecutor] Failed to resize pty:', e);
        }
    }
});

// --- ANSI Escape Code Stripper ---
function stripAnsi(str) {
    return str.replace(
        /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
        ''
    );
}

// --- 模块级状态 ---
let ptyProcess = null;
const childProcesses = new Set();
let guiDataListener = null;
let isExecutingCommand = false;

// --- 配置加载 ---
const defaultConfig = {
    returnMode: 'delta',
    forbiddenCommands: [],
    authRequiredCommands: []
};

try {
    const configPath = path.join(__dirname, 'config.env');
    if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, 'utf-8');

        const returnModeMatch = configContent.match(/^RETURN_MODE\s*=\s*(delta|full)/m);
        if (returnModeMatch) {
            defaultConfig.returnMode = returnModeMatch[1];
        }

        const forbiddenMatch = configContent.match(/^FORBIDDEN_COMMANDS\s*=\s*(.*)/m);
        if (forbiddenMatch && forbiddenMatch[1]) {
            defaultConfig.forbiddenCommands = forbiddenMatch[1].split(',').map(c => c.trim().toLowerCase()).filter(c => c);
        }

        const authRequiredMatch = configContent.match(/^AUTH_REQUIRED_COMMANDS\s*=\s*(.*)/m);
        if (authRequiredMatch && authRequiredMatch[1]) {
            defaultConfig.authRequiredCommands = authRequiredMatch[1].split(',').map(c => c.trim().toLowerCase()).filter(c => c);
        }
    }
} catch (error) {
    console.error('[MacTerminalExecutor] Error reading config.env:', error);
}

/**
 * 智能安全检查函数 - 区分命令关键字和路径内容
 */
function intelligentSecurityCheck(command, forbiddenKeywords, authRequiredKeywords) {
    const result = {
        isForbidden: false,
        needsAuth: false,
        matchedKeyword: null,
        reason: null
    };

    const normalizedCommand = command.trim().toLowerCase();
    if (!normalizedCommand) {
        return result;
    }

    // 定义路径模式 - Unix 路径格式
    const pathPatterns = [
        /\/[^\/\s]*(?:\/[^\/\s]*)*\/?/g,           // Unix路径 /path/to/file
        /~\/[^\/\s]*(?:\/[^\/\s]*)*\/?/g,           // 用户目录路径 ~/path
        /\$[A-Z_]+[^\\/:*?"<>|\s]*/gi,              // 环境变量路径 $HOME/path
        /\${[^}]+}[^\\/:*?"<>|\s]*/gi               // 变量路径 ${VAR}/path
    ];

    // 提取所有可能的路径
    const detectedPaths = [];
    pathPatterns.forEach(pattern => {
        const matches = normalizedCommand.match(pattern);
        if (matches) {
            detectedPaths.push(...matches);
        }
    });

    // 创建不包含路径的命令版本
    let commandWithoutPaths = normalizedCommand;
    detectedPaths.forEach(p => {
        commandWithoutPaths = commandWithoutPaths.replace(p.toLowerCase(), ' __PATH_PLACEHOLDER__ ');
    });
    commandWithoutPaths = commandWithoutPaths.replace(/\s+/g, ' ').trim();

    // 检查禁止的关键字
    for (const keyword of forbiddenKeywords) {
        if (!keyword) continue;
        const keywordLower = keyword.toLowerCase();

        const isInPath = detectedPaths.some(p => p.toLowerCase().includes(keywordLower));
        if (isInPath && !commandWithoutPaths.includes(keywordLower)) {
            console.log(`[MacTerminalExecutor] 安全检查：关键字 "${keyword}" 仅在路径中发现，允许执行`);
            continue;
        }

        if (commandWithoutPaths.includes(keywordLower)) {
            const wordBoundaryPattern = new RegExp(`\\b${keywordLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
            if (wordBoundaryPattern.test(commandWithoutPaths)) {
                result.isForbidden = true;
                result.matchedKeyword = keyword;
                result.reason = `命令包含被禁止的关键字: ${keyword}`;
                return result;
            }
        }
    }

    // 检查需要授权的关键字
    for (const keyword of authRequiredKeywords) {
        if (!keyword) continue;
        const keywordLower = keyword.toLowerCase();

        const isInPath = detectedPaths.some(p => p.toLowerCase().includes(keywordLower));
        if (isInPath && !commandWithoutPaths.includes(keywordLower)) {
            continue;
        }

        if (commandWithoutPaths.includes(keywordLower)) {
            const wordBoundaryPattern = new RegExp(`\\b${keywordLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
            if (wordBoundaryPattern.test(commandWithoutPaths)) {
                result.needsAuth = true;
                result.matchedKeyword = keyword;
                result.reason = `命令包含需要授权的关键字: ${keyword}`;
            }
        }
    }

    return result;
}

/**
 * 创建一个新的伪终端 (pty) 进程 - macOS zsh
 */
function createNewPtySession() {
    if (ptyProcess) {
        childProcesses.delete(ptyProcess);
        ptyProcess.kill();
        if (guiWindow && !guiWindow.isDestroyed()) {
            guiWindow.webContents.send('terminal-clear');
        }
    }

    // macOS 使用 zsh 作为默认 shell
    const shell = process.env.SHELL || '/bin/zsh';

    ptyProcess = pty.spawn(shell, ['--login'], {
        name: 'xterm-256color',
        cwd: process.env.HOME,
        env: {
            ...process.env,
            TERM: 'xterm-256color',
            LANG: 'en_US.UTF-8',
            LC_ALL: 'en_US.UTF-8'
        }
    });
    childProcesses.add(ptyProcess);

    // 创建GUI数据监听器
    guiDataListener = (data) => {
        if (isExecutingCommand) {
            return;
        }
        if (guiWindow && !guiWindow.isDestroyed()) {
            const dataStr = data.toString('utf-8');
            if (dataStr) {
                guiWindow.webContents.send('terminal-data', dataStr);
            }
        }
    };

    ptyProcess.onData(guiDataListener);

    ptyProcess.onExit(() => {
        childProcesses.delete(ptyProcess);
        ptyProcess = null;
        guiDataListener = null;
        isExecutingCommand = false;
    });
}

/**
 * 在给定的 pty 会话中执行单条命令并返回其增量输出。
 * 使用 echo 作为命令边界标记（替代 PowerShell 的 Write-Host）
 */
function executeSingleCommandInPty(ptyProcess, singleCommand) {
    return new Promise((resolve, reject) => {
        if (!ptyProcess) {
            return reject(new Error("PTY process is not available."));
        }

        let commandOutput = '';
        const boundary = `--- VCP_COMMAND_BOUNDARY_${crypto.randomUUID()} ---`;

        const dataListener = (data) => {
            const dataStr = data.toString('utf-8');

            if (dataStr.includes(boundary)) {
                clearTimeout(timeoutId);
                ptyProcess.removeListener('data', dataListener);

                const finalChunk = dataStr.substring(0, dataStr.indexOf(boundary));
                commandOutput += finalChunk;

                if (guiWindow && !guiWindow.isDestroyed() && finalChunk) {
                    guiWindow.webContents.send('terminal-data', finalChunk);
                }

                resolve(stripAnsi(commandOutput.trim()));
            } else {
                commandOutput += dataStr;
                if (guiWindow && !guiWindow.isDestroyed()) {
                    guiWindow.webContents.send('terminal-data', dataStr);
                }
            }
        };

        const timeoutId = setTimeout(() => {
            ptyProcess.removeListener('data', dataListener);
            reject(new Error(`Command "${singleCommand}" timed out after 60 seconds.`));
        }, 60000);

        ptyProcess.on('data', dataListener);
        // macOS: 使用 echo 替代 Write-Host 作为边界标记
        ptyProcess.write(`${singleCommand}\r\necho "${boundary}"\r\n`);
    });
}

/**
 * 插件的主入口点
 */
async function processToolCall(args) {
    // --- 1. 解析和排序命令 ---
    const commandEntries = Object.entries(args)
        .filter(([key]) => key.startsWith('command'))
        .map(([key, value]) => {
            const match = key.match(/^command(\d*)$/);
            const index = match ? (match[1] === '' ? 0 : parseInt(match[1], 10)) : -1;
            return { key, value, index };
        })
        .filter(item => item.index !== -1)
        .sort((a, b) => a.index - b.index);

    if (commandEntries.length === 0) {
        throw new Error('未提供任何有效的 command 参数 (例如 command, command1, command2)。');
    }

    // --- 2. 智能安全预检查 ---
    for (const entry of commandEntries) {
        const securityResult = intelligentSecurityCheck(
            entry.value,
            defaultConfig.forbiddenCommands,
            defaultConfig.authRequiredCommands
        );

        if (securityResult.isForbidden) {
            throw new Error(`执行被阻止：${securityResult.reason}`);
        }

        if (securityResult.needsAuth) {
            // macOS: 需要授权的命令通过环境变量中的验证码校验
            const authCode = process.env.DECRYPTED_AUTH_CODE;
            const providedAuth = args.requireAdmin;
            if (!providedAuth || providedAuth !== authCode) {
                throw new Error(`命令 "${entry.value}" 需要管理员授权。请提供正确的 requireAdmin 验证码。原因：${securityResult.reason}`);
            }
            console.log(`[MacTerminalExecutor] 命令 "${entry.value}" 已通过管理员授权验证。`);
        }
    }

    // --- 3. 初始化会话和参数 ---
    const lastCommandIndex = commandEntries[commandEntries.length - 1].index;
    const getArg = (key, defaultVal) => {
        const indexedKey = `${key}${lastCommandIndex || ''}`;
        return args[indexedKey] !== undefined ? args[indexedKey] : (args[key] !== undefined ? args[key] : defaultVal);
    };

    const newSession = getArg('newSession', false);
    const finalReturnMode = getArg('returnMode', defaultConfig.returnMode);

    // --- 4. 标准会话执行 ---
    ensureGuiWindow();

    if (newSession || !ptyProcess) {
        createNewPtySession();
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    const deltaOutputs = [];
    isExecutingCommand = true;
    try {
        for (const entry of commandEntries) {
            const command = entry.value;
            const currentReturnModeKey = `returnMode${entry.index || ''}`;
            const currentReturnMode = args[currentReturnModeKey] || finalReturnMode;

            try {
                const output = await executeSingleCommandInPty(ptyProcess, command);
                deltaOutputs.push({ command, output, returnMode: currentReturnMode });
            } catch (error) {
                throw new Error(`在执行命令 "${command}" 时出错: ${error.message}`);
            }
        }
    } finally {
        isExecutingCommand = false;
    }

    // --- 5. 格式化并返回结果 ---
    if (finalReturnMode === 'full') {
        return deltaOutputs.length > 0 ? deltaOutputs[deltaOutputs.length - 1].output : '';
    } else {
        if (deltaOutputs.length === 1) {
            return deltaOutputs[0].output;
        }
        return deltaOutputs.map(res =>
            `---[Output for: ${res.command}]---\n${res.output}`
        ).join('\n\n');
    }
}

/**
 * 清理插件资源
 */
function cleanup() {
    console.log('[MacTerminalExecutor] 正在清理资源...');

    if (guiWindow && !guiWindow.isDestroyed()) {
        try {
            guiWindow.removeAllListeners('closed');
            guiWindow.close();
            console.log('[MacTerminalExecutor] GUI 窗口已关闭。');
        } catch (e) {
            console.error('[MacTerminalExecutor] 关闭 GUI 窗口时出错:', e);
        }
        guiWindow = null;
    }

    if (childProcesses.size > 0) {
        console.log(`[MacTerminalExecutor] 正在终止 ${childProcesses.size} 个子进程...`);
        for (const processToKill of childProcesses) {
            try {
                processToKill.kill();
                console.log(`[MacTerminalExecutor] 进程 (PID: ${processToKill.pid}) 已终止。`);
            } catch (e) {
                console.error(`[MacTerminalExecutor] 终止进程 (PID: ${processToKill.pid}) 时出错:`, e);
            }
        }
        childProcesses.clear();
    }

    if (settingsWatcher) {
        try {
            settingsWatcher.close();
            settingsWatcher = null;
            console.log('[MacTerminalExecutor] Settings file watcher stopped.');
        } catch (e) {
            console.error('[MacTerminalExecutor] Error stopping settings watcher:', e);
        }
    }

    ptyProcess = null;
}

module.exports = {
    processToolCall,
    cleanup
};
