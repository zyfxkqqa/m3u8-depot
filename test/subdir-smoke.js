const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTaskStore } = require('../lib/task-store');
const { createScheduler } = require('../lib/scheduler');
const { createOutputManager } = require('../lib/output-manager');

function waitFor(predicate, timeoutMs = 3000, label = 'condition') {
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

async function run() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm3u8-subdir-'));
  try {
    const outputDir = path.join(root, 'output');
    const manager = createOutputManager(outputDir, { retryDelayMs: 1 });

    // 1. 无 subdir：单片（电影）落在根目录
    const movie = manager.reserve('独立电影', 'task-movie');
    assert.strictEqual(path.dirname(movie.finalPath), path.resolve(outputDir), '单片应落在输出根目录');

    // 2. 有 subdir：合集落在以剧名命名的子目录，且目录被自动创建
    const episode = manager.reserve('剧名 第01集', 'task-ep1', { subdir: '剧名' });
    assert.strictEqual(path.basename(path.dirname(episode.finalPath)), '剧名', '合集应落在子目录');
    assert.strictEqual(path.dirname(path.dirname(episode.finalPath)), path.resolve(outputDir));
    assert.ok(fs.existsSync(path.join(outputDir, '剧名')), '子目录应被自动创建');
    assert.ok(episode.partPath.startsWith(path.join(outputDir, '剧名')), '临时文件也应位于子目录');

    // 3. 子目录内同名仍走序号规则
    const duplicate = manager.reserve('剧名 第01集', 'task-ep1b', { subdir: '剧名' });
    assert.strictEqual(path.basename(duplicate.finalPath), '剧名 第01集 (2).mp4');

    // 4. 剧名含非法字符时被清洗为合法目录名
    const dirty = manager.reserve('x', 'task-dirty', { subdir: 'a/b:c*?' });
    assert.strictEqual(path.basename(path.dirname(dirty.finalPath)), 'a_b_c__');

    // 5. 空白 subdir 视为未指定
    const blank = manager.reserve('y', 'task-blank', { subdir: '   ' });
    assert.strictEqual(path.dirname(blank.finalPath), path.resolve(outputDir));

    // 6. 提交与清理在子目录内正常工作
    fs.writeFileSync(episode.partPath, 'video-bytes');
    await manager.commit(episode.partPath, episode.finalPath);
    assert.strictEqual(fs.readFileSync(episode.finalPath, 'utf8'), 'video-bytes');
    assert.ok(!fs.existsSync(episode.partPath), '提交后临时文件应消失');

    fs.writeFileSync(duplicate.partPath, 'partial');
    await manager.cleanupPart(duplicate.partPath, duplicate.partPath);
    assert.ok(!fs.existsSync(duplicate.partPath), '子目录内的临时文件应可清理');

    // 7. 调度端到端：batchId 决定是否建目录
    const schedOutput = path.join(root, 'sched-output');
    const store = createTaskStore({
      dataDir: path.join(root, 'data'),
      tasksFile: path.join(root, 'data', 'tasks.json'),
      outputDir: schedOutput,
      throttleMs: 5,
      retryDelayMs: 1,
    });
    await store.loadTasks();

    const runTask = async (task, options) => {
      fs.mkdirSync(path.dirname(options.partPath), { recursive: true });
      fs.writeFileSync(options.partPath, 'video');
    };
    const scheduler = createScheduler(store, {
      ffmpeg: 'ffmpeg',
      outputDir: schedOutput,
      maxActiveTasks: 4,
      runTask,
      manageOutput: true,
    });

    const soloTask = await store.commitParsedTask(
      { title: '单条电影', pageUrl: 'https://example.test/movie', m3u8Url: 'https://example.test/movie.m3u8' },
      { mode: 'direct' },
    );
    const batchTask = await store.commitParsedTask(
      { title: '剧集 第01集', pageUrl: 'https://example.test/ep1', m3u8Url: 'https://example.test/ep1.m3u8' },
      { mode: 'direct', batchId: 'batch-subdir', batchTitle: '剧集', batchLine: '线路一' },
    );

    scheduler.schedule();
    await waitFor(
      () => store.tasks.get(soloTask.id).status === 'done' && store.tasks.get(batchTask.id).status === 'done',
      5000,
      'subdir download',
    );

    const soloOutput = store.tasks.get(soloTask.id).output;
    const batchOutput = store.tasks.get(batchTask.id).output;
    assert.strictEqual(path.dirname(soloOutput), path.resolve(schedOutput), '无批次任务应落在根目录');
    assert.strictEqual(path.basename(path.dirname(batchOutput)), '剧集', '批次任务应落在剧名目录');
    assert.ok(fs.existsSync(batchOutput), '批次任务成品应存在');
    assert.ok(fs.existsSync(soloOutput), '单片成品应存在');

    // 8. batchTitle 缺失时退化为 batchLine
    const fallbackTask = await store.commitParsedTask(
      { title: '综艺 第02期', pageUrl: 'https://example.test/v2', m3u8Url: 'https://example.test/v2.m3u8' },
      { mode: 'direct', batchId: 'batch-fallback', batchLine: '备用线路' },
    );
    scheduler.schedule();
    await waitFor(() => store.tasks.get(fallbackTask.id).status === 'done', 5000, 'fallback download');
    assert.strictEqual(path.basename(path.dirname(store.tasks.get(fallbackTask.id).output)), '备用线路');

    await scheduler.stop({ cancelActive: false });
    await store.close();
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
  console.log('subdir-smoke-ok');
}

if (require.main === module) {
  run().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { run };
