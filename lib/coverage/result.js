import { stripVTControlCharacters } from 'node:util';

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

function normalizedEntries(value) {
    if (!Array.isArray(value)) return [];

    const entries = [];
    for (const entry of value) {
        if (typeof entry === 'string') {
            entries.push(stripVTControlCharacters(entry));
        }
    }
    return entries;
}

export function summarizeResult(value, runtime, source = 'test entry') {
    const result = validateResult(value, source);
    const passed = normalizedEntries(result.passed);
    const failed = normalizedEntries(result.failed);
    const reportedTotal = Number.isSafeInteger(result.total) && result.total >= result.failureCount
        ? result.total
        : null;
    const total = reportedTotal ?? passed.length + result.failureCount;

    return {
        schemaVersion: 1,
        runtime,
        ok: result.ok,
        total,
        passedCount: total - result.failureCount,
        failureCount: result.failureCount,
        passed,
        failed
    };
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
