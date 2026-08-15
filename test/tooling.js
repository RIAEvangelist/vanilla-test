import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HELP, main, parseArguments } from '../lib/coverage/cli.js';
import {
    buildChromeLaunchArguments,
    chromeNoSandboxFromEnvironment
} from '../lib/coverage/chrome-session.js';
import { isCoverageRequestAllowed } from '../lib/coverage/chrome.js';
import { loadConfig, packagePathFromModule } from '../lib/coverage/config.js';
import { createIncludeMatcher, globToRegExp, toPosix } from '../lib/coverage/glob.js';
import { getThresholdFailures } from '../lib/coverage/native-report.js';
import { runNodeCoverage } from '../lib/coverage/node.js';
import { selectRun, summarizeResult, validateResult } from '../lib/coverage/result.js';
import { startServer } from '../lib/coverage/server.js';
import { mergeV8ScriptCoverage } from '../lib/coverage/v8-merge.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entryRunner = path.join(projectRoot, 'lib', 'coverage', 'entry-runner.js');
const packageVersion = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8')).version;

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
        assert.equal(log.at(-1), packageVersion);
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

    assert.deepEqual(summarizeResult({
        ok: false,
        failureCount: 1,
        total: 2,
        passed: ['\u001B[32mpass\u001B[39m'],
        failed: ['\u001B[31mfail\u001B[39m']
    }, 'node'), {
        schemaVersion: 1,
        runtime: 'node',
        ok: false,
        total: 2,
        passedCount: 1,
        failureCount: 1,
        passed: ['pass'],
        failed: ['fail']
    });
    assert.deepEqual(summarizeResult({ ok: false, failureCount: 2 }, 'chrome'), {
        schemaVersion: 1,
        runtime: 'chrome',
        ok: false,
        total: 2,
        passedCount: 0,
        failureCount: 2,
        passed: [],
        failed: []
    });
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

    const { chrome, ...nodeOnly } = base;
    await write(nodeOnly);
    assert.deepEqual(loadConfig(configPath, { target: 'node' }).node.include, ['entry.js']);
    assert.throws(() => loadConfig(configPath), /chrome must be an object/);

    const { node, ...chromeOnly } = base;
    await write(chromeOnly);
    assert.deepEqual(loadConfig(configPath, { target: 'chrome' }).chrome.include, ['entry.js']);
    assert.throws(() => loadConfig(configPath), /node must be an object/);
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

test('Chrome coverage permits only requests to its exact loopback origin', () => {
    const origin = 'http://127.0.0.1:43210';
    assert.equal(isCoverageRequestAllowed(`${origin}/entry.js`, origin), true);
    assert.equal(isCoverageRequestAllowed('http://127.0.0.1:43211/entry.js', origin), false);
    assert.equal(isCoverageRequestAllowed('https://example.com/entry.js', origin), false);
    assert.equal(isCoverageRequestAllowed('data:,favicon', origin), false);
    assert.equal(isCoverageRequestAllowed('not a URL', origin), false);
});

