const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { createTaskStore, retryFileOperation } = require('../lib/task-store');
const { createScheduler } = require('../lib/scheduler');
const { runFfmpegTask } = require('../lib/ffmpeg-runner');
const { createApplication } = require('../server');

function waitFor(predicate, timeoutMs = 2000, label = 'condition') {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error(`${label} timed out`));
      setTimeout(check, 5);
    };
    check();
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createFakeChild(onKill) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.kill = signal => {
    child.killCalls.push(signal);
    if (onKill) onKill(child, signal);
    return true;
  };
  return child;
}

async function captureUnhandled(runTest) {
  const unhandled = [];
  const listener = reason => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const result = await runTest();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(unhandled.length, 0, 'runner emitted unhandledRejection');
    return result;
  } finally {
    process.off('unhandledRejection', listener);
  }
}

async function requestJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-M3U8-Local-Request': '1',
        'Content-Length': Buffer.byteLength(payload),
      },
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
    request.setTimeout(3000, () => request.destroy(new Error('request timed out')));
    request.on('error', reject);
    request.end(payload);
  });
}

async function run() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm3u8-stage1-'));
  const dataDir = path.join(root, 'data');
  const outputDir = path.join(root, 'output');
  const tasksFile = path.join(dataDir, 'tasks.json');
  let writes = 0;

  const store = createTaskStore({
    dataDir,
    tasksFile,
    outputDir,
    throttleMs: 40,
    retryDelayMs: 1,
    onWrite: () => { writes += 1; },
  });
  await store.loadTasks();
  const task = await store.addParsedTask({
    title: 'stage1',
    pageUrl: 'https://example.test/play/1',
    m3u8Url: 'https://example.test/video.m3u8',
  });
  const writesAfterAdd = writes;
  for (let index = 0; index < 25; index += 1) {
    await store.updateTask(task.id, { progressText: `progress-${index}` });
  }
  assert.strictEqual(writes, writesAfterAdd, 'progress writes must be throttled');
  await store.flush();
  assert.ok(writes <= writesAfterAdd + 1, 'progress burst should produce one extra snapshot');
  assert.strictEqual(JSON.parse(await fs.promises.readFile(tasksFile, 'utf8'))[0].progressText, 'progress-24');

  await store.updateTask(task.id, { status: 'done', completedAt: new Date().toISOString() });
  assert.ok(fs.existsSync(`${tasksFile}.bak`), 'backup must exist after replacing a healthy store');
  await store.close();

  await fs.promises.writeFile(tasksFile, '{broken json', 'utf8');
  const recoveredStore = createTaskStore({ dataDir, tasksFile, outputDir, throttleMs: 10 });
  const recovery = await recoveredStore.loadTasks();
  assert.strictEqual(recovery.recovered, true);
  assert.strictEqual(recoveredStore.listTasks().length, 1);
  JSON.parse(await fs.promises.readFile(tasksFile, 'utf8'));
  await recoveredStore.close();

  let attempts = 0;
  await retryFileOperation(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('simulated busy');
      error.code = 'EBUSY';
      throw error;
    }
  }, { attempts: 4, retryDelayMs: 1 });
  assert.strictEqual(attempts, 3);

  const schedulerTasks = new Map([
    ['one', { id: 'one', status: 'queued' }],
    ['two', { id: 'two', status: 'queued' }],
    ['three', { id: 'three', status: 'queued' }],
  ]);
  const schedulerStore = {
    tasks: schedulerTasks,
    updateTask: async (id, patch) => Object.assign(schedulerTasks.get(id), patch),
  };
  const gates = new Map();
  const starts = new Map();
  let concurrent = 0;
  let maxConcurrent = 0;
  const scheduler = createScheduler(schedulerStore, {
    maxActiveTasks: 2,
    runTask: async taskToRun => {
      starts.set(taskToRun.id, (starts.get(taskToRun.id) || 0) + 1);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const gate = deferred();
      gates.set(taskToRun.id, gate);
      await gate.promise;
      concurrent -= 1;
      taskToRun.status = 'done';
    },
  });
  scheduler.schedule();
  scheduler.schedule();
  await waitFor(() => scheduler.getActiveCount() === 2, 2000, 'initial scheduler capacity');
  scheduler.schedule();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(starts.get('one'), 1, 'same queued task must only start once');
  assert.strictEqual(starts.get('two'), 1, 'same queued task must only start once');
  assert.strictEqual(maxConcurrent, 2, 'scheduler must obey maxActiveTasks');
  gates.get('one').resolve();
  await waitFor(() => starts.get('three') === 1, 2000, 'third scheduler task');
  gates.get('two').resolve();
  gates.get('three').resolve();
  await scheduler.drain();
  assert.strictEqual(maxConcurrent, 2);
  assert.strictEqual(scheduler.getReservedCount(), 0, 'custom runner must not reserve managed output paths');

  const customPartPath = path.join(root, 'custom-runner.part.mp4');
  const customOutputPath = path.join(root, 'custom-runner.mp4');
  await fs.promises.writeFile(customPartPath, 'keep-part');
  await fs.promises.writeFile(customOutputPath, 'keep-output');
  const customDeleteTasks = new Map([['custom-delete', {
    id: 'custom-delete',
    status: 'parsed',
    partPath: customPartPath,
    output: customOutputPath,
  }]]);
  const customDeleteStore = {
    tasks: customDeleteTasks,
    updateTask: async (id, patch) => Object.assign(customDeleteTasks.get(id), patch),
    markTasksDeleting: async ids => {
      const existingIds = [...new Set(ids)].filter(id => customDeleteTasks.has(id));
      for (const id of existingIds) customDeleteTasks.get(id).status = 'deleting';
      return existingIds;
    },
    deleteTasks: async ids => {
      for (const id of ids) customDeleteTasks.delete(id);
    },
  };
  const customDeleteScheduler = createScheduler(customDeleteStore, {
    maxActiveTasks: 1,
    runTask: async () => {},
  });
  assert.strictEqual(customDeleteScheduler.getReservedCount(), 0);
  await customDeleteScheduler.deleteTasks(['custom-delete']);
  assert.strictEqual(customDeleteTasks.has('custom-delete'), false);
  assert.strictEqual(fs.existsSync(customPartPath), true, 'custom runner delete must not remove partPath');
  assert.strictEqual(fs.existsSync(customOutputPath), true, 'custom runner delete must not remove output');
  await customDeleteScheduler.stop();

  const persistError = new Error('persist-fail');
  const runnerTask = suffix => ({
    id: `persist-${suffix}`,
    title: `persist-${suffix}`,
    pageUrl: 'https://example.test/play',
    m3u8Url: 'https://example.test/video.m3u8',
  });
  const runnerOptions = { outputDir, userAgent: 'test', ffmpeg: 'unused', terminationGraceMs: 10, terminationForceSettleMs: 30 };
  const watchdogOptions = {
    ...runnerOptions,
    initialProgressTimeoutMs: 50,
    stallTimeoutMs: 50,
    stallCheckIntervalMs: 5,
  };
  const expectedNetworkRecoveryArgs = [
    ['-rw_timeout', '15000000'],
    ['-reconnect', '1'],
    ['-reconnect_streamed', '1'],
    ['-reconnect_on_network_error', '1'],
    ['-reconnect_delay_max', '5'],
    ['-reconnect_max_retries', '2'],
    ['-reconnect_delay_total_max', '15'],
  ];

  async function assertNetworkRecoveryArgs(suffix, optionOverrides, expectedArgs) {
    const child = createFakeChild();
    let spawnArgs;
    await runFfmpegTask(runnerTask(suffix), {
      ...runnerOptions,
      ...optionOverrides,
      spawnProcess: (_command, args) => {
        spawnArgs = args;
        fs.writeFileSync(args[args.length - 1], 'mp4');
        setImmediate(() => child.emit('close', 0));
        return child;
      },
    }, async () => {});

    const inputIndex = spawnArgs.indexOf('-i');
    assert.ok(inputIndex > 0, 'FFmpeg input flag must exist');
    for (const [flag, value] of expectedArgs) {
      const indexes = spawnArgs.reduce((matches, arg, index) => {
        if (arg === flag) matches.push(index);
        return matches;
      }, []);
      assert.deepStrictEqual(indexes.length, 1, `${flag} must appear exactly once`);
      assert.ok(indexes[0] < inputIndex, `${flag} must appear before -i`);
      assert.strictEqual(spawnArgs[indexes[0] + 1], value, `${flag} must use the expected value`);
    }
    assert.strictEqual(spawnArgs.includes('-reconnect_at_eof'), false, 'VOD EOF must not trigger reconnect');
  }

  await assertNetworkRecoveryArgs('network-recovery-defaults', {}, expectedNetworkRecoveryArgs);
  await assertNetworkRecoveryArgs('network-recovery-overrides', {
    rwTimeout: 9000000,
    reconnect: 0,
    reconnectStreamed: 0,
    reconnectOnNetworkError: 0,
    reconnectDelayMax: 3,
    reconnectMaxRetries: 1,
    reconnectDelayTotalMax: 7,
  }, [
    ['-rw_timeout', '9000000'],
    ['-reconnect', '0'],
    ['-reconnect_streamed', '0'],
    ['-reconnect_on_network_error', '0'],
    ['-reconnect_delay_max', '3'],
    ['-reconnect_max_retries', '1'],
    ['-reconnect_delay_total_max', '7'],
  ]);

  await captureUnhandled(async () => {
    const child = createFakeChild();
    await runFfmpegTask(runnerTask('watchdog-progress'), {
      ...watchdogOptions,
      spawnProcess: (_command, args) => {
        fs.writeFileSync(args[args.length - 1], 'mp4');
        setTimeout(() => child.stderr.emit('data', Buffer.from('time=00:00:01.00 speed=1x')), 5);
        setTimeout(() => child.stderr.emit('data', Buffer.from('time=00:00:02.00 speed=1x')), 35);
        setTimeout(() => child.stderr.emit('data', Buffer.from('time=00:00:03.00 speed=1x')), 65);
        setTimeout(() => child.emit('close', 0), 90);
        return child;
      },
    }, async () => {});
    assert.deepStrictEqual(child.killCalls, [], 'complete time tokens without record delimiters must keep the watchdog alive');
    await delay(70);
  });

  await captureUnhandled(async () => {
    const child = createFakeChild(fake => setImmediate(() => fake.emit('close', 1)));
    await runFfmpegTask(runnerTask('watchdog-split-progress'), {
      ...watchdogOptions,
      stallTimeoutMs: 150,
      spawnProcess: (_command, args) => {
        fs.writeFileSync(args[args.length - 1], 'mp4');
        setTimeout(() => child.stderr.emit('data', Buffer.from('time=00:0')), 5);
        setTimeout(() => child.stderr.emit('data', Buffer.from('0:01.00 speed=1x\r')), 10);
        setTimeout(() => child.stderr.emit('data', Buffer.from('time=00:00:02.00 speed=1x\r')), 40);
        setTimeout(() => child.stderr.emit('data', Buffer.from('time=00:00:03.00 speed=1x\r')), 70);
        setTimeout(() => child.emit('close', 0), 95);
        return child;
      },
    }, async () => {});
    assert.deepStrictEqual(child.killCalls, [], 'split progress records must keep the watchdog alive');
    await delay(70);
  });

  await captureUnhandled(async () => {
    const child = createFakeChild();
    const progressUpdates = [];
    await runFfmpegTask(runnerTask('multi-progress-chunk'), {
      ...watchdogOptions,
      spawnProcess: (_command, args) => {
        fs.writeFileSync(args[args.length - 1], 'mp4');
        setTimeout(() => child.stderr.emit('data', Buffer.from(
          'time=00:00:01.00 speed=1x\rtime=00:00:02.00 speed=1.1x\r',
        )), 5);
        setTimeout(() => child.emit('close', 0), 20);
        return child;
      },
    }, async (_id, patch) => {
      if (patch.progressText?.startsWith('time=')) progressUpdates.push(patch.progressText);
    });
    assert.deepStrictEqual(progressUpdates, [
      'time=00:00:01.00  speed=1x',
      'time=00:00:02.00  speed=1.1x',
    ], 'each CR-delimited progress record in one chunk must be parsed');
  });

  await captureUnhandled(async () => {
    const child = createFakeChild(fake => setImmediate(() => fake.emit('close', 1)));
    await assert.rejects(
      runFfmpegTask(runnerTask('watchdog-repeat'), {
        ...watchdogOptions,
        spawnProcess: () => {
          setTimeout(() => child.stderr.emit('data', Buffer.from('time=00:00:05.00 speed=1x\r')), 5);
          setTimeout(() => child.stderr.emit('data', Buffer.from('time=00:00:05.00 speed=0.8x\r')), 25);
          setTimeout(() => child.stderr.emit('data', Buffer.from('time=00:00:05.00 size=200kB speed=0.5x\r')), 45);
          setTimeout(() => child.emit('close', 1), 120);
          return child;
        },
      }, async () => {}),
      error => error.code === 'FFMPEG_STALLED',
    );
    assert.deepStrictEqual(child.killCalls, ['SIGTERM'], 'stalled media time must terminate FFmpeg');
  });

  await captureUnhandled(async () => {
    const child = createFakeChild(fake => setImmediate(() => fake.emit('close', 1)));
    await assert.rejects(
      runFfmpegTask(runnerTask('watchdog-initial'), {
        ...watchdogOptions,
        initialProgressTimeoutMs: 30,
        spawnProcess: () => {
          setTimeout(() => child.stderr.emit('data', Buffer.from('size=120kB speed=0.7x\r')), 10);
          setTimeout(() => child.emit('close', 1), 100);
          return child;
        },
      }, async () => {}),
      error => error.code === 'FFMPEG_STALLED',
    );
    assert.deepStrictEqual(child.killCalls, ['SIGTERM'], 'missing initial media progress must terminate FFmpeg');
  });

  await captureUnhandled(async () => {
    const controller = new AbortController();
    const child = createFakeChild(fake => setImmediate(() => fake.emit('close', 1)));
    const runPromise = runFfmpegTask(runnerTask('watchdog-abort'), {
      ...watchdogOptions,
      initialProgressTimeoutMs: 100,
      stallTimeoutMs: 20,
      spawnProcess: () => {
        setTimeout(() => child.stderr.emit('data', Buffer.from('time=00:00:01.00 speed=1x\r')), 5);
        setTimeout(() => controller.abort(), 10);
        return child;
      },
    }, async () => {}, controller.signal);
    await assert.rejects(runPromise, error => error.code === 'TASK_CANCELLED');
    assert.deepStrictEqual(child.killCalls, ['SIGTERM'], 'manual abort must terminate FFmpeg once');
    await delay(50);
  });

  await captureUnhandled(async () => {
    const child = createFakeChild();
    let updates = 0;
    await runFfmpegTask(runnerTask('watchdog-close-cleanup'), {
      ...watchdogOptions,
      initialProgressTimeoutMs: 20,
      stallTimeoutMs: 20,
      spawnProcess: (_command, args) => {
        fs.writeFileSync(args[args.length - 1], 'mp4');
        setTimeout(() => child.emit('close', 0), 5);
        return child;
      },
    }, async () => {
      updates += 1;
      if (updates === 2) await delay(40);
    });
    await delay(50);
    assert.deepStrictEqual(child.killCalls, [], 'normal close must clear watchdog timers');
  });

  await captureUnhandled(async () => {
    let spawnCalls = 0;
    await assert.rejects(
      runFfmpegTask(runnerTask('running'), {
        ...runnerOptions,
        spawnProcess: () => { spawnCalls += 1; },
      }, async () => { throw persistError; }),
      error => error === persistError,
    );
    assert.strictEqual(spawnCalls, 0, 'running persistence failure must prevent spawn');
  });

  await captureUnhandled(async () => {
    let updates = 0;
    const child = createFakeChild(fake => setImmediate(() => fake.emit('close', 1)));
    await assert.rejects(
      runFfmpegTask(runnerTask('progress'), {
        ...runnerOptions,
        spawnProcess: () => {
          setImmediate(() => child.stderr.emit('data', Buffer.from('time=00:00:01.00 speed=1x\r')));
          return child;
        },
      }, async () => {
        updates += 1;
        if (updates === 2) throw persistError;
      }),
      error => error === persistError,
    );
    assert.strictEqual(updates, 2);
    assert.deepStrictEqual(child.killCalls, ['SIGTERM']);
  });

  await captureUnhandled(async () => {
    const controller = new AbortController();
    let updates = 0;
    const child = createFakeChild(fake => setImmediate(() => fake.emit('close', 1)));
    const runPromise = runFfmpegTask(runnerTask('progress-error-abort'), {
      ...runnerOptions,
      spawnProcess: () => {
        setImmediate(() => child.stderr.emit('data', Buffer.from('time=00:00:01.00 speed=1x\r')));
        return child;
      },
    }, async () => {
      updates += 1;
      if (updates === 2) {
        setImmediate(() => controller.abort());
        throw persistError;
      }
    }, controller.signal);
    await assert.rejects(runPromise, error => error.code === 'TASK_CANCELLED');
    assert.deepStrictEqual(child.killCalls, ['SIGTERM']);
  });

  await captureUnhandled(async () => {
    const child = createFakeChild();
    const childError = new Error('child-error');
    await assert.rejects(
      runFfmpegTask(runnerTask('child-error-cleanup'), {
        ...watchdogOptions,
        initialProgressTimeoutMs: 20,
        spawnProcess: () => {
          setTimeout(() => child.emit('error', childError), 5);
          return child;
        },
      }, async () => {}),
      error => error === childError,
    );
    await delay(50);
    assert.deepStrictEqual(child.killCalls, [], 'child error must clear watchdog timers');
  });

  await captureUnhandled(async () => {
    const spawnError = new Error('spawn-error');
    await assert.rejects(
      runFfmpegTask(runnerTask('spawn-error-cleanup'), {
        ...watchdogOptions,
        initialProgressTimeoutMs: 20,
        spawnProcess: () => { throw spawnError; },
      }, async () => {}),
      error => error === spawnError,
    );
    await delay(50);
  });

  await captureUnhandled(async () => {
    let updates = 0;
    const child = createFakeChild();
    await assert.rejects(
      runFfmpegTask(runnerTask('done'), {
        ...runnerOptions,
        spawnProcess: (_command, args) => {
          fs.writeFileSync(args[args.length - 1], 'mp4');
          setImmediate(() => child.emit('close', 0));
          return child;
        },
      }, async () => {
        updates += 1;
        if (updates === 2) throw persistError;
      }),
      error => error === persistError,
    );
    assert.strictEqual(updates, 2);
    assert.deepStrictEqual(child.killCalls, [], 'closed child must not be killed after done persistence failure');
  });

  const preSpawnTasks = new Map([['pre-spawn', {
    ...runnerTask('pre-spawn'),
    id: 'pre-spawn',
    status: 'queued',
  }]]);
  const runningGate = deferred();
  let preSpawnCalls = 0;
  const preSpawnStore = {
    tasks: preSpawnTasks,
    updateTask: async (id, patch) => {
      if (patch.status === 'running') await runningGate.promise;
      return Object.assign(preSpawnTasks.get(id), patch);
    },
  };
  const preSpawnScheduler = createScheduler(preSpawnStore, {
    ...runnerOptions,
    maxActiveTasks: 1,
    runTask: runFfmpegTask,
    spawnProcess: () => { preSpawnCalls += 1; },
  });
  preSpawnScheduler.schedule();
  await waitFor(() => preSpawnScheduler.getActiveCount() === 1, 2000, 'pre-spawn reservation');
  const preSpawnStop = preSpawnScheduler.stop();
  runningGate.resolve();
  await Promise.race([
    preSpawnStop,
    new Promise((_, reject) => setTimeout(() => reject(new Error('pre-spawn stop exceeded 250ms')), 250)),
  ]);
  assert.strictEqual(preSpawnCalls, 0, 'stop before child registration must prevent spawn');
  assert.strictEqual(preSpawnTasks.get('pre-spawn').status, 'parsed');

  const boundaryController = new AbortController();
  const boundaryChild = createFakeChild(fake => setImmediate(() => fake.emit('close', 1)));
  await assert.rejects(
    runFfmpegTask(runnerTask('spawn-boundary'), {
      ...runnerOptions,
      spawnProcess: () => {
        boundaryController.abort();
        return boundaryChild;
      },
    }, async () => {} , boundaryController.signal),
    error => error.code === 'TASK_CANCELLED',
  );
  assert.deepStrictEqual(boundaryChild.killCalls, ['SIGTERM'], 'child created on abort boundary must be terminated once');

  const spawnThrowController = new AbortController();
  const spawnThrowError = new Error('spawn-after-abort');
  await assert.rejects(
    runFfmpegTask(runnerTask('spawn-abort-throw'), {
      ...runnerOptions,
      spawnProcess: () => {
        spawnThrowController.abort();
        throw spawnThrowError;
      },
    }, async () => {}, spawnThrowController.signal),
    error => error.code === 'TASK_CANCELLED',
  );

  const lifecycleTasks = new Map([
    ['success', { id: 'success', status: 'queued' }],
    ['failure', { id: 'failure', status: 'queued' }],
    ['cancel', { id: 'cancel', status: 'queued' }],
    ['after', { id: 'after', status: 'queued' }],
  ]);
  const lifecycleStarts = [];
  const cancelStarted = deferred();
  const lifecycleStore = {
    tasks: lifecycleTasks,
    updateTask: async (id, patch) => Object.assign(lifecycleTasks.get(id), patch),
  };
  const lifecycleScheduler = createScheduler(lifecycleStore, {
    maxActiveTasks: 1,
    runTask: async (taskToRun, _options, _update, signal) => {
      lifecycleStarts.push(taskToRun.id);
      if (taskToRun.id === 'failure') throw new Error('expected failure');
      if (taskToRun.id === 'cancel') {
        cancelStarted.resolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      taskToRun.status = 'done';
    },
  });
  lifecycleScheduler.schedule();
  await cancelStarted.promise;
  assert.strictEqual(await lifecycleScheduler.cancelTask('cancel'), true);
  await waitFor(() => lifecycleTasks.get('after').status === 'done', 2000, 'post-cancel scheduling');
  await lifecycleScheduler.drain();
  assert.deepStrictEqual(lifecycleStarts, ['success', 'failure', 'cancel', 'after']);
  assert.strictEqual(lifecycleTasks.get('failure').status, 'failed');
  assert.strictEqual(lifecycleTasks.get('cancel').status, 'parsed');
  assert.strictEqual(lifecycleScheduler.getActiveCount(), 0);

  for (const errorCode of ['EBUSY', 'EPERM', 'EACCES']) {
    const retryRoot = path.join(root, `retry-${errorCode}`);
    const retryTasksFile = path.join(retryRoot, 'data', 'tasks.json');
    const injected = new Set();
    const retryStore = createTaskStore({
      dataDir: path.dirname(retryTasksFile),
      tasksFile: retryTasksFile,
      outputDir: path.join(retryRoot, 'output'),
      retryDelayMs: 1,
      beforeFsOperation: ({ name }) => {
        if (!['open', 'rename', 'copy-backup'].includes(name) || injected.has(name)) return;
        injected.add(name);
        const error = new Error(`simulated ${errorCode} during ${name}`);
        error.code = errorCode;
        throw error;
      },
    });
    await retryStore.loadTasks();
    const retryTask = await retryStore.addParsedTask({
      title: errorCode,
      pageUrl: `https://example.test/${errorCode}`,
      m3u8Url: `https://example.test/${errorCode}.m3u8`,
    });
    await retryStore.updateTask(retryTask.id, { status: 'done' });
    await retryStore.close();
    assert.ok(injected.has('open'), `${errorCode} write retry was not exercised`);
    assert.ok(injected.has('rename'), `${errorCode} replace retry was not exercised`);
    assert.ok(injected.has('copy-backup'), `${errorCode} backup retry was not exercised`);

    await fs.promises.writeFile(retryTasksFile, '{broken', 'utf8');
    let recoveryRenameInjected = false;
    const recoveryStore = createTaskStore({
      dataDir: path.dirname(retryTasksFile),
      tasksFile: retryTasksFile,
      outputDir: path.join(retryRoot, 'output'),
      retryDelayMs: 1,
      beforeFsOperation: ({ name }) => {
        if (name !== 'rename' || recoveryRenameInjected) return;
        recoveryRenameInjected = true;
        const error = new Error(`simulated recovery ${errorCode}`);
        error.code = errorCode;
        throw error;
      },
    });
    const recovered = await recoveryStore.loadTasks();
    assert.strictEqual(recovered.recovered, true);
    assert.strictEqual(recoveryRenameInjected, true, `${errorCode} recovery replace retry was not exercised`);
    await recoveryStore.close();
  }

  const httpRoot = path.join(root, 'http');
  const httpConfig = {
    HOST: '127.0.0.1',
    PORT: 0,
    ROOT_DIR: httpRoot,
    STATIC_DIR: path.join(__dirname, '..', 'static'),
    DATA_DIR: path.join(httpRoot, 'data'),
    TASKS_FILE: path.join(httpRoot, 'data', 'tasks.json'),
    OUTPUT_DIR: path.join(httpRoot, 'output'),
    FFMPEG: path.join(httpRoot, 'missing-ffmpeg.exe'),
    USER_AGENT: 'stage1-smoke',
    MAX_ACTIVE_TASKS: 1,
  };
  const app = createApplication(httpConfig, { logger: () => {} });
  const address = await app.start();
  const response = await requestJson(address.port, '/api/detail/parse', { url: 'not-a-url' });
  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.body.ok, false);
  assert.strictEqual(typeof response.body.error, 'string');
  await app.close();

  const closeRoot = path.join(root, 'close');
  const closeGate = deferred();
  let closeTaskStarted = false;
  let closeTaskFinished = false;
  let closeWrites = 0;
  const closeConfig = {
    ...httpConfig,
    PORT: 0,
    ROOT_DIR: closeRoot,
    DATA_DIR: path.join(closeRoot, 'data'),
    TASKS_FILE: path.join(closeRoot, 'data', 'tasks.json'),
    OUTPUT_DIR: path.join(closeRoot, 'output'),
  };
  const closeApp = createApplication(closeConfig, {
    logger: () => {},
    storeOptions: { onWrite: () => { closeWrites += 1; }, retryDelayMs: 1 },
    schedulerOptions: {
      runTask: async (taskToRun, _options, _update, signal) => {
        closeTaskStarted = true;
        signal.addEventListener('abort', () => closeGate.resolve(), { once: true });
        await closeGate.promise;
        await closeApp.store.updateTask(taskToRun.id, { status: 'parsed', progressText: 'stopped' });
        closeTaskFinished = true;
      },
    },
  });
  await closeApp.start();
  const closeTask = await closeApp.store.addParsedTask({
    title: 'close-order',
    pageUrl: 'https://example.test/close',
    m3u8Url: 'https://example.test/close.m3u8',
  });
  await closeApp.store.updateTask(closeTask.id, { status: 'queued' });
  closeApp.scheduler.schedule();
  await waitFor(() => closeTaskStarted, 2000, 'application close task start');
  await Promise.all([closeApp.close(), closeApp.close()]);
  assert.strictEqual(closeTaskFinished, true, 'close must wait for active task completion');
  assert.strictEqual(closeApp.scheduler.getActiveCount(), 0);
  const writesAtClose = closeWrites;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.strictEqual(closeWrites, writesAtClose, 'close return must prevent later task writes');
  await assert.rejects(
    closeApp.store.updateTask(closeTask.id, { progressText: 'late-write' }),
    /Task store is closed/,
  );

  await fs.promises.rm(root, { recursive: true, force: true });
  console.log('stage1-smoke-ok');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
