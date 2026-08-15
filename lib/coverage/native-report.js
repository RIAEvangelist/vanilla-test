import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const METRICS = Object.freeze(['statements', 'branches', 'functions', 'lines']);
const METRIC_LABELS = Object.freeze({
    statements: 'Executable ranges',
    branches: 'Block ranges',
    functions: 'Function ranges',
    lines: 'Executable lines'
});
const SUMMARY_FILES = new WeakMap();

/**
 * Exact definitions used by the project-owned native V8 reporter.
 * These are range-derived measurements, not parser-derived source semantics.
 */
export const NATIVE_V8_METRIC_DEFINITIONS = Object.freeze({
    statements: 'One item for every executable range record emitted by V8, including function roots and nested block ranges; a positive execution count is covered. V8 may collapse equal-count ranges, so totals can vary with the execution path.',
    branches: 'One item for every nested block range after a function root range; a positive execution count is covered. These are count-change regions, not parser-enumerated branch alternatives.',
    functions: 'One item for the first (root) range of every V8 function record; a positive execution count is covered.',
    lines: 'One item for every source line whose content intersects an effective executable range; a line is covered only when every intersecting effective range has a positive count.',
    effectiveRanges: 'Source is partitioned at every V8 range boundary. Each segment uses the count from its smallest enclosing range, with the lowest count winning an equal-size tie.',
    unloaded: 'An included file not emitted by V8 is represented by one zero-count whole-file range. Its internal function and block structure is unknown and cannot satisfy a positive function or block threshold.',
    interoperability: 'The JSON and LCOV files use conventional field names and records for tool transport, but executable-range and block-range totals are native V8 measurements and are not interchangeable with parser-derived statement or branch totals. Summary pct values are truncated to two decimals; threshold gates compare the exact covered/total ratio.'
});

function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object.`);
    }
    return value;
}

function nonemptyString(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${label} must be a nonempty string.`);
    }
    return value;
}

function safeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${label} must be a nonnegative safe integer.`);
    }
    return value;
}

function percentage(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new RangeError(`${label} must be a number from 0 through 100.`);
    }
    return value;
}

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function percent(covered, total) {
    if (total === 0) return 100;
    return Number((BigInt(covered) * 10_000n) / BigInt(total)) / 100;
}

function measure(total, covered) {
    return Object.freeze({ total, covered, skipped: 0, pct: percent(covered, total) });
}

function decimalFraction(value) {
    const [coefficient, exponentText = '0'] = value.toString().toLowerCase().split('e');
    const [whole, fraction = ''] = coefficient.split('.');
    const exponent = Number(exponentText);
    const digits = BigInt(`${whole}${fraction}`);
    const scale = fraction.length - exponent;
    return scale <= 0
        ? [digits * (10n ** BigInt(-scale)), 1n]
        : [digits, 10n ** BigInt(scale)];
}

function meetsThreshold(item, required) {
    if (required === undefined || item.total === 0) return true;
    const [minimum, scale] = decimalFraction(required);
    return BigInt(item.covered) * 100n * scale >= BigInt(item.total) * minimum;
}

function normalizeThresholds(value) {
    const source = object(value ?? {}, 'thresholds');
    for (const key of Object.keys(source)) {
        if (!METRICS.includes(key)) throw new TypeError(`thresholds contains unknown key ${JSON.stringify(key)}.`);
    }
    return Object.freeze(Object.fromEntries(METRICS
        .filter((metric) => source[metric] !== undefined)
        .map((metric) => [metric, percentage(source[metric], `thresholds.${metric}`)])));
}

function normalizeEnforcement(value) {
    const source = object(value ?? {}, 'enforcement');
    for (const key of Object.keys(source)) {
        if (key !== 'total' && key !== 'perFile') throw new TypeError(`enforcement contains unknown key ${JSON.stringify(key)}.`);
    }
    for (const key of ['total', 'perFile']) {
        if (source[key] !== undefined && typeof source[key] !== 'boolean') {
            throw new TypeError(`enforcement.${key} must be a boolean.`);
        }
    }
    return Object.freeze({ total: source.total ?? true, perFile: source.perFile ?? true });
}

function identityFrom(value, root, label) {
    const source = object(value, label);
    if (source.filePath !== undefined) {
        const configured = nonemptyString(source.filePath, `${label}.filePath`);
        const absolute = path.resolve(root, configured);
        return Object.freeze({ key: `file:${process.platform === 'win32' ? absolute.toLowerCase() : absolute}`, filePath: absolute, url: source.url ?? null });
    }

    const url = nonemptyString(source.url, `${label}.url`);
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch {
        parsedUrl = null;
    }
    if (parsedUrl?.protocol === 'file:') {
        let absolute;
        try {
            absolute = path.resolve(fileURLToPath(parsedUrl));
        } catch (error) {
            throw new TypeError(`${label}.url must be a valid file URL.`, { cause: error });
        }
        return Object.freeze({ key: `file:${process.platform === 'win32' ? absolute.toLowerCase() : absolute}`, filePath: absolute, url });
    }
    return Object.freeze({ key: `url:${url}`, filePath: null, url });
}

function reportPath(identity, root) {
    if (!identity.filePath) return identity.url;
    const relative = path.relative(root, identity.filePath);
    if (relative === '') return path.basename(identity.filePath);
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        return relative.split(path.sep).join('/');
    }
    return identity.filePath.split(path.sep).join('/');
}

function normalizeFunctions(value, sourceLength, label) {
    if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
    return Object.freeze(value.map((entry, functionIndex) => {
        const functionSource = object(entry, `${label}[${functionIndex}]`);
        if (!Array.isArray(functionSource.ranges) || functionSource.ranges.length === 0) {
            throw new TypeError(`${label}[${functionIndex}].ranges must be a nonempty array.`);
        }
        const ranges = functionSource.ranges.map((entryRange, rangeIndex) => {
            const range = object(entryRange, `${label}[${functionIndex}].ranges[${rangeIndex}]`);
            const startOffset = safeInteger(range.startOffset, `${label}[${functionIndex}].ranges[${rangeIndex}].startOffset`);
            const endOffset = safeInteger(range.endOffset, `${label}[${functionIndex}].ranges[${rangeIndex}].endOffset`);
            const count = safeInteger(range.count, `${label}[${functionIndex}].ranges[${rangeIndex}].count`);
            if (endOffset <= startOffset || endOffset > sourceLength) {
                throw new RangeError(`${label}[${functionIndex}].ranges[${rangeIndex}] must be nonempty and stay inside its source.`);
            }
            return Object.freeze({ startOffset, endOffset, count });
        });
        const rootRange = ranges[0];
        for (let rangeIndex = 1; rangeIndex < ranges.length; rangeIndex += 1) {
            const range = ranges[rangeIndex];
            if (range.startOffset < rootRange.startOffset || range.endOffset > rootRange.endOffset) {
                throw new RangeError(`${label}[${functionIndex}].ranges[${rangeIndex}] must stay inside the function root range.`);
            }
        }
        return Object.freeze({
            functionName: typeof functionSource.functionName === 'string' ? functionSource.functionName : '',
            isBlockCoverage: functionSource.isBlockCoverage === true,
            ranges: Object.freeze(ranges)
        });
    }));
}

function normalizeScript(value, root, label, loaded = true) {
    const source = object(value, label);
    if (typeof source.source !== 'string') throw new TypeError(`${label}.source must be a string.`);
    if (loaded && !Object.hasOwn(source, 'functions')) throw new TypeError(`${label}.functions is required.`);
    const identity = identityFrom(source, root, label);
    const functions = normalizeFunctions(source.functions ?? [], source.source.length, `${label}.functions`);
    if (loaded && source.source.length > 0 && functions.length === 0) {
        throw new TypeError(`${label}.functions must include V8's script root for nonempty source.`);
    }
    return Object.freeze({
        ...identity,
        reportPath: reportPath(identity, root),
        source: source.source,
        functions,
        loaded
    });
}

