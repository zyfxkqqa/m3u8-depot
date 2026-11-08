const fs = require('fs');
const { runFfmpegTask, TaskCancelledError } = require('./ffmpeg-runner');
const n3u8 = require('./n3u8-engine');

// 这些错误码表示"当前引擎处理不了这个流"（格式、加密、参数层面），
// 换 ffmpeg 单连接引擎再试一次有意义。网络类错误仍由原引擎重试。
const FALLBACK_CODES = new Set(['FFMPEG_PERMANENT', 'N3U8_FAILED']);

function removeIfPresent(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {
    // 清理失败交给上层 cleanupPart 处理，不掩盖原始错误。
  }
}

function cancellationError(signal) {
  if (signal?.reason?.code === 'TASK_CANCELLED') return signal.reason;
  return new TaskCancelledError();
}

// 多线程引擎只负责下载与合并，单流 HLS 的产物是 .ts；
// 再由 ffmpeg 以 -c copy 无损封装为 .mp4，保证最终落盘格式与 ffmpeg 引擎一致。
async function runN3u8Pipeline(task, options, onUpdate, signal) {
  const tsPath = `${options.partPath}.ts`;
  try {
    await runFfmpegTask(task, {
      ...options,
      engine: 'n3u8',
      partPath: tsPath,
      recordPartPath: options.partPath,
    }, onUpdate, signal);
    if (signal?.aborted) throw cancellationError(signal);

    await onUpdate(task.id, { progressText: '正在转封装为 MP4...' });
    if (signal?.aborted) throw cancellationError(signal);

    await runFfmpegTask(task, {
      ...options,
      engine: 'remux',
      remuxInput: tsPath,
      partPath: options.partPath,
      recordPartPath: options.partPath,
    }, onUpdate, signal);

    removeIfPresent(tsPath);
    n3u8.cleanupRoot(options, task);
  } catch (error) {
    removeIfPresent(tsPath);
    n3u8.cleanupRoot(options, task);
    throw error;
  }
}

async function runDownloadTask(task, options, onUpdate, signal) {
  const engine = options.engine === 'ffmpeg' ? 'ffmpeg' : 'n3u8';
  const n3u8Ready = Boolean(options.n3u8dl) && fs.existsSync(options.n3u8dl);

  if (engine === 'ffmpeg' || !n3u8Ready) {
    return runFfmpegTask(task, { ...options, engine: 'ffmpeg' }, onUpdate, signal);
  }

  try {
    return await runN3u8Pipeline(task, options, onUpdate, signal);
  } catch (error) {
    const cancelled = signal?.aborted || error?.code === 'TASK_CANCELLED';
    if (cancelled || error?.code === 'FFMPEG_STALLED' || !FALLBACK_CODES.has(error?.code)) throw error;

    removeIfPresent(options.partPath);
    try {
      await onUpdate(task.id, {
        progressText: '多线程引擎无法处理该流，回退到 FFmpeg 重试',
        error: String(error.message || error).slice(0, 4000),
      });
    } catch (updateError) {
      throw updateError;
    }
    return runFfmpegTask(task, { ...options, engine: 'ffmpeg' }, onUpdate, signal);
  }
}

module.exports = { runDownloadTask, FALLBACK_CODES };
