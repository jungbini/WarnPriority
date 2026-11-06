import * as path from 'path';
import { RepoRef } from './types';

/**
 * Parses what a user would paste as "the GitHub address" of a repository.
 *
 * Accepted forms:
 *   https://github.com/owner/repo(.git)
 *   https://github.com/owner/repo/tree/<branch>      (also /commits/<ref>, /blob/<ref>/<path>, /commit/<sha>)
 *   github.com/owner/repo, www.github.com/owner/repo
 *   git@github.com:owner/repo.git, ssh://git@github.com/owner/repo.git
 *   owner/repo
 *   other https hosts (GitHub Enterprise, GitLab, ...): https://host/group/repo
 *   local repositories: file:///path/to/repo or an absolute path
 *
 * Throws an Error with a human readable message when the input is not usable.
 */
export function parseRepositoryInput(input: string): RepoRef {
  const raw = input.trim();
  if (!raw) {
    throw new Error('Repository address is empty.');
  }

  // Local repositories (absolute path or file:// URL).
  if (raw.startsWith('file://')) {
    const p = decodeURIComponent(new URL(raw).pathname);
    return localRepo(process.platform === 'win32' ? p.replace(/^\/([A-Za-z]:)/, '$1') : p);
  }
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    return localRepo(raw);
  }

  // scp-like SSH syntax: git@github.com:owner/repo.git
  const scp = /^([\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(raw);
  if (scp && scp[1]) {
    const host = scp[2].toLowerCase();
    const segments = splitPath(scp[3]);
    const { repoSegments } = splitRepoPath(host, segments);
    return {
      cloneUrl: `${scp[1]}${scp[2]}:${repoSegments.join('/')}.git`,
      webUrl: `https://${host}/${repoSegments.join('/')}`,
      host,
      owner: repoSegments.length > 1 ? repoSegments.slice(0, -1).join('/') : null,
      name: repoSegments[repoSegments.length - 1],
      refHint: null,
    };
  }

  // owner/repo shorthand -> github.com (GitHub user names never contain dots,
  // so "example.com/foo" is still treated as a host + path).
  if (/^[A-Za-z0-9-]+\/[\w.-]+$/.test(raw)) {
    return fromHttpUrl(new URL(`https://github.com/${raw}`));
  }

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Not a valid repository address: ${raw}`);
  }

  if (url.protocol === 'ssh:' || url.protocol === 'git:') {
    const host = url.hostname.toLowerCase();
    const segments = splitPath(decodeURIComponent(url.pathname));
    const { repoSegments } = splitRepoPath(host, segments);
    const user = url.username ? `${url.username}@` : '';
    const port = url.port ? `:${url.port}` : '';
    return {
      cloneUrl: `${url.protocol}//${user}${url.hostname}${port}/${repoSegments.join('/')}.git`,
      webUrl: `https://${host}/${repoSegments.join('/')}`,
      host,
      owner: repoSegments.length > 1 ? repoSegments.slice(0, -1).join('/') : null,
      name: repoSegments[repoSegments.length - 1],
      refHint: null,
    };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Unsupported URL scheme "${url.protocol}". Use an https:// GitHub address.`);
  }
  return fromHttpUrl(url);
}

function fromHttpUrl(url: URL): RepoRef {
  let host = url.host.toLowerCase();
  if (host === 'www.github.com') {
    host = 'github.com';
  }
  const segments = splitPath(decodeURIComponent(url.pathname));
  const { repoSegments, rest } = splitRepoPath(host, segments);
  const repoPath = repoSegments.join('/');
  // Credentials in the URL are deliberately dropped: they would otherwise be
  // written to the cached clone's config and to the output file.
  // github.com only serves https; other hosts keep the scheme the user gave.
  const scheme = host === 'github.com' ? 'https:' : url.protocol;
  return {
    cloneUrl: `${scheme}//${host}/${repoPath}.git`,
    webUrl: `${scheme}//${host}/${repoPath}`,
    host,
    owner: repoSegments.slice(0, -1).join('/'),
    name: repoSegments[repoSegments.length - 1],
    refHint: refFromRest(rest),
  };
}

const REF_MARKERS = new Set(['tree', 'blob', 'commits', 'commit']);

/** Splits URL path segments into the repository path and whatever follows it. */
function splitRepoPath(host: string, segments: string[]): { repoSegments: string[]; rest: string[] } {
  let repoSegments: string[];
  let rest: string[];
  if (host === 'github.com') {
    repoSegments = segments.slice(0, 2);
    rest = segments.slice(2);
  } else {
    // Generic hosts may have nested groups (GitLab); the repo path ends right
    // before "-" or a tree/blob/commits marker.
    let end = segments.length;
    for (let i = 2; i < segments.length; i++) {
      if (segments[i] === '-' || REF_MARKERS.has(segments[i])) {
        end = i;
        break;
      }
    }
    repoSegments = segments.slice(0, end);
    rest = segments.slice(end);
    if (rest[0] === '-') {
      rest = rest.slice(1);
    }
  }

  if (repoSegments.length < 2) {
    throw new Error('The address must point to a repository, e.g. https://github.com/owner/repo');
  }
  const last = repoSegments.length - 1;
  repoSegments[last] = repoSegments[last].replace(/\.git$/i, '');
  for (const seg of repoSegments) {
    if (!/^[\w.-]+$/.test(seg) || seg === '.' || seg === '..') {
      throw new Error(`Invalid owner or repository name: "${seg}"`);
    }
  }
  return { repoSegments, rest };
}

function refFromRest(rest: string[]): string | null {
  if (rest.length < 2 || !REF_MARKERS.has(rest[0])) {
    return null;
  }
  if (rest[0] === 'commit') {
    return rest[1];
  }
  return rest.slice(1).join('/');
}

function splitPath(p: string): string[] {
  return p.split('/').filter((s) => s.length > 0);
}

function localRepo(p: string): RepoRef {
  const normalized = p.replace(/[\\/]+$/, '');
  return {
    cloneUrl: normalized,
    webUrl: null,
    host: null,
    owner: null,
    name: path.basename(normalized).replace(/\.git$/i, '') || 'repository',
    refHint: null,
  };
}
