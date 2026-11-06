import { strict as assert } from 'assert';
import { test } from 'node:test';
import { GitLogParser, parseHeaderPath, unquoteCString } from '../core/logParser';
import { CommitRecord } from '../core/types';

function header(sha: string, parents: string, message: string): string[] {
  return [
    `\x00\x01COMMIT\x00${sha}\x00${parents}\x00Alice\x00alice@example.com\x002024-01-02T03:04:05+09:00\x00Bob\x00bob@example.com\x002024-01-03T00:00:00Z`,
    '\x00\x01MSG',
    ...message.split('\n'),
    '\x00\x01ENDMSG',
    '',
  ];
}

function parse(lines: string[]): CommitRecord[] {
  const parser = new GitLogParser((sha) => `https://github.com/o/r/commit/${sha}`);
  const out: CommitRecord[] = [];
  for (const l of lines) {
    const c = parser.push(l);
    if (c) {
      out.push(c);
    }
  }
  const last = parser.finish();
  if (last) {
    out.push(last);
  }
  return out;
}

test('classifies added / deleted / modified blocks with correct line numbers', () => {
  const commits = parse([
    ...header('a'.repeat(40), 'b'.repeat(40), 'Fix NPE in parser\n\nLonger body'),
    'diff --git a/src/A.java b/src/A.java',
    'index 111..222 100644',
    '--- a/src/A.java',
    '+++ b/src/A.java',
    '@@ -8,7 +8,8 @@ class A {',
    ' ctx1',
    ' ctx2',
    ' ctx3',
    '-    return x.length();',
    '+    if (x == null) return 0;',
    '+    return x.length();',
    ' ctx4',
    ' ctx5',
    ' ctx6',
    '@@ -20,0 +22,2 @@',
    '+inserted1',
    '+inserted2',
    '@@ -30,2 +31,0 @@',
    '-gone1',
    '-gone2',
  ]);
  assert.equal(commits.length, 1);
  const c = commits[0];
  assert.equal(c.message, 'Fix NPE in parser\n\nLonger body');
  assert.deepEqual(c.parents, ['b'.repeat(40)]);
  assert.equal(c.author.name, 'Alice');
  assert.equal(c.committer.email, 'bob@example.com');
  assert.equal(c.url, `https://github.com/o/r/commit/${'a'.repeat(40)}`);
  assert.equal(c.files.length, 1);
  const f = c.files[0];
  assert.equal(f.status, 'modified');
  assert.equal(f.oldPath, 'src/A.java');
  assert.equal(f.newPath, 'src/A.java');
  assert.deepEqual(f.changes, [
    {
      type: 'modified',
      oldStart: 11,
      oldLines: 1,
      newStart: 11,
      newLines: 2,
      deletedCode: ['    return x.length();'],
      addedCode: ['    if (x == null) return 0;', '    return x.length();'],
    },
    { type: 'added', oldStart: 20, oldLines: 0, newStart: 22, newLines: 2, deletedCode: [], addedCode: ['inserted1', 'inserted2'] },
    { type: 'deleted', oldStart: 30, oldLines: 2, newStart: 31, newLines: 0, deletedCode: ['gone1', 'gone2'], addedCode: [] },
  ]);
  assert.deepEqual(c.stats, { filesChanged: 1, linesAdded: 4, linesDeleted: 3, addedBlocks: 1, deletedBlocks: 1, modifiedBlocks: 1 });
});

test('separate blocks inside one hunk are split at context lines', () => {
  const [c] = parse([
    ...header('1'.repeat(40), '', 'msg'),
    'diff --git a/x b/x',
    '--- a/x',
    '+++ b/x',
    '@@ -1,5 +1,5 @@',
    '-a',
    '+A',
    ' b',
    ' c',
    '-d',
    '+D',
    ' e',
  ]);
  assert.deepEqual(
    c.files[0].changes.map((x) => [x.type, x.oldStart, x.newStart]),
    [
      ['modified', 1, 1],
      ['modified', 4, 4],
    ],
  );
});

test('code lines that look like diff headers are kept as code', () => {
  const [c] = parse([
    ...header('2'.repeat(40), '', 'msg'),
    'diff --git a/sql.txt b/sql.txt',
    '--- a/sql.txt',
    '+++ b/sql.txt',
    '@@ -1,2 +1,2 @@',
    '--- a comment',
    '-diff --git a/fake b/fake',
    '+++ b/not a header',
    '+@@ -1 +1 @@',
  ]);
  assert.equal(c.files.length, 1);
  assert.deepEqual(c.files[0].changes[0].deletedCode, ['-- a comment', 'diff --git a/fake b/fake']);
  assert.deepEqual(c.files[0].changes[0].addedCode, ['++ b/not a header', '@@ -1 +1 @@']);
});

