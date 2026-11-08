import { strict as assert } from 'assert';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { parseProgressLine, TOPIC_REQUIREMENTS, TOPIC_SCRIPT } from '../core/topics';

const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

test('topic_model.py helpers (Python unit tests)', { skip: !python && 'Python not found' }, () => {
  const tests = path.join(__dirname, '..', '..', 'src', 'test', 'python', 'test_topic_model.py');
  const r = spawnSync(python!, ['-m', 'unittest', tests], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('the script and its requirements ship with the extension', () => {
  assert.ok(existsSync(TOPIC_SCRIPT), TOPIC_SCRIPT);
  assert.ok(existsSync(TOPIC_REQUIREMENTS), TOPIC_REQUIREMENTS);
});

test('progress lines', () => {
  assert.deepEqual(parseProgressLine('PROGRESS {"stage":"embed","done":64,"total":128}'), { stage: 'embed', done: 64, total: 128 });
  assert.equal(parseProgressLine('Batches: 100%|####|'), null);
  assert.equal(parseProgressLine('PROGRESS not json'), null);
});
