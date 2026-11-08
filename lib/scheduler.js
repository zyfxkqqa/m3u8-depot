const fs = require('fs');
const { TaskCancelledError } = require('./ffmpeg-runner');
const { runDownloadTask } = require('./downloader');
const { parsePlayPage } = require('./play-extractor');
const { createOutputManager } = require('./output-manager');
const { isDeletingTask, deletionFailurePatch, deletionReadyAt } = require('./deletion-state');

const TRANSIENT_CODES = new Set([
  'FFMPEG_TRANSIENT',
  'FFMPEG_STALLED',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

function createScheduler(store, options) {
  const activeTasks = new Map();
  const deletingTasks = new Set();
  const runTask = options.runTask || runDownloadTask;
  const parsePage = options.parsePlayPage || parsePlayPage;
  const managesOutput = !options.runTask || options.manageOutput === true;
  const outputManager = managesOutput
    ? (options.outputManager || createOutputManager(options.outputDir, options.outputOptions))
    : null;
  const retryDelays = options.retryDelays || [5000, 15000];
  const maxRetries = options.maxRetries ?? 2;
  const deletionRetryDelays = options.deletionRetryDelays || [1000, 5000, 15000];
  const maxDeletionRetries = options.maxDeletionRetries ?? 3;
  const onError = options.onError || (() => {});
  const onTaskError = options.onTaskError || (() => {});
  let schedulePending = false;
  let stopping = false;
  let stopPromise = null;
  let deletionRecoveryPromise = null;
  let deletionRetryTimer = null;
  const deletionBlockedThisRun = new Set();

  function cancellationError(signal) {
    return signal?.reason?.code === 'TASK_CANCELLED' ? signal.reason : new TaskCancelledError();
  }

  function delayWithSignal(ms, signal) {
    if (signal.aborted) return Promise.reject(cancellationError(signal));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        reject(cancellationError(signal));
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function isCancelled(error, task, signal) {
    return signal.aborted || task.cancelRequested || error?.code === 'TASK_CANCELLED';
  }

  function isRetryable(error) {
    return TRANSIENT_CODES.has(error?.code);
  }

  async function runAttempts(task, signal, reservation) {
    let retryCount = Number(task.retryCount || 0);
    while (true) {
      let commitBoundary = false;
      if (signal.aborted) throw cancellationError(signal);
      await outputManager.cleanupPart(reservation.partPath, reservation.partPath);
      try {
        if (!options.runTask && !fs.existsSync(options.ffmpeg)) {
          const error = new Error(`FFmpeg 不存在: ${options.ffmpeg}`);
          error.code = 'FFMPEG_MISSING';
          throw error;
        }
        await runTask(task, {
          ...options,
          finalPath: reservation.finalPath,
          partPath: reservation.partPath,
          deferCompletion: true,
        }, store.updateTask, signal);
        if (signal.aborted) throw cancellationError(signal);
        await store.updateTask(task.id, {
          status: 'committing',
          output: reservation.finalPath,
          partPath: reservation.partPath,
          progressText: '下载完成，正在提交文件',
          nextRetryAt: null,
          error: '',
        });
        if (signal.aborted) throw cancellationError(signal);
        await outputManager.commit(reservation.partPath, reservation.finalPath);
        commitBoundary = true;
        if (signal.aborted) throw cancellationError(signal);
        const size = fs.statSync(reservation.finalPath).size;
        outputManager.release(reservation.finalPath);
        try {
          await store.updateTask(task.id, {
            status: 'done',
            output: reservation.finalPath,
            partPath: '',
            progressText: '完成',
            completedAt: new Date().toISOString(),
            outputSize: size,
            retryCount,
            nextRetryAt: null,
            error: '',
          });
        } catch (persistError) {
          outputManager.retain(reservation.finalPath);
          Object.assign(task, {
            status: 'committing',
            output: reservation.finalPath,
            partPath: reservation.partPath,
            progressText: '文件已提交，等待状态恢复',
            error: String(persistError.message || persistError).slice(0, 4000),
          });
          persistError.code = 'COMMIT_PERSISTENCE_FAILED';
          throw persistError;
        }
        return;
      } catch (error) {
        await outputManager.cleanupPart(reservation.partPath, reservation.partPath);
        if (commitBoundary && !isCancelled(error, task, signal) && error?.code !== 'COMMIT_PERSISTENCE_FAILED') {
          Object.assign(task, {
            status: 'committing',
            output: reservation.finalPath,
            partPath: '',
            progressText: '文件已提交，等待状态恢复',
            error: String(error.message || error).slice(0, 4000),
          });
          error.code = 'COMMIT_PERSISTENCE_FAILED';
        }
        if (error?.code === 'COMMIT_PERSISTENCE_FAILED') throw error;
        if (isCancelled(error, task, signal)) throw cancellationError(signal);
        if (!isRetryable(error) || retryCount >= maxRetries) throw error;

        retryCount += 1;
        const delayMs = retryDelays[Math.min(retryCount - 1, retryDelays.length - 1)] || 0;
        const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
        await store.updateTask(task.id, {
          status: 'retrying',
          progressText: `下载失败，${Math.ceil(delayMs / 1000)} 秒后进行第 ${retryCount} 次重试`,
          retryCount,
          nextRetryAt,
          error: String(error.message || error).slice(0, 4000),
        });
        await delayWithSignal(delayMs, signal);
        if (signal.aborted) throw cancellationError(signal);

        const refreshed = await parsePage(task.pageUrl);
        await store.updateTask(task.id, {
          m3u8Url: refreshed.m3u8Url,
          m3u8Source: refreshed.m3u8Source || task.m3u8Source,
          status: 'queued',
          progressText: `已刷新播放地址，准备第 ${retryCount} 次重试`,
          nextRetryAt: null,
          error: '',
        });
      }
    }
  }

  async function processTask(task, signal) {
    if (!managesOutput) {
      try {
        await runTask(task, options, store.updateTask, signal);
        if (signal.aborted) throw cancellationError(signal);
      } catch (error) {
        if (isCancelled(error, task, signal)) {
          await store.updateTask(task.id, { status: 'parsed', error: '', progressText: '已停止，等待手动开始' });
        } else {
          onTaskError(task, error);
          await store.updateTask(task.id, {
            status: 'failed',
            error: String(error.message || error).slice(0, 4000),
            progressText: '失败',
          });
        }
      } finally {
        task.cancelRequested = false;
      }
      return;
    }

    if (task.recoveryPartPath) {
      try {
        await outputManager.cleanupPart(task.recoveryPartPath, task.recoveryPartPath);
        await store.updateTask(task.id, { partPath: '', recoveryPartPath: '' });
      } catch (error) {
        onTaskError(task, error);
        await store.updateTask(task.id, {
          status: 'failed',
          recoveryPartPath: task.recoveryPartPath,
          error: `恢复临时文件清理失败: ${String(error.message || error).slice(0, 3900)}`,
          progressText: '恢复临时文件清理失败',
        });
        return;
      }
    }
    // 合集类内容（电视剧、综艺）按剧名归入子目录；播放页单条解析的电影留在根目录。
    const subdir = task.batchId ? (task.batchTitle || task.batchLine || '合集') : null;
    const reservation = outputManager.reserve(task.title, task.id, { subdir });
    let retainReservation = false;
    try {
      await store.updateTask(task.id, {
        output: reservation.finalPath,
        partPath: reservation.partPath,
        retryCount: Number(task.retryCount || 0),
        nextRetryAt: null,
      });
      await runAttempts(task, signal, reservation);
    } catch (error) {
      try {
        if (error?.code === 'COMMIT_PERSISTENCE_FAILED') {
          retainReservation = true;
          return;
        }
        let cleanupError = null;
        try {
          await outputManager.cleanupPart(reservation.partPath, reservation.partPath);
        } catch (errorDuringCleanup) {
          cleanupError = errorDuringCleanup;
        }
        if (cleanupError || error?.code === 'FINAL_CLEANUP_FAILED') {
          const failure = cleanupError || error;
          onTaskError(task, failure);
          await store.updateTask(task.id, {
            status: 'failed',
            partPath: fs.existsSync(reservation.partPath) ? reservation.partPath : '',
            nextRetryAt: null,
            error: `文件清理失败：${String(failure.message || failure).slice(0, 3900)}`,
            progressText: '文件清理失败',
          });
        } else if (isCancelled(error, task, signal)) {
          await store.updateTask(task.id, {
            status: 'parsed',
            error: '',
            partPath: '',
            nextRetryAt: null,
            progressText: '已停止，等待手动开始',
          });
        } else {
          onTaskError(task, error);
          await store.updateTask(task.id, {
            status: 'failed',
            partPath: '',
            nextRetryAt: null,
            error: String(error.message || error).slice(0, 4000),
            progressText: '失败',
          });
        }
      } catch (stateError) {
        onError(stateError);
      }
    } finally {
      task.cancelRequested = false;
      if (!retainReservation) outputManager.release(reservation.finalPath);
    }
  }

  function startClaimedTask(task) {
    const controller = new AbortController();
    const entry = { controller, promise: null, deleting: false };
    activeTasks.set(task.id, entry);
    entry.promise = processTask(task, controller.signal)
      .catch(onError)
      .finally(() => {
        activeTasks.delete(task.id);
        if (!stopping) schedule();
      });
  }

  function dispatch() {
    schedulePending = false;
    if (stopping) return;
    const now = Date.now();
    const deleting = [...store.tasks.values()]
      .filter(task => (
        isDeletingTask(task)
        && task.deletionRetryExhausted !== true
        && !deletingTasks.has(task.id)
        && !deletionBlockedThisRun.has(task.id)
      ));
    const pendingDeletes = deleting
      .filter(task => deletionReadyAt(task) <= now)
      .map(task => task.id);
    if (pendingDeletes.length > 0) {
      deletionRecoveryPromise = completeDeletions(pendingDeletes)
        .catch(onError)
        .finally(() => {
          deletionRecoveryPromise = null;
          if (!stopping) schedule();
        });
      return;
    }
    const nextDeletionRetryAt = deleting
      .map(deletionReadyAt)
      .filter(timestamp => timestamp > now)
      .sort((left, right) => left - right)[0];
    if (nextDeletionRetryAt && !deletionRetryTimer) {
      deletionRetryTimer = setTimeout(() => {
        deletionRetryTimer = null;
        schedule();
      }, Math.max(1, nextDeletionRetryAt - now));
      deletionRetryTimer.unref?.();
    }
    const capacity = Math.max(0, options.maxActiveTasks - activeTasks.size);
    if (capacity === 0) return;
    const queued = [...store.tasks.values()]
      .filter(task => task.status === 'queued' && !activeTasks.has(task.id) && !deletingTasks.has(task.id))
      .slice(0, capacity);
    for (const task of queued) startClaimedTask(task);
  }

  function schedule() {
    if (stopping || schedulePending) return false;
    schedulePending = true;
    setImmediate(dispatch);
    return true;
  }

  function requestCancellation(id) {
    const entry = activeTasks.get(id);
    if (!entry) return null;
    const task = store.tasks.get(id);
    if (task) task.cancelRequested = true;
    if (!entry.controller.signal.aborted) entry.controller.abort(new TaskCancelledError());
    return entry.promise;
  }

  async function cancelTask(id) {
    const promise = requestCancellation(id);
    if (!promise) return false;
    await promise;
    return true;
  }

  async function deleteTasks(ids) {
    const uniqueIds = [...new Set(ids)];
    for (const id of uniqueIds) deletionBlockedThisRun.delete(id);
    const markedIds = await store.markTasksDeleting(uniqueIds);
    return completeDeletions(markedIds);
  }

  async function recordDeletionFailure(task, error) {
    const currentCount = Number(task.deletionRetryCount || 0);
    const delayMs = deletionRetryDelays[Math.min(currentCount, deletionRetryDelays.length - 1)] || 0;
    const patch = deletionFailurePatch(task, error, {
      now: Date.now(),
      delayMs,
      maxRetries: maxDeletionRetries,
    });
    await store.updateTask(task.id, patch);
    if (patch.deletionRetryExhausted) deletionBlockedThisRun.add(task.id);
  }

  async function completeDeletions(ids) {
    const uniqueIds = [...new Set(ids)].filter(id => store.tasks.has(id));
    if (uniqueIds.length === 0) return;
    for (const id of uniqueIds) deletingTasks.add(id);
    try {
      const waits = [];
      for (const id of uniqueIds) {
        const promise = requestCancellation(id);
        if (promise) waits.push(promise);
      }
      await Promise.allSettled(waits);
      const ready = [];
      let firstError = null;
      if (managesOutput) {
        for (const id of uniqueIds) {
          const task = store.tasks.get(id);
          if (!task) continue;
          try {
            const paths = [...new Set([task.partPath, task.recoveryPartPath].filter(Boolean))];
            for (const partPath of paths) await outputManager.cleanupPart(partPath, partPath);
            if (task.output) outputManager.release(task.output);
            ready.push(id);
          } catch (error) {
            // 任务记录可能来自旧的输出目录（例如输出目录被改过盘符），
            // 此时路径越界校验会拒绝清理。若这些文件实际已不存在，
            // 就没有需要清理的对象，允许直接删除记录，避免永久卡在 deleting。
            const orphaned = error?.code === 'OUTPUT_PATH_INVALID'
              && ![task.partPath, task.recoveryPartPath, task.output]
                .filter(Boolean)
                .some(existingPath => fs.existsSync(existingPath));
            if (orphaned) {
              if (task.output) outputManager.release(task.output);
              ready.push(id);
              continue;
            }
            try {
              await recordDeletionFailure(task, error);
            } catch (persistError) {
              onError(persistError);
            }
            if (!firstError) firstError = error;
          }
        }
      } else {
        ready.push(...uniqueIds);
      }
      if (ready.length > 0) {
        try {
          await store.deleteTasks(ready);
        } catch (error) {
          for (const id of ready) {
            const task = store.tasks.get(id);
            if (!task) continue;
            try {
              await recordDeletionFailure(task, error);
            } catch (persistError) {
              onError(persistError);
            }
          }
          if (!firstError) firstError = error;
        }
      }
      if (firstError) throw firstError;
    } finally {
      for (const id of uniqueIds) deletingTasks.delete(id);
      if (!stopping) schedule();
    }
  }

  async function stop(stopOptions = {}) {
    if (stopPromise) return stopPromise;
    stopping = true;
    schedulePending = false;
    if (deletionRetryTimer) {
      clearTimeout(deletionRetryTimer);
      deletionRetryTimer = null;
    }
    stopPromise = (async () => {
      if (stopOptions.cancelActive !== false) {
        for (const id of activeTasks.keys()) requestCancellation(id);
      }
      await Promise.allSettled([...activeTasks.values()].map(entry => entry.promise));
      if (deletionRecoveryPromise) await Promise.allSettled([deletionRecoveryPromise]);
    })();
    return stopPromise;
  }

  return {
    schedule,
    stop,
    cancelTask,
    deleteTasks,
    drain: () => stop({ cancelActive: false }),
    getActiveCount: () => activeTasks.size,
    getReservedCount: () => outputManager?.getReservedCount() || 0,
    isDeleting: id => deletingTasks.has(id),
    isStopping: () => stopping,
  };
}

module.exports = { createScheduler, TRANSIENT_CODES };
