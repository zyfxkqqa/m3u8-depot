const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTaskStore } = require('../lib/task-store');
const { createScheduler, TRANSIENT_CODES } = require('../lib/scheduler');
const { createOutputManager } = require('../lib/output-manager');
const { classifyFfmpegFailure } = require('../lib/ffmpeg-runner');
const { sanitizeFileName } = require('../lib/text');
const { createApplication } = require('../server');
const { commitCheckedItems } = require('../lib/parse-workflow');

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

async function createStore(root, name) {
  const base = path.join(root, name);
  const store = createTaskStore({
    dataDir: path.join(base, 'data'),
    tasksFile: path.join(base, 'data', 'tasks.json'),
    outputDir: path.join(base, 'output'),
    throttleMs: 5,
    retryDelayMs: 1,
  });
  await store.loadTasks();
  return { store, base, outputDir: path.join(base, 'output') };
}

async function addQueued(store, title, suffix) {
  const task = await store.addParsedTask({
    title,
    pageUrl: `https://example.test/${suffix}`,
    m3u8Url: `https://example.test/${suffix}.m3u8`,
  });
  await store.updateTask(task.id, { status: 'queued', progressText: '排队中' });
  return task;
}

function transient(message = 'temporary ffmpeg failure') {
  const error = new Error(message);
  error.code = 'FFMPEG_TRANSIENT';
  return error;
}

