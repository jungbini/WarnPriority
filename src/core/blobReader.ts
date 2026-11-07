import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { once } from 'events';
import { CancelledError, GitContext, GitError, gitEnv } from './git';

interface Pending {
  resolve: (content: Buffer | null) => void;
  reject: (e: Error) => void;
}

/**
 * Reads file contents at given commits through one long-running
 * `git cat-file --batch` process, instead of starting `git show` per file.
 * Requests are answered in order, so callers may issue several at once.
 */
export class BlobReader {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending: Pending[] = [];
  private chunks: Buffer[] = [];
  private length = 0;
  /** Size of the object whose header was read and whose content is awaited. */
  private expect: { size: number; isBlob: boolean } | null = null;
  private failure: Error | null = null;
  private closing = false;
  private readonly onAbort = () => this.child.kill();

  constructor(
    private readonly ctx: GitContext,
    repoDir: string,
  ) {
    this.child = spawn(ctx.gitPath, ['cat-file', '--batch'], { cwd: repoDir, env: gitEnv(true), windowsHide: true });
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.length += chunk.length;
      this.drain();
    });
    this.child.stderr.resume();
    // EPIPE if the process died; the 'close' handler reports the reason.
    this.child.stdin.on('error', () => undefined);
    this.child.on('error', (e) => this.fail(e));
    this.child.on('close', (code) => {
      if (ctx.signal?.aborted) {
        this.fail(new CancelledError());
      } else if (!this.closing || this.pending.length > 0) {
        this.fail(new GitError(`git cat-file exited unexpectedly (exit code ${code})`, code, ''));
      }
    });
    ctx.signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  /** Contents of `<rev>:<filePath>`, or null if it does not exist or is not a regular file. */
  read(rev: string, filePath: string): Promise<Buffer | null> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (/[\r\n]/.test(filePath)) {
      // Cannot be expressed in the line-based --batch input.
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(`${rev}:${filePath}\n`);
    });
  }

  async close(): Promise<void> {
    this.ctx.signal?.removeEventListener('abort', this.onAbort);
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    this.closing = true;
    const closed = once(this.child, 'close');
    this.child.stdin.end();
    await closed;
  }

  private drain(): void {
    while (this.pending.length > 0) {
      if (!this.expect) {
        const buf = this.take();
        const nl = buf.indexOf(0x0a);
        if (nl === -1) {
          return;
        }
        const header = buf.toString('utf8', 0, nl);
        this.consume(nl + 1);
        // "<oid> <type> <size>" when found; "<input> missing" / "<input> ambiguous" otherwise.
        const m = /^[0-9a-f]{40,64} (\S+) (\d+)$/.exec(header);
        if (!m) {
          this.pending.shift()!.resolve(null);
          continue;
        }
        this.expect = { size: Number(m[2]), isBlob: m[1] === 'blob' };
      }
      // Content plus the trailing LF. Wait without copying until it is all here.
      if (this.length < this.expect.size + 1) {
        return;
      }
      const buf = this.take();
      const content = Buffer.from(buf.subarray(0, this.expect.size));
      this.consume(this.expect.size + 1);
      const isBlob = this.expect.isBlob;
      this.expect = null;
      this.pending.shift()!.resolve(isBlob ? content : null);
    }
  }

  /** Joins the buffered chunks into one (cheap when there is just one). */
  private take(): Buffer {
    if (this.chunks.length > 1) {
      this.chunks = [Buffer.concat(this.chunks, this.length)];
    }
    return this.chunks[0] ?? Buffer.alloc(0);
  }

  private consume(n: number): void {
    const rest = this.take().subarray(n);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
  }

  private fail(e: Error): void {
    this.failure ??= e;
    for (const p of this.pending.splice(0)) {
      p.reject(this.failure);
    }
  }
}
