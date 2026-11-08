const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const packageJson = require('../package.json');
const { VERSION } = require('../lib/version');
const defaultConfig = require('../lib/config');
const { createApplication } = require('../server');
const { runCommand } = require('./run-all');

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

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

async function waitForProcessesGone(pids, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = pids.filter(processExists);
    if (remaining.length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const remaining = pids.filter(processExists);
  if (remaining.length) throw new Error(`processes did not exit within ${timeoutMs}ms: ${remaining.join(', ')}`);
}

async function terminateProcesses(pids) {
  const livePids = [...new Set(pids.filter(pid => pid && processExists(pid)))];
  for (const pid of livePids) {
    if (!processExists(pid)) continue;
    if (process.platform === 'win32') {
      await runCommand({
        name: `stage5-cleanup-${pid}`,
        command: 'taskkill',
        args: ['/PID', String(pid), '/T', '/F'],
        stdio: 'ignore',
        timeoutMs: 2000,
        cleanupTimeoutMs: 1000,
      }).catch(() => {});
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  await waitForProcessesGone(livePids, 3000);
}

async function withHardTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForFile(filePath, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.promises.readFile(filePath, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function run() {
  const projectRoot = path.resolve(__dirname, '..');
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm3u8-stage5-'));
  let app = null;
  let timeoutPids = null;
  try {
  assert.strictEqual(packageJson.version, '1.3.0');
  assert.strictEqual(packageJson.private, undefined);
  assert.strictEqual(packageJson.license, 'MIT');
  assert.strictEqual(VERSION, packageJson.version);
  assert.deepStrictEqual(Object.keys(packageJson.scripts).sort(), ['check', 'smoke', 'start', 'test']);
  assert.strictEqual(packageJson.dependencies, undefined);

  assert.strictEqual(defaultConfig.HOST, '127.0.0.1');
  assert.strictEqual(defaultConfig.PORT, 17892);
  assert.strictEqual(defaultConfig.OUTPUT_DIR, path.join(os.homedir(), 'Downloads', 'M3U8'));
  assert.match(path.basename(defaultConfig.FFMPEG), /^ffmpeg(\.exe)?$/);
  assert.strictEqual(defaultConfig.TASKS_FILE, path.join(projectRoot, 'data', 'tasks.json'));

  const indexHtml = await fs.promises.readFile(path.join(projectRoot, 'static', 'index.html'), 'utf8');
  assert.match(indexHtml, /id=["']versionText["']/);
  assert.match(indexHtml, /<script type=["']module["'] src=["']\/js\/main\.js["']><\/script>/);
  const tasksSource = await fs.promises.readFile(path.join(projectRoot, 'static', 'js', 'tasks.js'), 'utf8');
  assert.match(tasksSource, /state\.health\.version/);
  assert.match(tasksSource, /`v\$\{state\.health\.version\}`/);

  const startScript = await fs.promises.readFile(path.join(projectRoot, 'start.bat'), 'utf8');
  assert.match(startScript, /if not defined M3U8_DOWNLOADER_PORT set "M3U8_DOWNLOADER_PORT=17892"/);
  assert.match(startScript, /if exist "%~dp0env\.local\.bat" call "%~dp0env\.local\.bat"/);
  assert.match(startScript, /where node/);
  assert.match(startScript, /set NO_PROXY=\*/);
  assert.match(startScript, /"%NODE_EXE%" "%~dp0server\.js"/);
  // 开源版本不得内置任何盘符绝对路径
  assert.doesNotMatch(startScript, /[A-Za-z]:\\/, 'start.bat must not hardcode drive-letter paths');
  assert.ok(!fs.existsSync(path.join(projectRoot, 'start-downloader.cmd')), 'redundant launcher should be removed');


  // 启动脚本的路径探测已改为 where node + config.js 默认值，
  // 不再依赖 NODE_EXE 环境变量注入，相关行为测试由下方应用启动覆盖。


  const runtimeConfig = {
    HOST: '127.0.0.1', PORT: 0, ROOT_DIR: root, STATIC_DIR: path.join(projectRoot, 'static'),
    DATA_DIR: path.join(root, 'data'), TASKS_FILE: path.join(root, 'data', 'tasks.json'), OUTPUT_DIR: path.join(root, 'output'),
    FFMPEG: path.join(root, 'missing-ffmpeg.exe'), USER_AGENT: 'stage5-smoke', MAX_ACTIVE_TASKS: 1, PARSE_CONCURRENCY: 2,
  };
  app = createApplication(runtimeConfig, { runtimeLogger: { log: () => {}, close: async () => {} } });
  {
    const address = await app.start();
    const healthResponse = await request(address.port, '/api/health');
    assert.strictEqual(healthResponse.status, 200);
    const health = JSON.parse(healthResponse.body);
    assert.strictEqual(health.version, VERSION);
    assert.strictEqual(health.port, 0);
    assert.strictEqual(health.outputDir, runtimeConfig.OUTPUT_DIR);
    const tasks = await request(address.port, '/api/tasks');
    assert.deepStrictEqual(JSON.parse(tasks.body), { ok: true, tasks: [] });
    const index = await request(address.port, '/');
    assert.strictEqual(index.status, 200);
    assert.match(index.body, /id="versionText"/);
    const main = await request(address.port, '/js/main.js');
    assert.strictEqual(main.status, 200);
    assert.match(main.headers['content-type'], /^text\/javascript/);
    const polling = await request(address.port, '/js/polling.mjs');
    assert.strictEqual(polling.status, 200);
    assert.match(polling.headers['content-type'], /^text\/javascript/);
  }
  await app.close();
  assert.strictEqual(app.server.listening, false);

  const pidFile = path.join(root, 'timeout-pids.json');
  let timeoutError = null;
  const timeoutRun = runCommand({
    name: 'timeout-fixture',
    command: process.execPath,
    args: ['test/fixtures/run-all-timeout-child.js'],
    cwd: projectRoot,
    env: {
      ...process.env,
      RUN_ALL_TIMEOUT_PID_FILE: pidFile,
    },
    stdio: 'ignore',
    timeoutMs: 300,
    cleanupTimeoutMs: 4000,
  }).catch(error => { timeoutError = error; });
  timeoutPids = await waitForFile(pidFile);
  await withHardTimeout(timeoutRun, 15000, 'timeout fixture test exceeded 15000ms');
  assert.ok(timeoutError);
  assert.match(timeoutError.message, /timed out after 300ms; process closed/);
  await waitForProcessesGone([timeoutPids.parentPid, timeoutPids.childPid]);
  assert.strictEqual(processExists(timeoutPids.parentPid), false, `timeout parent still running: ${timeoutPids.parentPid}`);
  assert.strictEqual(processExists(timeoutPids.childPid), false, `timeout child still running: ${timeoutPids.childPid}`);

  const staticPackage = JSON.parse(await fs.promises.readFile(path.join(projectRoot, 'static', 'js', 'package.json'), 'utf8'));
  assert.deepStrictEqual(staticPackage, { type: 'module' });
  console.log('stage5-smoke-ok');
  } finally {
    if (app) await app.close();
    if (timeoutPids) {
      await terminateProcesses([timeoutPids.parentPid, timeoutPids.childPid]);
      if (processExists(timeoutPids.parentPid)) throw new Error(`timeout parent still running during cleanup: ${timeoutPids.parentPid}`);
      if (processExists(timeoutPids.childPid)) throw new Error(`timeout child still running during cleanup: ${timeoutPids.childPid}`);
    }
    await fs.promises.rm(root, { recursive: true, force: true });
    if (fs.existsSync(root)) throw new Error(`stage5 temporary directory was not removed: ${root}`);
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
