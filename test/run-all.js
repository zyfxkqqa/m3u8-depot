const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const defaultSteps = [
  ['check', 'test/check-all.js'],
  ['stage1', 'test/stage1-smoke.js'],
  ['stage2', 'test/stage2-smoke.js'],
  ['stage2-security', 'test/stage2-security-smoke.js'],
  ['subdir', 'test/subdir-smoke.js'],
  ['stage3-input', 'test/stage3-input-smoke.js'],
  ['stage3-delete', 'test/stage3-delete-smoke.js'],
  ['stage3-shutdown', 'test/stage3-shutdown-smoke.js'],
  ['stage3', 'test/stage3-smoke.js'],
  ['stage3-ui', 'test/stage3-ui-smoke.js'],
  ['stage4', 'test/stage4-smoke.js'],
  ['stage4-accessibility', 'test/stage4-accessibility-smoke.js'],
  ['zjlqzg', 'test/zjlqzg-smoke.js'],
  ['sites', 'test/sites-smoke.js'],
  ['stage5', 'test/stage5-smoke.js'],
];

function waitWithTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]);
}

function processExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function createCommand(command, args, options = {}) {
  const child = spawn(command, args, { windowsHide: true, ...options });
  let stdout = '';
  let stderr = '';
  let exitResult = null;
  let closeResult = null;
  let spawnError = null;
  if (child.stdout) child.stdout.on('data', chunk => { stdout += chunk; });
  if (child.stderr) child.stderr.on('data', chunk => { stderr += chunk; });

  let resolveExit;
  let resolveClose;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const closed = new Promise(resolve => { resolveClose = resolve; });
  child.once('error', error => {
    spawnError = error;
    if (!exitResult) { exitResult = { code: null, signal: null, error }; resolveExit(exitResult); }
    if (!closeResult) { closeResult = { code: null, signal: null, error }; resolveClose(closeResult); }
  });
  child.once('exit', (code, signal) => {
    exitResult = { code, signal, error: spawnError };
    resolveExit(exitResult);
  });
  child.once('close', (code, signal) => {
    closeResult = { code, signal, error: spawnError };
    resolveClose(closeResult);
  });

  return {
    child, exited, closed,
    get exitResult() { return exitResult; },
    get closeResult() { return closeResult; },
    getOutput() { return { stdout, stderr }; },
  };
}

function terminatePidTree(pid) {
  if (!pid) return Promise.resolve({ code: 0, alreadyClosed: true });
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    return Promise.resolve({ code: 0 });
  }
  const killer = createCommand('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return killer.closed.then(result => {
    const output = killer.getOutput();
    if (result.error) throw result.error;
    if (result.code !== 0 && result.code !== 128 && processExists(pid)) {
      throw new Error(`taskkill failed for PID ${pid}: code=${result.code} ${output.stderr || output.stdout}`.trim());
    }
    return result;
  });
}

async function terminateCommand(commandState) {
  if (commandState.closeResult) return commandState.closeResult;
  let treeError = null;
  try {
    await terminatePidTree(commandState.child.pid);
  } catch (error) {
    treeError = error;
    if (!commandState.closeResult) {
      try { commandState.child.kill('SIGKILL'); } catch (killError) {
        if (killError.code !== 'ESRCH') throw new Error(`${error.message}; child.kill failed: ${killError.message}`);
      }
    }
  }
  return { treeError };
}

async function runCommand(options) {
  const timeoutMs = options.timeoutMs || 30000;
  const cleanupTimeoutMs = options.cleanupTimeoutMs || 5000;
  const commandState = createCommand(options.command, options.args || [], {
    cwd: options.cwd || root,
    env: options.env || process.env,
    stdio: options.stdio || 'inherit',
  });
  const startedAt = Date.now();
  let timeoutTimer;
  const winner = await Promise.race([
    commandState.closed.then(result => ({ type: 'closed', result })),
    new Promise(resolve => { timeoutTimer = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs); }),
  ]);
  clearTimeout(timeoutTimer);

  if (winner.type === 'timeout') {
    let cleanupError = null;
    if (!commandState.closeResult) {
      try {
        const termination = await terminateCommand(commandState);
        cleanupError = termination?.treeError || null;
      } catch (error) { cleanupError = error; }
    }
    let closedResult;
    try {
      closedResult = commandState.closeResult || await waitWithTimeout(
        commandState.closed,
        cleanupTimeoutMs,
        `${options.name || 'command'} cleanup failed: PID ${commandState.child.pid} did not close within ${cleanupTimeoutMs}ms`,
      );
    } catch (error) {
      if (cleanupError) error.message += `; termination error: ${cleanupError.message || cleanupError}`;
      throw error;
    }
    if (cleanupError && !processExists(commandState.child.pid)) cleanupError = null;
    const output = commandState.getOutput();
    const cleanupText = cleanupError ? `; termination error: ${cleanupError.message || cleanupError}` : '';
    const error = new Error(`${options.name || 'command'} timed out after ${timeoutMs}ms; process closed${cleanupText}`);
    error.result = { ...closedResult, ...output, elapsed: Date.now() - startedAt, pid: commandState.child.pid };
    throw error;
  }

  const output = commandState.getOutput();
  return { ...winner.result, ...output, elapsed: Date.now() - startedAt, pid: commandState.child.pid };
}

async function runStep(name, script, options = {}) {
  console.log(`\n[${name}] ${script}`);
  const result = await runCommand({
    name,
    command: process.execPath,
    args: [script],
    cwd: root,
    stdio: 'inherit',
    timeoutMs: options.timeoutMs || 30000,
    cleanupTimeoutMs: options.cleanupTimeoutMs || 5000,
  });
  if (result.error) throw result.error;
  if (result.code !== 0) throw new Error(`${name} failed: code=${result.code} signal=${result.signal || 'none'} elapsed=${result.elapsed}ms`);
  console.log(`[${name}] PASS ${result.elapsed}ms`);
}

async function main() {
  for (const [name, script] of defaultSteps) await runStep(name, script);
  console.log('\nrun-all-ok');
}

if (require.main === module) {
  main().catch(error => { console.error(error.message || error); process.exitCode = 1; });
}

module.exports = { runCommand };
