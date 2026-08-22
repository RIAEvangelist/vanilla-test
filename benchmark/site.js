const state = document.querySelector('[data-benchmark-state]');
const machine = document.querySelector('[data-benchmark-machine]');
const provenance = document.querySelector('[data-benchmark-provenance]');
const scalingState = document.querySelector('[data-scaling-state]');
const scalingProvenance = document.querySelector('[data-scaling-provenance]');
const scalingBody = document.querySelector('[data-scaling-points]');
const dialog = document.querySelector('[data-source-dialog]');
const sourceCode = dialog?.querySelector('[data-source-code]');
const sourceTitle = dialog?.querySelector('[data-source-title]');
const sourceStatus = dialog?.querySelector('[data-source-status]');
const sourceLink = dialog?.querySelector('[data-source-github]');
let benchmark;
let currentSource = '';

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function duration(milliseconds) {
    if (!Number.isFinite(milliseconds)) return '—';
    return milliseconds >= 1_000 ? `${(milliseconds / 1_000).toFixed(2)} s` : `${milliseconds.toFixed(1)} ms`;
}

function throughput(value) {
    if (!Number.isFinite(value)) return '—';
    return `${Math.round(value).toLocaleString()} /s`;
}

function bytes(value) {
    if (!Number.isFinite(value)) return '—';
    return `${(value / (1024 ** 3)).toFixed(2)} GiB`;
}

function memorySize(value) {
    if (!Number.isFinite(value)) return '—';
    return `${(value / (1024 ** 2)).toFixed(0)} MiB`;
}

function renderMachine(value) {
    machine.replaceChildren();
    const fields = [
        ['Machine', value.model],
        ['CPU', `${value.cpu.model} · ${value.cpu.logicalCores} logical cores`],
        ['Memory', bytes(value.memory.totalBytes)],
        ['Operating system', `${value.os.version} · ${value.os.release} · ${value.os.architecture}`],
        ['Node / V8', `${value.node.version} · V8 ${value.node.v8}`],
        ['Chrome / V8', `${value.chrome?.product ?? 'not run'} · V8 ${value.chrome?.jsVersion ?? 'not run'}`],
        ['Power / affinity', `${value.powerPlan} · ${value.affinity}`]
    ];
    for (const [label, content] of fields) {
        const item = element('div', 'benchmark-machine__item');
        item.append(element('span', '', label), element('strong', '', content));
        machine.append(item);
    }
}

function renderLane(lane, value) {
    const body = document.querySelector(`[data-benchmark-lane="${lane}"]`);
    body.replaceChildren();
    const entries = [...(value?.entries ?? [])].sort((left, right) => left.summary.coldWall.medianMs - right.summary.coldWall.medianMs);
    for (const [index, entry] of entries.entries()) {
        const row = document.createElement('tr');
        const runner = document.createElement('th');
        runner.scope = 'row';
        const name = element('span', 'benchmark-runner', `${index + 1}. ${entry.name}`);
        const detail = element('small', '', `${entry.version} · ${entry.kind === 'subject' ? 'subject' : 'richer competitor'} · ${entry.summary.verifiedSamples}/${benchmark.protocol.measuredSamples} verified`);
        runner.append(name, detail);
        const wall = element('td', 'metric-value', duration(entry.summary.coldWall.medianMs));
        wall.append(element('small', '', `range ${duration(entry.summary.coldWall.minimumMs)}–${duration(entry.summary.coldWall.maximumMs)}`));
        const pipeline = element('td', '', duration(entry.summary.pipeline.medianMs));
        const runnerPhase = element('td', '', duration(entry.summary.runner.medianMs));
        const rate = element('td', '', throughput(entry.summary.coldWall.medianCasesPerSecond));
        const memory = element('td', '', memorySize(entry.summary.peakMemoryBytes));
        row.append(runner, wall, pipeline, runnerPhase, rate, memory);
        body.append(row);
    }
    if (entries.length === 0) {
        const row = document.createElement('tr');
        const cell = element('td', '', 'This runtime lane was not included in the published run.');
        cell.colSpan = 6;
        row.append(cell);
        body.append(row);
    }
}