test('Chrome sandbox bypass requires an explicit validated environment opt-in', () => {
    assert.equal(chromeNoSandboxFromEnvironment({}), false);
    assert.equal(chromeNoSandboxFromEnvironment({ VANILLA_TEST_CHROME_NO_SANDBOX: '' }), false);
    assert.equal(chromeNoSandboxFromEnvironment({ VANILLA_TEST_CHROME_NO_SANDBOX: '0' }), false);
    assert.equal(chromeNoSandboxFromEnvironment({ VANILLA_TEST_CHROME_NO_SANDBOX: '1' }), true);
    assert.throws(
        () => chromeNoSandboxFromEnvironment({ VANILLA_TEST_CHROME_NO_SANDBOX: 'true' }),
        /must be 0, 1, empty, or unset/
    );

    const options = {
        userDataDirectory: '/temporary/chrome-profile',
        width: 1440,
        height: 1000,
        headless: true,
        args: []
    };
    assert.equal(buildChromeLaunchArguments({ ...options, noSandbox: false }).includes('--no-sandbox'), false);
    assert.equal(buildChromeLaunchArguments({ ...options, noSandbox: true }).includes('--no-sandbox'), true);
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

test('native V8 records merge collapsed, missing, nested, and crossing executions', () => {
    const functionRecord = (ranges) => ({
        functionName: 'fixture',
        isBlockCoverage: ranges.length > 1,
        ranges
    });
    const root = (count) => ({ startOffset: 0, endOffset: 10, count });

    const collapsed = mergeV8ScriptCoverage([
        { functions: [functionRecord([root(1), { startOffset: 2, endOffset: 8, count: 0 }])] },
        { functions: [functionRecord([root(2)])] }
    ], 10);
    assert.deepEqual(collapsed.functions[0].ranges, [
        root(3),
        { startOffset: 2, endOffset: 8, count: 2 }
    ]);

    const missing = mergeV8ScriptCoverage([
        { functions: [functionRecord([root(1)])] },
        { functions: [] }
    ], 10);
    assert.deepEqual(missing.functions[0].ranges, [root(1)]);

    const nested = mergeV8ScriptCoverage([
        { functions: [functionRecord([
            root(1),
            { startOffset: 2, endOffset: 8, count: 0 },
            { startOffset: 3, endOffset: 7, count: 1 }
        ])] },
        { functions: [functionRecord([
            root(1),
            { startOffset: 2, endOffset: 8, count: 2 },
            { startOffset: 3, endOffset: 7, count: 0 }
        ])] }
    ], 10);
    assert.deepEqual(nested.functions[0].ranges, [
        root(2),
        { startOffset: 3, endOffset: 7, count: 1 }
    ]);

    const crossing = mergeV8ScriptCoverage([
        { functions: [functionRecord([root(1), { startOffset: 0, endOffset: 7, count: 0 }])] },
        { functions: [functionRecord([root(1), { startOffset: 3, endOffset: 10, count: 0 }])] }
    ], 10);
    assert.deepEqual(crossing.functions[0].ranges, [
        root(2),
        { startOffset: 0, endOffset: 3, count: 1 },
        { startOffset: 3, endOffset: 7, count: 0 },
        { startOffset: 7, endOffset: 10, count: 1 }
    ]);

    assert.throws(() => mergeV8ScriptCoverage([
        { functions: [functionRecord([
            root(1),
            { startOffset: 0, endOffset: 7, count: 0 },
            { startOffset: 3, endOffset: 10, count: 0 }
        ])] }
    ], 10), /partially overlapping/);
    assert.throws(() => mergeV8ScriptCoverage([
        { functions: [functionRecord([root(Number.MAX_SAFE_INTEGER)])] },
        { functions: [functionRecord([root(1)])] }
    ], 10), /MAX_SAFE_INTEGER/);
});

test('native coverage gates compare exact ratios independently of display precision', () => {
    const record = (total, covered) => Object.fromEntries(
        ['statements', 'branches', 'functions', 'lines']
            .map((metric) => [metric, { total, covered, skipped: 0, pct: 0 }])
    );

    const exactDecimal = { total: record(100, 57), 'exact.js': record(100, 57) };
    assert.deepEqual(getThresholdFailures(exactDecimal, { statements: 57 }), []);

    const repeatingDecimal = { total: record(3, 2), 'fraction.js': record(3, 2) };
    assert.deepEqual(getThresholdFailures(repeatingDecimal, { statements: 66.665 }), []);
    const failures = getThresholdFailures(repeatingDecimal, { statements: 66.667 });
    assert.equal(failures.length, 2);
    assert.ok(failures.every((failure) => failure.metric === 'statements'));
    assert.ok(failures.every((failure) => failure.reason === 'below-threshold'));
    assert.ok(failures.every((failure) => failure.message.includes('66.6666…% (required 66.667%)')));
});

test('Node coverage parent watchdog terminates a synchronous entry', async (context) => {
    const root = await temporaryDirectory(context);
    const entry = path.join(root, 'entry.js');
    const configPath = path.join(root, 'vanilla-test.config.json');
    await fs.writeFile(entry, 'for (;;) {}\nexport default () => ({ ok: true, failureCount: 0 });\n', 'utf8');
    await fs.writeFile(configPath, `${JSON.stringify({
        entry: './entry.js',
        reportsDirectory: './coverage',
        thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 },
        timeoutMs: 25,
        node: { include: ['entry.js'] },
        chrome: { include: ['entry.js'], imports: {}, headless: true, executablePath: null }
    })}\n`, 'utf8');

    const errors = [];
    const originalError = console.error;
    const started = Date.now();
    console.error = (...values) => errors.push(values.join(' '));
    try {
        assert.equal(await runNodeCoverage(loadConfig(configPath)), 2);
    } finally {
        console.error = originalError;
    }
    assert.ok(Date.now() - started < 3_000, 'Parent watchdog did not stop the synchronous entry promptly.');
    assert.match(errors.join('\n'), /timed out after 25 ms/);
});

test('README and Pages documentation cover the public API, CLI, config, reports, and console cues', async () => {
    const [readme, home, api, cli, coverage, testing, example, browserVerification, harness] = await Promise.all([
        fs.readFile(path.join(projectRoot, 'readme.md'), 'utf8'),
        fs.readFile(path.join(projectRoot, 'index.html'), 'utf8'),
        fs.readFile(path.join(projectRoot, 'api', 'index.html'), 'utf8'),
        fs.readFile(path.join(projectRoot, 'cli', 'index.html'), 'utf8'),
        fs.readFile(path.join(projectRoot, 'coverage', 'index.html'), 'utf8'),
        fs.readFile(path.join(projectRoot, 'testing', 'index.html'), 'utf8'),
        fs.readFile(path.join(projectRoot, 'example', 'index.html'), 'utf8'),
        fs.readFile(path.join(projectRoot, 'test', 'index.html'), 'utf8'),
        fs.readFile(path.join(projectRoot, 'lib', 'coverage', 'harness.js'), 'utf8')
    ]);
    const apiDocumentation = `${readme}\n${api}`;
    const cliDocumentation = `${readme}\n${cli}`;
    const site = `${home}\n${api}\n${cli}\n${coverage}\n${testing}`;

    for (const apiName of [
        'new VanillaTest()',
        'test.is',
        'test.compare',
        'test.throw',
        'test.strict',
        'test.expects(description)',
        'test.pass(strict = false)',
        'test.fail(strict = false)',
        'test.done()',
        'test.report()',
        'test.onComplete(listener, options)',
        'test.delay(iterations = 1000)',
        'VANILLA_TEST_COMPLETE_EVENT'
    ]) {
        assert.ok(apiDocumentation.includes(apiName), `Missing API documentation for ${apiName}`);
    }

    for (const cliOption of ['--config', '--chrome-path', '--headed', '--timeout-ms', '--help', '--version']) {
        assert.ok(cliDocumentation.includes(cliOption), `Missing CLI documentation for ${cliOption}`);
    }

    for (const configField of ['entry', 'reportsDirectory', 'thresholds', 'timeoutMs', 'node.include', 'chrome.include', 'chrome.imports', 'chrome.headless', 'chrome.executablePath']) {
        assert.ok(cliDocumentation.includes(configField), `Missing configuration documentation for ${configField}`);
    }

    assert.match(cliDocumentation, /vanilla-test coverage \[all\|node\|chrome\] \[options\]/);
    assert.match(cliDocumentation, /"executablePath": null/);
    assert.match(cliDocumentation, /CHROME_PATH/);
    for (const script of ['test', 'test:core', 'test:tooling', 'coverage', 'coverage:node', 'coverage:chrome', 'site:status', 'screenshots', 'start']) {
        const aliases = script === 'test'
            ? ['npm test', 'npm run test']
            : script === 'start'
                ? ['npm start', 'npm run start']
                : [`npm run ${script}`];
        assert.ok(aliases.some((alias) => cliDocumentation.includes(alias)), `Missing npm script documentation for ${script}`);
    }

    assert.match(readme, /^# vanilla-test$/m);
    assert.match(readme, /riaevangelist\.github\.io\/vanilla-test/);
    assert.match(readme, /test-results\.json/);
    assert.match(readme, /\.vanilla-test-coverage\.json/);
    assert.match(coverage, /screenshot-gallery/);
    const images = [
        'vanilla-test-chrome-v2.png',
        'vanilla-test-chrome-coverage-v2.png',
        'vanilla-test-node-coverage-v2.png'
    ];
    for (const image of images) {
        assert.ok(readme.includes(image), `README does not link ${image}`);
        assert.ok(coverage.includes(image), `Coverage site does not link ${image}`);
        assert.ok(coverage.includes(`${image}" width="1425"`), `Coverage site is missing the stable width for ${image}`);
        assert.doesNotMatch(coverage, new RegExp(`${image.replaceAll('.', '\\.')}.+?height="`), `Coverage site hard-codes a platform-dependent height for ${image}`);
        const source = await fs.readFile(path.join(projectRoot, 'example', 'img', image));
        assert.equal(source.subarray(1, 4).toString('ascii'), 'PNG');
        assert.equal(source.readUInt32BE(16), 1425);
        assert.ok(source.readUInt32BE(20) > 1000, `${image} is unexpectedly short`);
    }

    assert.match(site, /Native V8|native V8/);
    assert.doesNotMatch(site, /\b(?:c8|Playwright|Monocart|Istanbul)\b/i);
    assert.match(example, /type="importmap"/);
    assert.match(example, /No build step/);
    assert.match(browserVerification, /Chrome console/);
    assert.match(browserVerification, /visible panel mirrors messages/);
    assert.match(browserVerification, /consoleOutput\.append/);
    assert.match(harness, /Check the console or DevTools/);
});
