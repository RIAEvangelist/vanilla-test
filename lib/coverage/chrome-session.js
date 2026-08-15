/**
 * Dependency-free Chrome DevTools Protocol transport for Node.js >= 22.12.
 *
 * Public API:
 *   - discoverChromeExecutable(explicitPath?) -> absolute Chrome Stable path
 *   - launchChrome(options?) -> ChromeSession
 *   - ChromeSession#createPage(options?) -> PageSession (flat CDP session)
 *   - ChromeSession#send / #waitForEvent / #on / #close
 *   - PageSession#send / #waitForEvent / #on / #goto / #evaluate /
 *     #waitForFunction / #screenshot / #setViewport / #close
 *   - ChromeProtocolError and ChromeTimeoutError for precise error handling
 *
 * `on(method, listener)` passes `(params, event)` to the listener and returns an
 * unsubscribe function. `addEventListener` is an alias with the same contract.
 */

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
    access,
    mkdtemp,
    realpath,
    rm,
    stat,
    writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 2_000;
const MAX_PROTOCOL_BUFFER_BYTES = 256 * 1024 * 1024;

export function chromeNoSandboxFromEnvironment(environment = process.env) {
    const value = environment.VANILLA_TEST_CHROME_NO_SANDBOX;
    if (value === undefined || value === '' || value === '0') return false;
    if (value === '1') return true;
    throw new TypeError('VANILLA_TEST_CHROME_NO_SANDBOX must be 0, 1, empty, or unset.');
}

