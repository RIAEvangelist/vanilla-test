import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { runNodeCoverage } from '../lib/coverage/node.js';
import { expectedChecksum } from './workload.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerEntries = Object.freeze({
    'vanilla-test': path.join(projectRoot, 'benchmark', 'runners', 'vanilla-node.js'),
    'node-test': path.join(projectRoot, 'benchmark', 'runners', 'node-test.js'),
    mocha: path.join(projectRoot, 'benchmark', 'runners', 'mocha-node.js')
});

function positiveInteger(value, label) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) throw new RangeError(`${label} must be a positive safe integer.`);
    return number;
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
    const entry = runnerEntries[runner];
    if (!entry) throw new TypeError(`Unknown Node benchmark runner ${JSON.stringify(runner)}.`);
    const cases = positiveInteger(caseText, 'cases');
    const batchSize = positiveInteger(batchText, 'batchSize');
    const timeoutMs = positiveInteger(timeoutText, 'timeoutMs');
    if (batchSize > cases) throw new RangeError('batchSize cannot exceed cases.');
    const runDirectory = path.resolve(runDirectoryText);
    const metricsPath = path.join(runDirectory, 'runner-metrics.json');
    await fs.mkdir(runDirectory, { recursive: true });
    process.env.VANILLA_TEST_BENCHMARK_CASES = String(cases);
    process.env.VANILLA_TEST_BENCHMARK_BATCH_SIZE = String(batchSize);
    process.env.VANILLA_TEST_BENCHMARK_METRICS = metricsPath;

    const started = performance.now();
    const code = await runNodeCoverage({
        root: projectRoot,
        entry,
        reportsDirectory: runDirectory,
        thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 },
        timeoutMs,
        node: { include: ['benchmark/workload.js'] }
    });
    const pipelineMs = performance.now() - started;
    if (code !== 0) throw new Error(`${runner} Node coverage pipeline exited with status ${code}.`);

    const metrics = JSON.parse(await fs.readFile(metricsPath, 'utf8'));
    const expected = expectedChecksum(cases);
    const valid = metrics.cases === cases
        && metrics.suites === Math.ceil(cases / batchSize)
        && metrics.executed === cases
        && metrics.passed === cases
        && metrics.failureCount === 0
        && metrics.checksum === expected;
    if (!valid) throw new Error(`${runner} returned invalid counts or checksum.`);

    const outputDirectory = path.join(runDirectory, 'node');
    const reportNames = ['test-results.json', 'coverage-summary.json', 'lcov.info', 'index.html'];
    const reports = await Promise.all(reportNames.map((name) => fileRecord(path.join(outputDirectory, name), outputDirectory)));
    const coverage = JSON.parse(await fs.readFile(path.join(outputDirectory, 'coverage-summary.json'), 'utf8'));
    return {
        schemaVersion: 1,
        lane: 'node',
        runner,
        valid,
        counts: { cases, suites: metrics.suites, executed: metrics.executed, passed: metrics.passed, failed: 0 },
        checksum: metrics.checksum,
        expectedChecksum: expected,
        runnerMs: metrics.runnerMs,
        pipelineMs,
        phasesMs: metrics.phasesMs,
        reportBytes: metrics.reportBytes,
        memory: metrics.memory,
        coverage: coverage.total,
        reports
    };
}

try {
    process.stdout.write(`${JSON.stringify(await main())}\n`);
} catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
}
