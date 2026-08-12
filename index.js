import ansi from 'ansi-colors-es6';
import Is from 'strong-type';

const VANILLA_TEST_COMPLETE_EVENT = 'vanilla-test:complete';

class VanillaTest extends EventTarget {
    constructor() {
        super();
    }

    get is() {
        return this.#is;
    }

    get compare() {
        return this.#is.compare;
    }

    get throw() {
        return this.#is.throw;
    }

    get strict() {
        return this.#is.strict;
    }

    set strict(strict) {
        this.#requireType(strict, 'boolean', 'strict');
        this.#is.strict = strict;
    }

    expects(description) {
        this.#requireType(description, 'string', 'description');

        if (this.#snapshot) {
            throw new ReferenceError(
                'This vanilla-test instance has already reported and cannot start another test.'
            );
        }

        if (this.#test !== null) {
            throw new ReferenceError(
                `${ansi.red(this.#test)} is not complete. So ${ansi.red(description)} cannot be started.`
            );
        }

        if (this.#descriptions.has(description)) {
            throw new ReferenceError(
                `vanilla-test expects test descriptions to be unique. ${ansi.red(description)} has already been declared and run. Please use a more descriptive test name.`
            );
        }

        this.#descriptions.add(description);
        this.#test = `${this.#failed.length + this.#passed.length + 1}) .expects ${description}`;

        console.log(`\n${ansi.bgBlack.white(this.#test)}`);

        return this.#test;
    }

    pass(strict = false) {
        this.#requireType(strict, 'boolean', 'strict');
        this.#requireActiveTest('pass');

        if (this.#passed.includes(this.#test) || this.#failed.includes(this.#test)) {
            if (strict) {
                throw new ReferenceError(
                    `${ansi.red(this.#test)} has already passed or failed and is waiting for .done(). It cannot pass or fail again.`
                );
            }

            return this.#test;
        }

        this.#passed.push(this.#test);
        console.log(ansi.greenBright('   pass\n'));

        return this.#test;
    }

    fail(strict = false) {
        this.#requireType(strict, 'boolean', 'strict');
        this.#requireActiveTest('fail');

        if (this.#passed.includes(this.#test) || this.#failed.includes(this.#test)) {
            if (strict) {
                throw new ReferenceError(
                    `${ansi.red(this.#test)} has already passed or failed and is waiting for .done(). It cannot pass or fail again.`
                );
            }

            return this.#test;
        }

        this.#failed.push(this.#test);
        console.log(ansi.redBright('   fail\n'));

        return this.#test;
    }

    done() {
        this.#requireActiveTest('finish');

        if (!this.#passed.includes(this.#test) && !this.#failed.includes(this.#test)) {
            this.fail();
        }

        const test = this.#test;
        this.#test = null;

        return test;
    }

    onComplete(listener, options) {
        this.#requireType(listener, 'function', 'listener');
        this.addEventListener(VANILLA_TEST_COMPLETE_EVENT, listener, options);

        let subscribed = true;

        return () => {
            if (!subscribed) {
                return;
            }

            subscribed = false;
            this.removeEventListener(VANILLA_TEST_COMPLETE_EVENT, listener, options);
        };
    }

    report() {
        if (this.#snapshot) {
            return this.#snapshot;
        }

        if (this.#test !== null) {
            throw new ReferenceError(
                `${ansi.red(this.#test)} is not complete. Call .done() before .report().`
            );
        }

        let report = `

Result : ${this.#failed.length ? ansi.redBright('FAILED') : ansi.greenBright('PASSED')}

Test Total : ${this.#passed.length + this.#failed.length}
${ansi.greenBright('Passed :')} ${this.#passed.length}
${ansi.redBright('Failed :')} ${this.#failed.length}\n`;

        report += ansi.bgRedBright.black('\nFAILED TESTS :\n');

        for (const test of this.#failed) {
            report += ansi.bgBlack.redBright(`${test}\n`);
        }

        report += ansi.bgGreenBright.black('\nPASSED TESTS :\n');

        for (const test of this.#passed) {
            report += ansi.bgBlack.greenBright(`${test}\n`);
        }

        const renderedReport = ansi.bgBlack(report);
        const passed = Object.freeze([...this.#passed]);
        const failed = Object.freeze([...this.#failed]);

        this.#snapshot = Object.freeze({
            passed,
            failed,
            total: passed.length + failed.length,
            failureCount: failed.length,
            ok: failed.length === 0,
            report: renderedReport
        });

        console.log(renderedReport);

        const snapshot = this.#snapshot;
        queueMicrotask(() => {
            this.dispatchEvent(new CustomEvent(VANILLA_TEST_COMPLETE_EVENT, {
                detail: snapshot
            }));
        });

        return snapshot;
    }

    // Chew on something to give async operations a moment without host APIs.
    delay(delay = 1000) {
        if (!Number.isSafeInteger(delay) || delay < 0) {
            throw new TypeError('delay must be a nonnegative safe integer.');
        }

        let current = 0;
        while (current < delay) {
            current++;
        }

        return this;
    }

    #requireActiveTest(action) {
        if (this.#test === null) {
            throw new ReferenceError(`There is no active test to ${action}. Call .expects() first.`);
        }
    }

    #requireType(value, expected, label) {
        if (typeof value !== expected) {
            throw new TypeError(`${label} must be a ${expected}.`);
        }
    }

    #is = new Is();
    #test = null;
    #descriptions = new Set();
    #passed = [];
    #failed = [];
    #snapshot = null;
}

export {
    VanillaTest as default,
    VanillaTest,
    VANILLA_TEST_COMPLETE_EVENT
};