function renderScaling(value) {
    scalingBody.replaceChildren();
    const [baseline, candidate] = value.series;
    for (const [index, candidatePoint] of candidate.points.entries()) {
        const baselinePoint = baseline.points[index];
        if (baselinePoint.caseCount !== candidatePoint.caseCount) {
            throw new Error('Scaling series case counts do not align.');
        }
        const row = document.createElement('tr');
        const cases = document.createElement('th');
        cases.scope = 'row';
        cases.textContent = candidatePoint.caseCount.toLocaleString();
        const measurement = (point) => {
            const cell = element('td', 'metric-value', duration(point.summary.medianMs));
            cell.append(element('small', '', `range ${duration(point.summary.minimumMs)}–${duration(point.summary.maximumMs)}`));
            return cell;
        };
        const baselinePerCase = element('td', '', `${((baselinePoint.summary.medianMs / baselinePoint.caseCount) * 1_000).toFixed(2)} µs`);
        const candidatePerCase = element('td', '', `${((candidatePoint.summary.medianMs / candidatePoint.caseCount) * 1_000).toFixed(2)} µs`);
        const improvement = element('td', '', `${(baselinePoint.summary.medianMs / candidatePoint.summary.medianMs).toFixed(1)}×`);
        row.append(cases, measurement(baselinePoint), measurement(candidatePoint), baselinePerCase, candidatePerCase, improvement);
        scalingBody.append(row);
    }
}

async function loadSource(pathname) {
    sourceTitle.textContent = pathname;
    sourceCode.textContent = 'Loading source…';
    sourceStatus.textContent = '';
    dialog.showModal();
    try {
        const response = await fetch(`./${pathname}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Source request returned ${response.status}.`);
        currentSource = await response.text();
        sourceCode.textContent = currentSource;
        const commit = benchmark?.source?.commit || 'main';
        sourceLink.href = `https://github.com/RIAEvangelist/vanilla-test/blob/${encodeURIComponent(commit)}/benchmark/${pathname}`;
    } catch (error) {
        currentSource = '';
        sourceCode.textContent = error?.message || String(error);
    }
}

for (const button of document.querySelectorAll('[data-benchmark-source]')) {
    button.addEventListener('click', () => void loadSource(button.dataset.benchmarkSource));
}

dialog?.querySelector('[data-source-copy]')?.addEventListener('click', async () => {
    if (!currentSource) return;
    try {
        await navigator.clipboard.writeText(currentSource);
        sourceStatus.textContent = 'Copied.';
    } catch {
        sourceStatus.textContent = 'Copy unavailable; select the source text manually.';
    }
});

try {
    const response = await fetch('../data/benchmarks.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Benchmark data request returned ${response.status}.`);
    benchmark = await response.json();
    if (benchmark?.schemaVersion !== 1 || !benchmark.protocol || !benchmark.machine || !benchmark.lanes) {
        throw new Error('Benchmark data has an unsupported schema.');
    }
    const generated = new Date(benchmark.generatedAt);
    state.textContent = `${benchmark.publishable ? 'Verified publishable run' : 'Preview run'} · ${generated.toLocaleString()} · commit ${benchmark.source.commit.slice(0, 12)}`;
    provenance.textContent = `${benchmark.protocol.caseCount.toLocaleString()} cases · ${benchmark.protocol.measuredSamples} measured samples · commit ${benchmark.source.commit.slice(0, 12)} · lock ${benchmark.source.benchmarkLockSha256.slice(0, 12)}`;
    renderMachine(benchmark.machine);
    renderLane('node', benchmark.lanes.node);
    renderLane('browser', benchmark.lanes.browser);
} catch (error) {
    state.textContent = `Benchmark data unavailable: ${error?.message || error}`;
    provenance.textContent = 'Run npm run benchmark to generate the verified dataset.';
    for (const body of document.querySelectorAll('[data-benchmark-lane]')) {
        const row = document.createElement('tr');
        const cell = element('td', '', 'No verified benchmark data is available yet.');
        cell.colSpan = 6;
        row.append(cell);
        body.replaceChildren(row);
    }
}

try {
    const response = await fetch('../data/scaling.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Scaling data request returned ${response.status}.`);
    const scaling = await response.json();
    if (scaling?.schemaVersion !== 1 || scaling.protocol?.id !== 'core-suite-scaling-v1'
        || !Array.isArray(scaling.series) || scaling.series.length !== 2) {
        throw new Error('Scaling data has an unsupported schema.');
    }
    const generated = new Date(scaling.generatedAt);
    scalingState.textContent = `${scaling.publishable ? 'Verified publishable run' : 'Preview run'} · ${generated.toLocaleString()}`;
    scalingProvenance.textContent = `${scaling.protocol.measuredSamples} measured samples · baseline ${scaling.source.baseline.tag} @ ${scaling.source.baseline.commit.slice(0, 12)} · candidate ${scaling.source.candidate.packageVersion} @ ${scaling.source.candidate.commit.slice(0, 12)}`;
    renderScaling(scaling);
} catch (error) {
    scalingState.textContent = `Scaling data unavailable: ${error?.message || error}`;
    scalingProvenance.textContent = 'Run npm run benchmark:scale to generate the verified dataset.';
    const row = document.createElement('tr');
    const cell = element('td', '', 'No verified scaling data is available yet.');
    cell.colSpan = 6;
    row.append(cell);
    scalingBody?.replaceChildren(row);
}
