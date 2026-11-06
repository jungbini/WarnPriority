import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import { test } from 'node:test';

// Tests run from out/test; the sources live next to it in src/.
const root = path.join(__dirname, '..', '..');

test('every vscode.l10n.t() string has a Korean translation', () => {
  const source = readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
  const bundle = JSON.parse(readFileSync(path.join(root, 'l10n', 'bundle.l10n.ko.json'), 'utf8'));
  const used = [...source.matchAll(/l10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
  assert.ok(used.length > 10);
  const missing = used.filter((s) => !(s in bundle));
  assert.deepEqual(missing, []);
});

test('every %key% in package.json is defined in both nls files', () => {
  const pkg = readFileSync(path.join(root, 'package.json'), 'utf8');
  const keys = [...pkg.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]);
  for (const file of ['package.nls.json', 'package.nls.ko.json']) {
    const nls = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
    assert.deepEqual(
      keys.filter((k) => !(k in nls)),
      [],
      file,
    );
  }
});
