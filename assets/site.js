function valueAt(source, paths) {
    for (const path of paths) {
        const value = path.split('.').reduce((current, key) => current?.[key], source);
        if (value !== undefined && value !== null) return value;
    }
    return undefined;
}

function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function result(source, name) {
    const item = valueAt(source, [
        `tests.${name}`,
        `testResults.${name}`,
        `quality.tests.${name}`
    ]);
    if (!item || typeof item !== 'object') return null;

    const total = number(valueAt(item, ['total', 'tests', 'count']));
    const passed = number(valueAt(item, ['passedCount', 'passed', 'pass']));
    const failed = number(valueAt(item, ['failed', 'failures', 'failureCount']))
        ?? (total !== undefined && passed !== undefined ? total - passed : undefined);
    const ok = valueAt(item, ['ok', 'passedAll', 'success'])
        ?? (failed !== undefined ? failed === 0 : undefined);
    return { ...item, total, passed, failed, ok };
}

function metric(source, runtime, name) {
    const item = valueAt(source, [
        `coverage.${runtime}.metrics.${name}`,
        `coverage.${runtime}.${name}`,
        `coverage.${runtime}.total.${name}`,
        `quality.coverage.${runtime}.${name}`
    ]);
    if (!item || typeof item !== 'object') return null;

    const covered = number(item.covered);
    const total = number(item.total);
    const pct = number(valueAt(item, ['pct', 'percent', 'percentage']))
        ?? (covered !== undefined && total ? (covered / total) * 100 : undefined);
    return { covered, total, pct };
}

function percentage(value) {
    if (!Number.isFinite(value)) return '—';
    return `${Number.isInteger(value) ? value : value.toFixed(2)}%`;
}

function count(resultValue) {
    if (!resultValue || resultValue.passed === undefined || resultValue.total === undefined) return '—';
    return `${resultValue.passed}/${resultValue.total}`;
}

function dateTime(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return String(value);
    return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short'
    }).format(date);
}

function setText(selector, text) {
    if (text === undefined || text === null || text === '') return;
    for (const element of document.querySelectorAll(selector)) element.textContent = String(text);
}

function setLink(selector, label, href) {
    for (const element of document.querySelectorAll(selector)) {
        if (label) element.textContent = label;
        if (href) element.href = href;
    }
}

