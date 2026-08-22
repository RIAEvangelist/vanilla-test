import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { launchChrome } from '../lib/coverage/chrome-session.js';

const root = resolve(import.meta.dirname, '..');
const imageDirectory = resolve(root, 'example', 'img');
const port = process.env.PORT || '8000';
const origin = `http://127.0.0.1:${port}`;

await mkdir(imageDirectory, { recursive: true });

async function verifyPlayground(page) {
    const redirect = await fetch(`${origin}/playground`, { redirect: 'manual' });
    if (redirect.status !== 308 || redirect.headers.get('location') !== '/playground/') {
        throw new Error('The playground directory route does not preserve its module-relative base URL.');
    }

    await page.goto(`${origin}/playground/`);
    await page.waitForFunction(
        () => document.querySelector('[data-playground-status]')?.dataset.state === 'ready'
    );
    await page.evaluate("document.querySelector('[data-playground-run]').click()");
    await page.waitForFunction(
        () => document.querySelector('[data-playground-status]')?.dataset.state === 'passed'
    );
    const defaultRun = await page.evaluate(`(() => ({
        status: document.querySelector('[data-playground-status]').textContent,
        output: document.querySelector('[data-playground-console]').textContent
    }))()`);
    if (!/2 test\(s\) passed/.test(defaultRun.status) || !/Summary/.test(defaultRun.output)) {
        throw new Error('The playground default module did not publish its result and console output.');
    }
    const styledPlaygroundOutput = await page.evaluate(
        "document.querySelectorAll('[data-playground-console] [class*=\"ansi-\"]').length"
    );
    if (styledPlaygroundOutput < 4) {
        throw new Error('The playground did not render its ansi-colors output.');
    }
    await page.screenshot({
        path: resolve(imageDirectory, 'vanilla-test-playground-v2.png'),
        fullPage: true
    });

    await page.evaluate("document.querySelector('[data-playground-reset]').click()");
    await page.waitForFunction(
        () => document.querySelector('[data-playground-status]')?.dataset.state === 'ready'
    );

    await page.setViewport({ width: 320, height: 800, deviceScaleFactor: 1 });
    const reflowsAt320 = await page.evaluate(
        'document.documentElement.scrollWidth <= document.documentElement.clientWidth'
    );
    if (!reflowsAt320) throw new Error('The playground overflows horizontally at 320 CSS pixels.');
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });

    await page.evaluate(`(() => {
        document.querySelector('#playground-code').value = [
            "console.log('x'.repeat(5000));",
            "console.log(Array.from({ length: 400 }, (_, index) => index).join('\\\\n'));",
            'export default { ok: true, total: 0, failureCount: 0 };'
        ].join('\\n');
        document.querySelector('[data-playground-run]').click();
    })()`);
    await page.waitForFunction(
        () => document.querySelector('[data-playground-status]')?.dataset.state === 'passed'
    );
    const boundedOutput = await page.evaluate(`(() => ({
        characters: document.querySelector('[data-playground-console]').textContent.length,
        lines: document.querySelectorAll('[data-playground-console] .console-line').length,
        text: document.querySelector('[data-playground-console]').textContent
    }))()`);
    if (boundedOutput.lines > 301 || boundedOutput.characters > 105_000
        || !/truncated|Output stopped/.test(boundedOutput.text)) {
        throw new Error('The playground did not bound mirrored console output.');
    }

    await page.evaluate("document.querySelector('[data-playground-reset]').click()");
    await page.waitForFunction(
        () => document.querySelector('[data-playground-status]')?.dataset.state === 'ready'
    );

    await page.evaluate(`(() => {
        document.querySelector('#playground-code').value = 'await new Promise(() => {});';
        document.querySelector('[data-playground-run]').click();
    })()`);
    await page.waitForFunction(
        () => document.querySelector('[data-playground-status]')?.textContent.includes('timed out'),
        { timeoutMs: 20_000 }
    );
    await page.evaluate("document.querySelector('[data-playground-reset]').click()");
    await page.waitForFunction(
        () => document.querySelector('[data-playground-status]')?.dataset.state === 'ready'
    );
}

const server = spawn(process.execPath, [resolve(root, 'scripts', 'serve.js')], {
    cwd: root,
    env: { ...process.env, PORT: port },
    stdio: ['ignore', 'pipe', 'inherit']
});

