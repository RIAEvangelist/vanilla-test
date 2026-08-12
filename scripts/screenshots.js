import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const imageDirectory = resolve(root, 'example', 'img');
const origin = 'http://127.0.0.1:8000';

await mkdir(imageDirectory, { recursive: true });

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

    const browser = await chromium.launch({
        ...(process.env.CHROME_PATH
            ? { executablePath: process.env.CHROME_PATH }
            : { channel: 'chrome' }),
        headless: true
    });

    try {
        const page = await browser.newPage({
            colorScheme: 'dark',
            deviceScaleFactor: 1,
            viewport: { width: 1440, height: 1000 }
        });

        await page.goto(`${origin}/test/`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => {
            const explicit = document.querySelector('[data-vanilla-test-status][data-ok]');
            const fallback = document.querySelector('[data-status][data-ok]');
            const explicitFinished = explicit?.dataset.ok === 'true' || explicit?.dataset.ok === 'false';
            const fallbackFinished = fallback?.dataset.ok === 'true' || fallback?.dataset.ok === 'false';
            return explicitFinished || fallbackFinished || document.body.dataset.complete === 'true';
        });
        await page.screenshot({
            path: resolve(imageDirectory, 'vanilla-test-chrome-v2.png'),
            fullPage: true
        });

        for (const [url, filename] of [
            [`${origin}/coverage/chrome/`, 'vanilla-test-chrome-coverage-v2.png'],
            [`${origin}/coverage/node/`, 'vanilla-test-node-coverage-v2.png']
        ]) {
            const response = await page.goto(url, { waitUntil: 'networkidle' });
            if (!response?.ok()) {
                throw new Error(`Coverage report is unavailable at ${url}`);
            }
            await page.screenshot({ path: resolve(imageDirectory, filename), fullPage: true });
        }
    } finally {
        await browser.close();
    }
} finally {
    server.kill();
}

console.log(`Screenshots written to ${imageDirectory}`);
