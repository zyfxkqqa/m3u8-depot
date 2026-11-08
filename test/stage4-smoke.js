const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { createApplication, queryTasks } = require('../server');
const { createHealthRoutes } = require('../routes/health-routes');
const { createParseRoutes } = require('../routes/parse-routes');
const { createTaskRoutes } = require('../routes/task-routes');
const { sendJson } = require('../lib/http/respond');
const { readBody, readJsonBody } = require('../lib/http/request-body');
const { serveStatic } = require('../lib/http/static-files');
const sites = require('../lib/sites');
const common = require('../lib/sites/common-maccms');
const kxmp4 = require('../lib/sites/kxmp4');
const maliys = require('../lib/sites/maliys');
const playExtractor = require('../lib/play-extractor');
const detailExtractor = require('../lib/detail-extractor');

function request(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: requestPath }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function readFrontendGraph(staticDir) {
  const entry = path.join(staticDir, 'js', 'main.js');
  const graph = new Map();
  function visit(file) {
    if (graph.has(file)) return;
    const source = fs.readFileSync(file, 'utf8');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
    const dependencies = imports.filter(specifier => specifier.startsWith('.')).map(specifier => path.resolve(path.dirname(file), specifier));
    dependencies.forEach(dependency => assert.ok(fs.existsSync(dependency), `missing frontend import: ${dependency}`));
    graph.set(file, dependencies);
    dependencies.forEach(visit);
  }
  visit(entry);
  const visiting = new Set();
  const visited = new Set();
  function assertAcyclic(file) {
    if (visiting.has(file)) throw new Error(`frontend import cycle at ${file}`);
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file) || []) assertAcyclic(dependency);
    visiting.delete(file);
    visited.add(file);
  }
  assertAcyclic(entry);
  return graph;
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  toggle(name, enabled) { enabled ? this.values.add(name) : this.values.delete(name); }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.isConnected = true;
    this.parent = null;
    this.tabIndex = -1;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener));
  }
  listenerCount(type) { return (this.listeners.get(type) || []).length; }
  async dispatch(type, event = {}) {
    const target = event.target || this;
    await Promise.all((this.listeners.get(type) || []).map(listener => listener({ target, ...event })));
  }
  click() { return this.dispatch('click'); }
  focus() { global.document.activeElement = this; }
  contains(element) {
    for (let current = element; current; current = current.parent) {
      if (current === this) return true;
    }
    return false;
  }
  closest(selector) {
    if (selector === '[hidden]') {
      for (let current = this; current; current = current.parent) {
        if (current.hidden) return current;
      }
      return null;
    }
    if (selector.includes('data-filter') && this.dataset.filter) return this;
    if (selector.includes('data-action') && this.dataset.action) return this;
    if (selector.includes('data-line-index') && this.dataset.lineIndex !== undefined) return this;
    if (selector.includes('data-task-check') && this.dataset.taskCheck) return this;
    if (selector.includes('checkbox') && this.type === 'checkbox') return this;
    return null;
  }
}

function createFrontendEnvironment(indexHtml) {
  const ids = [...indexHtml.matchAll(/id=["']([^"']+)["']/g)].map(match => match[1]);
  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  const tabs = ['play', 'detail', 'tasks'].map(name => {
    const tab = new FakeElement(`${name}Tab`);
    tab.dataset.tab = name;
    tab.setAttribute('aria-controls', `${name}Panel`);
    return tab;
  });
  const modal = elements.get('duplicateModal');
  for (const id of ['directDownloadBtn', 'redownloadBtn', 'cancelDuplicateBtn']) {
    elements.get(id).parent = modal;
  }
  const documentListeners = new Map();
  const windowListeners = new Map();
  const documentObject = {
    readyState: 'loading',
    hidden: false,
    activeElement: null,
    querySelector: selector => elements.get(selector.replace(/^#/, '')) || null,
    querySelectorAll: selector => selector === '.tab' ? tabs : [],
    getElementById: id => elements.get(id) || null,
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(listener);
    },
  };
  const windowObject = {
    confirm: () => true,
    setTimeout,
    clearTimeout,
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(listener);
    },
  };
  return { elements, tabs, documentObject, windowObject, documentListeners, windowListeners };
}