try {
    await new Promise((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out starting screenshot server')), 10_000);

        server.once('error', reject);
        server.stdout.setEncoding('utf8');
        server.stdout.on('data', (chunk) => {
            process.stdout.write(chunk);
            if (chunk.includes(origin)) {
                clearTimeout(timer);
                resolveReady();
            }
        });
    });

    const browser = await launchChrome({
        executablePath: process.env.CHROME_PATH || null,
        headless: true,
        timeoutMs: 30_000,
        viewport: { width: 1440, height: 1000 }
    });

    try {
        const page = await browser.createPage({
            colorScheme: 'dark',
            viewport: { width: 1440, height: 1000, deviceScaleFactor: 1 }
        });

        await verifyPlayground(page);

        await page.goto(`${origin}/test/`);
        await page.waitForFunction(() => globalThis.__VANILLA_TEST_RESULT__ !== undefined);
        const browserRun = await page.evaluate(`(() => ({
            total: globalThis.__VANILLA_TEST_RESULT__.total,
            categoryTotal: globalThis.__VANILLA_TEST_RESULT__.categories
                .reduce((total, category) => total + category.total, 0),
            categories: document.querySelectorAll('#checks .test-category').length,
            ansiSegments: document.querySelectorAll('#console-output [class*="ansi-"]').length
        }))()`);
        if (browserRun.categories !== 4 || browserRun.total !== browserRun.categoryTotal
            || browserRun.ansiSegments < browserRun.total) {
            throw new Error('The browser verifier did not render four complete ANSI test sets.');
        }
        await page.screenshot({
            path: resolve(imageDirectory, 'vanilla-test-chrome-v2.png'),
            fullPage: true
        });

        await page.goto(`${origin}/benchmark/`);
        await page.waitForFunction(
            () => !document.querySelector('[data-benchmark-state]')?.textContent.includes('Loading')
        );
        const benchmark = await page.evaluate(`(() => ({
            rows: document.querySelectorAll('[data-benchmark-lane] tr').length,
            machineFields: document.querySelectorAll('[data-benchmark-machine] .benchmark-machine__item').length,
            state: document.querySelector('[data-benchmark-state]').textContent
        }))()`);
        if (benchmark.rows !== 5 || benchmark.machineFields < 7 || !/Verified publishable run/.test(benchmark.state)) {
            throw new Error('The published benchmark page did not render five verified runner rows and machine specifications.');
        }
        await page.evaluate("document.querySelector('[data-benchmark-source=\"run.js\"]').click()");
        await page.waitForFunction(
            () => document.querySelector('[data-source-dialog]')?.open
                && document.querySelector('[data-source-code]')?.textContent.includes('parseArguments')
        );
        const sourceDisclosure = await page.evaluate(`(() => ({
            localSource: document.querySelector('[data-source-code]').textContent.includes('validateWorkerResult'),
            pinnedLink: document.querySelector('[data-source-github]').href
        }))()`);
        if (!sourceDisclosure.localSource || !/\/blob\/[0-9a-f]{40}\/benchmark\/run\.js$/.test(sourceDisclosure.pinnedLink)) {
            throw new Error('The benchmark source dialog did not expose local code and its commit-pinned repository link.');
        }
        await page.evaluate("document.querySelector('[data-source-dialog]').close()");
        await page.setViewport({ width: 320, height: 800, deviceScaleFactor: 1 });
        const benchmarkReflowsAt320 = await page.evaluate(
            'document.documentElement.scrollWidth <= document.documentElement.clientWidth'
        );
        if (!benchmarkReflowsAt320) throw new Error('The benchmark page overflows horizontally at 320 CSS pixels.');
        await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
        await page.screenshot({
            path: resolve(imageDirectory, 'vanilla-test-benchmark-v2.png'),
            fullPage: true
        });

        for (const [url, filename] of [
            [`${origin}/coverage/chrome/`, 'vanilla-test-chrome-coverage-v2.png'],
            [`${origin}/coverage/node/`, 'vanilla-test-node-coverage-v2.png']
        ]) {
            const response = await fetch(url, { method: 'HEAD' });
            if (!response.ok) {
                throw new Error(`Coverage report is unavailable at ${url}`);
            }
            await page.goto(url);
            await page.evaluate('globalThis.scrollTo(0, 0)');
            await page.screenshot({ path: resolve(imageDirectory, filename), fullPage: true });
        }
    } finally {
        await browser.close();
    }
} finally {
    server.kill();
}

console.log(`Screenshots written to ${imageDirectory}`);
