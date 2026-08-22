import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const [modulePath, rawCaseCount] = process.argv.slice(2);
const caseCount = Number(rawCaseCount);

if (!modulePath || !Number.isSafeInteger(caseCount) || caseCount < 1) {
    throw new TypeError('Usage: node benchmark/scale-worker.js <runner-module> <positive-case-count>');
}

const { default: VanillaTest } = await import(pathToFileURL(path.resolve(modulePath)).href);
const originalLog = console.log;
console.log = () => {};

try {
    const started = performance.now();
    const test = new VanillaTest();

    for (let index = 0; index < caseCount; index += 1) {
        test.expects(`core scaling case ${index}`);
        test.pass();
        test.done();
    }

    const lifecycleMs = performance.now() - started;
    const result = test.report();
    if (!result.ok || result.total !== caseCount || result.failureCount !== 0
        || result.passed.length !== caseCount || result.failed.length !== 0) {
        throw new Error(`Runner returned invalid counts for ${caseCount} cases.`);
    }

    process.stdout.write(`${JSON.stringify({ caseCount, lifecycleMs, valid: true })}\n`);
} finally {
    console.log = originalLog;
}
