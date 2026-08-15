import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createIncludeMatcher, listIncludedFiles } from './glob.js';
import { writeNativeCoverageReport } from './native-report.js';
import { createOutputTransaction } from './output.js';
import { mergeV8ScriptCoverage } from './v8-merge.js';

function localFilePath(url) {
    if (typeof url !== 'string' || !url.startsWith('file:')) return null;
    try {
        return fileURLToPath(url);
    } catch {
        return null;
    }
}

async function readCoverageScripts(tempDirectory, config) {
    const matches = createIncludeMatcher(config.root, config.node.include);
    const scripts = new Map();
    const entries = (await fs.readdir(tempDirectory, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

        let coverage;
        try {
            coverage = JSON.parse(await fs.readFile(path.join(tempDirectory, entry.name), 'utf8'));
        } catch (error) {
            throw new Error(`Unable to read native Node coverage file ${entry.name}.`, { cause: error });
        }

        if (!Array.isArray(coverage?.result)) continue;
        for (const script of coverage.result) {
            const filePath = localFilePath(script?.url);
            if (!filePath || !matches(filePath)) continue;
            const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
            let grouped = scripts.get(key);
            if (!grouped) {
                grouped = {
                    filePath,
                    url: script.url,
                    source: await fs.readFile(filePath, 'utf8'),
                    records: []
                };
                scripts.set(key, grouped);
            }
            grouped.records.push(script);
        }
    }

    return [...scripts.values()].map(({ records, ...script }) => ({
        ...script,
        functions: mergeV8ScriptCoverage(records, script.source.length).functions
    }));
}

function runEntry(config, tempDirectory, resultFile, signal) {
    const internalRunner = fileURLToPath(new URL('./entry-runner.js', import.meta.url));
    if (signal?.aborted) return Promise.resolve(130);

    return new Promise((resolve, reject) => {
        let settled = false;
        let timedOut = false;
        let aborted = false;
        let timer;
        let forceTimer;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(forceTimer);
            signal?.removeEventListener('abort', onAbort);
            callback(value);
        };
        const child = spawn(
            process.execPath,
            [internalRunner, config.entry, String(config.timeoutMs), resultFile],
            {
                cwd: config.root,
                env: { ...process.env, NODE_V8_COVERAGE: tempDirectory },
                stdio: 'inherit',
                windowsHide: true
            }
        );
        const terminate = () => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            child.kill();
            forceTimer = setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            }, 500);
            forceTimer.unref?.();
        };
        const onAbort = () => {
            aborted = true;
            terminate();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
            timedOut = true;
            console.error(`vanilla-test coverage: Test entry timed out after ${config.timeoutMs} ms.`);
            terminate();
        }, config.timeoutMs + 100);
        timer.unref?.();
        child.once('error', (error) => {
            if (aborted || signal?.aborted || error?.name === 'AbortError') {
                finish(resolve, 130);
                return;
            }
            finish(reject, error);
        });
        child.once('close', (code, childSignal) => {
            if (aborted || signal?.aborted) {
                finish(resolve, 130);
                return;
            }
            if (childSignal) {
                if (!timedOut) console.error(`vanilla-test coverage: Test entry terminated by ${childSignal}.`);
                finish(resolve, 2);
                return;
            }
            if (timedOut) {
                finish(resolve, 2);
                return;
            }
            finish(resolve, code === 0 ? 0 : code === 1 ? 1 : 2);
        });
    });
}

export async function runNodeCoverage(config, signal) {
    const finalDirectory = path.join(config.reportsDirectory, 'node');
    const output = await createOutputTransaction(finalDirectory, 'node');
    const outputDirectory = output.directory;
    const tempDirectory = path.join(outputDirectory, '.native-v8');
    const resultFile = path.join(outputDirectory, 'test-results.json');
    await fs.mkdir(tempDirectory, { recursive: true });

    try {
        const testCode = await runEntry(config, tempDirectory, resultFile, signal);
        if (testCode === 130) return 130;

        const report = await writeNativeCoverageReport({
            scripts: await readCoverageScripts(tempDirectory, config),
            includedFiles: listIncludedFiles(config.root, config.node.include),
            root: config.root,
            outputDirectory,
            runtime: `Node.js ${process.versions.node}`,
            title: 'vanilla-test Node native V8 coverage',
            thresholds: config.thresholds,
            enforcement: { total: false, perFile: true }
        });

        if (report.failures.length) {
            console.error(`Node coverage thresholds not met:\n${report.failures.map(({ message }) => message).join('\n')}`);
        }

        if (testCode === 2) return 2;
        await fs.rm(tempDirectory, { recursive: true, force: true });
        const code = testCode === 1 || !report.passed ? 1 : 0;
        await output.commit();
        return code;
    } finally {
        await fs.rm(tempDirectory, { recursive: true, force: true });
        await output.cleanup();
    }
}
