import fs from 'node:fs/promises';
import path from 'node:path';

import { launchChrome } from './chrome-session.js';
import { createIncludeMatcher, listIncludedFiles } from './glob.js';
import { createHarness } from './harness.js';
import { writeNativeCoverageReport } from './native-report.js';
import { createOutputTransaction } from './output.js';
import { summarizeResult, validateResult } from './result.js';
import { startServer } from './server.js';
import { mergeV8ScriptCoverage } from './v8-merge.js';

function browserPath(root, value, origin) {
    let url;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.origin !== origin) return null;
    return path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
}

function isCoverageRequestAllowed(value, origin) {
    try {
        return new URL(value).origin === origin;
    } catch {
        return false;
    }
}

function remoteValue(argument) {
    if (Object.hasOwn(argument, 'value')) {
        if (typeof argument.value === 'string') return argument.value;
        try {
            return JSON.stringify(argument.value);
        } catch {
            return String(argument.value);
        }
    }
    return argument.description ?? argument.unserializableValue ?? argument.type ?? '';
}

async function coverageScripts(coverageData, config, origin) {
    const matches = createIncludeMatcher(config.root, config.chrome.include);
    const scripts = new Map();

    for (const script of coverageData) {
        const filePath = browserPath(config.root, script?.url, origin);
        if (!filePath || !matches(filePath)) continue;
        const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
        let grouped = scripts.get(key);
        if (!grouped) {
            grouped = {
                filePath,
                url: script.url,
                source: await fs.readFile(filePath, 'utf8'),
                records: []
            };
            scripts.set(key, grouped);
        }
        grouped.records.push(script);
    }

    return [...scripts.values()].map(({ records, ...script }) => ({
        ...script,
        functions: mergeV8ScriptCoverage(records, script.source.length).functions
    }));
}

