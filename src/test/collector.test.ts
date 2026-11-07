import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, test } from 'node:test';
import {
  CollectOptions,
  collectCommitChanges,
  defaultOutputFileName,
  projectDirName,
  SOURCE_FILE_EXTENSIONS,
  toPathspecs,
} from '../core/collector';
import { CancelledError } from '../core/git';
import { parseRepositoryInput } from '../core/githubUrl';

/*
 * End-to-end tests against a throwaway local repository (no network needed).
 */

let root: string;
let source: string;
let cacheDir: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Tester',
      GIT_AUTHOR_EMAIL: 'tester@example.com',
      GIT_COMMITTER_NAME: 'Tester',
      GIT_COMMITTER_EMAIL: 'tester@example.com',
    },
  }).toString();
}

function commit(files: Record<string, string | Buffer | null>, message: string): string {
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(source, name);
    if (content === null) {
      git(source, 'rm', '-q', name);
    } else {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
      git(source, 'add', name);
    }
  }
  git(source, 'commit', '-q', '-m', message);
  return git(source, 'rev-parse', 'HEAD').trim();
}

function options(overrides: Partial<CollectOptions>): CollectOptions {
  return {
    repo: parseRepositoryInput(source),
    keywords: [],
    caseSensitive: false,
    useRegex: false,
    fileExtensions: [],
    includeMergeCommits: false,
    ignoreWhitespace: false,
    codeLinesOnly: true,
    maxCommits: 0,
    outputDir: path.join(root, `out-${Math.random().toString(36).slice(2)}`),
    outputFileName: 'result.json',
    cacheDir,
    gitPath: 'git',
    ...overrides,
  };
}

function resultOf(opts: CollectOptions) {
  return JSON.parse(readFileSync(path.join(opts.outputDir, opts.outputFileName), 'utf8'));
}

/** Contents of a saved before/after file, split into lines (index 0 = line 1). */
function savedLines(opts: CollectOptions, sha: string, side: 'before' | 'after', file: string): string[] {
  return readFileSync(path.join(opts.outputDir, sha, side, file), 'utf8').split('\n');
}

function sha(grep: string): string {
  return git(source, 'log', '--format=%H', '-F', `--grep=${grep}`, 'main').trim();
}

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'warnpriority-test-'));
  source = path.join(root, 'source');
  cacheDir = path.join(root, 'cache');
  mkdirSync(source);
  git(source, 'init', '-q', '-b', 'main');

  commit({ 'src/Calc.java': 'class Calc {\n  int div(int a, int b) {\n    return a / b;\n  }\n}\n', 'README.md': '# demo\n' }, 'Initial commit');
  commit(
    { 'src/Calc.java': 'class Calc {\n  int div(int a, int b) {\n    if (b == 0) return 0;\n    return a / b;\n  }\n}\n' },
    'Fix division by zero\n\nCloses #1',
  );
  commit({ 'README.md': '# demo\n\nfixed typo\n' }, 'docs: FIX readme');
  commit({ 'src/util.py': 'def f():\n    return 1\n' }, 'Add util');
  commit({ 'src/util.py': 'def f():\n    return 2\n', 'src/Calc.java': 'class Calc {\n  int div(int a, int b) {\n    if (b == 0) return 0;\n    return a / b;\n  }\n}\n// bugfix note\n' }, 'bugfix: wrong constant');
  commit({ 'src/Old.java': 'class Old {}\n' }, 'Add Old');
  commit({ 'src/Old.java': null }, 'Remove Old (fix build)');
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('collects only commits whose message contains the keyword (case-insensitive)', async () => {
  const opts = options({ keywords: ['fix'] });
  const result = await collectCommitChanges(opts);
  assert.equal(result.cancelled, false);
  assert.equal(result.ref, 'main');
  assert.equal(result.outputFile, path.join(opts.outputDir, 'result.json'));
  assert.equal(result.summary.complete, true);
  assert.equal(result.summary.matchedCommits, 4);

  const data = resultOf(opts);
  assert.ok(Array.isArray(data));
  const messages = data.map((c: { message: string }) => c.message.split('\n')[0]);
  assert.deepEqual(messages, ['Remove Old (fix build)', 'bugfix: wrong constant', 'docs: FIX readme', 'Fix division by zero']);
  assert.deepEqual(data[3].files, [{ file: 'src/Calc.java', diff: [{ type: 'added', before: [], after: [3] }] }]);
  assert.deepEqual(data[0].files, [{ file: 'src/Old.java', diff: [{ type: 'deleted', before: [1], after: [] }] }]);
});

