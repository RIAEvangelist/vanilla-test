import { performance } from 'node:perf_hooks';

import VanillaTest from '../../index.js';
import { caseName, executeCase, updateChecksum } from '../workload.js';
import { memoryTracker, readOptions, writeMetrics } from './node-support.js';

export default async function run() {
    const { cases, batchSize, metricsPath } = readOptions();
    const memory = memoryTracker();
    const originalLog = console.log;
    let checksum = 2_166_136_261;
    let executed = 0;
    let reportBytes = 0;
    let lifecycleMs = 0;
    let reportMs = 0;
    const started = performance.now();

    console.log = () => {};
    try {
        for (let offset = 0; offset < cases; offset += batchSize) {
            const test = new VanillaTest();
            const end = Math.min(offset + batchSize, cases);
            const lifecycleStarted = performance.now();
            for (let index = offset; index < end; index += 1) {
                test.expects(caseName(index));
                checksum = updateChecksum(checksum, executeCase(index));
                executed += 1;
                test.pass();
                test.done();
            }
            lifecycleMs += performance.now() - lifecycleStarted;
            memory.sample();
            const reportStarted = performance.now();
            const result = test.report();
            reportMs += performance.now() - reportStarted;
            reportBytes += Buffer.byteLength(result.report);
            if (!result.ok || result.total !== end - offset || result.failureCount !== 0) {
                throw new Error(`vanilla-test reported an invalid suite at offset ${offset}.`);
            }
            memory.sample();
        }
    } finally {
        console.log = originalLog;
    }

    const runnerMs = performance.now() - started;
    const suites = Math.ceil(cases / batchSize);
    const metrics = {
        runner: 'vanilla-test', cases, suites, executed, passed: executed,
        failureCount: 0, checksum, reportBytes, runnerMs,
        phasesMs: { registration: 0, execution: lifecycleMs, reporting: reportMs },
        memory: memory.value()
    };
    await writeMetrics(metricsPath, metrics);
    return { ok: true, failureCount: 0, total: cases };
}
