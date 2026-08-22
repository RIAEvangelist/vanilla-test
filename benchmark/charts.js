import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(benchmarkRoot, '..');
const assetsRoot = path.join(projectRoot, 'assets');
const chartPaths = Object.freeze({
    scaling: path.join(assetsRoot, 'benchmark-core-scaling.svg'),
    pipelines: path.join(assetsRoot, 'benchmark-native-pipelines.svg')
});
const palette = Object.freeze({
    background: '#07110f', panel: '#0d1c18', grid: '#29473f', text: '#f3fbf7', muted: '#a9c1b8',
    green: '#55e6a5', cyan: '#5cc8ff', amber: '#ffbf69'
});

function escapeXml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

function compact(value, digits = 2) {
    const fixed = Number(value).toFixed(digits);
    const [integer, fraction = ''] = fixed.split('.');
    const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const trimmedFraction = fraction.replace(/0+$/, '');
    return trimmedFraction ? `${grouped}.${trimmedFraction}` : grouped;
}

function shortCommit(value) {
    return typeof value === 'string' ? value.slice(0, 12) : 'unknown';
}

function validateScaling(value) {
    if (value?.schemaVersion !== 1 || value?.protocol?.id !== 'core-suite-scaling-v1'
        || !Array.isArray(value.series) || value.series.length !== 2) {
        throw new Error('data/scaling.json has an unsupported schema.');
    }
    for (const series of value.series) {
        if (!Array.isArray(series.points) || series.points.length === 0) {
            throw new Error('Scaling benchmark series is missing points.');
        }
        for (const point of series.points) {
            if (!Number.isSafeInteger(point.caseCount) || point.caseCount < 1
                || !Number.isFinite(point.summary?.medianMs) || point.summary.medianMs <= 0
                || !Number.isFinite(point.summary?.minimumMs) || point.summary.minimumMs <= 0
                || !Number.isFinite(point.summary?.maximumMs) || point.summary.maximumMs <= 0) {
                throw new Error('Scaling benchmark contains an invalid point.');
            }
        }
    }
    return value;
}

function validatePipelines(value) {
    if (value?.schemaVersion !== 1 || !value?.lanes?.node?.entries || !value?.lanes?.browser?.entries) {
        throw new Error('data/benchmarks.json has an unsupported schema.');
    }
    return value;
}

