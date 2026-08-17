import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import protocolDefaults from './protocol.json' with { type: 'json' };

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(benchmarkRoot, '..');
const laneRunners = Object.freeze({
    node: Object.freeze(['vanilla-test', 'node-test', 'mocha']),
    browser: Object.freeze(['vanilla-test', 'mocha'])
});
const runnerMetadata = Object.freeze({
    'vanilla-test': {
        name: 'vanilla-test', kind: 'subject',
        capabilities: ['Node and real browsers', 'native V8 coverage', 'HTML, LCOV, and JSON reports']
    },
    'node-test': {
        name: 'node:test', kind: 'richer-competitor',
        capabilities: ['suites and hooks', 'mocks and snapshots', 'reporters and native coverage']
    },
    mocha: {
        name: 'Mocha', kind: 'richer-competitor',
        capabilities: ['Node and real browsers', 'suites and hooks', 'filtering, retries, and reporters']
    }
});

function usage() {
    return `Usage: node benchmark/run.js [options]

Options:
  --runtime <all|node|browser>  Runtime lane(s) to run (default: all)
  --cases <integer>            Real test cases per sample (default: ${protocolDefaults.caseCount})
  --batch-size <integer>       Cases retained in each suite (default: ${protocolDefaults.batchSize})
  --samples <integer>          Measured fresh runs (default: ${protocolDefaults.measuredSamples})
  --warmups <integer>          Discarded rehearsal runs (default: ${protocolDefaults.warmups})
  --timeout-ms <integer>       Watchdog for one sample (default: ${protocolDefaults.sampleTimeoutMs})
  --output <path>              Write only this JSON path instead of publishing data + raw result
  --help                       Show this help
`;
}

export function parseArguments(argv) {
    const values = {
        runtime: 'all', cases: protocolDefaults.caseCount, batchSize: protocolDefaults.batchSize,
        samples: protocolDefaults.measuredSamples, warmups: protocolDefaults.warmups,
        timeoutMs: protocolDefaults.sampleTimeoutMs, output: null, help: false
    };
    const fields = new Map([
        ['--runtime', 'runtime'], ['--cases', 'cases'], ['--batch-size', 'batchSize'],
        ['--samples', 'samples'], ['--warmups', 'warmups'], ['--timeout-ms', 'timeoutMs'], ['--output', 'output']
    ]);
    for (let index = 0; index < argv.length; index += 1) {
        const option = argv[index];
        if (option === '--help') { values.help = true; continue; }
        const field = fields.get(option);
        if (!field) throw new TypeError(`Unknown benchmark option ${JSON.stringify(option)}.`);
        const value = argv[++index];
        if (value === undefined) throw new TypeError(`${option} requires a value.`);
        values[field] = field === 'runtime' || field === 'output' ? value : Number(value);
    }
    if (!['all', 'node', 'browser'].includes(values.runtime)) throw new RangeError('--runtime must be all, node, or browser.');
    for (const [field, minimum] of [['cases', 1], ['batchSize', 1], ['samples', 1], ['warmups', 0], ['timeoutMs', 1]]) {
        if (!Number.isSafeInteger(values[field]) || values[field] < minimum) {
            throw new RangeError(`--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be an integer of at least ${minimum}.`);
        }
    }
    if (values.batchSize > values.cases) throw new RangeError('--batch-size cannot exceed --cases.');
    return Object.freeze(values);
}

function quantile(sorted, fraction) {
    if (sorted.length === 1) return sorted[0];
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower));
}

