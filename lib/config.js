const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const IS_WINDOWS = process.platform === 'win32';

function positiveIntegerFromEnv(name, fallback, maximum) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid ${name}: expected an integer between 1 and ${maximum}, received ${JSON.stringify(raw)}`);
  }
  return value;
}

// 随项目分发的可执行文件优先；缺失时回退到 PATH，由系统安装提供。
function bundledBinary(name) {
  const candidate = path.join(ROOT_DIR, 'tools', IS_WINDOWS ? `${name}.exe` : name);
  if (fs.existsSync(candidate)) return candidate;
  return IS_WINDOWS ? `${name}.exe` : name;
}

module.exports = {
  HOST: '127.0.0.1',
  PORT: Number(process.env.M3U8_DOWNLOADER_PORT || 17892),
  ROOT_DIR,
  STATIC_DIR: process.env.M3U8_STATIC_DIR || path.join(ROOT_DIR, 'static'),
  DATA_DIR: process.env.M3U8_DATA_DIR || path.join(ROOT_DIR, 'data'),
  TASKS_FILE: process.env.M3U8_TASKS_FILE || path.join(ROOT_DIR, 'data', 'tasks.json'),
  // 默认落在用户主目录下的下载文件夹，避免依赖任何固定盘符。
  OUTPUT_DIR: process.env.M3U8_OUTPUT_DIR || path.join(os.homedir(), 'Downloads', 'M3U8'),
  FFMPEG: process.env.FFMPEG_PATH || bundledBinary('ffmpeg'),
  N3U8DL: process.env.M3U8_N3U8DL_PATH || bundledBinary('N_m3u8DL-RE'),
  DOWNLOAD_ENGINE: process.env.M3U8_DOWNLOAD_ENGINE === 'ffmpeg' ? 'ffmpeg' : 'n3u8',
  DOWNLOAD_THREADS: positiveIntegerFromEnv('M3U8_DOWNLOAD_THREADS', 16, 64),
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  MAX_ACTIVE_TASKS: positiveIntegerFromEnv('M3U8_MAX_ACTIVE_TASKS', 2, 32),
  PARSE_CONCURRENCY: positiveIntegerFromEnv('M3U8_PARSE_CONCURRENCY', 4, 64),
};