function includedFilePath(value, root, index) {
    const label = `includedFiles[${index}]`;
    if (typeof value === 'string') {
        return path.resolve(root, nonemptyString(value, label));
    }
    const entry = object(value, label);
    return path.resolve(root, nonemptyString(entry.filePath, `${label}.filePath`));
}

async function normalizeIncludedFile(value, filePath, root, index) {
    const label = `includedFiles[${index}]`;
    const source = typeof value === 'string' || value.source === undefined
        ? await fs.readFile(filePath, 'utf8')
        : value.source;
    if (typeof source !== 'string') throw new TypeError(`${label}.source must be a string.`);
    return normalizeScript({ filePath, source, functions: [] }, root, label, false);
}

function rangeRecords(functions) {
    return functions.flatMap((entry, functionIndex) => entry.ranges.map((range, rangeIndex) => Object.freeze({
        ...range,
        functionIndex,
        rangeIndex,
        kind: rangeIndex === 0 ? 'function' : 'block'
    })));
}

function heapPush(heap, value, compare) {
    heap.push(value);
    let index = heap.length - 1;
    while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (compare(heap[parent], value) <= 0) break;
        heap[index] = heap[parent];
        index = parent;
    }
    heap[index] = value;
}

function heapPop(heap, compare) {
    const first = heap[0];
    const last = heap.pop();
    if (heap.length === 0) return first;
    let index = 0;
    while (true) {
        const left = (index * 2) + 1;
        if (left >= heap.length) break;
        const right = left + 1;
        const child = right < heap.length && compare(heap[right], heap[left]) < 0 ? right : left;
        if (compare(heap[child], last) >= 0) break;
        heap[index] = heap[child];
        index = child;
    }
    heap[index] = last;
    return first;
}

