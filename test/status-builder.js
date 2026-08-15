import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    buildSiteStatus,
    normalizeSharedTests,
    parseArguments,
    parseTapSummary
} from '../scripts/build-site-status.js';

const metrics = (pct = 100) => Object.fromEntries(
    ['statements', 'branches', 'functions', 'lines'].map((name) => [name, {
        total: 10,
        covered: Math.round(pct / 10),
        skipped: 0,
        pct
    }])
);

async function writeJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vanilla-test-status-'));
    await writeJson(path.join(root, 'package.json'), { name: 'vanilla-test', version: '2.0.0' });
    await writeJson(path.join(root, 'vanilla-test.config.json'), {
        thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 }
    });
    await writeJson(path.join(root, 'coverage', 'runtime.json'), {
        node: 'v24.0.0',
        chrome: 'Google Chrome 140.0.0.0'
    });

    for (const runtime of ['node', 'chrome']) {
        await writeJson(path.join(root, 'coverage', runtime, 'test-results.json'), {
            schemaVersion: 1,
            runtime,
            ok: true,
            total: 2,
            passedCount: 2,
            failureCount: 0,
            passed: ['first shared check', 'second shared check'],
            failed: []
        });
        await writeJson(path.join(root, 'coverage', runtime, 'coverage-summary.json'), {
            total: metrics(runtime === 'node' ? 100 : 90)
        });
    }

    await writeJson(path.join(root, 'tooling-result.json'), {
        ok: true,
        total: 3,
        passedCount: 3,
        failureCount: 0,
        skippedCount: 0,
        cancelledCount: 0
    });
    return root;
}

test('parses Node TAP summaries into normalized tooling results', () => {
    const result = parseTapSummary(`TAP version 13
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
`, 0);

    assert.deepEqual(result, {
        runtime: 'node',
        suite: 'tooling',
        ok: true,
        total: 3,
        passedCount: 3,
        failureCount: 0,
        skippedCount: 0,
        cancelledCount: 0
    });
    assert.throws(() => parseTapSummary('not TAP'), /must be TAP/);
});

test('builds status data and shared-core Shields badges from report artifacts', async () => {
    const root = await fixture();
    try {
        const { status, badges } = await buildSiteStatus({
            root,
            toolingResultPath: 'tooling-result.json',
            packageSmoke: 'passed',
            now: new Date('2026-08-15T00:00:00.000Z'),
            environment: {
                GITHUB_SHA: '0123456789abcdef',
                GITHUB_REPOSITORY: 'RIAEvangelist/vanilla-test',
                GITHUB_SERVER_URL: 'https://github.com'
            }
        });

        assert.equal(status.status.ok, true);
        assert.equal(status.generatedAt, '2026-08-15T00:00:00.000Z');
        assert.equal(status.commit.short, '0123456');
        assert.equal(status.tests.scope, 'shared-core');
        assert.equal(status.tests.shared.node.total, 2);
        assert.equal(status.tests.tooling.total, 3);
        assert.equal(status.tests.packageSmoke.ok, true);
        assert.equal(status.coverage.scope, 'shared-core');
        assert.equal(status.coverage.node.metrics.lines.pct, 100);
        assert.equal(status.coverage.chrome.minimumPct, 90);
        assert.match(badges['node-coverage.json'].label, /shared core/);
        assert.match(badges['chrome-tests.json'].label, /shared core/);

        const diskStatus = JSON.parse(await fs.readFile(path.join(root, 'data', 'status.json'), 'utf8'));
        const diskBadge = JSON.parse(await fs.readFile(path.join(root, 'badges', 'node-tests.json'), 'utf8'));
        assert.deepEqual(diskStatus, status);
        assert.deepEqual(diskBadge, badges['node-tests.json']);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('rejects inconsistent shared test artifacts and CLI options', () => {
    assert.throws(() => normalizeSharedTests({
        runtime: 'chrome',
        ok: true,
        total: 1,
        passedCount: 1,
        failureCount: 0
    }, 'node'), /runtime "node"/);
    assert.deepEqual(parseArguments([
        '--root', 'workspace',
        '--tooling-result', 'tooling.json',
        '--package-smoke', 'passed'
    ]), {
        root: 'workspace',
        toolingResultPath: 'tooling.json',
        packageSmoke: 'passed'
    });
    assert.throws(() => parseArguments(['--unknown']), /Unknown option/);
});
