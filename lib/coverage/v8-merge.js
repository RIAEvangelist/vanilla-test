const MAX_COUNT = Number.MAX_SAFE_INTEGER;

function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object.`);
    }
    return value;
}

function safeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${label} must be a nonnegative safe integer.`);
    }
    return value;
}

function addCounts(left, right, label) {
    if (left > MAX_COUNT - right) {
        throw new RangeError(`${label} exceeds Number.MAX_SAFE_INTEGER.`);
    }
    return left + right;
}

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function compareRanges(left, right) {
    return left.startOffset - right.startOffset
        || right.endOffset - left.endOffset
        || left.count - right.count;
}

function validateRangeTree(ranges, label) {
    const ordered = [...ranges].sort(compareRanges);
    const stack = [];

    for (const range of ordered) {
        while (stack.length > 0 && stack.at(-1).endOffset <= range.startOffset) stack.pop();

        const parent = stack.at(-1);
        if (parent) {
            if (range.startOffset === parent.startOffset && range.endOffset === parent.endOffset) {
                throw new RangeError(`${label} contains duplicate range boundaries.`);
            }
            if (range.endOffset > parent.endOffset) {
                throw new RangeError(`${label} contains partially overlapping ranges.`);
            }
        }

        stack.push(range);
    }
}

function normalizeFunction(value, sourceLength, label) {
    const source = object(value, label);
    if (typeof source.functionName !== 'string') {
        throw new TypeError(`${label}.functionName must be a string.`);
    }
    if (typeof source.isBlockCoverage !== 'boolean') {
        throw new TypeError(`${label}.isBlockCoverage must be a boolean.`);
    }
    if (!Array.isArray(source.ranges) || source.ranges.length === 0) {
        throw new TypeError(`${label}.ranges must be a nonempty array.`);
    }

    const ranges = source.ranges.map((valueRange, rangeIndex) => {
        const rangeLabel = `${label}.ranges[${rangeIndex}]`;
        const input = object(valueRange, rangeLabel);
        const startOffset = safeInteger(input.startOffset, `${rangeLabel}.startOffset`);
        const endOffset = safeInteger(input.endOffset, `${rangeLabel}.endOffset`);
        const count = safeInteger(input.count, `${rangeLabel}.count`);
        if (endOffset <= startOffset) {
            throw new RangeError(`${rangeLabel} must be nonempty.`);
        }
        if (sourceLength !== undefined && endOffset > sourceLength) {
            throw new RangeError(`${rangeLabel} must stay inside the source.`);
        }
        return Object.freeze({ startOffset, endOffset, count });
    });

    const root = ranges[0];
    for (let rangeIndex = 1; rangeIndex < ranges.length; rangeIndex += 1) {
        const range = ranges[rangeIndex];
        if (range.startOffset < root.startOffset || range.endOffset > root.endOffset) {
            throw new RangeError(`${label}.ranges[${rangeIndex}] must stay inside the function root range.`);
        }
    }
    validateRangeTree(ranges, `${label}.ranges`);

    return Object.freeze({
        functionName: source.functionName,
        isBlockCoverage: source.isBlockCoverage,
        ranges: Object.freeze(ranges),
        root
    });
}

function normalizeRecords(records, sourceLength) {
    if (!Array.isArray(records)) throw new TypeError('records must be an array.');
    if (sourceLength !== undefined) safeInteger(sourceLength, 'sourceLength');

    return Object.freeze(records.map((value, recordIndex) => {
        const label = `records[${recordIndex}]`;
        const record = object(value, label);
        if (!Array.isArray(record.functions)) {
            throw new TypeError(`${label}.functions must be an array.`);
        }

        const functions = record.functions.map((entry, functionIndex) => (
            normalizeFunction(entry, sourceLength, `${label}.functions[${functionIndex}]`)
        ));
        const identities = new Set();
        for (const entry of functions) {
            const identity = `${entry.root.startOffset}:${entry.root.endOffset}`;
            if (identities.has(identity)) {
                throw new RangeError(`${label}.functions contains duplicate root range ${identity}.`);
            }
            identities.add(identity);
        }

        return Object.freeze({ functions: Object.freeze(functions) });
    }));
}

function effectiveCount(entry, startOffset, endOffset) {
    if (!entry) return 0;
    let selected = entry.root;
    let selectedLength = selected.endOffset - selected.startOffset;

    for (let index = 1; index < entry.ranges.length; index += 1) {
        const range = entry.ranges[index];
        if (range.startOffset <= startOffset && range.endOffset >= endOffset) {
            const length = range.endOffset - range.startOffset;
            if (length < selectedLength || (length === selectedLength && range.count < selected.count)) {
                selected = range;
                selectedLength = length;
            }
        }
    }

    return selected.count;
}

function coalesceSegments(segments) {
    const output = [];
    for (const segment of segments) {
        const previous = output.at(-1);
        if (previous && previous.endOffset === segment.startOffset && previous.count === segment.count) {
            previous.endOffset = segment.endOffset;
        } else {
            output.push({ ...segment });
        }
    }
    return output;
}

function deterministicName(entries) {
    const names = [...new Set(entries.map((entry) => entry?.functionName).filter((name) => name))];
    names.sort(compareText);
    return names[0] ?? '';
}

function unionNodes(ordered) {
    const nodes = [];
    const stack = [];
    for (const range of ordered) {
        while (stack.length > 0 && stack.at(-1).range.endOffset <= range.startOffset) stack.pop();
        const parent = stack.at(-1) ?? null;
        if (parent && range.endOffset > parent.range.endOffset) return null;
        const node = { range, parent };
        nodes.push(node);
        stack.push(node);
    }
    return nodes;
}