function effectiveRanges(ranges) {
    const nonempty = ranges.filter((range) => range.endOffset > range.startOffset).map((range, id) => ({
        ...range,
        id,
        length: range.endOffset - range.startOffset
    }));
    const starts = new Map();
    for (const range of nonempty) {
        const entries = starts.get(range.startOffset) ?? [];
        entries.push(range);
        starts.set(range.startOffset, entries);
    }
    const boundaries = [...new Set(nonempty.flatMap((range) => [range.startOffset, range.endOffset]))].sort((left, right) => left - right);
    const compare = (left, right) => left.length - right.length || left.count - right.count || left.id - right.id;
    const active = [];
    const segments = [];
    for (let index = 0; index < boundaries.length - 1; index += 1) {
        const startOffset = boundaries[index];
        const endOffset = boundaries[index + 1];
        for (const range of starts.get(startOffset) ?? []) heapPush(active, range, compare);
        while (active.length && active[0].endOffset <= startOffset) heapPop(active, compare);
        if (active.length === 0) continue;
        const count = active[0].count;
        const previous = segments.at(-1);
        if (previous && previous.endOffset === startOffset && previous.count === count) {
            previous.endOffset = endOffset;
        } else {
            segments.push({ startOffset, endOffset, count });
        }
    }
    return Object.freeze(segments.map(Object.freeze));
}

function sourceLines(source) {
    const lines = [];
    let startOffset = 0;
    let number = 1;
    for (let index = 0; index < source.length; index += 1) {
        if (source[index] !== '\n' && source[index] !== '\r') continue;
        lines.push({ number, startOffset, endOffset: index });
        if (source[index] === '\r' && source[index + 1] === '\n') index += 1;
        startOffset = index + 1;
        number += 1;
    }
    if (startOffset < source.length) lines.push({ number, startOffset, endOffset: source.length });
    return lines;
}

function executableLines(source, ranges) {
    let rangeIndex = 0;
    return Object.freeze(sourceLines(source).flatMap((line) => {
        if (line.endOffset <= line.startOffset) return [];
        while (rangeIndex < ranges.length && ranges[rangeIndex].endOffset <= line.startOffset) rangeIndex += 1;
        let cursor = rangeIndex;
        let found = false;
        let covered = true;
        let count = Number.POSITIVE_INFINITY;
        while (cursor < ranges.length && ranges[cursor].startOffset < line.endOffset) {
            const range = ranges[cursor];
            if (range.endOffset > line.startOffset) {
                found = true;
                covered &&= range.count > 0;
                count = Math.min(count, range.count);
            }
            cursor += 1;
        }
        if (!found) return [];
        return [Object.freeze({
            ...line,
            count,
            covered
        })];
    }));
}

function lineNumberAt(lines, offset) {
    let low = 0;
    let high = lines.length - 1;
    let match = null;
    while (low <= high) {
        const middle = low + Math.floor((high - low) / 2);
        if (offset <= lines[middle].endOffset) {
            match = lines[middle].number;
            high = middle - 1;
        } else {
            low = middle + 1;
        }
    }
    return match ?? lines.at(-1)?.number ?? 1;
}

function analyzeFile(script) {
    const nativeRanges = rangeRecords(script.functions);
    const ranges = !script.loaded && nativeRanges.length === 0 && script.source.length > 0
        ? [Object.freeze({ startOffset: 0, endOffset: script.source.length, count: 0, functionIndex: -1, rangeIndex: 0, kind: 'unloaded' })]
        : nativeRanges;
    const effective = effectiveRanges(ranges);
    const lines = executableLines(script.source, effective);
    const functionRanges = ranges.filter((range) => range.kind === 'function');
    const blockRanges = ranges.filter((range) => range.kind === 'block');
    const metrics = Object.freeze({
        statements: measure(ranges.length, ranges.filter((range) => range.count > 0).length),
        branches: measure(blockRanges.length, blockRanges.filter((range) => range.count > 0).length),
        functions: measure(functionRanges.length, functionRanges.filter((range) => range.count > 0).length),
        lines: measure(lines.length, lines.filter((line) => line.covered).length)
    });
    const unknownMetrics = Object.freeze(!script.loaded && script.source.length > 0 ? ['branches', 'functions'] : []);
    return Object.freeze({ ...script, ranges: Object.freeze(ranges), effectiveRanges: effective, lines, metrics, unknownMetrics });
}

function totalMetrics(files) {
    return Object.freeze(Object.fromEntries(METRICS.map((metric) => {
        const total = files.reduce((sum, file) => sum + file.metrics[metric].total, 0);
        const covered = files.reduce((sum, file) => sum + file.metrics[metric].covered, 0);
        return [metric, measure(total, covered)];
    })));
}

function summaryFromFiles(files) {
    const entries = [['total', totalMetrics(files)]];
    for (const file of files) entries.push([file.reportPath, file.metrics]);
    return Object.freeze(Object.fromEntries(entries));
}

