import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { launchChrome } from '../lib/coverage/chrome-session.js';

const root = resolve(import.meta.dirname, '..');
const imageDirectory = resolve(root, 'example', 'img');
const origin = 'http://127.0.0.1:8000';

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
    env: { ...process.env, PORT: '8000' },
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
        await page.screenshot({
            path: resolve(imageDirectory, 'vanilla-test-chrome-v2.png'),
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
            await page.screenshot({ path: resolve(imageDirectory, filename), fullPage: true });
        }
    } finally {
        await browser.close();
    }
} finally {
    server.kill();
}

console.log(`Screenshots written to ${imageDirectory}`);
