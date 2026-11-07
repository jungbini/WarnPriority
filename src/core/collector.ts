import { promises as fs } from 'fs';
import * as path from 'path';
import { BlobReader } from './blobReader';
import { saveCommitFiles } from './commitFiles';
import { CancelledError, GitContext, GitError, runGit, streamGitLines } from './git';
import { GitLogParser, LOG_FORMAT } from './logParser';
import { ensureBareClone, resolveStartCommit } from './repoCache';
import { ProgressEvent, RepoRef } from './types';
import { JsonArrayWriter, RunSummary } from './writers';

/**
 * Default file filter: source files of languages that static analyzers
 * handle (Java: SpotBugs/PMD/Checkstyle, C/C++: cppcheck/clang-tidy, Python:
 * pylint, JS/TS: ESLint, ...). Docs, build files, data and images are skipped.
 * Keep in sync with the "warnPriority.fileExtensions" default in package.json.
 */
export const SOURCE_FILE_EXTENSIONS: readonly string[] = [
  'java', 'kt', 'kts', 'scala', 'groovy',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx',
  'cs', 'go', 'rs', 'py',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  'php', 'rb', 'swift', 'm', 'mm',
];

export interface CollectOptions {
  repo: RepoRef;
  /** Commit message keywords; a commit matches if its message contains any of them. Empty = all commits. */
  keywords: string[];
  caseSensitive: boolean;
  /** Treat keywords as (POSIX extended) regular expressions instead of plain text. */
  useRegex: boolean;
  /**
   * Only collect changes to files with these extensions (e.g. ["java"]).
   * Empty means SOURCE_FILE_EXTENSIONS: non-source files (xml, md, ...) are
   * never collected unless their extension is listed explicitly.
   */
  fileExtensions: string[];
  includeMergeCommits: boolean;
  ignoreWhitespace: boolean;
  /** 0 = no limit. */
  maxCommits: number;
  /**
   * Project folder: receives the result JSON (`outputFileName`, see
   * `OutputCommit`) and one folder per commit, named by its hash, with the
   * changed files before/after the commit. Created when something matches.
   */
  outputDir: string;
  outputFileName: string;
  /** Where bare clones are cached between runs. */
  cacheDir: string;
  gitPath: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
  onProgress?: (event: ProgressEvent) => void;
}

export interface CollectResult {
  /** Path of the result JSON; null when nothing matched (nothing is written then). */
  outputFile: string | null;
  outputDir: string;
  cancelled: boolean;
  summary: RunSummary;
  ref: string;
  headCommit: string;
  warnings: string[];
}

