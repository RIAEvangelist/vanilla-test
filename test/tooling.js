import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HELP, main, parseArguments } from '../lib/coverage/cli.js';
import { loadConfig, packagePathFromModule } from '../lib/coverage/config.js';
import { createIncludeMatcher, globToRegExp, toPosix } from '../lib/coverage/glob.js';
import { selectRun, validateResult } from '../lib/coverage/result.js';
import { startServer } from '../lib/coverage/server.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entryRunner = path.join(projectRoot, 'lib', 'coverage', 'entry-runner.js');

async function temporaryDirectory(context) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vanilla-test-tooling-'));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

function request(origin, requestPath, method = 'GET') {
    const target = new URL(origin);
    return new Promise((resolve, reject) => {
        const outgoing = http.request({
            host: target.hostname,
            port: target.port,
            path: requestPath,
            method
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks).toString('utf8')
            }));
        });
        outgoing.once('error', reject);
        outgoing.end();
    });
}

function runRunner(argumentsList, wallTimeoutMs = 3_000) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [entryRunner, ...argumentsList], {
            cwd: projectRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`Entry runner exceeded its ${wallTimeoutMs} ms test deadline.`));
        }, wallTimeoutMs);
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, stdout, stderr });
        });
    });
}

async function runEntry(context, source, timeoutMs = 200) {
    const directory = await temporaryDirectory(context);
    const entry = path.join(directory, 'entry.mjs');
    await fs.writeFile(entry, source, 'utf8');
    return runRunner([entry, String(timeoutMs)]);
}

test('CLI argument parsing is strict and deterministic', () => {
    assert.deepEqual(parseArguments([
        'coverage', 'chrome', '--config', 'custom.json', '--chrome-path', 'chrome.exe',
        '--headed', '--timeout-ms', '250', '--help'
    ]), {
        target: 'chrome',
        config: 'custom.json',
        chromePath: 'chrome.exe',
        headed: true,
        timeoutMs: 250,
        help: true
    });
    assert.deepEqual(parseArguments(['coverage']), { target: 'all' });
    assert.throws(() => parseArguments(['coverage', '--config']), /requires a value/);
    assert.throws(() => parseArguments(['coverage', '--headed', '--headed']), /Duplicate option/);
    assert.throws(() => parseArguments(['coverage', '--unknown']), /Unknown argument/);
    assert.throws(() => parseArguments(['coverage', '--timeout-ms', '0']), /positive integer/);
    assert.throws(() => parseArguments(['coverage', '--timeout-ms', '1.5']), /positive integer/);
    assert.throws(() => parseArguments(['coverage', '--timeout-ms', '999999999999999999999']), /positive integer/);
});

test('CLI help, version, and usage errors have stable exit codes', async () => {
    const log = [];
    const errors = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...values) => log.push(values.join(' '));
    console.error = (...values) => errors.push(values.join(' '));
    try {
        assert.equal(await main([]), 0);
        assert.equal(log.at(-1), HELP);
        assert.equal(await main(['--version']), 0);
        assert.match(log.at(-1), /^2\.0\.0$/);
        assert.equal(await main(['coverage', '--no-such-option']), 2);
        assert.match(errors.at(-1), /Unknown argument/);
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
});

test('result selection and validation reject ambiguous failure states', () => {
    const passing = Object.freeze({ ok: true, failureCount: 0 });
    assert.equal(validateResult(passing), passing);
    assert.equal(selectRun({ default: () => 1, run: () => 2 })(), 1);
    assert.equal(selectRun({ run: () => 2 })(), 2);

    for (const value of [null, [], {}, { ok: true, failureCount: -1 }, { ok: false, failureCount: 0 }]) {
        assert.throws(() => validateResult(value, 'fixture'), /fixture/);
    }
    assert.throws(() => selectRun({}, 'fixture'), /default function or named run function/);
});

test('glob helpers match only positive project-relative paths', () => {
    const recursive = globToRegExp('src/**/*.js');
    assert.equal(recursive.test('src/index.js'), true);
    assert.equal(recursive.test('src/deep/module.js'), true);
    assert.equal(recursive.test('src/deep/module.css'), false);
    assert.equal(globToRegExp('test/file?.js').test('test/file1.js'), true);
    assert.equal(globToRegExp('literal/[x].js').test('literal/[x].js'), true);

    const matcher = createIncludeMatcher(projectRoot, ['index.js', 'lib/**/*.js']);
    assert.equal(matcher(path.join(projectRoot, 'index.js')), true);
    assert.equal(matcher(path.join(projectRoot, 'lib', 'coverage', 'cli.js')), true);
    assert.equal(matcher(path.resolve(projectRoot, '..', 'index.js')), false);
    assert.equal(toPosix(path.join('lib', 'coverage', 'cli.js')), 'lib/coverage/cli.js');
});

