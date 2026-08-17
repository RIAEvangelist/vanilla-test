import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { launchChrome } from '../lib/coverage/chrome-session.js';
import { writeNativeCoverageReport } from '../lib/coverage/native-report.js';
import { startServer } from '../lib/coverage/server.js';
import { mergeV8ScriptCoverage } from '../lib/coverage/v8-merge.js';
import { expectedChecksum } from './workload.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerEntries = Object.freeze({
    'vanilla-test': '/benchmark/runners/vanilla-browser.js',
    mocha: '/benchmark/runners/mocha-browser.js'
});

function positiveInteger(value, label) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) throw new RangeError(`${label} must be a positive safe integer.`);
    return number;
}

function harness(runner, cases, batchSize) {
    const dependency = runner === 'mocha' ? '<script src="/benchmark/node_modules/mocha/mocha.js"></script>' : '';
    const entry = JSON.stringify(runnerEntries[runner]);
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,">
<script type="importmap">${JSON.stringify({ imports: {
        'ansi-colors-es6': '/node_modules/ansi-colors-es6/index.js',
        'strong-type': '/node_modules/strong-type/index.js'
    } })}</script>
<title>vanilla-test benchmark worker</title>${dependency}</head><body>
<main><h1>Native Chrome benchmark</h1><p>Running ${runner}…</p></main>
<script type="module">
try {
    const namespace = await import(${entry});
    const value = await namespace.runBrowserBenchmark(${JSON.stringify({ cases, batchSize })});
    globalThis.__VANILLA_TEST_BENCHMARK_RESULT__ = { kind: 'result', value };
} catch (error) {
    globalThis.__VANILLA_TEST_BENCHMARK_RESULT__ = { kind: 'error', message: error?.stack || String(error) };
}
</script></body></html>`;
}

function browserFilePath(url, origin) {
    try {
        const parsed = new URL(url);
        if (parsed.origin !== origin) return null;
        return path.resolve(projectRoot, `.${decodeURIComponent(parsed.pathname)}`);
    } catch {
        return null;
    }
}

async function coverageScripts(coverageData, origin) {
    const workloadPath = path.join(projectRoot, 'benchmark', 'workload.js');
    const records = coverageData.filter((entry) => {
        const filePath = browserFilePath(entry?.url, origin);
        return filePath && path.normalize(filePath).toLowerCase() === path.normalize(workloadPath).toLowerCase();
    });
    if (records.length === 0) return [];
    const source = await fs.readFile(workloadPath, 'utf8');
    return [{
        filePath: workloadPath,
        url: records[0].url,
        source,
        functions: mergeV8ScriptCoverage(records, source.length).functions
    }];
}

async function fileRecord(filePath, outputDirectory) {
    const source = await fs.readFile(filePath);
    return {
        file: path.relative(outputDirectory, filePath).split(path.sep).join('/'),
        bytes: source.length,
        sha256: createHash('sha256').update(source).digest('hex')
    };
}

async function main() {
    const [, , runner, caseText, batchText, runDirectoryText, timeoutText] = process.argv;
    if (!runnerEntries[runner]) throw new TypeError(`Unknown browser benchmark runner ${JSON.stringify(runner)}.`);
    const cases = positiveInteger(caseText, 'cases');
    const batchSize = positiveInteger(batchText, 'batchSize');
    const timeoutMs = positiveInteger(timeoutText, 'timeoutMs');
    if (batchSize > cases) throw new RangeError('batchSize cannot exceed cases.');
    const runDirectory = path.resolve(runDirectoryText);
    const outputDirectory = path.join(runDirectory, 'browser');
    const workloadPath = path.join(projectRoot, 'benchmark', 'workload.js');
    await fs.mkdir(outputDirectory, { recursive: true });

    let server;
    let browser;
    let page;
    let coverageStarted = false;
    let requestFailure;
    let removeRequestListener;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Browser benchmark exceeded ${timeoutMs} ms.`)), timeoutMs);
    const started = performance.now();
    let result;
    try {
        server = await startServer(projectRoot, harness(runner, cases, batchSize));
        browser = await launchChrome({
            headless: true,
            timeoutMs,
            signal: controller.signal,
            args: ['--enable-precise-memory-info']
        });
        page = await browser.createPage({
            viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
            colorScheme: 'dark', timeoutMs, signal: controller.signal
        });
        removeRequestListener = page.on('Fetch.requestPaused', ({ requestId, request }) => {
            let sameOrigin = false;
            try { sameOrigin = new URL(request.url).origin === server.origin; } catch {}
            const command = sameOrigin ? 'Fetch.continueRequest' : 'Fetch.failRequest';
            const params = sameOrigin ? { requestId } : { requestId, errorReason: 'BlockedByClient' };
            void page.send(command, params, { timeoutMs, signal: controller.signal }).catch((error) => { requestFailure ??= error; });
        });
        await page.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, { timeoutMs, signal: controller.signal });
        await page.send('Profiler.enable', {}, { timeoutMs, signal: controller.signal });
        await page.send('Profiler.startPreciseCoverage', {
            callCount: true, detailed: true, allowTriggeredUpdates: false
        }, { timeoutMs, signal: controller.signal });
        coverageStarted = true;
        await page.goto(`${server.origin}/__vanilla-test__/index.html`, {
            waitUntil: 'load', timeoutMs, signal: controller.signal
        });
        await page.waitForFunction('globalThis.__VANILLA_TEST_BENCHMARK_RESULT__ !== undefined', {
            timeoutMs, signal: controller.signal
        });
        if (requestFailure) throw requestFailure;
        const outcome = await page.evaluate('globalThis.__VANILLA_TEST_BENCHMARK_RESULT__', {
            timeoutMs, signal: controller.signal
        });
        if (outcome?.kind !== 'result') throw new Error(outcome?.message || 'Browser runner returned no result.');
        const { result: coverageData } = await page.send('Profiler.takePreciseCoverage', {}, {
            timeoutMs, signal: controller.signal
        });
        await page.send('Profiler.stopPreciseCoverage', {}, { timeoutMs, signal: controller.signal });
        coverageStarted = false;
        const metrics = outcome.value;
        const expected = expectedChecksum(cases);
        const valid = metrics?.cases === cases
            && metrics.suites === Math.ceil(cases / batchSize)
            && metrics.executed === cases
            && metrics.passed === cases
            && metrics.failureCount === 0
            && metrics.checksum === expected;
        if (!valid) throw new Error(`${runner} returned invalid browser counts or checksum.`);
        const report = await writeNativeCoverageReport({
            scripts: await coverageScripts(coverageData, server.origin),
            includedFiles: [workloadPath],
            root: projectRoot,
            outputDirectory,
            runtime: browser.version?.product ?? 'Google Chrome',
            title: `${runner} native Chrome benchmark coverage`,
            thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 }
        });
        await fs.writeFile(path.join(outputDirectory, 'test-results.json'), `${JSON.stringify({
            schemaVersion: 1, runtime: 'chrome', ok: true, total: cases,
            passedCount: cases, failureCount: 0, passed: [], failed: []
        }, null, 2)}\n`, 'utf8');
        const reportNames = ['test-results.json', 'coverage-summary.json', 'lcov.info', 'index.html'];
        const reports = await Promise.all(reportNames.map((name) => fileRecord(path.join(outputDirectory, name), outputDirectory)));
        result = {
            schemaVersion: 1, lane: 'browser', runner, valid,
            counts: { cases, suites: metrics.suites, executed: metrics.executed, passed: metrics.passed, failed: 0 },
            checksum: metrics.checksum, expectedChecksum: expected,
            runnerMs: metrics.runnerMs,
            phasesMs: metrics.phasesMs,
            reportBytes: metrics.reportBytes,
            memory: metrics.memory,
            coverage: report.summary.total,
            reports,
            browser: browser.version
        };
    } finally {
        clearTimeout(timer);
        removeRequestListener?.();
        if (coverageStarted && page) await page.send('Profiler.stopPreciseCoverage', {}, { timeoutMs }).catch(() => {});
        if (page) await page.send('Fetch.disable', {}, { timeoutMs }).catch(() => {});
        await browser?.close().catch(() => {});
        await server?.close().catch(() => {});
    }
    result.pipelineMs = performance.now() - started;
    return result;
}

try {
    process.stdout.write(`${JSON.stringify(await main())}\n`);
} catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
}
