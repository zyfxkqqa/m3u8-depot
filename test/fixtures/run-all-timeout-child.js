const fs = require('fs');
const { spawn } = require('child_process');

const childSource = `
  const parentPid = Number(process.argv[1]);
  setInterval(() => {
    try { process.kill(parentPid, 0); }
    catch (_) { process.exit(0); }
  }, 25);
`;
const child = spawn(process.execPath, ['-e', childSource, String(process.pid)], {
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();

fs.writeFileSync(process.env.RUN_ALL_TIMEOUT_PID_FILE, JSON.stringify({
  parentPid: process.pid,
  childPid: child.pid,
}));

setInterval(() => {}, 1000);
