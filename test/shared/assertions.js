// This verifier deliberately does not use vanilla-test (or a host test API) as
// its own oracle. These small Web-standard helpers run unchanged in Node and
// browsers, so the framework never certifies its own behavior.
export function assert(condition, message = 'Expected condition to be true.') {
    if (!condition) {
        throw new Error(message);
    }
}

export function equal(actual, expected, message = 'Values are not equal.') {
    if (!Object.is(actual, expected)) {
        throw new Error(`${message} Expected ${String(expected)}, received ${String(actual)}.`);
    }
}

export function includes(value, expected, message = 'Expected value was not found.') {
    assert(String(value).includes(expected), `${message} Missing: ${expected}`);
}

export function throws(callback, ErrorType, messagePart) {
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

export function deeplyFrozenSnapshot(snapshot) {
    assert(Object.isFrozen(snapshot), 'The report snapshot must be frozen.');
    assert(Object.isFrozen(snapshot.passed), 'The passed list must be frozen.');
    assert(Object.isFrozen(snapshot.failed), 'The failed list must be frozen.');
}

export async function flushMicrotasks() {
    await Promise.resolve();
}
