import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { selectRun, summarizeResult, validateResult } from './result.js';

const HARNESS_EXIT = 2;

function withTimeout(promise, timeoutMs) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Test entry timed out after ${timeoutMs} ms.`)), timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function run() {
    const [, , entryPath, timeoutText, resultPath] = process.argv;
    const timeoutMs = Number(timeoutText);

    if (!entryPath || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new TypeError('The internal entry runner received invalid arguments.');
    }

    const result = await withTimeout((async () => {
        const entryUrl = pathToFileURL(entryPath).href;
        const moduleNamespace = await import(entryUrl);
        const execute = selectRun(moduleNamespace, entryPath);
        return execute();
    })(), timeoutMs);
    const output = resultPath
        ? summarizeResult(result, 'node', entryPath)
        : validateResult(result, entryPath);

    if (resultPath) {
        await fs.writeFile(
            resultPath,
            `${JSON.stringify(output, null, 2)}\n`,
            { encoding: 'utf8', flag: 'wx', mode: 0o600 }
        );
    }

    process.exit(output.ok ? 0 : 1);
}

try {
    await run();
} catch (error) {
    console.error(`vanilla-test coverage: ${error?.stack || error}`);
    process.exit(HARNESS_EXIT);
}