export function summarizeSamples(values, cases, seed = protocolDefaults.orderSeed) {
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
        throw new TypeError('Sample values must be a nonempty array of positive finite numbers.');
    }
    const sorted = [...values].sort((left, right) => left - right);
    const median = quantile(sorted, 0.5);
    const deviations = sorted.map((value) => Math.abs(value - median)).sort((left, right) => left - right);
    let state = seed >>> 0;
    const random = () => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state / 0x1_0000_0000;
    };
    const bootstrap = [];
    for (let iteration = 0; iteration < 2_000; iteration += 1) {
        const sample = Array.from({ length: sorted.length }, () => sorted[Math.floor(random() * sorted.length)]).sort((a, b) => a - b);
        bootstrap.push(quantile(sample, 0.5));
    }
    bootstrap.sort((left, right) => left - right);
    return {
        count: sorted.length,
        minimumMs: sorted[0],
        p25Ms: quantile(sorted, 0.25),
        medianMs: median,
        p75Ms: quantile(sorted, 0.75),
        maximumMs: sorted.at(-1),
        medianAbsoluteDeviationMs: quantile(deviations, 0.5),
        median95ConfidenceMs: [quantile(bootstrap, 0.025), quantile(bootstrap, 0.975)],
        medianCasesPerSecond: cases / (median / 1_000)
    };
}

export function validateWorkerResult(record, { lane, runner, cases, batchSize }) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('Worker result must be an object.');
    const expectedSuites = Math.ceil(cases / batchSize);
    if (record.lane !== lane || record.runner !== runner || record.valid !== true) {
        throw new Error(`${lane}/${runner} did not identify itself as a valid result.`);
    }
    if (record.counts?.cases !== cases || record.counts?.suites !== expectedSuites
        || record.counts?.executed !== cases || record.counts?.passed !== cases || record.counts?.failed !== 0) {
        throw new Error(`${lane}/${runner} returned inconsistent execution counts.`);
    }
    if (!Number.isSafeInteger(record.checksum) || record.checksum !== record.expectedChecksum) {
        throw new Error(`${lane}/${runner} returned an invalid checksum.`);
    }
    for (const field of ['runnerMs', 'pipelineMs']) {
        if (typeof record[field] !== 'number' || !Number.isFinite(record[field]) || record[field] <= 0) {
            throw new Error(`${lane}/${runner} returned invalid ${field}.`);
        }
    }
    const reportNames = new Set(record.reports?.map((report) => report.file));
    for (const name of protocolDefaults.reportFormats) {
        if (!reportNames.has(name)) throw new Error(`${lane}/${runner} is missing generated report ${name}.`);
    }
    return record;
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

function workerPath(lane) {
    return path.join(benchmarkRoot, lane === 'node' ? 'node-worker.js' : 'browser-worker.js');
}

