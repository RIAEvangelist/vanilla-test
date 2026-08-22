import VanillaTest, { VANILLA_TEST_COMPLETE_EVENT } from '../../index.js';
import {
    assert,
    deeplyFrozenSnapshot,
    equal,
    flushMicrotasks,
    includes,
    throws
} from './assertions.js';

function mixedSuite() {
    const test = new VanillaTest();
    const passing = test.expects('snapshot passing test');
    test.pass();
    test.done();
    const failing = test.expects('snapshot failing test');
    test.fail();
    test.done();
    return { test, passing, failing };
}

export default Object.freeze({
    name: 'Integration',
    description: 'Lifecycle composition, reports, events, listeners, and instance boundaries.',
    tests: Object.freeze([
        {
            name: 'mixed outcomes produce consistent report accounting',
            async run() {
                const { test, passing, failing } = mixedSuite();
                const snapshot = test.report();
                equal(snapshot.total, 2);
                equal(snapshot.failureCount, 1);
                equal(snapshot.ok, false);
                equal(snapshot.passed[0], passing);
                equal(snapshot.failed[0], failing);
                await flushMicrotasks();
            }
        },
        {
            name: 'report snapshots freeze their complete structure',
            async run() {
                const { test } = mixedSuite();
                deeplyFrozenSnapshot(test.report());
                await flushMicrotasks();
            }
        },
        {
            name: 'report result lists reject mutation',
            async run() {
                const { test } = mixedSuite();
                const snapshot = test.report();
                throws(() => snapshot.passed.push('mutation'), TypeError);
                throws(() => snapshot.failed.splice(0, 1), TypeError);
                await flushMicrotasks();
            }
        },
        {
            name: 'rendered reports include status and both outcome lists',
            async run() {
                const { test } = mixedSuite();
                const snapshot = test.report();
                assert(typeof snapshot.report === 'string');
                includes(snapshot.report, 'FAILED');
                includes(snapshot.report, 'snapshot passing test');
                includes(snapshot.report, 'snapshot failing test');
                await flushMicrotasks();
            }
        },
        {
            name: 'completion dispatch occurs after report returns',
            async run() {
                const test = new VanillaTest();
                test.expects('completion timing');
                test.pass();
                test.done();

                let phase = 'before report';
                let phaseAtEvent;
                let eventCount = 0;
                test.onComplete(() => {
                    eventCount++;
                    phaseAtEvent = phase;
                }, { once: true });

                test.report();
                equal(eventCount, 0, 'Completion must not dispatch synchronously.');
                phase = 'after report';
                await flushMicrotasks();
                equal(eventCount, 1);
                equal(phaseAtEvent, 'after report');
            }
        },
        {
            name: 'completion event carries its public type and exact snapshot',
            async run() {
                const test = new VanillaTest();
                let event;
                test.onComplete((receivedEvent) => {
                    event = receivedEvent;
                }, { once: true });
                const snapshot = test.report();
                await flushMicrotasks();
                assert(event instanceof CustomEvent);
                equal(event.type, VANILLA_TEST_COMPLETE_EVENT);
                equal(event.detail, snapshot);
            }
        },
        {
            name: 'reports without completion subscriptions do not queue completion work',
            run() {
                const originalQueueMicrotask = globalThis.queueMicrotask;
                let queued = 0;
                globalThis.queueMicrotask = (callback) => {
                    queued++;
                    return originalQueueMicrotask(callback);
                };

                try {
                    const test = new VanillaTest();
                    test.addEventListener('unrelated-event', () => {});
                    test.report();
                    equal(queued, 0);
                } finally {
                    globalThis.queueMicrotask = originalQueueMicrotask;
                }
            }
        },
        {
            name: 'first completion listener can subscribe after report',
            async run() {
                const test = new VanillaTest();
                const snapshot = test.report();
                let received;

                test.addEventListener(VANILLA_TEST_COMPLETE_EVENT, ({ detail }) => {
                    received = detail;
                }, { once: true });

                equal(received, undefined);
                await flushMicrotasks();
                equal(received, snapshot);
            }
        },
        {
            name: 'native event type coercion still observes completion listeners',
            async run() {
                const test = new VanillaTest();
                const eventType = { toString: () => VANILLA_TEST_COMPLETE_EVENT };
                let received;

                test.addEventListener(eventType, ({ detail }) => {
                    received = detail;
                }, { once: true });

                const snapshot = test.report();
                await flushMicrotasks();
                equal(received, snapshot);
            }
        },
        {
            name: 'completion unsubscribe remains idempotent',
            async run() {
                const test = new VanillaTest();
                let eventCount = 0;
                const unsubscribe = test.onComplete(() => {
                    eventCount++;
                });
                equal(typeof unsubscribe, 'function');
                unsubscribe();
                unsubscribe();
                test.report();
                await flushMicrotasks();
                equal(eventCount, 0);
            }
        },
        {
            name: 'instances isolate descriptions and outcomes',
            async run() {
                const first = new VanillaTest();
                const second = new VanillaTest();

                first.expects('the same description');
                first.pass();
                first.done();
                second.expects('the same description');
                second.fail();
                second.done();

                const firstResult = first.report();
                const secondResult = second.report();
                equal(firstResult.ok, true);
                equal(firstResult.total, 1);
                equal(secondResult.ok, false);
                equal(secondResult.failureCount, 1);
                await flushMicrotasks();
            }
        }
    ])
});
