const { readJsonBody } = require('../lib/http/request-body');
const { sendJson } = require('../lib/http/respond');

const TASK_STATUSES = new Set(['parsed', 'queued', 'running', 'retrying', 'committing', 'deleting', 'done', 'failed']);
const TASK_QUERY_NAMES = ['page', 'pageSize', 'status', 'batch'];

function getSingleQueryValue(searchParams, name) {
  const values = searchParams.getAll(name);
  if (values.length > 1) throw new Error(`${name} must not be repeated`);
  return values.length === 1 ? values[0] : null;
}

function parsePositiveInteger(value, name, defaultValue, maxValue) {
  if (value === null) return defaultValue;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maxValue) {
    throw new Error(`${name} must be between 1 and ${maxValue}`);
  }
  return number;
}

function queryTasks(tasks, searchParams) {
  const page = parsePositiveInteger(getSingleQueryValue(searchParams, 'page'), 'page', 1, 1000000);
  const pageSize = parsePositiveInteger(getSingleQueryValue(searchParams, 'pageSize'), 'pageSize', 20, 200);
  const statusValue = getSingleQueryValue(searchParams, 'status');
  const batchValue = getSingleQueryValue(searchParams, 'batch');
  const status = statusValue === null ? '' : statusValue;
  const batch = batchValue === null ? '' : batchValue;
  if (statusValue !== null && !TASK_STATUSES.has(status)) throw new Error(`unknown task status: ${status}`);
  if (batchValue !== null) {
    if (batch.length < 1 || batch.length > 200) throw new Error('batch length must be between 1 and 200');
    if (/[\x00-\x1f\x7f]/.test(batch)) throw new Error('batch contains invalid control characters');
    if (batch.startsWith('__') && batch !== '__manual__') throw new Error(`unknown special batch: ${batch}`);
  }

  const batchFiltered = batch
    ? tasks.filter(task => batch === '__manual__' ? !task.batchId : task.batchId === batch)
    : tasks;
  const statusCounts = batchFiltered.reduce((counts, task) => {
    counts[task.status] = (counts[task.status] || 0) + 1;
    return counts;
  }, {});
  const filtered = status ? batchFiltered.filter(task => task.status === status) : batchFiltered;
  const start = (page - 1) * pageSize;
  return {
    tasks: filtered.slice(start, start + pageSize),
    total: filtered.length,
    page,
    pageSize,
    statusCounts,
  };
}

function createTaskRoutes({ store, scheduler }) {
  return async function taskRoutes(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const tasks = store.listTasks();
      const hasQuery = TASK_QUERY_NAMES.some(name => url.searchParams.has(name));
      if (!hasQuery) sendJson(res, 200, { ok: true, tasks });
      else {
        try {
          sendJson(res, 200, { ok: true, ...queryTasks(tasks, url.searchParams) });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error.message || error) });
        }
      }
      return true;
    }

    if (req.method !== 'POST') return false;

    if (url.pathname === '/api/start') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : [];
      if (ids.length === 0) {
        sendJson(res, 400, { ok: false, error: 'ids must contain at least one task' });
        return true;
      }
      const targetIds = ids;
      for (const id of targetIds) {
        const task = store.tasks.get(id);
        if (task && ['parsed', 'failed', 'queued'].includes(task.status)) {
          await store.updateTask(id, {
            status: 'queued',
            progressText: '排队中',
            error: '',
            retryCount: 0,
            nextRetryAt: null,
          });
        }
      }
      scheduler.schedule();
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (url.pathname === '/api/cancel') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : [];
      let changed = 0;
      for (const id of ids) {
        const task = store.tasks.get(id);
        if (!task) continue;
        if (await scheduler.cancelTask(id)) {
          changed += 1;
          continue;
        }
        if (task.status === 'queued') {
          await store.updateTask(id, { status: 'parsed', progressText: '已取消排队，等待手动开始', error: '' });
          changed += 1;
        }
      }
      sendJson(res, 200, { ok: true, changed });
      return true;
    }

    if (url.pathname === '/api/delete') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : [];
      await scheduler.deleteTasks(ids);
      sendJson(res, 200, { ok: true });
      return true;
    }

    return false;
  };
}

module.exports = { TASK_QUERY_NAMES, TASK_STATUSES, createTaskRoutes, queryTasks };