function nextTurn() { return new Promise(resolve => setImmediate(resolve)); }

async function testFrontendBehavior(staticDir, indexHtml) {
  const environment = createFrontendEnvironment(indexHtml);
  global.document = environment.documentObject;
  global.window = environment.windowObject;
  try {
    const stateModule = await import(pathToFileURL(path.join(staticDir, 'js', 'state.js')).href);
    const mainModule = await import(`${pathToFileURL(path.join(staticDir, 'js', 'main.js')).href}?stage4`);
    const detailModule = await import(pathToFileURL(path.join(staticDir, 'js', 'detail.js')).href);
    const tasksModule = await import(pathToFileURL(path.join(staticDir, 'js', 'tasks.js')).href);
    const pollingModule = await import(pathToFileURL(path.join(staticDir, 'js', 'polling.mjs')).href);
    const calls = [];
    let scenario = 'play-direct';
    const request = async (requestPath, options = {}) => {
      calls.push({ path: requestPath, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      if (requestPath === '/api/sites') return { ok: true, sites: [] };
      if (requestPath === '/api/detail/parse') {
        return { ok: true, detail: { title: '详情标题', lines: [{ name: '线路一', episodes: [] }] } };
      }
      if (requestPath === '/api/parse/check') {
        if (scenario === 'play-no-duplicate') return { ok: true, items: [{ pageUrl: 'new' }], summary: { total: 1, duplicate: 0, failed: 0 } };
        return { ok: true, items: [{ pageUrl: 'new' }, { pageUrl: 'duplicate', duplicate: true }], summary: { total: 2, duplicate: 1, failed: 0 } };
      }
      if (requestPath === '/api/parse/commit') return { ok: true, results: [{ id: 'created' }], startIds: ['created'] };
      if (requestPath === '/api/start') return { ok: true };
      if (requestPath === '/api/delete') return { ok: true };
      if (requestPath === '/api/cancel') return { ok: true };
      throw new Error(`unexpected request: ${requestPath}`);
    };
    const pollingController = {
      starts: 0, refreshes: 0,
      start() { this.starts += 1; return Promise.resolve(); },
      stop() {}, reschedule() {},
      refreshNow() { this.refreshes += 1; return Promise.resolve(); },
    };
    const app = mainModule.initApp({ request, pollingController });
    assert.strictEqual(mainModule.initApp({ request, pollingController }), app);
    assert.strictEqual(environment.elements.get('parseBtn').listenerCount('click'), 1);
    assert.strictEqual(environment.elements.get('directDownloadBtn').listenerCount('click'), 1);
    assert.strictEqual(environment.elements.get('redownloadBtn').listenerCount('click'), 1);
    assert.strictEqual(pollingController.starts, 1);

    assert.match(indexHtml, /<textarea\b[^>]*\bid="detailUrlInput"/);
    const detailUrl = 'https://www.kxmp4.com/detail/378301.html';
    environment.elements.get('detailUrlInput').value = `  \n${detailUrl}\r\n  `;
    await environment.elements.get('parseDetailBtn').click();
    assert.deepStrictEqual(calls.filter(call => call.path === '/api/detail/parse').at(-1), {
      path: '/api/detail/parse',
      method: 'POST',
      body: { url: detailUrl },
    });

    environment.elements.get('urlInput').value = 'https://www.kxmp4.com/play/1.html';
    let action = app.playPage.parseUrls();
    await nextTurn();
    await environment.elements.get('directDownloadBtn').click();
    await action;
    assert.deepStrictEqual(
      calls.filter(call => call.path.startsWith('/api/parse/')).slice(0, 2).map(call => call.path),
      ['/api/parse/check', '/api/parse/commit'],
    );
    assert.strictEqual(calls.find(call => call.path === '/api/parse/commit').body.mode, 'direct');
    assert.strictEqual(calls.some(call => call.path === '/api/parse'), false);
    assert.strictEqual(environment.elements.get('tasksPanel').classList.contains('active'), true);

    scenario = 'play-redownload';
    action = app.playPage.parseUrls();
    await nextTurn();
    await environment.elements.get('redownloadBtn').click();
    await action;
    assert.strictEqual(calls.filter(call => call.path === '/api/parse/commit').at(-1).body.mode, 'redownload');

    const commitsBeforeCancel = calls.filter(call => call.path === '/api/parse/commit').length;
    action = app.playPage.parseUrls();
    await nextTurn();
    await environment.elements.get('cancelDuplicateBtn').click();
    await action;
    assert.strictEqual(calls.filter(call => call.path === '/api/parse/commit').length, commitsBeforeCancel);

    scenario = 'play-no-duplicate';
    await app.playPage.parseUrls();
    assert.strictEqual(calls.filter(call => call.path === '/api/parse/commit').at(-1).body.mode, 'direct');

    scenario = 'detail-shared-dialog';
    stateModule.state.detail = { title: '详情标题', lines: [{ name: '线路一', episodes: [{ name: '第1集', url: 'https://example/1' }] }] };
    stateModule.state.activeLineIndex = 0;
    stateModule.state.selectedEpisodes = new Set(['https://example/1']);
    action = detailModule.downloadSelectedEpisodes();
    await nextTurn();
    await environment.elements.get('redownloadBtn').click();
    await action;
    const detailCommit = calls.filter(call => call.path === '/api/parse/commit').at(-1);
    assert.strictEqual(detailCommit.body.mode, 'redownload');
    assert.deepStrictEqual(detailCommit.body.batch, { title: '详情标题', line: '线路一' });
    assert.strictEqual(environment.elements.get('directDownloadBtn').listenerCount('click'), 1, 'shared dialog rebound listeners');

    stateModule.state.tasks = [
      { id: 'render-stalled', title: '渲染卡住任务', status: 'failed', error: 'FFmpeg stalled: no media time' },
      { id: 'render-failed', title: '渲染普通失败任务', status: 'failed', error: '下载失败' },
      { id: 'render-running', title: '渲染运行任务', status: 'running', progressText: 'time=00:01:02.00 speed=1x', error: 'stalled warning' },
      { id: 'render-retrying', title: '渲染重试任务', status: 'retrying', progressText: '下载失败，5 秒后进行第 1 次重试', error: 'stalled warning' },
    ];
    tasksModule.renderTasks();
    const taskListHtml = environment.elements.get('taskList').innerHTML;
    assert.match(taskListHtml, /源线路长时间无进度/);
    assert.match(taskListHtml, /失败/);
    assert.match(taskListHtml, /已处理.*1x/);
    assert.match(taskListHtml, /下载失败，5 秒后进行第 1 次重试/);

    stateModule.state.tasks = [
      { id: 'failed-1', title: '失败任务', status: 'failed', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'done-1', title: '完成任务', status: 'done', createdAt: '2026-01-02T00:00:00Z' },
    ];
    stateModule.state.selectedTasks = new Set(['failed-1']);
    const filterButton = new FakeElement('failed-filter');
    filterButton.dataset.filter = 'failed';
    filterButton.textContent = '失败 1';
    await environment.elements.get('taskSummary').dispatch('click', { target: filterButton });
    assert.strictEqual(stateModule.state.taskFilter, 'failed');
    await environment.elements.get('startSelectedTasksBtn').click();
    const startCall = calls.filter(call => call.path === '/api/start').at(-1);
    assert.deepStrictEqual(startCall.body.ids, ['failed-1']);
    await environment.elements.get('deleteSelectedTasksBtn').click();
    const deleteCall = calls.filter(call => call.path === '/api/delete').at(-1);
    assert.deepStrictEqual(deleteCall.body.ids, ['failed-1']);

    const oldGate = deferred();
    const newGate = deferred();
    const commits = [];
    const timers = new Map();
    let timerId = 0;
    let refreshIndex = 0;
    const controller = pollingModule.createPollingController({
      refresh: async context => {
        refreshIndex += 1;
        const value = refreshIndex === 1 ? await oldGate.promise : await newGate.promise;
        if (context.isCurrent()) commits.push(value);
      },
      getTasks: () => [], isHidden: () => false,
      setTimeoutFn: callback => { const id = ++timerId; timers.set(id, callback); return id; },
      clearTimeoutFn: id => timers.delete(id),
    });
    const oldRefresh = controller.start();
    await nextTurn();
    controller.stop();
    const newRefresh = controller.start();
    await nextTurn();
    newGate.resolve('new');
    await newRefresh;
    oldGate.resolve('old');
    await oldRefresh;
    assert.deepStrictEqual(commits, ['new']);
    assert.strictEqual(timers.size, 1);
    controller.stop();
  } finally {
    delete global.document;
    delete global.window;
  }
}

async function run() {
  assert.strictEqual(typeof createHealthRoutes, 'function');
  assert.strictEqual(typeof createParseRoutes, 'function');
  assert.strictEqual(typeof createTaskRoutes, 'function');
  assert.strictEqual(typeof queryTasks, 'function');
  assert.strictEqual(typeof sendJson, 'function');
  assert.strictEqual(typeof readBody, 'function');
  assert.strictEqual(typeof readJsonBody, 'function');
  assert.strictEqual(typeof serveStatic, 'function');
  assert.deepStrictEqual(Object.keys(playExtractor).sort(), ['decodePlayerUrl', 'extractM3u8', 'extractTitle', 'parsePlayPage', 'parsePlayerData'].sort());
  assert.deepStrictEqual(Object.keys(detailExtractor).sort(), ['extractDetailTitle', 'extractPlayLines', 'parseDetailPage'].sort());

  const kxPlayHtml = `
    <html><head><title>备用标题</title></head><body>
      <h1 class="title"><a>示例影片</a><span class="data2">第2集</span></h1>
      <script>var player_data = {"url":"https://cdn.example/kx-2.m3u8","encrypt":0}</script>
    </body></html>`;
  const kxPlay = kxmp4.parsePlay(kxPlayHtml, 'https://www.kxmp4.com/play/100-1-2.html');
  assert.strictEqual(kxPlay.title, '示例影片 第2集');
  assert.strictEqual(kxPlay.titleSource, 'h1.title');
  assert.strictEqual(kxPlay.m3u8Url, 'https://cdn.example/kx-2.m3u8');
  assert.strictEqual(kxPlay.m3u8Source, 'player_data.url');

  const encodedM3u8 = Buffer.from('https://cdn.example/mali-1.m3u8').toString('base64');
  const maliPlayHtml = `<html><script>var player_data={"url":"${encodedM3u8}","encrypt":2,"nid":1,"vod_data":{"vod_name":"马里示例"}}</script></html>`;
  const maliPlay = maliys.parsePlay(maliPlayHtml, 'https://www.maliys.com/yun/200-4-1.html');
  assert.strictEqual(maliPlay.title, '马里示例 第01集');
  assert.strictEqual(maliPlay.titleSource, 'player_data');
  assert.strictEqual(maliPlay.m3u8Url, 'https://cdn.example/mali-1.m3u8');

  const kxDetailHtml = `
    <div class="stui-content__detail"><h1 class="title">示例详情</h1></div>
    <div class="stui-vodlist__head"><h4>线路一</h4><ul class="stui-content__playlist">
      <a href="/play/100-1-1.html">第1集</a><a href="/play/100-1-2.html">第2集</a>
    </ul></div>`;
  const kxDetail = kxmp4.parseDetail(kxDetailHtml, 'https://www.kxmp4.com/detail/100.html');
  assert.strictEqual(kxDetail.title, '示例详情');
  assert.strictEqual(kxDetail.lines[0].name, '线路一');
  assert.deepStrictEqual(kxDetail.lines[0].episodes.map(item => item.url), [
    'https://www.kxmp4.com/play/100-1-1.html',
    'https://www.kxmp4.com/play/100-1-2.html',
  ]);

  const maliDetailHtml = `
    <h1 class="title">马里详情</h1>
    <div class="stui-vodlist__head"><span class="pull-right1">云播线路</span><ul class="stui-content__playlist">
      <a href="/yun/200-4-1.html">第1集</a><a href="/yun/200-4-1.html">重复第1集</a>
    </ul></div>`;
  const maliDetail = maliys.parseDetail(maliDetailHtml, 'https://www.maliys.com/html/200.html');
  assert.strictEqual(maliDetail.title, '马里详情');
  assert.strictEqual(maliDetail.lines[0].name, '云播线路');
  assert.strictEqual(maliDetail.lines[0].episodes.length, 1);
  assert.strictEqual(sites.getSiteAdapter('https://www.kxmp4.com/play/1.html').id, 'kxmp4');
  assert.strictEqual(sites.getSiteAdapter('https://www.maliys.com/yun/1.html').id, 'maliys');
  assert.strictEqual(sites.getSiteAdapter('https://compatible.example/play/1.html').id, 'common-maccms');
  assert.strictEqual(common.extractTitle(kxPlayHtml, common.parsePlayerData(kxPlayHtml)).source, 'h1.title');

  const staticDir = path.join(__dirname, '..', 'static');
  const indexHtml = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
  const scripts = [...indexHtml.matchAll(/<script\b([^>]*)>/gi)].map(match => match[1]);
  assert.strictEqual(scripts.length, 1);
  assert.match(scripts[0], /type=["']module["']/i);
  assert.match(scripts[0], /src=["']\/js\/main\.js["']/i);
  assert.doesNotMatch(indexHtml, /src=["']\/(?:app|polling)\.js["']/i);
  assert.strictEqual(fs.existsSync(path.join(staticDir, 'app.js')), false);
  const frontendGraph = readFrontendGraph(staticDir);
  assert.strictEqual(frontendGraph.size, 9);
  assert.ok(frontendGraph.has(path.join(staticDir, 'js', 'sites.js')));
  await testFrontendBehavior(staticDir, indexHtml);

  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm3u8-stage4-'));
  const config = {
    HOST: '127.0.0.1', PORT: 0, ROOT_DIR: root, STATIC_DIR: staticDir,
    DATA_DIR: path.join(root, 'data'), TASKS_FILE: path.join(root, 'data', 'tasks.json'), OUTPUT_DIR: path.join(root, 'output'),
    FFMPEG: path.join(root, 'missing-ffmpeg.exe'), USER_AGENT: 'stage4-smoke', MAX_ACTIVE_TASKS: 1, PARSE_CONCURRENCY: 2,
  };
  const app = createApplication(config, { runtimeLogger: { log: () => {}, close: async () => {} } });
  try {
    const address = await app.start();
    const health = await request(address.port, '/api/health');
    assert.strictEqual(health.status, 200);
    assert.deepStrictEqual(Object.keys(JSON.parse(health.body)).sort(), ['ffmpeg', 'ffmpegExists', 'maxActiveTasks', 'ok', 'outputDir', 'port', 'version'].sort());
    const tasks = await request(address.port, '/api/tasks');
    assert.strictEqual(tasks.status, 200);
    assert.deepStrictEqual(JSON.parse(tasks.body), { ok: true, tasks: [] });
    const paged = await request(address.port, '/api/tasks?page=1&pageSize=20');
    assert.strictEqual(paged.status, 200);
    assert.deepStrictEqual(Object.keys(JSON.parse(paged.body)).sort(), ['ok', 'page', 'pageSize', 'statusCounts', 'tasks', 'total'].sort());
    const frontend = await request(address.port, '/js/main.js');
    assert.strictEqual(frontend.status, 200);
    assert.match(frontend.headers['content-type'], /^text\/javascript/);
  } finally {
    await app.close();
    await fs.promises.rm(root, { recursive: true, force: true });
  }

  console.log('stage4-smoke-ok');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
