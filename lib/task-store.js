const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sanitizeParsedInput } = require('./task-input');
const { isDeletingTask, deletingPatch } = require('./deletion-state');

const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const persistenceLanes = new Map();

function getPersistenceLane(tasksFile) {
  const key = path.resolve(tasksFile).toLowerCase();
  let lane = persistenceLanes.get(key);
  if (!lane) {
    lane = { tail: Promise.resolve() };
    persistenceLanes.set(key, lane);
  }
  return lane;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryFileOperation(operation, options = {}) {
  const attempts = options.attempts || 5;
  const retryDelayMs = options.retryDelayMs || 25;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (options.beforeAttempt) await options.beforeAttempt(attempt);
      return await operation();
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_CODES.has(error.code) || attempt === attempts) throw error;
      await delay(retryDelayMs * attempt);
    }
  }

  throw lastError;
}

function createTaskStore(options) {
  const { dataDir, tasksFile, outputDir } = options;
  const backupFile = options.backupFile || `${tasksFile}.bak`;
  const tempFile = options.tempFile || `${tasksFile}.tmp`;
  const throttleMs = options.throttleMs ?? 750;
  const retryDelayMs = options.retryDelayMs ?? 25;
  const retryAttempts = options.retryAttempts ?? 5;
  const beforeFsOperation = options.beforeFsOperation || null;
  const onPersistenceError = options.onPersistenceError || (() => {});
  const onWrite = options.onWrite || (() => {});
  const fsp = fs.promises;
  const tasks = new Map();
  const persistenceLane = getPersistenceLane(tasksFile);

  let mutationVersion = 0;
  let persistedVersion = 0;
  let throttleTimer = null;
  let mainFileHealthy = false;
  let closed = false;
  let lastPersistenceError = null;
  let commitTail = Promise.resolve();

  function ensureDirs() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
  }

  function publicTask(task) {
    const copy = { ...task };
    delete copy.process;
    delete copy.cancelRequested;
    return copy;
  }

  function snapshotTasks() {
    return [...tasks.values()].map(publicTask);
  }

  function assertOpen() {
    if (closed) throw new Error('Task store is closed');
  }

  async function fileOperation(name, target, operation) {
    return retryFileOperation(operation, {
      attempts: retryAttempts,
      retryDelayMs,
      beforeAttempt: beforeFsOperation
        ? attempt => beforeFsOperation({ name, target, attempt })
        : null,
    });
  }

  async function pathExists(filePath) {
    try {
      await fsp.access(filePath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async function removeIfExists(filePath) {
    try {
      await fileOperation('unlink', filePath, () => fsp.unlink(filePath));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async function writeSynced(filePath, content) {
    const handle = await fileOperation('open', filePath, () => fsp.open(filePath, 'w'));
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function replaceFile(source, target) {
    try {
      await fileOperation('rename', target, () => fsp.rename(source, target));
      return;
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    }

    const displaced = `${target}.replace-old`;
    await removeIfExists(displaced);
    const targetExists = await pathExists(target);
    if (targetExists) {
      await fileOperation('rename-existing', target, () => fsp.rename(target, displaced));
    }

    try {
      await fileOperation('rename', target, () => fsp.rename(source, target));
      await removeIfExists(displaced);
    } catch (error) {
      if (targetExists && await pathExists(displaced) && !await pathExists(target)) {
        await fileOperation('restore', target, () => fsp.rename(displaced, target));
      }
      throw error;
    }
  }

  async function createBackup() {
    if (!mainFileHealthy || !await pathExists(tasksFile)) return;
    const backupTemp = `${backupFile}.tmp`;
    await removeIfExists(backupTemp);
    await fileOperation('copy-backup', backupTemp, () => fsp.copyFile(tasksFile, backupTemp));
    await replaceFile(backupTemp, backupFile);
  }

  async function writeSnapshot(snapshot = snapshotTasks(), version = mutationVersion) {
    ensureDirs();
    const content = JSON.stringify(snapshot, null, 2);
    await removeIfExists(tempFile);
    await writeSynced(tempFile, content);
    await createBackup();
    await replaceFile(tempFile, tasksFile);
    mainFileHealthy = true;
    persistedVersion = Math.max(persistedVersion, version);
    lastPersistenceError = null;
    try {
      onWrite({ version, tasksFile });
    } catch (_) {
      // Test/instrumentation hooks must not turn a committed snapshot into failure.
    }
    return version;
  }

  function enqueuePersistence(operation) {
    const writePromise = persistenceLane.tail.then(operation);
    persistenceLane.tail = writePromise.catch(error => {
      lastPersistenceError = error;
      try {
        onPersistenceError(error);
      } catch (_) {
        // Persistence reporting must not create a second failure chain.
      }
    });
    return writePromise;
  }

  function enqueueWrite(snapshot, version) {
    return enqueuePersistence(() => writeSnapshot(snapshot, version));
  }

  function enqueueTransaction(operation) {
    return enqueuePersistence(operation);
  }

  function scheduleThrottledWrite() {
    if (closed || throttleTimer) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      persistNow().catch(() => {});
    }, throttleMs);
    if (typeof throttleTimer.unref === 'function') throttleTimer.unref();
  }

  async function persistNow() {
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    const targetVersion = mutationVersion;
    if (persistedVersion >= targetVersion) return;
    await enqueuePersistence(async () => {
      if (persistedVersion >= targetVersion) return;
      const version = mutationVersion;
      await writeSnapshot(snapshotTasks(), version);
    });
  }

  async function flush() {
    while (persistedVersion < mutationVersion) {
      await persistNow();
    }
    await persistenceLane.tail;
    if (lastPersistenceError) throw lastPersistenceError;
  }

  function parseTaskList(content, source) {
    const list = JSON.parse(content);
    if (!Array.isArray(list)) throw new Error(`Task store is not an array: ${source}`);
    for (const task of list) {
      if (!task || typeof task !== 'object' || typeof task.id !== 'string') {
        throw new Error(`Task store contains an invalid task: ${source}`);
      }
    }
    return list;
  }

  async function readCandidate(filePath) {
    try {
      const content = await fsp.readFile(filePath, 'utf8');
      return { ok: true, list: parseTaskList(content, filePath) };
    } catch (error) {
      if (error.code === 'ENOENT') return { ok: false, missing: true, error };
      return { ok: false, missing: false, error };
    }
  }

  async function loadTasks() {
    ensureDirs();
    const candidates = [tasksFile, backupFile, tempFile];
    let selected = null;
    const failures = [];

    for (const candidate of candidates) {
      const result = await readCandidate(candidate);
      if (result.ok) {
        selected = { filePath: candidate, list: result.list };
        break;
      }
      if (!result.missing) failures.push(`${candidate}: ${result.error.message}`);
    }

    if (!selected) {
      if (failures.length) throw new Error(`Unable to recover task store. ${failures.join(' | ')}`);
      mainFileHealthy = false;
      return { source: null, recovered: false, count: 0 };
    }

    tasks.clear();
    let normalized = false;
    for (const storedTask of selected.list) {
      const task = { ...storedTask, process: null };
      if (task.status === 'running') {
        task.recoveryPartPath = task.recoveryPartPath || task.partPath || '';
        task.status = 'queued';
        task.progressText = '检测到上次下载中断，已恢复到队列';
        task.partPath = task.partPath || '';
        task.nextRetryAt = null;
        normalized = true;
      } else if (task.status === 'retrying') {
        task.recoveryPartPath = task.recoveryPartPath || task.partPath || '';
        task.status = 'queued';
        task.progressText = '检测到重试等待中断，已恢复到队列';
        task.nextRetryAt = null;
        normalized = true;
      } else if (task.status === 'committing') {
        const finalExists = Boolean(task.output && fs.existsSync(task.output) && fs.statSync(task.output).size > 0);
        const partExists = Boolean(task.partPath && fs.existsSync(task.partPath) && fs.statSync(task.partPath).size > 0);
        if (finalExists && !partExists) {
          task.status = 'done';
          task.progressText = '完成（已恢复提交状态）';
          task.outputSize = fs.statSync(task.output).size;
          task.partPath = '';
          task.completedAt = task.completedAt || new Date().toISOString();
          task.error = '';
        } else if (!finalExists && partExists) {
          task.recoveryPartPath = task.recoveryPartPath || task.partPath;
          task.status = 'queued';
          task.progressText = '检测到未完成的文件提交，已恢复到队列';
          task.nextRetryAt = null;
        } else {
          task.status = 'failed';
          task.progressText = '文件提交状态异常';
          task.error = finalExists
            ? '提交恢复失败：最终文件和临时文件同时存在'
            : '提交恢复失败：最终文件和临时文件均不存在';
          task.nextRetryAt = null;
        }
        normalized = true;
      }
      tasks.set(task.id, task);
    }

    mutationVersion += 1;
    mainFileHealthy = selected.filePath === tasksFile;
    if (mainFileHealthy && !normalized) {
      persistedVersion = mutationVersion;
    } else {
      await persistNow();
    }

    return {
      source: selected.filePath,
      recovered: selected.filePath !== tasksFile,
      count: tasks.size,
    };
  }

  function findDuplicate(parsed) {
    return [...tasks.values()].find(task => {
      if (parsed.pageUrl && task.pageUrl === parsed.pageUrl) return true;
      if (parsed.m3u8Url && task.m3u8Url === parsed.m3u8Url) return true;
      return false;
    }) || null;
  }

  async function addParsedTask(parsed, taskOptions = {}) {
    assertOpen();
    const business = sanitizeParsedInput(parsed);
    let id;
    do id = crypto.randomUUID(); while (tasks.has(id));
    const now = new Date().toISOString();
    const task = {
      ...business,
      id,
      status: 'parsed',
      progressText: '已解析，等待开始',
      error: '',
      output: '',
      outputSize: 0,
      duplicate: Boolean(taskOptions.duplicate),
      duplicateOf: taskOptions.duplicateOf || null,
      existingTitle: taskOptions.existingTitle || null,
      existingStatus: taskOptions.existingStatus || null,
      batchId: taskOptions.batchId || null,
      batchTitle: taskOptions.batchTitle || null,
      batchLine: taskOptions.batchLine || null,
      createdAt: now,
      updatedAt: now,
      partPath: '',
      retryCount: 0,
      nextRetryAt: null,
      process: null,
      cancelRequested: false,
    };
    tasks.set(task.id, task);
    mutationVersion += 1;
    await persistNow();
    return task;
  }

  function commitParsedTask(parsed, taskOptions = {}) {
    const operation = commitTail.then(async () => {
      assertOpen();
      const business = sanitizeParsedInput(parsed);
      const duplicateTask = findDuplicate(business);
      const duplicate = Boolean(duplicateTask);
      const task = await addParsedTask(business, {
        duplicate,
        duplicateOf: duplicateTask?.id || null,
        existingTitle: duplicateTask?.title || null,
        existingStatus: duplicateTask?.status || null,
        batchId: taskOptions.batchId,
        batchTitle: taskOptions.batchTitle,
        batchLine: taskOptions.batchLine,
      });
      const shouldStart = taskOptions.mode === 'redownload' || (taskOptions.mode === 'direct' && !duplicate);
      if (shouldStart) await updateTask(task.id, { status: 'queued', progressText: '排队中', error: '' });
      return publicTask(tasks.get(task.id));
    });
    commitTail = operation.catch(() => {});
    return operation;
  }

  async function updateTask(id, patch, updateOptions = {}) {
    assertOpen();
    const task = tasks.get(id);
    if (!task) return null;
    const effectivePatch = { ...patch };
    if (isDeletingTask(task) && effectivePatch.status !== 'deleting') {
      delete effectivePatch.status;
      delete effectivePatch.deletionRequestedAt;
    }
    Object.assign(task, effectivePatch, { updatedAt: new Date().toISOString() });
    mutationVersion += 1;

    const patchKeys = Object.keys(effectivePatch);
    const progressOnly = patchKeys.length > 0 && patchKeys.every(key => key === 'progressText');
    const persistence = updateOptions.persistence || (progressOnly ? 'throttled' : 'immediate');
    if (persistence === 'throttled') scheduleThrottledWrite();
    else await persistNow();
    return task;
  }

  async function markTasksDeleting(ids) {
    assertOpen();
    const idSet = new Set(ids);
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    return enqueueTransaction(async () => {
      const selected = [...tasks.values()].filter(task => idSet.has(task.id));
      if (selected.length === 0) return [];
      const now = new Date().toISOString();
      const patch = deletingPatch(now);
      mutationVersion += 1;
      const transactionVersion = mutationVersion;
      const nextSnapshot = [...tasks.values()].map(task => publicTask(
        idSet.has(task.id)
          ? { ...task, ...patch, updatedAt: now }
          : task,
      ));
      await writeSnapshot(nextSnapshot, transactionVersion);
      for (const task of selected) Object.assign(task, patch, { updatedAt: now });
      persistedVersion = Math.max(persistedVersion, transactionVersion);
      return selected.map(task => task.id);
    });
  }

  async function deleteTasks(ids) {
    assertOpen();
    const idSet = new Set(ids);
    if (![...tasks.keys()].some(id => idSet.has(id))) return;

    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    await enqueueTransaction(async () => {
      const removed = [...tasks.keys()].filter(id => idSet.has(id));
      if (removed.length === 0) return;
      mutationVersion += 1;
      const transactionVersion = mutationVersion;
      const nextSnapshot = [...tasks.values()]
        .filter(task => !idSet.has(task.id))
        .map(publicTask);
      await writeSnapshot(nextSnapshot, transactionVersion);
      for (const id of removed) tasks.delete(id);
      persistedVersion = Math.max(persistedVersion, transactionVersion);
    });
  }

  async function close() {
    if (closed) {
      await persistenceLane.tail;
      if (lastPersistenceError) throw lastPersistenceError;
      return;
    }
    closed = true;
    await flush();
  }

  return {
    tasks,
    ensureDirs,
    loadTasks,
    saveTasks: flush,
    flush,
    close,
    publicTask,
    addParsedTask,
    commitParsedTask,
    findDuplicate,
    updateTask,
    markTasksDeleting,
    deleteTasks,
    listTasks: () => [...tasks.values()].map(publicTask),
    getPersistenceState: () => ({
      mutationVersion,
      persistedVersion,
      lastError: lastPersistenceError,
    }),
  };
}

module.exports = { createTaskStore, retryFileOperation };
