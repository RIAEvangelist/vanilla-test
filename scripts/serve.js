import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const root = resolve(process.cwd());
const port = Number.parseInt(process.env.PORT ?? '8000', 10);
const types = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml']
]);

const server = createServer(async (request, response) => {
    try {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { allow: 'GET, HEAD' }).end('Method not allowed');
            return;
        }

        const url = new URL(request.url ?? '/', 'http://localhost');
        const pathname = decodeURIComponent(url.pathname);
        let file = resolve(root, `.${pathname}`);

        if (file !== root && !file.startsWith(`${root}${sep}`)) {
            response.writeHead(403).end('Forbidden');
            return;
        }

        const metadata = await stat(file);
        if (metadata.isDirectory()) {
            file = resolve(file, 'index.html');
        }

        if (file !== root && !file.startsWith(`${root}${sep}`)) {
            response.writeHead(403).end('Forbidden');
            return;
        }

        const fileMetadata = await stat(file);
        response.writeHead(200, {
            'content-length': fileMetadata.size,
            'content-type': types.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
            'x-content-type-options': 'nosniff'
        });

        if (request.method === 'HEAD') {
            response.end();
            return;
        }

        createReadStream(file).pipe(response);
    } catch {
        response.writeHead(404).end('Not found');
    }
});

server.listen(port, '127.0.0.1', () => {
    console.log(`vanilla-test workspace: http://127.0.0.1:${port}`);
});