function flatEffectiveRanges(entries, root, ordered) {
    const boundaries = [...new Set(ordered.flatMap((range) => [range.startOffset, range.endOffset]))]
        .sort((left, right) => left - right);
    const rootCount = entries.reduce((total, entry) => (
        addCounts(total, entry?.root.count ?? 0, 'Merged function count')
    ), 0);
    const segments = [];
    for (let index = 0; index < boundaries.length - 1; index += 1) {
        const startOffset = boundaries[index];
        const endOffset = boundaries[index + 1];
        let count = 0;
        for (const entry of entries) {
            count = addCounts(count, effectiveCount(entry, startOffset, endOffset), 'Merged range count');
        }
        segments.push({ startOffset, endOffset, count });
    }

    let overrides = coalesceSegments(segments.filter((segment) => segment.count !== rootCount));
    if (overrides.length === 1
        && overrides[0].startOffset === root.startOffset
        && overrides[0].endOffset === root.endOffset) {
        const splitOffset = boundaries.find((offset) => offset > root.startOffset && offset < root.endOffset);
        if (!splitOffset) {
            throw new RangeError('Merged effective coverage cannot be represented without a distinct inner boundary.');
        }
        const [override] = overrides;
        overrides = [
            { startOffset: override.startOffset, endOffset: splitOffset, count: override.count },
            { startOffset: splitOffset, endOffset: override.endOffset, count: override.count }
        ];
    }

    return [
        { startOffset: root.startOffset, endOffset: root.endOffset, count: rootCount },
        ...overrides
    ];
}

function mergeFunction(entries, root) {
    const rangesByBoundary = new Map();
    let isBlockCoverage = false;

    for (const entry of entries) {
        if (!entry) continue;
        isBlockCoverage ||= entry.isBlockCoverage;
        for (const range of entry.ranges) {
            const identity = `${range.startOffset}:${range.endOffset}`;
            rangesByBoundary.set(identity, {
                startOffset: range.startOffset,
                endOffset: range.endOffset,
                count: 0
            });
        }
    }

    const ordered = [...rangesByBoundary.values()].sort(compareRanges);
    const nodes = unionNodes(ordered);
    for (const range of ordered) {
        for (const entry of entries) {
            range.count = addCounts(
                range.count,
                effectiveCount(entry, range.startOffset, range.endOffset),
                'Merged range count'
            );
        }
    }

    const rootNode = nodes?.[0];
    if (nodes && (!rootNode
        || rootNode.range.startOffset !== root.startOffset
        || rootNode.range.endOffset !== root.endOffset
        || rootNode.parent !== null)) {
        throw new RangeError('Merged function ranges must have one enclosing root range.');
    }
    const ranges = nodes
        ? nodes
            .filter((node) => node.parent === null || node.range.count !== node.parent.range.count)
            .map((node) => node.range)
        : flatEffectiveRanges(entries, root, ordered);

    return Object.freeze({
        functionName: deterministicName(entries),
        ranges: Object.freeze(ranges.map((range) => Object.freeze(range))),
        isBlockCoverage: isBlockCoverage || ranges.length > 1
    });
}

/**
 * Merge V8 ScriptCoverage entries that refer to the same physical source.
 *
 * V8 omits a nested range when its count equals the enclosing range. Different
 * executions can consequently describe the same function with different range
 * trees. This merger partitions every function at the union of all observed
 * boundaries, resolves the innermost effective count in each input, sums those
 * counts, and reconstructs a deterministic union range tree beneath the original
 * function root. A union node whose merged count equals its parent is collapsed
 * in the same lossless way V8 collapses an equal-count nested range. If otherwise
 * valid executions contain mutually crossing range trees, the output falls back
 * to deterministic disjoint effective ranges because both trees cannot coexist
 * in V8's nested range shape.
 *
 * `url` and `scriptId` are intentionally ignored, so query-string variants and
 * records from multiple processes can be combined after the caller establishes
 * that they are the same source. Passing the same execution twice counts it
 * twice. Function identity is its root offset pair; inputs must therefore come
 * from byte-for-byte equivalent source. The normalized output preserves exact
 * pointwise counts and, when the union remains nested, every observed range
 * identity except redundant equal-count nodes. It cannot recover a range that
 * V8 omitted in every input or preserve identities that cross between inputs.
 * If labels for one root differ, the first nonempty name in lexical order is
 * selected so record ordering cannot affect the result.
 *
 * @param {Array<{functions: Array}>} records V8 ScriptCoverage-shaped records.
 * @param {number} [sourceLength] Optional UTF-16 source length for bounds checks.
 * @returns {{functions: Array}}
 */
export function mergeV8ScriptCoverage(records, sourceLength) {
    const normalized = normalizeRecords(records, sourceLength);
    const groups = new Map();

    normalized.forEach((record, recordIndex) => {
        for (const entry of record.functions) {
            const identity = `${entry.root.startOffset}:${entry.root.endOffset}`;
            let group = groups.get(identity);
            if (!group) {
                group = {
                    root: Object.freeze({
                        startOffset: entry.root.startOffset,
                        endOffset: entry.root.endOffset
                    }),
                    entries: Array(normalized.length).fill(null)
                };
                groups.set(identity, group);
            }
            group.entries[recordIndex] = entry;
        }
    });

    const orderedGroups = [...groups.values()].sort((left, right) => (
        left.root.startOffset - right.root.startOffset
        || right.root.endOffset - left.root.endOffset
        || compareText(deterministicName(left.entries), deterministicName(right.entries))
    ));

    return Object.freeze({
        functions: Object.freeze(orderedGroups.map((group) => mergeFunction(group.entries, group.root)))
    });
}
