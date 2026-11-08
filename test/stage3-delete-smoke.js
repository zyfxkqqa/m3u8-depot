const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTaskStore } = require('../lib/task-store');
const { createScheduler } = require('../lib/scheduler');

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function waitFor(predicate, label, timeoutMs = 1500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error(`${label} timed out`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function openStore(root, name, hooks = {}) {
  const base = path.join(root, name);
  const dataDir = path.join(base, 'data');
  const outputDir = path.join(base, 'output');
  const tasksFile = path.join(dataDir, 'tasks.json');
  const store = createTaskStore({
    dataDir,
    outputDir,
    tasksFile,
    throttleMs: 5,
    retryDelayMs: 1,
    ...hooks,
  });
  await store.loadTasks();
  return { store, outputDir, tasksFile };
}

async function addQueued(store, suffix) {
  const task = await store.addParsedTask({
    title: `Delete ${suffix}`,
    pageUrl: `https://example.test/${suffix}`,
    m3u8Url: `https://example.test/${suffix}.m3u8`,
  });
  await store.updateTask(task.id, { status: 'queued', progressText: 'queued' });
  return task;
}

async function run() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm3u8-stage3-delete-'));
  try {
    const markCase = await openStore(root, 'mark-failure');
    const markTask = await addQueued(markCase.store, 'mark-failure');
    const started = deferred();
    let cancelled = false;
    const markScheduler = createScheduler(markCase.store, {
      outputDir: markCase.outputDir,
      maxActiveTasks: 1,
      manageOutput: true,
      runTask: async (_task, options, _update, signal) => {
        fs.writeFileSync(options.partPath, 'partial');
        started.resolve();
        await new Promise(resolve => signal.addEventListener('abort', () => {
          cancelled = true;
          resolve();
        }, { once: true }));
      },
    });
    markScheduler.schedule();
    await started.promise;
    const originalMark = markCase.store.markTasksDeleting;
    markCase.store.markTasksDeleting = async () => {
      const error = new Error('simulated deleting persistence failure');
      error.code = 'ENOSPC';
      throw error;
    };
    await assert.rejects(markScheduler.deleteTasks([markTask.id]), error => error.code === 'ENOSPC');
    assert.strictEqual(cancelled, false, 'persistence failure must not cancel an active task');
    assert.notStrictEqual(markTask.status, 'deleting');
    markCase.store.markTasksDeleting = originalMark;
    await markScheduler.deleteTasks([markTask.id]);
    assert.strictEqual(cancelled, true);
    assert.strictEqual(markCase.store.tasks.has(markTask.id), false);
    await markScheduler.stop();
    await markCase.store.close();

    const restartCase = await openStore(root, 'restart');
    const restartTask = await addQueued(restartCase.store, 'restart');
    const legacyPart = path.join(restartCase.outputDir, 'restart.part.mp4');
    fs.writeFileSync(legacyPart, 'partial');
    await restartCase.store.updateTask(restartTask.id, { partPath: legacyPart });
    await restartCase.store.markTasksDeleting([restartTask.id]);
    const diskMarked = JSON.parse(fs.readFileSync(restartCase.tasksFile, 'utf8'));
    assert.strictEqual(diskMarked[0].status, 'deleting');
    assert.strictEqual(diskMarked[0].partPath, legacyPart);
    await restartCase.store.close();

    const recovered = await openStore(root, 'restart');
    assert.strictEqual(recovered.store.tasks.get(restartTask.id).status, 'deleting');
    const recoveryScheduler = createScheduler(recovered.store, {
      outputDir: recovered.outputDir,
      maxActiveTasks: 1,
      manageOutput: true,
      runTask: async () => { throw new Error('deleting task must not start'); },
    });
    recoveryScheduler.schedule();
    await waitFor(() => !recovered.store.tasks.has(restartTask.id), 'restart deletion recovery');
    assert.strictEqual(fs.existsSync(legacyPart), false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(recovered.tasksFile, 'utf8')), []);
    await recoveryScheduler.stop();
    await recovered.store.close();

    let failFinalDelete = false;
    let deleteWriteCount = 0;
    const finalCase = await openStore(root, 'final-failure', {
      beforeFsOperation: ({ name }) => {
        if (!failFinalDelete || name !== 'open') return;
        deleteWriteCount += 1;
        if (deleteWriteCount !== 2) return;
        const error = new Error('simulated final delete persistence failure');
        error.code = 'ENOSPC';
        throw error;
      },
    });
    const finalTask = await addQueued(finalCase.store, 'final-failure');
    await finalCase.store.updateTask(finalTask.id, { status: 'parsed', progressText: 'ready' });
    const finalPart = path.join(finalCase.outputDir, 'final.part.mp4');
    fs.writeFileSync(finalPart, 'partial');
    await finalCase.store.updateTask(finalTask.id, { partPath: finalPart });
    const finalScheduler = createScheduler(finalCase.store, {
      outputDir: finalCase.outputDir,
      maxActiveTasks: 1,
      manageOutput: true,
      runTask: async () => {},
    });
    failFinalDelete = true;
    await assert.rejects(finalScheduler.deleteTasks([finalTask.id]), error => error.code === 'ENOSPC');
    assert.strictEqual(finalCase.store.tasks.get(finalTask.id).status, 'deleting');
    assert.strictEqual(fs.existsSync(finalPart), false);
    const persistedAfterFailure = JSON.parse(fs.readFileSync(finalCase.tasksFile, 'utf8'));
    assert.strictEqual(persistedAfterFailure[0].status, 'deleting');
    failFinalDelete = false;
    await finalScheduler.deleteTasks([finalTask.id]);
    assert.strictEqual(finalCase.store.tasks.has(finalTask.id), false);
    await finalScheduler.stop();
    await finalCase.store.close();

    const commitCase = await openStore(root, 'commit-boundary');
    const commitTask = await addQueued(commitCase.store, 'commit-boundary');
    const renamed = deferred();
    const releaseCommit = deferred();
    const commitScheduler = createScheduler(commitCase.store, {
      outputDir: commitCase.outputDir,
      maxActiveTasks: 1,
      manageOutput: true,
      runTask: async (_task, options) => {
        fs.writeFileSync(options.partPath, 'complete-video');
      },
      outputManager: (() => {
        const { createOutputManager } = require('../lib/output-manager');
        const manager = createOutputManager(commitCase.outputDir);
        const commit = manager.commit;
        manager.commit = async (partPath, finalPath) => {
          await commit(partPath, finalPath);
          renamed.resolve(finalPath);
          await releaseCommit.promise;
        };
        return manager;
      })(),
    });
    commitScheduler.schedule();
    const committedFinal = await renamed.promise;
    const deleting = commitScheduler.deleteTasks([commitTask.id]);
    await waitFor(() => commitTask.cancelRequested === true, 'commit boundary cancellation');
    releaseCommit.resolve();
    await deleting;
    assert.strictEqual(commitCase.store.tasks.has(commitTask.id), false);
    assert.strictEqual(fs.existsSync(committedFinal), true, 'deleting a committed task must keep the final MP4');
    assert.strictEqual(fs.readFileSync(committedFinal, 'utf8'), 'complete-video');
    await commitScheduler.stop();
    await commitCase.store.close();

    const retryCase = await openStore(root, 'delete-retry');
    const retryTask = await addQueued(retryCase.store, 'delete-retry');
    const retryPart = path.join(retryCase.outputDir, 'retry.part.mp4');
    fs.writeFileSync(retryPart, 'partial');
    await retryCase.store.updateTask(retryTask.id, { status: 'parsed', partPath: retryPart });
    let cleanupAttempts = 0;
    let cleanupAllowed = false;
    const retryScheduler = createScheduler(retryCase.store, {
      outputDir: retryCase.outputDir,
      maxActiveTasks: 1,
      manageOutput: true,
      deletionRetryDelays: [25, 40],
      maxDeletionRetries: 2,
      runTask: async () => {},
      outputManager: {
        cleanupPart: async filePath => {
          cleanupAttempts += 1;
          if (!cleanupAllowed) throw Object.assign(new Error('permanent cleanup failure'), { code: 'EACCES' });
          await fs.promises.rm(filePath, { force: true });
        },
        release: () => {},
        getReservedCount: () => 0,
      },
    });
    await assert.rejects(retryScheduler.deleteTasks([retryTask.id]), /permanent cleanup failure/);
    assert.strictEqual(cleanupAttempts, 1);
    await waitFor(() => cleanupAttempts === 2, 'delayed deletion retry');
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.strictEqual(cleanupAttempts, 2, 'exhausted deletion must not enter a hot loop');
    const exhausted = retryCase.store.tasks.get(retryTask.id);
    assert.strictEqual(exhausted.status, 'deleting');
    assert.strictEqual(exhausted.deletionRetryCount, 2);
    assert.strictEqual(exhausted.deletionRetryExhausted, true);
    assert.match(exhausted.deletionError, /permanent cleanup failure/);
    assert.strictEqual(exhausted.nextDeletionRetryAt, null);
    await retryScheduler.stop();
    await retryCase.store.close();

    const restartedRetryCase = await openStore(root, 'delete-retry');
    const persistedExhausted = restartedRetryCase.store.tasks.get(retryTask.id);
    assert.strictEqual(persistedExhausted.deletionRetryExhausted, true);
    assert.strictEqual(persistedExhausted.deletionRetryCount, 2);
    assert.strictEqual(persistedExhausted.nextDeletionRetryAt, null);
    let restartedCleanupAttempts = 0;
    const restartedRetryScheduler = createScheduler(restartedRetryCase.store, {
      outputDir: restartedRetryCase.outputDir,
      maxActiveTasks: 1,
      manageOutput: true,
      deletionRetryDelays: [25, 40],
      maxDeletionRetries: 2,
      runTask: async () => {},
      outputManager: {
        cleanupPart: async filePath => {
          restartedCleanupAttempts += 1;
          await fs.promises.rm(filePath, { force: true });
        },
        release: () => {},
        getReservedCount: () => 0,
      },
    });
    restartedRetryScheduler.schedule();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.strictEqual(restartedCleanupAttempts, 0, 'restart must not auto-retry an exhausted deletion');
    await restartedRetryScheduler.deleteTasks([retryTask.id]);
    assert.strictEqual(restartedCleanupAttempts, 1, 'manual delete must perform one fresh cleanup attempt');
    assert.strictEqual(restartedRetryCase.store.tasks.has(retryTask.id), false, 'manual retry must remain available');
    assert.strictEqual(fs.existsSync(retryPart), false);
    await restartedRetryScheduler.stop();
    await restartedRetryCase.store.close();
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

const timeout = setTimeout(() => {
  console.error('stage3-delete-smoke timed out');
  process.exit(1);
}, 9000);

run().then(() => {
  clearTimeout(timeout);
  console.log('stage3-delete-smoke-ok');
}).catch(error => {
  clearTimeout(timeout);
  console.error(error);
  process.exitCode = 1;
});
