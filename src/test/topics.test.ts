import { strict as assert } from 'assert';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { cudaBuildsFor, parseNvidiaSmi, parseProgressLine, TOPIC_REQUIREMENTS, TOPIC_SCRIPT } from '../core/topics';

const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

test('topic_model.py helpers (Python unit tests)', { skip: !python && 'Python not found' }, () => {
  const tests = path.join(__dirname, '..', '..', 'src', 'test', 'python', 'test_topic_model.py');
  // No __pycache__ next to the script: it would end up in the .vsix.
  const r = spawnSync(python!, ['-m', 'unittest', tests], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
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

const NVIDIA_SMI = `Sun Nov  8 10:12:03 2026
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 590.44                 Driver Version: 590.44         CUDA Version: 13.2     |
|-----------------------------------------+------------------------+----------------------+
| GPU  Name                  Driver-Model | Bus-Id          Disp.A | Volatile Uncorr. ECC |
|   0  NVIDIA GeForce RTX 3070 Ti   WDDM  |   00000000:01:00.0  On |                  N/A |
+-----------------------------------------------------------------------------------------+`;

test('nvidia-smi output gives the GPU and the CUDA version its driver supports', () => {
  assert.deepEqual(parseNvidiaSmi(NVIDIA_SMI, 'NVIDIA GeForce RTX 3070 Ti\r\n'), { name: 'NVIDIA GeForce RTX 3070 Ti', cudaVersion: '13.2' });
  assert.equal(parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.', ''), null);
});

test('CUDA builds are tried newest first, only those the driver supports', () => {
  assert.deepEqual(cudaBuildsFor('13.4'), ['cu134', 'cu132', 'cu130', 'cu126', 'cu118']);
  assert.deepEqual(cudaBuildsFor('13.2'), ['cu132', 'cu130', 'cu126', 'cu118']);
  assert.deepEqual(cudaBuildsFor('13.0'), ['cu130', 'cu126', 'cu118']);
  assert.deepEqual(cudaBuildsFor('12.8'), ['cu126', 'cu118']);
  assert.deepEqual(cudaBuildsFor('12.4'), ['cu118']);
  assert.deepEqual(cudaBuildsFor('11.4'), []);
});