async function run() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm3u8-stage2-'));
  try {
    const reservationDir = path.join(root, 'reservations');
    fs.mkdirSync(reservationDir, { recursive: true });
    fs.writeFileSync(path.join(reservationDir, 'Same.mp4'), 'existing');
    const outputManager = createOutputManager(reservationDir, { retryDelayMs: 1 });
    const reservedOne = outputManager.reserve('Same', 'task-one');
    const reservedTwo = outputManager.reserve('Same', 'task-two');
    assert.strictEqual(path.basename(reservedOne.finalPath), 'Same (2).mp4');
    assert.strictEqual(path.basename(reservedTwo.finalPath), 'Same (3).mp4');
    assert.match(path.basename(reservedOne.partPath), /taskone.part.mp4$/);
    outputManager.release(reservedOne.finalPath);
    outputManager.release(reservedTwo.finalPath);
    for (const reservedName of ['CON', 'prn.txt', 'AUX.', 'NUL ', 'CLOCK$', 'COM1.mp4', 'LPT9.log']) {
      assert.ok(sanitizeFileName(reservedName).startsWith('_'), `${reservedName} was not made Windows-safe`);
    }
    assert.strictEqual(/[ .]$/.test(sanitizeFileName('video...   ')), false);
    assert.strictEqual(/[\x00-\x1f]/.test(sanitizeFileName('bad\x00name\x1f')), false);
    assert.ok(sanitizeFileName('x'.repeat(300)).length <= 120);
    assert.strictEqual(classifyFfmpegFailure('Connection reset by peer', 1).code, 'FFMPEG_TRANSIENT');
    assert.strictEqual(classifyFfmpegFailure('Connection timed out', 1).code, 'FFMPEG_TRANSIENT');
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      assert.strictEqual(classifyFfmpegFailure(`Server returned ${status} remote response`, 1).code, 'FFMPEG_TRANSIENT');
    }
    assert.strictEqual(classifyFfmpegFailure('Temporary failure in name resolution', 1).code, 'FFMPEG_TRANSIENT');
    assert.strictEqual(classifyFfmpegFailure('TLS remote peer connection reset', 1).code, 'FFMPEG_TRANSIENT');
    assert.strictEqual(classifyFfmpegFailure('TLS handshake timed out', 1).code, 'FFMPEG_TRANSIENT');
    for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN']) {
      assert.strictEqual(TRANSIENT_CODES.has(code), true, `${code} must remain retryable`);
    }
    assert.strictEqual(TRANSIENT_CODES.has('FFMPEG_STALLED'), true, 'FFMPEG_STALLED must be retryable');
    assert.strictEqual(classifyFfmpegFailure('Invalid data found when processing input', 1).code, 'FFMPEG_PERMANENT');
    const auditCounterexamples = [
      'Server returned 5000 custom local error',
      'HTTP error 5000',
      'HTTP status 5040',
      'TLS local connection closed after permission error',
      'Could not resolve host: typo.invalid',
      'Name or service not known',
    ];
    for (const localFailure of ['End of file', 'Input/output error', 'Resource temporarily unavailable', 'Temporary failure', 'HTTP error 501', ...auditCounterexamples]) {
      assert.notStrictEqual(classifyFfmpegFailure(localFailure, 1).code, 'FFMPEG_TRANSIENT', localFailure);
    }
    assert.strictEqual(classifyFfmpegFailure('unknown failure', 1).code, 'FFMPEG_FAILED');

    const boundaryCase = await createStore(root, 'task-boundary');
    const outsideFile = path.join(root, 'must-survive.txt');
    fs.writeFileSync(outsideFile, 'safe');
    const forged = await boundaryCase.store.addParsedTask({
      id: 'forged-id', status: 'done', output: outsideFile, partPath: outsideFile,
      process: { forged: true }, cancelRequested: true, retryCount: 99,
      createdAt: 'forged', batchId: 'forged-batch',
      title: 'Boundary', pageUrl: 'https://example.test/boundary', m3u8Url: 'https://example.test/boundary.m3u8',
    });
    assert.notStrictEqual(forged.id, 'forged-id');
    assert.strictEqual(forged.status, 'parsed');
    assert.strictEqual(forged.output, '');
    assert.strictEqual(forged.partPath, '');
    assert.strictEqual(forged.retryCount, 0);
    assert.strictEqual(forged.batchId, null);
    const boundaryScheduler = createScheduler(boundaryCase.store, {
      outputDir: boundaryCase.outputDir,
      maxActiveTasks: 1,
      runTask: async () => {},
      manageOutput: true,
    });
    forged.partPath = outsideFile;
    await assert.rejects(boundaryScheduler.deleteTasks([forged.id]), error => error.code === 'OUTPUT_PATH_INVALID');
    assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), 'safe');
    assert.strictEqual(boundaryCase.store.tasks.has(forged.id), true);
    forged.partPath = '';
    await boundaryScheduler.deleteTasks([forged.id]);
    await boundaryScheduler.drain();
    await boundaryCase.store.close();

    const concurrentCommitCase = await createStore(root, 'concurrent-commit');
    const identical = { title: 'Same Commit', pageUrl: 'https://example.test/same', m3u8Url: 'https://example.test/same.m3u8', duplicate: false };
    const [commitOne, commitTwo] = await Promise.all([
      commitCheckedItems([identical], concurrentCommitCase.store, { mode: 'direct' }),
      commitCheckedItems([identical], concurrentCommitCase.store, { mode: 'direct' }),
    ]);
    assert.strictEqual([...concurrentCommitCase.store.tasks.values()].filter(task => task.status === 'queued').length, 1);
    assert.strictEqual([...concurrentCommitCase.store.tasks.values()].filter(task => task.status === 'parsed' && task.duplicate).length, 1);
    assert.strictEqual(commitOne.startIds.length + commitTwo.startIds.length, 1);
    await concurrentCommitCase.store.close();

    const successCase = await createStore(root, 'success');
    const successTask = await addQueued(successCase.store, 'Part Success', 'success');
    const successScheduler = createScheduler(successCase.store, {
      outputDir: successCase.outputDir,
      maxActiveTasks: 1,
      maxRetries: 0,
      manageOutput: true,
      runTask: async (_task, options) => {
        assert.match(options.partPath, /.part.mp4$/);
        fs.writeFileSync(options.partPath, 'complete-mp4');
      },
    });
    successScheduler.schedule();
    await waitFor(() => successTask.status === 'done', 2000, 'part commit');
    assert.ok(fs.existsSync(successTask.output));
    assert.strictEqual(fs.existsSync(successTask.partPath), false);
    assert.strictEqual(fs.readFileSync(successTask.output, 'utf8'), 'complete-mp4');
    await successScheduler.drain();
    await successCase.store.close();

    const concurrentCase = await createStore(root, 'concurrent');
    const sameOne = await addQueued(concurrentCase.store, 'Concurrent', 'one');
    const sameTwo = await addQueued(concurrentCase.store, 'Concurrent', 'two');
    const concurrentScheduler = createScheduler(concurrentCase.store, {
      outputDir: concurrentCase.outputDir,
      maxActiveTasks: 2,
      maxRetries: 0,
      manageOutput: true,
      runTask: async (_task, options) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        fs.writeFileSync(options.partPath, 'video');
      },
    });
    concurrentScheduler.schedule();
    await waitFor(() => sameOne.status === 'done' && sameTwo.status === 'done', 2000, 'same-title downloads');
    assert.notStrictEqual(sameOne.output.toLowerCase(), sameTwo.output.toLowerCase());
    assert.deepStrictEqual(
      [path.basename(sameOne.output), path.basename(sameTwo.output)].sort(),
      ['Concurrent (2).mp4', 'Concurrent.mp4'].sort(),
    );
    assert.strictEqual(concurrentScheduler.getReservedCount(), 0);
    await concurrentScheduler.drain();
    await concurrentCase.store.close();

    const failureCase = await createStore(root, 'failure');
    const failureTask = await addQueued(failureCase.store, 'Failure Cleanup', 'failure');
    let failurePart = '';
    const failureScheduler = createScheduler(failureCase.store, {
      outputDir: failureCase.outputDir,
      maxActiveTasks: 1,
      maxRetries: 0,
      manageOutput: true,
      runTask: async (_task, options) => {
        failurePart = options.partPath;
        fs.writeFileSync(failurePart, 'partial');
        throw transient();
      },
    });
    failureScheduler.schedule();
    await waitFor(() => failureTask.status === 'failed', 2000, 'failure cleanup');
    assert.strictEqual(fs.existsSync(failurePart), false);
    assert.strictEqual(fs.existsSync(failureTask.output), false);
    await failureScheduler.drain();
    await failureCase.store.close();

    const cancelCase = await createStore(root, 'cancel');
    const cancelTask = await addQueued(cancelCase.store, 'Cancel Cleanup', 'cancel');
    const cancelStarted = deferred();
    let cancelPart = '';
    const cancelScheduler = createScheduler(cancelCase.store, {
      outputDir: cancelCase.outputDir,
      maxActiveTasks: 1,
      maxRetries: 2,
      retryDelays: [5, 5],
      manageOutput: true,
      runTask: async (_task, options, _update, signal) => {
        cancelPart = options.partPath;
        fs.writeFileSync(cancelPart, 'partial');
        cancelStarted.resolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      parsePlayPage: async () => { throw new Error('cancel must not refresh'); },
    });
    cancelScheduler.schedule();
    await cancelStarted.promise;
    assert.strictEqual(await cancelScheduler.cancelTask(cancelTask.id), true);
    assert.strictEqual(cancelTask.status, 'parsed');
    assert.strictEqual(cancelTask.retryCount, 0);
    assert.strictEqual(fs.existsSync(cancelPart), false);
    await cancelScheduler.drain();
    await cancelCase.store.close();

    const deleteCase = await createStore(root, 'delete');
    const deleteTask = await addQueued(deleteCase.store, 'Delete Running', 'delete');
    const deleteStarted = deferred();
    const deleteExit = deferred();
    let deletePart = '';
    const deleteScheduler = createScheduler(deleteCase.store, {
      outputDir: deleteCase.outputDir,
      maxActiveTasks: 1,
      maxRetries: 0,
      manageOutput: true,
      runTask: async (_task, options, _update, signal) => {
        deletePart = options.partPath;
        fs.writeFileSync(deletePart, 'partial');
        deleteStarted.resolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            setTimeout(() => {
              deleteExit.resolve();
              reject(signal.reason);
            }, 20);
          }, { once: true });
        });
      },
    });
    deleteScheduler.schedule();
    await deleteStarted.promise;
    const deletePromise = deleteScheduler.deleteTasks([deleteTask.id]);
    assert.strictEqual(deleteCase.store.tasks.has(deleteTask.id), true, 'record deleted before child exit');
    await deleteExit.promise;
    await deletePromise;
    assert.strictEqual(deleteCase.store.tasks.has(deleteTask.id), false);
    assert.strictEqual(fs.existsSync(deletePart), false);
    await deleteScheduler.drain();
    await deleteCase.store.close();

    const retryCase = await createStore(root, 'retry');
    const retryTask = await addQueued(retryCase.store, 'Retry', 'retry');
    let attempts = 0;
    let refreshes = 0;
    const retryScheduler = createScheduler(retryCase.store, {
      outputDir: retryCase.outputDir,
      maxActiveTasks: 1,
      maxRetries: 2,
      retryDelays: [10, 15],
      manageOutput: true,
      runTask: async (task, options) => {
        attempts += 1;
        if (attempts < 3) throw transient(`attempt-${attempts}`);
        assert.match(task.m3u8Url, /refreshed-2/);
        fs.writeFileSync(options.partPath, 'retried-video');
      },
      parsePlayPage: async pageUrl => {
        refreshes += 1;
        return { pageUrl, m3u8Url: `https://example.test/refreshed-${refreshes}.m3u8`, m3u8Source: 'test' };
      },
    });
    retryScheduler.schedule();
    await waitFor(() => retryTask.status === 'done', 2000, 'finite retry');
    assert.strictEqual(attempts, 3);
    assert.strictEqual(refreshes, 2);
    assert.strictEqual(retryTask.retryCount, 2);
    assert.strictEqual(retryTask.nextRetryAt, null);
    await retryScheduler.drain();
    await retryCase.store.close();

    const stalledFollowerCase = await createStore(root, 'stalled-follower');
    const stalledTask = await addQueued(stalledFollowerCase.store, 'Stalled', 'stalled');
    const followerTask = await addQueued(stalledFollowerCase.store, 'Follower', 'follower');
    let stalledAttempts = 0;
    let stalledRefreshes = 0;
    const stalledFollowerScheduler = createScheduler(stalledFollowerCase.store, {
      outputDir: stalledFollowerCase.outputDir,
      maxActiveTasks: 1,
      maxRetries: 1,
      retryDelays: [1],
      manageOutput: true,
      runTask: async (task, options) => {
        if (task.id !== stalledTask.id) {
          fs.writeFileSync(options.partPath, 'follower-video');
          return;
        }
        stalledAttempts += 1;
        const error = new Error(`stalled-attempt-${stalledAttempts}`);
        error.code = 'FFMPEG_STALLED';
        throw error;
      },
      parsePlayPage: async pageUrl => {
        stalledRefreshes += 1;
        return { pageUrl, m3u8Url: `https://example.test/refreshed-stalled-${stalledRefreshes}.m3u8`, m3u8Source: 'test' };
      },
    });
    stalledFollowerScheduler.schedule();
    await waitFor(() => (
      stalledTask.status === 'failed'
      && followerTask.status === 'done'
      && stalledFollowerScheduler.getActiveCount() === 0
      && stalledFollowerScheduler.getReservedCount() === 0
    ), 2000, 'stalled follower recovery');
    assert.strictEqual(stalledAttempts, 2);
    assert.strictEqual(stalledRefreshes, 1);
    assert.strictEqual(stalledTask.status, 'failed');
    assert.strictEqual(followerTask.status, 'done');
    assert.ok(fs.existsSync(followerTask.output));
    assert.strictEqual(stalledFollowerScheduler.getActiveCount(), 0);
    assert.strictEqual(stalledFollowerScheduler.getReservedCount(), 0);
    await stalledFollowerScheduler.drain();
    await stalledFollowerCase.store.close();

    const refreshFailureCase = await createStore(root, 'refresh-failure-follower');
    const refreshFailureTask = await addQueued(refreshFailureCase.store, 'Refresh Failure', 'refresh-failure');
    const refreshFollowerTask = await addQueued(refreshFailureCase.store, 'Refresh Follower', 'refresh-follower');
    let refreshFailureAttempts = 0;
    let refreshFailureRefreshes = 0;
    const refreshFailureScheduler = createScheduler(refreshFailureCase.store, {
      outputDir: refreshFailureCase.outputDir,
      maxActiveTasks: 1,
      maxRetries: 1,
      retryDelays: [1],
      manageOutput: true,
      runTask: async (task, options) => {
        if (task.id !== refreshFailureTask.id) {
          fs.writeFileSync(options.partPath, 'follower-video');
          return;
        }
        refreshFailureAttempts += 1;
        const error = new Error('stalled');
        error.code = 'FFMPEG_STALLED';
        throw error;
      },
      parsePlayPage: async () => { refreshFailureRefreshes += 1; throw new Error('refresh failed'); },
    });
    refreshFailureScheduler.schedule();
    await waitFor(() => (
      refreshFailureTask.status === 'failed'
      && refreshFollowerTask.status === 'done'
      && refreshFailureScheduler.getActiveCount() === 0
      && refreshFailureScheduler.getReservedCount() === 0
    ), 2000, 'refresh failure follower recovery');
    assert.strictEqual(refreshFailureAttempts, 1);
    assert.strictEqual(refreshFailureRefreshes, 1);
    assert.strictEqual(refreshFailureTask.status, 'failed');
    assert.strictEqual(refreshFollowerTask.status, 'done');
    assert.ok(fs.existsSync(refreshFollowerTask.output));
    assert.strictEqual(refreshFailureScheduler.getActiveCount(), 0);
    assert.strictEqual(refreshFailureScheduler.getReservedCount(), 0);
    await refreshFailureScheduler.drain();
    await refreshFailureCase.store.close();

    const permanentCase = await createStore(root, 'permanent');
    const permanentTask = await addQueued(permanentCase.store, 'Permanent', 'permanent');
    let permanentAttempts = 0;
    let permanentRefreshes = 0;
    const permanentScheduler = createScheduler(permanentCase.store, {
      outputDir: permanentCase.outputDir,
      maxActiveTasks: 1,
      maxRetries: 2,
      retryDelays: [5, 5],
      manageOutput: true,
      runTask: async () => {
        permanentAttempts += 1;
        const error = new Error('Invalid data found when processing input');
        error.code = 'FFMPEG_PERMANENT';
        throw error;
      },
      parsePlayPage: async () => { permanentRefreshes += 1; },
    });
    permanentScheduler.schedule();
    await waitFor(() => permanentTask.status === 'failed', 2000, 'permanent ffmpeg failure');
    assert.strictEqual(permanentAttempts, 1);
    assert.strictEqual(permanentRefreshes, 0);
    await permanentScheduler.drain();
    await permanentCase.store.close();

    const mixedDeleteCase = await createStore(root, 'mixed-delete');
    const runningDelete = await addQueued(mixedDeleteCase.store, 'Mixed Running', 'mixed-running');
    const queuedDelete = await addQueued(mixedDeleteCase.store, 'Mixed Queued', 'mixed-queued');
    const retryingDelete = await addQueued(mixedDeleteCase.store, 'Mixed Retrying', 'mixed-retrying');
    await mixedDeleteCase.store.updateTask(retryingDelete.id, { status: 'retrying', nextRetryAt: new Date().toISOString() });
    const mixedStarted = deferred();
    const mixedRelease = deferred();
    const mixedStarts = [];
    const mixedScheduler = createScheduler(mixedDeleteCase.store, {
      outputDir: mixedDeleteCase.outputDir,
      maxActiveTasks: 1,
      maxRetries: 0,
      manageOutput: true,
      runTask: async (task, _options, _update, signal) => {
        mixedStarts.push(task.id);
        mixedStarted.resolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => mixedRelease.promise.then(() => reject(signal.reason)), { once: true });
        });
      },
    });
    mixedScheduler.schedule();
    await mixedStarted.promise;
    const mixedDeletePromise = mixedScheduler.deleteTasks([runningDelete.id, queuedDelete.id, retryingDelete.id]);
    await waitFor(() => mixedScheduler.isDeleting(queuedDelete.id), 2000, 'mixed delete persistence');
    mixedScheduler.schedule();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepStrictEqual(mixedStarts, [runningDelete.id]);
    mixedRelease.resolve();
    await mixedDeletePromise;
    assert.strictEqual(mixedDeleteCase.store.tasks.has(runningDelete.id), false);
    assert.strictEqual(mixedDeleteCase.store.tasks.has(queuedDelete.id), false);
    assert.strictEqual(mixedDeleteCase.store.tasks.has(retryingDelete.id), false);
    assert.strictEqual(mixedScheduler.isDeleting(queuedDelete.id), false);
    await mixedScheduler.drain();
    await mixedDeleteCase.store.close();

    const serializedCaseRoot = path.join(root, 'serialized-mixed-delete');
    const serializedData = path.join(serializedCaseRoot, 'data');
    const serializedOutput = path.join(serializedCaseRoot, 'output');
    const serializedTasksFile = path.join(serializedData, 'tasks.json');
    let trackSnapshot = false;
    let snapshotOpen = false;
    let overlappingSnapshots = 0;
    const firstOpen = deferred();
    const releaseFirstOpen = deferred();
    const serializedStore = createTaskStore({
      dataDir: serializedData,
      tasksFile: serializedTasksFile,
      outputDir: serializedOutput,
      throttleMs: 5,
      retryDelayMs: 1,
      beforeFsOperation: async ({ name, target }) => {
        if (!trackSnapshot) return;
        if (name === 'open' && target === `${serializedTasksFile}.tmp`) {
          if (snapshotOpen) overlappingSnapshots += 1;
          snapshotOpen = true;
          firstOpen.resolve();
          await releaseFirstOpen.promise;
        }
        if (name === 'rename' && target === serializedTasksFile) snapshotOpen = false;
      },
    });
    await serializedStore.loadTasks();
    const serializedUpdate = await addQueued(serializedStore, 'Serialized Update', 'serialized-update');
    const serializedMark = await addQueued(serializedStore, 'Serialized Mark', 'serialized-mark');
    const serializedDelete = await addQueued(serializedStore, 'Serialized Delete', 'serialized-delete');
    trackSnapshot = true;
    const updatePromise = serializedStore.updateTask(serializedUpdate.id, { status: 'parsed', progressText: 'updated' });
    await firstOpen.promise;
    const markPromise = serializedStore.markTasksDeleting([serializedMark.id]);
    const finalDeletePromise = serializedStore.deleteTasks([serializedDelete.id]);
    releaseFirstOpen.resolve();
    await Promise.all([updatePromise, markPromise, finalDeletePromise]);
    assert.strictEqual(overlappingSnapshots, 0, 'task snapshots wrote or moved the shared temp file concurrently');
    assert.strictEqual(serializedStore.tasks.get(serializedUpdate.id).status, 'parsed');
    assert.strictEqual(serializedStore.tasks.get(serializedMark.id).status, 'deleting');
    assert.strictEqual(serializedStore.tasks.has(serializedDelete.id), false);
    const serializedDisk = JSON.parse(fs.readFileSync(serializedTasksFile, 'utf8'));
    assert.deepStrictEqual(
      serializedDisk.map(task => [task.id, task.status]).sort(),
      [[serializedUpdate.id, 'parsed'], [serializedMark.id, 'deleting']].sort(),
    );
    await serializedStore.close();

    const deleteFailureRoot = path.join(root, 'delete-failure');
    const deleteFailureData = path.join(deleteFailureRoot, 'data');
    const deleteFailureOutput = path.join(deleteFailureRoot, 'output');
    const deleteFailureFile = path.join(deleteFailureData, 'tasks.json');
    let failDeleteWrite = false;
    let deleteFailureStarts = 0;
    const deleteFailureStore = createTaskStore({
      dataDir: deleteFailureData,
      tasksFile: deleteFailureFile,
      outputDir: deleteFailureOutput,
      retryDelayMs: 1,
      beforeFsOperation: ({ name }) => {
        if (!failDeleteWrite || name !== 'open') return;
        const error = new Error('simulated disk full');
        error.code = 'ENOSPC';
        throw error;
      },
    });
    await deleteFailureStore.loadTasks();
    const deleteFailureOne = await addQueued(deleteFailureStore, 'Delete Failure One', 'delete-failure-one');
    const deleteFailureTwo = await addQueued(deleteFailureStore, 'Delete Failure Two', 'delete-failure-two');
    const deleteFailureThree = await addQueued(deleteFailureStore, 'Delete Failure Three', 'delete-failure-three');
    const deleteFailureScheduler = createScheduler(deleteFailureStore, {
      outputDir: deleteFailureOutput,
      maxActiveTasks: 1,
      runTask: async () => { deleteFailureStarts += 1; },
    });
    failDeleteWrite = true;
    await assert.rejects(
      deleteFailureScheduler.deleteTasks([deleteFailureOne.id, deleteFailureTwo.id, deleteFailureThree.id]),
      error => error.code === 'ENOSPC',
    );
    assert.strictEqual(deleteFailureStore.tasks.has(deleteFailureOne.id), true);
    assert.strictEqual(deleteFailureStore.tasks.has(deleteFailureTwo.id), true);
    assert.strictEqual(deleteFailureStore.tasks.has(deleteFailureThree.id), true);
    assert.strictEqual(deleteFailureScheduler.isDeleting(deleteFailureOne.id), false);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.strictEqual(deleteFailureStarts, 0, 'failed delete triggered automatic scheduling');

    const reloadedDeleteStore = createTaskStore({
      dataDir: deleteFailureData,
      tasksFile: deleteFailureFile,
      outputDir: deleteFailureOutput,
      retryDelayMs: 1,
    });
    await reloadedDeleteStore.loadTasks();
    assert.deepStrictEqual(
      [...reloadedDeleteStore.tasks.keys()].sort(),
      [deleteFailureOne.id, deleteFailureTwo.id, deleteFailureThree.id].sort(),
    );
    await reloadedDeleteStore.close();
    failDeleteWrite = false;
    await deleteFailureStore.flush();
    await deleteFailureScheduler.drain();
    await deleteFailureStore.close();

    const localRetryCase = await createStore(root, 'local-no-retry');
    const noRetryMessages = [
      'Server returned 5000 custom local error',
      'HTTP error 5000',
      'HTTP status 5040',
      'TLS local connection closed after permission error',
      'Could not resolve host: typo.invalid',
      'Name or service not known',
    ];
    const localRetryTasks = [];
    const localRetryMessages = new Map();
    for (let index = 0; index < noRetryMessages.length; index += 1) {
      const task = await addQueued(localRetryCase.store, `Local No Retry ${index}`, `local-no-retry-${index}`);
      localRetryTasks.push(task);
      localRetryMessages.set(task.id, noRetryMessages[index]);
    }
    const localRetryAttempts = new Map();
    let localRetryRefreshes = 0;
    const localRetryScheduler = createScheduler(localRetryCase.store, {
      outputDir: localRetryCase.outputDir,
      maxActiveTasks: 2,
      maxRetries: 2,
      retryDelays: [5, 5],
      manageOutput: true,
      runTask: async task => {
        localRetryAttempts.set(task.id, (localRetryAttempts.get(task.id) || 0) + 1);
        const error = new Error(localRetryMessages.get(task.id));
        error.code = classifyFfmpegFailure(error.message, 1).code;
        throw error;
      },
      parsePlayPage: async () => { localRetryRefreshes += 1; },
    });
    localRetryScheduler.schedule();
    await waitFor(() => localRetryTasks.every(task => task.status === 'failed'), 2000, 'audit errors no retry');
    for (const task of localRetryTasks) assert.strictEqual(localRetryAttempts.get(task.id), 1);
    assert.strictEqual(localRetryRefreshes, 0);
    await localRetryScheduler.drain();
    await localRetryCase.store.close();

    const commitRecoveryRoot = path.join(root, 'commit-recovery');
    const commitRecoveryData = path.join(commitRecoveryRoot, 'data');
    const commitRecoveryOutput = path.join(commitRecoveryRoot, 'output');
    fs.mkdirSync(commitRecoveryData, { recursive: true });
    fs.mkdirSync(commitRecoveryOutput, { recursive: true });
    const commitTasksFile = path.join(commitRecoveryData, 'tasks.json');
    const finalOnly = path.join(commitRecoveryOutput, 'final-only.mp4');
    const partOnly = path.join(commitRecoveryOutput, 'part-only.part.mp4');
    const bothFinal = path.join(commitRecoveryOutput, 'both.mp4');
    const bothPart = path.join(commitRecoveryOutput, 'both.part.mp4');
    fs.writeFileSync(finalOnly, 'final');
    fs.writeFileSync(partOnly, 'part');
    fs.writeFileSync(bothFinal, 'final');
    fs.writeFileSync(bothPart, 'part');
    fs.writeFileSync(commitTasksFile, JSON.stringify([
      { id: 'final-only', title: 'Final', status: 'committing', output: finalOnly, partPath: path.join(commitRecoveryOutput, 'missing.part.mp4') },
      { id: 'part-only', title: 'Part', status: 'committing', output: path.join(commitRecoveryOutput, 'missing.mp4'), partPath: partOnly },
      { id: 'both', title: 'Both', status: 'committing', output: bothFinal, partPath: bothPart },
      { id: 'neither', title: 'Neither', status: 'committing', output: path.join(commitRecoveryOutput, 'none.mp4'), partPath: path.join(commitRecoveryOutput, 'none.part.mp4') },
    ]), 'utf8');
    const commitRecoveryStore = createTaskStore({
      dataDir: commitRecoveryData,
      tasksFile: commitTasksFile,
      outputDir: commitRecoveryOutput,
      retryDelayMs: 1,
    });
    await commitRecoveryStore.loadTasks();
    assert.strictEqual(commitRecoveryStore.tasks.get('final-only').status, 'done');
    assert.strictEqual(commitRecoveryStore.tasks.get('part-only').status, 'queued');
    assert.strictEqual(commitRecoveryStore.tasks.get('part-only').recoveryPartPath, partOnly);
    assert.strictEqual(commitRecoveryStore.tasks.get('both').status, 'failed');
    assert.strictEqual(commitRecoveryStore.tasks.get('neither').status, 'failed');
    await commitRecoveryStore.close();
    const secondCommitRecoveryStore = createTaskStore({
      dataDir: commitRecoveryData,
      tasksFile: commitTasksFile,
      outputDir: commitRecoveryOutput,
      retryDelayMs: 1,
    });
    await secondCommitRecoveryStore.loadTasks();
    const recoveredPartOnly = secondCommitRecoveryStore.tasks.get('part-only');
    assert.strictEqual(recoveredPartOnly.status, 'queued');
    assert.strictEqual(recoveredPartOnly.recoveryPartPath, partOnly);
    const commitRecoveryScheduler = createScheduler(secondCommitRecoveryStore, {
      outputDir: commitRecoveryOutput,
      maxActiveTasks: 1,
      maxRetries: 0,
      manageOutput: true,
      runTask: async (_task, options) => fs.writeFileSync(options.partPath, 'recovered-part-only'),
    });
    commitRecoveryScheduler.schedule();
    await waitFor(() => recoveredPartOnly.status === 'done', 2000, 'committing part-only recovery');
    assert.strictEqual(fs.existsSync(partOnly), false, 'committing recovery leaked old part file');
    assert.ok(fs.existsSync(recoveredPartOnly.output));
    await commitRecoveryScheduler.drain();
    await secondCommitRecoveryStore.close();

    const commitFailureCase = await createStore(root, 'commit-failure');
    const commitFailureTask = await addQueued(commitFailureCase.store, 'Commit Failure', 'commit-failure');
    const originalCommitUpdate = commitFailureCase.store.updateTask;
    let doneFailed = false;
    commitFailureCase.store.updateTask = async (id, patch, options) => {
      if (patch.status === 'done' && !doneFailed) {
        doneFailed = true;
        throw new Error('simulated done persistence failure');
      }
      return originalCommitUpdate(id, patch, options);
    };
    const commitFailureScheduler = createScheduler(commitFailureCase.store, {
      outputDir: commitFailureCase.outputDir,
      maxActiveTasks: 1,
      maxRetries: 0,
      manageOutput: true,
      runTask: async (_task, options) => fs.writeFileSync(options.partPath, 'committed'),
    });
    commitFailureScheduler.schedule();
    await waitFor(() => doneFailed && fs.existsSync(commitFailureTask.output), 2000, 'rename before done failure');
    await waitFor(() => commitFailureScheduler.getActiveCount() === 0, 2000, 'commit failure settle');
    assert.strictEqual(commitFailureTask.status, 'committing');
    assert.strictEqual(path.basename(commitFailureTask.output), 'Commit Failure.mp4');
    assert.strictEqual(commitFailureScheduler.getReservedCount(), 1);
    await commitFailureCase.store.flush();
    await commitFailureCase.store.close();
    const commitRestartStore = createTaskStore({
      dataDir: path.join(commitFailureCase.base, 'data'),
      tasksFile: path.join(commitFailureCase.base, 'data', 'tasks.json'),
      outputDir: commitFailureCase.outputDir,
      retryDelayMs: 1,
    });
    await commitRestartStore.loadTasks();
    assert.strictEqual(commitRestartStore.tasks.get(commitFailureTask.id).status, 'done');
    assert.strictEqual(path.basename(commitRestartStore.tasks.get(commitFailureTask.id).output), 'Commit Failure.mp4');
    await commitRestartStore.close();

    const closeRetryCase = await createStore(root, 'close-retry');
    const closeRetryTask = await addQueued(closeRetryCase.store, 'Close Retry', 'close-retry');
    const retryWaiting = deferred();
    const originalUpdate = closeRetryCase.store.updateTask;
    closeRetryCase.store.updateTask = async (id, patch, options) => {
      const result = await originalUpdate(id, patch, options);
      if (patch.status === 'retrying') retryWaiting.resolve();
      return result;
    };
    const closeRetryScheduler = createScheduler(closeRetryCase.store, {
      outputDir: closeRetryCase.outputDir,
      maxActiveTasks: 1,
      maxRetries: 2,
      retryDelays: [1000, 1000],
      manageOutput: true,
      runTask: async () => { throw transient(); },
      parsePlayPage: async () => ({ m3u8Url: 'unused' }),
    });
    closeRetryScheduler.schedule();
    await retryWaiting.promise;
    const closeStartedAt = Date.now();
    await Promise.race([
      closeRetryScheduler.stop(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('close retry wait exceeded 250ms')), 250)),
    ]);
    assert.ok(Date.now() - closeStartedAt < 250);
    assert.strictEqual(closeRetryTask.status, 'parsed');
    await closeRetryCase.store.close();

    const recoveryRoot = path.join(root, 'recovery-app');
    const recoveryTasksFile = path.join(recoveryRoot, 'data', 'tasks.json');
    fs.mkdirSync(path.dirname(recoveryTasksFile), { recursive: true });
    const recoveryOutput = path.join(recoveryRoot, 'output');
    fs.mkdirSync(recoveryOutput, { recursive: true });
    const stalePart = path.join(recoveryOutput, 'legacy-running.part.mp4');
    fs.writeFileSync(stalePart, 'stale');
    fs.writeFileSync(recoveryTasksFile, JSON.stringify([{
      id: 'recovered-task',
      title: 'Recovered',
      pageUrl: 'https://example.test/recovered',
      m3u8Url: 'https://example.test/recovered.m3u8',
      status: 'running',
      progressText: 'old running',
      retryCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      partPath: stalePart,
    }]), 'utf8');
    const firstRecoveryStore = createTaskStore({
      dataDir: path.dirname(recoveryTasksFile), tasksFile: recoveryTasksFile, outputDir: recoveryOutput, retryDelayMs: 1,
    });
    await firstRecoveryStore.loadTasks();
    assert.strictEqual(firstRecoveryStore.tasks.get('recovered-task').recoveryPartPath, stalePart);
    await firstRecoveryStore.close();
    const persistedAfterFirstRestart = JSON.parse(fs.readFileSync(recoveryTasksFile, 'utf8'))[0];
    assert.strictEqual(persistedAfterFirstRestart.status, 'queued');
    assert.strictEqual(persistedAfterFirstRestart.recoveryPartPath, stalePart);
    let recoveryStarted = 0;
    let listenedBeforeRun = false;
    const recoveryConfig = {
      HOST: '127.0.0.1',
      PORT: 0,
      ROOT_DIR: recoveryRoot,
      STATIC_DIR: path.join(__dirname, '..', 'static'),
      DATA_DIR: path.join(recoveryRoot, 'data'),
      TASKS_FILE: recoveryTasksFile,
      OUTPUT_DIR: path.join(recoveryRoot, 'output'),
      FFMPEG: 'unused',
      USER_AGENT: 'stage2-smoke',
      MAX_ACTIVE_TASKS: 1,
    };
    let recoveryApp;
    recoveryApp = createApplication(recoveryConfig, {
      logger: () => {},
      storeOptions: { retryDelayMs: 1 },
      schedulerOptions: {
        manageOutput: true,
        maxRetries: 0,
        runTask: async (_task, options) => {
          recoveryStarted += 1;
          listenedBeforeRun = recoveryApp.server.listening;
          fs.writeFileSync(options.partPath, 'recovered-video');
        },
      },
    });
    await recoveryApp.start();
    await waitFor(() => recoveryApp.store.tasks.get('recovered-task')?.status === 'done', 2000, 'restart auto schedule');
    assert.strictEqual(recoveryStarted, 1);
    assert.strictEqual(fs.existsSync(stalePart), false, 'stale recovery part was leaked');
    assert.strictEqual(listenedBeforeRun, true, 'recovery started before listen success');
    await recoveryApp.close();

    const legacyRoot = path.join(root, 'legacy-part-delete');
    const legacyOutput = path.join(legacyRoot, 'output');
    const legacyData = path.join(legacyRoot, 'data');
    fs.mkdirSync(legacyOutput, { recursive: true });
    fs.mkdirSync(legacyData, { recursive: true });
    const legacyPart = path.join(legacyOutput, 'part-only.part.mp4');
    fs.writeFileSync(legacyPart, 'legacy');
    const legacyFile = path.join(legacyData, 'tasks.json');
    fs.writeFileSync(legacyFile, JSON.stringify([{
      id: 'legacy-task', title: 'Legacy', pageUrl: 'https://example.test/legacy', m3u8Url: 'https://example.test/legacy.m3u8',
      status: 'running', partPath: legacyPart, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }]), 'utf8');
    const legacyStore = createTaskStore({ dataDir: legacyData, tasksFile: legacyFile, outputDir: legacyOutput, retryDelayMs: 1 });
    await legacyStore.loadTasks();
    const legacyScheduler = createScheduler(legacyStore, {
      outputDir: legacyOutput, maxActiveTasks: 1, manageOutput: true, maxRetries: 0,
      runTask: async (_task, options) => fs.writeFileSync(options.partPath, 'new'),
    });
    legacyScheduler.schedule();
    await waitFor(() => legacyStore.tasks.get('legacy-task')?.status === 'done', 2000, 'legacy part cleanup');
    assert.strictEqual(fs.existsSync(legacyPart), false);
    await legacyScheduler.drain();
    await legacyStore.close();

    console.log('stage2-smoke-ok');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
