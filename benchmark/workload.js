const MASK = 0x5a5a5a5a;
const OFFSET = 17;

export function executeCase(index) {
    const actual = ((index + OFFSET) ^ MASK) >>> 0;
    const expected = ((index + 17) ^ 0x5a5a5a5a) >>> 0;
    if (actual !== expected) throw new Error(`case ${index} produced ${actual}, expected ${expected}`);
    return actual;
}

export function updateChecksum(checksum, value) {
    return Math.imul((checksum ^ value) >>> 0, 16_777_619) >>> 0;
}

export function caseName(index) {
    return `case ${index}`;
}

export function expectedChecksum(caseCount) {
    let checksum = 2_166_136_261;
    for (let index = 0; index < caseCount; index += 1) {
        checksum = updateChecksum(checksum, ((index + OFFSET) ^ MASK) >>> 0);
    }
    return checksum;
}
