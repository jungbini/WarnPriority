import { ChangeType, CodeChange, CommitRecord, CommitStats, FileChange, FileStatus } from './types';

/*
 * Streaming parser for the output of
 *
 *   git log -p --format=<LOG_FORMAT> ...
 *
 * Each commit starts with a marker line beginning with "\0\x01". Diff lines
 * always start with a printable character (" ", "+", "-", "@", "d", ...) and
 * commit messages cannot contain NUL, so the markers are unambiguous.
 */

const COMMIT_MARKER = '\x00\x01COMMIT\x00';
const MSG_MARKER = '\x00\x01MSG';
const END_MSG_MARKER = '\x00\x01ENDMSG';

export const LOG_FORMAT =
  '%x00%x01COMMIT%x00%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%n' + '%x00%x01MSG%n%B%x00%x01ENDMSG';

interface PartialCommit {
  record: CommitRecord;
  messageLines: string[];
}

interface PartialFile {
  minusPath: string | null;
  plusPath: string | null;
  minusIsDevNull: boolean;
  plusIsDevNull: boolean;
  newFile: boolean;
  deletedFile: boolean;
  renamed: boolean;
  copied: boolean;
  /** Submodule pointer change ("Subproject commit ..."), not source code. */
  submodule: boolean;
  changes: CodeChange[];
}

