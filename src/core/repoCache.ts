import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { CancelledError, GitContext, GitError, runGit } from './git';
import { ProgressEvent, RepoRef } from './types';

export type ProgressReporter = (event: ProgressEvent) => void;

/** Directory name used for a repository inside the cache directory. */
export function cacheDirName(repo: RepoRef): string {
  const hash = createHash('sha1').update(repo.cloneUrl).digest('hex').slice(0, 10);
  const readable = [repo.host, repo.owner, repo.name]
    .filter((s): s is string => !!s)
    .join('_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 80);
  return `${readable}-${hash}.git`;
}

/**
 * Makes sure an up-to-date bare clone of the repository exists under
 * `cacheDir` and returns its path. A cached clone is updated with `git fetch`;
 * if the update fails (e.g. offline), the cached data is used with a warning.
 */
export async function ensureBareClone(
  ctx: GitContext,
  repo: RepoRef,
  cacheDir: string,
  progress: ProgressReporter,
  warn: (message: string) => void,
): Promise<string> {
  await fs.mkdir(cacheDir, { recursive: true });
  const target = path.join(cacheDir, cacheDirName(repo));

  if (await isUsableBareRepo(ctx, target)) {
    progress({ stage: 'fetch' });
    try {
      await runGit(ctx, ['fetch', '--prune', '--tags', '--progress', 'origin'], {
        cwd: target,
        onStderr: gitProgressParser(progress, 'fetch'),
      });
    } catch (e) {
      if (e instanceof CancelledError) {
        throw e;
      }
      warn(`Could not update the cached clone, using cached data instead: ${(e as Error).message}`);
    }
    return target;
  }

  // Missing or broken cache entry: clone into a temp dir and move it into place
  // so an interrupted clone never leaves a half-initialised cache behind.
  await fs.rm(target, { recursive: true, force: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  progress({ stage: 'clone' });
  try {
    await runGit(ctx, ['clone', '--bare', '--progress', '--', repo.cloneUrl, tmp], {
      onStderr: gitProgressParser(progress, 'clone'),
    });
    // A bare clone has no fetch refspec; add one so later `git fetch` updates branches.
    await runGit(ctx, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'], { cwd: tmp });
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    if (e instanceof GitError) {
      throw new GitError(
        `Could not clone ${repo.webUrl ?? repo.cloneUrl}. Check that the address is correct and that the repository is public ` +
          `(or that your Git credentials give access to it).\n${e.message}`,
        e.exitCode,
        e.stderr,
      );
    }
    throw e;
  }
  return target;
}

async function isUsableBareRepo(ctx: GitContext, dir: string): Promise<boolean> {
  try {
    await fs.access(dir);
  } catch {
    return false;
  }
  try {
    const out = await runGit(ctx, ['rev-parse', '--is-bare-repository'], { cwd: dir, isolateConfig: true });
    return out.trim() === 'true';
  } catch (e) {
    if (e instanceof CancelledError) {
      throw e;
    }
    return false;
  }
}

/**
 * Resolves the commit to read history from. `refHint` comes from URLs such as
 * /tree/feature/x/src/file.java where the branch name and the file path are
 * indistinguishable, so progressively shorter prefixes are tried.
 */
export async function resolveStartCommit(
  ctx: GitContext,
  repoDir: string,
  refHint: string | null,
): Promise<{ ref: string; sha: string }> {
  const candidates: string[] = [];
  if (refHint) {
    const parts = refHint.split('/');
    for (let n = parts.length; n >= 1; n--) {
      const name = parts.slice(0, n).join('/');
      candidates.push(`refs/heads/${name}`, `refs/tags/${name}`);
      if (n === 1 && /^[0-9a-f]{7,40}$/i.test(name)) {
        candidates.push(name);
      }
    }
  }
  candidates.push('HEAD');

  for (const candidate of candidates) {
    if (candidate.startsWith('-')) {
      continue;
    }
    try {
      const sha = (
        await runGit(ctx, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], { cwd: repoDir, isolateConfig: true })
      ).trim();
      if (sha) {
        const ref = candidate.replace(/^refs\/(heads|tags)\//, '');
        if (refHint && candidate === 'HEAD') {
          ctx.log?.(`Ref "${refHint}" not found in the repository; using the default branch.`);
        }
        return { ref: candidate === 'HEAD' ? await defaultBranchName(ctx, repoDir) : ref, sha };
      }
    } catch (e) {
      if (e instanceof CancelledError) {
        throw e;
      }
      // try the next candidate
    }
  }
  throw new Error('The repository has no commits.');
}

async function defaultBranchName(ctx: GitContext, repoDir: string): Promise<string> {
  try {
    return (await runGit(ctx, ['symbolic-ref', '--short', 'HEAD'], { cwd: repoDir, isolateConfig: true })).trim() || 'HEAD';
  } catch {
    return 'HEAD';
  }
}

/** Turns git's "Receiving objects:  42% (...)" stderr output into progress reports. */
function gitProgressParser(progress: ProgressReporter, stage: 'clone' | 'fetch'): (chunk: string) => void {
  let lastReported = '';
  return (chunk: string) => {
    const lines = chunk.split(/[\r\n]+/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files):\s+(\d+)%/.exec(lines[i]);
      if (m) {
        const detail = `${m[1]} ${m[2]}%`;
        if (detail !== lastReported) {
          lastReported = detail;
          progress({ stage, detail });
        }
        return;
      }
    }
  };
}