function scalingSvg(data) {
    const width = 1_200;
    const height = 660;
    const plot = { left: 100, top: 138, width: 1_040, height: 390 };
    const allValues = data.series.flatMap(({ points }) => points.flatMap(({ caseCount, summary }) => [
        (summary.minimumMs / caseCount) * 1_000,
        (summary.maximumMs / caseCount) * 1_000
    ]));
    let minimumPower = Math.floor(Math.log10(Math.min(...allValues) * 0.8));
    let maximumPower = Math.ceil(Math.log10(Math.max(...allValues) * 1.2));
    if (minimumPower === maximumPower) maximumPower += 1;
    const y = (value) => plot.top + ((maximumPower - Math.log10(value)) / (maximumPower - minimumPower)) * plot.height;
    const sizes = data.series[0].points.map(({ caseCount }) => caseCount);
    const x = (index) => plot.left + (index / (sizes.length - 1)) * plot.width;
    const colors = [palette.amber, palette.green];
    const lines = [];

    lines.push(`<rect width="${width}" height="${height}" rx="24" fill="${palette.background}"/>`);
    lines.push(`<title>vanilla-test core lifecycle scaling from ${sizes[0]} to ${sizes.at(-1)} cases in one runner</title>`);
    const description = data.series.map((series) => `${series.label}: ${series.points.map(({ caseCount, summary }) => `${caseCount} cases ${compact((summary.medianMs / caseCount) * 1_000, 3)} microseconds per case`).join(', ')}`).join('. ');
    lines.push(`<desc>${escapeXml(`Lower is better. Five fresh-process medians with observed ranges. ${description}. Raw data: data/scaling.json.`)}</desc>`);
    lines.push(`<text x="60" y="58" fill="${palette.text}" font-size="30" font-weight="700">Core lifecycle cost stays flat after the decision-state fix</text>`);
    lines.push(`<text x="60" y="90" fill="${palette.muted}" font-size="17">One runner per point · construction + expects/pass/done · report excluded · lower is better</text>`);
    lines.push(`<rect x="${plot.left}" y="${plot.top}" width="${plot.width}" height="${plot.height}" rx="12" fill="${palette.panel}"/>`);

    for (let power = minimumPower; power <= maximumPower; power += 1) {
        const value = 10 ** power;
        const position = y(value);
        const label = value < 1 ? value.toFixed(Math.abs(power)) : compact(value, 0);
        lines.push(`<line x1="${plot.left}" y1="${position}" x2="${plot.left + plot.width}" y2="${position}" stroke="${palette.grid}" stroke-width="1"/>`);
        lines.push(`<text x="${plot.left - 14}" y="${position + 5}" text-anchor="end" fill="${palette.muted}" font-size="14">${label} µs</text>`);
    }

    for (const [index, size] of sizes.entries()) {
        const position = x(index);
        lines.push(`<line x1="${position}" y1="${plot.top}" x2="${position}" y2="${plot.top + plot.height}" stroke="${palette.grid}" stroke-width="1" opacity="0.5"/>`);
        lines.push(`<text x="${position}" y="${plot.top + plot.height + 30}" text-anchor="middle" fill="${palette.muted}" font-size="14">${compact(size, 0)}</text>`);
    }
    lines.push(`<text x="${plot.left + plot.width / 2}" y="${plot.top + plot.height + 62}" text-anchor="middle" fill="${palette.text}" font-size="15">Cases retained in one VanillaTest runner</text>`);
    lines.push(`<text transform="translate(26 ${plot.top + plot.height / 2}) rotate(-90)" text-anchor="middle" fill="${palette.text}" font-size="15">Median lifecycle microseconds per case · log scale</text>`);

    for (const [seriesIndex, series] of data.series.entries()) {
        const color = colors[seriesIndex];
        const points = series.points.map(({ caseCount, summary }, index) => ({
            x: x(index),
            medianY: y((summary.medianMs / caseCount) * 1_000),
            minimumY: y((summary.minimumMs / caseCount) * 1_000),
            maximumY: y((summary.maximumMs / caseCount) * 1_000),
            median: (summary.medianMs / caseCount) * 1_000
        }));
        for (const point of points) {
            lines.push(`<line x1="${point.x}" y1="${point.minimumY}" x2="${point.x}" y2="${point.maximumY}" stroke="${color}" stroke-width="2" opacity="0.65"/>`);
            lines.push(`<line x1="${point.x - 5}" y1="${point.minimumY}" x2="${point.x + 5}" y2="${point.minimumY}" stroke="${color}" stroke-width="2" opacity="0.65"/>`);
            lines.push(`<line x1="${point.x - 5}" y1="${point.maximumY}" x2="${point.x + 5}" y2="${point.maximumY}" stroke="${color}" stroke-width="2" opacity="0.65"/>`);
        }
        lines.push(`<polyline points="${points.map((point) => `${point.x},${point.medianY}`).join(' ')}" fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`);
        for (const point of points) {
            lines.push(`<circle cx="${point.x}" cy="${point.medianY}" r="6" fill="${palette.background}" stroke="${color}" stroke-width="4"/>`);
        }
        const legendX = seriesIndex === 0 ? 700 : 920;
        lines.push(`<line x1="${legendX}" y1="116" x2="${legendX + 30}" y2="116" stroke="${color}" stroke-width="4"/>`);
        lines.push(`<text x="${legendX + 39}" y="121" fill="${palette.text}" font-size="14">${escapeXml(series.label)}</text>`);
    }

    const baselineLast = data.series[0].points.at(-1);
    const candidateLast = data.series[1].points.at(-1);
    const ratio = baselineLast.summary.medianMs / candidateLast.summary.medianMs;
    lines.push(`<text x="60" y="615" fill="${palette.text}" font-size="16" font-weight="700">At ${compact(sizes.at(-1), 0)} cases: ${compact(ratio, 1)}× faster lifecycle in this benchmark</text>`);
    lines.push(`<text x="60" y="641" fill="${palette.muted}" font-size="13">Baseline ${escapeXml(data.source.baseline.tag)} @ ${shortCommit(data.source.baseline.commit)} · candidate ${escapeXml(data.source.candidate.packageVersion)} @ ${shortCommit(data.source.candidate.commit)} · Node ${escapeXml(data.machine.node.version)} · ${data.protocol.measuredSamples} measured samples · data/scaling.json</text>`);
    return `<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 ${width} ${height}" font-family="Inter, ui-sans-serif, system-ui, sans-serif">\n${lines.join('\n')}\n</svg>\n`;
}

