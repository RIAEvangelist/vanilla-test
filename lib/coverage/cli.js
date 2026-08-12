import fs from 'node:fs';

import { runChromeCoverage } from './chrome.js';
import { loadConfig, packagePathFromModule } from './config.js';
import { runNodeCoverage } from './node.js';

const HELP = `vanilla-test coverage [all|node|chrome] [options]

Collect uninstrumented native V8 coverage in Node, Google Chrome, or both.

Options:
  --config <path>       JSON configuration (default: vanilla-test.config.json)
  --chrome-path <path>  Use an explicit Google Chrome executable
  --headed              Show Chrome while the browser suite runs
  --timeout-ms <ms>     Override the configured test timeout
  --help                Show this help
  --version             Show the installed vanilla-test version`;

function value(args, index, option) {
    if (index + 1 >= args.length || args[index + 1].startsWith('--')) {
        throw new TypeError(`${option} requires a value.`);
    }
    return args[index + 1];
}

export function parseArguments(args) {
    const result = { target: 'all' };
    let index = 0;

    if (args[index] === 'coverage') index += 1;
    if (['all', 'node', 'chrome'].includes(args[index])) result.target = args[index++];

    const seen = new Set();
    while (index < args.length) {
        const option = args[index];
        if (!['--config', '--chrome-path', '--headed', '--timeout-ms', '--help', '--version'].includes(option)) {
            throw new TypeError(`Unknown argument: ${option}`);
        }
        if (seen.has(option)) throw new TypeError(`Duplicate option: ${option}`);
        seen.add(option);

        if (option === '--config') {
            result.config = value(args, index, option);
            index += 2;
        } else if (option === '--chrome-path') {
            result.chromePath = value(args, index, option);
            index += 2;
        } else if (option === '--timeout-ms') {
            const raw = value(args, index, option);
            const timeoutMs = Number(raw);
            if (!/^\d+$/.test(raw) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
                throw new TypeError('--timeout-ms must be a positive integer.');
            }
            result.timeoutMs = timeoutMs;
            index += 2;
        } else {
            result[option.slice(2)] = true;
            index += 1;
        }
    }
    return result;
}

function version() {
    return JSON.parse(fs.readFileSync(packagePathFromModule(import.meta.url), 'utf8')).version;
}

function combine(codes) {
    if (codes.includes(130)) return 130;
    if (codes.includes(2)) return 2;
    if (codes.includes(1)) return 1;
    return 0;
}

export async function main(args) {
    try {
        const options = parseArguments(args);
        if (options.help || args.length === 0) {
            console.log(HELP);
            return 0;
        }
        if (options.version) {
            console.log(version());
            return 0;
        }
        if (args[0] !== 'coverage' && !['all', 'node', 'chrome'].includes(args[0])) {
            throw new TypeError('Expected the coverage command.');
        }

        const config = loadConfig(options.config, options);
        const controller = new AbortController();
        let interrupted = false;
        const interrupt = () => {
            interrupted = true;
            controller.abort();
        };
        process.once('SIGINT', interrupt);
        process.once('SIGTERM', interrupt);

        try {
            const codes = [];
            if (options.target === 'all' || options.target === 'node') {
                codes.push(await runNodeCoverage(config, controller.signal));
            }
            if (!interrupted && (options.target === 'all' || options.target === 'chrome')) {
                codes.push(await runChromeCoverage(config, controller.signal));
            }
            return interrupted ? 130 : combine(codes);
        } finally {
            process.removeListener('SIGINT', interrupt);
            process.removeListener('SIGTERM', interrupt);
        }
    } catch (error) {
        console.error(`vanilla-test coverage: ${error?.stack || error}`);
        return 2;
    }
}

export { HELP };
