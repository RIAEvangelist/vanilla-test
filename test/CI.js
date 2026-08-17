import ansi from 'ansi-colors-es6';
import unit from './shared/unit.js';
import functional from './shared/functional.js';
import integration from './shared/integration.js';
import regression from './shared/regression.js';

const categories = Object.freeze([unit, functional, integration, regression]);

function selectCategories(category) {
    if (category === undefined) return categories;
    if (typeof category !== 'string') {
        throw new TypeError('category must be a string.');
    }

    const selected = categories.filter(
        (candidate) => candidate.name.toLowerCase() === category.toLowerCase()
    );
    if (selected.length === 0) {
        throw new RangeError(`Unknown test category: ${category}`);
    }
    return selected;
}

function categoryHeading(category) {
    return `${ansi.bgBlueBright.black.bold(` ${category.name.toUpperCase()} `)} ${ansi.dim(category.description)}`;
}

function testLabel(category, name) {
    return `${category.name} › ${name}`;
}

export async function run({ category } = {}) {
    const selectedCategories = selectCategories(category);
    const passed = [];
    const failed = [];
    const frameworkLogs = [];
    const categoryResults = [];
    const originalLog = console.log;

    console.log = (...values) => {
        frameworkLogs.push(values);
    };

    try {
        for (const testCategory of selectedCategories) {
            const categoryPassed = [];
            const categoryFailed = [];
            originalLog(categoryHeading(testCategory));

            for (const testCase of testCategory.tests) {
                const label = testLabel(testCategory, testCase.name);

                try {
                    await testCase.run({ frameworkLogs });
                    passed.push(label);
                    categoryPassed.push(testCase.name);
                    originalLog(`${ansi.greenBright.bold('✓ PASS')} ${ansi.cyan(testCase.name)}`);
                } catch (error) {
                    const detail = error instanceof Error
                        ? `${error.name}: ${error.message}`
                        : String(error);
                    const failure = `${label} — ${detail}`;
                    failed.push(failure);
                    categoryFailed.push(`${testCase.name} — ${detail}`);
                    originalLog(`${ansi.redBright.bold('✗ FAIL')} ${ansi.cyan(testCase.name)} ${ansi.red(detail)}`);
                }
            }

            categoryResults.push(Object.freeze({
                name: testCategory.name,
                description: testCategory.description,
                ok: categoryFailed.length === 0,
                total: categoryPassed.length + categoryFailed.length,
                passedCount: categoryPassed.length,
                failureCount: categoryFailed.length,
                passed: Object.freeze([...categoryPassed]),
                failed: Object.freeze([...categoryFailed])
            }));
        }
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
        categories: Object.freeze(categoryResults),
        frameworkLogCount: frameworkLogs.length
    });

    const status = result.ok
        ? ansi.greenBright.bold('PASS')
        : ansi.redBright.bold('FAIL');
    const setLabel = categoryResults.length === 1 ? 'set' : 'sets';
    originalLog(
        `${ansi.bold('vanilla-test shared verification:')} ${status} `
        + ansi.dim(`(${passedNames.length}/${result.total}, ${categoryResults.length} ${setLabel})`)
    );

    return result;
}

export { categories };
export default run;
