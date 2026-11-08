const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { sanitizeFileName } = require('./text');
const n3u8 = require('./n3u8-engine');

class TaskCancelledError extends Error {
  constructor(message = 'Task cancelled') {
    super(message);
    this.name = 'TaskCancelledError';
    this.code = 'TASK_CANCELLED';
  }
}

function cancellationError(signal) {
  if (signal?.reason?.code === 'TASK_CANCELLED') return signal.reason;
  return new TaskCancelledError();
}

function classifyFfmpegFailure(stderr, code) {
  const text = String(stderr || '');
  const permanent = /(invalid data|invalid argument|unsupported|not supported|unknown encoder|encoder .* not found|decoder .* not found|permission denied|operation not permitted|unrecognized option|option .* not found|error parsing options|no such filter)/i;
  const transient = /(connection (?:timed out|timeout|reset by peer|reset|refused)|network is unreachable|no route to host|temporary failure in name resolution|server returned (?:408|425|429|500|502|503|504)(?!\d)|http error (?:408|425|429|500|502|503|504)(?!\d)|http status (?:408|425|429|500|502|503|504)(?!\d)|tls[^\r\n]*(?:remote (?:peer|host|server)[^\r\n]*(?:closed|reset)|handshake[^\r\n]*(?:timed out|timeout)))/i;
  const error = new Error((text || `ffmpeg exited with code ${code}`).slice(-4000));
  if (permanent.test(text)) error.code = 'FFMPEG_PERMANENT';
  else if (transient.test(text)) error.code = 'FFMPEG_TRANSIENT';
  else error.code = 'FFMPEG_FAILED';
  return error;
}

function parseMediaTime(value) {
  const match = String(value || '').match(/^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/);
  if (!match) return null;
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
}

function createStalledError(engine, hasProgress, timeoutMs, lastValue) {
  let phase;
  if (!hasProgress) {
    phase = 'no progress was produced';
  } else if (engine === 'n3u8') {
    phase = `segment count stopped at ${lastValue}`;
  } else {
    phase = `media time stopped at ${lastValue.toFixed(2)} seconds`;
  }
  const error = new Error(`${engine === 'n3u8' ? 'Downloader' : 'FFmpeg'} stalled: ${phase} for ${timeoutMs}ms`);
  error.code = 'FFMPEG_STALLED';
  return error;
}

function uniqueOutputPath(outputDir, title) {
  const base = sanitizeFileName(title);
  let output = path.join(outputDir, `${base}.mp4`);
  if (!fs.existsSync(output)) return output;
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  output = path.join(outputDir, `${base}_${stamp}.mp4`);
  if (!fs.existsSync(output)) return output;
  return path.join(outputDir, `${base}_${stamp}_${crypto.randomUUID().slice(0, 8)}.mp4`);
}

function buildFfmpegArgs(task, options, output) {
  const headers = `User-Agent: ${options.userAgent}\r\nReferer: ${task.pageUrl}\r\nOrigin: ${new URL(task.pageUrl).origin}\r\n`;
  return [
    '-hide_banner',
    '-y',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-headers', headers,
    '-rw_timeout', String(options.rwTimeout ?? 15000000),
    '-reconnect', String(options.reconnect ?? 1),
    '-reconnect_streamed', String(options.reconnectStreamed ?? 1),
    '-reconnect_on_network_error', String(options.reconnectOnNetworkError ?? 1),
    '-reconnect_delay_max', String(options.reconnectDelayMax ?? 5),
    '-reconnect_max_retries', String(options.reconnectMaxRetries ?? 2),
    '-reconnect_delay_total_max', String(options.reconnectDelayTotalMax ?? 15),
    '-i', task.m3u8Url,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    output,
  ];
}

// 转封装：把引擎合并出的 .ts 无损封装为 .mp4。
// 不加 -movflags +faststart：对 1 GB 级文件会额外重写一遍全文件（实测多耗 30 秒以上），
// 本地播放器不依赖 moov 前置。
function buildRemuxArgs(options, output) {
  return [
    '-hide_banner',
    '-y',
    '-i', options.remuxInput,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    output,
  ];
}

// N_m3u8DL-RE 会在 save-name 基础上补扩展名。正常情况与 output 完全一致，
// 这里保留一次兜底查找，避免上游版本改变命名规则时把成品当成失败。
function resolveProducedFile(output) {
  if (fs.existsSync(output)) return output;
  const withExtension = `${output}.mp4`;
  if (fs.existsSync(withExtension)) return withExtension;
  return null;
}

// 所有子进程一律直连：清空代理环境变量并显式声明 NO_PROXY，
// 避免外部 shell 或系统配置把下载流量导向代理（代理节点通常限速且易断流）。
function directEnv() {
  const env = { ...process.env };
  for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    delete env[key];
  }
  env.NO_PROXY = '*';
  env.no_proxy = '*';
  return env;
}

