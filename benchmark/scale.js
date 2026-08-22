import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { summarizeSamples } from './run.js';

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(benchmarkRoot, '..');
const baselineTag = '2.1.1';
const defaultSizes = Object.freeze([250, 500, 1_000, 2_000, 4_000, 8_000, 16_000]);
const defaults = Object.freeze({
    sizes: defaultSizes,
    samples: 5,
    warmups: 1,
    timeoutMs: 60_000,
    orderSeed: 0x51ca1e
});

function usage() {
    return `Usage: node benchmark/scale.js [options]

Options:
  --sizes <csv>          Cases in each monolithic suite (default: ${defaultSizes.join(',')})
  --samples <integer>    Measured fresh-process samples (default: ${defaults.samples})
  --warmups <integer>    Discarded fresh-process rehearsals (default: ${defaults.warmups})
  --timeout-ms <integer> Per-process watchdog (default: ${defaults.timeoutMs})
  --output <path>        Write only this JSON path instead of publishing data + raw result
  --help                 Show this help
`;
}

export function parseScaleArguments(argv) {
    const values = {
        sizes: [...defaults.sizes], samples: defaults.samples, warmups: defaults.warmups,
        timeoutMs: defaults.timeoutMs, output: null, help: false
    };
    const fields = new Map([
        ['--sizes', 'sizes'], ['--samples', 'samples'], ['--warmups', 'warmups'],
        ['--timeout-ms', 'timeoutMs'], ['--output', 'output']
    ]);

    for (let index = 0; index < argv.length; index += 1) {
        const option = argv[index];
        if (option === '--help') { values.help = true; continue; }
        const field = fields.get(option);
        if (!field) throw new TypeError(`Unknown scaling benchmark option ${JSON.stringify(option)}.`);
        const value = argv[++index];
        if (value === undefined) throw new TypeError(`${option} requires a value.`);
        values[field] = field === 'output' ? value
            : field === 'sizes' ? value.split(',').map(Number)
                : Number(value);
    }

    if (!Array.isArray(values.sizes) || values.sizes.length === 0
        || values.sizes.some((value) => !Number.isSafeInteger(value) || value < 1)
        || new Set(values.sizes).size !== values.sizes.length) {
        throw new RangeError('--sizes must contain unique positive integers separated by commas.');
    }
    values.sizes.sort((left, right) => left - right);
    for (const [field, minimum] of [['samples', 1], ['warmups', 0], ['timeoutMs', 1]]) {
        if (!Number.isSafeInteger(values[field]) || values[field] < minimum) {
            throw new RangeError(`--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be an integer of at least ${minimum}.`);
        }
    }
    return Object.freeze({ ...values, sizes: Object.freeze(values.sizes) });
}

function shuffled(values, seed) {
    let state = seed >>> 0;
    const output = [...values];
    for (let index = output.length - 1; index > 0; index -= 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        const target = state % (index + 1);
        [output[index], output[target]] = [output[target], output[index]];
    }
    return output;
}

function runCommand(file, args, { reject = true } = {}) {
    return new Promise((resolve, rejectPromise) => {
        const child = spawn(file, args, {
            cwd: projectRoot,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', rejectPromise);
        child.once('close', (code, signal) => {
            if (code === 0 || !reject) {
                resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
                return;
            }
            rejectPromise(new Error(`${file} ${args.join(' ')} exited ${code ?? signal}: ${stderr.trim() || 'no diagnostic'}`));
        });
    });
}

async function runWorker(modulePath, caseCount, timeoutMs) {
    const child = spawn(process.execPath, [path.join(benchmarkRoot, 'scale-worker.js'), modulePath, String(caseCount)], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-65_536); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-65_536); });

    const record = await new Promise((resolve, reject) => {
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
            setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 2_000).unref?.();
        }, timeoutMs);
        const finish = (error, value) => {
            clearTimeout(timer);
            if (error) reject(error); else resolve(value);
        };
        child.once('error', (error) => finish(error));
        child.once('close', (code, signal) => {
            if (timedOut) {
                finish(new Error(`Scaling worker timed out after ${timeoutMs} ms for ${caseCount} cases.`));
                return;
            }
            if (code !== 0) {
                finish(new Error(`Scaling worker exited ${code ?? signal}: ${stderr || 'no diagnostic'}`));
                return;
            }
            try {
                finish(null, JSON.parse(stdout.trim()));
            } catch (error) {
                finish(new Error(`Scaling worker returned malformed JSON: ${stdout.slice(0, 500)}`, { cause: error }));
            }
        });
    });

    if (record.valid !== true || record.caseCount !== caseCount
        || typeof record.lifecycleMs !== 'number' || !Number.isFinite(record.lifecycleMs) || record.lifecycleMs <= 0) {
        throw new Error(`Scaling worker returned invalid data for ${caseCount} cases.`);
    }
    return record;
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

async function machineInformation() {
    const cpus = os.cpus();
    const windows = process.platform === 'win32';
    const modelResult = windows
        ? await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystem).Model'], { reject: false })
        : null;
    const powerResult = windows ? await runCommand('powercfg.exe', ['/getactivescheme'], { reject: false }) : null;
    const powerMatch = powerResult?.stdout?.match(/\(([^)]+)\)/);
    return {
        model: modelResult?.stdout || 'not reported',
        os: { platform: process.platform, release: os.release(), version: os.version(), architecture: os.arch() },
        cpu: {
            model: cpus[0]?.model?.trim() || 'not reported',
            logicalCores: cpus.length,
            availableParallelism: os.availableParallelism()
        },
        memory: { totalBytes: os.totalmem() },
        node: { version: process.version, architecture: process.arch, v8: process.versions.v8 },
        powerPlan: powerMatch?.[1] || powerResult?.stdout || 'not reported',
        affinity: 'operating-system default; workers execute serially'
    };
}

