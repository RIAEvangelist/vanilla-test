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

function send(response, status, body, type = 'text/plain; charset=utf-8') {
    response.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(body);
}

export async function startServer(root, harness) {
    const realRoot = fs.realpathSync(root);
    const server = http.createServer((request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            send(response, 405, 'Method not allowed');
            return;
        }

        let pathname;
        try {
            pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
        } catch {
            send(response, 400, 'Bad request');
            return;
        }

        if (pathname === '/__vanilla-test__/index.html') {
            send(response, 200, request.method === 'HEAD' ? '' : harness, 'text/html; charset=utf-8');
            return;
        }

        const filePath = path.resolve(root, `.${pathname}`);
        const relative = path.relative(root, filePath);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            send(response, 403, 'Forbidden');
            return;
        }

        fs.stat(filePath, (statError, stats) => {
            if (statError || !stats.isFile()) {
                send(response, 404, 'Not found');
                return;
            }
            fs.realpath(filePath, (realError, realPath) => {
                const realRelative = realError ? '..' : path.relative(realRoot, realPath);
                if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
                    send(response, 403, 'Forbidden');
                    return;
                }
                response.writeHead(200, {
                    'Content-Type': MIME.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
                    'Content-Length': stats.size,
                    'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff'
                });
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
    return {
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    };
}
