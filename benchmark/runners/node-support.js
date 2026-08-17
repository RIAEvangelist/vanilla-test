import fs from 'node:fs/promises';

export function readOptions() {
    const cases = Number(process.env.VANILLA_TEST_BENCHMARK_CASES);
    const batchSize = Number(process.env.VANILLA_TEST_BENCHMARK_BATCH_SIZE);
    const metricsPath = process.env.VANILLA_TEST_BENCHMARK_METRICS;
    if (!Number.isSafeInteger(cases) || cases < 1) throw new RangeError('Benchmark cases must be a positive safe integer.');
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > cases) {
        throw new RangeError('Benchmark batch size must be a positive safe integer no larger than cases.');
    }
    if (!metricsPath) throw new TypeError('Benchmark metrics path is required.');
    return { cases, batchSize, metricsPath };
}

export function memoryTracker() {
    let peakRssBytes = 0;
    let peakHeapUsedBytes = 0;
    return {
        sample() {
            const memory = process.memoryUsage();
            peakRssBytes = Math.max(peakRssBytes, memory.rss);
            peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
        },
        value() {
            return { peakRssBytes, peakHeapUsedBytes, method: 'sampled after every suite phase' };
        }
    };
}

export async function writeMetrics(metricsPath, metrics) {
    await fs.writeFile(metricsPath, `${JSON.stringify(metrics)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}