test('added, deleted, renamed, binary and odd paths', () => {
  const [c] = parse([
    ...header('3'.repeat(40), '4'.repeat(40), 'many files'),
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,2 @@',
    '+one',
    '+two',
    '\\ No newline at end of file',
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    '--- a/old.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/a/Old.java b/b/New.java',
    'similarity index 90%',
    'rename from a/Old.java',
    'rename to b/New.java',
    '--- a/a/Old.java',
    '+++ b/b/New.java',
    '@@ -3 +3 @@',
    '-class Old {',
    '+class New {',
    'diff --git a/pure/Rename.java b/pure/Renamed.java',
    'similarity index 100%',
    'rename from pure/Rename.java',
    'rename to pure/Renamed.java',
    'diff --git a/img.png b/img.png',
    'index 1..2 100644',
    'Binary files a/img.png and b/img.png differ',
    'diff --git a/with space.txt b/with space.txt',
    '--- a/with space.txt\t',
    '+++ b/with space.txt\t',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    'diff --git "a/tab\\there.txt" "b/tab\\there.txt"',
    '--- "a/tab\\there.txt"',
    '+++ "b/tab\\there.txt"',
    '@@ -1 +1 @@',
    '-crlf\r',
    '+CRLF\r',
    'diff --git a/한글.java b/한글.java',
    '--- a/한글.java',
    '+++ b/한글.java',
    '@@ -1 +1 @@',
    '-가',
    '+나',
  ]);
  assert.deepEqual(
    c.files.map((f) => [f.status, f.oldPath, f.newPath]),
    [
      ['added', null, 'new.txt'],
      ['deleted', 'old.txt', null],
      ['renamed', 'a/Old.java', 'b/New.java'],
      ['modified', 'with space.txt', 'with space.txt'],
      ['modified', 'tab\there.txt', 'tab\there.txt'],
      ['modified', '한글.java', '한글.java'],
    ],
  );
  assert.deepEqual(c.files[0].changes[0], {
    type: 'added',
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: 2,
    deletedCode: [],
    addedCode: ['one', 'two'],
  });
  assert.deepEqual(c.files[1].changes[0], {
    type: 'deleted',
    oldStart: 1,
    oldLines: 1,
    newStart: 0,
    newLines: 0,
    deletedCode: ['bye'],
    addedCode: [],
  });
  assert.deepEqual(c.files[4].changes[0].deletedCode, ['crlf']);
  assert.deepEqual(c.files[4].changes[0].addedCode, ['CRLF']);
});

test('several commits, empty message, message without trailing newline, commit without diff', () => {
  const lines = [
    ...header('5'.repeat(40), '', ''),
    'diff --git a/x b/x',
    '--- a/x',
    '+++ b/x',
    '@@ -1 +1 @@',
    '-1',
    '+2',
    `\x00\x01COMMIT\x00${'6'.repeat(40)}\x00\x00A\x00a@x\x00d\x00C\x00c@x\x00d`,
    '\x00\x01MSG',
    'subject only\x00\x01ENDMSG',
    '',
    `\x00\x01COMMIT\x00${'7'.repeat(40)}\x00${'5'.repeat(40)} ${'6'.repeat(40)}\x00A\x00a@x\x00d\x00C\x00c@x\x00d`,
    '\x00\x01MSG',
    'line1',
    '',
    '',
    '\x00\x01ENDMSG',
  ];
  const commits = parse(lines);
  assert.equal(commits.length, 3);
  assert.equal(commits[0].message, '');
  assert.equal(commits[0].files[0].changes[0].type, 'modified');
  assert.equal(commits[1].message, 'subject only');
  assert.equal(commits[1].files.length, 0);
  assert.equal(commits[2].message, 'line1');
  assert.equal(commits[2].parents.length, 2);
});

test('header path helpers', () => {
  assert.equal(parseHeaderPath('/dev/null'), null);
  assert.equal(parseHeaderPath('a/x y.txt\t'), 'a/x y.txt');
  assert.equal(unquoteCString('"a/\\355\\225\\234.txt"'), 'a/한.txt');
  assert.equal(unquoteCString('"q\\"uote\\\\back"'), 'q"uote\\back');
  assert.equal(unquoteCString('"emoji 😀"'), 'emoji 😀');
});
