// Runs the compiled tests in out/test with Node's built-in test runner.
// (A file list is passed explicitly: directory/glob arguments behave
// differently across Node versions.)
const { readdirSync } = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'out', 'test');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join(dir, f));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
