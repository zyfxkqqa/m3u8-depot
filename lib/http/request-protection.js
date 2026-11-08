const { HttpError } = require('../http-error');

const REQUEST_HEADER = 'x-m3u8-local-request';

function localRequestAuthority(req) {
  const rawHost = String(req.headers.host || '').trim();
  let parsed;
  try { parsed = new URL(`http://${rawHost}`); } catch (_) { return null; }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) return null;
  return { hostname, port: parsed.port || '80' };
}

function expectedOrigins(req) {
  const authority = localRequestAuthority(req);
  if (!authority) return new Set();
  const port = authority.port === '80' ? '' : `:${authority.port}`;
  return new Set([`http://127.0.0.1${port}`, `http://localhost${port}`, `http://[::1]${port}`]);
}

function protectLocalPost(req) {
  if (req.method !== 'POST') return;
  if (!localRequestAuthority(req)) {
    throw new HttpError(403, 'HOST_NOT_ALLOWED', 'request host is not allowed');
  }
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    throw new HttpError(403, 'CROSS_SITE_REQUEST', 'cross-site requests are not allowed');
  }
  const origin = req.headers.origin;
  if (origin && !expectedOrigins(req).has(origin)) {
    throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'request origin is not allowed');
  }
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  }
  if (req.headers[REQUEST_HEADER] !== '1') {
    throw new HttpError(403, 'LOCAL_HEADER_REQUIRED', 'local request header is required');
  }
}

module.exports = { REQUEST_HEADER, expectedOrigins, protectLocalPost };
