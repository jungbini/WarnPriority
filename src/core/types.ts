/**
 * Shared data model for commits and the code they changed.
 *
 * Only changed lines are kept (no context lines). Each contiguous block of
 * changed lines is classified as one of:
 *   - "added":    lines were only added (추가)
 *   - "deleted":  lines were only removed (삭제)
 *   - "modified": lines were removed and replaced by other lines (수정)
 *
 * The parser keeps a richer model (line numbers, dates, ...) than what is
 * written to the result file; see `OutputCommit` for the file format.
 */

export type ChangeType = 'added' | 'deleted' | 'modified';

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';

export interface CodeChange {
  type: ChangeType;
  /**
   * First removed line in the old file. When `oldLines` is 0 (added), this is
   * the old-file line *after which* the code was inserted (0 = top of file),
   * following the unified diff hunk header convention.
   */
  oldStart: number;
  oldLines: number;
  /**
   * First added line in the new file. When `newLines` is 0 (deleted), this is
   * the new-file line *after which* the code used to be.
   */
  newStart: number;
  newLines: number;
  /** Lines as they were before the commit (removed lines). */
  deletedCode: string[];
  /** Lines as they are after the commit (added lines). */
  addedCode: string[];
}

export interface FileChange {
  /** Path before the commit; null when the file was added. */
  oldPath: string | null;
  /** Path after the commit; null when the file was deleted. */
  newPath: string | null;
  status: FileStatus;
  changes: CodeChange[];
}

export interface PersonInfo {
  name: string;
  email: string;
  date: string;
}

export interface CommitRecord {
  sha: string;
  parents: string[];
  author: PersonInfo;
  committer: PersonInfo;
  message: string;
  /** Link to the commit on the web, when the host is known. */
  url: string | null;
  stats: CommitStats;
  files: FileChange[];
}

export interface CommitStats {
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  addedBlocks: number;
  deletedBlocks: number;
  modifiedBlocks: number;
}

export interface RepoRef {
  /** URL or local path handed to `git clone`. */
  cloneUrl: string;
  /** Browser URL of the repository (e.g. https://github.com/owner/repo), if known. */
  webUrl: string | null;
  host: string | null;
  owner: string | null;
  name: string;
  /**
   * Branch/tag/commit taken from the URL (e.g. `/tree/<ref>`), possibly with a
   * trailing file path still attached; resolved against the clone later.
   */
  refHint: string | null;
}

/**
 * Result file format: a JSON array of these, one per commit. Only line
 * numbers are stored; the code itself is saved as files next to the JSON:
 *
 *   <project folder>/<sha>/before/<oldFile ?? file>   file at `parent`
 *   <project folder>/<sha>/after/<file>               file at `sha`
 *
 *   [
 *     {
 *       "sha": "...", "parent": "...", "author": "Name <email>", "message": "...",
 *       "files": [
 *         { "file": "src/A.java",
 *           "diff": [
 *             { "type": "modified", "before": [11], "after": [11, 12] },
 *             { "type": "added", "before": [], "after": [30, 31] },
 *             { "type": "deleted", "before": [40], "after": [] } ] } ]
 *     }
 *   ]
 */
export interface OutputCommit {
  sha: string;
  /** The parent the diff was computed against (first parent); null for the root commit. */
  parent: string | null;
  /** "Name <email>", as shown by `git log`. */
  author: string;
  message: string;
  files: OutputFile[];
}

export interface OutputFile {
  /** Path after the commit (path before the commit for deleted files). */
  file: string;
  /** Path before the commit, only present when the file was renamed or copied. */
  oldFile?: string;
  diff: OutputDiff[];
}

export interface OutputDiff {
  type: ChangeType;
  /** Removed lines, numbered as in the file before the commit (`before/`). Empty for "added". */
  before: number[];
  /** Added lines, numbered as in the file after the commit (`after/`). Empty for "deleted". */
  after: number[];
}

/** Progress events emitted while collecting; the UI decides how to render them. */
export type ProgressEvent =
  | { stage: 'clone' | 'fetch'; detail?: string }
  | { stage: 'count' }
  | { stage: 'process'; done: number; total: number };