export function buildChromeLaunchArguments({
    userDataDirectory,
    width,
    height,
    headless,
    noSandbox,
    args = []
}) {
    return [
        '--remote-debugging-pipe',
        `--user-data-dir=${userDataDirectory}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-sync',
        '--metrics-recording-only',
        '--force-color-profile=srgb',
        `--window-size=${width},${height}`,
        ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
        ...(process.platform === 'linux' ? ['--password-store=basic'] : []),
        ...(noSandbox ? ['--no-sandbox'] : []),
        ...(headless ? ['--headless=new'] : []),
        ...args,
        'about:blank'
    ];
}

function abortError(signal, message = 'Chrome operation aborted.') {
    const error = new Error(message, signal?.reason === undefined ? undefined : { cause: signal.reason });
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

function connectionClosedError(message = 'Chrome DevTools connection closed.') {
    const error = new Error(message);
    error.code = 'ERR_CHROME_CONNECTION_CLOSED';
    return error;
}

function assertSignal(signal) {
    if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function')) {
        throw new TypeError('signal must be an AbortSignal.');
    }
}

function positiveInteger(value, label, maximum = 3_600_000) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new RangeError(`${label} must be an integer from 1 through ${maximum}.`);
    }
    return value;
}

function finitePositive(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new RangeError(`${label} must be a positive finite number.`);
    }
    return value;
}

function assertMethod(method) {
    if (typeof method !== 'string' || method.trim() === '') {
        throw new TypeError('CDP method must be a nonempty string.');
    }
}

function assertParams(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
        throw new TypeError('CDP params must be an object.');
    }
}

function combinedSignal(...signals) {
    const values = signals.filter(Boolean);
    if (values.length === 0) return undefined;
    if (values.length === 1) return values[0];
    return AbortSignal.any(values);
}

function timeoutFor(value, fallback) {
    return positiveInteger(value ?? fallback, 'timeoutMs');
}

/** Error raised when a CDP request or event wait exceeds its deadline. */
export class ChromeTimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ChromeTimeoutError';
        this.code = 'ERR_CHROME_TIMEOUT';
    }
}

/** Error returned by Chrome for a CDP request, including its protocol metadata. */
export class ChromeProtocolError extends Error {
    constructor(method, details, sessionId) {
        super(`Chrome DevTools ${method} failed: ${details?.message || 'unknown protocol error'}`);
        this.name = 'ChromeProtocolError';
        this.code = details?.code;
        this.data = details?.data;
        this.method = method;
        this.sessionId = sessionId;
    }
}

async function usableExecutable(candidate) {
    try {
        const details = await stat(candidate);
        if (!details.isFile()) return null;
        await access(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
        return await realpath(candidate);
    } catch {
        return null;
    }
}

function pathCandidates(names, environment) {
    const directories = (environment.PATH || environment.Path || environment.path || '')
        .split(path.delimiter)
        .filter(Boolean);
    return directories.flatMap((directory) => names.map((name) => path.join(directory, name)));
}

function chromeCandidates(environment = process.env) {
    const home = os.homedir();
    const candidates = environment.CHROME_PATH ? [environment.CHROME_PATH] : [];

    if (process.platform === 'win32') {
        for (const root of [environment.LOCALAPPDATA, environment.PROGRAMFILES, environment['PROGRAMFILES(X86)']]) {
            if (root) candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
        }
        candidates.push(...pathCandidates(['chrome.exe'], environment));
    } else if (process.platform === 'darwin') {
        candidates.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')
        );
        candidates.push(...pathCandidates(['google-chrome-stable', 'google-chrome'], environment));
    } else {
        candidates.push(
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/opt/google/chrome/google-chrome'
        );
        candidates.push(...pathCandidates(['google-chrome-stable', 'google-chrome'], environment));
    }

    const seen = new Set();
    return candidates.filter((candidate) => {
        const absolute = path.resolve(candidate);
        const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Resolve an explicit Chrome executable or discover Google Chrome Stable.
 * Passing null (the default) selects discovery. CHROME_PATH is checked first,
 * followed by the platform's standard Stable installation locations and PATH.
 */
export async function discoverChromeExecutable(explicitPath = null) {
    if (explicitPath !== null && explicitPath !== undefined) {
        if (typeof explicitPath !== 'string' || explicitPath.trim() === '') {
            throw new TypeError('executablePath must be a nonempty string or null.');
        }
        const candidate = path.resolve(explicitPath);
        const executable = await usableExecutable(candidate);
        if (!executable) {
            throw new Error(`Chrome executable is missing, is not a file, or is not executable: ${candidate}`);
        }
        return executable;
    }

    const candidates = chromeCandidates();
    for (const candidate of candidates) {
        const executable = await usableExecutable(candidate);
        if (executable) return executable;
    }

    throw new Error(
        'Google Chrome Stable was not found. Install Chrome, set CHROME_PATH, '
        + 'or provide executablePath.\nSearched:\n'
        + candidates.map((candidate) => `  - ${path.resolve(candidate)}`).join('\n')
    );
}

class PipeConnection {
    constructor(child, defaultTimeoutMs) {
        this.child = child;
        this.defaultTimeoutMs = defaultTimeoutMs;
        this.reader = child.stdio[4];
        this.writer = child.stdio[3];
        this.nextRequestId = 1;
        this.nextWaiterId = 1;
        this.pending = new Map();
        this.waiters = new Map();
        this.listeners = new Set();
        this.frameChunks = [];
        this.frameBytes = 0;
        this.closedError = null;

        if (!this.reader || !this.writer) {
            throw new Error('Chrome remote-debugging pipe descriptors were not created.');
        }

        this.reader.on('data', (chunk) => this.#receive(chunk));
        this.reader.once('error', (error) => this.fail(error));
        this.reader.once('end', () => this.fail(connectionClosedError()));
        this.writer.once('error', (error) => this.fail(error));
    }

    send(method, params = {}, options = {}) {
        assertMethod(method);
        assertParams(params);
        const { sessionId, signal } = options;
        assertSignal(signal);
        const timeoutMs = timeoutFor(options.timeoutMs, this.defaultTimeoutMs);

        if (typeof sessionId !== 'undefined' && (typeof sessionId !== 'string' || sessionId === '')) {
            throw new TypeError('sessionId must be a nonempty string when provided.');
        }
        if (signal?.aborted) return Promise.reject(abortError(signal));
        if (this.closedError) return Promise.reject(this.closedError);

        const id = this.nextRequestId++;
        const message = { id, method, params };
        if (sessionId !== undefined) message.sessionId = sessionId;

        return new Promise((resolve, reject) => {
            const finish = (error, result) => {
                const pending = this.pending.get(id);
                if (!pending) return;
                this.pending.delete(id);
                clearTimeout(pending.timer);
                signal?.removeEventListener('abort', pending.onAbort);
                if (error) reject(error);
                else resolve(result);
            };
            const onAbort = () => finish(abortError(signal));
            const timer = setTimeout(
                () => finish(new ChromeTimeoutError(`Timed out after ${timeoutMs} ms waiting for ${method}.`)),
                timeoutMs
            );
            timer.unref?.();
            this.pending.set(id, { finish, method, sessionId, timer, onAbort });
            signal?.addEventListener('abort', onAbort, { once: true });

            let serialized;
            try {
                serialized = `${JSON.stringify(message)}\0`;
            } catch (error) {
                finish(error);
                return;
            }

            this.writer.write(serialized, 'utf8', (error) => {
                if (error) finish(error);
            });
        });
    }

    on(method, listener, options = {}) {
        assertMethod(method);
        if (typeof listener !== 'function') throw new TypeError('listener must be a function.');
        const { sessionId } = options;
        if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId === '')) {
            throw new TypeError('sessionId must be a nonempty string when provided.');
        }
        const subscription = { method, listener, sessionId };
        this.listeners.add(subscription);
        return () => this.listeners.delete(subscription);
    }

    waitForEvent(method, options = {}) {
        assertMethod(method);
        const { predicate, sessionId, signal } = options;
        if (predicate !== undefined && typeof predicate !== 'function') {
            throw new TypeError('predicate must be a function.');
        }
        if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId === '')) {
            throw new TypeError('sessionId must be a nonempty string when provided.');
        }
        assertSignal(signal);
        const timeoutMs = timeoutFor(options.timeoutMs, this.defaultTimeoutMs);
        if (signal?.aborted) return Promise.reject(abortError(signal));
        if (this.closedError) return Promise.reject(this.closedError);

        return new Promise((resolve, reject) => {
            const id = this.nextWaiterId++;
            const finish = (error, value) => {
                const waiter = this.waiters.get(id);
                if (!waiter) return;
                this.waiters.delete(id);
                clearTimeout(waiter.timer);
                signal?.removeEventListener('abort', waiter.onAbort);
                if (error) reject(error);
                else resolve(value);
            };
            const onAbort = () => finish(abortError(signal));
            const timer = setTimeout(
                () => finish(new ChromeTimeoutError(`Timed out after ${timeoutMs} ms waiting for ${method}.`)),
                timeoutMs
            );
            timer.unref?.();
            this.waiters.set(id, { finish, method, predicate, sessionId, timer, onAbort });
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    rejectSession(sessionId, error = connectionClosedError('Chrome page session closed.')) {
        for (const waiter of this.waiters.values()) {
            if (waiter.sessionId === sessionId) waiter.finish(error);
        }
        for (const [id, pending] of this.pending) {
            if (pending.sessionId === sessionId) pending.finish(error);
        }
    }

    fail(error) {
        if (this.closedError) return;
        this.closedError = error instanceof Error ? error : connectionClosedError(String(error));
        for (const pending of [...this.pending.values()]) pending.finish(this.closedError);
        for (const waiter of [...this.waiters.values()]) waiter.finish(this.closedError);
        this.listeners.clear();
        this.frameChunks = [];
        this.frameBytes = 0;
    }

    #receive(chunk) {
        if (this.closedError) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let start = 0;

        while (start < bytes.length) {
            const delimiter = bytes.indexOf(0, start);
            if (delimiter === -1) {
                this.#appendFrameChunk(bytes.subarray(start));
                return;
            }
            if (!this.#appendFrameChunk(bytes.subarray(start, delimiter))) return;

            const frame = this.#takeFrame();
            start = delimiter + 1;
            if (frame.length === 0) continue;

            let message;
            try {
                message = JSON.parse(frame.toString('utf8'));
            } catch (error) {
                this.fail(new Error('Chrome sent malformed JSON over the DevTools pipe.', { cause: error }));
                return;
            }
            this.#dispatch(message);
        }
    }

    #appendFrameChunk(chunk) {
        if (chunk.length === 0) return true;
        const nextFrameBytes = this.frameBytes + chunk.length;
        if (nextFrameBytes > MAX_PROTOCOL_BUFFER_BYTES) {
            this.fail(new Error('Chrome DevTools message exceeded the 256 MiB transport limit.'));
            return false;
        }
        this.frameChunks.push(chunk);
        this.frameBytes = nextFrameBytes;
        return true;
    }

    #takeFrame() {
        const frame = this.frameChunks.length === 0
            ? Buffer.alloc(0)
            : this.frameChunks.length === 1
                ? this.frameChunks[0]
                : Buffer.concat(this.frameChunks, this.frameBytes);
        this.frameChunks = [];
        this.frameBytes = 0;
        return frame;
    }

    #dispatch(message) {
        if (Number.isSafeInteger(message?.id)) {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            if (message.error) {
                pending.finish(new ChromeProtocolError(pending.method, message.error, pending.sessionId));
            } else {
                pending.finish(null, message.result ?? {});
            }
            return;
        }
        if (typeof message?.method !== 'string') return;

        const event = {
            method: message.method,
            params: message.params ?? {},
            sessionId: message.sessionId
        };
        for (const waiter of [...this.waiters.values()]) {
            if (waiter.method !== event.method || waiter.sessionId !== event.sessionId) continue;
            try {
                if (!waiter.predicate || waiter.predicate(event.params, event)) {
                    waiter.finish(null, event.params);
                }
            } catch (error) {
                waiter.finish(error);
            }
        }
        for (const subscription of [...this.listeners]) {
            if (subscription.method !== event.method || subscription.sessionId !== event.sessionId) continue;
            try {
                subscription.listener(event.params, event);
            } catch (error) {
                process.emitWarning(error, { code: 'VANILLA_TEST_CDP_EVENT_LISTENER' });
            }
        }
    }
}

function formatRemoteException(details) {
    const exception = details?.exception;
    const message = exception?.description || exception?.value || details?.text || 'Chrome evaluation failed.';
    const error = new Error(String(message));
    error.name = exception?.className || 'ChromeEvaluationError';
    error.details = details;
    return error;
}

/** A single page target attached through a flattened CDP session. */
export class PageSession {
    constructor(browser, targetId, sessionId) {
        this.browser = browser;
        this.targetId = targetId;
        this.sessionId = sessionId;
        this.closed = false;
        this.subscriptions = new Set();
    }

    #assertOpen() {
        if (this.closed || this.browser.closed) {
            throw connectionClosedError('Chrome page session is closed.');
        }
    }

    send(method, params = {}, options = {}) {
        this.#assertOpen();
        return this.browser.connection.send(method, params, { ...options, sessionId: this.sessionId });
    }

    waitForEvent(method, options = {}) {
        this.#assertOpen();
        return this.browser.connection.waitForEvent(method, { ...options, sessionId: this.sessionId });
    }

    on(method, listener) {
        this.#assertOpen();
        const removeFromConnection = this.browser.connection.on(method, listener, { sessionId: this.sessionId });
        let active = true;
        const unsubscribe = () => {
            if (!active) return false;
            active = false;
            this.subscriptions.delete(unsubscribe);
            return removeFromConnection();
        };
        this.subscriptions.add(unsubscribe);
        return unsubscribe;
    }

    addEventListener(method, listener) {
        return this.on(method, listener);
    }

    async setViewport(viewport, options = {}) {
        this.#assertOpen();
        if (!viewport || typeof viewport !== 'object' || Array.isArray(viewport)) {
            throw new TypeError('viewport must be an object.');
        }
        const width = positiveInteger(viewport.width, 'viewport.width', 100_000);
        const height = positiveInteger(viewport.height, 'viewport.height', 100_000);
        const deviceScaleFactor = finitePositive(viewport.deviceScaleFactor ?? 1, 'viewport.deviceScaleFactor');
        if (viewport.mobile !== undefined && typeof viewport.mobile !== 'boolean') {
            throw new TypeError('viewport.mobile must be a boolean.');
        }
        await this.send('Emulation.setDeviceMetricsOverride', {
            width,
            height,
            deviceScaleFactor,
            mobile: viewport.mobile ?? false,
            screenWidth: width,
            screenHeight: height
        }, options);
    }

    async setColorScheme(colorScheme, options = {}) {
        if (!['light', 'dark', 'no-preference'].includes(colorScheme)) {
            throw new RangeError('colorScheme must be light, dark, or no-preference.');
        }
        await this.send('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-color-scheme', value: colorScheme }]
        }, options);
    }

    async goto(url, options = {}) {
        this.#assertOpen();
        let parsed;
        try {
            parsed = new URL(url);
        } catch (error) {
            throw new TypeError(`url must be an absolute URL: ${url}`, { cause: error });
        }
        const waitUntil = options.waitUntil ?? 'load';
        const eventMethod = waitUntil === 'load'
            ? 'Page.loadEventFired'
            : waitUntil === 'domcontentloaded'
                ? 'Page.domContentEventFired'
                : null;
        if (waitUntil !== 'none' && !eventMethod) {
            throw new RangeError('waitUntil must be load, domcontentloaded, or none.');
        }
        const timeoutMs = timeoutFor(options.timeoutMs, this.browser.defaultTimeoutMs);
        const cancellation = new AbortController();
        const signal = combinedSignal(options.signal, cancellation.signal);
        const eventPromise = eventMethod
            ? this.waitForEvent(eventMethod, { timeoutMs, signal })
            : null;

        try {
            const result = await this.send('Page.navigate', { url: parsed.href }, { timeoutMs, signal });
            if (result.errorText) throw new Error(`Chrome could not navigate to ${parsed.href}: ${result.errorText}`);
            if (eventPromise) await eventPromise;
            return result;
        } catch (error) {
            cancellation.abort(error);
            await eventPromise?.catch(() => {});
            throw error;
        } finally {
            cancellation.abort();
        }
    }

    async evaluate(expression, options = {}) {
        this.#assertOpen();
        if (typeof expression !== 'string' || expression.trim() === '') {
            throw new TypeError('expression must be a nonempty string.');
        }
        const returnByValue = options.returnByValue ?? true;
        const response = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise: options.awaitPromise ?? true,
            returnByValue,
            userGesture: options.userGesture ?? true
        }, options);
        if (response.exceptionDetails) throw formatRemoteException(response.exceptionDetails);
        return returnByValue ? response.result?.value : response.result;
    }

    async waitForFunction(predicate, options = {}) {
        this.#assertOpen();
        if ((typeof predicate !== 'string' && typeof predicate !== 'function')
            || (typeof predicate === 'string' && predicate.trim() === '')) {
            throw new TypeError('predicate must be a function or a nonempty JavaScript expression.');
        }
        const expression = typeof predicate === 'function'
            ? `(${predicate.toString()})()`
            : `(${predicate})`;
        const timeoutMs = timeoutFor(options.timeoutMs, this.browser.defaultTimeoutMs);
        const pollingMs = positiveInteger(options.pollingMs ?? 50, 'pollingMs');
        const signal = options.signal;
        assertSignal(signal);
        const deadline = performance.now() + timeoutMs;

        while (true) {
            if (signal?.aborted) throw abortError(signal);
            const remaining = Math.ceil(deadline - performance.now());
            if (remaining <= 0) {
                throw new ChromeTimeoutError(`Timed out after ${timeoutMs} ms waiting for a page function.`);
            }
            if (await this.evaluate(`Promise.resolve(${expression}).then(Boolean)`, {
                timeoutMs: Math.max(1, remaining),
                signal
            })) return;
            await delay(Math.min(pollingMs, Math.max(1, remaining)), undefined, { signal }).catch((error) => {
                if (signal?.aborted) throw abortError(signal);
                throw error;
            });
        }
    }

    async screenshot(options = {}) {
        this.#assertOpen();
        if (options.path !== undefined && (typeof options.path !== 'string' || options.path.trim() === '')) {
            throw new TypeError('screenshot path must be a nonempty string.');
        }
        const format = options.format ?? (options.path?.toLowerCase().endsWith('.jpeg')
            || options.path?.toLowerCase().endsWith('.jpg') ? 'jpeg' : 'png');
        if (!['png', 'jpeg', 'webp'].includes(format)) {
            throw new RangeError('screenshot format must be png, jpeg, or webp.');
        }
        if (options.quality !== undefined
            && (!Number.isSafeInteger(options.quality) || options.quality < 0 || options.quality > 100)) {
            throw new RangeError('screenshot quality must be an integer from 0 through 100.');
        }
        const params = {
            format,
            fromSurface: options.fromSurface ?? true,
            captureBeyondViewport: options.captureBeyondViewport ?? true
        };
        if (options.quality !== undefined) params.quality = options.quality;
        if (options.fullPage) {
            const metrics = await this.send('Page.getLayoutMetrics', {}, options);
            const size = metrics.cssContentSize || metrics.contentSize;
            if (!size) throw new Error('Chrome did not return the page content size.');
            params.clip = {
                x: size.x,
                y: size.y,
                width: Math.max(1, size.width),
                height: Math.max(1, size.height),
                scale: 1
            };
        }
        const { data } = await this.send('Page.captureScreenshot', params, options);
        if (typeof data !== 'string') throw new Error('Chrome returned no screenshot data.');
        const image = Buffer.from(data, 'base64');
        if (options.path !== undefined) {
            await writeFile(options.path, image);
        }
        return image;
    }

    async close(options = {}) {
        if (this.closed) return;
        try {
            await this.browser.send('Target.closeTarget', { targetId: this.targetId }, options);
        } finally {
            this.#markClosed();
        }
    }

    #markClosed() {
        if (this.closed) return;
        this.closed = true;
        for (const unsubscribe of [...this.subscriptions]) unsubscribe();
        this.browser.connection.rejectSession(this.sessionId);
        this.browser.pages.delete(this.sessionId);
    }

    _markClosed() {
        this.#markClosed();
    }
}

function waitForChildExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
        let timer;
        const onExit = () => finish(true);
        const finish = (exited) => {
            clearTimeout(timer);
            child.removeListener('exit', onExit);
            resolve(exited);
        };
        timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref?.();
        child.once('exit', onExit);
    });
}

/** A launched Chrome process and its root browser-level CDP session. */
export class ChromeSession {
    constructor(child, connection, executablePath, userDataDirectory, defaultTimeoutMs, signal) {
        this.child = child;
        this.connection = connection;
        this.executablePath = executablePath;
        this.userDataDirectory = userDataDirectory;
        this.defaultTimeoutMs = defaultTimeoutMs;
        this.pages = new Map();
        this.version = null;
        this.closed = false;
        this.closePromise = null;
        this.cleanupPromise = null;
        this.signal = signal;
        this.stderr = '';

        this.removeDetachedListener = connection.on('Target.detachedFromTarget', ({ sessionId }) => {
            this.pages.get(sessionId)?._markClosed();
        });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk) => {
            this.stderr = `${this.stderr}${chunk}`.slice(-65_536);
        });
        child.on('error', (error) => connection.fail(error));
        child.once('exit', (code, exitSignal) => {
            this.closed = true;
            signal?.removeEventListener('abort', this.onAbort);
            this.removeDetachedListener?.();
            const suffix = exitSignal ? `signal ${exitSignal}` : `code ${code}`;
            connection.fail(connectionClosedError(`Chrome exited with ${suffix}.`));
            for (const page of [...this.pages.values()]) page._markClosed();
            void this.#cleanup().catch(() => {});
        });
        this.onAbort = () => {
            connection.fail(abortError(signal));
            void this.close({ force: true });
        };
        signal?.addEventListener('abort', this.onAbort, { once: true });
    }

    get pid() {
        return this.child.pid;
    }

    send(method, params = {}, options = {}) {
        if (this.closed) return Promise.reject(connectionClosedError('Chrome session is closed.'));
        return this.connection.send(method, params, options);
    }

    waitForEvent(method, options = {}) {
        if (this.closed) return Promise.reject(connectionClosedError('Chrome session is closed.'));
        return this.connection.waitForEvent(method, options);
    }

    on(method, listener) {
        if (this.closed) throw connectionClosedError('Chrome session is closed.');
        return this.connection.on(method, listener);
    }

    addEventListener(method, listener) {
        return this.on(method, listener);
    }

    async createPage(options = {}) {
        if (this.closed) throw connectionClosedError('Chrome session is closed.');
        const timeoutMs = timeoutFor(options.timeoutMs, this.defaultTimeoutMs);
        const signal = options.signal;
        assertSignal(signal);
        const requestedUrl = options.url ?? 'about:blank';
        let parsedUrl;
        try {
            parsedUrl = new URL(requestedUrl).href;
        } catch (error) {
            throw new TypeError(`url must be an absolute URL: ${requestedUrl}`, { cause: error });
        }

        const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' }, { timeoutMs, signal });
        let page;
        try {
            const attached = await this.send('Target.attachToTarget', { targetId, flatten: true }, { timeoutMs, signal });
            page = new PageSession(this, targetId, attached.sessionId);
            this.pages.set(attached.sessionId, page);
            await Promise.all([
                page.send('Page.enable', {}, { timeoutMs, signal }),
                page.send('Runtime.enable', {}, { timeoutMs, signal })
            ]);
            if (options.viewport) await page.setViewport(options.viewport, { timeoutMs, signal });
            if (options.colorScheme) await page.setColorScheme(options.colorScheme, { timeoutMs, signal });
            if (parsedUrl !== 'about:blank') {
                await page.goto(parsedUrl, {
                    waitUntil: options.waitUntil ?? 'load',
                    timeoutMs,
                    signal
                });
            }
            return page;
        } catch (error) {
            page?._markClosed();
            await this.send('Target.closeTarget', { targetId }, { timeoutMs, signal: undefined }).catch(() => {});
            throw error;
        }
    }

    close(options = {}) {
        if (this.closePromise) return this.closePromise;
        this.closePromise = this.#close(options);
        return this.closePromise;
    }

    async #close({ force = false } = {}) {
        this.closed = true;
        this.signal?.removeEventListener('abort', this.onAbort);
        this.removeDetachedListener?.();

        if (!force && this.child.exitCode === null && this.child.signalCode === null) {
            await this.connection.send('Browser.close', {}, { timeoutMs: CLOSE_TIMEOUT_MS }).catch(() => {});
        }

        if (!await waitForChildExit(this.child, force ? 100 : CLOSE_TIMEOUT_MS)) {
            this.child.kill();
            if (!await waitForChildExit(this.child, CLOSE_TIMEOUT_MS)) {
                this.child.kill('SIGKILL');
                await waitForChildExit(this.child, CLOSE_TIMEOUT_MS);
            }
        }

        this.connection.fail(connectionClosedError('Chrome session is closed.'));
        this.connection.reader.destroy();
        this.connection.writer.destroy();
        for (const page of [...this.pages.values()]) page._markClosed();
        await this.#cleanup();
    }

    #cleanup() {
        this.cleanupPromise ??= rm(this.userDataDirectory, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100
        });
        return this.cleanupPromise;
    }
}

function waitForSpawn(child, signal) {
    assertSignal(signal);
    if (signal?.aborted) {
        child.kill();
        return Promise.reject(abortError(signal));
    }
    return new Promise((resolve, reject) => {
        const finish = (error) => {
            child.removeListener('spawn', onSpawn);
            child.removeListener('error', onError);
            signal?.removeEventListener('abort', onAbort);
            if (error) reject(error);
            else resolve();
        };
        const onSpawn = () => finish();
        const onError = (error) => finish(error);
        const onAbort = () => {
            child.kill();
            finish(abortError(signal));
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function assertSupportedNode() {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 12)) {
        throw new Error(`Chrome sessions require Node.js >= 22.12.0; current version is ${process.versions.node}.`);
    }
}

/**
 * Launch Chrome Stable with an isolated temporary profile and CDP pipe.
 *
 * Options: executablePath (string|null), headless (boolean), noSandbox
 * (boolean), timeoutMs, signal, viewport ({width,height}), args (additional
 * Chrome flags), env, cwd.
 * When executablePath is null, discoverChromeExecutable() locates Stable.
 */
export async function launchChrome(options = {}) {
    assertSupportedNode();
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('Chrome launch options must be an object.');
    }
    const headless = options.headless ?? true;
    if (typeof headless !== 'boolean') throw new TypeError('headless must be a boolean.');
    const noSandbox = options.noSandbox ?? chromeNoSandboxFromEnvironment();
    if (typeof noSandbox !== 'boolean') throw new TypeError('noSandbox must be a boolean.');
    const timeoutMs = timeoutFor(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    const signal = options.signal;
    assertSignal(signal);
    if (signal?.aborted) throw abortError(signal);
    const executablePath = await discoverChromeExecutable(options.executablePath ?? null);
    if (signal?.aborted) throw abortError(signal);

    if (options.args !== undefined && (!Array.isArray(options.args)
        || options.args.some((argument) => typeof argument !== 'string'))) {
        throw new TypeError('args must be an array of strings.');
    }
    const reserved = /^(--remote-debugging-|--user-data-dir(?:=|$)|--headless(?:=|$)|--no-sandbox(?:=|$))/;
    const conflicting = (options.args ?? []).find((argument) => reserved.test(argument));
    if (conflicting) throw new Error(`Chrome argument is managed by launchChrome and cannot be overridden: ${conflicting}`);

    const viewport = options.viewport ?? { width: 1440, height: 1000 };
    const width = positiveInteger(viewport.width, 'viewport.width', 100_000);
    const height = positiveInteger(viewport.height, 'viewport.height', 100_000);
    const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'vanilla-test-chrome-'));
    const chromeArguments = buildChromeLaunchArguments({
        userDataDirectory,
        width,
        height,
        headless,
        noSandbox,
        args: options.args
    });

    let child;
    let browser;
    try {
        child = spawn(executablePath, chromeArguments, {
            cwd: options.cwd,
            env: options.env ?? process.env,
            stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
            windowsHide: true
        });
        await waitForSpawn(child, signal);
        const connection = new PipeConnection(child, timeoutMs);
        browser = new ChromeSession(
            child,
            connection,
            executablePath,
            userDataDirectory,
            timeoutMs,
            signal
        );
        browser.version = await browser.send('Browser.getVersion', {}, { timeoutMs, signal });
        return browser;
    } catch (error) {
        if (browser) {
            await browser.close({ force: true }).catch(() => {});
        } else {
            child?.kill();
            if (child) await waitForChildExit(child, CLOSE_TIMEOUT_MS).catch(() => {});
            await rm(userDataDirectory, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 100
            }).catch(() => {});
        }
        const stderr = browser?.stderr.trim();
        if (stderr && error instanceof Error && !error.message.includes(stderr)) {
            error.message += `\nChrome stderr:\n${stderr}`;
        }
        throw error;
    }
}
