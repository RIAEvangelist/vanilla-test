import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MIME = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml; charset=utf-8']
]);

const SECURITY_HEADERS = Object.freeze({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
});

const SECRET_NAMES = new Set([
    'credentials',
    'credentials.json',
    'id_dsa',
    'id_ecdsa',
    'id_ed25519',
    'id_rsa',
    'secrets',
    'secrets.json'
]);

const SECRET_EXTENSION = /\.(?:key|p12|pem|pfx)$/i;

export function isDeniedPathname(pathname) {
    if (typeof pathname !== 'string' || pathname.includes('\0')) {
        return true;
    }

    const segments = pathname.split(/[\\/]+/).filter(Boolean);
    return segments.some((segment) => {
        const normalized = segment.toLowerCase();
        return normalized.startsWith('.')
            || normalized.includes(':')
            || SECRET_NAMES.has(normalized)
            || SECRET_EXTENSION.test(normalized);
    });
}

export function isPathInside(root, target) {
    const relative = path.relative(root, target);
    return relative === ''
        || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

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

export async function startServer(root, harness) {
    const resolvedRoot = path.resolve(root);
    const realRoot = fs.realpathSync(resolvedRoot);
    let expectedHost;

    const server = http.createServer((request, response) => {
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
            pathname = decodeURIComponent(new URL(request.url, `http://${expectedHost}`).pathname);
        } catch {
            send(response, 400, 'Bad request');
            return;
        }

        if (isDeniedPathname(pathname)) {
            send(response, 403, 'Forbidden');
            return;
        }

        if (pathname === '/__vanilla-test__/index.html') {
            send(response, 200, request.method === 'HEAD' ? '' : harness, 'text/html; charset=utf-8');
            return;
        }

        const filePath = path.resolve(resolvedRoot, `.${pathname}`);
        if (!isPathInside(resolvedRoot, filePath)) {
            send(response, 403, 'Forbidden');
            return;
        }

        fs.stat(filePath, (statError, stats) => {
            if (statError || !stats.isFile()) {
                send(response, 404, 'Not found');
                return;
            }

            fs.realpath(filePath, (realError, realPath) => {
                if (realError) {
                    send(response, 404, 'Not found');
                    return;
                }
                if (!isPathInside(realRoot, realPath)) {
                    send(response, 403, 'Forbidden');
                    return;
                }

                response.writeHead(200, headers(
                    MIME.get(path.extname(realPath).toLowerCase()) || 'application/octet-stream',
                    { 'Content-Length': stats.size }
                ));
                if (request.method === 'HEAD') {
                    response.end();
                    return;
                }
                fs.createReadStream(realPath).on('error', () => response.destroy()).pipe(response);
            });
        });
    });

    server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    expectedHost = `127.0.0.1:${address.port}`;
    return {
        origin: `http://${expectedHost}`,
        close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    };
}

export { SECURITY_HEADERS };
