import { createWriteStream, promises as fs, WriteStream } from 'fs';
import { once } from 'events';
import { CommitRecord, OutputCommit, OutputDiff } from './types';

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
  finishedAt: string;
}

/** Reduces a parsed commit to the fields stored in the result file. */
export function toOutputCommit(commit: CommitRecord): OutputCommit {
  return {
    sha: commit.sha,
    parent: commit.parents[0] ?? null,
    author: commit.author.email ? `${commit.author.name} <${commit.author.email}>` : commit.author.name,
    message: commit.message,
    files: commit.files.map((f) => ({
      file: (f.newPath ?? f.oldPath)!,
      diff: f.changes.map((c): OutputDiff => {
        switch (c.type) {
          case 'added':
            return { type: 'added', code: c.addedCode };
          case 'deleted':
            return { type: 'deleted', code: c.deletedCode };
          case 'modified':
            return { type: 'modified', before: c.deletedCode, after: c.addedCode };
        }
      }),
    })),
  };
}

/**
 * Streams the result file: a pretty-printed JSON array with one entry per
 * commit. Commits are written as soon as they are parsed, so memory use stays
 * flat even for repositories with tens of thousands of matching commits.
 * The array is always closed properly, also for partial (cancelled) runs.
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
    const json = JSON.stringify(toOutputCommit(commit), null, 2).replace(/\n/g, '\n  ');
    await this.write((this.count === 0 ? '[\n  ' : ',\n  ') + json);
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
