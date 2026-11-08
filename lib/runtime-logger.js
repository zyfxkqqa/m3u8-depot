const fs = require('fs');
const path = require('path');

function createRuntimeLogger(options) {
  const filePath = options.filePath;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 3;
  let writeTail = Promise.resolve();

  async function exists(target) {
    try {
      await fs.promises.access(target);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async function rotate() {
    if (maxFiles <= 1) {
      await fs.promises.rm(filePath, { force: true });
      return;
    }
    await fs.promises.rm(`${filePath}.${maxFiles - 1}`, { force: true });
    for (let index = maxFiles - 2; index >= 1; index -= 1) {
      const source = `${filePath}.${index}`;
      if (await exists(source)) await fs.promises.rename(source, `${filePath}.${index + 1}`);
    }
    if (await exists(filePath)) await fs.promises.rename(filePath, `${filePath}.1`);
  }

  async function append(line) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    let size = 0;
    try {
      size = (await fs.promises.stat(filePath)).size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) await rotate();
    await fs.promises.appendFile(filePath, line, 'utf8');
  }

  function log(message, error) {
    const line = `[${new Date().toISOString()}] ${message}${error ? `\n${error.stack || error}` : ''}\n`;
    writeTail = writeTail.then(() => append(line)).catch(() => {});
    return writeTail;
  }

  return { log, close: () => writeTail };
}

module.exports = { createRuntimeLogger };