export async function collectCommitChanges(opts: CollectOptions): Promise<CollectResult> {
  const ctx: GitContext = { gitPath: opts.gitPath, signal: opts.signal, log: opts.log };
  const progress = (event: ProgressEvent) => opts.onProgress?.(event);
  const warnings: string[] = [];
  const warn = (w: string) => {
    warnings.push(w);
    opts.log?.(`WARNING: ${w}`);
  };

  const gitVersion = await getGitVersion(ctx);
  opts.log?.(`Using ${gitVersion.text}`);
  if (opts.includeMergeCommits && versionLessThan(gitVersion.numbers, [2, 31])) {
    throw new Error(`Including merge commits requires Git 2.31 or newer (found ${gitVersion.text}).`);
  }

  const repoDir = await ensureBareClone(ctx, opts.repo, opts.cacheDir, progress, warn);
  const start = await resolveStartCommit(ctx, repoDir, opts.repo.refHint);
  opts.log?.(`Reading history of ${start.ref} (${start.sha})`);

  const keywords = opts.keywords.map((k) => k.trim()).filter((k) => k.length > 0);
  let pathspecs = toPathspecs(opts.fileExtensions);
  if (pathspecs.length === 0) {
    pathspecs = toPathspecs([...SOURCE_FILE_EXTENSIONS]);
  }
  opts.log?.(`File extensions: ${pathspecs.map((p) => p.replace(':(icase)*', '')).join(' ')}`);
  const revFilters: string[] = [];
  for (const k of keywords) {
    revFilters.push(`--grep=${k}`);
  }
  if (keywords.length > 0) {
    revFilters.push(opts.useRegex ? '--extended-regexp' : '--fixed-strings');
    if (!opts.caseSensitive) {
      revFilters.push('--regexp-ignore-case');
    }
  }
  if (!opts.includeMergeCommits) {
    revFilters.push('--no-merges');
  }
  if (opts.maxCommits > 0) {
    revFilters.push(`--max-count=${Math.floor(opts.maxCommits)}`);
  }
  if (pathspecs.length > 0) {
    // Without this, history simplification can hide commits from side branches.
    revFilters.push('--full-history');
  }
  const tail = [start.sha, '--', ...pathspecs];

  progress({ stage: 'count' });
  const total = parseInt(
    (await runGit(ctx, ['rev-list', '--count', ...revFilters, ...tail], { cwd: repoDir, isolateConfig: true })).trim(),
    10,
  );
  opts.log?.(`${total} matching commit(s)`);

  const summary: RunSummary = {
    complete: false,
    matchedCommits: 0,
    commitsWithCodeChanges: 0,
    filesChanged: 0,
    codeChanges: { added: 0, deleted: 0, modified: 0, total: 0 },
    linesAdded: 0,
    linesDeleted: 0,
    savedFiles: 0,
    finishedAt: '',
  };
  const outputFile = path.join(opts.outputDir, opts.outputFileName);
  const result: CollectResult = {
    outputFile,
    outputDir: opts.outputDir,
    cancelled: false,
    summary,
    ref: start.ref,
    headCommit: start.sha,
    warnings,
  };

  if (total === 0) {
    summary.complete = true;
    summary.finishedAt = new Date().toISOString();
    result.outputFile = null;
    return result;
  }

  const logArgs = [
    '-c',
    'core.quotePath=false',
    '-c',
    'log.showSignature=false',
    'log',
    `--format=${LOG_FORMAT}`,
    '--encoding=UTF-8',
    '--patch',
    // Default context (3 lines) so the edit script matches what GitHub and
    // `git diff --stat` show; -U0 can make git pick a different alignment.
    // Context lines are dropped by the parser.
    '--unified=3',
    '--find-renames',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--root',
    ...(opts.includeMergeCommits ? ['--diff-merges=first-parent'] : []),
    ...(opts.ignoreWhitespace ? ['--ignore-all-space'] : []),
    ...revFilters,
    ...tail,
  ];

  await fs.mkdir(opts.outputDir, { recursive: true });
  const writer = new JsonArrayWriter(outputFile);
  const reader = new BlobReader(ctx, repoDir);
  const commitUrl = opts.repo.webUrl ? (sha: string) => `${opts.repo.webUrl}/commit/${sha}` : () => null;
  const parser = new GitLogParser(commitUrl);
  let lastProgressAt = 0;

  const handle = async (commit: ReturnType<GitLogParser['finish']>) => {
    if (!commit) {
      return;
    }
    summary.matchedCommits++;
    if (commit.files.length > 0) {
      summary.commitsWithCodeChanges++;
      summary.filesChanged += commit.stats.filesChanged;
      summary.linesAdded += commit.stats.linesAdded;
      summary.linesDeleted += commit.stats.linesDeleted;
      summary.codeChanges.added += commit.stats.addedBlocks;
      summary.codeChanges.deleted += commit.stats.deletedBlocks;
      summary.codeChanges.modified += commit.stats.modifiedBlocks;
      summary.codeChanges.total += commit.stats.addedBlocks + commit.stats.deletedBlocks + commit.stats.modifiedBlocks;
      // Files first: every commit listed in the JSON then has its folder, even after a cancel.
      summary.savedFiles += await saveCommitFiles(reader, commit, opts.outputDir, warn);
      await writer.writeCommit(commit);
    }
    const now = Date.now();
    if (now - lastProgressAt > 200 || summary.matchedCommits === total) {
      lastProgressAt = now;
      progress({ stage: 'process', done: summary.matchedCommits, total });
    }
  };

  try {
    for await (const line of streamGitLines(ctx, logArgs, { cwd: repoDir, isolateConfig: true })) {
      await handle(parser.push(line));
    }
    await handle(parser.finish());
    summary.complete = true;
  } catch (e) {
    if (e instanceof CancelledError) {
      result.cancelled = true;
    } else {
      await writer.discard().catch(() => undefined);
      throw e;
    }
  } finally {
    await reader.close().catch(() => undefined);
  }

  summary.finishedAt = new Date().toISOString();
  if (summary.matchedCommits === 0 && !result.cancelled) {
    await writer.discard();
    result.outputFile = null;
    return result;
  }
  await writer.close();
  return result;
}

/** "java", ".java", "*.java" -> ":(icase)*.java" (matches at any depth). */
export function toPathspecs(extensions: string[]): string[] {
  const specs = new Set<string>();
  for (const raw of extensions) {
    const ext = raw.trim().replace(/^\*?\.?/, '');
    if (ext) {
      specs.add(`:(icase)*.${ext}`);
    }
  }
  return [...specs];
}

/** Builds a file name such as "owner_repo_fix-bug_20250101-120000.json". */
/** Folder name for a repository's results, e.g. "google_gson". */
export function projectDirName(repo: RepoRef): string {
  return [repo.owner, repo.name]
    .filter((p): p is string => !!p)
    .join('_')
    .replace(/[<>:"/\\|?*\x00-\x1f\s]+/g, '_');
}

export function defaultOutputFileName(repo: RepoRef, keywords: string[], date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const kw = keywords.map((k) => k.trim()).filter((k) => k).join('-') || 'all';
  const parts = [repo.owner, repo.name, kw.slice(0, 40), stamp].filter((p): p is string => !!p);
  return parts.join('_').replace(/[<>:"/\\|?*\x00-\x1f\s]+/g, '_') + '.json';
}

async function getGitVersion(ctx: GitContext): Promise<{ text: string; numbers: number[] }> {
  try {
    const text = (await runGit(ctx, ['--version'])).trim();
    const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
    return { text, numbers: m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : [] };
  } catch (e) {
    if (e instanceof GitError || e instanceof CancelledError) {
      throw e;
    }
    throw new Error(`Could not run git: ${(e as Error).message}`);
  }
}

function versionLessThan(actual: number[], required: number[]): boolean {
  for (let i = 0; i < required.length; i++) {
    const a = actual[i] ?? 0;
    if (a !== required[i]) {
      return a < required[i];
    }
  }
  return false;
}