/**
 * Normalize V8 script coverage, add zero-count records for included files that
 * V8 did not emit, and derive the documented native range metrics.
 *
 * Each script must have `source`, `functions`, and either `filePath` or `url`.
 * Function entries use V8's `{functionName, ranges, isBlockCoverage}` shape.
 * Included files may be paths or `{filePath, source?}` objects; missing source
 * text is read from disk. Included entries already present in scripts are not
 * duplicated.
 *
 * @param {{scripts: Array<object>, includedFiles?: Array<string|object>, root?: string}} options Native coverage inputs.
 * @returns {Promise<Readonly<{summary: object, files: ReadonlyArray<object>, metricDefinitions: typeof NATIVE_V8_METRIC_DEFINITIONS}>>} Derived coverage.
 */
export async function analyzeNativeCoverage(options) {
    const source = object(options, 'options');
    if (!Array.isArray(source.scripts)) throw new TypeError('options.scripts must be an array.');
    if (source.includedFiles !== undefined && !Array.isArray(source.includedFiles)) {
        throw new TypeError('options.includedFiles must be an array.');
    }
    const root = path.resolve(source.root ?? process.cwd());
    const filesByIdentity = new Map();
    for (const [index, entry] of source.scripts.entries()) {
        const script = normalizeScript(entry, root, `scripts[${index}]`);
        if (filesByIdentity.has(script.key)) throw new TypeError(`scripts contains duplicate source ${JSON.stringify(script.reportPath)}.`);
        filesByIdentity.set(script.key, script);
    }
    for (const [index, entry] of (source.includedFiles ?? []).entries()) {
        const filePath = includedFilePath(entry, root, index);
        const identity = identityFrom({ filePath }, root, `includedFiles[${index}]`);
        if (filesByIdentity.has(identity.key)) continue;
        const included = await normalizeIncludedFile(entry, filePath, root, index);
        filesByIdentity.set(included.key, included);
    }
    const files = Object.freeze([...filesByIdentity.values()]
        .map(analyzeFile)
        .sort((left, right) => compareText(left.reportPath, right.reportPath)));
    const reportPaths = new Set(['total']);
    for (const file of files) {
        if (reportPaths.has(file.reportPath)) {
            throw new TypeError(`Coverage sources must have unique report paths; reserved or duplicate path ${JSON.stringify(file.reportPath)}.`);
        }
        reportPaths.add(file.reportPath);
    }
    const summary = summaryFromFiles(files);
    SUMMARY_FILES.set(summary, files);
    return Object.freeze({ summary, files, metricDefinitions: NATIVE_V8_METRIC_DEFINITIONS });
}

function coverageSummary(value) {
    const input = object(value, 'coverage summary');
    const summary = Object.hasOwn(input, 'total') ? input : object(input.summary, 'coverage summary.summary');
    if (!Object.hasOwn(summary, 'total')) throw new TypeError('coverage summary must contain a total record.');
    const entries = [];
    for (const [filePath, recordValue] of Object.entries(summary).sort(([left], [right]) => left === right ? 0 : left === 'total' ? -1 : right === 'total' ? 1 : compareText(left, right))) {
        const record = object(recordValue, `coverage summary[${JSON.stringify(filePath)}]`);
        entries.push([filePath, Object.freeze(Object.fromEntries(METRICS.map((metric) => {
            const item = object(record[metric], `coverage summary[${JSON.stringify(filePath)}].${metric}`);
            const total = safeInteger(item.total, `coverage summary[${JSON.stringify(filePath)}].${metric}.total`);
            const covered = safeInteger(item.covered, `coverage summary[${JSON.stringify(filePath)}].${metric}.covered`);
            if (covered > total) throw new RangeError(`coverage summary[${JSON.stringify(filePath)}].${metric}.covered cannot exceed its total.`);
            return [metric, measure(total, covered)];
        }))) ]);
    }
    return Object.freeze(Object.fromEntries(entries));
}

/**
 * Compute deterministic threshold failures for aggregate totals, files, or
 * both. Omitted threshold metrics are measured but not enforced.
 *
 * Pass the complete analyzeNativeCoverage result when available so thresholds
 * can treat function and block structure in unloaded files as unavailable. A
 * `summary` property from this module retains that metadata in the same process.
 *
 * @param {object} summary A result returned by analyzeNativeCoverage, or its `summary` property.
 * @param {Record<string, number>} thresholds Minimum percentages by native metric.
 * @param {{total?: boolean, perFile?: boolean}} [enforcement] Both switches default to true.
 * @returns {ReadonlyArray<Readonly<{scope: 'total'|'file', file: string|null, metric: string, actual: number|null, required: number, reason: 'below-threshold'|'unavailable', message: string}>>} Structured failures.
 */