interface HunkState {
  oldRemaining: number;
  newRemaining: number;
  oldCursor: number;
  newCursor: number;
  block: { oldStart: number; newStart: number; deleted: string[]; added: string[] } | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export class GitLogParser {
  private commit: PartialCommit | null = null;
  private mode: 'none' | 'message' | 'diff' = 'none';
  private file: PartialFile | null = null;
  private hunk: HunkState | null = null;

  constructor(private readonly commitUrl: (sha: string) => string | null = () => null) {}

  /** Feeds one output line; returns the previous commit once a new one starts. */
  push(line: string): CommitRecord | null {
    if (line.startsWith(COMMIT_MARKER)) {
      const done = this.finishCommit();
      this.startCommit(line.slice(COMMIT_MARKER.length));
      return done;
    }
    if (!this.commit) {
      return null;
    }
    switch (this.mode) {
      case 'none':
        if (line === MSG_MARKER) {
          this.mode = 'message';
        }
        return null;
      case 'message':
        if (line.endsWith(END_MSG_MARKER)) {
          const rest = line.slice(0, line.length - END_MSG_MARKER.length);
          if (rest) {
            this.commit.messageLines.push(rest);
          }
          this.commit.record.message = this.commit.messageLines.join('\n').replace(/\s+$/, '');
          this.mode = 'diff';
        } else {
          this.commit.messageLines.push(line);
        }
        return null;
      case 'diff':
        this.diffLine(line);
        return null;
    }
  }

  /** Call after the last line; returns the final commit, if any. */
  finish(): CommitRecord | null {
    return this.finishCommit();
  }

  private startCommit(header: string): void {
    const [sha = '', parents = '', an = '', ae = '', ad = '', cn = '', ce = '', cd = ''] = header.split('\x00');
    this.commit = {
      record: {
        sha,
        parents: parents.split(' ').filter((p) => p.length > 0),
        author: { name: an, email: ae, date: ad },
        committer: { name: cn, email: ce, date: cd },
        message: '',
        url: this.commitUrl(sha),
        stats: emptyStats(),
        files: [],
      },
      messageLines: [],
    };
    this.mode = 'none';
    this.file = null;
    this.hunk = null;
  }

  private finishCommit(): CommitRecord | null {
    if (!this.commit) {
      return null;
    }
    this.finishFile();
    const record = this.commit.record;
    if (this.mode === 'message') {
      record.message = this.commit.messageLines.join('\n').replace(/\s+$/, '');
    }
    record.stats = computeStats(record.files);
    this.commit = null;
    this.mode = 'none';
    return record;
  }

  private diffLine(line: string): void {
    const hunk = this.hunk;
    if (hunk && (hunk.oldRemaining > 0 || hunk.newRemaining > 0)) {
      const c = line.charAt(0);
      if (c === '-' && hunk.oldRemaining > 0) {
        if (!hunk.block || hunk.block.added.length > 0) {
          this.flushBlock();
          hunk.block = { oldStart: hunk.oldCursor, newStart: hunk.newCursor, deleted: [], added: [] };
        }
        hunk.block.deleted.push(stripCr(line.slice(1)));
        hunk.oldCursor++;
        hunk.oldRemaining--;
      } else if (c === '+' && hunk.newRemaining > 0) {
        if (!hunk.block) {
          hunk.block = { oldStart: hunk.oldCursor, newStart: hunk.newCursor, deleted: [], added: [] };
        }
        hunk.block.added.push(stripCr(line.slice(1)));
        hunk.newCursor++;
        hunk.newRemaining--;
      } else if ((c === ' ' || line === '') && hunk.oldRemaining > 0 && hunk.newRemaining > 0) {
        // Context line (only present if context was requested).
        this.flushBlock();
        hunk.oldCursor++;
        hunk.newCursor++;
        hunk.oldRemaining--;
        hunk.newRemaining--;
      } else if (c === '\\') {
        // "\ No newline at end of file"
      } else {
        // Malformed or truncated hunk: close it and treat the line as a header.
        this.closeHunk();
        this.headerLine(line);
        return;
      }
      if (hunk.oldRemaining === 0 && hunk.newRemaining === 0) {
        this.closeHunk();
      }
      return;
    }
    this.headerLine(line);
  }

  private headerLine(line: string): void {
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      this.finishFile();
      this.file = {
        minusPath: null,
        plusPath: null,
        minusIsDevNull: false,
        plusIsDevNull: false,
        newFile: false,
        deletedFile: false,
        renamed: false,
        copied: false,
        submodule: false,
        changes: [],
      };
      return;
    }
    const file = this.file;
    if (!file) {
      return;
    }
    if (line.startsWith('@@ ')) {
      this.closeHunk();
      const m = HUNK_HEADER.exec(line);
      if (!m) {
        return;
      }
      const oldStart = parseInt(m[1], 10);
      const oldLines = m[2] === undefined ? 1 : parseInt(m[2], 10);
      const newStart = parseInt(m[3], 10);
      const newLines = m[4] === undefined ? 1 : parseInt(m[4], 10);
      this.hunk = {
        oldRemaining: oldLines,
        newRemaining: newLines,
        // For an empty side the header names the line *before* the change.
        oldCursor: oldLines === 0 ? oldStart + 1 : oldStart,
        newCursor: newLines === 0 ? newStart + 1 : newStart,
        block: null,
      };
      return;
    }
    if (line.startsWith('--- ')) {
      const p = parseHeaderPath(line.slice(4));
      if (p === null) {
        file.minusIsDevNull = true;
      } else {
        file.minusPath = stripPrefix(p, 'a/');
      }
    } else if (line.startsWith('+++ ')) {
      const p = parseHeaderPath(line.slice(4));
      if (p === null) {
        file.plusIsDevNull = true;
      } else {
        file.plusPath = stripPrefix(p, 'b/');
      }
    } else if (line.startsWith('new file mode')) {
      file.newFile = true;
      file.submodule ||= line.endsWith(' 160000');
    } else if (line.startsWith('deleted file mode')) {
      file.deletedFile = true;
      file.submodule ||= line.endsWith(' 160000');
    } else if (line.startsWith('index ') || line.startsWith('new mode ') || line.startsWith('old mode ')) {
      file.submodule ||= line.endsWith(' 160000');
    } else if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      file.renamed = true;
    } else if (line.startsWith('copy from ') || line.startsWith('copy to ')) {
      file.copied = true;
    }
  }

  private flushBlock(): void {
    const hunk = this.hunk;
    if (!hunk || !hunk.block || !this.file) {
      return;
    }
    const b = hunk.block;
    hunk.block = null;
    if (b.deleted.length === 0 && b.added.length === 0) {
      return;
    }
    const type: ChangeType = b.deleted.length > 0 && b.added.length > 0 ? 'modified' : b.added.length > 0 ? 'added' : 'deleted';
    this.file.changes.push({
      type,
      oldStart: b.deleted.length > 0 ? b.oldStart : b.oldStart - 1,
      oldLines: b.deleted.length,
      newStart: b.added.length > 0 ? b.newStart : b.newStart - 1,
      newLines: b.added.length,
      deletedCode: b.deleted,
      addedCode: b.added,
    });
  }

  private closeHunk(): void {
    this.flushBlock();
    this.hunk = null;
  }

  private finishFile(): void {
    this.closeHunk();
    const f = this.file;
    this.file = null;
    if (!f || !this.commit || f.changes.length === 0 || f.submodule) {
      // Binary files, pure renames, mode changes and submodule bumps carry no code changes.
      return;
    }
    const added = f.newFile || f.minusIsDevNull;
    const deleted = f.deletedFile || f.plusIsDevNull;
    let status: FileStatus = 'modified';
    if (added) {
      status = 'added';
    } else if (deleted) {
      status = 'deleted';
    } else if (f.renamed || (f.minusPath !== null && f.plusPath !== null && f.minusPath !== f.plusPath)) {
      status = f.copied ? 'copied' : 'renamed';
    } else if (f.copied) {
      status = 'copied';
    }
    const result: FileChange = {
      oldPath: added ? null : f.minusPath,
      newPath: deleted ? null : f.plusPath,
      status,
      changes: f.changes,
    };
    this.commit.record.files.push(result);
  }
}

