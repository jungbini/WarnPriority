import { strict as assert } from 'assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { CommitRecord } from '../core/types';
import { JsonArrayWriter, toOutputCommit } from '../core/writers';

const commit: CommitRecord = {
  sha: 'abc',
  parents: ['p1', 'p2'],
  author: { name: 'Alice', email: 'alice@example.com', date: 'd' },
  committer: { name: 'C', email: 'c@d', date: 'd' },
  message: 'Fix "quotes"\n\nbody',
  url: 'https://github.com/o/r/commit/abc',
  stats: { filesChanged: 3, linesAdded: 3, linesDeleted: 2, addedBlocks: 1, deletedBlocks: 1, modifiedBlocks: 1 },
  files: [
    {
      oldPath: 'a.c',
      newPath: 'a.c',
      status: 'modified',
      changes: [
        { type: 'modified', oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, deletedCode: ['x = 1;'], addedCode: ['x = 2;', 'y = 3;'] },
        { type: 'added', oldStart: 5, oldLines: 0, newStart: 7, newLines: 1, deletedCode: [], addedCode: ['z();'] },
      ],
    },
    {
      oldPath: 'gone.c',
      newPath: null,
      status: 'deleted',
      changes: [{ type: 'deleted', oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, deletedCode: ['bye'], addedCode: [] }],
    },
    {
      oldPath: 'old/name.c',
      newPath: 'new/name.c',
      status: 'renamed',
      changes: [{ type: 'modified', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, deletedCode: ['a'], addedCode: ['b'] }],
    },
  ],
};

test('toOutputCommit keeps sha, parent, author, message and line-numbered per-file diffs', () => {
  assert.deepEqual(toOutputCommit(commit), {
    sha: 'abc',
    parent: 'p1',
    author: 'Alice <alice@example.com>',
    message: 'Fix "quotes"\n\nbody',
    files: [
      {
        file: 'a.c',
        diff: [
          {
            type: 'modified',
            before: [{ line: 1, code: 'x = 1;' }],
            after: [
              { line: 1, code: 'x = 2;' },
              { line: 2, code: 'y = 3;' },
            ],
          },
          { type: 'added', before: [], after: [{ line: 7, code: 'z();' }] },
        ],
      },
      { file: 'gone.c', diff: [{ type: 'deleted', before: [{ line: 1, code: 'bye' }], after: [] }] },
      {
        file: 'new/name.c',
        oldFile: 'old/name.c',
        diff: [{ type: 'modified', before: [{ line: 1, code: 'a' }], after: [{ line: 1, code: 'b' }] }],
      },
    ],
  });
  assert.equal(toOutputCommit({ ...commit, parents: [] }).parent, null);
});

test('JSON writer produces a valid array for zero, one and many commits', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'warnpriority-writer-'));
  try {
    for (const n of [0, 1, 3]) {
      const file = path.join(dir, `${n}.json`);
      const w = new JsonArrayWriter(file);
      for (let i = 0; i < n; i++) {
        await w.writeCommit({ ...commit, sha: String(i) });
      }
      await w.close();
      const data = JSON.parse(readFileSync(file, 'utf8'));
      assert.ok(Array.isArray(data));
      assert.equal(data.length, n);
      if (n > 0) {
        assert.deepEqual(data[0], toOutputCommit({ ...commit, sha: '0' }));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discard removes the file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'warnpriority-writer-'));
  try {
    const file = path.join(dir, 'y.json');
    const w = new JsonArrayWriter(file);
    await w.writeCommit(commit);
    await w.discard();
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
