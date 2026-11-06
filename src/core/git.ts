import { spawn, SpawnOptions } from 'child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Operation cancelled.');
    this.name = 'CancelledError';
  }
}

export interface GitContext {
  gitPath: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

/**
 * Environment for git processes.
 *  - never prompt on a terminal (there is none; git would hang),
 *  - untranslated (English) messages.
 * `isolateConfig` additionally ignores the user's global/system git config.
 * That is safe (and makes output deterministic) for purely local commands,
 * but must not be used for clone/fetch, which may need credential helpers.
 */
export function gitEnv(isolateConfig: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    // English progress/error messages (parsed for progress), while keeping the
    // user's LC_CTYPE so case-insensitive matching of non-ASCII keywords works.
    LANGUAGE: 'C',
    LC_MESSAGES: 'C',
  };
  if (isolateConfig) {
    env.GIT_CONFIG_NOSYSTEM = '1';
    // Git for Windows maps the literal "/dev/null" to NUL itself.
    env.GIT_CONFIG_GLOBAL = '/dev/null';
  }
  return env;
}

export interface RunOptions {
  cwd?: string;
  isolateConfig?: boolean;
  /** Called with each stderr chunk (e.g. to parse clone progress). */
  onStderr?: (chunk: string) => void;
}

/** Runs git to completion and returns stdout. Rejects with GitError on non-zero exit. */
export function runGit(ctx: GitContext, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (ctx.signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    ctx.log?.(`> git ${args.join(' ')}`);
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: gitEnv(opts.isolateConfig ?? false),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    const child = spawn(ctx.gitPath, args, spawnOpts);
    const out: Buffer[] = [];
    let err = '';
    const onAbort = () => child.kill();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout!.on('data', (c: Buffer) => out.push(c));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (c: string) => {
      err += c;
      if (err.length > 64 * 1024) {
        err = err.slice(-32 * 1024);
      }
      opts.onStderr?.(c);
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      ctx.signal?.removeEventListener('abort', onAbort);
      if (e.code === 'ENOENT') {
        reject(new GitError(`Git executable not found: "${ctx.gitPath}". Install Git or set "warnPriority.gitPath".`, null, ''));
      } else {
        reject(e);
      }
    });
    child.on('close', (code) => {
      ctx.signal?.removeEventListener('abort', onAbort);
      if (ctx.signal?.aborted) {
        reject(new CancelledError());
      } else if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8'));
      } else {
        reject(new GitError(`git ${args[0]} failed (exit code ${code}): ${lastLines(err)}`, code, err));
      }
    });
  });
}

/**
 * Runs git and yields stdout line by line (split on "\n" only, so a lone "\r"
 * inside a source line does not break the line structure). Rejects after the
 * last line if git exits with a non-zero code.
 */
export async function* streamGitLines(ctx: GitContext, args: string[], opts: RunOptions = {}): AsyncGenerator<string> {
  if (ctx.signal?.aborted) {
    throw new CancelledError();
  }
  ctx.log?.(`> git ${args.join(' ')}`);
  const child = spawn(ctx.gitPath, args, {
    cwd: opts.cwd,
    env: gitEnv(opts.isolateConfig ?? false),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => {
    err += c;
    if (err.length > 64 * 1024) {
      err = err.slice(-32 * 1024);
    }
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'ENOENT' ? new GitError(`Git executable not found: "${ctx.gitPath}".`, null, '') : e),
    );
    child.on('close', (code) => resolve(code));
  });
  // Avoid an unhandled rejection if the consumer stops early.
  exited.catch(() => undefined);
  const onAbort = () => child.kill();
  ctx.signal?.addEventListener('abort', onAbort, { once: true });

  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let finished = false;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      pending += decoder.decode(chunk, { stream: true });
      let start = 0;
      let nl: number;
      while ((nl = pending.indexOf('\n', start)) !== -1) {
        yield pending.slice(start, nl);
        start = nl + 1;
      }
      pending = pending.slice(start);
    }
    pending += decoder.decode();
    if (pending.length > 0) {
      yield pending;
    }
    const code = await exited;
    finished = true;
    if (ctx.signal?.aborted) {
      throw new CancelledError();
    }
    if (code !== 0) {
      throw new GitError(`git ${args[0]} failed (exit code ${code}): ${lastLines(err)}`, code, err);
    }
  } finally {
    ctx.signal?.removeEventListener('abort', onAbort);
    if (!finished) {
      child.kill();
    }
  }
}

function lastLines(text: string): string {
  const lines = text
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.slice(-3).join(' | ') || '(no error output)';
}
