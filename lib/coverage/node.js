import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

function c8Path() {
    try {
        return require.resolve('c8/bin/c8.js');
    } catch (error) {
        throw new Error('c8 is required for Node coverage. Install the package dependencies.', { cause: error });
    }
}

export async function runNodeCoverage(config, signal) {
    const outputDirectory = path.join(config.reportsDirectory, 'node');
    const tempDirectory = path.join(outputDirectory, '.tmp');
    await fs.rm(outputDirectory, { recursive: true, force: true });
    const internalRunner = fileURLToPath(new URL('./entry-runner.js', import.meta.url));
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
    args.push(process.execPath, internalRunner, config.entry, String(config.timeoutMs));

    try {
        return await new Promise((resolve, reject) => {
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
    } finally {
        await fs.rm(tempDirectory, { recursive: true, force: true });
    }
}