test('result file contains sha, parent, author, message and per-file line numbers only', async () => {
  const opts = options({ keywords: ['bugfix'] });
  await collectCommitChanges(opts);
  const commitSha = sha('bugfix');
  assert.deepEqual(resultOf(opts), [
    {
      sha: commitSha,
      parent: git(source, 'rev-parse', `${commitSha}^`).trim(),
      author: 'Tester <tester@example.com>',
      message: 'bugfix: wrong constant',
      // The Calc.java change of this commit only added the comment "// bugfix note".
      files: [{ file: 'src/util.py', diff: [{ type: 'modified', before: [2], after: [2] }] }],
    },
  ]);
  // Diff blocks are written on one line each.
  assert.match(readFileSync(path.join(opts.outputDir, 'result.json'), 'utf8'), /\{ "type": "modified", "before": \[2\], "after": \[2\] \}/);
});

test('saves the changed files before/after the commit in a folder named by the commit hash', async () => {
  const opts = options({ keywords: ['bugfix'] });
  const result = await collectCommitChanges(opts);
  const commitSha = sha('bugfix');
  const parent = git(source, 'rev-parse', `${commitSha}^`).trim();
  assert.deepEqual(readdirSync(opts.outputDir).sort(), [commitSha, 'result.json']);
  assert.deepEqual(readdirSync(path.join(opts.outputDir, commitSha)).sort(), ['after', 'before']);
  assert.equal(result.summary.savedFiles, 2);

  const file = 'src/util.py';
  assert.equal(readFileSync(path.join(opts.outputDir, commitSha, 'before', file), 'utf8'), git(source, 'show', `${parent}:${file}`));
  assert.equal(readFileSync(path.join(opts.outputDir, commitSha, 'after', file), 'utf8'), git(source, 'show', `${commitSha}:${file}`));
  // Calc.java only got a comment in this commit: no copy is saved for it.
  assert.ok(!existsSync(path.join(opts.outputDir, commitSha, 'after', 'src/Calc.java')));
  // The JSON line numbers point at the changed lines of these files.
  assert.equal(savedLines(opts, commitSha, 'before', 'src/util.py')[2 - 1], '    return 1');
  assert.equal(savedLines(opts, commitSha, 'after', 'src/util.py')[2 - 1], '    return 2');
});

test('added files only get an after/ copy, deleted files only a before/ copy', async () => {
  const opts = options({ keywords: ['Initial commit', 'Remove Old'] });
  const result = await collectCommitChanges(opts);
  const initial = sha('Initial commit');
  const removal = sha('Remove Old');
  assert.deepEqual(readdirSync(path.join(opts.outputDir, initial)), ['after']);
  assert.deepEqual(readdirSync(path.join(opts.outputDir, removal)), ['before']);
  assert.equal(readFileSync(path.join(opts.outputDir, removal, 'before', 'src/Old.java'), 'utf8'), 'class Old {}\n');
  assert.equal(result.summary.savedFiles, 3); // README.md + Calc.java after, Old.java before
});

test('root commit has a null parent', async () => {
  const opts = options({ keywords: ['Initial commit'] });
  await collectCommitChanges(opts);
  const [initial] = resultOf(opts);
  assert.equal(initial.parent, null);
  assert.deepEqual(
    initial.files.map((f: { file: string }) => f.file),
    ['README.md', 'src/Calc.java'],
  );
});

test('multiple keywords are OR-ed, and case sensitivity can be turned on', async () => {
  const opts = options({ keywords: ['Fix', 'constant'], caseSensitive: true });
  await collectCommitChanges(opts);
  const messages = resultOf(opts).map((c: { message: string }) => c.message.split('\n')[0]);
  assert.deepEqual(messages, ['bugfix: wrong constant', 'Fix division by zero']);
});

