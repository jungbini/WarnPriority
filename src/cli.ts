/**
 * Command line entry point for the same collector the VS Code command uses.
 * Handy for batch runs and for testing without VS Code:
 *
 *   npm run compile
 *   node out/cli.js https://github.com/owner/repo "fix,bug" [--out-dir dir]
 *        [--ext java,py | --ext all] [--max 100] [--case-sensitive] [--regex] [--merges] [--ignore-ws] [--all-lines]
 *        [--cache <dir>] [--git <path>]
 */
import * as os from 'os';
import * as path from 'path';
import { collectCommitChanges, defaultOutputFileName, projectDirName, SOURCE_FILE_EXTENSIONS } from './core/collector';
import { CancelledError } from './core/git';
import { parseRepositoryInput } from './core/githubUrl';
import { ProgressEvent } from './core/types';

function describeProgress(e: ProgressEvent): string {
  switch (e.stage) {
    case 'clone':
      return `Cloning repository... ${e.detail ?? ''}`;
    case 'fetch':
      return `Updating cached clone... ${e.detail ?? ''}`;
    case 'count':
      return 'Counting matching commits...';
    case 'process':
      return `Processing commits ${e.done}/${e.total}`;
  }
}

function usage(): never {
  console.error(
    'Usage: node out/cli.js <github-url> <keywords> [--out-dir dir] [--ext java,py|all] [--max N]\n' +
      '                         [--case-sensitive] [--regex] [--merges] [--ignore-ws] [--all-lines] [--cache dir] [--git path]\n' +
      '  <keywords> is a comma-separated list; use "" to collect every commit.\n' +
      '  --ext defaults to source files of static-analyzable languages; "all" collects every file.\n' +
      '  --all-lines also records changes that touch only comments or blank lines.',
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (['case-sensitive', 'regex', 'merges', 'ignore-ws', 'all-lines', 'quiet'].includes(name)) {
        flags[name] = true;
      } else if (i + 1 < args.length) {
        flags[name] = args[++i];
      } else {
        usage();
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length < 2) {
    usage();
  }

  const repo = parseRepositoryInput(positional[0]);
  const keywords = positional[1].split(',').map((k) => k.trim()).filter((k) => k);
  // Same layout as the VS Code command: <out-dir>/<owner>_<repo>/{<result>.json, <sha>/before|after/...}
  const outputDir = path.join(path.resolve((flags['out-dir'] as string) ?? 'warnpriority-output'), projectDirName(repo));
  const quiet = flags.quiet === true;

  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());

  const result = await collectCommitChanges({
    repo,
    keywords,
    caseSensitive: flags['case-sensitive'] === true,
    useRegex: flags.regex === true,
    // Default: source files only (same as the VS Code setting's default); --ext all = every file.
    fileExtensions:
      typeof flags.ext !== 'string' ? [...SOURCE_FILE_EXTENSIONS] : flags.ext.trim() === 'all' ? [] : flags.ext.split(','),
    includeMergeCommits: flags.merges === true,
    ignoreWhitespace: flags['ignore-ws'] === true,
    codeLinesOnly: flags['all-lines'] !== true,
    maxCommits: flags.max ? parseInt(flags.max as string, 10) : 0,
    outputDir,
    outputFileName: defaultOutputFileName(repo, keywords),
    cacheDir: path.resolve((flags.cache as string) ?? path.join(os.homedir(), '.warnpriority', 'repos')),
    gitPath: (flags.git as string) ?? 'git',
    signal: controller.signal,
    log: quiet ? undefined : (m) => console.error(m),
    onProgress: quiet ? undefined : (e) => process.stderr.write(`\r\x1b[K${describeProgress(e)}`),
  });
  if (!quiet) {
    process.stderr.write('\n');
  }

  if (!result.outputFile) {
    console.log(
      result.summary.matchedCommits > 0
        ? `${result.summary.matchedCommits} commit(s) matched, but none changed source code.`
        : 'No commits matched.',
    );
    return;
  }
  const s = result.summary;
  console.log(
    `${result.cancelled ? 'Cancelled; partial results' : 'Done'}: ${s.commitsWithCodeChanges}/${s.matchedCommits} commits, ` +
      `${s.codeChanges.total} code changes (added ${s.codeChanges.added}, deleted ${s.codeChanges.deleted}, modified ${s.codeChanges.modified}), ` +
      `${s.savedFiles} before/after files saved` +
      (s.skippedNonCodeChanges > 0 ? `, ${s.skippedNonCodeChanges} comment/blank-only changes skipped` : ''),
  );
  console.log(result.outputFile);
}

main().catch((e) => {
  console.error(e instanceof CancelledError ? 'Cancelled.' : `Error: ${(e as Error).message}`);
  process.exit(1);
});
