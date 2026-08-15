import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startServer } from '../lib/coverage/server.js';
import { startWorkspaceServer } from '../scripts/serve.js';

async function temporaryDirectory(context) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vanilla-test-server-security-'));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

function request(origin, requestPath, {
    host,
    method = 'GET',
    setHost = true
} = {}) {
    const target = new URL(origin);
    const headers = host === undefined ? {} : { Host: host };

    return new Promise((resolve, reject) => {
        const outgoing = http.request({
            host: target.hostname,
            port: target.port,
            path: requestPath,
            method,
            headers,
            setHost
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks).toString('utf8')
            }));
        });
        outgoing.once('error', reject);
        outgoing.end();
    });
}

function assertSecurityHeaders(response) {
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.headers['content-security-policy'], /default-src 'self'/);
    assert.match(response.headers['content-security-policy'], /connect-src 'self'/);
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
}

async function writeSensitiveFixtures(root) {
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    await fs.writeFile(path.join(root, '.git', 'config'), '[remote "origin"]\nurl = secret\n');
    await fs.writeFile(path.join(root, '.env'), 'TOKEN=secret\n');
    await fs.writeFile(path.join(root, 'credentials.json'), '{"token":"secret"}\n');
    await fs.writeFile(path.join(root, 'private.pem'), 'private key material\n');
}

test('coverage server requires its exact Host and protects project files', async (context) => {
    const root = await temporaryDirectory(context);
    await fs.writeFile(path.join(root, 'module.js'), 'export const answer = 42;\n');
    await writeSensitiveFixtures(root);

    const server = await startServer(root, '<!doctype html><title>Harness</title>');
    context.after(server.close);

    const harness = await request(server.origin, '/__vanilla-test__/index.html');
    assert.equal(harness.status, 200);
    assert.match(harness.body, /Harness/);
    assertSecurityHeaders(harness);

    const module = await request(server.origin, '/module.js');
    assert.equal(module.status, 200);
    assert.match(module.headers['content-type'], /^text\/javascript/);
    assert.match(module.body, /answer = 42/);
    assertSecurityHeaders(module);

    const target = new URL(server.origin);
    assert.equal((await request(server.origin, '/module.js', { host: 'attacker.example' })).status, 421);
    assert.equal((await request(server.origin, '/module.js', { host: `localhost:${target.port}` })).status, 421);
    assert.match(String((await request(server.origin, '/module.js', { setHost: false })).status), /^(?:400|421)$/);

    for (const denied of [
        '/.git/config',
        '/%2egit/config',
        '/.env',
        '/credentials.json',
        '/private.pem'
    ]) {
        assert.equal((await request(server.origin, denied)).status, 403, denied);
    }

    const head = await request(server.origin, '/module.js', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal((await request(server.origin, '/module.js', { method: 'POST' })).status, 405);
    assert.equal((await request(server.origin, '/..%2Foutside.js')).status, 403);
});

test('workspace server preserves valid site routes while enforcing the same boundary', async (context) => {
    const root = await temporaryDirectory(context);
    await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><title>Workspace</title>');
    await fs.writeFile(path.join(root, 'module.mjs'), 'export const ready = true;\n');
    await fs.mkdir(path.join(root, 'coverage', 'node'), { recursive: true });
    await fs.writeFile(path.join(root, 'coverage', 'node', 'index.html'), '<!doctype html><title>Node report</title>');
    await writeSensitiveFixtures(root);

    const server = await startWorkspaceServer({ root, port: 0 });
    context.after(server.close);

    const index = await request(server.origin, '/');
    assert.equal(index.status, 200);
    assert.match(index.body, /Workspace/);
    assertSecurityHeaders(index);

    const module = await request(server.origin, '/module.mjs');
    assert.equal(module.status, 200);
    assert.match(module.headers['content-type'], /^text\/javascript/);
    assertSecurityHeaders(module);

    const report = await request(server.origin, '/reports/node/');
    assert.equal(report.status, 200);
    assert.match(report.body, /Node report/);
    assertSecurityHeaders(report);

    assert.equal((await request(server.origin, '/', { host: 'attacker.example' })).status, 421);
    assert.equal((await request(server.origin, '/.git/config')).status, 403);
    assert.equal((await request(server.origin, '/.env')).status, 403);
    assert.equal((await request(server.origin, '/credentials.json')).status, 403);
    assert.equal((await request(server.origin, '/private.pem')).status, 403);
});

test('both servers reject symlinks whose real target escapes the root', async (context) => {
    const directory = await temporaryDirectory(context);
    const root = path.join(directory, 'root');
    const outside = path.join(directory, 'outside');
    const link = path.join(root, 'escape');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.js'), 'export const secret = true;\n');

    try {
        await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (error?.code === 'EPERM' || error?.code === 'EACCES') {
            context.skip(`This host cannot create a test symlink: ${error.code}`);
            return;
        }
        throw error;
    }

    const coverage = await startServer(root, '<!doctype html><title>Harness</title>');
    const workspace = await startWorkspaceServer({ root, port: 0 });
    try {
        assert.equal((await request(coverage.origin, '/escape/secret.js')).status, 403);
        assert.equal((await request(workspace.origin, '/escape/secret.js')).status, 403);
    } finally {
        await Promise.all([coverage.close(), workspace.close()]);
    }
});

test('workspace server rejects invalid port configuration', async () => {
    await assert.rejects(
        startWorkspaceServer({ port: -1 }),
        /port must be an integer/
    );
});
