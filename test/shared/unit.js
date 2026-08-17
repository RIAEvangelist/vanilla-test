import VanillaTest, {
    VanillaTest as NamedVanillaTest,
    VANILLA_TEST_COMPLETE_EVENT
} from '../../index.js';
import { assert, equal, throws } from './assertions.js';

export default Object.freeze({
    name: 'Unit',
    description: 'Exports, type contracts, delegates, strict state, and delay boundaries.',
    tests: Object.freeze([
        {
            name: 'default and named exports reference the same class',
            run() {
                equal(VanillaTest, NamedVanillaTest);
            }
        },
        {
            name: 'completion event name is stable',
            run() {
                equal(VANILLA_TEST_COMPLETE_EVENT, 'vanilla-test:complete');
            }
        },
        {
            name: 'instances satisfy the Web-standard EventTarget contract',
            run() {
                const test = new VanillaTest();
                assert(test instanceof EventTarget);
                assert(test instanceof NamedVanillaTest);
            }
        },
        {
            name: 'compare and throw expose the strong-type delegates',
            run() {
                const test = new VanillaTest();
                equal(test.compare, test.is.compare);
                equal(test.throw, test.is.throw);
            }
        },
        {
            name: 'strict checking starts enabled',
            run() {
                equal(new VanillaTest().strict, true);
            }
        },
        {
            name: 'strict checking can be disabled and restored',
            run() {
                const test = new VanillaTest();
                test.strict = false;
                equal(test.strict, false);
                test.strict = true;
                equal(test.strict, true);
            }
        },
        {
            name: 'strict setting accepts booleans only',
            run() {
                const test = new VanillaTest();
                throws(() => {
                    test.strict = 'yes';
                }, TypeError, 'boolean');
            }
        },
        {
            name: 'strong-type delegates return their underlying results',
            run() {
                const test = new VanillaTest();
                equal(test.is.number(42), true);
                equal(test.compare(1, 1), true);
                test.strict = false;
                equal(test.compare(1, '1'), false);
                equal(test.is.string(42), false);
            }
        },
        {
            name: 'expects accepts string descriptions only',
            run() {
                throws(() => new VanillaTest().expects(42), TypeError, 'string');
            }
        },
        {
            name: 'pass accepts a boolean strict flag only',
            run() {
                throws(() => new VanillaTest().pass('strict'), TypeError, 'boolean');
            }
        },
        {
            name: 'fail accepts a boolean strict flag only',
            run() {
                throws(() => new VanillaTest().fail(1), TypeError, 'boolean');
            }
        },
        {
            name: 'onComplete accepts function listeners only',
            run() {
                throws(() => new VanillaTest().onComplete({}), TypeError, 'function');
            }
        },
        {
            name: 'delay rejects invalid iteration counts',
            run() {
                const test = new VanillaTest();
                for (const value of ['later', Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1]) {
                    throws(() => test.delay(value), TypeError, 'nonnegative safe integer');
                }
            }
        },
        {
            name: 'delay accepts explicit nonnegative iteration counts',
            run() {
                const test = new VanillaTest();
                equal(test.delay(0), test);
                equal(test.delay(1), test);
            }
        },
        {
            name: 'delay default remains chainable',
            run() {
                const test = new VanillaTest();
                equal(test.delay(), test);
            }
        }
    ])
});
