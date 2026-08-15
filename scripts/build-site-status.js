#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const executeFile = promisify(execFile);
const METRICS = Object.freeze(['statements', 'branches', 'functions', 'lines']);

function requireObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object.`);
    }
    return value;
}

function requireCount(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${label} must be a nonnegative safe integer.`);
    }
    return value;
}

function requireBoolean(value, label) {
    if (typeof value !== 'boolean') {
        throw new TypeError(`${label} must be a boolean.`);
    }
    return value;
}

function stringArray(value, label) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new TypeError(`${label} must be an array of strings.`);
    }
    return [...value];
}

async function readJson(filePath, label) {
    let source;
    try {
        source = await fs.readFile(filePath, 'utf8');
    } catch (error) {
        throw new Error(`Unable to read ${label}: ${filePath}`, { cause: error });
    }

    try {
        return JSON.parse(source);
    } catch (error) {
        throw new SyntaxError(`Invalid JSON in ${label}: ${filePath}`, { cause: error });
    }
}

function normalizeSharedTests(value, expectedRuntime) {
    const source = requireObject(value, `${expectedRuntime} test results`);
    if (source.runtime !== expectedRuntime) {
        throw new TypeError(`${expectedRuntime} test results must declare runtime ${JSON.stringify(expectedRuntime)}.`);
    }

    const total = requireCount(source.total, `${expectedRuntime} test results total`);
    const passedCount = requireCount(source.passedCount, `${expectedRuntime} test results passedCount`);
    const failureCount = requireCount(source.failureCount, `${expectedRuntime} test results failureCount`);
    const ok = requireBoolean(source.ok, `${expectedRuntime} test results ok`);

    if (passedCount + failureCount !== total || ok !== (failureCount === 0)) {
        throw new TypeError(`${expectedRuntime} test result counts and status are inconsistent.`);
    }

    return {
        runtime: expectedRuntime,
        ok,
        total,
        passedCount,
        failureCount,
        passed: stringArray(source.passed, `${expectedRuntime} test results passed`),
        failed: stringArray(source.failed, `${expectedRuntime} test results failed`)
    };
}

function normalizeThresholds(value) {
    const source = requireObject(value, 'coverage thresholds');
    const result = {};
    for (const metric of METRICS) {
        const threshold = source[metric];
        if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
            throw new TypeError(`coverage threshold ${metric} must be a number from 0 through 100.`);
        }
        result[metric] = threshold;
    }
    return result;
}

function normalizeCoverage(value, thresholds, runtime) {
    const source = requireObject(value, `${runtime} coverage summary`);
    const total = requireObject(source.total, `${runtime} coverage summary total`);
    const metrics = {};

    for (const metric of METRICS) {
        const input = requireObject(total[metric], `${runtime} coverage ${metric}`);
        const covered = requireCount(input.covered, `${runtime} coverage ${metric}.covered`);
        const count = requireCount(input.total, `${runtime} coverage ${metric}.total`);
        const pct = input.pct;
        if (covered > count || typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
            throw new TypeError(`${runtime} coverage ${metric} contains invalid totals or percentage.`);
        }
        metrics[metric] = { covered, total: count, pct };
    }

    const minimumPct = Math.min(...METRICS.map((metric) => metrics[metric].pct));
    const ok = METRICS.every((metric) => metrics[metric].pct >= thresholds[metric]);
    return { runtime, ok, minimumPct, metrics };
}

function normalizeToolingResult(value) {
    const source = requireObject(value, 'tooling test result');
    const total = requireCount(source.total, 'tooling test result total');
    const passedCount = requireCount(source.passedCount, 'tooling test result passedCount');
    const failureCount = requireCount(source.failureCount, 'tooling test result failureCount');
    const skippedCount = requireCount(source.skippedCount ?? 0, 'tooling test result skippedCount');
    const cancelledCount = requireCount(source.cancelledCount ?? 0, 'tooling test result cancelledCount');
    const ok = requireBoolean(source.ok, 'tooling test result ok');

    if (passedCount + failureCount + skippedCount + cancelledCount > total
        || ok !== (failureCount === 0 && cancelledCount === 0)) {
        throw new TypeError('tooling test result counts and status are inconsistent.');
    }

    return {
        runtime: 'node',
        suite: 'tooling',
        ok,
        total,
        passedCount,
        failureCount,
        skippedCount,
        cancelledCount
    };
}

