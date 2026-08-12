import VanillaTest from 'vanilla-test';

const test = new VanillaTest();

function run(description, assertion) {
    test.expects(description);

    try {
        assertion();
        test.pass();
    } catch (error) {
        console.error(error);
        test.fail();
    }

    test.done();
}

run('1 + 2 equals 3', () => test.compare(1 + 2, 3));
run('the result is a number', () => test.is.number(1 + 2));
run('invalid boolean input throws TypeError', () => {
    try {
        test.is.boolean([]);
    } catch (error) {
        test.is.typeError(error);
        return;
    }

    throw new Error('Expected a TypeError');
});

const result = test.report();
const status = document.querySelector('[data-status]');
const details = document.querySelector('[data-details]');

status.textContent = result.ok ? 'All example tests passed' : 'Example tests failed';
status.dataset.ok = String(result.ok);
details.textContent = `${result.total} tests · ${result.passed.length} passed · ${result.failureCount} failed`;