async function runWorker({ lane, runner, cases, batchSize, runDirectory, timeoutMs }) {
    await fs.mkdir(runDirectory, { recursive: true });
    const args = [workerPath(lane), runner, String(cases), String(batchSize), runDirectory, String(timeoutMs)];
    const started = performance.now();
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {
            cwd: projectRoot,
            windowsHide: true,
            env: {
                ...process.env,
                NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${protocolDefaults.nodeHeapCapMiB}`.trim()
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const append = (current, chunk) => `${current}${chunk}`.slice(-131_072);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
        child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
            setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 2_000).unref?.();
        }, timeoutMs + 10_000);
        const finish = (error, value) => {
            clearTimeout(timer);
            if (error) reject(error); else resolve(value);
        };
        child.once('error', (error) => finish(error));
        child.once('close', (code, signal) => {
            const coldWallMs = performance.now() - started;
            if (timedOut) {
                finish(new Error(`${lane}/${runner} timed out after ${timeoutMs} ms.`));
                return;
            }
            if (code !== 0) {
                finish(new Error(`${lane}/${runner} worker exited ${code ?? signal}: ${stderr.trim() || 'no diagnostic'}`));
                return;
            }
            try {
                const record = validateWorkerResult(JSON.parse(stdout.trim()), { lane, runner, cases, batchSize });
                finish(null, { ...record, coldWallMs });
            } catch (error) {
                finish(new Error(`${lane}/${runner} returned malformed JSON: ${stdout.slice(0, 500)}`, { cause: error }));
            }
        });
    });
}

async function command(file, args = []) {
    return new Promise((resolve) => {
        const child = spawn(file, args, { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let stdout = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.once('error', () => resolve(null));
        child.once('close', (code) => resolve(code === 0 ? stdout.trim() : null));
    });
}

async function machineInformation() {
    const cpus = os.cpus();
    const windows = process.platform === 'win32';
    const model = windows
        ? await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystem).Model'])
        : null;
    const power = windows ? await command('powercfg.exe', ['/getactivescheme']) : null;
    const powerMatch = power?.match(/\(([^)]+)\)/);
    const npm = process.env.npm_config_user_agent?.match(/(?:^|\s)npm\/([^\s]+)/)?.[1] ?? null;
    return {
        model: model || 'not reported',
        os: { platform: process.platform, release: os.release(), version: os.version(), architecture: os.arch() },
        cpu: {
            model: cpus[0]?.model?.trim() || 'not reported',
            logicalCores: cpus.length,
            availableParallelism: os.availableParallelism()
        },
        memory: { totalBytes: os.totalmem() },
        node: { version: process.version, architecture: process.arch, v8: process.versions.v8 },
        npm: npm || 'not reported',
        powerPlan: powerMatch?.[1] || (power ? power.replace(/\s+/g, ' ').trim() : 'not reported'),
        affinity: 'operating-system default; runners execute serially'
    };
}

async function sourceInformation() {
    const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    const lockPath = path.join(benchmarkRoot, 'package-lock.json');
    const lockSource = await fs.readFile(lockPath);
    const lock = JSON.parse(lockSource);
    const commit = await command('git', ['rev-parse', 'HEAD']);
    const status = await command('git', ['status', '--porcelain']);
    return {
        commit,
        dirty: Boolean(status),
        packageVersion: packageJson.version,
        benchmarkLockSha256: createHash('sha256').update(lockSource).digest('hex'),
        dependencies: {
            mocha: {
                version: lock.packages?.['node_modules/mocha']?.version,
                integrity: lock.packages?.['node_modules/mocha']?.integrity
            },
            nodeTest: { version: process.version, source: 'built into the recorded Node runtime' }
        }
    };
}

function entrySummary(samples, cases) {
    return {
        verifiedSamples: samples.filter((sample) => sample.valid).length,
        runner: summarizeSamples(samples.map((sample) => sample.runnerMs), cases),
        pipeline: summarizeSamples(samples.map((sample) => sample.pipelineMs), cases),
        coldWall: summarizeSamples(samples.map((sample) => sample.coldWallMs), cases),
        peakMemoryBytes: Math.max(...samples.map((sample) => sample.memory?.peakRssBytes ?? sample.memory?.peakHeapUsedBytes ?? 0))
    };
}

async function execute(options) {
    const selectedLanes = options.runtime === 'all' ? ['node', 'browser'] : [options.runtime];
    const workRoot = path.join(benchmarkRoot, '.work', `run-${Date.now()}-${process.pid}`);
    const records = Object.fromEntries(selectedLanes.map((lane) => [lane, Object.fromEntries(
        laneRunners[lane].map((runner) => [runner, []])
    )]));
    let runNumber = 0;
    try {
        for (const lane of selectedLanes) {
            for (let warmup = 0; warmup < options.warmups; warmup += 1) {
                for (const runner of shuffled(laneRunners[lane], protocolDefaults.orderSeed + warmup)) {
                    runNumber += 1;
                    console.error(`[warmup] ${lane} · ${runner} · ${options.cases.toLocaleString()} cases`);
                    await runWorker({
                        lane, runner, cases: options.cases, batchSize: options.batchSize,
                        runDirectory: path.join(workRoot, `warmup-${runNumber}`), timeoutMs: options.timeoutMs
                    });
                }
            }
            for (let sample = 0; sample < options.samples; sample += 1) {
                for (const runner of shuffled(laneRunners[lane], protocolDefaults.orderSeed + options.warmups + sample)) {
                    runNumber += 1;
                    console.error(`[sample ${sample + 1}/${options.samples}] ${lane} · ${runner} · ${options.cases.toLocaleString()} cases`);
                    const result = await runWorker({
                        lane, runner, cases: options.cases, batchSize: options.batchSize,
                        runDirectory: path.join(workRoot, `sample-${runNumber}`), timeoutMs: options.timeoutMs
                    });
                    records[lane][runner].push({ index: sample + 1, ...result });
                }
            }
        }

        const source = await sourceInformation();
        const machine = await machineInformation();
        const browserSample = records.browser
            ? Object.values(records.browser).flat().find((sample) => sample.browser)
            : null;
        if (browserSample) machine.chrome = browserSample.browser;
        const lanes = Object.fromEntries(selectedLanes.map((lane) => [lane, {
            entries: laneRunners[lane].map((runner) => ({
                id: runner,
                ...runnerMetadata[runner],
                version: runner === 'vanilla-test' ? source.packageVersion
                    : runner === 'node-test' ? process.version
                        : source.dependencies.mocha.version,
                samples: records[lane][runner],
                summary: entrySummary(records[lane][runner], options.cases)
            }))
        }]));
        const allSamples = Object.values(records).flatMap((lane) => Object.values(lane).flat());
        const result = {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            publishable: !source.dirty && options.cases === protocolDefaults.caseCount
                && options.samples >= 3 && allSamples.every((sample) => sample.valid),
            source,
            protocol: {
                id: protocolDefaults.id,
                caseCount: options.cases,
                batchSize: options.batchSize,
                batchCount: Math.ceil(options.cases / options.batchSize),
                warmups: options.warmups,
                measuredSamples: options.samples,
                orderSeed: protocolDefaults.orderSeed,
                execution: 'serial synchronous passing cases; globally unique names; no parallel entrants',
                isolation: 'fresh Node worker and test child, or fresh Node worker plus isolated Chrome profile, per sample',
                timing: 'cold wall includes startup, execution, precise V8 coverage, validation, HTML/LCOV/JSON writes, and teardown',
                coverageScope: protocolDefaults.coverageScope,
                reportFormats: protocolDefaults.reportFormats,
                nodeHeapCapMiB: protocolDefaults.nodeHeapCapMiB,
                comparison: 'Node and browser are separate lanes; only comparable or richer runners are ranked'
            },
            machine,
            lanes
        };

        const serialized = `${JSON.stringify(result, null, 2)}\n`;
        if (options.output) {
            const output = path.resolve(projectRoot, options.output);
            await fs.mkdir(path.dirname(output), { recursive: true });
            await fs.writeFile(output, serialized, 'utf8');
            console.error(`Wrote ${path.relative(projectRoot, output)}`);
        } else {
            const dataPath = path.join(projectRoot, 'data', 'benchmarks.json');
            const stamp = result.generatedAt.replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
            const rawPath = path.join(benchmarkRoot, 'results', `${stamp}.json`);
            await fs.mkdir(path.dirname(rawPath), { recursive: true });
            await Promise.all([fs.writeFile(dataPath, serialized, 'utf8'), fs.writeFile(rawPath, serialized, 'utf8')]);
            console.error(`Published data/benchmarks.json and benchmark/results/${path.basename(rawPath)}`);
        }
        return result;
    } finally {
        await fs.rm(workRoot, { recursive: true, force: true });
    }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    try {
        const options = parseArguments(process.argv.slice(2));
        if (options.help) {
            process.stdout.write(usage());
        } else {
            const result = await execute(options);
            const state = result.publishable ? 'publishable' : 'preview';
            console.error(`Benchmark complete (${state}).`);
        }
    } catch (error) {
        console.error(error?.stack || error);
        process.exitCode = 1;
    }
}

export { execute };
