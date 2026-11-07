import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { after, before, test } from 'node:test';
import { analyzeWithPmd, pmdOutputFile } from '../core/analyzeWithPmd';
import { collectCommitChanges } from '../core/collector';
import { parseRepositoryInput } from '../core/githubUrl';
import { MavenArtifact } from '../core/pmdArtifacts';
import { installPmd, isPmdInstalled, locatePmd, pmdInstallDir } from '../core/pmdInstaller';
import { ALL_RULES, BUNDLED_ALL_RULES, fileKey, parsePmdReport, resolveRuleset } from '../core/pmdRunner';

let tmp: string;
before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'warnpriority-pmd-test-'));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test('parsePmdReport reads violations and parse errors', () => {
  const report = parsePmdReport(
    JSON.stringify({
      pmdVersion: '7.29.0',
      files: [
        {
          filename: '/x/after/A.java',
          violations: [{ beginline: 3, endline: 4, description: 'Avoid x', rule: 'R', ruleset: 'Error Prone', priority: 2 }],
        },
      ],
      processingErrors: [{ filename: '/x/before/A.java', message: 'ParseException: oops\nstack' }],
    }),
  );
  assert.equal(report.pmdVersion, '7.29.0');
  assert.deepEqual(report.warnings.get(fileKey('/x/after/A.java')), [
    { rule: 'R', ruleset: 'Error Prone', priority: 2, line: 3, endLine: 4, message: 'Avoid x' },
  ]);
  assert.equal(report.errors.get(fileKey('/x/before/A.java')), 'ParseException: oops');
  assert.deepEqual(report.ruleErrors, []);
  // A misconfigured rule is reported, not fatal: PMD runs the other rules.
  const withRuleError = parsePmdReport(JSON.stringify({ files: [], configurationErrors: [{ rule: 'LoosePackageCoupling', message: 'No packages' }] }));
  assert.deepEqual(withRuleError.ruleErrors, ['LoosePackageCoupling: No packages']);
});

test('ruleset "all" is the bundled ruleset with every Java category', () => {
  for (const value of ['all', 'ALL', ' all ', '']) {
    assert.equal(resolveRuleset(value), BUNDLED_ALL_RULES, JSON.stringify(value));
  }
  assert.equal(resolveRuleset('category/java/errorprone.xml'), 'category/java/errorprone.xml');
  const xml = readFileSync(BUNDLED_ALL_RULES, 'utf8');
  const categories = [...xml.matchAll(/<rule ref="category\/java\/(\w+)\.xml"/g)].map((m) => m[1]);
  assert.deepEqual(categories, ['bestpractices', 'codestyle', 'design', 'documentation', 'errorprone', 'multithreading', 'performance', 'security']);
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.equal(pkg.contributes.configuration.properties['warnPriority.pmd.ruleset'].default, ALL_RULES);
});

