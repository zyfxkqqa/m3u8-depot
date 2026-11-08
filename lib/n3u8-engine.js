const fs = require('fs');
const path = require('path');

// N_m3u8DL-RE 的进度行形如（已去 ANSI 颜色、\r 覆盖式输出）：
//   Vid Kbps ------------------------------ 103/3434 3.00% 23.23MB/949.74MB5.95MBps00:03:27
// 注意大小、速度、剩余时间三段之间没有分隔符，必须用带锚点的组合正则拆分。
const PROGRESS_RE = /(\d+)\/(\d+)\s+([\d.]+)%\s+([\d.]+[KMG]?B)\/([\d.]+[KMG]?B)([\d.]+[KMG]?Bps)?(\d+:\d+:\d+)?/;

// 永久性失败特征：格式/加密/参数层面不可恢复，交给 ffmpeg 回退或直接失败。
const PERMANENT_PATTERNS = [
  /unsupported/i,
  /not supported/i,
  /no available/i,
  /no stream/i,
  /decrypt/i,
  /invalid data/i,
  /invalid argument/i,
  /permission denied/i,
  /not found/i,
  /failed to parse/i,
  /unknown/i,
];

// 临时性失败特征：网络层面，可重试。
const TRANSIENT_PATTERNS = [
  /timed? ?out/i,
  /timeout/i,
  /reset by peer/i,
  /connection (?:reset|refused|closed|aborted)/i,
  /network is unreachable/i,
  /no route to host/i,
  /temporary failure in name resolution/i,
  /(?:http|status|code)[^\d]{0,6}(?:408|425|429|500|502|503|504)/i,
  /too many requests/i,
  /retry/i,
];

// 每个任务使用独立的临时根目录，避免并发任务互相覆盖分片。
// 目录内容在任务提交或失败后整体删除，不污染输出目录。
function taskRoot(options, task) {
  const shortId = String(task?.id || 'task').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'task';
  return path.join(options.outputDir, '.n3u8tmp', shortId);
}

function workDir(options, task) {
  return path.join(taskRoot(options, task), 'work');
}

function outDir(options, task) {
  return path.join(taskRoot(options, task), 'out');
}

// 引擎只负责下载与合并，不负责封装：单流 HLS 会输出 .ts。
// 因此 save-name 取输出文件的完整主干，得到 <name>.ts，交由 ffmpeg 转封装。
function saveNameFor(output) {
  return path.basename(output).replace(/\.(mp4|ts|mkv)$/i, '');
}

function buildArgs(task, options, output) {
  const saveName = saveNameFor(output);
  const args = [
    task.m3u8Url,
    '--save-dir', outDir(options, task),
    '--save-name', saveName,
    '--tmp-dir', workDir(options, task),
    '-H', `User-Agent: ${options.userAgent}`,
    '-H', `Referer: ${task.pageUrl}`,
    '-H', `Origin: ${new URL(task.pageUrl).origin}`,
    '--auto-select',
    '--thread-count', String(options.threads ?? 16),
    // .NET 默认读取系统代理（Clash 等），会与 start.bat 的清代理策略冲突，
    // 且代理节点常限速或断流，因此显式直连。
    '--use-system-proxy', 'false',
    '--no-log',
    '--no-ansi-color',
    '--del-after-done',
    '--ffmpeg-binary-path', options.ffmpeg,
  ];
  return args;
}

function dirStats(dir) {
  let bytes = 0;
  let segments = 0;

  function walk(current, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (entry.name.endsWith('.ts')) segments += 1;
      try {
        bytes += fs.statSync(full).size;
      } catch (_) {
        // 分片可能正在写入或被合并流程移动，跳过即可。
      }
    }
  }

  walk(dir, 0);
  return { bytes, segments };
}

// 引擎在 stdout 被重定向时会缓冲进度条，短时间可能一行都不吐。
// 进度因此改由临时目录的实际落盘量推导，不受输出缓冲影响。
function measureTmp(options, task) {
  const work = dirStats(workDir(options, task));
  const out = dirStats(outDir(options, task));
  return {
    bytes: work.bytes + out.bytes,
    segments: work.segments,
  };
}

// 引擎合并完成后，产物名可能带 .ts/.mp4/.mkv 或附加语言标记。
// 按优先顺序查找，最后退化为“目录内最大的媒体文件”。
function findOutput(options, task, output) {
  const dir = outDir(options, task);
  const saveName = saveNameFor(output);
  const candidates = [
    `${saveName}.ts`,
    `${saveName}.mp4`,
    `${saveName}.mkv`,
  ];
  for (const name of candidates) {
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).size > 0) return full;
    } catch (_) {
      // 继续尝试下一个候选名。
    }
  }

  let best = null;
  let bestSize = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(dir, entry.name);
    let files;
    try {
      files = fs.readdirSync(sub);
    } catch (_) {
      continue;
    }
    for (const file of files) {
      if (!/\.(ts|mp4|mkv|m4a|aac)$/i.test(file)) continue;
      const full = path.join(sub, file);
      try {
        const size = fs.statSync(full).size;
        if (size > bestSize) {
          best = full;
          bestSize = size;
        }
      } catch (_) {
        // 忽略无法读取的候选文件。
      }
    }
  }
  return best;
}

function cleanupRoot(options, task) {
  const root = taskRoot(options, task);
  try {
    fs.rmSync(root, { recursive: true, force: true });
    // 父目录为空时一并移除，避免输出目录留下空壳。
    try {
      fs.rmdirSync(path.dirname(root));
    } catch (_) {
      // 仍有其他任务在用，保留父目录。
    }
  } catch (_) {
    // 清理失败不影响任务结果，残留会在下次同任务启动时覆盖。
  }
}

function parseProgress(record) {
  const match = PROGRESS_RE.exec(record);
  if (!match) return null;
  const segmentsDone = Number(match[1]);
  const segmentsTotal = Number(match[2]);
  if (!Number.isFinite(segmentsDone) || !Number.isFinite(segmentsTotal) || segmentsTotal <= 0) return null;

  const percent = match[3];
  const speed = match[6];
  const eta = match[7];
  const progressText = [
    `${segmentsDone}/${segmentsTotal}`,
    `${percent}%`,
    speed ? `${speed}` : '',
    eta ? `剩余 ${eta}` : '',
  ].filter(Boolean).join('  ');

  return {
    segmentsDone,
    segmentsTotal,
    percent: Number(percent),
    downloaded: match[4],
    total: match[5],
    speed,
    eta,
    progressText,
  };
}

function formatBytes(value) {
  const size = Number(value) || 0;
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${size} B`;
}

function classifyFailure(text, code) {
  const body = String(text || '');
  const error = new Error((body || `N_m3u8DL-RE exited with code ${code}`).slice(-4000));
  if (PERMANENT_PATTERNS.some(pattern => pattern.test(body))) {
    error.code = 'FFMPEG_PERMANENT';
  } else if (TRANSIENT_PATTERNS.some(pattern => pattern.test(body))) {
    error.code = 'FFMPEG_TRANSIENT';
  } else {
    error.code = 'N3U8_FAILED';
  }
  return error;
}

module.exports = {
  buildArgs,
  parseProgress,
  classifyFailure,
  taskRoot,
  workDir,
  outDir,
  saveNameFor,
  measureTmp,
  findOutput,
  cleanupRoot,
  formatBytes,
  PROGRESS_RE,
};
