/* Static file server for the Cubic PM System prototype.
   Replaces `py -m http.server 8080` — the Python install was removed from this
   machine, so the dev server now runs on Node (v18+, no dependencies).
   Serves the project root, no caching, so edits show on reload. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2]) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.zip': 'application/zip',
};

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store, must-revalidate',
  });
  res.end(body);
}

function listing(res, dir, urlPath) {
  const names = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
  const rows = names.map(n => {
    const slash = fs.statSync(path.join(dir, n)).isDirectory() ? '/' : '';
    return '<li><a href="' + encodeURIComponent(n) + slash + '">' + esc(n) + slash + '</a></li>';
  }).join('\n');
  const html = '<!doctype html><meta charset="utf-8"><title>Index of ' + esc(urlPath) +
    '</title><h1>Index of ' + esc(urlPath) + '</h1><ul>' + rows + '</ul>';
  send(res, 200, html, TYPES['.html']);
}

http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    return send(res, 400, '400 Bad Request');
  }
  const target = path.resolve(ROOT, '.' + urlPath);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return send(res, 403, '403 Forbidden');

  fs.stat(target, (err, st) => {
    if (err) return send(res, 404, '404 Not Found: ' + urlPath);
    if (st.isDirectory()) {
      const index = path.join(target, 'index.html');
      if (fs.existsSync(index)) return stream(res, index);
      if (!urlPath.endsWith('/')) {
        res.writeHead(301, { Location: urlPath + '/' });
        return res.end();
      }
      return listing(res, target, urlPath);
    }
    stream(res, target, st);
  });
}).listen(PORT, () => {
  console.log('Serving ' + ROOT + ' on http://localhost:' + PORT + '/');
});

function stream(res, file, st) {
  const size = st ? st.size : fs.statSync(file).size;
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': 'no-store, must-revalidate',
  });
  fs.createReadStream(file).pipe(res).on('error', () => res.end());
}
