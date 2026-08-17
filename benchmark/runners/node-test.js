import { performance } from 'node:perf_hooks';
import { suite, test } from 'node:test';

import { caseName, executeCase, updateChecksum } from '../workload.js';
import { memoryTracker, readOptions, writeMetrics } from './node-support.js';

export default async function run() {
    const { cases, batchSize, metricsPath } = readOptions();
    const memory = memoryTracker();
    const originalWrite = process.stdout.write.bind(process.stdout);
    let checksum = 2_166_136_261;
    let executed = 0;
    let reportBytes = 0;
    const started = performance.now();

    process.stdout.write = (chunk, ..._arguments) => {
        reportBytes += Buffer.byteLength(typeof chunk === 'string' ? chunk : chunk);
        return true;
    };

    for (let offset = 0; offset < cases; offset += batchSize) {
        const end = Math.min(offset + batchSize, cases);
        await suite(`suite ${offset / batchSize + 1}`, async () => {
            for (let index = offset; index < end; index += 1) {
                await test(caseName(index), () => {
                    checksum = updateChecksum(checksum, executeCase(index));
                    executed += 1;
                });
            }
        });
        memory.sample();
    }

    const runnerMs = performance.now() - started;
    const suites = Math.ceil(cases / batchSize);
    const metrics = {
        runner: 'node-test', cases, suites, executed, passed: executed,
        failureCount: 0, checksum, reportBytes, runnerMs,
        phasesMs: { registration: 0, execution: runnerMs, reporting: 0 },
        memory: memory.value()
    };
    await writeMetrics(metricsPath, metrics);
    // Keep the sink installed through process exit so Node's trailing summary cannot contaminate IPC stdout.
    void originalWrite;
    return { ok: true, failureCount: 0, total: cases };
}
