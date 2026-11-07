import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, test } from 'node:test';
import { BlobReader } from '../core/blobReader';
import { safeJoin } from '../core/commitFiles';
import { CancelledError } from '../core/git';

test('safeJoin keeps normal paths below the base directory', () => {
  assert.equal(safeJoin('/out/abc/before', 'src/A.java', 'linux'), '/out/abc/before/src/A.java');
  assert.equal(safeJoin('/out/abc/before', 'dir with space/파일.txt', 'linux'), '/out/abc/before/dir with space/파일.txt');
  assert.equal(safeJoin('/out/b', 'a\\b.txt', 'linux'), '/out/b/a\\b.txt');
  assert.equal(safeJoin('C:\\out\\b', 'src/A.java', 'win32'), 'C:\\out\\b\\src\\A.java');
});

test('safeJoin rejects traversal, absolute paths and .git directories', () => {
  for (const p of ['../x', 'a/../../x', '/etc/passwd', 'a//b', './a', '', '.git/config', 'sub/.GIT/hooks/x', '.git./x', 'GIT~1/config']) {
    assert.equal(safeJoin('/out/b', p, 'linux'), null, p);
  }
  for (const p of ['a\\..\\..\\x', 'C:/x', 'a:stream', '.git /x']) {
    assert.equal(safeJoin('C:\\out\\b', p, 'win32'), null, p);
  }
});

let repo: string;
let head: string;

before(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'warnpriority-blob-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    }).toString();
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'small.txt'), 'hello\n');
  writeFileSync(path.join(repo, 'with space.txt'), 'spaced\n');
  // Larger than a pipe chunk, with every byte value, to exercise the chunk reassembly.
  const big = Buffer.alloc(1_000_000);
  for (let i = 0; i < big.length; i++) {
    big[i] = (i * 7) % 256;
  }
  writeFileSync(path.join(repo, 'big.bin'), big);
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  head = git('rev-parse', 'HEAD').trim();
});

after(() => rmSync(repo, { recursive: true, force: true }));

test('BlobReader returns file contents in request order, null for missing paths and directories', async () => {
  const reader = new BlobReader({ gitPath: 'git' }, repo);
  try {
    const [small, missing, spaced, big, again, dir] = await Promise.all([
      reader.read(head, 'small.txt'),
      reader.read(head, 'nope.txt'),
      reader.read(head, 'with space.txt'),
      reader.read(head, 'big.bin'),
      reader.read(head, 'small.txt'),
      reader.read(head, ''),
    ]);
    assert.equal(small?.toString(), 'hello\n');
    assert.equal(missing, null);
    assert.equal(spaced?.toString(), 'spaced\n');
    assert.equal(big?.length, 1_000_000);
    assert.equal(big?.[999_999], (999_999 * 7) % 256);
    assert.equal(again?.toString(), 'hello\n');
    assert.equal(dir, null, 'a tree is not a file');
    assert.equal(await reader.read(head, 'bad\nname'), null);
  } finally {
    await reader.close();
  }
});

test('BlobReader rejects pending reads when cancelled', async () => {
  const controller = new AbortController();
  const reader = new BlobReader({ gitPath: 'git', signal: controller.signal }, repo);
  await reader.read(head, 'small.txt');
  controller.abort();
  await assert.rejects(reader.read(head, 'big.bin'), CancelledError);
  await reader.close();
});
