const fs = require('fs');
const path = require('path');
const { sanitizeFileName } = require('./text');
const { retryFileOperation } = require('./task-store');

function createOutputManager(outputDir, options = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const outputRoot = path.resolve(outputDir);
  const outputRealRoot = fs.realpathSync(outputRoot);
  const reserved = new Set();
  const retryAttempts = options.retryAttempts ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 25;

  function candidatePath(title, index, dir) {
    const base = sanitizeFileName(title);
    const suffix = index === 1 ? '' : ` (${index})`;
    return path.join(dir, `${base}${suffix}.mp4`);
  }

  // subdir 用于合集类内容（电视剧、综艺）：由调用方根据批次信息传入，
  // 单片（电影）不传，仍直接落在输出根目录。
  function reserve(title, taskId, reserveOptions = {}) {
    const rawSubdir = typeof reserveOptions.subdir === 'string' ? reserveOptions.subdir.trim() : '';
    const targetDir = rawSubdir ? path.join(outputDir, sanitizeFileName(rawSubdir)) : outputDir;
    fs.mkdirSync(targetDir, { recursive: true });
    let index = 1;
    let finalPath;
    do {
      finalPath = candidatePath(title, index, targetDir);
      index += 1;
    } while (reserved.has(finalPath.toLowerCase()) || fs.existsSync(finalPath));

    reserved.add(finalPath.toLowerCase());
    const shortId = String(taskId || 'task').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'task';
    const extension = path.extname(finalPath);
    const stem = finalPath.slice(0, -extension.length);
    const partPath = `${stem}.${shortId}.part.mp4`;
    return { finalPath, partPath };
  }

  function release(finalPath) {
    if (finalPath) reserved.delete(finalPath.toLowerCase());
  }

  function retain(finalPath) {
    if (finalPath) reserved.add(finalPath.toLowerCase());
  }

  function pathKey(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  async function assertDeletable(filePath, kind, authorizedPath) {
    const resolved = path.resolve(String(filePath || ''));
    const relative = path.relative(outputRoot, resolved);
    if (!filePath || relative.startsWith('..') || path.isAbsolute(relative)) {
      const error = new Error(`Refusing ${kind} path outside output directory: ${filePath}`);
      error.code = 'OUTPUT_PATH_INVALID';
      throw error;
    }
    if (kind === 'part') {
      if (!authorizedPath || pathKey(resolved) !== pathKey(authorizedPath)) {
        const error = new Error(`Refusing part file not authorized by task record: ${filePath}`);
        error.code = 'OUTPUT_PATH_INVALID';
        throw error;
      }
      // .part.mp4.ts 是多线程引擎的中间合并产物（下载完成后转封装为 .part.mp4），
      // 与 .part.mp4 同属临时文件，允许清理。
      const lowered = resolved.toLowerCase();
      if (!lowered.endsWith('.part.mp4') && !lowered.endsWith('.part.mp4.ts')) {
        const error = new Error(`Refusing invalid part file: ${filePath}`);
        error.code = 'OUTPUT_PATH_INVALID';
        throw error;
      }
    } else if (path.extname(resolved).toLowerCase() !== '.mp4' || resolved.toLowerCase().endsWith('.part.mp4')) {
      const error = new Error(`Refusing invalid final output file: ${filePath}`);
      error.code = 'OUTPUT_PATH_INVALID';
      throw error;
    }
    let stat;
    try { stat = await fs.promises.lstat(resolved); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      const error = new Error(`Refusing non-file output path: ${filePath}`);
      error.code = 'OUTPUT_PATH_INVALID';
      throw error;
    }
    const realPath = await fs.promises.realpath(resolved);
    const realRelative = path.relative(outputRealRoot, realPath);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      const error = new Error(`Refusing output path escaping real output directory: ${filePath}`);
      error.code = 'OUTPUT_PATH_INVALID';
      throw error;
    }
    return resolved;
  }

  async function removeIfExists(filePath, kind, authorizedPath) {
    if (!filePath) return;
    const safePath = await assertDeletable(filePath, kind, authorizedPath);
    if (!safePath) return;
    try {
      await retryFileOperation(() => fs.promises.unlink(safePath), {
        attempts: retryAttempts,
        retryDelayMs,
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async function commit(partPath, finalPath) {
    if (!partPath || !finalPath) throw new Error('Missing output path reservation');
    const relative = path.relative(outputRoot, path.resolve(finalPath));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Object.assign(new Error(`Invalid output path: ${finalPath}`), { code: 'OUTPUT_PATH_INVALID' });
    const reservation = [...reserved].includes(path.resolve(finalPath).toLowerCase());
    if (!reservation) throw Object.assign(new Error(`Unreserved output path: ${finalPath}`), { code: 'OUTPUT_PATH_INVALID' });
    if (!fs.existsSync(partPath) || fs.statSync(partPath).size <= 0) {
      const error = new Error('FFmpeg did not produce a complete part file');
      error.code = 'FFMPEG_FAILED';
      throw error;
    }
    if (fs.existsSync(finalPath)) {
      const error = new Error(`Reserved output path already exists: ${finalPath}`);
      error.code = 'OUTPUT_CONFLICT';
      throw error;
    }
    await retryFileOperation(() => fs.promises.rename(partPath, finalPath), {
      attempts: retryAttempts,
      retryDelayMs,
    });
  }

  return {
    reserve,
    retain,
    release,
    commit,
    cleanupPart: (filePath, authorizedPath) => removeIfExists(filePath, 'part', authorizedPath),
    removeFinal: filePath => removeIfExists(filePath, 'final', filePath),
    getReservedCount: () => reserved.size,
  };
}

module.exports = { createOutputManager };
