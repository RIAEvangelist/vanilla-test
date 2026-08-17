import { caseName, executeCase, updateChecksum } from '../workload.js';

export async function runBrowserBenchmark({ cases, batchSize }) {
    const Mocha = globalThis.Mocha;
    if (typeof Mocha !== 'function') throw new Error('The pinned Mocha browser bundle did not load.');
    let checksum = 2_166_136_261;
    let executed = 0;
    let failureCount = 0;
    let reportBytes = 0;
    let registrationMs = 0;
    let executionMs = 0;
    let peakHeapUsedBytes = 0;
    const encoder = new TextEncoder();
    const sampleMemory = () => {
        peakHeapUsedBytes = Math.max(peakHeapUsedBytes, performance.memory?.usedJSHeapSize ?? 0);
    };
    const started = performance.now();

    for (let offset = 0; offset < cases; offset += batchSize) {
        const end = Math.min(offset + batchSize, cases);
        const reports = { passed: [], failed: [] };
        class DetailedSinkReporter {
            constructor(runner) {
                runner.on('pass', (entry) => reports.passed.push(entry.fullTitle()));
                runner.on('fail', (entry) => reports.failed.push(entry.fullTitle()));
                runner.once('end', () => { reportBytes += encoder.encode(JSON.stringify(reports)).byteLength; });
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
        sampleMemory();
        const executionStarted = performance.now();
        failureCount += await new Promise((resolve) => mocha.run(resolve));
        executionMs += performance.now() - executionStarted;
        sampleMemory();
    }

    return {
        runner: 'mocha', cases, suites: Math.ceil(cases / batchSize), executed,
        passed: executed - failureCount, failureCount, checksum, reportBytes,
        runnerMs: performance.now() - started,
        phasesMs: { registration: registrationMs, execution: executionMs, reporting: 0 },
        memory: { peakHeapUsedBytes, method: 'performance.memory sampled after every suite phase' }
    };
}
