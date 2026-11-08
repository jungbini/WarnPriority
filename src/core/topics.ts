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

/** Python of the managed environment if it is set up for the current requirements, else null. */
export async function managedPython(storageDir: string): Promise<string | null> {
  const venv = topicEnvDir(storageDir);
  const marker = await fs.readFile(path.join(venv, '.complete'), 'utf8').catch(() => '');
  return marker.trim() === (await requirementsHash()) && existsSync(venvPython(venv)) ? venvPython(venv) : null;
}

export interface SetupOptions {
  signal?: AbortSignal;
  log?: (line: string) => void;
  onStep?: (step: 'venv' | 'packages') => void;
}

/**
 * Creates <storage>/python-topics (a virtual environment) and installs
 * requirements.txt into it. Needs Python 3.9+ on the machine.
 */
export async function setupManagedPython(storageDir: string, opts: SetupOptions = {}): Promise<string> {
  const base = await findBasePython(opts.signal);
  opts.log?.(`Using ${base.description} to create the environment`);
  const venv = topicEnvDir(storageDir);
  await fs.rm(venv, { recursive: true, force: true });
  await fs.mkdir(path.dirname(venv), { recursive: true });

  opts.onStep?.('venv');
  await check(runPython(base.command, [...base.args, '-m', 'venv', venv], { signal: opts.signal, onStdout: opts.log, onStderr: opts.log }), 'Creating the Python environment');
  const python = venvPython(venv);
  opts.onStep?.('packages');
  await check(runPython(python, ['-m', 'pip', 'install', '--upgrade', 'pip'], { signal: opts.signal, onStdout: opts.log, onStderr: opts.log }), 'Updating pip');
  await check(
    runPython(python, ['-m', 'pip', 'install', '-r', TOPIC_REQUIREMENTS], { signal: opts.signal, onStdout: opts.log, onStderr: opts.log }),
    'Installing the topic modeling packages',
  );
  await fs.writeFile(path.join(venv, '.complete'), (await requirementsHash()) + '\n');
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
