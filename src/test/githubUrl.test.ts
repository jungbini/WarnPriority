import { strict as assert } from 'assert';
import { test } from 'node:test';
import { parseRepositoryInput } from '../core/githubUrl';

test('plain https GitHub URL', () => {
  const r = parseRepositoryInput('https://github.com/google/gson');
  assert.equal(r.cloneUrl, 'https://github.com/google/gson.git');
  assert.equal(r.webUrl, 'https://github.com/google/gson');
  assert.equal(r.owner, 'google');
  assert.equal(r.name, 'gson');
  assert.equal(r.refHint, null);
});

test('variants of the same repository normalise to the same clone URL', () => {
  for (const input of [
    'https://github.com/google/gson.git',
    'https://github.com/google/gson/',
    '  https://www.github.com/google/gson  ',
    'github.com/google/gson',
    'http://github.com/google/gson',
    'https://github.com/google/gson?tab=readme-ov-file#gson',
    'google/gson',
  ]) {
    assert.equal(parseRepositoryInput(input).cloneUrl, 'https://github.com/google/gson.git', input);
  }
});

test('branch, commit history and file URLs keep the ref as a hint', () => {
  assert.equal(parseRepositoryInput('https://github.com/o/r/tree/main').refHint, 'main');
  assert.equal(parseRepositoryInput('https://github.com/o/r/tree/feature/x').refHint, 'feature/x');
  assert.equal(parseRepositoryInput('https://github.com/o/r/commits/dev').refHint, 'dev');
  assert.equal(parseRepositoryInput('https://github.com/o/r/blob/main/src/A.java').refHint, 'main/src/A.java');
  assert.equal(parseRepositoryInput('https://github.com/o/r/commit/abc1234').refHint, 'abc1234');
  assert.equal(parseRepositoryInput('https://github.com/o/r/issues').refHint, null);
  assert.equal(parseRepositoryInput('https://github.com/o/r/tree/main').cloneUrl, 'https://github.com/o/r.git');
});

test('credentials in the URL are dropped', () => {
  const r = parseRepositoryInput('https://user:secret@github.com/o/r');
  assert.equal(r.cloneUrl, 'https://github.com/o/r.git');
  assert.ok(!JSON.stringify(r).includes('secret'));
});

test('SSH URLs stay SSH but get a web URL', () => {
  const scp = parseRepositoryInput('git@github.com:owner/repo.git');
  assert.equal(scp.cloneUrl, 'git@github.com:owner/repo.git');
  assert.equal(scp.webUrl, 'https://github.com/owner/repo');
  assert.equal(scp.owner, 'owner');
  assert.equal(scp.name, 'repo');

  const ssh = parseRepositoryInput('ssh://git@github.com/owner/repo');
  assert.equal(ssh.cloneUrl, 'ssh://git@github.com/owner/repo.git');
  assert.equal(ssh.webUrl, 'https://github.com/owner/repo');
});

test('other hosts with nested groups', () => {
  const r = parseRepositoryInput('https://gitlab.com/group/sub/project/-/tree/main');
  assert.equal(r.cloneUrl, 'https://gitlab.com/group/sub/project.git');
  assert.equal(r.owner, 'group/sub');
  assert.equal(r.name, 'project');
  assert.equal(r.refHint, 'main');
  assert.equal(parseRepositoryInput('https://ghe.example.com/team/app').cloneUrl, 'https://ghe.example.com/team/app.git');
});

test('local repositories', () => {
  const r = parseRepositoryInput('/tmp/some/repo.git');
  assert.equal(r.cloneUrl, '/tmp/some/repo.git');
  assert.equal(r.name, 'repo');
  assert.equal(r.webUrl, null);
  assert.equal(parseRepositoryInput('file:///tmp/x/').cloneUrl, '/tmp/x');
});

test('invalid inputs are rejected with a message', () => {
  for (const input of ['', '   ', 'https://github.com/', 'https://github.com/onlyowner', 'ftp://github.com/o/r', 'https://github.com/o/r%20x']) {
    assert.throws(() => parseRepositoryInput(input), Error, input);
  }
});
