import { promises as fs } from 'fs';
import * as path from 'path';
import { BlobReader } from './blobReader';
import { CommitRecord, FileChange } from './types';

export interface FileContents {
  file: FileChange;
  /** Content at the first parent; null for added files (or if it could not be read). */
  before: Buffer | null;
  /** Content at the commit; null for deleted files (or if it could not be read). */
  after: Buffer | null;
}

/** Reads the before/after contents of every changed file of a commit. */
export async function readCommitFiles(
  reader: BlobReader,
  commit: CommitRecord,
  warn: (message: string) => void,
): Promise<FileContents[]> {
  const parent = commit.parents[0] ?? null;
  const read = async (rev: string | null, repoPath: string | null): Promise<Buffer | null> => {
    if (!rev || repoPath === null) {
      return null;
    }
    const content = await reader.read(rev, repoPath);
    if (content === null) {
      warn(`Could not read "${repoPath}" at ${rev}`);
    }
    return content;
  };
  return Promise.all(
    commit.files.map(async (file) => {
      const [before, after] = await Promise.all([read(parent, file.oldPath), read(commit.sha, file.newPath)]);
      return { file, before, after };
    }),
  );
}

/**
 * Saves the changed files of a commit, before and after the change:
 *
 *   <outputDir>/<sha>/before/<old path>   content at the first parent
 *   <outputDir>/<sha>/after/<new path>    content at the commit
 *
 * Files are written byte for byte as stored in git, so the line numbers in
 * the result JSON point at the same lines in these files. Added files only
 * have an after/ copy, deleted files only a before/ copy.
 *
 * @returns the number of files written
 */
export async function writeCommitFiles(
  files: FileContents[],
  commit: CommitRecord,
  outputDir: string,
  warn: (message: string) => void,
): Promise<number> {
  const commitDir = path.join(outputDir, commit.sha);
  const jobs: Promise<boolean>[] = [];
  for (const { file, before, after } of files) {
    if (before && file.oldPath) {
      jobs.push(writeFile(before, file.oldPath, path.join(commitDir, 'before'), warn));
    }
    if (after && file.newPath) {
      jobs.push(writeFile(after, file.newPath, path.join(commitDir, 'after'), warn));
    }
  }
  const saved = await Promise.all(jobs);
  return saved.filter((ok) => ok).length;
}

/** Errors that will hit every following file too: stop instead of warning per file. */
const FATAL_WRITE_ERRORS = new Set(['ENOSPC', 'EDQUOT', 'EROFS']);

async function writeFile(content: Buffer, repoPath: string, baseDir: string, warn: (message: string) => void): Promise<boolean> {
  const target = safeJoin(baseDir, repoPath);
  if (!target) {
    warn(`Skipped unsafe path "${repoPath}"`);
    return false;
  }
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    return true;
  } catch (e) {
    if (FATAL_WRITE_ERRORS.has((e as NodeJS.ErrnoException).code ?? '')) {
      throw e;
    }
    warn(`Could not write ${target}: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Resolves a path from a git tree below `baseDir`, or returns null if it
 * could escape it or create a `.git` directory (a repository can contain such
 * tree entries; `git checkout` refuses them too).
 */
export function safeJoin(baseDir: string, repoPath: string, platform: NodeJS.Platform = process.platform): string | null {
  const parts = repoPath.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') {
      return null;
    }
    // ".git", plus the names Windows/macOS treat as ".git" (".git.", ".GIT ", "GIT~1").
    const folded = part.toLowerCase().replace(/[. ]+$/, '');
    if (folded === '.git' || /^git~\d+$/.test(folded)) {
      return null;
    }
    if (platform === 'win32' && /[\\:]/.test(part)) {
      return null;
    }
  }
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const base = pathApi.resolve(baseDir);
  const target = pathApi.resolve(base, ...parts);
  return target.startsWith(base + pathApi.sep) ? target : null;
}
