const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createApplication } = require('../server');
const { pinnedLookup, requestText } = require('../lib/http-client');
const { createUrlPolicy, isBlockedAddress } = require('../lib/url-policy');

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

function localRequestFactory(port, inspect = () => {}) {
  return ({ url, options, onResponse }) => {
    inspect(url, options);
    return http.request({ ...options, host: '127.0.0.1', port, path: `${url.pathname}${url.search}` }, onResponse);
  };
}

function requestJson(port, requestPath, { body = {}, headers = {}, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: requestPath, method: 'POST',
      headers: { Host: host, 'Content-Type': 'application/json', 'X-M3U8-Local-Request': '1', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.setTimeout(1000, () => req.destroy(new Error('local request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function expectHttpError(run, status, code) {
  await assert.rejects(run, error => error && error.statusCode === status && error.code === code, `${code} must map to HTTP ${status}`);
}

async function run() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm3u8-stage2-security-'));
  const servers = [];
  let app;
  try {
    const capturedLogs = [];
    const secretInternalError = 'SECRET_INTERNAL_HOST';
    const runtimeConfig = {
      HOST: '127.0.0.1', PORT: 0, ROOT_DIR: root, STATIC_DIR: path.join(root, 'static'),
      DATA_DIR: path.join(root, 'data'), TASKS_FILE: path.join(root, 'data', 'tasks.json'), OUTPUT_DIR: path.join(root, 'output'),
      FFMPEG: path.join(root, 'missing-ffmpeg.exe'), USER_AGENT: 'stage2-security', MAX_ACTIVE_TASKS: 1, PARSE_CONCURRENCY: 1,
    };
    app = createApplication(runtimeConfig, {
      logger: (message, error) => capturedLogs.push({ message, error }),
      schedulerOptions: { runTask: async () => {} },
      urlPolicyOptions: { allowedHosts: ['example.test'], resolver: async () => [{ address: '93.184.216.34', family: 4 }] },
      parseDetail: async () => { throw new Error(secretInternalError); },
    });
    const address = await app.start();
    const port = address.port;
    let response = await requestJson(port, '/api/start', { body: { ids: ['missing'] } });
    assert.strictEqual(response.status, 200, 'legal local POST');
    response = await requestJson(port, '/api/start', { body: { ids: [] } });
    assert.strictEqual(response.status, 400, 'empty ids');
    response = await requestJson(port, '/api/start', { body: { ids: ['x'] }, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.deepStrictEqual([response.status, response.body.code], [403, 'CROSS_SITE_REQUEST']);
    response = await requestJson(port, '/api/start', { body: { ids: ['x'] }, headers: { Origin: 'https://evil.test' } });
    assert.deepStrictEqual([response.status, response.body.code], [403, 'ORIGIN_NOT_ALLOWED']);
    response = await requestJson(port, '/api/start', { body: { ids: ['x'] }, headers: { 'Content-Type': 'text/plain' } });
    assert.deepStrictEqual([response.status, response.body.code], [415, 'JSON_REQUIRED']);
    response = await requestJson(port, '/api/start', { body: { ids: ['x'] }, headers: { 'X-M3U8-Local-Request': '' } });
    assert.deepStrictEqual([response.status, response.body.code], [403, 'LOCAL_HEADER_REQUIRED']);

    response = await requestJson(port, '/api/detail/parse', { body: { url: 'http://example.test/detail' } });
    assert.strictEqual(response.status, 500, 'unexpected internal errors must map to HTTP 500');
    assert.strictEqual(JSON.stringify(response.body).includes(secretInternalError), false, 'API response must redact internal error details');
    assert.strictEqual(
      capturedLogs.some(entry => String(entry.error && (entry.error.stack || entry.error.message || entry.error)).includes(secretInternalError)),
      true,
      'logger must retain the original internal error',
    );

    const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];
    const policy = createUrlPolicy({ allowedHosts: ['example.test', '127.0.0.1', '::1'], resolver: publicResolver });
    await expectHttpError(() => policy('ftp://example.test/x'), 400, 'URL_PROTOCOL');
    await expectHttpError(() => policy('http://u:p@example.test/x'), 400, 'URL_CREDENTIALS');
    await expectHttpError(() => policy('http://unknown.test/x'), 403, 'SITE_NOT_ALLOWED');
    await expectHttpError(() => policy('http://127.0.0.1/x'), 403, 'PRIVATE_ADDRESS');
    await expectHttpError(() => policy('http://[::1]/x'), 403, 'PRIVATE_ADDRESS');
    await expectHttpError(() => createUrlPolicy({ allowedHosts: ['example.test'], resolver: async () => [{ address: '10.0.0.1', family: 4 }] })('http://example.test/x'), 403, 'PRIVATE_ADDRESS');

    for (const address of [
      '192.0.2.1', '198.51.100.1', '203.0.113.1', 'fec0::1',
      '::127.0.0.1', '::ffff:127.0.0.1', '::ffff:1.1.1.1', '100::1', '192.88.99.1',
      '2001:2::1', '2001:10::1', '2001:20::1', '3fff::1', '5f00::1',
      '64:ff9b::7f00:1', '64:ff9b:1::7f00:1', '2002:7f00:1::', '2001:0000::',
    ]) {
      assert.strictEqual(isBlockedAddress(address), true, `${address} must be blocked`);
    }
    for (const address of ['1.1.1.1', '2606:4700:4700::1111', '192.0.0.9', '192.0.0.10', '192.88.99.2']) {
      assert.strictEqual(isBlockedAddress(address), false, `${address} must remain publicly routable`);
    }

    const deadlineStartedAt = Date.now();
    let deadlineTimer;
    const deadlineRequest = requestText('http://example.test/deadline', '', {
      urlPolicyOptions: { allowedHosts: ['example.test'], resolver: () => new Promise(() => {}) },
      deadlineMs: 50,
    });
    try {
      await assert.rejects(
        Promise.race([
          deadlineRequest,
          new Promise((_, reject) => {
            deadlineTimer = setTimeout(() => reject(new Error('resolver deadline did not reject within 500ms')), 450);
          }),
        ]),
        error => error && error.code === 'UPSTREAM_DEADLINE' && error.statusCode === 504,
        'pending resolver must reject with UPSTREAM_DEADLINE/504',
      );
      assert.ok(Date.now() - deadlineStartedAt < 500, 'resolver deadline must reject within 500ms');
    } finally {
      clearTimeout(deadlineTimer);
    }

    const upstream = await listen((req, res) => {
      if (req.url === '/private') { res.writeHead(302, { Location: 'http://127.0.0.1/private' }); return res.end(); }
      if (req.url === '/unknown') { res.writeHead(302, { Location: 'http://unknown.test/x' }); return res.end(); }
      if (req.url === '/declared') { res.writeHead(200, { 'Content-Length': '100' }); return res.end('x'); }
      if (req.url === '/stream') { res.writeHead(200); res.write('x'.repeat(40)); return res.end('y'.repeat(40)); }
      if (req.url === '/idle') { res.writeHead(200); res.write('x'); return; }
      if (req.url === '/r1') return setTimeout(() => { res.writeHead(302, { Location: '/r2' }); res.end(); }, 25);
      if (req.url === '/r2') return setTimeout(() => { res.writeHead(302, { Location: '/done' }); res.end(); }, 25);
      res.end('ok');
    });
    servers.push(upstream);
    const upstreamPort = upstream.address().port;
    const redirectPolicy = createUrlPolicy({ allowedHosts: ['example.test', '127.0.0.1'], resolver: publicResolver });
    const baseOptions = { validateUrl: redirectPolicy, requestFactory: localRequestFactory(upstreamPort), idleTimeoutMs: 200, deadlineMs: 500 };
    await expectHttpError(() => requestText('http://example.test/private', '', baseOptions), 403, 'PRIVATE_ADDRESS');
    await expectHttpError(() => requestText('http://example.test/unknown', '', baseOptions), 403, 'SITE_NOT_ALLOWED');
    await expectHttpError(() => requestText('http://example.test/declared', '', { ...baseOptions, maxBytes: 64 }), 502, 'UPSTREAM_TOO_LARGE');
    await expectHttpError(() => requestText('http://example.test/stream', '', { ...baseOptions, maxBytes: 64 }), 502, 'UPSTREAM_TOO_LARGE');
    await expectHttpError(() => requestText('http://example.test/idle', '', { ...baseOptions, idleTimeoutMs: 40 }), 504, 'UPSTREAM_IDLE_TIMEOUT');
    await expectHttpError(() => requestText('http://example.test/r1', '', { ...baseOptions, deadlineMs: 40 }), 504, 'UPSTREAM_DEADLINE');

    const lookup = pinnedLookup([
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '1.1.1.1', family: 4 },
    ]);
    await new Promise((resolve, reject) => lookup('pinned.test', { all: true, verbatim: true }, (error, addresses) => {
      if (error) return reject(error);
      try {
        assert.deepStrictEqual(addresses, [
          { address: '2606:4700:4700::1111', family: 6 },
          { address: '1.1.1.1', family: 4 },
        ]);
        resolve();
      } catch (assertionError) { reject(assertionError); }
    }));
    await new Promise((resolve, reject) => lookup('pinned.test', { all: true, family: 4 }, (error, addresses) => {
      if (error) return reject(error);
      try { assert.deepStrictEqual(addresses, [{ address: '1.1.1.1', family: 4 }]); resolve(); }
      catch (assertionError) { reject(assertionError); }
    }));
    await new Promise(resolve => lookup('pinned.test', { family: 5 }, error => {
      assert.strictEqual(error && error.code, 'ENOTFOUND');
      assert.strictEqual(error && error.syscall, 'getaddrinfo');
      resolve();
    }));

    let receivedHost = '';
    const pinnedUpstream = await listen((req, res) => {
      receivedHost = req.headers.host;
      res.end('pinned-ok');
    });
    servers.push(pinnedUpstream);
    const pinnedPort = pinnedUpstream.address().port;
    const pinnedText = await requestText(`http://pinned.test:${pinnedPort}/transport`, '', {
      validateUrl: async value => ({
        url: new URL(value),
        addresses: [{ address: '127.0.0.1', family: 4 }],
      }),
      idleTimeoutMs: 200,
      deadlineMs: 1000,
    });
    assert.strictEqual(pinnedText, 'pinned-ok', 'real transport must connect through pinned lookup');
    assert.strictEqual(receivedHost, `pinned.test:${pinnedPort}`, 'real transport must preserve the original Host header');

    let transportSeen = false;
    const text = await requestText('https://example.test/done', '', {
      validateUrl: createUrlPolicy({ allowedHosts: ['example.test'], resolver: publicResolver }),
      requestFactory: localRequestFactory(upstreamPort, (url, options) => {
        transportSeen = true;
        assert.strictEqual(url.hostname, 'example.test');
        assert.strictEqual(options.servername, 'example.test');
        assert.strictEqual(typeof options.lookup, 'function');
        options.lookup('example.test', { family: 4 }, (error, address) => { assert.ifError(error); assert.strictEqual(address, '93.184.216.34'); });
      }),
      idleTimeoutMs: 200, deadlineMs: 500,
    });
    assert.strictEqual(text, 'ok');
    assert.strictEqual(transportSeen, true, 'requestFactory injection must observe pinned DNS and SNI');
    console.log('stage2-security-smoke-ok');
  } finally {
    if (app) await app.close().catch(() => {});
    for (const server of servers.reverse()) await closeServer(server).catch(() => {});
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

let timer;
Promise.race([
  run(),
  new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stage2 security smoke timed out')), 4500); }),
]).then(() => { clearTimeout(timer); }, error => { clearTimeout(timer); console.error(error.stack || error); process.exitCode = 1; });
