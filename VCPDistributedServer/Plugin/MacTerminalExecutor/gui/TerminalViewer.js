// TerminalViewer.js - MacTerminalExecutor

const terminalContainer = document.getElementById('terminal-container');
const commandInput = document.getElementById('command-input');
const sendButton = document.getElementById('send-button');

const fitAddon = new FitAddon.FitAddon();

function getCssVariable(variable) {
    return getComputedStyle(document.body).getPropertyValue(variable).trim();
}

const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {},
    allowTransparency: true,
    // macOS 不需要 windowsMode
    copyOnSelect: false
});

term.loadAddon(fitAddon);
term.open(terminalContainer);

// --- 功能函数 ---

function fitTerminal() {
    try {
        fitAddon.fit();
        if (window.electronAPI) {
            window.electronAPI.send('mac-terminal-resize', { cols: term.cols, rows: term.rows });
        }
    } catch (e) {
        console.error("Failed to fit terminal:", e);
    }
}

function sendCommand() {
    const command = commandInput.value;
    if (command.trim() && window.electronAPI) {
        term.write(command + '\r\n');
        window.electronAPI.send('mac-terminal-command', command);
        commandInput.value = '';
        commandInput.focus();
    }
}

// --- IPC 与事件监听 ---

if (window.electronAPI) {
    window.electronAPI.on('terminal-data', (data) => {
        if (data) {
            term.write(data);
        }
    });

    window.electronAPI.on('terminal-clear', () => {
        term.clear();
    });

    window.electronAPI.on('terminal-theme-init', ({ themeName }) => {
        document.body.classList.toggle('light-theme', themeName === 'light');

        setTimeout(() => {
            term.options.theme = {
                background: 'transparent',
                foreground: getCssVariable('--primary-text'),
                cursor: getCssVariable('--highlight-text'),
                selectionBackground: getCssVariable('--accent-bg'),
                black: getCssVariable('--tertiary-bg'),
                red: getCssVariable('--danger-color'),
                green: getCssVariable('--success-color'),
                yellow: getCssVariable('--quoted-text'),
                blue: getCssVariable('--button-bg'),
                magenta: getCssVariable('--highlight-text'),
                cyan: getCssVariable('--secondary-text'),
                white: getCssVariable('--primary-text'),
                brightBlack: getCssVariable('--secondary-text'),
                brightRed: getCssVariable('--danger-hover-bg'),
                brightGreen: getCssVariable('--success-color'),
                brightYellow: getCssVariable('--quoted-text'),
                brightBlue: getCssVariable('--button-hover-bg'),
                brightMagenta: getCssVariable('--highlight-text'),
                brightCyan: getCssVariable('--secondary-text'),
                brightWhite: getCssVariable('--primary-text')
            };
            term.refresh(0, term.rows - 1);
        }, 100);
    });

    // --- macOS 原生复制逻辑 (Cmd+C) ---
    terminalContainer.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const selection = term.getSelection();
        if (selection) {
            window.electronAPI.send('mac-terminal-copy', selection);
        }
    });

    // macOS: Cmd+C 复制（而非 Ctrl+C）
    term.attachCustomKeyEventHandler((arg) => {
        if (arg.metaKey && arg.code === 'KeyC' && arg.type === 'keydown') {
            const selection = term.getSelection();
            if (selection) {
                window.electronAPI.send('mac-terminal-copy', selection);
                return false;
            }
        }
        return true;
    });

} else {
    console.error('Fatal Error: electronAPI not found.');
    term.writeln('Error: Could not connect to the backend.');
}

// --- 窗口与输入监听 ---
window.addEventListener('DOMContentLoaded', () => {
    fitTerminal();
    if (window.electronAPI) {
        window.electronAPI.send('mac-terminal-gui-ready');
    }
});
window.addEventListener('resize', () => setTimeout(fitTerminal, 0));
sendButton.addEventListener('click', sendCommand);
commandInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendCommand();
    }
});
