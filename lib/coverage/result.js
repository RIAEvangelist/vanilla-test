const isFailureCount = (value) => Number.isSafeInteger(value) && value >= 0;

export function validateResult(value, source = 'test entry') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${source} must return a result object.`);
    }

    if (typeof value.ok !== 'boolean' || !isFailureCount(value.failureCount)) {
        throw new TypeError(`${source} must return { ok: boolean, failureCount: nonnegative integer }.`);
    }

    if (value.ok !== (value.failureCount === 0)) {
        throw new TypeError(`${source} returned inconsistent ok and failureCount values.`);
    }

    return value;
}

export function selectRun(moduleNamespace, source = 'test entry') {
    const run = typeof moduleNamespace.default === 'function'
        ? moduleNamespace.default
        : moduleNamespace.run;

    if (typeof run !== 'function') {
        throw new TypeError(`${source} must export a default function or named run function.`);
    }

    return run;
}