export function getThresholdFailures(summary, thresholds, enforcement = {}) {
    const input = object(summary, 'coverage summary');
    const rawSummary = Object.hasOwn(input, 'total') ? input : input.summary;
    const files = Array.isArray(input.files) ? input.files : SUMMARY_FILES.get(rawSummary) ?? [];
    const unknownByFile = new Map(files.map((file) => [file.reportPath, new Set(file.unknownMetrics ?? [])]));
    const normalized = coverageSummary(input);
    const minimums = normalizeThresholds(thresholds);
    const rules = normalizeEnforcement(enforcement);
    const failures = [];
    const inspect = (scope, file, record) => {
        for (const metric of METRICS) {
            const required = minimums[metric];
            if (required === undefined) continue;
            const unavailable = required > 0 && (scope === 'total'
                ? [...unknownByFile.values()].some((metrics) => metrics.has(metric))
                : unknownByFile.get(file)?.has(metric));
            if (unavailable) {
                failures.push(Object.freeze({
                    scope,
                    file,
                    metric,
                    actual: null,
                    required,
                    reason: 'unavailable',
                    message: `${scope === 'total' ? 'total' : file} ${metric}: unavailable for included source not loaded by V8 (required ${formatThresholdPercentage(required)})`
                }));
                continue;
            }
            if (meetsThreshold(record[metric], required)) continue;
            const actual = record[metric].pct;
            failures.push(Object.freeze({
                scope,
                file,
                metric,
                actual,
                required,
                reason: 'below-threshold',
                message: `${scope === 'total' ? 'total' : file} ${metric}: ${formatMeasurePercentage(record[metric], required)} (required ${formatThresholdPercentage(required)})`
            }));
        }
    };
    if (rules.total) inspect('total', null, normalized.total);
    if (rules.perFile) {
        for (const [file, record] of Object.entries(normalized).filter(([key]) => key !== 'total')) inspect('file', file, record);
    }
    return Object.freeze(failures);
}

function lcovName(entry, functionIndex, startLine) {
    const supplied = entry.functionName.trim().replace(/[\r\n,]+/g, ' ');
    return `${supplied || '(anonymous)'}@${startLine}:${functionIndex + 1}`;
}

function lcovPath(file) {
    return file.reportPath.replaceAll('\\', '/').replace(/[\r\n]+/g, '');
}

