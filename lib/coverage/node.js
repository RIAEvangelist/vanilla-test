import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createOutputTransaction } from './output.js';

const require = createRequire(import.meta.url);

function c8Path() {
    try {
        return require.resolve('c8/bin/c8.js');
    } catch (error) {
        throw new Error('c8 is required for Node coverage. Install the package dependencies.', { cause: error });
    }
}

export async function runNodeCoverage(config, signal) {
    const finalDirectory = path.join(config.reportsDirectory, 'node');
    const output = await createOutputTransaction(finalDirectory, 'node');
    const outputDirectory = output.directory;
    const tempDirectory = path.join(outputDirectory, '.tmp');
    const internalRunner = fileURLToPath(new URL('./entry-runner.js', import.meta.url));
    let resultDirectory;

    try {
        resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vanilla-test-node-result-'));
        const resultFile = path.join(resultDirectory, 'test-results.json');
        const args = [
            c8Path(),
            '--all',
            '--check-coverage',
            '--per-file',
            '--clean',
            '--report-dir', outputDirectory,
            '--temp-directory', tempDirectory,
            '--reporter', 'text',
            '--reporter', 'html',
            '--reporter', 'lcov',
            '--reporter', 'json-summary'
        ];

        for (const [metric, threshold] of Object.entries(config.thresholds)) {
            args.push(`--${metric}`, String(threshold));
        }
        for (const pattern of config.node.include) {
            args.push('--include', pattern);
        }
        args.push(process.execPath, internalRunner, config.entry, String(config.timeoutMs), resultFile);

        const code = await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                callback(value);
            };
            const child = spawn(process.execPath, args, {
                cwd: config.root,
                stdio: 'inherit',
                windowsHide: true,
                signal
            });
            child.once('error', (error) => {
                if (signal?.aborted || error?.name === 'AbortError') {
                    finish(resolve, 130);
                    return;
                }
                finish(reject, error);
            });
            child.once('close', (code, childSignal) => {
                if (childSignal || signal?.aborted) {
                    finish(resolve, 130);
                    return;
                }
                finish(resolve, code === 0 ? 0 : code === 1 ? 1 : 2);
            });
        });

        if (code === 0 || code === 1) {
            await fs.copyFile(resultFile, path.join(outputDirectory, 'test-results.json'));
            await fs.rm(tempDirectory, { recursive: true, force: true });
            await output.commit();
        }
        return code;
    } finally {
        await fs.rm(tempDirectory, { recursive: true, force: true });
        if (resultDirectory) await fs.rm(resultDirectory, { recursive: true, force: true });
        await output.cleanup();
    }
}