function pointsFor(records, seriesId, sizes) {
    return sizes.map((caseCount) => {
        const samples = records[seriesId][caseCount];
        return {
            caseCount,
            samples,
            summary: summarizeSamples(samples.map(({ lifecycleMs }) => lifecycleMs), caseCount)
        };
    });
}

export async function executeScale(options) {
    const workRoot = path.join(benchmarkRoot, '.work', `scale-${Date.now()}-${process.pid}`);
    const baselineDirectory = path.join(workRoot, 'baseline');
    const baselinePath = path.join(baselineDirectory, 'index.js');
    const candidatePath = path.join(projectRoot, 'index.js');
    const packageSource = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8');
    const packageJson = JSON.parse(packageSource);
    const baselineSourceResult = await runCommand('git', ['show', `${baselineTag}:index.js`]);
    const baselineCommit = (await runCommand('git', ['rev-list', '-n', '1', baselineTag])).stdout;
    const candidateCommit = (await runCommand('git', ['rev-parse', 'HEAD'])).stdout;
    const status = (await runCommand('git', ['status', '--porcelain'])).stdout;
    const candidateSource = await fs.readFile(candidatePath);
    const implementations = Object.freeze([
        Object.freeze({ id: 'baseline', label: `vanilla-test ${baselineTag}`, modulePath: baselinePath }),
        Object.freeze({ id: 'candidate', label: `vanilla-test ${packageJson.version}`, modulePath: candidatePath })
    ]);
    const records = Object.fromEntries(implementations.map(({ id }) => [id, Object.fromEntries(
        options.sizes.map((size) => [size, []])
    )]));

    try {
        await fs.mkdir(baselineDirectory, { recursive: true });
        await fs.writeFile(baselinePath, `${baselineSourceResult.stdout}\n`, 'utf8');
        const jobs = implementations.flatMap((implementation) => options.sizes.map((caseCount) => ({
            implementation, caseCount
        })));

        for (let round = 0; round < options.warmups + options.samples; round += 1) {
            const warmup = round < options.warmups;
            const sampleIndex = round - options.warmups + 1;
            for (const { implementation, caseCount } of shuffled(jobs, defaults.orderSeed + round)) {
                const label = warmup ? 'warmup' : `sample ${sampleIndex}/${options.samples}`;
                console.error(`[${label}] ${implementation.label} · ${caseCount.toLocaleString()} cases in one runner`);
                const result = await runWorker(implementation.modulePath, caseCount, options.timeoutMs);
                if (!warmup) records[implementation.id][caseCount].push({ index: sampleIndex, ...result });
            }
        }

        const generatedAt = new Date().toISOString();
        const result = {
            schemaVersion: 1,
            generatedAt,
            publishable: !status
                && options.samples === defaults.samples
                && options.warmups === defaults.warmups
                && options.sizes.length === defaults.sizes.length
                && options.sizes.every((size, index) => size === defaults.sizes[index])
                && packageJson.version !== baselineTag,
            source: {
                baseline: {
                    tag: baselineTag,
                    commit: baselineCommit,
                    indexSha256: sha256(`${baselineSourceResult.stdout}\n`)
                },
                candidate: {
                    packageVersion: packageJson.version,
                    commit: candidateCommit,
                    dirty: Boolean(status),
                    indexSha256: sha256(candidateSource)
                }
            },
            protocol: {
                id: 'core-suite-scaling-v1',
                sizes: options.sizes,
                warmups: options.warmups,
                measuredSamples: options.samples,
                orderSeed: defaults.orderSeed,
                processPolicy: 'one fresh Node process per implementation and suite size; serial randomized order',
                boundary: 'imports excluded; construction plus expects/pass/done included; report excluded from timing and used only for exact-result validation',
                workload: 'uniquely named synchronous passing cases in one VanillaTest instance',
                comparison: `exact ${baselineTag} index.js reconstructed from Git versus the candidate using the same installed runtime dependencies`
            },
            machine: await machineInformation(),
            series: implementations.map(({ id, label }) => ({
                id,
                label,
                points: pointsFor(records, id, options.sizes)
            }))
        };

        const serialized = `${JSON.stringify(result, null, 2)}\n`;
        if (options.output) {
            const output = path.resolve(projectRoot, options.output);
            await fs.mkdir(path.dirname(output), { recursive: true });
            await fs.writeFile(output, serialized, 'utf8');
            console.error(`Wrote ${path.relative(projectRoot, output)}`);
        } else {
            const stamp = generatedAt.replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
            const dataPath = path.join(projectRoot, 'data', 'scaling.json');
            const rawPath = path.join(benchmarkRoot, 'results', `scaling-${stamp}.json`);
            await fs.mkdir(path.dirname(rawPath), { recursive: true });
            await Promise.all([
                fs.writeFile(dataPath, serialized, 'utf8'),
                fs.writeFile(rawPath, serialized, 'utf8')
            ]);
            console.error(`Published data/scaling.json and benchmark/results/${path.basename(rawPath)}`);
        }
        return result;
    } finally {
        await fs.rm(workRoot, { recursive: true, force: true });
    }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    try {
        const options = parseScaleArguments(process.argv.slice(2));
        if (options.help) {
            process.stdout.write(usage());
        } else {
            const result = await executeScale(options);
            console.error(`Scaling benchmark complete (${result.publishable ? 'publishable' : 'preview'}).`);
        }
    } catch (error) {
        console.error(error?.stack || error);
        process.exitCode = 1;
    }
}
