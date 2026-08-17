import VanillaTest from '../../index.js';
import {
    deeplyFrozenSnapshot,
    equal,
    flushMicrotasks,
    includes,
    throws
} from './assertions.js';

export default Object.freeze({
    name: 'Functional',
    description: 'Public lifecycle behavior from expects through report.',
    tests: Object.freeze([
        {
            name: 'expects returns a numbered descriptor',
            run() {
                const test = new VanillaTest();
                includes(test.expects('a numbered test'), '1) .expects a numbered test');
                test.pass();
                test.done();
            }
        },
        {
            name: 'pass records the active test as passed',
            async run() {
                const test = new VanillaTest();
                const descriptor = test.expects('a passing test');
                equal(test.pass(), descriptor);
                equal(test.done(), descriptor);
                const snapshot = test.report();
                equal(snapshot.passed[0], descriptor);
                equal(snapshot.failureCount, 0);
                await flushMicrotasks();
            }
        },
        {
            name: 'fail records the active test as failed',
            async run() {
                const test = new VanillaTest();
                const descriptor = test.expects('a failing test');
                equal(test.fail(), descriptor);
                equal(test.done(), descriptor);
                const snapshot = test.report();
                equal(snapshot.failed[0], descriptor);
                equal(snapshot.failureCount, 1);
                await flushMicrotasks();
            }
        },
        {
            name: 'pass requires an active test',
            run() {
                throws(() => new VanillaTest().pass(), ReferenceError, 'no active test to pass');
            }
        },
        {
            name: 'fail requires an active test',
            run() {
                throws(() => new VanillaTest().fail(), ReferenceError, 'no active test to fail');
            }
        },
        {
            name: 'done requires an active test',
            run() {
                throws(() => new VanillaTest().done(), ReferenceError, 'no active test to finish');
            }
        },
        {
            name: 'a second test waits for the active test to finish',
            run() {
                const test = new VanillaTest();
                test.expects('the active test guard');
                throws(
                    () => test.expects('a test that starts too early'),
                    ReferenceError,
                    'is not complete'
                );
                test.pass();
                test.done();
            }
        },
        {
            name: 'done converts an undecided test into a failure',
            async run() {
                const test = new VanillaTest();
                const descriptor = test.expects('an undecided test');
                equal(test.done(), descriptor);
                const snapshot = test.report();
                equal(snapshot.failureCount, 1);
                equal(snapshot.failed[0], descriptor);
                equal(snapshot.ok, false);
                await flushMicrotasks();
            }
        },
        {
            name: 'report waits for the active test to finish',
            async run() {
                const test = new VanillaTest();
                test.expects('report waits for done');
                throws(() => test.report(), ReferenceError, 'Call .done() before .report()');
                test.fail();
                test.done();
                equal(test.report().failureCount, 1);
                await flushMicrotasks();
            }
        },
        {
            name: 'an empty suite reports a passing immutable result',
            async run() {
                const snapshot = new VanillaTest().report();
                deeplyFrozenSnapshot(snapshot);
                equal(snapshot.total, 0);
                equal(snapshot.failureCount, 0);
                equal(snapshot.ok, true);
                equal(snapshot.passed.length, 0);
                equal(snapshot.failed.length, 0);
                includes(snapshot.report, 'PASSED');
                await flushMicrotasks();
            }
        }
    ])
});
