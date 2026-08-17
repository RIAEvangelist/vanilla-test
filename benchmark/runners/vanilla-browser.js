import VanillaTest from '../../index.js';
import { caseName, executeCase, updateChecksum } from '../workload.js';

export async function runBrowserBenchmark({ cases, batchSize }) {
    const originalLog = console.log;
    let checksum = 2_166_136_261;
    let executed = 0;
    let reportBytes = 0;
    let lifecycleMs = 0;
    let reportMs = 0;
    let peakHeapUsedBytes = 0;
    const sampleMemory = () => {
        peakHeapUsedBytes = Math.max(peakHeapUsedBytes, performance.memory?.usedJSHeapSize ?? 0);
    };
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
            sampleMemory();
            const reportStarted = performance.now();
            const result = test.report();
            reportMs += performance.now() - reportStarted;
            reportBytes += new TextEncoder().encode(result.report).byteLength;
            if (!result.ok || result.total !== end - offset || result.failureCount !== 0) {
                throw new Error(`vanilla-test reported an invalid suite at offset ${offset}.`);
            }
            sampleMemory();
        }
    } finally {
        console.log = originalLog;
    }
    return {
        runner: 'vanilla-test', cases, suites: Math.ceil(cases / batchSize), executed,
        passed: executed, failureCount: 0, checksum, reportBytes,
        runnerMs: performance.now() - started,
        phasesMs: { registration: 0, execution: lifecycleMs, reporting: reportMs },
        memory: { peakHeapUsedBytes, method: 'performance.memory sampled after every suite phase' }
    };
}
