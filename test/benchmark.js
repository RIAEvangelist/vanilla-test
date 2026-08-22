import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCharts } from '../benchmark/charts.js';
import { parseArguments, summarizeSamples, validateWorkerResult } from '../benchmark/run.js';
import { parseScaleArguments } from '../benchmark/scale.js';
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

test('scaling benchmark arguments preserve the monolithic-suite sweep', () => {
    const defaults = parseScaleArguments([]);
    assert.deepEqual(defaults.sizes, [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000]);
    assert.equal(defaults.samples, 5);
    assert.equal(defaults.warmups, 1);
    assert.throws(() => parseScaleArguments(['--sizes', '100,100']), /unique positive integers/);
    assert.throws(() => parseScaleArguments(['--sizes', '0,100']), /unique positive integers/);
    assert.throws(() => parseScaleArguments(['--samples', '0']), /at least 1/);
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

test('published benchmark data contains only verified million-case native pipeline samples', async () => {
    const source = await fs.readFile(path.join(projectRoot, 'data', 'benchmarks.json'), 'utf8');
    const result = JSON.parse(source);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.publishable, true);
    assert.match(result.source.commit, /^[0-9a-f]{40}$/);
    assert.equal(result.source.dirty, false);
    assert.equal(result.protocol.caseCount, 1_000_000);
    assert.equal(result.protocol.batchSize, 1_000);
    assert.equal(result.protocol.measuredSamples, 5);
    assert.deepEqual(result.lanes.node.entries.map(({ id }) => id), ['vanilla-test', 'node-test', 'mocha']);
    assert.deepEqual(result.lanes.browser.entries.map(({ id }) => id), ['vanilla-test', 'mocha']);

    for (const [lane, { entries }] of Object.entries(result.lanes)) {
        for (const entry of entries) {
            assert.equal(entry.summary.verifiedSamples, 5, `${lane}/${entry.id} has missing verified samples.`);
            assert.equal(entry.samples.length, 5);
            for (const sample of entry.samples) {
                assert.equal(sample.valid, true);
                assert.deepEqual(sample.counts, {
                    cases: 1_000_000, suites: 1_000, executed: 1_000_000, passed: 1_000_000, failed: 0
                });
                assert.equal(sample.checksum, sample.expectedChecksum);
                assert.deepEqual(sample.reports.map(({ file }) => file), [
                    'test-results.json', 'coverage-summary.json', 'lcov.info', 'index.html'
                ]);
                assert.ok(sample.reports.every(({ bytes, sha256 }) => bytes > 0 && /^[0-9a-f]{64}$/.test(sha256)));
            }
        }
    }

    assert.equal(Object.hasOwn(result.machine, 'hostname'), false);
    assert.doesNotMatch(source, /(?:[A-Z]:\\Users\\|\/home\/)[^"\\/]+/i);
});

test('published scaling data compares exact 2.1.1 and candidate sources with verified samples', async () => {
    const source = await fs.readFile(path.join(projectRoot, 'data', 'scaling.json'), 'utf8');
    const result = JSON.parse(source);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.publishable, true);
    assert.equal(result.source.baseline.tag, '2.1.1');
    assert.match(result.source.baseline.commit, /^[0-9a-f]{40}$/);
    assert.match(result.source.baseline.indexSha256, /^[0-9a-f]{64}$/);
    assert.equal(result.source.candidate.packageVersion, '2.1.2');
    assert.match(result.source.candidate.commit, /^[0-9a-f]{40}$/);
    assert.match(result.source.candidate.indexSha256, /^[0-9a-f]{64}$/);
    assert.equal(result.source.candidate.dirty, false);
    assert.deepEqual(result.protocol.sizes, [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000]);
    assert.equal(result.protocol.measuredSamples, 5);
    assert.deepEqual(result.series.map(({ id }) => id), ['baseline', 'candidate']);

    for (const series of result.series) {
        assert.equal(series.points.length, result.protocol.sizes.length);
        for (const point of series.points) {
            assert.equal(point.samples.length, result.protocol.measuredSamples);
            assert.equal(point.summary.count, result.protocol.measuredSamples);
            assert.ok(point.samples.every((sample) => sample.valid && sample.caseCount === point.caseCount));
        }
    }
    assert.doesNotMatch(source, /(?:[A-Z]:\\Users\\|\/home\/)[^"\\/]+/i);
});

test('published benchmark SVGs are deterministic, accessible, and current', async () => {
    const charts = await buildCharts();
    for (const [name, file] of Object.entries({
        scaling: 'benchmark-core-scaling.svg',
        pipelines: 'benchmark-native-pipelines.svg'
    })) {
        const source = await fs.readFile(path.join(projectRoot, 'assets', file), 'utf8');
        assert.equal(source, charts[name]);
        assert.match(source, /<title>[^<]+<\/title>/);
        assert.match(source, /<desc>[^<]+<\/desc>/);
        assert.match(source, /role="img"/);
    }
});

test('core lifecycle uses active decision state instead of scanning result history', async () => {
    const source = await fs.readFile(path.join(projectRoot, 'index.js'), 'utf8');
    assert.match(source, /#decision/);
    assert.doesNotMatch(source, /#(?:passed|failed)\.includes\(/);
});