function pipelineSvg(data) {
    const width = 1_200;
    const height = 660;
    const panels = [
        { lane: 'node', title: 'Node pipeline', left: 72, width: 496 },
        { lane: 'browser', title: 'Real Chrome pipeline', left: 632, width: 496 }
    ];
    const chartTop = 160;
    const chartHeight = 350;
    const colors = { 'vanilla-test': palette.green, 'node-test': palette.cyan, mocha: palette.amber };
    const lines = [
        `<rect width="${width}" height="${height}" rx="24" fill="${palette.background}"/>`,
        '<title>One-million-case native pipeline cold-wall medians</title>'
    ];
    const description = panels.map(({ lane, title }) => `${title}: ${data.lanes[lane].entries.map((entry) => `${entry.name} ${compact(entry.summary.coldWall.medianMs / 1_000, 3)} seconds`).join(', ')}`).join('. ');
    lines.push(`<desc>${escapeXml(`Lower is better within each host panel. Axes are independent and must not be compared across Node and Chrome. ${description}. Raw data: data/benchmarks.json.`)}</desc>`);
    lines.push(`<text x="60" y="58" fill="${palette.text}" font-size="30" font-weight="700">One million cases through the complete native pipeline</text>`);
    lines.push(`<text x="60" y="90" fill="${palette.muted}" font-size="17">Cold startup + runner + precise V8 coverage + JSON/LCOV/HTML reports + teardown</text>`);
    lines.push(`<text x="60" y="111" fill="${palette.amber}" font-size="14">Independent zero-based axes: compare runners only within the same host panel.</text>`);

    for (const panel of panels) {
        const entries = [...data.lanes[panel.lane].entries].sort((left, right) => left.summary.coldWall.medianMs - right.summary.coldWall.medianMs);
        const maximumSeconds = Math.max(...entries.map((entry) => entry.summary.coldWall.medianMs / 1_000));
        const axisMaximum = Math.ceil(maximumSeconds / 5) * 5 || 1;
        const baseY = chartTop + chartHeight;
        lines.push(`<rect x="${panel.left}" y="${chartTop - 42}" width="${panel.width}" height="${chartHeight + 92}" rx="14" fill="${palette.panel}"/>`);
        lines.push(`<text x="${panel.left + 18}" y="${chartTop - 14}" fill="${palette.text}" font-size="20" font-weight="700">${panel.title}</text>`);
        for (let tick = 0; tick <= 4; tick += 1) {
            const value = (axisMaximum / 4) * tick;
            const position = baseY - (value / axisMaximum) * chartHeight;
            lines.push(`<line x1="${panel.left + 54}" y1="${position}" x2="${panel.left + panel.width - 16}" y2="${position}" stroke="${palette.grid}" stroke-width="1"/>`);
            lines.push(`<text x="${panel.left + 44}" y="${position + 5}" text-anchor="end" fill="${palette.muted}" font-size="13">${compact(value, 1)}s</text>`);
        }
        const availableWidth = panel.width - 90;
        const slotWidth = availableWidth / entries.length;
        const barWidth = Math.min(96, slotWidth * 0.62);
        for (const [index, entry] of entries.entries()) {
            const seconds = entry.summary.coldWall.medianMs / 1_000;
            const barHeight = (seconds / axisMaximum) * chartHeight;
            const barX = panel.left + 64 + (slotWidth * index) + ((slotWidth - barWidth) / 2);
            const barY = baseY - barHeight;
            lines.push(`<rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="7" fill="${colors[entry.id] ?? palette.cyan}"/>`);
            lines.push(`<text x="${barX + barWidth / 2}" y="${Math.max(chartTop + 15, barY - 10)}" text-anchor="middle" fill="${palette.text}" font-size="14" font-weight="700">${compact(seconds, 2)}s</text>`);
            lines.push(`<text x="${barX + barWidth / 2}" y="${baseY + 28}" text-anchor="middle" fill="${palette.text}" font-size="14">${escapeXml(entry.name)}</text>`);
            lines.push(`<text x="${barX + barWidth / 2}" y="${baseY + 48}" text-anchor="middle" fill="${palette.muted}" font-size="12">${escapeXml(entry.version)}</text>`);
        }
    }

    lines.push(`<text x="60" y="602" fill="${palette.text}" font-size="15" font-weight="700">Same 1,000 × 1,000 workload · five measured fresh-host samples · no outlier deletion</text>`);
    lines.push(`<text x="60" y="631" fill="${palette.muted}" font-size="13">Source ${shortCommit(data.source.commit)} · Node ${escapeXml(data.machine.node.version)} · Chrome ${escapeXml(data.machine.chrome?.product ?? 'not recorded')} · data/benchmarks.json</text>`);
    return `<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 ${width} ${height}" font-family="Inter, ui-sans-serif, system-ui, sans-serif">\n${lines.join('\n')}\n</svg>\n`;
}

