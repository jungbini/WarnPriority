import { createHash } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import { CancelledError } from './git';
import { MavenArtifact, PMD_ARTIFACTS, PMD_VERSION } from './pmdArtifacts';

/** Maven Central first; Google's official mirror of it when Central fails (e.g. HTTP 429 rate limits). */
export const MAVEN_REPOSITORIES = ['https://repo1.maven.org/maven2/', 'https://maven-central.storage-download.googleapis.com/maven2/'];

const COMPLETE_MARKER = '.complete';

export interface PmdLocation {
  /** Java classpath for PMD (a "<dir>/*" wildcard). */
  classpath: string;
  /** Where it came from, for logs. */
  description: string;
}

/** Folder of the downloaded PMD below the extension's storage folder. */
export function pmdInstallDir(storageDir: string): string {
  return path.join(storageDir, 'pmd', PMD_VERSION);
}

export async function isPmdInstalled(storageDir: string): Promise<boolean> {
  return fs.access(path.join(pmdInstallDir(storageDir), COMPLETE_MARKER)).then(
    () => true,
    () => false,
  );
}

export function downloadSize(artifacts: readonly MavenArtifact[] = PMD_ARTIFACTS): number {
  return artifacts.reduce((sum, a) => sum + a.size, 0);
}

/**
 * Locates PMD: a user-provided installation (`pmdHome`, the folder of an
 * unpacked PMD distribution containing lib/), or the downloaded one.
 * Returns null when PMD still has to be downloaded.
 */
export async function locatePmd(pmdHome: string, storageDir: string): Promise<PmdLocation | null> {
  if (pmdHome) {
    const lib = path.join(pmdHome, 'lib');
    const jars = await fs.readdir(lib).catch(() => [] as string[]);
    if (!jars.some((j) => /^pmd-java-.*\.jar$/.test(j))) {
      throw new Error(`No PMD Java module (lib/pmd-java-*.jar) found in "${pmdHome}". Point warnPriority.pmd.home to an unpacked PMD 7 distribution.`);
    }
    return { classpath: path.join(lib, '*'), description: `PMD at ${pmdHome}` };
  }
  if (await isPmdInstalled(storageDir)) {
    return { classpath: path.join(pmdInstallDir(storageDir), 'lib', '*'), description: `PMD ${PMD_VERSION}` };
  }
  return null;
}

export interface InstallOptions {
  signal?: AbortSignal;
  log?: (message: string) => void;
  /** Called with the number of bytes downloaded so far and the total. */
  onProgress?: (done: number, total: number) => void;
  /** For tests. */
  artifacts?: readonly MavenArtifact[];
  repositories?: string[];
  retryDelayMs?: number;
}

/**
 * Downloads the PMD jars into <storageDir>/pmd/<version>/lib. Every jar is
 * checked against its pinned SHA-256; the installation is only marked
 * complete when all jars are in place, so an interrupted download is redone.
 */
export async function installPmd(storageDir: string, opts: InstallOptions = {}): Promise<PmdLocation> {
  const artifacts = opts.artifacts ?? PMD_ARTIFACTS;
  const repositories = opts.repositories ?? MAVEN_REPOSITORIES;
  const dir = pmdInstallDir(storageDir);
  const lib = path.join(dir, 'lib');
  const staging = `${lib}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(staging, { recursive: true });

  const total = downloadSize(artifacts);
  let done = 0;
  opts.onProgress?.(0, total);
  try {
    // A few downloads at a time: fast, and gentle on the repository's rate limits.
    const queue = [...artifacts];
    const worker = async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        await downloadArtifact(a, path.join(staging, path.basename(a.path)), repositories, opts, (n) => {
          done += n;
          opts.onProgress?.(done, total);
        });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    await fs.rm(lib, { recursive: true, force: true });
    await fs.rename(staging, lib);
    await fs.writeFile(path.join(dir, COMPLETE_MARKER), `${new Date().toISOString()}\n`);
  } catch (e) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  opts.log?.(`Installed PMD ${PMD_VERSION} to ${dir}`);
  return { classpath: path.join(lib, '*'), description: `PMD ${PMD_VERSION}` };
}

async function downloadArtifact(
  artifact: MavenArtifact,
  target: string,
  repositories: string[],
  opts: InstallOptions,
  onBytes: (n: number) => void,
): Promise<void> {
  const failures: string[] = [];
  for (const repo of repositories) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (opts.signal?.aborted) {
        throw new CancelledError();
      }
      let received = 0;
      try {
        await fetchToFile(repo + artifact.path, target, artifact.sha256, opts.signal, (n) => {
          received += n;
          onBytes(n);
        });
        return;
      } catch (e) {
        onBytes(-received);
        if (e instanceof CancelledError || opts.signal?.aborted) {
          throw new CancelledError();
        }
        failures.push(`${repo}: ${(e as Error).message}`);
        opts.log?.(`Download of ${path.basename(artifact.path)} failed (${(e as Error).message}); retrying`);
        await delay(attempt * (opts.retryDelayMs ?? 1000), opts.signal);
      }
    }
  }
  throw new Error(`Could not download ${path.basename(artifact.path)}:\n  ${failures.join('\n  ')}`);
}

function fetchToFile(url: string, target: string, sha256: string, signal: AbortSignal | undefined, onBytes: (n: number) => void, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https:') ? https.get : http.get;
    const req = get(url, { signal, timeout: 60_000, headers: { 'User-Agent': 'WarnPriority-VSCode' } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects < 5) {
        res.resume();
        fetchToFile(new URL(res.headers.location, url).toString(), target, sha256, signal, onBytes, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const hash = createHash('sha256');
      const out = createWriteStream(target);
      res.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        onBytes(chunk.length);
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => {
        const actual = hash.digest('hex');
        if (actual !== sha256) {
          fs.rm(target, { force: true }).finally(() => reject(new Error(`checksum mismatch (got sha256 ${actual})`)));
        } else {
          resolve();
        }
      });
      res.pipe(out);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => reject(signal?.aborted ? new CancelledError() : e));
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