test('file extension filter limits files and drops commits without matching files', async () => {
  const opts = options({ keywords: ['fix'], fileExtensions: ['.JAVA'] });
  await collectCommitChanges(opts);
  const data = resultOf(opts);
  const files = data.flatMap((c: { files: { file: string }[] }) => c.files.map((f) => f.file));
  // "bugfix: wrong constant" only added a comment to Calc.java, so it has no Java code change.
  assert.deepEqual(files, ['src/Old.java', 'src/Calc.java']);
  assert.ok(!data.some((c: { message: string }) => c.message.includes('readme')));
});

test('the default extension list keeps source files and skips docs', async () => {
  const opts = options({ keywords: ['fix'], fileExtensions: [...SOURCE_FILE_EXTENSIONS] });
  await collectCommitChanges(opts);
  const data = resultOf(opts);
  const files = data.flatMap((c: { files: { file: string }[] }) => c.files.map((f) => f.file));
  assert.deepEqual(files, ['src/Old.java', 'src/util.py', 'src/Calc.java']);
  assert.ok(!data.some((c: { message: string }) => c.message.includes('readme')), 'README-only commit dropped');
});

test('package.json default for warnPriority.fileExtensions matches SOURCE_FILE_EXTENSIONS', () => {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.deepEqual(pkg.contributes.configuration.properties['warnPriority.fileExtensions'].default, [...SOURCE_FILE_EXTENSIONS]);
});

test('regex keywords and max commit limit', async () => {
  const opts = options({ keywords: ['^(fix|bugfix)'], useRegex: true, maxCommits: 1 });
  await collectCommitChanges(opts);
  const data = resultOf(opts);
  assert.equal(data.length, 1);
  assert.equal(data[0].message, 'bugfix: wrong constant');
});

test('no matching commit writes nothing', async () => {
  const opts = options({ keywords: ['no-such-keyword-xyz'] });
  const result = await collectCommitChanges(opts);
  assert.equal(result.outputFile, null);
  assert.equal(existsSync(opts.outputDir), false);
});

test('a cached clone is reused and updated with new commits', async () => {
  const clonesBefore = readdirSync(cacheDir).length;
  commit({ 'src/New.java': 'class New {}\n' }, 'Fix: add New');
  const opts = options({ keywords: ['add new'] });
  await collectCommitChanges(opts);
  assert.equal(readdirSync(cacheDir).length, clonesBefore);
  assert.equal(resultOf(opts)[0].message, 'Fix: add New');
});

test('ref from a /tree/ URL selects the branch', async () => {
  git(source, 'checkout', '-q', '-b', 'feature/x');
  commit({ 'src/Feature.java': 'class Feature {}\n' }, 'fix on feature branch');
  git(source, 'checkout', '-q', 'main');
  const repo = { ...parseRepositoryInput(source), refHint: 'feature/x/src/Feature.java' };
  const opts = options({ repo, keywords: ['feature branch'] });
  const result = await collectCommitChanges(opts);
  assert.equal(result.ref, 'feature/x');
  assert.equal(resultOf(opts).length, 1);
});

test('cancellation before start throws CancelledError', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(collectCommitChanges(options({ signal: controller.signal })), CancelledError);
});

test('unknown repository gives a readable error and leaves no cache entry', async () => {
  const repo = parseRepositoryInput(path.join(root, 'does-not-exist'));
  await assert.rejects(collectCommitChanges(options({ repo })), /Could not clone/);
  assert.ok(!readdirSync(cacheDir).some((d) => d.includes('does-not-exist')));
});

test('renamed files keep the old path; before/ uses it', async () => {
  const renamedContent = readFileSync(path.join(source, 'src/Calc.java'), 'utf8').replace('class Calc {', 'class Calculator {');
  commit({ 'src/Calc.java': null, 'src/Calculator.java': renamedContent }, 'Rename Calc to Calculator');
  const opts = options({ keywords: ['Rename Calc'] });
  await collectCommitChanges(opts);
  const [entry] = resultOf(opts);
  assert.deepEqual(entry.files, [
    { file: 'src/Calculator.java', oldFile: 'src/Calc.java', diff: [{ type: 'modified', before: [1], after: [1] }] },
  ]);
  assert.equal(savedLines(opts, entry.sha, 'before', 'src/Calc.java')[0], 'class Calc {');
  assert.equal(savedLines(opts, entry.sha, 'after', 'src/Calculator.java')[0], 'class Calculator {');
});

