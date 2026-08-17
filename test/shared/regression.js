import VanillaTest from '../../index.js';
import { equal, flushMicrotasks, includes, throws } from './assertions.js';

export default Object.freeze({
    name: 'Regression',
    description: 'State-integrity and idempotence cases that protect earlier fixes.',
    tests: Object.freeze([
        {
            name: 'duplicate descriptions do not corrupt later numbering',
            run() {
                const test = new VanillaTest();
                test.expects('a unique raw description');
                test.pass();
                test.done();
                throws(
                    () => test.expects('a unique raw description'),
                    ReferenceError,
                    'descriptions to be unique'
                );
                const second = test.expects('a different raw description');
                includes(second, '2) .expects a different raw description');
                test.pass();
                test.done();
            }
        },
        {
            name: 'lenient decisions preserve an earlier pass',
            run() {
                const test = new VanillaTest();
                const descriptor = test.expects('lenient after passing');
                equal(test.pass(), descriptor);
                equal(test.pass(), descriptor);
                equal(test.fail(), descriptor);
                test.done();
            }
        },
        {
            name: 'lenient decisions preserve an earlier failure',
            run() {
                const test = new VanillaTest();
                const descriptor = test.expects('lenient after failing');
                equal(test.fail(), descriptor);
                equal(test.fail(), descriptor);
                equal(test.pass(), descriptor);
                test.done();
            }
        },
        {
            name: 'strict repeated decisions reject changes after pass',
            run() {
                const test = new VanillaTest();
                test.expects('strict after passing');
                test.pass();
                throws(() => test.pass(true), ReferenceError, 'already passed or failed');
                throws(() => test.fail(true), ReferenceError, 'already passed or failed');
                test.done();
            }
        },
        {
            name: 'strict repeated decisions reject changes after failure',
            run() {
                const test = new VanillaTest();
                test.expects('strict after failing');
                test.fail();
                throws(() => test.pass(true), ReferenceError, 'already passed or failed');
                throws(() => test.fail(true), ReferenceError, 'already passed or failed');
                test.done();
            }
        },
        {
            name: 'repeated report calls return the same snapshot',
            async run() {
                const test = new VanillaTest();
                test.expects('idempotent report identity');
                test.pass();
                test.done();
                const first = test.report();
                await flushMicrotasks();
                const second = test.report();
                equal(second, first);
            }
        },
        {
            name: 'repeated report calls log only once',
            async run({ frameworkLogs }) {
                const test = new VanillaTest();
                test.expects('idempotent report logging');
                test.pass();
                test.done();
                const before = frameworkLogs.length;
                test.report();
                equal(frameworkLogs.length, before + 1);
                await flushMicrotasks();
                test.report();
                equal(frameworkLogs.length, before + 1);
            }
        },
        {
            name: 'repeated report calls dispatch completion only once',
            async run() {
                const test = new VanillaTest();
                let eventCount = 0;
                test.onComplete(() => {
                    eventCount++;
                });
                test.report();
                await flushMicrotasks();
                test.report();
                await flushMicrotasks();
                equal(eventCount, 1);
            }
        },
        {
            name: 'reported suites reject later tests',
            async run() {
                const test = new VanillaTest();
                test.report();
                await flushMicrotasks();
                throws(() => test.expects('too late'), ReferenceError, 'already reported');
            }
        }
    ])
});
