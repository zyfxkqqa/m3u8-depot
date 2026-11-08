const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const excludedDirectories = new Set(['data', 'log', 'logs', 'node_modules', '.git']);

function collect(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name.toLowerCase())) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collect(target));
    else if (/\.(?:js|mjs)$/i.test(entry.name) && !/\.log$/i.test(entry.name)) files.push(target);
  }
  return files;
}

const files = collect(root).sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    console.error(`check failed: ${path.relative(root, file)}`);
    process.exit(result.status || 1);
  }
}
console.log(`check-all-ok (${files.length} files)`);