function emptyStats(): CommitStats {
  return { filesChanged: 0, linesAdded: 0, linesDeleted: 0, addedBlocks: 0, deletedBlocks: 0, modifiedBlocks: 0 };
}

function computeStats(files: FileChange[]): CommitStats {
  const s = emptyStats();
  s.filesChanged = files.length;
  for (const f of files) {
    for (const c of f.changes) {
      s.linesAdded += c.newLines;
      s.linesDeleted += c.oldLines;
      if (c.type === 'added') {
        s.addedBlocks++;
      } else if (c.type === 'deleted') {
        s.deletedBlocks++;
      } else {
        s.modifiedBlocks++;
      }
    }
  }
  return s;
}

function stripCr(s: string): string {
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}

function stripPrefix(p: string, prefix: string): string {
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/**
 * Parses the path part of a "---"/"+++" line. Returns null for /dev/null.
 * Git appends a TAB when the name contains a space, and C-quotes names with
 * special characters.
 */
export function parseHeaderPath(text: string): string | null {
  let t = text.endsWith('\t') ? text.slice(0, -1) : text;
  if (t.startsWith('"')) {
    t = unquoteCString(t);
  }
  return t === '/dev/null' ? null : t;
}

const SIMPLE_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/** Decodes a C-style quoted string as produced by git (octal escapes are UTF-8 bytes). */
export function unquoteCString(quoted: string): string {
  const end = quoted.lastIndexOf('"');
  const body = quoted.slice(1, end > 0 ? end : undefined);
  const parts: Buffer[] = [];
  let i = 0;
  while (i < body.length) {
    const bs = body.indexOf('\\', i);
    if (bs === -1) {
      parts.push(Buffer.from(body.slice(i), 'utf8'));
      break;
    }
    if (bs > i) {
      parts.push(Buffer.from(body.slice(i, bs), 'utf8'));
    }
    const next = body.charAt(bs + 1);
    const oct = /^[0-7]{1,3}/.exec(body.slice(bs + 1));
    if (oct) {
      parts.push(Buffer.from([parseInt(oct[0], 8) & 0xff]));
      i = bs + 1 + oct[0].length;
    } else if (next in SIMPLE_ESCAPES) {
      parts.push(Buffer.from([SIMPLE_ESCAPES[next]]));
      i = bs + 2;
    } else {
      parts.push(Buffer.from('\\'));
      i = bs + 1;
    }
  }
  return Buffer.concat(parts).toString('utf8');
}
