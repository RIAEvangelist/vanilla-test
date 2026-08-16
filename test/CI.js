import VanillaTest, {
    VanillaTest as NamedVanillaTest,
    VANILLA_TEST_COMPLETE_EVENT
} from '../index.js';

// This verifier deliberately does not use vanilla-test (or a host test API) as
// its own oracle. Everything below is standard JavaScript shared by Node and
// browsers, so both hosts execute this exact, untransformed module.
function assert(condition, message = 'Expected condition to be true.') {
    if (!condition) {
        throw new Error(message);
    }
}

function equal(actual, expected, message = 'Values are not equal.') {
    if (!Object.is(actual, expected)) {
        throw new Error(`${message} Expected ${String(expected)}, received ${String(actual)}.`);
    }
}

function includes(value, expected, message = 'Expected value was not found.') {
    assert(String(value).includes(expected), `${message} Missing: ${expected}`);
}

function throws(callback, ErrorType, messagePart) {
    let caught;

    try {
        callback();
    } catch (error) {
        caught = error;
    }

    assert(caught, `Expected ${ErrorType.name} to be thrown.`);
    assert(caught instanceof ErrorType, `Expected ${ErrorType.name}, received ${caught.constructor.name}.`);

    if (messagePart) {
        includes(caught.message, messagePart, 'Thrown error had an unexpected message.');
    }

    return caught;
}

function deeplyFrozenSnapshot(snapshot) {
    assert(Object.isFrozen(snapshot), 'The report snapshot must be frozen.');
    assert(Object.isFrozen(snapshot.passed), 'The passed list must be frozen.');
    assert(Object.isFrozen(snapshot.failed), 'The failed list must be frozen.');
}

async function flushMicrotasks() {
    await Promise.resolve();
}