async function runFfmpegTask(task, options, onUpdate, signal) {
  const engine = options.engine === 'n3u8'
    ? 'n3u8'
    : (options.engine === 'remux' ? 'remux' : 'ffmpeg');
  const output = options.partPath || uniqueOutputPath(options.outputDir, task.title);
  const command = engine === 'n3u8' ? options.n3u8dl : options.ffmpeg;
  const args = engine === 'n3u8'
    ? n3u8.buildArgs(task, options, output)
    : (engine === 'remux' ? buildRemuxArgs(options, output) : buildFfmpegArgs(task, options, output));

  if (signal?.aborted) throw cancellationError(signal);
  await onUpdate(task.id, {
    status: 'running',
    output: options.finalPath || task.output || '',
    // 任务记录只保存最终的 .part.mp4；.ts 等中间产物不落进记录，
    // 否则恢复流程会因路径校验不认识该后缀而拒绝清理。
    partPath: options.recordPartPath || output,
    progressText: engine === 'n3u8'
      ? '启动多线程下载...'
      : (engine === 'remux' ? '正在转封装为 MP4...' : '启动 FFmpeg...'),
    startedAt: engine === 'n3u8' ? new Date().toISOString() : task.startedAt,
    error: '',
  });
  if (signal?.aborted) throw cancellationError(signal);

  return new Promise((resolve, reject) => {
    const spawnProcess = options.spawnProcess || spawn;
    let child = null;
    let childClosed = false;
    let spawnInProgress = false;
    let terminationStage = 0;
    let terminationTimer = null;
    let forceSettleTimer = null;
    let settled = false;
    let terminalError = null;
    let stderrTail = '';
    let stdoutTail = '';
    let progressRecordTail = '';
    let updateTail = Promise.resolve();
    let watchdogTimer = null;
    let progressPollTimer = null;
    let hasProgress = false;
    let lastProgressValue = null;
    let lastProgressAt = Date.now();

    function stopWatchdog() {
      if (!watchdogTimer) return;
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }

    function stopProgressPoll() {
      if (!progressPollTimer) return;
      clearInterval(progressPollTimer);
      progressPollTimer = null;
    }

    function cleanup() {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      stopWatchdog();
      stopProgressPoll();
      if (task.process === child) task.process = null;
    }

    function settleResolve() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }

    function settleReject(error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function killChild(signalName) {
      if (!child || childClosed || typeof child.kill !== 'function') return;
      try {
        child.kill(signalName);
      } catch (error) {
        if (!terminalError) terminalError = error;
      }
    }

    function requestTermination(error) {
      if (!terminalError) terminalError = error;
      stopWatchdog();
      if (spawnInProgress) return;
      if (!child || childClosed) {
        settleReject(terminalError);
        return;
      }
      if (terminationStage === 0) {
        terminationStage = 1;
        killChild('SIGTERM');
        const graceMs = options.terminationGraceMs ?? 1000;
        terminationTimer = setTimeout(() => {
          if (settled || childClosed) return;
          terminationStage = 2;
          killChild('SIGKILL');
        }, graceMs);
        const forceSettleMs = options.terminationForceSettleMs ?? Math.max(graceMs + 1000, 2000);
        forceSettleTimer = setTimeout(() => {
          if (!settled) settleReject(terminalError);
        }, forceSettleMs);
      }
    }

    function onAbort() {
      const error = cancellationError(signal);
      terminalError = error;
      requestTermination(error);
    }

    function noteProgress(value) {
      if (value === null || !Number.isFinite(value)) return;
      if (lastProgressValue === null || value > lastProgressValue) {
        hasProgress = true;
        lastProgressValue = value;
        lastProgressAt = Date.now();
      }
    }

    function processProgressRecord(record) {
      if (engine === 'n3u8') {
        // 进度以临时目录实际落盘量为准（见 startProgressPoll），
        // 这里只用于兜底：万一输出没有被缓冲，仍可刷新一次文案。
        const progress = n3u8.parseProgress(record);
        if (!progress || hasProgress) return;
        noteProgress(progress.segmentsDone);
        queueUpdate({ progressText: progress.progressText }, { persistence: 'throttled' });
        return;
      }

      const times = [...record.matchAll(/time=([^\s]+)/g)].map(match => match[1]);
      for (const time of times) {
        noteProgress(parseMediaTime(time));
      }

      const time = times.at(-1);
      const speed = [...record.matchAll(/speed=([^\s]+)/g)].at(-1)?.[1];
      const size = [...record.matchAll(/size=\s*([^\s]+\s*kB)/g)].at(-1)?.[1];
      const progressText = [time ? `time=${time}` : '', size ? `size=${size}` : '', speed ? `speed=${speed}` : ''].filter(Boolean).join('  ');
      if (progressText) queueUpdate({ progressText }, { persistence: 'throttled' });
    }

    function scanProgressTail() {
      if (engine === 'n3u8') return;
      for (const match of progressRecordTail.matchAll(/time=(\d+:[0-5]\d:[0-5]\d\.\d{2})(?=\s|$)/g)) {
        noteProgress(parseMediaTime(match[1]));
      }
    }

    function consumeProgressRecords(text, flush = false) {
      const records = `${progressRecordTail}${text}`.split(/\r\n|\r|\n/);
      progressRecordTail = flush ? '' : records.pop();
      if (progressRecordTail.length > 12000) progressRecordTail = progressRecordTail.slice(-12000);
      for (const record of records) processProgressRecord(record);
      if (!flush) scanProgressTail();
    }

    function startWatchdog() {
      // 多线程引擎要先解析整份播放列表再开下，且末尾要调 ffmpeg 封装，
      // 两段都没有新分片落盘，因此超时阈值比 FFmpeg 单连接宽。
      const initialProgressTimeoutMs = options.initialProgressTimeoutMs ?? (engine === 'n3u8' ? 60000 : 30000);
      const stallTimeoutMs = options.stallTimeoutMs ?? (engine === 'n3u8' ? 180000 : 60000);
      const stallCheckIntervalMs = options.stallCheckIntervalMs ?? 1000;
      watchdogTimer = setInterval(() => {
        if (settled || terminalError || signal?.aborted) return;
        const timeoutMs = hasProgress ? stallTimeoutMs : initialProgressTimeoutMs;
        if (Date.now() - lastProgressAt < timeoutMs) return;
        requestTermination(createStalledError(engine, hasProgress, timeoutMs, lastProgressValue));
      }, stallCheckIntervalMs);
    }

    function startProgressPoll() {
      if (engine !== 'n3u8') return;
      progressPollTimer = setInterval(() => {
        if (settled || terminalError) return;
        const { bytes, segments } = n3u8.measureTmp(options, task);
        if (bytes <= 0) return;
        noteProgress(bytes);
        const text = `已下载 ${n3u8.formatBytes(bytes)}${segments > 0 ? ` · ${segments} 个分片` : ''}`;
        queueUpdate({ progressText: text }, { persistence: 'throttled' });
      }, 2000);
      progressPollTimer.unref?.();
    }

    function queueUpdate(patch, updateOptions, terminal = false) {
      updateTail = updateTail.then(async () => {
        if (settled || terminalError) return;
        try {
          await onUpdate(task.id, patch, updateOptions);
          if (terminal) settleResolve();
        } catch (error) {
          requestTermination(error);
        }
      });
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    try {
      spawnInProgress = true;
      child = spawnProcess(command, args, { windowsHide: true, env: directEnv() });
      task.process = child;
      spawnInProgress = false;
      startWatchdog();
      startProgressPoll();
    } catch (error) {
      spawnInProgress = false;
      settleReject(signal?.aborted ? cancellationError(signal) : error);
      return;
    }

    // N_m3u8DL-RE 把进度写 stdout，ffmpeg 写 stderr，两条流都送进解析器。
    // 中文提示按 utf8 解码会乱码，但进度数字与错误关键字均为 ASCII，不影响判定。
    child.stdout?.on('data', chunk => {
      if (settled || terminalError) return;
      const text = chunk.toString('utf8');
      stdoutTail = (stdoutTail + text).slice(-12000);
      consumeProgressRecords(text);
    });

    child.stderr?.on('data', chunk => {
      if (settled || terminalError) return;
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-12000);
      consumeProgressRecords(text);
    });

    child.on('error', error => {
      childClosed = true;
      stopWatchdog();
      settleReject(signal?.aborted ? cancellationError(signal) : terminalError || error);
    });

    child.on('close', code => {
      childClosed = true;
      stopWatchdog();
      if (settled) return;
      if (terminalError) {
        settleReject(terminalError);
        return;
      }
      if (signal?.aborted) {
        settleReject(cancellationError(signal));
        return;
      }
      if (progressRecordTail) consumeProgressRecords('', true);
      const produced = code === 0
        ? (engine === 'n3u8' ? n3u8.findOutput(options, task, output) : resolveProducedFile(output))
        : null;
      if (produced && fs.statSync(produced).size > 0) {
        if (produced !== output) fs.renameSync(produced, output);
        if (options.deferCompletion) {
          settleResolve();
        } else {
          queueUpdate({
            status: 'done',
            progressText: '完成',
            completedAt: new Date().toISOString(),
            outputSize: fs.statSync(output).size,
          }, undefined, true);
        }
      } else {
        const detail = engine === 'n3u8' ? (stderrTail || stdoutTail) : stderrTail;
        settleReject(engine === 'n3u8' ? n3u8.classifyFailure(detail, code) : classifyFfmpegFailure(detail, code));
      }
    });

    // Abort can happen synchronously inside a custom spawn implementation.
    // The listener is installed before spawn, and this check covers the point
    // immediately after the child becomes killable.
    if (signal?.aborted || terminalError) requestTermination(terminalError || cancellationError(signal));
  });
}

module.exports = { runFfmpegTask, uniqueOutputPath, TaskCancelledError, classifyFfmpegFailure, buildFfmpegArgs };