function tapCount(source, name) {
    const matches = [...source.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
    if (matches.length !== 1) {
        throw new TypeError(`TAP output must contain exactly one ${name} summary.`);
    }
    return Number(matches[0][1]);
}

function parseTapSummary(source, exitCode = 0) {
    if (typeof source !== 'string' || !source.includes('TAP version')) {
        throw new TypeError('tooling test output must be TAP.');
    }

    const total = tapCount(source, 'tests');
    const passedCount = tapCount(source, 'pass');
    const failureCount = tapCount(source, 'fail');
    const optional = (name) => {
        const match = source.match(new RegExp(`^# ${name} (\\d+)\\s*$`, 'm'));
        return match ? Number(match[1]) : 0;
    };
    const skippedCount = optional('skipped') + optional('todo');
    const cancelledCount = optional('cancelled');

    return normalizeToolingResult({
        ok: exitCode === 0 && failureCount === 0 && cancelledCount === 0,
        total,
        passedCount,
        failureCount,
        skippedCount,
        cancelledCount
    });
}

async function runToolingTests(root) {
    const testPaths = [
        'tooling.js',
        'output.js',
        'server-security.js',
        'status-builder.js'
    ].map((name) => path.join(root, 'test', name));
    let stdout;
    let stderr = '';
    let exitCode = 0;

    try {
        ({ stdout, stderr } = await executeFile(
            process.execPath,
            ['--test', '--test-reporter=tap', ...testPaths],
            { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, windowsHide: true }
        ));
    } catch (error) {
        if (!Number.isSafeInteger(error?.code)) throw error;
        stdout = error.stdout ?? '';
        stderr = error.stderr ?? '';
        exitCode = error.code;
    }

    try {
        return parseTapSummary(stdout, exitCode);
    } catch (error) {
        if (stderr) error.message += `\nTooling stderr:\n${stderr}`;
        throw error;
    }
}

function badgeColor(percent) {
    if (percent >= 100) return 'brightgreen';
    if (percent >= 90) return 'green';
    if (percent >= 80) return 'yellowgreen';
    if (percent >= 70) return 'yellow';
    if (percent >= 60) return 'orange';
    return 'red';
}

function coverageBadge(runtime, coverage) {
    return {
        schemaVersion: 1,
        label: `shared core · ${runtime} coverage`,
        message: `${coverage.minimumPct}% minimum`,
        color: coverage.ok ? badgeColor(coverage.minimumPct) : 'red'
    };
}

function testBadge(runtime, result, scope = 'shared core') {
    return {
        schemaVersion: 1,
        label: `${scope} · ${runtime} tests`,
        message: `${result.passedCount}/${result.total} passed`,
        color: result.ok ? 'brightgreen' : 'red'
    };
}

async function writeJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function packageSmokeResult(value) {
    if (value === 'passed') return { evaluated: true, ok: true, label: 'passed' };
    if (value === 'failed') return { evaluated: true, ok: false, label: 'failed' };
    if (value === undefined || value === 'not-run') return { evaluated: false, ok: null, label: 'not evaluated' };
    throw new TypeError('package smoke status must be passed, failed, or not-run.');
}

function commitInfo(environment) {
    const sha = environment.GITHUB_SHA || null;
    const repository = environment.GITHUB_REPOSITORY || null;
    const server = environment.GITHUB_SERVER_URL || 'https://github.com';
    return {
        sha,
        short: sha ? sha.slice(0, 7) : null,
        url: sha && repository ? `${server}/${repository}/commit/${sha}` : null
    };
}

async function coverageRuntimes(root) {
    const runtimePath = path.join(root, 'coverage', 'runtime.json');
    try {
        const value = requireObject(await readJson(runtimePath, 'coverage runtime metadata'), 'coverage runtime metadata');
        return {
            node: typeof value.node === 'string' ? value.node : process.version,
            chrome: typeof value.chrome === 'string' ? value.chrome : null
        };
    } catch (error) {
        if (error?.cause?.code !== 'ENOENT') throw error;
        return { node: process.version, chrome: null };
    }
}

async function buildSiteStatus(options = {}) {
    const root = path.resolve(options.root ?? process.cwd());
    const packageManifest = requireObject(
        await readJson(path.join(root, 'package.json'), 'package manifest'),
        'package manifest'
    );
    const config = requireObject(
        await readJson(path.join(root, 'vanilla-test.config.json'), 'vanilla-test configuration'),
        'vanilla-test configuration'
    );
    const thresholds = normalizeThresholds(config.thresholds);

    const nodeTests = normalizeSharedTests(
        await readJson(path.join(root, 'coverage', 'node', 'test-results.json'), 'Node test results'),
        'node'
    );
    const chromeTests = normalizeSharedTests(
        await readJson(path.join(root, 'coverage', 'chrome', 'test-results.json'), 'Chrome test results'),
        'chrome'
    );
    const nodeCoverage = normalizeCoverage(
        await readJson(path.join(root, 'coverage', 'node', 'coverage-summary.json'), 'Node coverage summary'),
        thresholds,
        'node'
    );
    const chromeCoverage = normalizeCoverage(
        await readJson(path.join(root, 'coverage', 'chrome', 'coverage-summary.json'), 'Chrome coverage summary'),
        thresholds,
        'chrome'
    );

    const tooling = options.toolingResultPath
        ? normalizeToolingResult(await readJson(path.resolve(root, options.toolingResultPath), 'tooling test result'))
        : await runToolingTests(root);
    const packageSmoke = packageSmokeResult(options.packageSmoke);
    const runtimes = await coverageRuntimes(root);
    const requiredChecks = [nodeTests.ok, chromeTests.ok, tooling.ok, nodeCoverage.ok, chromeCoverage.ok];
    if (packageSmoke.evaluated) requiredChecks.push(packageSmoke.ok);
    const ok = requiredChecks.every(Boolean);

    const status = {
        schemaVersion: 1,
        generatedAt: (options.now ?? new Date()).toISOString(),
        commit: commitInfo(options.environment ?? process.env),
        package: {
            name: packageManifest.name,
            version: packageManifest.version
        },
        runtimes,
        status: {
            ok,
            label: ok ? 'passing' : 'failing'
        },
        tests: {
            scope: 'shared-core',
            shared: {
                node: nodeTests,
                chrome: chromeTests
            },
            tooling,
            packageSmoke
        },
        coverage: {
            scope: 'shared-core',
            thresholds,
            node: nodeCoverage,
            chrome: chromeCoverage
        }
    };

    const badges = {
        'node-coverage.json': coverageBadge('node', nodeCoverage),
        'chrome-coverage.json': coverageBadge('chrome', chromeCoverage),
        'node-tests.json': testBadge('node', nodeTests),
        'chrome-tests.json': testBadge('chrome', chromeTests),
        'tooling-tests.json': testBadge('node', tooling, 'tooling'),
        'quality.json': {
            schemaVersion: 1,
            label: 'vanilla-test quality',
            message: status.status.label,
            color: ok ? 'brightgreen' : 'red'
        }
    };

    await writeJson(path.join(root, 'data', 'status.json'), status);
    await Promise.all(Object.entries(badges).map(([name, value]) => (
        writeJson(path.join(root, 'badges', name), value)
    )));

    return { status, badges };
}

function parseArguments(args) {
    const options = {};
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (argument === '--root' || argument === '--tooling-result' || argument === '--package-smoke') {
            const value = args[++index];
            if (!value) throw new TypeError(`${argument} requires a value.`);
            if (argument === '--root') options.root = value;
            if (argument === '--tooling-result') options.toolingResultPath = value;
            if (argument === '--package-smoke') options.packageSmoke = value;
            continue;
        }
        if (argument === '--run-tooling') continue;
        if (argument === '--help') return { help: true };
        throw new TypeError(`Unknown option: ${argument}`);
    }
    return options;
}

const HELP = `Build vanilla-test site quality artifacts.

Usage: node scripts/build-site-status.js [options]

Options:
  --root <path>              Project root (default: current directory)
  --run-tooling              Run the Node-only tooling suites and parse TAP (default)
  --tooling-result <path>    Read a normalized tooling result JSON artifact instead
  --package-smoke <status>   passed, failed, or not-run
  --help                     Show this help
`;

async function main(args = process.argv.slice(2)) {
    try {
        const options = parseArguments(args);
        if (options.help) {
            process.stdout.write(HELP);
            return 0;
        }
        const { status } = await buildSiteStatus(options);
        process.stdout.write(`Generated shared-core status: ${status.status.label}\n`);
        return status.status.ok ? 0 : 1;
    } catch (error) {
        console.error(`build-site-status: ${error?.stack || error}`);
        return 2;
    }
}

const isMain = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exitCode = await main();

export {
    buildSiteStatus,
    main,
    normalizeCoverage,
    normalizeSharedTests,
    normalizeToolingResult,
    parseArguments,
    parseTapSummary,
    runToolingTests
};
