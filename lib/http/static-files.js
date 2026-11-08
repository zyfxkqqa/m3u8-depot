const fs = require('fs');
const path = require('path');

function serveStatic(req, res, runtimeConfig) {
  const parsed = new URL(req.url, `http://${runtimeConfig.HOST}:${runtimeConfig.PORT}`);
  const pathname = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  const filePath = path.normalize(path.join(runtimeConfig.STATIC_DIR, pathname));
  if (!filePath.startsWith(runtimeConfig.STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
  };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

module.exports = { serveStatic };