/** Serves `files` (path -> content); paths listed in `fail` answer with the given status. */
async function server(files: Record<string, Buffer>, fail: Record<string, number> = {}): Promise<{ url: string; close: () => void; hits: string[] }> {
  const hits: string[] = [];
  const s = http.createServer((req, res) => {
    const p = (req.url ?? '').replace(/^\//, '');
    hits.push(p);
    if (fail[p] || fail['*']) {
      res.writeHead(fail[p] ?? fail['*']).end('rate limited');
    } else if (files[p]) {
      res.writeHead(200).end(files[p]);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/`, close: () => s.close(), hits };
}

const jar = (name: string) => Buffer.from(`fake jar ${name}`);
const artifact = (p: string, content: Buffer): MavenArtifact => ({
  path: p,
  sha256: createHash('sha256').update(content).digest('hex'),
  size: content.length,
});

test('installPmd downloads, verifies and falls back to the mirror', async () => {
  const files = { 'g/pmd-java/1/pmd-java-1.jar': jar('java'), 'g/pmd-core/1/pmd-core-1.jar': jar('core') };
  const artifacts = Object.entries(files).map(([p, c]) => artifact(p, c));
  const central = await server({}, { '*': 429 });
  const mirror = await server(files);
  try {
    const storage = path.join(tmp, 'install-ok');
    let progressSeen = 0;
    const loc = await installPmd(storage, {
      artifacts,
      repositories: [central.url, mirror.url],
      retryDelayMs: 1,
      onProgress: (done) => (progressSeen = done),
    });
    assert.equal(loc.classpath, path.join(pmdInstallDir(storage), 'lib', '*'));
    assert.deepEqual(readdirSync(path.join(pmdInstallDir(storage), 'lib')).sort(), ['pmd-core-1.jar', 'pmd-java-1.jar']);
    assert.equal(progressSeen, artifacts.reduce((n, a) => n + a.size, 0));
    assert.ok(central.hits.length >= 2, 'Maven Central was tried first');
    assert.equal(await isPmdInstalled(storage), true);
    assert.deepEqual(await locatePmd('', storage), loc);
  } finally {
    central.close();
    mirror.close();
  }
});

test('installPmd rejects a jar with a wrong checksum and leaves nothing installed', async () => {
  const good = jar('x');
  const tampered = await server({ 'g/x/1/x-1.jar': Buffer.from('tampered') });
  try {
    const storage = path.join(tmp, 'install-bad');
    await assert.rejects(
      installPmd(storage, { artifacts: [artifact('g/x/1/x-1.jar', good)], repositories: [tampered.url], retryDelayMs: 1 }),
      /checksum mismatch/,
    );
    assert.equal(await isPmdInstalled(storage), false);
    assert.equal(existsSync(path.join(pmdInstallDir(storage), 'lib')), false);
    assert.deepEqual(readdirSync(pmdInstallDir(storage)), [], 'no staging folder left behind');
  } finally {
    tampered.close();
  }
});

test('locatePmd uses a configured PMD installation', async () => {
  const home = path.join(tmp, 'pmd-home');
  mkdirSync(path.join(home, 'lib'), { recursive: true });
  await assert.rejects(locatePmd(home, tmp), /No PMD Java module/);
  writeFileSync(path.join(home, 'lib', 'pmd-java-7.0.0.jar'), '');
  assert.equal((await locatePmd(home, tmp))?.classpath, path.join(home, 'lib', '*'));
  assert.equal(await locatePmd('', path.join(tmp, 'nothing-here')), null);
});

/*
 * End to end with the real PMD. Needs Java and a PMD 7 folder (with lib/):
 *   WARNPRIORITY_PMD_HOME=/path/to/pmd-bin-7.x npm test
 */
const pmdHome = process.env.WARNPRIORITY_PMD_HOME;

test('analyzeWithPmd finds the warnings a commit fixed and introduced', { skip: !pmdHome && 'set WARNPRIORITY_PMD_HOME to run' }, async () => {
  const source = path.join(tmp, 'repo');
  mkdirSync(path.join(source, 'src'), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: source,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
  git('init', '-q', '-b', 'main');
  const before = [
    'package p;',
    '',
    'public class A {',
    '    public boolean same(String a, String b) {',
    '        return a == b;',
    '    }',
    '',
    '    public int g() {',
    '        try {',
    '            return Integer.parseInt("1");',
    '        } catch (NumberFormatException e) {',
    '        }',
    '        return 0;',
    '    }',
    '}',
    '',
  ].join('\n');
  writeFileSync(path.join(source, 'src', 'A.java'), before);
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  // Fix the string comparison; add two lines above g() so its (unfixed) empty catch moves down.
  const fixed = before
    .replace('return a == b;', 'return a.equals(b);')
    .replace('    public int g() {', '    // helper\n    // that parses\n    public int g() {');
  writeFileSync(path.join(source, 'src', 'A.java'), fixed);
  git('commit', '-q', '-am', 'fix string comparison');

  const outputDir = path.join(tmp, 'out', 'repo');
  await collectCommitChanges({
    repo: parseRepositoryInput(source),
    keywords: ['fix'],
    caseSensitive: false,
    useRegex: false,
    fileExtensions: ['java'],
    includeMergeCommits: false,
    ignoreWhitespace: false,
    maxCommits: 0,
    outputDir,
    outputFileName: 'result.json',
    cacheDir: path.join(tmp, 'cache'),
    gitPath: 'git',
  });
  const resultFile = path.join(outputDir, 'result.json');
  const result = await analyzeWithPmd({
    resultFile,
    ruleset: ALL_RULES,
    javaPath: process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java',
    pmd: { classpath: path.join(pmdHome!, 'lib', '*'), description: 'test' },
  });
  assert.equal(result.outputFile, pmdOutputFile(resultFile));
  const [entry] = JSON.parse(readFileSync(result.outputFile, 'utf8'));
  const file = entry.files[0];
  assert.equal(file.file, 'src/A.java');
  assert.deepEqual(
    file.removed.map((x: { rule: string; line: number; onChangedLine: boolean }) => [x.rule, x.line, x.onChangedLine]),
    [
      ['CompareObjectsWithEquals', 5, true],
      ['UseEqualsToCompareStrings', 5, true],
    ],
  );
  assert.deepEqual(file.added, []);
  assert.ok(file.unchanged >= 1, 'the empty catch block moved down two lines but is the same warning');
  assert.equal(result.summary.commitsWithWarningChanges, 1);
  assert.equal(result.summary.skippedRules, 0, 'every rule of the bundled ruleset runs without extra configuration');
});
