import { performance } from 'node:perf_hooks';

import Mocha from 'mocha';

import { caseName, executeCase, updateChecksum } from '../workload.js';
import { memoryTracker, readOptions, writeMetrics } from './node-support.js';

export default async function run() {
    const { cases, batchSize, metricsPath } = readOptions();
    const memory = memoryTracker();
    let checksum = 2_166_136_261;
    let executed = 0;
    let failureCount = 0;
    let reportBytes = 0;
    let registrationMs = 0;
    let executionMs = 0;
    const started = performance.now();

    for (let offset = 0; offset < cases; offset += batchSize) {
        const end = Math.min(offset + batchSize, cases);
        const reports = { passed: [], failed: [] };
        class DetailedSinkReporter {
            constructor(runner) {
                runner.on('pass', (entry) => reports.passed.push(entry.fullTitle()));
                runner.on('fail', (entry) => reports.failed.push(entry.fullTitle()));
                runner.once('end', () => { reportBytes += Buffer.byteLength(JSON.stringify(reports)); });
            }
        }
        const mocha = new Mocha({ reporter: DetailedSinkReporter, color: false });
        const registrationStarted = performance.now();
        for (let index = offset; index < end; index += 1) {
            mocha.suite.addTest(new Mocha.Test(caseName(index), () => {
                checksum = updateChecksum(checksum, executeCase(index));
                executed += 1;
            }));
        }
        registrationMs += performance.now() - registrationStarted;
        memory.sample();
        const executionStarted = performance.now();
        failureCount += await new Promise((resolve) => mocha.run(resolve));
        executionMs += performance.now() - executionStarted;
        memory.sample();
    }

    const runnerMs = performance.now() - started;
    const suites = Math.ceil(cases / batchSize);
    const metrics = {
        runner: 'mocha', cases, suites, executed, passed: executed - failureCount,
        failureCount, checksum, reportBytes, runnerMs,
        phasesMs: { registration: registrationMs, execution: executionMs, reporting: 0 },
        memory: memory.value()
    };
    await writeMetrics(metricsPath, metrics);
    return { ok: failureCount === 0, failureCount, total: cases };
}
