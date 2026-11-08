const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createApplication } = require('../server');
const { requestText } = require('../lib/http-client');

function post(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-M3U8-Local-Request': '1', 'Content-Length': Buffer.byteLength(payload) },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(payload);
  });
}

async function run() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm3u8-stage3-shutdown-'));
  let app;
  let upstream;
  try {
    let resolverStarted;
    const resolverGate = new Promise(resolve => { resolverStarted = resolve; });
    const runtimeConfig = {
      HOST: '127.0.0.1', PORT: 0, ROOT_DIR: root, STATIC_DIR: path.join(root, 'static'),
      DATA_DIR: path.join(root, 'data'), TASKS_FILE: path.join(root, 'data', 'tasks.json'),
      OUTPUT_DIR: path.join(root, 'output'), FFMPEG: path.join(root, 'missing.exe'),
      USER_AGENT: 'stage3-shutdown', MAX_ACTIVE_TASKS: 1, PARSE_CONCURRENCY: 1,
    };
    app = createApplication(runtimeConfig, {
      shutdownTimeoutMs: 200,
      runtimeLogger: { log: () => {}, close: async () => {} },
      schedulerOptions: { runTask: async () => {} },
      urlPolicyOptions: {
        allowedHosts: ['pending.test'],
        resolver: () => { resolverStarted(); return new Promise(() => {}); },
      },
    });
    const address = await app.start();
    const pendingRequest = post(address.port, '/api/detail/parse', { url: 'http://pending.test/video' }).catch(error => error);
    await resolverGate;
    const startedAt = Date.now();
    await app.close();
    assert.ok(Date.now() - startedAt < 700, 'close must not wait for pending DNS');
    await Promise.race([pendingRequest, new Promise((_, reject) => setTimeout(() => reject(new Error('aborted parse request stayed open')), 500))]);

    upstream = http.createServer((_req, res) => { res.writeHead(200); res.write('partial'); });
    await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
    const controller = new AbortController();
    let streamStarted;
    const streamGate = new Promise(resolve => { streamStarted = resolve; });
    upstream.once('request', streamStarted);
    const streamRequest = requestText(`http://stream.test:${upstream.address().port}/video`, '', {
      signal: controller.signal, deadlineMs: 5000, idleTimeoutMs: 5000,
      validateUrl: async value => ({ url: new URL(value), addresses: [{ address: '127.0.0.1', family: 4 }] }),
    });
    await streamGate;
    controller.abort();
    await assert.rejects(streamRequest, error => error && error.code === 'UPSTREAM_ABORTED');
    await new Promise(resolve => upstream.close(resolve));
    upstream = null;

    const pendingLoggerConfig = {
      ...runtimeConfig,
      DATA_DIR: path.join(root, 'pending-logger-data'),
      TASKS_FILE: path.join(root, 'pending-logger-data', 'tasks.json'),
      OUTPUT_DIR: path.join(root, 'pending-logger-output'),
    };
    const pendingLoggerApp = createApplication(pendingLoggerConfig, {
      shutdownTimeoutMs: 150,
      runtimeLogger: { log: () => {}, close: () => new Promise(() => {}) },
      schedulerOptions: { runTask: async () => {} },
    });
    const pendingLoggerStartedAt = Date.now();
    await assert.rejects(pendingLoggerApp.close(), error => {
      assert.strictEqual(error.code, 'SHUTDOWN_FAILED');
      assert.ok(error.failures.some(failure => failure.resource === 'runtime logger' && failure.code === 'SHUTDOWN_TIMEOUT'));
      return true;
    });
    assert.ok(Date.now() - pendingLoggerStartedAt < 700, 'pending logger must respect the total shutdown deadline');

    let loggerCloseCalls = 0;
    const throwingStoreConfig = {
      ...runtimeConfig,
      DATA_DIR: path.join(root, 'throwing-store-data'),
      TASKS_FILE: path.join(root, 'throwing-store-data', 'tasks.json'),
      OUTPUT_DIR: path.join(root, 'throwing-store-output'),
    };
    const throwingStoreApp = createApplication(throwingStoreConfig, {
      shutdownTimeoutMs: 300,
      runtimeLogger: {
        log: () => {},
        close: async () => { loggerCloseCalls += 1; },
      },
      schedulerOptions: { runTask: async () => {} },
    });
    throwingStoreApp.store.close = async () => { throw new Error('STORE_CLOSE_TEST_FAILURE'); };
    await assert.rejects(throwingStoreApp.close(), error => {
      assert.strictEqual(error.code, 'SHUTDOWN_FAILED');
      assert.ok(error.failures.some(failure => failure.resource === 'task store' && failure.message === 'STORE_CLOSE_TEST_FAILURE'));
      return true;
    });
    assert.strictEqual(loggerCloseCalls, 1, 'logger.close must run when store.close throws');
    console.log('stage3-shutdown-smoke-ok');
  } finally {
    if (app) await app.close().catch(() => {});
    if (upstream) { upstream.closeAllConnections?.(); await new Promise(resolve => upstream.close(resolve)); }
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

let timer;
Promise.race([
  run(),
  new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stage3 shutdown smoke timed out')), 8000); }),
]).then(() => clearTimeout(timer), error => { clearTimeout(timer); console.error(error.stack || error); process.exitCode = 1; });
