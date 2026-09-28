const { spawn } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const files = [];

function discover(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) discover(absolute);
    else if (entry.isFile() && /\.(?:spec|test)\.(?:cjs|js|ts)$/.test(entry.name)) {
      files.push(path.relative(root, absolute));
    }
  }
}

for (const directory of ['test', 'src']) discover(path.join(root, directory));
files.sort();
if (files.length === 0) {
  console.error('No API test files discovered under test/ or src/.');
  process.exit(1);
}

console.log(`Running ${files.length} API test files: ${files.join(', ')}`);
const child = spawn(process.execPath, [
  '--require', 'ts-node/register/transpile-only',
  '--test', '--test-reporter=tap', ...files,
], { cwd: root, stdio: ['inherit', 'pipe', 'inherit'] });

let pending = '';
let testCount;
let passCount;
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  pending += chunk.toString();
  const lines = pending.split(/\r?\n/);
  pending = lines.pop();
  for (const line of lines) {
    const match = /^# tests (\d+)$/.exec(line);
    if (match) testCount = Number(match[1]);
    const passes = /^# pass (\d+)$/.exec(line);
    if (passes) passCount = Number(passes[1]);
  }
});
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('close', (code) => {
  if (code !== 0 || !testCount || !passCount) {
    if (!testCount || !passCount) console.error('API test runner did not report a nonzero number of passing tests.');
    process.exitCode = 1;
  } else {
    console.log(`Verified ${testCount} API tests passed.`);
  }
});
