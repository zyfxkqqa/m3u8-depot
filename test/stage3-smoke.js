const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { checkPlayUrls } = require('../lib/parse-workflow');
const { createRuntimeLogger } = require('../lib/runtime-logger');
const { createApplication } = require('../server');

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function requestJson(port, requestPath, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'X-M3U8-Local-Request': '1',
        'Content-Length': Buffer.byteLength(payload),
      } : {},
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(text) });
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${text}`));
        }
      });
    });
    request.setTimeout(2000, () => request.destroy(new Error('request timed out')));
    request.on('error', reject);
    request.end(payload || undefined);
  });
}

async function run() {
  const { getPollDelay, createPollingController } = await import('../static/js/polling.mjs');
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm3u8-stage3-'));
  try {
    const urls = Array.from({ length: 10 }, (_, index) => `https://example.test/${index}`);
    let activeParses = 0;
    let maxActiveParses = 0;
    const parseResult = await checkPlayUrls(urls, { findDuplicate: () => null }, {
      concurrency: 4,
      parsePlayPage: async pageUrl => {
        const index = Number(pageUrl.split('/').pop());
        activeParses += 1;
        maxActiveParses = Math.max(maxActiveParses, activeParses);
        await new Promise(resolve => setTimeout(resolve, index % 3 === 0 ? 15 : 3));
        activeParses -= 1;
        if (index === 5) throw new Error('expected parse failure');
        return { pageUrl, title: `Video ${index}`, m3u8Url: `${pageUrl}.m3u8` };
      },
    });
    assert.strictEqual(maxActiveParses, 4);
    assert.deepStrictEqual(parseResult.items.map(item => item.pageUrl), urls);
    assert.strictEqual(parseResult.items[5].status, 'parse_failed');
    assert.strictEqual(parseResult.summary.total, 10);
    assert.strictEqual(parseResult.summary.failed, 1);

    for (const concurrencyValue of [0, 'invalid', -2]) {
      let active = 0;
      let maxActive = 0;
      const result = await checkPlayUrls(['sync', 'async', 'ok', 'last'], { findDuplicate: () => null }, {
        concurrency: concurrencyValue,
        parsePlayPage: pageUrl => {
          if (pageUrl === 'sync') throw new Error('sync failure');
          if (pageUrl === 'async') return Promise.reject(new Error('async failure'));
          active += 1;
          maxActive = Math.max(maxActive, active);
          return new Promise(resolve => setTimeout(() => {
            active -= 1;
            resolve({ pageUrl, title: pageUrl, m3u8Url: `${pageUrl}.m3u8` });
          }, 5));
        },
      });
      assert.ok(maxActive <= 4, `invalid concurrency escaped default limit: ${concurrencyValue}`);
      assert.deepStrictEqual(result.items.map(item => item.pageUrl), ['sync', 'async', 'ok', 'last']);
      assert.strictEqual(result.items[0].status, 'parse_failed');
      assert.strictEqual(result.items[1].status, 'parse_failed');
    }
    let serialActive = 0;
    let serialMax = 0;
    await checkPlayUrls(['a', 'b', 'c'], { findDuplicate: () => null }, {
      concurrency: 1,
      parsePlayPage: async pageUrl => {
        serialActive += 1;
        serialMax = Math.max(serialMax, serialActive);
        await new Promise(resolve => setTimeout(resolve, 3));
        serialActive -= 1;
        return { pageUrl, title: pageUrl, m3u8Url: `${pageUrl}.m3u8` };
      },
    });
    assert.strictEqual(serialMax, 1);

    assert.strictEqual(getPollDelay([{ status: 'running' }], false), 1500);
    assert.strictEqual(getPollDelay([{ status: 'queued' }], false), 1500);
    assert.strictEqual(getPollDelay([{ status: 'retrying' }], false), 1500);
    assert.strictEqual(getPollDelay([{ status: 'committing' }], false), 1500);
    assert.strictEqual(getPollDelay([{ status: 'done' }], false), 5000);
    assert.strictEqual(getPollDelay([{ status: 'running' }], true), 10000);

    const timers = new Map();
    let nextTimerId = 1;
    let refreshCalls = 0;
    let concurrentRefreshes = 0;
    let maxConcurrentRefreshes = 0;
    const refreshGate = deferred();
    const controller = createPollingController({
      refresh: async () => {
        refreshCalls += 1;
        concurrentRefreshes += 1;
        maxConcurrentRefreshes = Math.max(maxConcurrentRefreshes, concurrentRefreshes);
        await refreshGate.promise;
        concurrentRefreshes -= 1;
      },
      getTasks: () => [{ status: 'running' }],
      isHidden: () => false,
      setTimeoutFn: (callback, delay) => {
        const id = nextTimerId++;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeoutFn: id => timers.delete(id),
    });
    const firstRefresh = controller.start();
    const overlappingRefresh = controller.refreshNow();
    assert.strictEqual(firstRefresh, overlappingRefresh);
    assert.strictEqual(refreshCalls, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(refreshCalls, 1);
    refreshGate.resolve();
    await firstRefresh;
    assert.strictEqual(maxConcurrentRefreshes, 1);
    assert.strictEqual(timers.size, 1);
    assert.strictEqual([...timers.values()][0].delay, 1500);
    controller.reschedule();
    assert.strictEqual(timers.size, 1, 'reschedule must replace the old timer');
    controller.stop();
    assert.strictEqual(timers.size, 0);
    const restartGate = deferred();
    const restarted = createPollingController({
      refresh: () => restartGate.promise,
      getTasks: () => [],
      isHidden: () => false,
      setTimeoutFn: (callback, delay) => {
        const id = nextTimerId++;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeoutFn: id => timers.delete(id),
    });
    restarted.stop();
    const restartedPromise = restarted.start();
    assert.strictEqual(restarted.isStopped(), false);
    assert.strictEqual(restarted.start(), restartedPromise, 'start must be idempotent while refreshing');
    restarted.stop();
    restartGate.resolve();
    await restartedPromise;
    assert.strictEqual(timers.size, 0, 'stopped controller scheduled after in-flight refresh');
    const afterBfcache = restarted.start();
    await afterBfcache;
    assert.strictEqual(timers.size, 1, 'pageshow-style restart did not schedule polling');
    restarted.stop();

    const failureTimers = new Map();
    let failureTimerId = 1;
    let failedRefreshCalls = 0;
    const failingController = createPollingController({
      refresh: async () => {
        failedRefreshCalls += 1;
        if (failedRefreshCalls === 1) throw new Error('expected refresh failure');
      },
      getTasks: () => [],
      isHidden: () => false,
      setTimeoutFn: (callback, delay) => {
        const id = failureTimerId++;
        failureTimers.set(id, { callback, delay });
        return id;
      },
      clearTimeoutFn: id => failureTimers.delete(id),
    });
    await assert.rejects(failingController.start(), /expected refresh failure/);
    assert.strictEqual(failureTimers.size, 1, 'failed refresh did not restore automatic polling');
    const pendingTimer = [...failureTimers.entries()][0];
    failureTimers.delete(pendingTimer[0]);
    pendingTimer[1].callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(failedRefreshCalls, 2);
    assert.strictEqual(failureTimers.size, 1);
    await failingController.refreshNow();
    assert.strictEqual(failureTimers.size, 1, 'manual refresh did not restore one automatic timer');
    failingController.stop();

    const raceTimers = new Map();
    let raceTimerId = 1;
    const oldGate = deferred();
    const newGate = deferred();
    const raceContexts = [];
    const committedValues = [];
    const unhandled = [];
    const unhandledListener = reason => unhandled.push(reason);
    process.on('unhandledRejection', unhandledListener);
    try {
      const raceController = createPollingController({
        refresh: async context => {
          raceContexts.push(context);
          const value = raceContexts.length === 1 ? await oldGate.promise : await newGate.promise;
          if (context.isCurrent()) committedValues.push(value);
        },
        getTasks: () => [],
        isHidden: () => false,
        setTimeoutFn: (callback, delay) => {
          const id = raceTimerId++;
          raceTimers.set(id, { callback, delay });
          return id;
        },
        clearTimeoutFn: id => raceTimers.delete(id),
      });
      const oldRefresh = raceController.start();
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(raceContexts.length, 1);
      const oldGeneration = raceContexts[0].generation;
      raceController.stop();
      const newRefresh = raceController.start();
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(raceContexts.length, 2, 'new generation reused old refresh promise');
      assert.notStrictEqual(raceContexts[1].generation, oldGeneration);
      newGate.resolve('new-value');
      await newRefresh;
      assert.deepStrictEqual(committedValues, ['new-value']);
      assert.strictEqual(raceTimers.size, 1);
      oldGate.resolve('old-value');
      await oldRefresh;
      await new Promise(resolve => setImmediate(resolve));
      assert.deepStrictEqual(committedValues, ['new-value'], 'old generation overwrote new state');
      assert.strictEqual(raceTimers.size, 1, 'old generation changed new timer');
      raceController.stop();

      const rejectOldGate = deferred();
      const resolveNewGate = deferred();
      let rejectCalls = 0;
      const rejectController = createPollingController({
        refresh: async context => {
          rejectCalls += 1;
          if (rejectCalls === 1) {
            await rejectOldGate.promise;
            throw new Error('stale refresh rejection');
          }
          const value = await resolveNewGate.promise;
          if (context.isCurrent()) committedValues.push(value);
        },
        getTasks: () => [],
        isHidden: () => false,
        setTimeoutFn: (callback, delay) => {
          const id = raceTimerId++;
          raceTimers.set(id, { callback, delay });
          return id;
        },
        clearTimeoutFn: id => raceTimers.delete(id),
      });
      const staleReject = rejectController.start();
      await new Promise(resolve => setImmediate(resolve));
      rejectController.stop();
      const currentResolve = rejectController.start();
      await new Promise(resolve => setImmediate(resolve));
      resolveNewGate.resolve('new-after-reject');
      await currentResolve;
      rejectOldGate.resolve();
      await staleReject;
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(unhandled.length, 0, 'stale rejection became unhandled');
      assert.strictEqual(raceTimers.size, 1);
      rejectController.stop();
    } finally {
      process.off('unhandledRejection', unhandledListener);
    }

    const logDir = path.join(root, 'logs');
    const logFile = path.join(logDir, 'runtime.log');
    const rotatingLogger = createRuntimeLogger({ filePath: logFile, maxBytes: 90, maxFiles: 3 });
    for (let index = 0; index < 12; index += 1) {
      rotatingLogger.log(`event-${index}-${'x'.repeat(30)}`);
    }
    await rotatingLogger.close();
    const logFiles = (await fs.promises.readdir(logDir)).filter(name => name.startsWith('runtime.log'));
    assert.ok(logFiles.length <= 3);
    assert.ok(logFiles.includes('runtime.log'));
    assert.ok(logFiles.includes('runtime.log.1'));

    const orderedLogFile = path.join(root, 'ordered', 'runtime.log');
    const orderedLogger = createRuntimeLogger({ filePath: orderedLogFile, maxBytes: 1024 * 1024, maxFiles: 3 });
    await Promise.all(Array.from({ length: 25 }, (_, index) => orderedLogger.log(`ordered-${String(index).padStart(2, '0')}`)));
    await orderedLogger.close();
    const orderedText = await fs.promises.readFile(orderedLogFile, 'utf8');
    for (let index = 0; index < 25; index += 1) {
      const current = `ordered-${String(index).padStart(2, '0')}`;
      assert.strictEqual(orderedText.split(current).length - 1, 1, `${current} missing or duplicated`);
      if (index > 0) {
        const previous = `ordered-${String(index - 1).padStart(2, '0')}`;
        assert.ok(orderedText.indexOf(previous) < orderedText.indexOf(current), 'log order changed');
      }
    }

    const appRoot = path.join(root, 'app');
    const logMessages = [];
    const runtimeLogger = {
      log: (message, error) => { logMessages.push({ message, error }); },
      close: async () => {},
    };
    const appConfig = {
      HOST: '127.0.0.1',
      PORT: 0,
      ROOT_DIR: appRoot,
      STATIC_DIR: path.join(__dirname, '..', 'static'),
      DATA_DIR: path.join(appRoot, 'data'),
      TASKS_FILE: path.join(appRoot, 'data', 'tasks.json'),
      OUTPUT_DIR: path.join(appRoot, 'output'),
      FFMPEG: path.join(appRoot, 'missing-ffmpeg.exe'),
      USER_AGENT: 'stage3-smoke',
      MAX_ACTIVE_TASKS: 1,
      PARSE_CONCURRENCY: 2,
    };
    const app = createApplication(appConfig, { runtimeLogger });
    const address = await app.start();
    await app.store.addParsedTask({
      title: 'Manual One',
      pageUrl: 'https://example.test/manual-one',
      m3u8Url: 'https://example.test/manual-one.m3u8',
    });
    const batchOne = await app.store.addParsedTask({
      title: 'Batch One',
      pageUrl: 'https://example.test/batch-one',
      m3u8Url: 'https://example.test/batch-one.m3u8',
    }, { batchId: 'batch-a', batchTitle: 'Batch A' });
    await app.store.updateTask(batchOne.id, { status: 'failed' });
    const batchTwo = await app.store.addParsedTask({
      title: 'Batch Two',
      pageUrl: 'https://example.test/batch-two',
      m3u8Url: 'https://example.test/batch-two.m3u8',
    }, { batchId: 'batch-a', batchTitle: 'Batch A' });
    await app.store.updateTask(batchTwo.id, { status: 'done' });

    const compatibility = await requestJson(address.port, '/api/tasks');
    assert.strictEqual(compatibility.status, 200);
    assert.strictEqual(compatibility.body.tasks.length, 3);
    assert.strictEqual('total' in compatibility.body, false);

    const paged = await requestJson(address.port, '/api/tasks?page=1&pageSize=1&batch=batch-a');
    assert.strictEqual(paged.status, 200);
    assert.strictEqual(paged.body.tasks.length, 1);
    assert.strictEqual(paged.body.total, 2);
    assert.strictEqual(paged.body.page, 1);
    assert.strictEqual(paged.body.pageSize, 1);
    assert.strictEqual(paged.body.statusCounts.failed, 1);
    assert.strictEqual(paged.body.statusCounts.done, 1);

    const filtered = await requestJson(address.port, '/api/tasks?page=1&pageSize=20&status=failed&batch=batch-a');
    assert.strictEqual(filtered.body.total, 1);
    assert.strictEqual(filtered.body.tasks[0].id, batchOne.id);
    const invalidPage = await requestJson(address.port, '/api/tasks?page=0');
    assert.strictEqual(invalidPage.status, 400);
    const invalidSize = await requestJson(address.port, '/api/tasks?pageSize=1000');
    assert.strictEqual(invalidSize.status, 400);
    const invalidStatus = await requestJson(address.port, '/api/tasks?status=unknown');
    assert.strictEqual(invalidStatus.status, 400);
    for (const duplicateQuery of [
      '/api/tasks?page=1&page=2',
      '/api/tasks?pageSize=20&pageSize=50',
      '/api/tasks?status=done&status=failed',
      '/api/tasks?batch=batch-a&batch=batch-b',
    ]) {
      assert.strictEqual((await requestJson(address.port, duplicateQuery)).status, 400, duplicateQuery);
    }
    for (const invalidInteger of ['', '0', '-1', '+1', '1.0', '1e2', 'NaN', ' 1', '1 ']) {
      const encoded = encodeURIComponent(invalidInteger);
      assert.strictEqual((await requestJson(address.port, `/api/tasks?page=${encoded}`)).status, 400, `page=${invalidInteger}`);
      assert.strictEqual((await requestJson(address.port, `/api/tasks?pageSize=${encoded}`)).status, 400, `pageSize=${invalidInteger}`);
    }
    for (const status of ['parsed', 'queued', 'running', 'retrying', 'committing', 'done', 'failed']) {
      assert.strictEqual((await requestJson(address.port, `/api/tasks?status=${status}`)).status, 200, status);
    }
    assert.strictEqual((await requestJson(address.port, '/api/tasks?batch=__manual__')).status, 200);
    assert.strictEqual((await requestJson(address.port, '/api/tasks?batch=')).status, 400);
    assert.strictEqual((await requestJson(address.port, '/api/tasks?batch=__unknown__')).status, 400);
    assert.strictEqual((await requestJson(address.port, `/api/tasks?batch=${'x'.repeat(201)}`)).status, 400);

    await requestJson(address.port, '/api/health');
    await requestJson(address.port, '/api/tasks');
    assert.strictEqual(logMessages.some(entry => entry.message === 'GET /api/health'), false);
    assert.strictEqual(logMessages.some(entry => entry.message === 'GET /api/tasks'), false);
    assert.strictEqual(logMessages.some(entry => entry.message.startsWith('server started:')), true);
    await requestJson(address.port, '/api/detail/parse', 'POST', { url: 'not-a-url' });
    assert.strictEqual(logMessages.some(entry => entry.message.startsWith('POST /api/detail/parse')), true);
    await app.close();

    const defaultLogRoot = path.join(root, 'default-logger-app');
    const defaultLogConfig = {
      ...appConfig,
      ROOT_DIR: defaultLogRoot,
      DATA_DIR: path.join(defaultLogRoot, 'data'),
      TASKS_FILE: path.join(defaultLogRoot, 'data', 'tasks.json'),
      OUTPUT_DIR: path.join(defaultLogRoot, 'output'),
      PORT: 0,
    };
    const defaultLogApp = createApplication(defaultLogConfig);
    await defaultLogApp.start();
    defaultLogApp.logger.log('flush-before-close');
    await defaultLogApp.close();
    const defaultLogText = await fs.promises.readFile(path.join(defaultLogRoot, 'server-runtime.log'), 'utf8');
    assert.match(defaultLogText, /server started:/);
    assert.match(defaultLogText, /flush-before-close/);

    console.log('stage3-smoke-ok');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
