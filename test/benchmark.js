import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArguments, summarizeSamples, validateWorkerResult } from '../benchmark/run.js';
import { caseName, executeCase, expectedChecksum, updateChecksum } from '../benchmark/workload.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('benchmark arguments preserve the million-case bounded-suite protocol', () => {
    const defaults = parseArguments([]);
    assert.equal(defaults.cases, 1_000_000);
    assert.equal(defaults.batchSize, 1_000);
    assert.equal(defaults.samples, 5);
    assert.equal(defaults.warmups, 1);
    assert.equal(defaults.runtime, 'all');

    assert.deepEqual(
        parseArguments(['--runtime', 'node', '--cases', '101', '--batch-size', '17', '--samples', '3', '--warmups', '0']).runtime,
        'node'
    );
    assert.throws(() => parseArguments(['--runtime', 'deno']), /all, node, or browser/);
    assert.throws(() => parseArguments(['--cases', '10', '--batch-size', '11']), /cannot exceed/);
    assert.throws(() => parseArguments(['--samples', '0']), /at least 1/);
    assert.throws(() => parseArguments(['--unknown']), /Unknown benchmark option/);
});

test('benchmark workload names and checksum prove every case exactly once', () => {
    const names = new Set();
    let checksum = 2_166_136_261;
    for (let index = 0; index < 1_001; index += 1) {
        names.add(caseName(index));
        checksum = updateChecksum(checksum, executeCase(index));
    }
    assert.equal(names.size, 1_001);
    assert.equal(checksum, expectedChecksum(1_001));
    assert.notEqual(checksum, expectedChecksum(1_000));
});

test('benchmark statistics retain all samples and deterministic uncertainty', () => {
    const first = summarizeSamples([12, 8, 10, 14, 11], 1_000_000, 42);
    const second = summarizeSamples([12, 8, 10, 14, 11], 1_000_000, 42);
    assert.deepEqual(first, second);
    assert.equal(first.count, 5);
    assert.equal(first.minimumMs, 8);
    assert.equal(first.medianMs, 11);
    assert.equal(first.maximumMs, 14);
    assert.equal(first.medianCasesPerSecond, 1_000_000 / 0.011);
    assert.throws(() => summarizeSamples([], 10), /nonempty array/);
    assert.throws(() => summarizeSamples([1, Number.NaN], 10), /positive finite/);
});

test('benchmark worker result validation rejects missing cases, checksums, timing, and reports', () => {
    const record = {
        lane: 'node', runner: 'vanilla-test', valid: true,
        counts: { cases: 101, suites: 1, executed: 101, passed: 101, failed: 0 },
        checksum: 42, expectedChecksum: 42, runnerMs: 1, pipelineMs: 2,
        reports: ['test-results.json', 'coverage-summary.json', 'lcov.info', 'index.html'].map((file) => ({ file }))
    };
    assert.equal(validateWorkerResult(record, { lane: 'node', runner: 'vanilla-test', cases: 101, batchSize: 101 }), record);
    assert.throws(
        () => validateWorkerResult({ ...record, counts: { ...record.counts, executed: 100 } }, { lane: 'node', runner: 'vanilla-test', cases: 101, batchSize: 101 }),
        /inconsistent execution counts/
    );
    assert.throws(
        () => validateWorkerResult({ ...record, expectedChecksum: 41 }, { lane: 'node', runner: 'vanilla-test', cases: 101, batchSize: 101 }),
        /invalid checksum/
    );
    assert.throws(
        () => validateWorkerResult({ ...record, reports: record.reports.slice(1) }, { lane: 'node', runner: 'vanilla-test', cases: 101, batchSize: 101 }),
        /missing generated report/
    );
});

test('benchmark dependencies are pinned privately and the published package remains unchanged', async () => {
    const [rootPackage, benchmarkPackage, protocol, readme, browserWorker, nodeWorker] = await Promise.all([
        fs.readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
        fs.readFile(path.join(projectRoot, 'benchmark', 'package.json'), 'utf8').then(JSON.parse),
        fs.readFile(path.join(projectRoot, 'benchmark', 'protocol.json'), 'utf8').then(JSON.parse),
        fs.readFile(path.join(projectRoot, 'benchmark', 'README.md'), 'utf8'),
        fs.readFile(path.join(projectRoot, 'benchmark', 'browser-worker.js'), 'utf8'),
        fs.readFile(path.join(projectRoot, 'benchmark', 'node-worker.js'), 'utf8')
    ]);
    assert.equal(benchmarkPackage.private, true);
    assert.equal(benchmarkPackage.devDependencies.mocha, '11.8.0');
    assert.equal(benchmarkPackage.overrides.diff, '8.0.3');
    assert.equal(benchmarkPackage.overrides['serialize-javascript'], '7.0.5');
    assert.equal(rootPackage.dependencies.mocha, undefined);
    assert.equal(rootPackage.devDependencies, undefined);
    assert.doesNotMatch(rootPackage.files.join('\n'), /benchmark/);
    assert.equal(protocol.caseCount, 1_000_000);
    assert.equal(protocol.batchSize, 1_000);
    assert.equal(protocol.nodeHeapCapMiB, 16_384);
    assert.deepEqual(protocol.reportFormats, ['test-results.json', 'coverage-summary.json', 'lcov.info', 'index.html']);
    assert.match(readme, /1,000 bounded suites of 1,000/);
    assert.match(readme, /deliberately omits hostname, username/);
    assert.match(browserWorker, /Profiler\.startPreciseCoverage/);
    assert.match(browserWorker, /writeNativeCoverageReport/);
    assert.match(nodeWorker, /runNodeCoverage/);
});