export async function run() {
    const passed = [];
    const failed = [];
    const frameworkLogs = [];
    const originalLog = console.log;

    console.log = (...values) => {
        frameworkLogs.push(values);
    };

    async function check(name, callback) {
        try {
            await callback();
            passed.push(name);
        } catch (error) {
            const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            failed.push(`${name} — ${detail}`);
        }
    }

    try {
        await check('exports the same class by default and by name', () => {
            equal(VanillaTest, NamedVanillaTest);
            equal(VANILLA_TEST_COMPLETE_EVENT, 'vanilla-test:complete');
            const test = new VanillaTest();
            assert(test instanceof EventTarget);
            assert(test instanceof NamedVanillaTest);
        });

        await check('exposes the strong-type helpers and strict setting', () => {
            const test = new VanillaTest();
            equal(test.compare, test.is.compare);
            equal(test.throw, test.is.throw);
            equal(test.strict, true);
            equal(test.is.number(42), true);
            equal(test.compare(1, 1), true);

            test.strict = false;
            equal(test.compare(1, '1'), false);
            equal(test.strict, false);
            equal(test.is.string(42), false);
            test.strict = true;
            equal(test.strict, true);
            throws(() => {
                test.strict = 'yes';
            }, TypeError, 'boolean');
        });

        await check('validates every public typed argument', () => {
            const test = new VanillaTest();
            throws(() => test.expects(42), TypeError, 'string');
            throws(() => test.pass('strict'), TypeError, 'boolean');
            throws(() => test.fail(1), TypeError, 'boolean');
            throws(() => test.delay('later'), TypeError, 'integer');
            throws(() => test.onComplete({}), TypeError, 'function');

            test.strict = false;
            throws(() => test.expects(42), TypeError, 'string');
            throws(() => test.pass('strict'), TypeError, 'boolean');
            throws(() => test.fail(1), TypeError, 'boolean');
            throws(() => test.delay('later'), TypeError, 'integer');
            throws(() => test.delay(Number.NaN), TypeError, 'integer');
            throws(() => test.delay(Number.POSITIVE_INFINITY), TypeError, 'integer');
            throws(() => test.delay(1.5), TypeError, 'integer');
            throws(() => test.delay(-1), TypeError, 'integer');
            throws(() => test.onComplete({}), TypeError, 'function');
            throws(() => {
                test.strict = 'yes';
            }, TypeError, 'boolean');
        });

        await check('guards operations which require an active test', () => {
            const test = new VanillaTest();
            throws(() => test.pass(), ReferenceError, 'no active test to pass');
            throws(() => test.fail(), ReferenceError, 'no active test to fail');
            throws(() => test.done(), ReferenceError, 'no active test to finish');
        });

        await check('guards against starting a second active test', () => {
            const test = new VanillaTest();
            const descriptor = test.expects('the active test guard');
            includes(descriptor, '1) .expects the active test guard');
            throws(
                () => test.expects('a test that starts too early'),
                ReferenceError,
                'is not complete'
            );
            equal(test.pass(), descriptor);
            equal(test.done(), descriptor);
        });

        await check('rejects duplicate raw descriptions without corrupting state', () => {
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
        });

        await check('makes repeated pass and fail calls lenient by default', () => {
            const passedTest = new VanillaTest();
            const passedDescriptor = passedTest.expects('lenient after passing');
            equal(passedTest.pass(), passedDescriptor);
            equal(passedTest.pass(), passedDescriptor);
            equal(passedTest.fail(), passedDescriptor);
            passedTest.done();

            const failedTest = new VanillaTest();
            const failedDescriptor = failedTest.expects('lenient after failing');
            equal(failedTest.fail(), failedDescriptor);
            equal(failedTest.fail(), failedDescriptor);
            equal(failedTest.pass(), failedDescriptor);
            failedTest.done();
        });

        await check('throws for repeated decisions in strict mode', () => {
            const passedTest = new VanillaTest();
            passedTest.expects('strict after passing');
            passedTest.pass();
            throws(() => passedTest.pass(true), ReferenceError, 'already passed or failed');
            throws(() => passedTest.fail(true), ReferenceError, 'already passed or failed');
            passedTest.done();

            const failedTest = new VanillaTest();
            failedTest.expects('strict after failing');
            failedTest.fail();
            throws(() => failedTest.pass(true), ReferenceError, 'already passed or failed');
            throws(() => failedTest.fail(true), ReferenceError, 'already passed or failed');
            failedTest.done();
        });

        await check('automatically fails an undecided test in done', async () => {
            const test = new VanillaTest();
            const descriptor = test.expects('an undecided test');
            equal(test.done(), descriptor);
            const snapshot = test.report();
            equal(snapshot.failureCount, 1);
            equal(snapshot.failed[0], descriptor);
            equal(snapshot.ok, false);
            await flushMicrotasks();
        });

        await check('requires an active test to be done before reporting', async () => {
            const test = new VanillaTest();
            test.expects('report waits for done');
            throws(() => test.report(), ReferenceError, 'Call .done() before .report()');
            test.fail();
            test.done();
            equal(test.report().failureCount, 1);
            await flushMicrotasks();
        });

        await check('returns a complete deeply immutable failure snapshot', async () => {
            const test = new VanillaTest();
            const passing = test.expects('snapshot passing test');
            test.pass();
            test.done();
            const failing = test.expects('snapshot failing test');
            test.fail();
            test.done();

            const snapshot = test.report();
            deeplyFrozenSnapshot(snapshot);
            equal(snapshot.total, 2);
            equal(snapshot.failureCount, 1);
            equal(snapshot.ok, false);
            equal(snapshot.passed[0], passing);
            equal(snapshot.failed[0], failing);
            assert(typeof snapshot.report === 'string');
            includes(snapshot.report, 'FAILED');
            includes(snapshot.report, 'snapshot passing test');
            includes(snapshot.report, 'snapshot failing test');
            throws(() => snapshot.passed.push('mutation'), TypeError);
            throws(() => snapshot.failed.splice(0, 1), TypeError);
            await flushMicrotasks();
        });

        await check('reports a passing empty suite', async () => {
            const test = new VanillaTest();
            const snapshot = test.report();
            deeplyFrozenSnapshot(snapshot);
            equal(snapshot.total, 0);
            equal(snapshot.failureCount, 0);
            equal(snapshot.ok, true);
            equal(snapshot.passed.length, 0);
            equal(snapshot.failed.length, 0);
            includes(snapshot.report, 'PASSED');
            await flushMicrotasks();
        });

        await check('dispatches one completion event after report returns', async () => {
            const test = new VanillaTest();
            test.expects('completion timing');
            test.pass();
            test.done();

            let phase = 'before report';
            let phaseAtEvent;
            let event;
            let eventCount = 0;
            test.onComplete((receivedEvent) => {
                eventCount++;
                event = receivedEvent;
                phaseAtEvent = phase;
            }, { once: true });

            const snapshot = test.report();
            equal(eventCount, 0, 'Completion must not dispatch synchronously.');
            phase = 'after report';
            await flushMicrotasks();
            equal(eventCount, 1);
            equal(phaseAtEvent, 'after report');
            assert(event instanceof CustomEvent);
            equal(event.type, VANILLA_TEST_COMPLETE_EVENT);
            equal(event.detail, snapshot);
        });

        await check('unsubscribes completion listeners idempotently', async () => {
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
        });

        await check('makes report idempotent and seals the suite', async () => {
            const test = new VanillaTest();
            test.expects('idempotent report');
            test.pass();
            test.done();
            let eventCount = 0;
            test.onComplete(() => {
                eventCount++;
            });

            const logCountBeforeReport = frameworkLogs.length;
            const first = test.report();
            equal(frameworkLogs.length, logCountBeforeReport + 1);
            await flushMicrotasks();
            const second = test.report();
            await flushMicrotasks();
            equal(second, first, 'Repeated report calls must return the same object.');
            equal(frameworkLogs.length, logCountBeforeReport + 1, 'Repeated reports must not log twice.');
            equal(eventCount, 1, 'Repeated reports must not dispatch twice.');
            throws(() => test.expects('too late'), ReferenceError, 'already reported');
        });

        await check('keeps VanillaTest instances isolated', async () => {
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
        });

        await check('delay validates, iterates, defaults, and remains chainable', () => {
            const test = new VanillaTest();
            equal(test.delay(0), test);
            equal(test.delay(1), test);
            equal(test.delay(), test);
        });
    } finally {
        console.log = originalLog;
    }

    const passedNames = Object.freeze([...passed]);
    const failedDetails = Object.freeze([...failed]);
    const result = Object.freeze({
        ok: failedDetails.length === 0,
        failureCount: failedDetails.length,
        total: passedNames.length + failedDetails.length,
        passed: passedNames,
        failed: failedDetails,
        frameworkLogCount: frameworkLogs.length
    });

    originalLog(`vanilla-test shared verification: ${result.ok ? 'PASS' : 'FAIL'} (${passedNames.length}/${result.total})`);
    for (const failure of failedDetails) {
        originalLog(`  ${failure}`);
    }

    return result;
}

export default run;
