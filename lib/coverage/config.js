import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { globToRegExp } from './glob.js';

const METRICS = Object.freeze(['statements', 'branches', 'functions', 'lines']);
const TOP_KEYS = new Set(['entry', 'reportsDirectory', 'thresholds', 'node', 'chrome', 'timeoutMs']);
const NODE_KEYS = new Set(['include']);
const CHROME_KEYS = new Set(['include', 'imports', 'headless', 'executablePath']);

function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object.`);
    }
    return value;
}

function rejectUnknown(value, allowed, label) {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw new TypeError(`${label} contains unknown key ${JSON.stringify(key)}.`);
        }
    }
}

function string(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${label} must be a nonempty string.`);
    }
    return value;
}

function inside(root, target, label, allowRoot = false) {
    const relative = path.relative(root, target);
    if ((!allowRoot && relative === '') || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new RangeError(`${label} must stay inside ${root}.`);
    }
    return target;
}

function projectPath(root, value, label, allowRoot = false) {
    const target = inside(root, path.resolve(root, string(value, label)), label, allowRoot);
    let anchor = target;
    while (!fs.existsSync(anchor)) {
        const parent = path.dirname(anchor);
        if (parent === anchor) break;
        anchor = parent;
    }
    const realRoot = fs.realpathSync(root);
    const realAnchor = fs.realpathSync(anchor);
    inside(realRoot, path.resolve(realAnchor, path.relative(anchor, target)), label, allowRoot);
    return target;
}

function includes(value, label) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new TypeError(`${label} must be a nonempty array.`);
    }

    return Object.freeze(value.map((item, index) => {
        const pattern = string(item, `${label}[${index}]`).replaceAll('\\', '/');
        if (path.posix.isAbsolute(pattern) || path.win32.isAbsolute(pattern) || pattern === '..'
            || pattern.startsWith('../') || pattern.includes('/../') || pattern.startsWith('!')) {
            throw new RangeError(`${label}[${index}] must be a positive project-relative glob.`);
        }
        return pattern;
    }));
}

function matchedFiles(root, patterns, label) {
    const expressions = patterns.map(globToRegExp);
    const pending = [root];
    let count = 0;
    while (pending.length) {
        const directory = pending.pop();
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === 'coverage' || entry.name === '.git') continue;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) pending.push(absolute);
            if (entry.isFile()) {
                const relative = path.relative(root, absolute).split(path.sep).join('/');
                if (expressions.some((expression) => expression.test(relative))) count += 1;
            }
        }
    }
    if (count === 0) throw new Error(`${label} did not match any files inside ${root}.`);
}

function thresholds(value) {
    const source = object(value, 'thresholds');
    rejectUnknown(source, new Set(METRICS), 'thresholds');
    const result = {};
    for (const metric of METRICS) {
        const threshold = source[metric];
        if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
            throw new RangeError(`thresholds.${metric} must be a number from 0 through 100.`);
        }
        result[metric] = threshold;
    }
    return Object.freeze(result);
}

function timeout(value, label = 'timeoutMs') {
    if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) {
        throw new RangeError(`${label} must be an integer from 1 through 3600000.`);
    }
    return value;
}

