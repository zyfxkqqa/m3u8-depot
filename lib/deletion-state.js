const DELETING_STATUS = 'deleting';

function isDeletingTask(task) {
  return task?.status === DELETING_STATUS;
}

function deletingPatch(now = new Date().toISOString()) {
  return {
    status: DELETING_STATUS,
    deletionRequestedAt: now,
    nextRetryAt: null,
    deletionRetryCount: 0,
    nextDeletionRetryAt: null,
    deletionRetryExhausted: false,
    deletionError: '',
    error: '',
  };
}

function deletionFailurePatch(task, error, options = {}) {
  const retryCount = Number(task?.deletionRetryCount || 0) + 1;
  const exhausted = retryCount >= options.maxRetries;
  const message = String(error?.message || error).slice(0, 4000);
  return {
    status: DELETING_STATUS,
    deletionRetryCount: retryCount,
    nextDeletionRetryAt: exhausted
      ? null
      : new Date(options.now + options.delayMs).toISOString(),
    deletionRetryExhausted: exhausted,
    deletionError: message,
    error: message,
    progressText: exhausted ? '删除失败，等待手动重试' : '删除失败，等待重试',
  };
}

function deletionReadyAt(task) {
  if (!task?.nextDeletionRetryAt) return 0;
  const timestamp = Date.parse(task.nextDeletionRetryAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

module.exports = {
  DELETING_STATUS,
  isDeletingTask,
  deletingPatch,
  deletionFailurePatch,
  deletionReadyAt,
};
