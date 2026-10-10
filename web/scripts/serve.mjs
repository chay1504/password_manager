// Local preview of the built sites: Vault on :5173, Codes on :5174.
// They are different origins, so each gets its own private storage, as when deployed.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVALIDATE, REVALIDATE_PATHS, SECURITY_HEADERS } from './headers.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};

function serve(portal, port) {
  const base = join(dist, portal);
  createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(base, path));
      if (!file.startsWith(base)) throw new Error('outside');
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      const headers = { ...SECURITY_HEADERS, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' };
      if (REVALIDATE_PATHS.includes(path)) headers['Cache-Control'] = REVALIDATE;
      res.writeHead(200, headers).end(await readFile(file));
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  }).listen(port, '127.0.0.1', () => console.log(`${portal}: http://localhost:${port}/`));
}

serve('vault', 5173);
serve('codes', 5174);
