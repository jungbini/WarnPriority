import { createWriteStream, promises as fs, WriteStream } from 'fs';
import { once } from 'events';
import { CommitRecord, OutputFormat } from './types';

export interface RunSummary {
  /** false when the run was cancelled and the file holds partial results. */
  complete: boolean;
  matchedCommits: number;
  commitsWithCodeChanges: number;
  filesChanged: number;
  codeChanges: { modify: number; insert: number; delete: number; total: number };
  linesAdded: number;
  linesDeleted: number;
  finishedAt: string;
}

export interface OutputWriter {
  writeCommit(commit: CommitRecord): Promise<void>;
  /** Finishes the file (valid JSON/CSV even for partial results). */
  close(summary: RunSummary): Promise<void>;
  /** Closes and removes the file. */
  discard(): Promise<void>;
}

class StreamTarget {
  private readonly stream: WriteStream;
  private error: Error | null = null;

  constructor(readonly filePath: string) {
    this.stream = createWriteStream(filePath, { encoding: 'utf8' });
    this.stream.on('error', (e) => (this.error = e));
  }

  async write(text: string): Promise<void> {
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

  async end(): Promise<void> {
    if (this.error) {
      throw this.error;
    }
    this.stream.end();
    await once(this.stream, 'finish');
  }

  async discard(): Promise<void> {
    this.stream.destroy();
    await once(this.stream, 'close').catch(() => undefined);
    await fs.rm(this.filePath, { force: true });
  }
}

export function createOutputWriter(format: OutputFormat, filePath: string, metadata: object): OutputWriter {
  return format === 'csv' ? new CsvWriter(filePath) : new JsonWriter(filePath, metadata);
}

/**
 * Streams a pretty-printed JSON document:
 *   { "metadata": {...}, "commits": [ ... ], "summary": {...} }
 * Commits are written as soon as they are parsed, so memory use stays flat
 * even for repositories with tens of thousands of matching commits.
 */
class JsonWriter implements OutputWriter {
  private readonly target: StreamTarget;
  private started = false;
  private count = 0;

  constructor(filePath: string, private readonly metadata: object) {
    this.target = new StreamTarget(filePath);
  }

  private async start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      await this.target.write(`{\n  "metadata": ${indent(JSON.stringify(this.metadata, null, 2), 2)},\n  "commits": [`);
    }
  }

  async writeCommit(commit: CommitRecord): Promise<void> {
    await this.start();
    const sep = this.count === 0 ? '\n' : ',\n';
    this.count++;
    await this.target.write(sep + '    ' + indent(JSON.stringify(commit, null, 2), 4));
  }

  async close(summary: RunSummary): Promise<void> {
    await this.start();
    await this.target.write(`${this.count > 0 ? '\n  ' : ''}],\n  "summary": ${indent(JSON.stringify(summary, null, 2), 2)}\n}\n`);
    await this.target.end();
  }

  discard(): Promise<void> {
    return this.target.discard();
  }
}

export const CSV_COLUMNS = [
  'commit_sha',
  'commit_url',
  'author_name',
  'author_email',
  'author_date',
  'commit_message',
  'file_status',
  'old_path',
  'new_path',
  'change_type',
  'old_start',
  'old_lines',
  'new_start',
  'new_lines',
  'deleted_code',
  'added_code',
] as const;

/** One row per changed code block. UTF-8 with BOM so Excel detects the encoding. */
class CsvWriter implements OutputWriter {
  private readonly target: StreamTarget;
  private started = false;

  constructor(filePath: string) {
    this.target = new StreamTarget(filePath);
  }

  private async start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      await this.target.write('﻿' + CSV_COLUMNS.join(',') + '\r\n');
    }
  }

  async writeCommit(commit: CommitRecord): Promise<void> {
    await this.start();
    let rows = '';
    for (const file of commit.files) {
      for (const change of file.changes) {
        const cells: (string | number | null)[] = [
          commit.sha,
          commit.url,
          commit.author.name,
          commit.author.email,
          commit.author.date,
          commit.message,
          file.status,
          file.oldPath,
          file.newPath,
          change.type,
          change.oldStart,
          change.oldLines,
          change.newStart,
          change.newLines,
          change.deletedCode.join('\n'),
          change.addedCode.join('\n'),
        ];
        rows += cells.map(csvCell).join(',') + '\r\n';
      }
    }
    await this.target.write(rows);
  }

  async close(): Promise<void> {
    await this.start();
    await this.target.end();
  }

  discard(): Promise<void> {
    return this.target.discard();
  }
}

export function csvCell(value: string | number | null): string {
  if (value === null) {
    return '';
  }
  const s = String(value);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text.replace(/\n/g, '\n' + pad);
}
