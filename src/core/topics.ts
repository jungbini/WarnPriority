import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import { CancelledError } from './git';

/*
 * Topic modeling runs in Python (BERTopic, sentence-transformers). The script
 * ships with the extension; Python comes from a setting or from a virtual
 * environment the extension creates on first use.
 */

const RESOURCES = path.join(__dirname, '..', '..', 'resources', 'topics');
export const TOPIC_SCRIPT = path.join(RESOURCES, 'topic_model.py');
export const TOPIC_REQUIREMENTS = path.join(RESOURCES, 'requirements.txt');
export const DEFAULT_EMBEDDING_MODEL = 'nomic-ai/CodeRankEmbed';

export type TopicProgress =
  | { stage: 'read'; files: number }
  | { stage: 'model'; model: string }
  | { stage: 'embed'; done: number; total: number }
  | { stage: 'topics' }
  | { stage: 'write' }
  | {
      stage: 'done';
      topics: number;
      files: number;
      /** Test files left out. */
      testFiles: number;
      chunks: number;
      uniqueChunks: number;
      outliers: number;
      /** Distinct chunks in the "Unclassified" column (0 when outliers were assigned to topics). */
      unclassifiedChunks: number;
      /** Device the new embeddings were computed on ("cuda:0", "cpu", ...); null when all came from the cache. */
      device: string | null;
      csv: string;
      keywordsCsv: string;
    };

export type TopicResult = Extract<TopicProgress, { stage: 'done' }>;

export interface TopicModelOptions {
  python: string;
  resultFile: string;
  model?: string;
  minTopicSize?: number;
  extraStopwords?: string[];
  /** Also model test files (left out by default). */
  includeTests?: boolean;
  signal?: AbortSignal;
  /** stderr of the script (model download, BERTopic messages, errors). */
  log?: (line: string) => void;
  onProgress?: (p: TopicProgress) => void;
}

/** Runs topic_model.py on a result JSON; resolves with its final report. */
export async function runTopicModel(opts: TopicModelOptions): Promise<TopicResult> {
  const args = [TOPIC_SCRIPT, opts.resultFile];
  if (opts.model) {
    args.push('--model', opts.model);
  }
  if (opts.minTopicSize) {
    args.push('--min-topic-size', String(opts.minTopicSize));
  }
  const extra = (opts.extraStopwords ?? []).map((w) => w.trim()).filter((w) => w);
  if (extra.length > 0) {
    args.push('--extra-stopwords', extra.join(','));
  }
  if (opts.includeTests) {
    args.push('--include-tests');
  }
  let result: TopicResult | undefined;
  const { code, stderr } = await runPython(opts.python, args, {
    signal: opts.signal,
    onStdout: (line) => {
      const p = parseProgressLine(line);
      if (p) {
        if (p.stage === 'done') {
          result = p;
        }
        opts.onProgress?.(p);
      }
    },
    onStderr: opts.log,
  });
  if (code !== 0 || !result) {
    throw new Error(`Topic modeling failed (exit code ${code}): ${lastMeaningfulLine(stderr)}`);
  }
  return result;
}

