import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main } from '../lib/coverage/cli.js';
import { createOutputTransaction, MARKER_NAME } from '../lib/coverage/output.js';

async function temporaryDirectory(context) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vanilla-test-output-'));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

test('coverage output refuses to replace an unowned directory', async (context) => {
    const root = await temporaryDirectory(context);
    const output = path.join(root, 'coverage', 'node');
    const sentinel = path.join(output, 'sentinel.txt');
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(sentinel, 'keep me', 'utf8');

    await assert.rejects(
        createOutputTransaction(output, 'node'),
        (error) => error?.code === 'ERR_VANILLA_TEST_UNOWNED_OUTPUT'
    );
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep me');
});

test('Node-only CLI refuses unowned output without requiring Chrome config', async (context) => {
    const root = await temporaryDirectory(context);
    const entry = path.join(root, 'entry.js');
    const config = path.join(root, 'vanilla-test.config.json');
    const output = path.join(root, 'reports', 'node');
    const sentinel = path.join(output, 'sentinel.txt');
    await fs.writeFile(entry, 'export default () => ({ ok: true, failureCount: 0 });\n', 'utf8');
    await fs.writeFile(config, `${JSON.stringify({
        entry: './entry.js',
        reportsDirectory: './reports',
        node: { include: ['entry.js'] }
    })}\n`, 'utf8');
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(sentinel, 'keep me', 'utf8');

    const errors = [];
    const originalError = console.error;
    console.error = (...values) => errors.push(values.join(' '));
    try {
        assert.equal(await main(['coverage', 'node', '--config', config]), 2);
    } finally {
        console.error = originalError;
    }

    assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep me');
    assert.match(errors.at(-1), /Refusing to replace unowned coverage directory/);
});

test('coverage output commits through an ownership marker', async (context) => {
    const root = await temporaryDirectory(context);
    const output = path.join(root, 'coverage', 'node');
    const transaction = await createOutputTransaction(output, 'node');
    await fs.writeFile(path.join(transaction.directory, 'coverage-summary.json'), '{}\n', 'utf8');

    await transaction.commit();
    await transaction.cleanup();

    assert.equal(await fs.readFile(path.join(output, 'coverage-summary.json'), 'utf8'), '{}\n');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, MARKER_NAME), 'utf8')), {
        schemaVersion: 1,
        owner: 'vanilla-test',
        runtime: 'node'
    });
});

test('failed coverage preserves the previous owned report and successful reruns replace it', async (context) => {
    const root = await temporaryDirectory(context);
    const output = path.join(root, 'coverage', 'chrome');

    const first = await createOutputTransaction(output, 'chrome');
    await fs.writeFile(path.join(first.directory, 'report.txt'), 'first', 'utf8');
    await first.commit();

    const failed = await createOutputTransaction(output, 'chrome');
    await fs.writeFile(path.join(failed.directory, 'report.txt'), 'incomplete', 'utf8');
    await failed.cleanup();
    assert.equal(await fs.readFile(path.join(output, 'report.txt'), 'utf8'), 'first');

    const second = await createOutputTransaction(output, 'chrome');
    await fs.writeFile(path.join(second.directory, 'report.txt'), 'second', 'utf8');
    await second.commit();
    assert.equal(await fs.readFile(path.join(output, 'report.txt'), 'utf8'), 'second');
});

test('coverage output rejects a marker for another runtime', async (context) => {
    const root = await temporaryDirectory(context);
    const output = path.join(root, 'coverage', 'node');
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, MARKER_NAME), JSON.stringify({
        schemaVersion: 1,
        owner: 'vanilla-test',
        runtime: 'chrome'
    }), 'utf8');

    await assert.rejects(
        createOutputTransaction(output, 'node'),
        (error) => error?.code === 'ERR_VANILLA_TEST_UNOWNED_OUTPUT'
    );
});

test('Node coverage preserves a good report on harness errors and publishes valid failures', async (context) => {
    const root = await temporaryDirectory(context);
    const entry = path.join(root, 'entry.js');
    const config = path.join(root, 'vanilla-test.config.json');
    const output = path.join(root, 'reports', 'node');
    await fs.writeFile(config, `${JSON.stringify({
        entry: './entry.js',
        reportsDirectory: './reports',
        thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 },
        node: { include: ['entry.js'] }
    })}\n`, 'utf8');

    const initial = await createOutputTransaction(output, 'node');
    await fs.writeFile(path.join(initial.directory, 'previous.txt'), 'known good', 'utf8');
    await initial.commit();

    await fs.writeFile(entry, 'export default () => ({ ok: true, failureCount: 1 });\n', 'utf8');
    assert.equal(await main(['coverage', 'node', '--config', config]), 2);
    assert.equal(await fs.readFile(path.join(output, 'previous.txt'), 'utf8'), 'known good');

    await fs.writeFile(entry, [
        'export default () => ({',
        '    ok: false,',
        '    failureCount: 1,',
        '    total: 1,',
        '    passed: [],',
        "    failed: ['expected failure']",
        '});',
        ''
    ].join('\n'), 'utf8');
    assert.equal(await main(['coverage', 'node', '--config', config]), 1);
    await assert.rejects(fs.stat(path.join(output, 'previous.txt')), (error) => error?.code === 'ENOENT');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'test-results.json'), 'utf8')), {
        schemaVersion: 1,
        runtime: 'node',
        ok: false,
        total: 1,
        passedCount: 0,
        failureCount: 1,
        passed: [],
        failed: ['expected failure']
    });
});
