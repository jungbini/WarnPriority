import { createWriteStream, promises as fs, WriteStream } from 'fs';
import { once } from 'events';
import { CommitRecord, OutputCommit, OutputDiff, OutputFile } from './types';

/** Totals reported to the UI after a run (not written to the result file). */
export interface RunSummary {
  /** false when the run was cancelled and the file holds partial results. */
  complete: boolean;
  matchedCommits: number;
  commitsWithCodeChanges: number;
  filesChanged: number;
  codeChanges: { added: number; deleted: number; modified: number; total: number };
  linesAdded: number;
  linesDeleted: number;
  /** before/after files written to the commit folders. */
  savedFiles: number;
  finishedAt: string;
}

/** Reduces a parsed commit to the fields stored in the result file. */
export function toOutputCommit(commit: CommitRecord): OutputCommit {
  return {
    sha: commit.sha,
    parent: commit.parents[0] ?? null,
    author: commit.author.email ? `${commit.author.name} <${commit.author.email}>` : commit.author.name,
    message: commit.message,
    files: commit.files.map(
      (f): OutputFile => ({
        file: (f.newPath ?? f.oldPath)!,
        // Path of the before/ copy of a renamed file.
        ...(f.oldPath && f.newPath && f.oldPath !== f.newPath ? { oldFile: f.oldPath } : {}),
        diff: f.changes.map(
          (c): OutputDiff => ({
            type: c.type,
            before: lineNumbers(c.oldStart, c.deletedCode.length),
            after: lineNumbers(c.newStart, c.addedCode.length),
          }),
        ),
      }),
    ),
  };
}

function lineNumbers(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}

/**
 * Pretty-prints JSON like JSON.stringify(value, null, 2), except that arrays
 * of numbers and objects holding only scalars / number arrays (the diff
 * blocks) stay on one line:
 *   { "type": "modified", "before": [11], "after": [11, 12] }
 */
export function formatJson(value: unknown, indent = ''): string {
  if (isInline(value)) {
    return inline(value);
  }
  const inner = indent + '  ';
  if (Array.isArray(value)) {
    return `[\n${value.map((v) => inner + formatJson(v, inner)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value as object).filter(([, v]) => v !== undefined);
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatJson(v, inner)}`).join(',\n')}\n${indent}}`;
}

function isScalar(v: unknown): boolean {
  return v === null || typeof v !== 'object';
}

function isNumberArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === 'number');
}

function isInline(v: unknown): boolean {
  if (isScalar(v) || isNumberArray(v)) {
    return true;
  }
  if (Array.isArray(v)) {
    return v.length === 0;
  }
  const values = Object.values(v as object);
  return values.length === 0 || values.every((x) => x === undefined || isScalar(x) || isNumberArray(x));
}

function inline(v: unknown): string {
  if (isScalar(v)) {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
  }
  const entries = Object.entries(v as object).filter(([, x]) => x !== undefined);
  return entries.length === 0 ? '{}' : `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }`;
}

/**
 * Streams the result file: a JSON array with one entry per commit. Commits
 * are written as soon as they are parsed, so memory use stays flat even for
 * repositories with tens of thousands of matching commits. The array is
 * always closed properly, also for partial (cancelled) runs.
 */
export class JsonArrayWriter {
  private readonly stream: WriteStream;
  private error: Error | null = null;
  private count = 0;

  constructor(readonly filePath: string) {
    this.stream = createWriteStream(filePath, { encoding: 'utf8' });
    this.stream.on('error', (e) => (this.error = e));
  }

  async writeCommit(commit: CommitRecord): Promise<void> {
    await this.write((this.count === 0 ? '[\n  ' : ',\n  ') + formatJson(toOutputCommit(commit), '  '));
    this.count++;
  }

  /** Finishes the file (valid JSON even for partial results). */
  async close(): Promise<void> {
    await this.write(this.count === 0 ? '[]\n' : '\n]\n');
    this.stream.end();
    await once(this.stream, 'finish');
  }

  /** Closes and removes the file. */
  async discard(): Promise<void> {
    this.stream.destroy();
    await once(this.stream, 'close').catch(() => undefined);
    await fs.rm(this.filePath, { force: true });
  }

  private async write(text: string): Promise<void> {
    if (this.error) {
      throw this.error;
    }
    if (!this.stream.write(text)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          this.stream.off('drain', done);
          this.stream.off('error', done);
          resolve();
        };
        this.stream.on('drain', done);
        this.stream.on('error', done);
      });
      if (this.error) {
        throw this.error;
      }
    }
  }
}
