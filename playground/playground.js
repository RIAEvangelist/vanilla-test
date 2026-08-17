import { appendAnsiText } from '../assets/ansi-console.js';

const editor = document.querySelector('[data-playground-run]')
    ? document.querySelector('#playground-code')
    : null;
const runButton = document.querySelector('[data-playground-run]');
const resetButton = document.querySelector('[data-playground-reset]');
const output = document.querySelector('[data-playground-console]');
const status = document.querySelector('[data-playground-status]');
const frame = document.querySelector('[data-playground-frame]');

if (!editor || !runButton || !resetButton || !output || !status || !frame) {
    throw new Error('The playground interface is incomplete.');
}

const CHANNEL = 'vanilla-test-playground';
const MAX_OUTPUT_CHARACTERS = 100_000;
const MAX_OUTPUT_LINE_CHARACTERS = 4_000;
const MAX_OUTPUT_LINES = 300;
const RUN_TIMEOUT_MS = 15_000;
const STARTUP_TIMEOUT_MS = 10_000;
const defaultSource = editor.value;
let activeRunId = null;
let characterCount = 0;
let lineCount = 0;
let outputCapped = false;
let pendingRun = null;
let runTimer = null;
let sessionToken = '';
let startupTimer = null;

function token() {
    return globalThis.crypto?.randomUUID?.()
        ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setStatus(message, state) {
    status.textContent = message;
    status.dataset.state = state;
}

function clearOutput(message = '') {
    output.replaceChildren();
    characterCount = 0;
    lineCount = 0;
    outputCapped = false;
    if (!message) return;

    const empty = document.createElement('p');
    empty.className = 'console-empty';
    empty.textContent = message;
    output.append(empty);
}

function appendConsoleLine(level, text, count = true) {
    const line = document.createElement('div');
    line.className = 'console-line';
    line.dataset.level = ['warn', 'error'].includes(level) ? level : 'log';
    const value = document.createElement('span');
    appendAnsiText(value, text);
    line.append(value);
    output.append(line);
    if (count) {
        lineCount += 1;
        characterCount += text.length;
    }
    output.scrollTop = output.scrollHeight;
}

function capOutput(reason) {
    if (outputCapped) return;
    outputCapped = true;
    appendConsoleLine('warn', reason, false);
}

function appendOutput(level, text) {
    const placeholder = output.querySelector('.console-empty');
    placeholder?.remove();
    if (outputCapped) return;

    for (const rawLine of String(text).replaceAll('\r', '').split('\n')) {
        if (lineCount >= MAX_OUTPUT_LINES) {
            capOutput(`Output stopped after ${MAX_OUTPUT_LINES} lines.`);
            return;
        }
        const remainingCharacters = MAX_OUTPUT_CHARACTERS - characterCount;
        if (remainingCharacters <= 0) {
            capOutput(`Output stopped after ${MAX_OUTPUT_CHARACTERS.toLocaleString()} characters.`);
            return;
        }

        let displayed = rawLine;
        if (displayed.length > MAX_OUTPUT_LINE_CHARACTERS) {
            displayed = `${displayed.slice(0, MAX_OUTPUT_LINE_CHARACTERS - 18)}… [line truncated]`;
        }
        if (displayed.length > remainingCharacters) {
            displayed = `${displayed.slice(0, Math.max(0, remainingCharacters - 13))}… [truncated]`
                .slice(0, remainingCharacters);
            appendConsoleLine(level, displayed);
            capOutput(`Output stopped after ${MAX_OUTPUT_CHARACTERS.toLocaleString()} characters.`);
            return;
        }
        appendConsoleLine(level, displayed);
    }
}

async function fetchSource(path) {
    const response = await fetch(new URL(path, import.meta.url), { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`Could not load ${path}: HTTP ${response.status}`);
    }
    return response.text();
}

let sourceBundlePromise = null;

function loadSourceBundle() {
    if (!sourceBundlePromise) {
        sourceBundlePromise = Promise.all([
            fetchSource('../index.js'),
            fetchSource('../node_modules/ansi-colors-es6/index.js'),
            fetchSource('../node_modules/strong-type/index.js')
        ]).then(([vanillaTestSource, ansiSource, strongTypeSource]) => ({
            vanillaTestSource,
            ansiSource,
            strongTypeSource
        })).catch((error) => {
            sourceBundlePromise = null;
            throw error;
        });
    }
    return sourceBundlePromise;
}

function sandboxRuntime(parentOrigin, ownSessionToken) {
    'use strict';

    const channel = 'vanilla-test-playground';
    const ansiPattern = /\u001b\[[0-?]*[ -/]*[@-~]/g;
    const sgrPattern = /^\u001b\[(?:[0-9]+(?:;[0-9]+)*)?m$/;
    const maxOutputCharacters = 100_000;
    const maxOutputLineCharacters = 4_000;
    const maxOutputLines = 300;
    let activeRun = null;
    let initialized = false;
    let relayedCharacters = 0;
    let relayedLines = 0;
    let relayStopped = false;

    function send(type, payload = {}) {
        parent.postMessage({
            channel,
            sessionToken: ownSessionToken,
            type,
            ...payload
        }, parentOrigin);
    }

    function sanitizeAnsi(value) {
        return String(value).replace(
            ansiPattern,
            (sequence) => sgrPattern.test(sequence) ? sequence : ''
        );
    }

    function format(value) {
        if (value instanceof Error) {
            return sanitizeAnsi(value.stack || `${value.name}: ${value.message}`);
        }
        if (typeof value === 'string') return sanitizeAnsi(value);
        if (typeof value === 'bigint') return `${value}n`;
        if (typeof value === 'function' || typeof value === 'symbol') return String(value);
        if (value === undefined) return 'undefined';

        const seen = new WeakSet();
        try {
            const serialized = JSON.stringify(value, (_key, item) => {
                if (typeof item === 'string') return sanitizeAnsi(item);
                if (typeof item === 'bigint') return `${item}n`;
                if (item instanceof Error) {
                    return {
                        name: item.name,
                        message: sanitizeAnsi(item.message),
                        stack: sanitizeAnsi(item.stack || '')
                    };
                }
                if (item && typeof item === 'object') {
                    if (seen.has(item)) return '[Circular]';
                    seen.add(item);
                }
                return item;
            }, 2);
            return serialized === undefined ? String(value) : serialized;
        } catch {
            return sanitizeAnsi(String(value));
        }
    }

    const nativeConsole = Object.freeze({
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console)
    });

    function stopRelay(reason) {
        if (relayStopped) return;
        relayStopped = true;
        send('console', {
            runId: activeRun,
            level: 'warn',
            text: reason
        });
    }

    function relay(level, values) {
        nativeConsole[level](...values);
        if (relayStopped) return;

        const formatted = values.map(format).join(' ').replaceAll('\r', '');
        for (const rawLine of formatted.split('\n')) {
            if (relayedLines >= maxOutputLines) {
                stopRelay(`Output stopped after ${maxOutputLines} lines.`);
                return;
            }
            const remainingCharacters = maxOutputCharacters - relayedCharacters;
            if (remainingCharacters <= 0) {
                stopRelay(`Output stopped after ${maxOutputCharacters} characters.`);
                return;
            }

            let text = rawLine;
            if (text.length > maxOutputLineCharacters) {
                text = `${text.slice(0, maxOutputLineCharacters - 18)}… [line truncated]`;
            }
            if (text.length > remainingCharacters) {
                text = `${text.slice(0, Math.max(0, remainingCharacters - 13))}… [truncated]`
                    .slice(0, remainingCharacters);
            }
            send('console', {
                runId: activeRun,
                level,
                text
            });
            relayedLines += 1;
            relayedCharacters += text.length;
            if (relayedCharacters >= maxOutputCharacters) {
                stopRelay(`Output stopped after ${maxOutputCharacters} characters.`);
                return;
            }
        }
    }

    const relayError = (error) => relay('error', [error]);

    for (const level of Object.keys(nativeConsole)) {
        console[level] = (...values) => relay(level, values);
    }

    addEventListener('error', (event) => {
        if (event.error) relayError(event.error);
    });

    addEventListener('unhandledrejection', (event) => {
        relayError(event.reason instanceof Error ? event.reason : new Error(format(event.reason)));
    });

    async function initialize(sources) {
        if (initialized) return;
        const required = ['vanillaTestSource', 'ansiSource', 'strongTypeSource'];
        if (!sources || required.some((name) => typeof sources[name] !== 'string')) {
            throw new TypeError('Playground module sources are invalid.');
        }

        const ansiUrl = URL.createObjectURL(new Blob([sources.ansiSource], {
            type: 'text/javascript'
        }));
        const strongTypeUrl = URL.createObjectURL(new Blob([sources.strongTypeSource], {
            type: 'text/javascript'
        }));
        const vanillaTestUrl = URL.createObjectURL(new Blob([sources.vanillaTestSource], {
            type: 'text/javascript'
        }));
        const importMap = document.createElement('script');
        importMap.type = 'importmap';
        importMap.textContent = JSON.stringify({
            imports: {
                'ansi-colors-es6': ansiUrl,
                'strong-type': strongTypeUrl,
                'vanilla-test': vanillaTestUrl
            }
        });
        document.head.append(importMap);
        initialized = true;
    }

    async function execute(runId, source) {
        activeRun = runId;
        const sourceUrl = URL.createObjectURL(new Blob([source], {
            type: 'text/javascript'
        }));

        try {
            const moduleNamespace = await import(sourceUrl);
            const exported = moduleNamespace.default ?? moduleNamespace.result;
            const candidate = exported && typeof exported.then === 'function'
                ? await exported
                : exported;
            const result = candidate && typeof candidate === 'object'
                && typeof candidate.ok === 'boolean'
                ? {
                    ok: candidate.ok,
                    total: Number.isSafeInteger(candidate.total) ? candidate.total : null,
                    failureCount: Number.isSafeInteger(candidate.failureCount)
                        ? candidate.failureCount
                        : null
                }
                : null;
            send('complete', {
                runId,
                evaluationOk: true,
                result
            });
        } catch (error) {
            relayError(error);
            send('complete', {
                runId,
                evaluationOk: false,
                result: null
            });
        } finally {
            URL.revokeObjectURL(sourceUrl);
        }
    }

    addEventListener('message', async (event) => {
        if (event.source !== parent || event.origin !== parentOrigin) return;
        const message = event.data;
        if (!message || message.channel !== channel
            || message.sessionToken !== ownSessionToken) return;

        try {
            if (message.type === 'init') {
                await initialize(message.sources);
                send('initialized');
                return;
            }
            if (message.type === 'run' && initialized
                && typeof message.runId === 'string'
                && typeof message.source === 'string') {
                await execute(message.runId, message.source);
            }
        } catch (error) {
            relayError(error);
            send('fatal', { message: format(error) });
        }
    });

    send('ready');
}

function sandboxDocument(tokenValue) {
    const bootstrap = `(${sandboxRuntime.toString()})(${JSON.stringify(location.origin)}, ${JSON.stringify(tokenValue)});`
        .replaceAll('</script', '<\\/script');
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; script-src 'unsafe-inline' blob:; style-src 'none'; worker-src 'none'"><title>Playground runtime</title></head><body><script>${bootstrap}<\/script></body></html>`;
}

function clearTimers() {
    clearTimeout(runTimer);
    clearTimeout(startupTimer);
    runTimer = null;
    startupTimer = null;
}

function stopSandbox() {
    sessionToken = token();
    frame.srcdoc = '<!doctype html><title>Playground runtime reset</title>';
}

function bootSandbox(run = null) {
    clearTimers();
    activeRunId = run?.id ?? null;
    pendingRun = run;
    sessionToken = token();
    frame.srcdoc = sandboxDocument(sessionToken);

    startupTimer = setTimeout(() => {
        setStatus('The isolated runtime did not start. Run again to retry.', 'error');
        appendOutput('error', 'Playground startup timed out after 10 seconds.');
        runButton.disabled = false;
        pendingRun = null;
        stopSandbox();
    }, STARTUP_TIMEOUT_MS);
}

async function initializeSandbox(messageToken) {
    try {
        const sources = await loadSourceBundle();
        if (messageToken !== sessionToken) return;
        frame.contentWindow.postMessage({
            channel: CHANNEL,
            sessionToken,
            type: 'init',
            sources
        }, '*');
    } catch (error) {
        if (messageToken !== sessionToken) return;
        clearTimers();
        setStatus('Package source could not be loaded.', 'error');
        appendOutput('error', error instanceof Error ? error.message : String(error));
        runButton.disabled = false;
        pendingRun = null;
        stopSandbox();
    }
}

function startPendingRun() {
    if (!pendingRun) {
        runButton.disabled = false;
        setStatus('Ready. Edit the module and run it.', 'ready');
        clearOutput('Run the module to see its console output.');
        return;
    }

    const request = pendingRun;
    frame.contentWindow.postMessage({
        channel: CHANNEL,
        sessionToken,
        type: 'run',
        runId: request.id,
        source: request.source
    }, '*');
    setStatus('Running module…', 'running');
    runTimer = setTimeout(() => {
        if (activeRunId !== request.id) return;
        appendOutput('error', 'Run stopped after the 15-second limit.');
        setStatus('Run timed out. The sandbox was reset.', 'error');
        runButton.disabled = false;
        pendingRun = null;
        stopSandbox();
    }, RUN_TIMEOUT_MS);
}

addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow || event.origin !== 'null') return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL
        || message.sessionToken !== sessionToken) return;

    if (message.type === 'ready') {
        initializeSandbox(message.sessionToken);
        return;
    }

    if (message.type === 'initialized') {
        clearTimeout(startupTimer);
        startupTimer = null;
        startPendingRun();
        return;
    }

    if (message.type === 'console' && message.runId === activeRunId) {
        appendOutput(message.level, String(message.text));
        return;
    }

    if (message.type === 'complete' && message.runId === activeRunId) {
        clearTimeout(runTimer);
        runTimer = null;
        runButton.disabled = false;
        pendingRun = null;

        if (!message.evaluationOk) {
            setStatus('Module evaluation failed. Check the console output.', 'error');
        } else if (message.result?.ok === false) {
            setStatus(`Module finished with ${message.result.failureCount ?? 'one or more'} failed test(s).`, 'failed');
        } else if (message.result?.ok === true) {
            setStatus(`Module finished: ${message.result.total ?? 'all'} test(s) passed.`, 'passed');
        } else {
            setStatus('Module finished. Export a test result to show pass/fail status.', 'ready');
        }
        return;
    }

    if (message.type === 'fatal') {
        clearTimers();
        appendOutput('error', message.message || 'The isolated runtime failed.');
        setStatus('The isolated runtime failed. Run again to reset it.', 'error');
        runButton.disabled = false;
        pendingRun = null;
    }
});

runButton.addEventListener('click', () => {
    const source = editor.value;
    if (!source.trim()) {
        clearOutput('Add a JavaScript module before running.');
        setStatus('The editor is empty.', 'error');
        return;
    }

    clearOutput();
    runButton.disabled = true;
    setStatus('Preparing a fresh sandbox…', 'running');
    bootSandbox({ id: token(), source });
});

resetButton.addEventListener('click', () => {
    editor.value = defaultSource;
    runButton.disabled = true;
    setStatus('Resetting the example and sandbox…', 'running');
    clearOutput('Preparing the isolated runtime…');
    bootSandbox();
    editor.focus();
});

editor.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        runButton.click();
    }
});

runButton.disabled = true;
bootSandbox();
