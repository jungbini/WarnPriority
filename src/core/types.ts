/**
 * Shared data model for commits and the code they changed.
 *
 * Only changed lines are kept (no context lines). Each contiguous block of
 * changed lines is classified as one of:
 *   - "modify": lines were removed and replaced by other lines (수정)
 *   - "insert": lines were only added (삽입)
 *   - "delete": lines were only removed (삭제)
 */

export type ChangeType = 'modify' | 'insert' | 'delete';

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';

export interface CodeChange {
  type: ChangeType;
  /**
   * First removed line in the old file. When `oldLines` is 0 (insert), this is
   * the old-file line *after which* the code was inserted (0 = top of file),
   * following the unified diff hunk header convention.
   */
  oldStart: number;
  oldLines: number;
  /**
   * First added line in the new file. When `newLines` is 0 (delete), this is
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
  modifyBlocks: number;
  insertBlocks: number;
  deleteBlocks: number;
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

export type OutputFormat = 'json' | 'csv';

/** Progress events emitted while collecting; the UI decides how to render them. */
export type ProgressEvent =
  | { stage: 'clone' | 'fetch'; detail?: string }
  | { stage: 'count' }
  | { stage: 'process'; done: number; total: number };