function renderStatus(status) {
    const shared = result(status, 'shared');
    const sharedNode = result(status, 'shared.node');
    const sharedChrome = result(status, 'shared.chrome');
    const tooling = result(status, 'tooling');
    const smokeSource = valueAt(status, ['tests.packageSmoke', 'tests.package-smoke', 'packageSmoke']);
    const smoke = typeof smokeSource === 'object' && smokeSource !== null
        ? smokeSource.ok ?? smokeSource.success
        : smokeSource;

    const sharedText = shared?.total !== undefined && shared?.passed !== undefined
        ? `${count(shared)} passed`
        : sharedNode && sharedChrome && sharedNode.total === sharedChrome.total && sharedNode.passed === sharedChrome.passed
            ? `${count(sharedNode)} in Node and Chrome`
            : undefined;
    setText('[data-status-summary="shared"]', sharedText);
    setText('[data-status-summary="shared-node"]', sharedNode ? `${count(sharedNode)} passed` : undefined);
    setText('[data-status-summary="shared-chrome"]', sharedChrome ? `${count(sharedChrome)} passed` : undefined);
    setText('[data-status-summary="tooling"]', tooling ? `${count(tooling)} passed` : undefined);
    setText('[data-status-summary="smoke"]', smoke === true ? 'Passed' : smoke === false ? 'Failed' : undefined);
    setText('[data-status-summary="overall"]', valueAt(status, ['status.label']) ?? (valueAt(status, ['status.ok']) === true ? 'All quality gates passed' : undefined));

    for (const runtime of ['node', 'chrome']) {
        for (const name of ['statements', 'branches', 'functions', 'lines']) {
            const item = metric(status, runtime, name);
            if (!item) continue;
            setText(`[data-status-metric="${runtime}.${name}.pct"]`, percentage(item.pct));
            if (item.covered !== undefined && item.total !== undefined) {
                setText(`[data-status-metric="${runtime}.${name}.count"]`, `${item.covered}/${item.total}`);
            }
        }
    }

    for (const name of ['statements', 'branches', 'functions', 'lines']) {
        const threshold = number(valueAt(status, [`coverage.thresholds.${name}`, `quality.coverage.thresholds.${name}`]));
        setText(`[data-status-threshold="${name}"]`, threshold === undefined ? undefined : percentage(threshold));
    }

    const nodeLines = metric(status, 'node', 'lines');
    const chromeLines = metric(status, 'chrome', 'lines');
    if (nodeLines && chromeLines && nodeLines.pct === chromeLines.pct) {
        setText('[data-status-summary="coverage"]', `${percentage(nodeLines.pct)} in both runtimes`);
    }

    const generated = dateTime(valueAt(status, [
        'generatedAt',
        'generated_at',
        'provenance.generatedAt'
    ]));
    setText('[data-status-generated]', generated);

    const sha = String(valueAt(status, ['commit.short', 'commit.sha', 'sha', 'git.sha']) ?? '');
    const shortSha = valueAt(status, ['commit.short']) ?? sha.slice(0, 8);
    const commitUrl = valueAt(status, ['commit.url', 'git.url']);
    setLink('[data-status-commit]', shortSha, commitUrl);

    setText('[data-status-version]', valueAt(status, ['package.version', 'version', 'packageVersion']));
    setText('[data-status-node-minimum]', valueAt(status, [
        'runtimes.nodeMinimum',
        'runtimes.node.minimum',
        'node.minimum',
        'runtimes.node'
    ]));
    setText('[data-status-node-coverage]', valueAt(status, [
        'runtimes.nodeCoverage',
        'runtimes.node.coverage',
        'node.coverageVersion',
        'runtimes.node'
    ]));
    setText('[data-status-chrome]', valueAt(status, [
        'runtimes.chrome',
        'runtimes.chrome.version',
        'chrome.version'
    ]));

    const overallOk = valueAt(status, ['status.ok']);
    const overallLabel = valueAt(status, ['status.label']);
    for (const element of document.querySelectorAll('[data-status-state]')) {
        element.dataset.statusState = overallOk === false ? 'error' : 'ready';
        element.textContent = overallLabel
            ? `Latest published main build: ${overallLabel}`
            : 'Verified by the latest published main build';
    }
}

function renderStatusError() {
    for (const element of document.querySelectorAll('[data-status-state]')) {
        element.dataset.statusState = 'error';
        element.textContent = 'Live build status unavailable; documentation remains usable';
    }
}

async function loadStatus() {
    const statusUrl = document.body.dataset.statusUrl;
    if (!statusUrl || !document.querySelector('[data-status-state], [data-status-summary], [data-status-metric]')) return;

    try {
        const response = await fetch(statusUrl, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Status request failed with ${response.status}`);
        renderStatus(await response.json());
    } catch {
        renderStatusError();
    }
}

function enableCopyButtons() {
    if (!navigator.clipboard) return;

    for (const block of document.querySelectorAll('.code-block')) {
        const code = block.querySelector('code');
        if (!code) continue;

        const button = document.createElement('button');
        button.className = 'copy-button';
        button.type = 'button';
        button.textContent = 'Copy';
        button.setAttribute('aria-label', 'Copy code to clipboard');
        button.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(code.textContent);
                button.textContent = 'Copied';
                setTimeout(() => { button.textContent = 'Copy'; }, 1600);
            } catch {
                button.textContent = 'Select code';
            }
        });
        block.append(button);
    }
}

loadStatus();
enableCopyButtons();
