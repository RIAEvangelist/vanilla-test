import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createIncludeMatcher } from './glob.js';
import { createHarness } from './harness.js';
import { createOutputTransaction } from './output.js';
import { startServer } from './server.js';
import { summarizeResult, validateResult } from './result.js';

function browserPath(root, value, origin) {
    let pathname;
    try {
        const url = new URL(value);
        if (origin && url.origin !== origin) return null;
        pathname = decodeURIComponent(url.pathname);
    } catch {
        return null;
    }
    return path.resolve(root, `.${pathname}`);
}

async function loadDependencies() {
    try {
        const [{ chromium }, reportModule] = await Promise.all([
            import('playwright-core'),
            import('monocart-coverage-reports')
        ]);
        const factory = typeof reportModule.default === 'function'
            ? reportModule.default
            : (options) => new reportModule.CoverageReport(options);
        return { chromium, factory };
    } catch (error) {
        throw new Error('playwright-core and monocart-coverage-reports are required for Chrome coverage.', { cause: error });
    }
}

async function generateReport(factory, config, coverageData, outputDirectory, origin) {
    const matches = createIncludeMatcher(config.root, config.chrome.include);
    const browserPrefix = `${new URL(origin).hostname}-${new URL(origin).port}/`;
    let thresholdFailure = false;
    const reporter = factory({
        name: 'vanilla-test · Google Chrome native V8 coverage',
        outputDir: outputDirectory,
        reports: ['v8', 'console-details', 'lcovonly', 'json-summary'],
        clean: true,
        all: {
            dir: config.root,
            filter: (filePath) => matches(path.resolve(config.root, filePath)) ? 'js' : false
        },
        entryFilter: (entry) => {
            const filePath = browserPath(config.root, typeof entry === 'string' ? entry : entry.url, origin);
            return filePath !== null && matches(filePath);
        },
        sourcePath: (filePath) => {
            const mapped = browserPath(config.root, filePath);
            if (mapped) {
                return path.relative(config.root, mapped).split(path.sep).join('/');
            }
            return filePath.startsWith(browserPrefix) ? filePath.slice(browserPrefix.length) : filePath;
        },
        onEnd: async (results) => {
            if (!results?.summary) {
                throw new Error('Chrome coverage reporter produced no summary.');
            }
            const percent = (measure) => measure?.total === 0 ? 100 : Number(measure?.pct);
            const failures = [];
            for (const [metric, minimum] of Object.entries(config.thresholds)) {
                const actual = percent(results.summary[metric]);
                if (!Number.isFinite(actual) || actual < minimum) {
                    failures.push(`total ${metric}: ${Number.isFinite(actual) ? actual : 'unavailable'}% (required ${minimum}%)`);
                }
            }
            for (const file of results.files ?? []) {
                for (const [metric, minimum] of Object.entries(config.thresholds)) {
                    const actual = percent(file.summary?.[metric]);
                    if (!Number.isFinite(actual) || actual < minimum) {
                        failures.push(`${file.sourcePath} ${metric}: ${Number.isFinite(actual) ? actual : 'unavailable'}% (required ${minimum}%)`);
                    }
                }
            }
            if (failures.length) {
                thresholdFailure = true;
                console.error(`Chrome coverage thresholds not met:\n${failures.join('\n')}`);
            }
        }
    });
    await reporter.add(coverageData);
    await reporter.generate();
    return thresholdFailure;
}

export async function runChromeCoverage(config, signal) {
    const { chromium, factory } = await loadDependencies();
    if (config.chrome.executablePath) {
        const stat = await fs.stat(config.chrome.executablePath).catch(() => null);
        if (!stat?.isFile()) {
            throw new Error(`Chrome executable is not a file: ${config.chrome.executablePath}`);
        }
    }

    const finalDirectory = path.join(config.reportsDirectory, 'chrome');
    const output = await createOutputTransaction(finalDirectory, 'chrome');
    const outputDirectory = output.directory;
    let tempDirectory;
    let tempScreenshot;
    let server;
    let browser;
    let page;
    let coverageStarted = false;

    try {
        tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vanilla-test-chrome-'));
        tempScreenshot = path.join(tempDirectory, 'vanilla-test-chrome.png');
        server = await startServer(config.root, createHarness(config));
        browser = await chromium.launch({
            ...(config.chrome.executablePath
                ? { executablePath: config.chrome.executablePath }
                : { channel: 'chrome' }),
            headless: config.chrome.headless
        });
        page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        await page.route('**/*', async (route) => {
            const requestOrigin = new URL(route.request().url()).origin;
            if (requestOrigin === server.origin) {
                await route.continue();
            } else {
                await route.abort('blockedbyclient');
            }
        });
        page.on('console', (message) => {
            const method = message.type() === 'error' ? 'error' : message.type() === 'warning' ? 'warn' : 'log';
            console[method](`[chrome] ${message.text()}`);
        });
        page.on('pageerror', (error) => console.error(`[chrome page error] ${error.stack || error}`));

        await page.coverage.startJSCoverage({ resetOnNavigation: false });
        coverageStarted = true;
        await page.goto(`${server.origin}/__vanilla-test__/index.html`, { waitUntil: 'load', timeout: config.timeoutMs });
        await page.waitForFunction(() => globalThis.__VANILLA_TEST_COVERAGE_RESULT__ !== undefined, null, {
            timeout: config.timeoutMs
        });
        const outcome = await page.evaluate(() => globalThis.__VANILLA_TEST_COVERAGE_RESULT__);
        const coverageData = await page.coverage.stopJSCoverage();
        coverageStarted = false;

        await page.screenshot({ path: tempScreenshot, fullPage: true });
        const thresholdFailure = await generateReport(factory, config, coverageData, outputDirectory, server.origin);
        await fs.copyFile(tempScreenshot, path.join(outputDirectory, 'vanilla-test-chrome.png'));

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
        const code = result.ok && !thresholdFailure ? 0 : 1;
        await output.commit();
        return code;
    } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') {
            return 130;
        }
        if (page) {
            await page.evaluate((message) => globalThis.__vanillaTestRenderHarnessError?.(message), error?.stack || String(error)).catch(() => {});
            await page.screenshot({ path: tempScreenshot, fullPage: true }).catch(() => {});
            await fs.mkdir(outputDirectory, { recursive: true }).catch(() => {});
            await fs.copyFile(tempScreenshot, path.join(outputDirectory, 'vanilla-test-chrome-error.png')).catch(() => {});
        }
        console.error(`vanilla-test coverage: ${error?.stack || error}`);
        return 2;
    } finally {
        if (coverageStarted && page) {
            await page.coverage.stopJSCoverage().catch(() => {});
        }
        await browser?.close().catch(() => {});
        await server?.close().catch(() => {});
        if (tempDirectory) await fs.rm(tempDirectory, { recursive: true, force: true });
        await output.cleanup();
    }
}