test('changes to comments and blank lines are not recorded; code lines are, without blank lines', async () => {
  commit({ 'src/Comments.java': 'class Comments {\n  int f() {\n    return 1;\n  }\n}\n' }, 'add Comments');
  commit(
    {
      'src/Comments.java':
        '/** Docs for Comments. */\nclass Comments {\n  // explain f\n\n  int f() {\n    return 1; // the answer\n  }\n}\n',
    },
    'comment-only change',
  );
  commit(
    {
      'src/Comments.java':
        '/** Docs for Comments. */\nclass Comments {\n  // explain f\n\n  int f() {\n    log("f called"); // trace\n\n    return 2; // the answer\n  }\n}\n',
    },
    'mixed change',
  );

  // Only comments and a blank line changed: nothing is recorded, not even an empty folder.
  const commentOnly = options({ keywords: ['comment-only change'] });
  const r1 = await collectCommitChanges(commentOnly);
  assert.equal(r1.outputFile, null);
  assert.equal(r1.summary.matchedCommits, 1);
  assert.equal(r1.summary.commitsWithCodeChanges, 0);
  assert.ok(r1.summary.skippedNonCodeChanges > 0);
  assert.equal(existsSync(commentOnly.outputDir), false);

  // Code lines are recorded; the blank line 7 inside the block is not.
  const mixed = options({ keywords: ['mixed change'] });
  await collectCommitChanges(mixed);
  const [entry] = resultOf(mixed);
  assert.deepEqual(entry.files, [{ file: 'src/Comments.java', diff: [{ type: 'modified', before: [6], after: [6, 8] }] }]);
  assert.equal(savedLines(mixed, entry.sha, 'after', 'src/Comments.java')[8 - 1], '    return 2; // the answer');

  // With codeLinesOnly off every changed line is recorded.
  const raw = options({ keywords: ['comment-only change'], codeLinesOnly: false });
  await collectCommitChanges(raw);
  assert.deepEqual(resultOf(raw)[0].files[0].diff.length > 0, true);
});

test('odd file names and non-UTF-8 / CRLF content are saved byte for byte', async () => {
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a, 0x78, 0x0d, 0x0a]); // "café\r\nx\r\n" in Latin-1
  commit({ 'dir with space/파일 이름.txt': 'one\ntwo\n', 'latin1.txt': latin1 }, 'odd-paths base');
  commit({ 'dir with space/파일 이름.txt': 'one\nTWO\n', 'latin1.txt': Buffer.concat([latin1, Buffer.from('y\r\n')]) }, 'odd-paths change');
  const opts = options({ keywords: ['odd-paths change'] });
  await collectCommitChanges(opts);
  const [entry] = resultOf(opts);
  assert.deepEqual(
    entry.files.map((f: { file: string; diff: unknown }) => [f.file, f.diff]),
    [
      ['dir with space/파일 이름.txt', [{ type: 'modified', before: [2], after: [2] }]],
      ['latin1.txt', [{ type: 'added', before: [], after: [3] }]],
    ],
  );
  const dir = path.join(opts.outputDir, entry.sha);
  assert.deepEqual(readFileSync(path.join(dir, 'before', 'latin1.txt')), latin1);
  assert.deepEqual(readFileSync(path.join(dir, 'after', 'latin1.txt')), Buffer.concat([latin1, Buffer.from('y\r\n')]));
  assert.equal(readFileSync(path.join(dir, 'after', 'dir with space', '파일 이름.txt'), 'utf8'), 'one\nTWO\n');
});

test('helpers', () => {
  assert.deepEqual(toPathspecs(['java', '.py', '*.kt', ' ', 'java']), [':(icase)*.java', ':(icase)*.py', ':(icase)*.kt']);
  const name = defaultOutputFileName(parseRepositoryInput('https://github.com/o/r'), ['fix', 'bug/x'], new Date(2024, 0, 2, 3, 4, 5));
  assert.equal(name, 'o_r_fix-bug_x_20240102-030405.json');
  assert.equal(projectDirName(parseRepositoryInput('https://github.com/google/gson')), 'google_gson');
  assert.equal(projectDirName(parseRepositoryInput('https://gitlab.com/group/sub/project')), 'group_sub_project');
});