function browserImports(root, value) {
    const source = object(value, 'chrome.imports');
    const result = {};

    for (const [specifier, target] of Object.entries(source)) {
        string(specifier, 'chrome import specifier');
        const localTarget = string(target, `chrome.imports.${specifier}`);
        if (/^[a-z][a-z\d+.-]*:/i.test(localTarget) || localTarget.startsWith('//')) {
            throw new RangeError(`chrome.imports.${specifier} must refer to a file inside the project.`);
        }
        const absolute = projectPath(root, localTarget.replace(/^\//, ''), `chrome.imports.${specifier}`, true);
        if (!fs.existsSync(absolute)) {
            throw new Error(`chrome.imports.${specifier} does not exist: ${absolute}`);
        }
        result[specifier] = `/${path.relative(root, absolute).split(path.sep).map(encodeURIComponent).join('/')}`;
    }

    return result;
}

function defaultImports(root) {
    let isPackageRoot = false;
    try {
        isPackageRoot = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name === 'vanilla-test';
    } catch {
        // A consuming project need not have a package manifest.
    }
    const packageRoot = isPackageRoot ? root : path.join(root, 'node_modules', 'vanilla-test');
    const dependency = (name) => {
        const nested = path.join(packageRoot, 'node_modules', name, 'index.js');
        return fs.existsSync(nested) ? nested : path.join(root, 'node_modules', name, 'index.js');
    };
    const candidates = {
        'vanilla-test': path.join(packageRoot, 'index.js'),
        'ansi-colors-es6': dependency('ansi-colors-es6'),
        'strong-type': dependency('strong-type')
    };
    const result = {};

    for (const [specifier, filePath] of Object.entries(candidates)) {
        if (fs.existsSync(filePath)) {
            result[specifier] = `/${path.relative(root, filePath).split(path.sep).map(encodeURIComponent).join('/')}`;
        }
    }

    return result;
}

export function loadConfig(configArgument, overrides = {}) {
    const target = overrides.target ?? 'all';
    if (!['all', 'node', 'chrome'].includes(target)) {
        throw new TypeError(`Unknown coverage target: ${target}`);
    }
    const needsNode = target === 'all' || target === 'node';
    const needsChrome = target === 'all' || target === 'chrome';
    const configPath = path.resolve(process.cwd(), configArgument || 'vanilla-test.config.json');
    if (!fs.existsSync(configPath)) {
        throw new Error(`Configuration file not found: ${configPath}`);
    }

    let source;
    try {
        source = object(JSON.parse(fs.readFileSync(configPath, 'utf8')), 'configuration');
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new SyntaxError(`Invalid JSON in ${configPath}: ${error.message}`);
        }
        throw error;
    }

    rejectUnknown(source, TOP_KEYS, 'configuration');
    const root = path.dirname(configPath);
    const entry = projectPath(root, source.entry, 'entry');
    if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
        throw new Error(`entry is not a file: ${entry}`);
    }

    const reportsDirectory = projectPath(root, source.reportsDirectory ?? './coverage', 'reportsDirectory');
    const thresholdValues = thresholds(source.thresholds ?? Object.fromEntries(METRICS.map((metric) => [metric, 100])));

    const nodeSource = needsNode ? object(source.node, 'node') : null;
    if (nodeSource) rejectUnknown(nodeSource, NODE_KEYS, 'node');
    const chromeSource = needsChrome ? object(source.chrome, 'chrome') : null;
    if (chromeSource) rejectUnknown(chromeSource, CHROME_KEYS, 'chrome');

    if (chromeSource?.headless !== undefined && typeof chromeSource.headless !== 'boolean') {
        throw new TypeError('chrome.headless must be a boolean.');
    }
    if (chromeSource?.executablePath !== undefined && chromeSource.executablePath !== null) {
        string(chromeSource.executablePath, 'chrome.executablePath');
    }
    if (needsChrome && overrides.chromePath !== undefined) {
        string(overrides.chromePath, '--chrome-path');
    }

    const configuredImports = needsChrome ? browserImports(root, chromeSource.imports ?? {}) : {};
    const timeoutMs = overrides.timeoutMs === undefined
        ? timeout(source.timeoutMs ?? 30_000)
        : timeout(overrides.timeoutMs, '--timeout-ms');

    const nodeInclude = needsNode ? includes(nodeSource.include, 'node.include') : Object.freeze([]);
    const chromeInclude = needsChrome ? includes(chromeSource.include, 'chrome.include') : Object.freeze([]);
    if (needsNode) matchedFiles(root, nodeInclude, 'node.include');
    if (needsChrome) matchedFiles(root, chromeInclude, 'chrome.include');

    return Object.freeze({
        configPath,
        root,
        entry,
        entryUrl: `/${path.relative(root, entry).split(path.sep).map(encodeURIComponent).join('/')}`,
        reportsDirectory,
        thresholds: thresholdValues,
        timeoutMs,
        node: Object.freeze({ include: nodeInclude }),
        chrome: Object.freeze({
            include: chromeInclude,
            imports: Object.freeze(needsChrome ? { ...defaultImports(root), ...configuredImports } : {}),
            headless: needsChrome && overrides.headed ? false : (chromeSource?.headless ?? true),
            executablePath: needsChrome && overrides.chromePath
                ? path.resolve(process.cwd(), overrides.chromePath)
                : (chromeSource?.executablePath ? path.resolve(root, chromeSource.executablePath) : null)
        })
    });
}

export function packagePathFromModule(moduleUrl) {
    return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', '..', 'package.json');
}

export { METRICS };