function renderLcov(files, runtime) {
    const records = [];
    for (const file of files) {
        const sourceLineSpans = sourceLines(file.source);
        const lines = [`TN:${runtime.replace(/[\r\n]+/g, ' ')}`, `SF:${lcovPath(file)}`];
        file.functions.forEach((entry, functionIndex) => {
            const rootRange = entry.ranges[0];
            const startLine = lineNumberAt(sourceLineSpans, rootRange.startOffset);
            lines.push(`FN:${startLine},${lcovName(entry, functionIndex, startLine)}`);
        });
        file.functions.forEach((entry, functionIndex) => {
            const rootRange = entry.ranges[0];
            const startLine = lineNumberAt(sourceLineSpans, rootRange.startOffset);
            lines.push(`FNDA:${rootRange.count},${lcovName(entry, functionIndex, startLine)}`);
        });
        const functionTotal = file.metrics.functions.total;
        lines.push(`FNF:${functionTotal}`, `FNH:${file.metrics.functions.covered}`);
        let branchIndex = 0;
        file.functions.forEach((entry, functionIndex) => entry.ranges.slice(1).forEach((range) => {
            const startLine = lineNumberAt(sourceLineSpans, range.startOffset);
            lines.push(`BRDA:${startLine},${functionIndex},${branchIndex},${range.count}`);
            branchIndex += 1;
        }));
        lines.push(`BRF:${file.metrics.branches.total}`, `BRH:${file.metrics.branches.covered}`);
        for (const line of file.lines) lines.push(`DA:${line.number},${line.count}`);
        lines.push(`LF:${file.metrics.lines.total}`, `LH:${file.metrics.lines.covered}`, 'end_of_record');
        records.push(lines.join('\n'));
    }
    return `${records.join('\n')}\n`;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function decimalPlaces(value) {
    const [coefficient, exponentText = '0'] = value.toString().toLowerCase().split('e');
    const fractionLength = coefficient.split('.')[1]?.length ?? 0;
    return Math.max(0, fractionLength - Number(exponentText));
}

function formatThresholdPercentage(value) {
    return `${value}%`;
}

function formatMeasurePercentage(item, required) {
    if (item.total === 0) return '100%';
    const denominator = BigInt(item.total);
    const numerator = BigInt(item.covered) * 100n;
    const whole = numerator / denominator;
    let remainder = numerator % denominator;
    if (remainder === 0n) return `${whole}%`;

    const precision = Math.min(20, Math.max(2, decimalPlaces(required ?? 0) + 1));
    let fraction = '';
    for (let index = 0; index < precision && remainder !== 0n; index += 1) {
        remainder *= 10n;
        fraction += remainder / denominator;
        remainder %= denominator;
    }
    if (remainder === 0n) fraction = fraction.replace(/0+$/, '');
    return `${whole}.${fraction}${remainder === 0n ? '' : '…'}%`;
}

function metricState(item, required, enforced = true) {
    if (!enforced || required === undefined) return 'neutral';
    return meetsThreshold(item, required) ? 'pass' : 'fail';
}

function unknownMetricCount(files, metric) {
    return files.filter((file) => file.unknownMetrics.includes(metric)).length;
}

function renderMetricCards(total, files, thresholds, enforcement) {
    return METRICS.map((metric) => {
        const item = total[metric];
        const unknown = unknownMetricCount(files, metric);
        const unavailable = enforcement.total && thresholds[metric] > 0 && unknown > 0;
        const state = unavailable ? 'fail' : metricState(item, thresholds[metric], enforcement.total);
        const requirement = unavailable
            ? `${unknown} included ${unknown === 1 ? 'file has' : 'files have'} unknown structure`
            : thresholds[metric] === undefined
            ? 'No minimum configured'
            : enforcement.total ? `${formatThresholdPercentage(thresholds[metric])} total minimum` : 'Total gate disabled';
        return `<article class="metric ${state}"><div><h2>${METRIC_LABELS[metric]}</h2><span>${state === 'pass' ? 'Passing' : state === 'fail' ? unavailable ? 'Unavailable' : 'Below gate' : 'Measured'}</span></div><strong>${unavailable ? 'Unknown' : formatMeasurePercentage(item, thresholds[metric])}</strong><p>${item.covered} of ${item.total} known ranges covered · ${requirement}</p><i aria-hidden="true"><b style="width:${unavailable ? 0 : item.pct}%"></b></i></article>`;
    }).join('');
}

function renderThresholdRows(summary, files, thresholds, enforcement) {
    const fileEntries = Object.entries(summary).filter(([key]) => key !== 'total');
    return METRICS.map((metric) => {
        const required = thresholds[metric];
        const unknown = required > 0 ? unknownMetricCount(files, metric) : 0;
        const totalState = required === undefined || !enforcement.total ? 'Not enforced' : unknown > 0 ? `${unknown} unknown` : meetsThreshold(summary.total[metric], required) ? 'Pass' : 'Fail';
        const failedFiles = required === undefined ? 0 : fileEntries.filter(([, record]) => !meetsThreshold(record[metric], required)).length;
        const fileProblems = failedFiles + unknown;
        const fileState = required === undefined || !enforcement.perFile ? 'Not enforced' : fileProblems === 0 ? 'Pass' : unknown > 0 && failedFiles === 0 ? `${unknown} unknown` : `${fileProblems} failing`;
        return `<tr><th scope="row">${METRIC_LABELS[metric]}</th><td>${required === undefined ? '—' : formatThresholdPercentage(required)}</td><td><span class="pill ${totalState === 'Pass' ? 'pass' : totalState === 'Fail' || totalState.endsWith('unknown') ? 'fail' : ''}">${totalState}</span></td><td><span class="pill ${fileState === 'Pass' ? 'pass' : fileState.endsWith('failing') || fileState.endsWith('unknown') ? 'fail' : ''}">${fileState}</span></td></tr>`;
    }).join('');
}

function renderFileRows(files, thresholds, enforcement) {
    if (files.length === 0) return '<tr><td colspan="6" class="empty">No source files were supplied.</td></tr>';
    return files.map((file) => `<tr><th scope="row"><code>${escapeHtml(file.reportPath)}</code></th><td><span class="pill ${file.loaded ? 'pass' : 'fail'}">${file.loaded ? 'Loaded' : 'Not loaded'}</span></td>${METRICS.map((metric) => {
        const item = file.metrics[metric];
        const unavailable = enforcement.perFile && thresholds[metric] > 0 && file.unknownMetrics.includes(metric);
        const state = unavailable ? 'fail' : metricState(item, thresholds[metric], enforcement.perFile);
        return `<td class="number ${state}"><strong>${unavailable ? 'Unknown' : formatMeasurePercentage(item, thresholds[metric])}</strong><small>${unavailable ? 'not inferred' : `${item.covered} / ${item.total}`}</small></td>`;
    }).join('')}</tr>`).join('');
}

function renderDefinitions() {
    return `${METRICS.map((metric) => `<tr><th scope="row">${METRIC_LABELS[metric]}</th><td>${escapeHtml(NATIVE_V8_METRIC_DEFINITIONS[metric])}</td></tr>`).join('')}<tr><th scope="row">Effective ranges</th><td>${escapeHtml(NATIVE_V8_METRIC_DEFINITIONS.effectiveRanges)}</td></tr><tr><th scope="row">Output interoperability</th><td>${escapeHtml(NATIVE_V8_METRIC_DEFINITIONS.interoperability)}</td></tr>`;
}

function renderHtml({ analysis, runtime, title, thresholds, enforcement, failures }) {
    const { summary, files } = analysis;
    const passing = failures.length === 0;
    const safeRuntime = escapeHtml(runtime);
    const safeTitle = escapeHtml(title);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${safeTitle} · ${safeRuntime}</title>
<style>
:root{color-scheme:dark;--bg:#07100f;--deep:#030807;--panel:#0b1715;--raised:#10201d;--line:#24433b;--strong:#37685b;--text:#effcf7;--muted:#9bb7ae;--lime:#b9f66f;--cyan:#75e6dc;--rose:#ff9dac;--mono:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;--sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{min-width:20rem;margin:0;background:radial-gradient(circle at 8% -8%,rgba(117,230,220,.13),transparent 28rem),radial-gradient(circle at 90% 14%,rgba(185,246,111,.09),transparent 25rem),var(--bg);color:var(--text);font:400 1rem/1.55 var(--sans)}body:before{position:fixed;z-index:-1;inset:0;background-image:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);background-size:48px 48px;content:"";mask-image:linear-gradient(to bottom,#000,transparent 78%)}main{width:min(82rem,calc(100% - 2rem));margin:auto;padding:clamp(2.5rem,7vw,5rem) 0}.eyebrow{margin:0 0 .65rem;color:var(--cyan);font:750 .78rem/1.4 var(--mono);letter-spacing:.12em;text-transform:uppercase}h1{max-width:16ch;margin:0;font-size:clamp(2.8rem,8vw,6rem);line-height:.96;letter-spacing:-.06em}.lede{max-width:52rem;margin:1.25rem 0 0;color:var(--muted);font-size:clamp(1rem,2vw,1.18rem)}.native{display:flex;gap:.65rem;margin-top:1rem;color:var(--muted);font-size:.92rem}.native:before{color:var(--lime);content:"◆"}.run{display:flex;margin:2.5rem 0 1rem;padding:1rem 1.2rem;border:1px solid var(--strong);border-radius:.9rem;background:rgba(11,23,21,.9);align-items:center;gap:.9rem}.run.fail{border-color:rgba(255,157,172,.55)}.mark{display:grid;width:2.2rem;height:2.2rem;place-items:center;border-radius:50%;background:rgba(185,246,111,.12);color:var(--lime);font-weight:900}.run.fail .mark{background:rgba(255,157,172,.12);color:var(--rose)}.run strong,.run span{display:block}.run span{color:var(--muted);font-size:.88rem}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem}.metric{padding:1.15rem;border:1px solid var(--line);border-radius:1rem;background:linear-gradient(145deg,var(--raised),var(--panel))}.metric.fail{border-color:rgba(255,157,172,.5)}.metric>div{display:flex;align-items:baseline;justify-content:space-between;gap:.5rem}.metric h2{margin:0;font-size:.86rem}.metric div span{color:var(--muted);font-size:.68rem;text-transform:uppercase}.metric.pass div span,.number.pass strong{color:var(--lime)}.metric.fail div span,.number.fail strong{color:var(--rose)}.metric>strong{display:block;margin:.7rem 0 0;font:800 clamp(1.9rem,4vw,3rem)/1 var(--mono);letter-spacing:-.06em}.metric p{min-height:2.5em;margin:.5rem 0 .8rem;color:var(--muted);font-size:.75rem}.metric i{display:block;height:.35rem;overflow:hidden;border-radius:1rem;background:var(--deep)}.metric i b{display:block;height:100%;background:linear-gradient(90deg,var(--cyan),var(--lime))}.metric.fail i b{background:var(--rose)}section{margin-top:3rem}.heading{display:flex;margin-bottom:.8rem;align-items:end;justify-content:space-between;gap:1rem}.heading h2{margin:0;font-size:clamp(1.35rem,3vw,1.8rem);letter-spacing:-.025em}.heading p{margin:0;color:var(--muted);font-size:.86rem}.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:1rem;background:rgba(11,23,21,.9)}table{width:100%;border-collapse:collapse}caption{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}th,td{padding:.82rem 1rem;border-bottom:1px solid var(--line);text-align:left}thead th{background:var(--raised);color:#bdd2cb;font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}tbody tr:last-child>*{border-bottom:0}tbody tr:hover{background:rgba(117,230,220,.035)}code{color:var(--cyan);font:650 .82rem/1.4 var(--mono);white-space:nowrap}.number{white-space:nowrap}.number strong,.number small{display:block}.number strong{font:750 .86rem/1.4 var(--mono)}.number small{color:var(--muted)}.pill{display:inline-flex;padding:.16rem .48rem;border:1px solid var(--line);border-radius:999px;color:#bdd2cb;font:700 .7rem/1.3 var(--mono);white-space:nowrap}.pill.pass{border-color:rgba(185,246,111,.35);background:rgba(185,246,111,.08);color:var(--lime)}.pill.fail{border-color:rgba(255,157,172,.42);background:rgba(255,157,172,.08);color:var(--rose)}.definitions td{color:var(--muted)}.definitions th{white-space:nowrap}.note{margin:.9rem 0 0;color:var(--muted);font-size:.84rem}.empty{padding:2rem;color:var(--muted);text-align:center}footer{margin-top:3rem;padding-top:1.2rem;border-top:1px solid var(--line);color:var(--muted);font-size:.8rem}@media(max-width:60rem){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:36rem){main{width:calc(100% - 1.25rem)}.metrics{grid-template-columns:1fr}.heading{align-items:start;flex-direction:column}}
</style>
</head>
<body>
<main>
<header><p class="eyebrow">${safeRuntime} · native V8 coverage</p><h1>${safeTitle}</h1><p class="lede">Coverage calculated directly from the executable ranges reported by V8.</p><p class="native">The source ran as written—without source instrumentation, transpilation, or runtime rewriting.</p></header>
<div class="run ${passing ? 'pass' : 'fail'}" role="status"><span class="mark" aria-hidden="true">${passing ? '✓' : '!'}</span><div><strong>${passing ? 'Coverage gates passed' : 'Coverage gates need attention'}</strong><span>${passing ? 'Every enabled total and per-file gate is satisfied.' : `${failures.length} enabled ${failures.length === 1 ? 'gate needs' : 'gates need'} attention.`}</span></div></div>
<div class="metrics" aria-label="Aggregate native coverage metrics">${renderMetricCards(summary.total, files, thresholds, enforcement)}</div>
<section aria-labelledby="thresholds"><div class="heading"><h2 id="thresholds">Thresholds</h2><p>Total: ${enforcement.total ? 'enforced' : 'not enforced'} · Per file: ${enforcement.perFile ? 'enforced' : 'not enforced'}</p></div><div class="table-wrap"><table><caption>Threshold results</caption><thead><tr><th scope="col">Metric</th><th scope="col">Minimum</th><th scope="col">Total</th><th scope="col">Per file</th></tr></thead><tbody>${renderThresholdRows(summary, files, thresholds, enforcement)}</tbody></table></div></section>
<section aria-labelledby="files"><div class="heading"><h2 id="files">Files</h2><p>${files.length} ${files.length === 1 ? 'source' : 'sources'} measured</p></div><div class="table-wrap"><table><caption>Native coverage by source file</caption><thead><tr><th scope="col">Source</th><th scope="col">V8 state</th>${METRICS.map((metric) => `<th scope="col">${METRIC_LABELS[metric]}</th>`).join('')}</tr></thead><tbody>${renderFileRows(files, thresholds, enforcement)}</tbody></table></div></section>
<section class="definitions" aria-labelledby="definitions"><div class="heading"><h2 id="definitions">How these metrics work</h2><p>Transparent range semantics</p></div><div class="table-wrap"><table><caption>Native metric definitions</caption><tbody>${renderDefinitions()}<tr><th scope="row">Included, not loaded</th><td>${escapeHtml(NATIVE_V8_METRIC_DEFINITIONS.unloaded)}</td></tr></tbody></table></div><p class="note">These measurements deliberately describe V8 ranges. They do not claim parser-derived statement or branch semantics.</p></section>
<footer>vanilla-test · ${safeRuntime} · Project-owned native V8 reporter</footer>
</main>
</body>
</html>
`;
}

/**
 * Generate coverage-summary.json, lcov.info, and a standalone index.html from
 * normalized native V8 scripts. Output is dependency-free and deterministic:
 * it contains no timestamps, random identifiers, remote assets, or scripts.
 *
 * @param {{scripts: Array<object>, includedFiles?: Array<string|object>, root?: string, outputDirectory: string, runtime?: string, title?: string, thresholds?: Record<string, number>, enforcement?: {total?: boolean, perFile?: boolean}}} options Report options.
 * @returns {Promise<Readonly<{outputDirectory: string, summaryPath: string, lcovPath: string, htmlPath: string, summary: object, files: ReadonlyArray<object>, failures: ReturnType<typeof getThresholdFailures>, passed: boolean}>>} Paths and threshold results.
 */
export async function writeNativeCoverageReport(options) {
    const source = object(options, 'options');
    const outputDirectory = path.resolve(nonemptyString(source.outputDirectory, 'options.outputDirectory'));
    for (const key of ['runtime', 'title', 'root']) {
        if (source[key] !== undefined) nonemptyString(source[key], `options.${key}`);
    }
    const runtime = source.runtime ?? 'V8';
    const title = source.title ?? 'vanilla-test coverage';
    const thresholds = normalizeThresholds(source.thresholds);
    const enforcement = normalizeEnforcement(source.enforcement);
    const analysis = await analyzeNativeCoverage({
        scripts: source.scripts,
        includedFiles: source.includedFiles,
        root: source.root
    });
    const failures = getThresholdFailures(analysis, thresholds, enforcement);
    const summaryPath = path.join(outputDirectory, 'coverage-summary.json');
    const lcovOutputPath = path.join(outputDirectory, 'lcov.info');
    const htmlPath = path.join(outputDirectory, 'index.html');
    await fs.mkdir(outputDirectory, { recursive: true });
    await Promise.all([
        fs.writeFile(summaryPath, `${JSON.stringify(analysis.summary, null, 2)}\n`, 'utf8'),
        fs.writeFile(lcovOutputPath, renderLcov(analysis.files, runtime), 'utf8'),
        fs.writeFile(htmlPath, renderHtml({ analysis, runtime, title, thresholds, enforcement, failures }), 'utf8')
    ]);
    return Object.freeze({
        outputDirectory,
        summaryPath,
        lcovPath: lcovOutputPath,
        htmlPath,
        summary: analysis.summary,
        files: analysis.files,
        failures,
        passed: failures.length === 0
    });
}

export { getThresholdFailures as computeThresholdFailures };
