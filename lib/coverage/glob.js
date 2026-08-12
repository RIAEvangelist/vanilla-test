import path from 'node:path';

const ESCAPED = /[|\\{}()[\]^$+?.]/g;

export function toPosix(value) {
    return value.split(path.sep).join('/');
}

export function globToRegExp(pattern) {
    let expression = '^';

    for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index];

        if (character === '*') {
            if (pattern[index + 1] === '*') {
                index += 1;
                if (pattern[index + 1] === '/') {
                    index += 1;
                    expression += '(?:.*/)?';
                } else {
                    expression += '.*';
                }
            } else {
                expression += '[^/]*';
            }
            continue;
        }

        if (character === '?') {
            expression += '[^/]';
            continue;
        }

        expression += character.replace(ESCAPED, '\\$&');
    }

    return new RegExp(`${expression}$`);
}

export function createIncludeMatcher(root, patterns) {
    const expressions = patterns.map((pattern) => globToRegExp(toPosix(pattern)));

    return (filePath) => {
        const relative = toPosix(path.relative(root, filePath));
        return relative !== '..'
            && !relative.startsWith('../')
            && expressions.some((expression) => expression.test(relative));
    };
}
