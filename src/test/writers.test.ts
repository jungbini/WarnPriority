import { strict as assert } from 'assert';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { CommitRecord } from '../core/types';
import { createOutputWriter, csvCell, RunSummary } from '../core/writers';

const summary: RunSummary = {
  complete: true,
  matchedCommits: 1,
  commitsWithCodeChanges: 1,
  filesChanged: 1,
  codeChanges: { modify: 1, insert: 0, delete: 0, total: 1 },
  linesAdded: 1,
  linesDeleted: 1,
  finishedAt: '2024-01-01T00:00:00.000Z',
};

const commit: CommitRecord = {
  sha: 'abc',
  parents: [],
  author: { name: 'A, "B"', email: 'a@b', date: 'd' },
  committer: { name: 'C', email: 'c@d', date: 'd' },
  message: 'line1\nline2',
  url: null,
  stats: { filesChanged: 1, linesAdded: 1, linesDeleted: 1, modifyBlocks: 1, insertBlocks: 0, deleteBlocks: 0 },
  files: [
    {
      oldPath: 'a.c',
      newPath: 'a.c',
      status: 'modified',
      changes: [{ type: 'modify', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, deletedCode: ['x = "1";'], addedCode: ['x = "2";'] }],
    },
  ],
};

test('csvCell quotes only when needed', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(3), '3');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('l1\nl2'), '"l1\nl2"');
  assert.equal(csvCell('  indented'), '"  indented"');
});

test('JSON writer produces valid JSON for zero, one and many commits', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'warnpriority-writer-'));
  try {
    for (const n of [0, 1, 3]) {
      const file = path.join(dir, `${n}.json`);
      const w = createOutputWriter('json', file, { tool: 'test' });
      for (let i = 0; i < n; i++) {
        await w.writeCommit({ ...commit, sha: String(i) });
      }
      await w.close(summary);
      const data = JSON.parse(readFileSync(file, 'utf8'));
      assert.deepEqual(data.metadata, { tool: 'test' });
      assert.equal(data.commits.length, n);
      assert.deepEqual(data.summary, summary);
      if (n > 0) {
        assert.deepEqual(data.commits[0], { ...commit, sha: '0' });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CSV writer and discard', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'warnpriority-writer-'));
  try {
    const file = path.join(dir, 'x.csv');
    const w = createOutputWriter('csv', file, {});
    await w.writeCommit(commit);
    await w.close(summary);
    const lines = readFileSync(file, 'utf8').split('\r\n');
    assert.equal(lines[0].charCodeAt(0), 0xfeff);
    assert.equal(lines[1], 'abc,,"A, ""B""",a@b,d,"line1\nline2",modified,a.c,a.c,modify,1,1,1,1,"x = ""1"";","x = ""2"";"');

    const other = path.join(dir, 'y.json');
    const w2 = createOutputWriter('json', other, {});
    await w2.writeCommit(commit);
    await w2.discard();
    assert.equal(existsSync(other), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
