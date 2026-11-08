const { HttpError } = require('../http-error');

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', chunk => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.pause();
        fail(new HttpError(413, 'BODY_TOO_LARGE', 'request body too large'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, totalBytes).toString('utf8'));
    });
    req.on('error', fail);
  });
}

async function readJsonBody(req) {
  const body = await readBody(req);
  try { return body ? JSON.parse(body) : {}; } catch (_) { throw new HttpError(400, 'INVALID_JSON', 'invalid JSON body'); }
}

module.exports = { readBody, readJsonBody };
