import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, test } from 'node:test';
import { CollectOptions, collectCommitChanges, defaultOutputFileName, toPathspecs } from '../core/collector';
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

function commit(files: Record<string, string | null>, message: string): string {
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
    maxCommits: 0,
    outputFile: path.join(root, `out-${Math.random().toString(36).slice(2)}.json`),
    cacheDir,
    gitPath: 'git',
    ...overrides,
  };
}

function readJson(file: string) {
  return JSON.parse(readFileSync(file, 'utf8'));
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
  assert.equal(result.outputFile, opts.outputFile);

  assert.equal(result.summary.complete, true);
  assert.equal(result.summary.matchedCommits, 4);

  const data = readJson(opts.outputFile);
  assert.ok(Array.isArray(data));
  const messages = data.map((c: { message: string }) => c.message.split('\n')[0]);
  assert.deepEqual(messages, ['Remove Old (fix build)', 'bugfix: wrong constant', 'docs: FIX readme', 'Fix division by zero']);

  const fix = data[3];
  assert.deepEqual(fix.files, [{ file: 'src/Calc.java', diff: [{ type: 'added', code: ['    if (b == 0) return 0;'] }] }]);
  assert.deepEqual(data[0].files, [{ file: 'src/Old.java', diff: [{ type: 'deleted', code: ['class Old {}'] }] }]);
});

test('result file contains only sha, parent, author, message and per-file diffs', async () => {
  const opts = options({ keywords: ['bugfix'] });
  await collectCommitChanges(opts);
  const data = readJson(opts.outputFile);
  const sha = git(source, 'log', '--format=%H', '--grep=bugfix', 'main').trim();
  const parent = git(source, 'rev-parse', `${sha}^`).trim();
  assert.deepEqual(data, [
    {
      sha,
      parent,
      author: 'Tester <tester@example.com>',
      message: 'bugfix: wrong constant',
      files: [
        { file: 'src/Calc.java', diff: [{ type: 'added', code: ['// bugfix note'] }] },
        { file: 'src/util.py', diff: [{ type: 'modified', before: ['    return 1'], after: ['    return 2'] }] },
      ],
    },
  ]);
});

test('root commit has a null parent', async () => {
  const opts = options({ keywords: ['Initial commit'] });
  await collectCommitChanges(opts);
  const [initial] = readJson(opts.outputFile);
  assert.equal(initial.parent, null);
  assert.deepEqual(
    initial.files.map((f: { file: string }) => f.file),
    ['README.md', 'src/Calc.java'],
  );
});

test('multiple keywords are OR-ed, and case sensitivity can be turned on', async () => {
  const opts = options({ keywords: ['Fix', 'constant'], caseSensitive: true });
  await collectCommitChanges(opts);
  const messages = readJson(opts.outputFile).map((c: { message: string }) => c.message.split('\n')[0]);
  assert.deepEqual(messages, ['bugfix: wrong constant', 'Fix division by zero']);
});

test('file extension filter limits files and drops commits without matching files', async () => {
  const opts = options({ keywords: ['fix'], fileExtensions: ['.JAVA'] });
  await collectCommitChanges(opts);
  const data = readJson(opts.outputFile);
  const files = data.flatMap((c: { files: { file: string }[] }) => c.files.map((f) => f.file));
  assert.deepEqual(files, ['src/Old.java', 'src/Calc.java', 'src/Calc.java']);
  assert.ok(!data.some((c: { message: string }) => c.message.includes('readme')));
});

test('regex keywords and max commit limit', async () => {
  const opts = options({ keywords: ['^(fix|bugfix)'], useRegex: true, maxCommits: 1 });
  await collectCommitChanges(opts);
  const data = readJson(opts.outputFile);
  assert.equal(data.length, 1);
  assert.equal(data[0].message, 'bugfix: wrong constant');
});

test('no matching commit writes no file', async () => {
  const opts = options({ keywords: ['no-such-keyword-xyz'] });
  const result = await collectCommitChanges(opts);
  assert.equal(result.outputFile, null);
  assert.equal(existsSync(opts.outputFile), false);
});

test('a cached clone is reused and updated with new commits', async () => {
  const clonesBefore = readdirSync(cacheDir).length;
  commit({ 'src/New.java': 'class New {}\n' }, 'Fix: add New');
  const opts = options({ keywords: ['add new'] });
  await collectCommitChanges(opts);
  assert.equal(readdirSync(cacheDir).length, clonesBefore);
  assert.equal(readJson(opts.outputFile)[0].message, 'Fix: add New');
});

test('ref from a /tree/ URL selects the branch', async () => {
  git(source, 'checkout', '-q', '-b', 'feature/x');
  commit({ 'src/Feature.java': 'class Feature {}\n' }, 'fix on feature branch');
  git(source, 'checkout', '-q', 'main');
  const repo = { ...parseRepositoryInput(source), refHint: 'feature/x/src/Feature.java' };
  const opts = options({ repo, keywords: ['feature branch'] });
  const result = await collectCommitChanges(opts);
  assert.equal(result.ref, 'feature/x');
  assert.equal(readJson(opts.outputFile).length, 1);
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

test('helpers', () => {
  assert.deepEqual(toPathspecs(['java', '.py', '*.kt', ' ', 'java']), [':(icase)*.java', ':(icase)*.py', ':(icase)*.kt']);
  const name = defaultOutputFileName(parseRepositoryInput('https://github.com/o/r'), ['fix', 'bug/x'], new Date(2024, 0, 2, 3, 4, 5));
  assert.equal(name, 'o_r_fix-bug_x_20240102-030405.json');
});