test('configuration resolves, freezes, and validates project-local inputs', async (context) => {
    const root = await temporaryDirectory(context);
    const entry = path.join(root, 'entry.js');
    const browserDependency = path.join(root, 'browser.js');
    const configPath = path.join(root, 'vanilla-test.config.json');
    await fs.writeFile(entry, 'export default () => ({ ok: true, failureCount: 0 });\n');
    await fs.writeFile(browserDependency, 'export const ready = true;\n');

    const base = {
        entry: './entry.js',
        reportsDirectory: './coverage',
        thresholds: { statements: 90, branches: 80, functions: 70, lines: 60 },
        node: { include: ['entry.js'] },
        chrome: {
            include: ['entry.js'],
            imports: { fixture: './browser.js' },
            headless: true,
            executablePath: null
        },
        timeoutMs: 500
    };
    const write = (value) => fs.writeFile(configPath, `${JSON.stringify(value)}\n`, 'utf8');
    await write(base);

    const chromePath = path.join(root, 'chrome.exe');
    const config = loadConfig(configPath, { headed: true, timeoutMs: 750, chromePath });
    assert.equal(config.root, root);
    assert.equal(config.entry, entry);
    assert.equal(config.entryUrl, '/entry.js');
    assert.equal(config.reportsDirectory, path.join(root, 'coverage'));
    assert.equal(config.timeoutMs, 750);
    assert.deepEqual(config.thresholds, { statements: 90, branches: 80, functions: 70, lines: 60 });
    assert.deepEqual(config.node.include, ['entry.js']);
    assert.equal(config.chrome.imports.fixture, '/browser.js');
    assert.equal(config.chrome.headless, false);
    assert.equal(config.chrome.executablePath, chromePath);
    assert.equal(Object.isFrozen(config), true);
    assert.equal(Object.isFrozen(config.chrome.imports), true);
    assert.equal(packagePathFromModule(new URL('../lib/coverage/config.js', import.meta.url).href), path.join(projectRoot, 'package.json'));

    await write({ ...base, unexpected: true });
    assert.throws(() => loadConfig(configPath), /unknown key/);
    await write({ ...base, entry: '../outside.js' });
    assert.throws(() => loadConfig(configPath), /must stay inside/);
    await write({ ...base, node: { include: ['!entry.js'] } });
    assert.throws(() => loadConfig(configPath), /positive project-relative glob/);
    await write({ ...base, thresholds: { ...base.thresholds, lines: 101 } });
    assert.throws(() => loadConfig(configPath), /0 through 100/);
});

test('local coverage server serves only files inside its root', async (context) => {
    const root = await temporaryDirectory(context);
    await fs.writeFile(path.join(root, 'module.js'), 'export const answer = 42;\n', 'utf8');
    const server = await startServer(root, '<!doctype html><title>Harness</title>');
    context.after(server.close);

    const harness = await request(server.origin, '/__vanilla-test__/index.html');
    assert.equal(harness.status, 200);
    assert.match(harness.headers['content-type'], /^text\/html/);
    assert.match(harness.body, /Harness/);

    const module = await request(server.origin, '/module.js');
    assert.equal(module.status, 200);
    assert.match(module.headers['content-type'], /^text\/javascript/);
    assert.match(module.body, /answer = 42/);
    assert.equal(module.headers['cache-control'], 'no-store');
    assert.equal(module.headers['x-content-type-options'], 'nosniff');

    const head = await request(server.origin, '/module.js', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal((await request(server.origin, '/missing.js')).status, 404);
    assert.equal((await request(server.origin, '/module.js', 'POST')).status, 405);
    assert.equal((await request(server.origin, '/..%2Foutside.js')).status, 403);
    assert.equal((await request(server.origin, '/%E0%A4%A')).status, 400);
});

test('entry runner maps pass, failure, invalid output, timeout, and leaked handles', async (context) => {
    assert.equal((await runEntry(context, 'export default () => ({ ok: true, failureCount: 0 });\n')).code, 0);
    assert.equal((await runEntry(context, 'export const run = () => ({ ok: false, failureCount: 2 });\n')).code, 1);

    const invalid = await runEntry(context, 'export default () => ({ ok: true, failureCount: 1 });\n');
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /inconsistent ok and failureCount/);

    const rejected = await runEntry(context, 'export default async () => { throw new Error("fixture rejection"); };\n');
    assert.equal(rejected.code, 2);
    assert.match(rejected.stderr, /fixture rejection/);

    const timedOut = await runEntry(context, 'export default () => new Promise(() => {});\n', 25);
    assert.equal(timedOut.code, 2);
    assert.match(timedOut.stderr, /timed out after 25 ms/);

    const leakedHandle = await runEntry(context, 'setInterval(() => {}, 10_000); export default () => ({ ok: true, failureCount: 0 });\n');
    assert.equal(leakedHandle.code, 0);
    assert.equal(leakedHandle.signal, null);

    const invalidArguments = await runRunner([]);
    assert.equal(invalidArguments.code, 2);
    assert.match(invalidArguments.stderr, /invalid arguments/);
});