export async function runChromeCoverage(config, signal) {
    const finalDirectory = path.join(config.reportsDirectory, 'chrome');
    const output = await createOutputTransaction(finalDirectory, 'chrome');
    const outputDirectory = output.directory;
    const successScreenshot = path.join(outputDirectory, 'vanilla-test-chrome.png');
    const errorScreenshot = path.join(outputDirectory, 'vanilla-test-chrome-error.png');
    let server;
    let browser;
    let page;
    let coverageStarted = false;
    let removeRequestListener;
    let requestFailure;

    try {
        server = await startServer(config.root, createHarness(config));
        browser = await launchChrome({
            executablePath: config.chrome.executablePath,
            headless: config.chrome.headless,
            timeoutMs: config.timeoutMs,
            signal,
            viewport: { width: 1440, height: 1000 }
        });
        page = await browser.createPage({
            viewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
            colorScheme: 'dark',
            timeoutMs: config.timeoutMs,
            signal
        });
        page.on('Runtime.consoleAPICalled', ({ type, args = [] }) => {
            const method = type === 'error' ? 'error' : type === 'warning' ? 'warn' : 'log';
            console[method](`[chrome] ${args.map(remoteValue).join(' ')}`);
        });
        page.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
            console.error(`[chrome page error] ${exceptionDetails?.exception?.description || exceptionDetails?.text || 'Unknown error'}`);
        });
        removeRequestListener = page.on('Fetch.requestPaused', ({ requestId, request }) => {
            const isSameOrigin = isCoverageRequestAllowed(request.url, server.origin);
            const command = isSameOrigin ? 'Fetch.continueRequest' : 'Fetch.failRequest';
            const params = isSameOrigin
                ? { requestId }
                : { requestId, errorReason: 'BlockedByClient' };
            void page.send(command, params, {
                timeoutMs: config.timeoutMs,
                signal
            }).catch((error) => {
                requestFailure ??= error;
            });
        });
        await page.send('Fetch.enable', {
            patterns: [{ urlPattern: '*' }]
        }, { timeoutMs: config.timeoutMs, signal });

        await page.send('Profiler.enable', {}, { timeoutMs: config.timeoutMs, signal });
        await page.send('Profiler.startPreciseCoverage', {
            callCount: true,
            detailed: true,
            allowTriggeredUpdates: false
        }, { timeoutMs: config.timeoutMs, signal });
        coverageStarted = true;

        await page.goto(`${server.origin}/__vanilla-test__/index.html`, {
            waitUntil: 'load',
            timeoutMs: config.timeoutMs,
            signal
        });
        await page.waitForFunction(
            'globalThis.__VANILLA_TEST_COVERAGE_RESULT__ !== undefined',
            { timeoutMs: config.timeoutMs, signal }
        );
        if (requestFailure) throw requestFailure;
        const outcome = await page.evaluate(`(() => {
            const outcome = globalThis.__VANILLA_TEST_COVERAGE_RESULT__;
            if (outcome?.kind === 'harness-error') {
                return { kind: 'harness-error', message: String(outcome.message) };
            }
            const source = outcome?.value;
            const value = {
                ok: source?.ok,
                failureCount: source?.failureCount
            };
            try {
                if (Number.isSafeInteger(source?.total) && source.total >= 0) value.total = source.total;
                if (Array.isArray(source?.passed)) value.passed = source.passed.filter((entry) => typeof entry === 'string');
                if (Array.isArray(source?.failed)) value.failed = source.failed.filter((entry) => typeof entry === 'string');
            } catch {
                // Optional result details must not make an otherwise valid result untransportable.
            }
            return { kind: outcome?.kind, value };
        })()`, {
            timeoutMs: config.timeoutMs,
            signal
        });
        const { result: coverageData } = await page.send('Profiler.takePreciseCoverage', {}, {
            timeoutMs: config.timeoutMs,
            signal
        });
        if (requestFailure) throw requestFailure;
        await page.send('Profiler.stopPreciseCoverage', {}, { timeoutMs: config.timeoutMs, signal });
        coverageStarted = false;

        await page.screenshot({
            path: successScreenshot,
            fullPage: true,
            timeoutMs: config.timeoutMs,
            signal
        });
        const report = await writeNativeCoverageReport({
            scripts: await coverageScripts(coverageData, config, server.origin),
            includedFiles: listIncludedFiles(config.root, config.chrome.include),
            root: config.root,
            outputDirectory,
            runtime: browser.version?.product ?? 'Google Chrome',
            title: 'vanilla-test Chrome native V8 coverage',
            thresholds: config.thresholds,
            enforcement: { total: true, perFile: true }
        });

        if (report.failures.length) {
            console.error(`Chrome coverage thresholds not met:\n${report.failures.map(({ message }) => message).join('\n')}`);
        }
        if (outcome?.kind === 'harness-error') {
            console.error(`vanilla-test coverage: ${outcome.message}`);
            return 2;
        }

        const result = validateResult(outcome?.value, config.entry);
        await fs.writeFile(
            path.join(outputDirectory, 'test-results.json'),
            `${JSON.stringify(summarizeResult(result, 'chrome', config.entry), null, 2)}\n`,
            'utf8'
        );
        const code = result.ok && report.passed ? 0 : 1;
        await output.commit();
        return code;
    } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') return 130;
        if (page) {
            await page.evaluate(
                `globalThis.__vanillaTestRenderHarnessError?.(${JSON.stringify(error?.stack || String(error))})`,
                { timeoutMs: config.timeoutMs }
            ).catch(() => {});
            await page.screenshot({
                path: errorScreenshot,
                fullPage: true,
                timeoutMs: config.timeoutMs
            }).catch(() => {});
        }
        console.error(`vanilla-test coverage: ${error?.stack || error}`);
        return 2;
    } finally {
        removeRequestListener?.();
        if (page) {
            await page.send('Fetch.disable', {}, { timeoutMs: config.timeoutMs }).catch(() => {});
        }
        if (coverageStarted && page) {
            await page.send('Profiler.stopPreciseCoverage', {}, { timeoutMs: config.timeoutMs }).catch(() => {});
        }
        await browser?.close().catch(() => {});
        await server?.close().catch(() => {});
        await output.cleanup();
    }
}

export { isCoverageRequestAllowed };