export async function buildCharts() {
    const [scalingSource, pipelineSource] = await Promise.all([
        fs.readFile(path.join(projectRoot, 'data', 'scaling.json'), 'utf8'),
        fs.readFile(path.join(projectRoot, 'data', 'benchmarks.json'), 'utf8')
    ]);
    return Object.freeze({
        scaling: scalingSvg(validateScaling(JSON.parse(scalingSource))),
        pipelines: pipelineSvg(validatePipelines(JSON.parse(pipelineSource)))
    });
}

export async function writeCharts({ check = false } = {}) {
    const charts = await buildCharts();
    await fs.mkdir(assetsRoot, { recursive: true });
    for (const [name, output] of Object.entries(charts)) {
        if (check) {
            let current;
            try {
                current = await fs.readFile(chartPaths[name], 'utf8');
            } catch {
                throw new Error(`${path.relative(projectRoot, chartPaths[name])} is missing; run npm run benchmark:charts.`);
            }
            if (current !== output) {
                throw new Error(`${path.relative(projectRoot, chartPaths[name])} is stale; run npm run benchmark:charts.`);
            }
        } else {
            await fs.writeFile(chartPaths[name], output, 'utf8');
            console.error(`Wrote ${path.relative(projectRoot, chartPaths[name])}`);
        }
    }
    return charts;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    try {
        const argumentsList = process.argv.slice(2);
        if (argumentsList.some((value) => value !== '--check') || argumentsList.length > 1) {
            throw new TypeError('Usage: node benchmark/charts.js [--check]');
        }
        await writeCharts({ check: argumentsList.includes('--check') });
        console.error(process.argv.includes('--check') ? 'Benchmark charts are current.' : 'Benchmark charts generated.');
    } catch (error) {
        console.error(error?.stack || error);
        process.exitCode = 1;
    }
}