export function parseProgressLine(line: string): TopicProgress | null {
  if (!line.startsWith('PROGRESS ')) {
    return null;
  }
  try {
    return JSON.parse(line.slice('PROGRESS '.length)) as TopicProgress;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Managed Python environment
// --------------------------------------------------------------------------

export function topicEnvDir(storageDir: string): string {
  return path.join(storageDir, 'python-topics');
}

export function venvPython(venv: string): string {
  return process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
}

async function requirementsHash(): Promise<string> {
  return createHash('sha256').update(await fs.readFile(TOPIC_REQUIREMENTS)).digest('hex').slice(0, 16);
}

/** What the environment's marker file records. */
interface EnvMarker {
  requirements: string;
  /** "cuda" | "cpu", or "unknown" for environments created before 0.11.0. */
  torch: 'cuda' | 'cpu' | 'unknown';
}

async function readMarker(venv: string): Promise<EnvMarker | null> {
  const text = (await fs.readFile(path.join(venv, '.complete'), 'utf8').catch(() => '')).trim();
  if (!text) {
    return null;
  }
  try {
    const m = JSON.parse(text) as EnvMarker;
    return { requirements: m.requirements, torch: m.torch ?? 'unknown' };
  } catch {
    return { requirements: text, torch: 'unknown' }; // before 0.11.0 the marker held only the requirements hash
  }
}

async function writeMarker(venv: string, torch: EnvMarker['torch']): Promise<void> {
  const marker: EnvMarker = { requirements: await requirementsHash(), torch };
  await fs.writeFile(path.join(venv, '.complete'), JSON.stringify(marker) + '\n');
}

export interface ManagedPython {
  python: string;
  torch: EnvMarker['torch'];
}

/** The managed environment if it is set up for the current requirements, else null. */
export async function managedPython(storageDir: string): Promise<ManagedPython | null> {
  const venv = topicEnvDir(storageDir);
  const marker = await readMarker(venv);
  if (!marker || marker.requirements !== (await requirementsHash()) || !existsSync(venvPython(venv))) {
    return null;
  }
  return { python: venvPython(venv), torch: marker.torch };
}

// --------------------------------------------------------------------------
// GPU detection and PyTorch builds
// --------------------------------------------------------------------------

export interface GpuInfo {
  name: string;
  /** Highest CUDA version the installed NVIDIA driver supports, e.g. "13.2". */
  cudaVersion: string;
}

/** An NVIDIA GPU with a working driver (via nvidia-smi), or null. */
export async function detectNvidiaGpu(signal?: AbortSignal): Promise<GpuInfo | null> {
  try {
    let table = '';
    let names = '';
    const a = await runPython('nvidia-smi', [], { signal, onStdout: (l) => (table += l + '\n') });
    const b = await runPython('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { signal, onStdout: (l) => (names += l + '\n') });
    return a.code === 0 && b.code === 0 ? parseNvidiaSmi(table, names) : null;
  } catch (e) {
    if (e instanceof CancelledError) {
      throw e;
    }
    return null; // no nvidia-smi: no NVIDIA driver
  }
}

export function parseNvidiaSmi(table: string, names: string): GpuInfo | null {
  const cuda = /CUDA Version:\s*(\d+\.\d+)/.exec(table);
  const name = names.split(/\r?\n/).map((l) => l.trim()).find((l) => l);
  return cuda && name ? { name, cudaVersion: cuda[1] } : null;
}

/** PyTorch's package index; CUDA builds are under <index>/<tag>. */
export const PYTORCH_INDEX = 'https://download.pytorch.org/whl/';

/**
 * CUDA builds of PyTorch to try, newest first (each has Windows and Linux
 * wheels): tag, CUDA version it needs, newest PyTorch it offers. Builds
 * whose newest PyTorch is older than a later entry's are left out.
 */
export const CUDA_BUILDS: readonly { tag: string; cuda: string; torch: string }[] = [
  { tag: 'cu134', cuda: '13.4', torch: '2.15' },
  { tag: 'cu132', cuda: '13.2', torch: '2.15' },
  { tag: 'cu130', cuda: '13.0', torch: '2.14' },
  { tag: 'cu126', cuda: '12.6', torch: '2.14' },
  { tag: 'cu118', cuda: '11.8', torch: '2.7' },
];

/** The CUDA builds a driver supporting `driverCuda` can run, in the order to try them. */
export function cudaBuildsFor(driverCuda: string): string[] {
  const v = (s: string) => s.split('.').map(Number);
  const [dMajor, dMinor] = v(driverCuda);
  return CUDA_BUILDS.filter((b) => {
    const [major, minor] = v(b.cuda);
    return major < dMajor || (major === dMajor && minor <= dMinor);
  }).map((b) => b.tag);
}

export interface TorchInfo {
  version: string;
  /** CUDA version PyTorch was built with; null for a CPU build. */
  cuda: string | null;
  gpuAvailable: boolean;
}

/** The PyTorch installed in `python`, or null when there is none. */
export async function torchInfo(python: string, signal?: AbortSignal): Promise<TorchInfo | null> {
  let out = '';
  const { code } = await runPython(
    python,
    ['-c', 'import json, torch; print(json.dumps({"version": torch.__version__, "cuda": torch.version.cuda, "gpuAvailable": torch.cuda.is_available()}))'],
    { signal, onStdout: (l) => (out += l) },
  );
  if (code !== 0) {
    return null;
  }
  try {
    return JSON.parse(out) as TorchInfo;
  } catch {
    return null;
  }
}

export function describeTorch(t: TorchInfo | null): string {
  return t ? `PyTorch ${t.version} (${t.cuda ? `CUDA ${t.cuda}` : 'CPU build'}${t.gpuAvailable ? ', GPU available' : ''})` : 'no PyTorch';
}

/** Installs the newest CUDA build the driver supports; returns its tag, or null if none could be installed. */
async function installCudaTorch(python: string, gpu: GpuInfo, opts: SetupOptions): Promise<string | null> {
  const builds = cudaBuildsFor(gpu.cudaVersion);
  if (builds.length === 0) {
    opts.log?.(`WARNING: the NVIDIA driver supports CUDA ${gpu.cudaVersion}; PyTorch's CUDA builds need 11.8 or newer. Update the driver to use the GPU.`);
    return null;
  }
  for (const tag of builds) {
    opts.log?.(`Installing the PyTorch CUDA build ${tag} for ${gpu.name} (driver CUDA ${gpu.cudaVersion})`);
    // Only PyTorch's index: with PyPI as an extra index, pip could prefer a newer CPU build from PyPI.
    const { code } = await runPython(python, ['-m', 'pip', 'install', 'torch', '--index-url', PYTORCH_INDEX + tag], {
      signal: opts.signal,
      onStdout: opts.log,
      onStderr: opts.log,
    });
    if (code === 0) {
      return tag;
    }
    opts.log?.(`PyTorch build ${tag} could not be installed (e.g. none for this Python version); trying the next one`);
  }
  return null;
}

export interface SetupOptions {
  signal?: AbortSignal;
  log?: (line: string) => void;
  onStep?: (step: 'venv' | 'torch' | 'packages') => void;
}

/**
 * Creates <storage>/python-topics (a virtual environment) and installs the
 * packages. With an NVIDIA GPU, PyTorch's CUDA build is installed first (the
 * PyTorch on PyPI is CPU-only on Windows), then requirements.txt, which then
 * keeps that PyTorch. Needs Python 3.9+ on the machine.
 */
export async function setupManagedPython(storageDir: string, gpu: GpuInfo | null, opts: SetupOptions = {}): Promise<string> {
  const base = await findBasePython(opts.signal);
  opts.log?.(`Using ${base.description} to create the environment`);
  const venv = topicEnvDir(storageDir);
  await fs.rm(venv, { recursive: true, force: true });
  await fs.mkdir(path.dirname(venv), { recursive: true });

  opts.onStep?.('venv');
  await check(runPython(base.command, [...base.args, '-m', 'venv', venv], { signal: opts.signal, onStdout: opts.log, onStderr: opts.log }), 'Creating the Python environment');
  const python = venvPython(venv);
  await check(runPython(python, ['-m', 'pip', 'install', '--upgrade', 'pip'], { signal: opts.signal, onStdout: opts.log, onStderr: opts.log }), 'Updating pip');
  if (gpu) {
    opts.onStep?.('torch');
    await installCudaTorch(python, gpu, opts);
  }
  opts.onStep?.('packages');
  await installRequirements(python, opts);
  return finish(venv, python, opts);
}

/**
 * Replaces the CPU build of PyTorch in the managed environment with the CUDA
 * build: the CPU build is uninstalled first. If no CUDA build can be
 * installed, the CPU build is put back so the environment keeps working.
 */
export async function switchManagedTorchToCuda(storageDir: string, gpu: GpuInfo, opts: SetupOptions = {}): Promise<TorchInfo | null> {
  const venv = topicEnvDir(storageDir);
  const python = venvPython(venv);
  opts.onStep?.('torch');
  opts.log?.('Uninstalling the CPU build of PyTorch');
  await check(runPython(python, ['-m', 'pip', 'uninstall', '-y', 'torch'], { signal: opts.signal, onStdout: opts.log, onStderr: opts.log }), 'Uninstalling PyTorch');
  const tag = await installCudaTorch(python, gpu, opts);
  if (!tag) {
    opts.log?.('WARNING: no CUDA build of PyTorch could be installed; putting the CPU build back');
  }
  opts.onStep?.('packages');
  await installRequirements(python, opts); // reinstalls the CPU build if needed; otherwise keeps the CUDA build
  await finish(venv, python, opts);
  return torchInfo(python, opts.signal);
}

/** Records the PyTorch build of an existing environment (e.g. one created before 0.11.0). */
export async function recordManagedTorch(storageDir: string, info: TorchInfo | null): Promise<void> {
  await writeMarker(topicEnvDir(storageDir), info?.cuda ? 'cuda' : info ? 'cpu' : 'unknown');
}

async function installRequirements(python: string, opts: SetupOptions): Promise<void> {
  await check(
    runPython(python, ['-m', 'pip', 'install', '-r', TOPIC_REQUIREMENTS], { signal: opts.signal, onStdout: opts.log, onStderr: opts.log }),
    'Installing the topic modeling packages',
  );
}

async function finish(venv: string, python: string, opts: SetupOptions): Promise<string> {
  const info = await torchInfo(python, opts.signal);
  opts.log?.(`Environment ready: ${describeTorch(info)}`);
  await writeMarker(venv, info?.cuda ? 'cuda' : 'cpu');
  return python;
}

async function check(run: Promise<{ code: number | null; stderr: string }>, what: string): Promise<void> {
  const { code, stderr } = await run;
  if (code !== 0) {
    throw new Error(`${what} failed (exit code ${code}): ${lastMeaningfulLine(stderr)}`);
  }
}

/** A Python 3.9+ interpreter on PATH ("py -3" on Windows, then python3, then python). */
export async function findBasePython(signal?: AbortSignal): Promise<{ command: string; args: string[]; description: string }> {
  const candidates: [string, string[]][] = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [command, args] of candidates) {
    try {
      let out = '';
      const { code } = await runPython(command, [...args, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], {
        signal,
        onStdout: (l) => (out += l),
      });
      const [major, minor] = out.trim().split('.').map(Number);
      if (code === 0 && (major > 3 || (major === 3 && minor >= 9))) {
        return { command, args, description: `${[command, ...args].join(' ')} (Python ${out.trim()})` };
      }
    } catch (e) {
      if (e instanceof CancelledError) {
        throw e;
      }
      // not installed; try the next one
    }
  }
  throw new Error('Python 3.9 or newer was not found. Install Python, or set warnPriority.topics.pythonPath to a Python with BERTopic and sentence-transformers.');
}

// --------------------------------------------------------------------------

interface RunOptions {
  signal?: AbortSignal;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}

function runPython(command: string, args: string[], opts: RunOptions): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', TOKENIZERS_PARALLELISM: 'false' },
    });
    let stderr = '';
    const lines = (onLine?: (l: string) => void, keep?: (t: string) => void) => {
      let pending = '';
      return (chunk: Buffer) => {
        const text = pending + chunk.toString('utf8');
        keep?.(chunk.toString('utf8'));
        const parts = text.split(/\r?\n|\r/);
        pending = parts.pop() ?? '';
        for (const l of parts) {
          if (l.trim()) {
            onLine?.(l);
          }
        }
      };
    };
    child.stdout.on('data', lines(opts.onStdout));
    child.stderr.on('data', lines(opts.onStderr, (t) => (stderr = (stderr + t).slice(-16 * 1024))));
    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e: NodeJS.ErrnoException) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e.code === 'ENOENT' ? new Error(`Python not found: "${command}"`) : e);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) {
        reject(new CancelledError());
      } else {
        resolve({ code, stderr });
      }
    });
  });
}

function lastMeaningfulLine(text: string): string {
  const lines = text
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\d+%\|/.test(l));
  return lines.slice(-2).join(' | ') || '(no output)';
}
