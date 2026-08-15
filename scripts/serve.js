import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    isDeniedPathname,
    isPathInside,
    SECURITY_HEADERS
} from '../lib/coverage/server.js';

const TYPES = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml; charset=utf-8']
]);

function headers(type, extra = {}) {
    return {
        ...SECURITY_HEADERS,
        'Content-Type': type,
        ...extra
    };
}

function send(response, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
    response.writeHead(status, headers(type, extra));
    response.end(body);
}

function validPort(port) {
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
        throw new RangeError('Workspace server port must be an integer from 0 through 65535.');
    }
    return port;
}

export async function startWorkspaceServer({
    root = resolve(process.cwd()),
    port = 8_000
} = {}) {
    const listenPort = validPort(port);
    const resolvedRoot = resolve(root);
    const realRoot = await realpath(resolvedRoot);
    let expectedHost;

    const server = createServer(async (request, response) => {
        if (request.headers.host !== expectedHost) {
            send(response, 421, 'Misdirected request');
            return;
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
            send(response, 405, 'Method not allowed', 'text/plain; charset=utf-8', {
                Allow: 'GET, HEAD'
            });
            return;
        }

        let pathname;
        try {
            pathname = decodeURIComponent(new URL(request.url ?? '/', `http://${expectedHost}`).pathname);
        } catch {
            send(response, 400, 'Bad request');
            return;
        }

        if (isDeniedPathname(pathname)) {
            send(response, 403, 'Forbidden');
            return;
        }

        let file = resolve(resolvedRoot, `.${pathname}`);
        if (!isPathInside(resolvedRoot, file)) {
            send(response, 403, 'Forbidden');
            return;
        }

        let metadata;
        try {
            metadata = await stat(file);
            if (metadata.isDirectory()) {
                file = resolve(file, 'index.html');
            }
            if (!isPathInside(resolvedRoot, file)) {
                send(response, 403, 'Forbidden');
                return;
            }

            const realFile = await realpath(file);
            if (!isPathInside(realRoot, realFile)) {
                send(response, 403, 'Forbidden');
                return;
            }

            metadata = await stat(realFile);
            if (!metadata.isFile()) {
                send(response, 404, 'Not found');
                return;
            }

            response.writeHead(200, headers(
                TYPES.get(extname(realFile).toLowerCase()) ?? 'application/octet-stream',
                { 'Content-Length': metadata.size }
            ));

            if (request.method === 'HEAD') {
                response.end();
                return;
            }

            createReadStream(realFile).on('error', () => response.destroy()).pipe(response);
        } catch {
            send(response, 404, 'Not found');
        }
    });

    server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));

    await new Promise((resolveListening, reject) => {
        server.once('error', reject);
        server.listen(listenPort, '127.0.0.1', resolveListening);
    });

    const address = server.address();
    expectedHost = `127.0.0.1:${address.port}`;
    return {
        origin: `http://${expectedHost}`,
        close: () => new Promise((resolveClose, reject) => {
            server.close((error) => error ? reject(error) : resolveClose());
        })
    };
}

const isMain = process.argv[1]
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
    const port = Number(process.env.PORT ?? '8000');
    const workspace = await startWorkspaceServer({ port });
    console.log(`vanilla-test workspace: ${workspace.origin}`);
}
