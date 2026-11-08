const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

class FakeClassList {
  constructor() { this.values = new Set(); }
  toggle(name, enabled) { enabled ? this.values.add(name) : this.values.delete(name); }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.disabled = false;
    this.checked = false;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  async dispatch(type, event = {}) {
    const target = event.target || this;
    await Promise.all((this.listeners.get(type) || []).map(listener => listener({ target, ...event })));
  }
  click() { return this.dispatch('click'); }
  closest(selector) {
    if (selector.includes('data-filter') && this.dataset.filter) return this;
    if (selector.includes('data-action') && this.dataset.action) return this;
    if (selector.includes('data-task-check') && this.dataset.taskCheck) return this;
    return null;
  }
}

function createEnvironment(indexHtml) {
  const ids = [...indexHtml.matchAll(/id=["']([^"']+)["']/g)].map(match => match[1]);
  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  return {
    elements,
    documentObject: {
      querySelector: selector => elements.get(selector.replace(/^#/, '')) || null,
      querySelectorAll: () => [],
    },
    windowObject: { confirm: () => true },
  };
}

function nextTurn() { return new Promise(resolve => setImmediate(resolve)); }

async function run() {
  const projectRoot = path.resolve(__dirname, '..');
  const staticDir = path.join(projectRoot, 'static');
  const indexHtml = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
  const environment = createEnvironment(indexHtml);
  const previousDocument = global.document;
  const previousWindow = global.window;
  const unhandled = [];
  const onUnhandled = error => { unhandled.push(error); };
  global.document = environment.documentObject;
  global.window = environment.windowObject;
  process.on('unhandledRejection', onUnhandled);

  try {
    const stateModule = await import(pathToFileURL(path.join(staticDir, 'js', 'state.js')).href);
    const tasksModule = await import(`${pathToFileURL(path.join(staticDir, 'js', 'tasks.js')).href}?stage3-ui`);
    const { state } = stateModule;
    state.tasks = [
      { id: 'done-1', title: '完成任务', status: 'done', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'parsed-1', title: '待开始任务', status: 'parsed', createdAt: '2026-01-02T00:00:00Z' },
      { id: 'failed-1', title: '失败任务', status: 'failed', createdAt: '2026-01-03T00:00:00Z' },
    ];
    state.taskFilter = 'all';
    state.taskBatchFilter = 'all';
    state.taskPage = 1;
    state.taskPageSize = 20;
    state.selectedTasks = new Set(['parsed-1']);
    state.expandedTasks = new Set();

    let failure = '';
    const calls = [];
    const request = async (requestPath, options = {}) => {
      calls.push({ path: requestPath, body: JSON.parse(options.body) });
      if (failure) throw new Error(failure);
      return { ok: true };
    };
    const controller = { refreshNow: async () => {} };
    tasksModule.initTasks(controller, { request });
    tasksModule.renderTasks();

    const cases = [
      { id: 'clearDoneBtn', error: '清理完成失败' },
      { id: 'startSelectedTasksBtn', error: '开始选中失败' },
      { id: 'deleteSelectedTasksBtn', error: '删除选中失败' },
      { id: 'retryFailedTasksBtn', error: '重试失败任务失败' },
    ];
    for (const testCase of cases) {
      failure = testCase.error;
      const selectedBefore = [...state.selectedTasks];
      const button = environment.elements.get(testCase.id);
      await button.click();
      assert.strictEqual(environment.elements.get('taskMessage').textContent, testCase.error);
      assert.strictEqual(environment.elements.get('taskMessage').style.color, '#dc2626');
      assert.strictEqual(button.disabled, false, `${testCase.id} remained disabled`);
      assert.deepStrictEqual([...state.selectedTasks], selectedBefore, `${testCase.id} changed selection after failure`);
    }
    await nextTurn();
    assert.deepStrictEqual(unhandled, [], 'toolbar failures produced unhandled rejections');

    failure = '';
    await environment.elements.get('startSelectedTasksBtn').click();
    assert.strictEqual(environment.elements.get('taskMessage').textContent, '已提交 1 个任务。');
    assert.deepStrictEqual([...state.selectedTasks], ['parsed-1']);

    await environment.elements.get('deleteSelectedTasksBtn').click();
    assert.strictEqual(environment.elements.get('taskMessage').textContent, '已删除 1 个任务。');
    assert.deepStrictEqual([...state.selectedTasks], []);
    assert.strictEqual(calls.filter(call => call.path === '/api/start').length >= 2, true);
    assert.strictEqual(calls.some(call => call.path === '/api/delete'), true);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    global.document = previousDocument;
    global.window = previousWindow;
  }
}

let timeoutId;
Promise.race([
  run(),
  new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('stage3-ui-smoke timed out')), 7000); }),
]).then(() => {
  clearTimeout(timeoutId);
  console.log('stage3-ui-smoke-ok');
}).catch(error => {
  clearTimeout(timeoutId);
  console.error(error);
  process.exitCode = 1;
});
