export const ACTIVE_STATUSES = new Set(['running', 'queued', 'retrying', 'committing', 'deleting']);

export function getPollDelay(tasks, hidden) {
  if (hidden) return 10000;
  return tasks.some(task => ACTIVE_STATUSES.has(task.status)) ? 1500 : 5000;
}

export function createPollingController(options) {
  let timer = null;
  let stopped = true;
  let generation = 0;
  let inFlight = null;

  function clearTimer() {
    if (timer !== null) options.clearTimeoutFn(timer.id);
    timer = null;
  }
  function isCurrent(targetGeneration) { return !stopped && generation === targetGeneration; }
  function schedule(targetGeneration = generation) {
    if (!isCurrent(targetGeneration)) return;
    clearTimer();
    const delay = getPollDelay(options.getTasks(), options.isHidden());
    const id = options.setTimeoutFn(() => {
      if (timer?.id === id) timer = null;
      if (!isCurrent(targetGeneration)) return;
      refreshNow().catch(() => {});
    }, delay);
    timer = { id, generation: targetGeneration };
  }
  function refreshNow() {
    const targetGeneration = generation;
    if (stopped) return Promise.resolve();
    clearTimer();
    if (inFlight?.generation === targetGeneration) return inFlight.promise;
    const context = { generation: targetGeneration, isCurrent: () => isCurrent(targetGeneration) };
    let promise;
    promise = Promise.resolve()
      .then(() => options.refresh(context))
      .catch(error => { if (!context.isCurrent()) return undefined; throw error; })
      .finally(() => {
        if (inFlight?.generation === targetGeneration && inFlight.promise === promise) inFlight = null;
        if (context.isCurrent()) schedule(targetGeneration);
      });
    inFlight = { generation: targetGeneration, promise };
    return promise;
  }
  return {
    start() {
      if (!stopped) return inFlight?.generation === generation ? inFlight.promise : refreshNow();
      stopped = false; generation += 1; return refreshNow();
    },
    stop() { stopped = true; generation += 1; clearTimer(); },
    refreshNow,
    reschedule: () => schedule(generation),
    isStopped: () => stopped,
    isRunning: () => Boolean(inFlight?.generation === generation),
    getGeneration: () => generation,
  };
}
