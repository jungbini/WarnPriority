/**
 * Command line entry point for the same collector the VS Code command uses.
 * Handy for batch runs and for testing without VS Code:
 *
 *   npm run compile
 *   node out/cli.js https://github.com/owner/repo "fix,bug" [--out-dir dir]
 *        [--ext java,py] [--max 100] [--case-sensitive] [--regex] [--merges] [--ignore-ws]
 *        [--cache <dir>] [--git <path>]
 *
 *   node out/cli.js pmd <result.json> [--ruleset all|rulesets/java/quickstart.xml|...] [--pmd-home dir] [--java path]
 *        Runs PMD on the saved before/after files and writes <result>.pmd.json and <result>.pmd-rules.csv.
 *
 *   node out/cli.js topics <result.json> [--python python3] [--model nomic-ai/CodeRankEmbed] [--min-topic-size 10]
 *        [--extra-stopwords a,b] [--include-tests]
 *        Topic modeling (BERTopic) of the "before" files; writes <result>.topics.csv and <result>.topic-keywords.csv.
 *        The Python needs: pip install -r resources/topics/requirements.txt
 */
import * as os from 'os';
import * as path from 'path';
import { collectCommitChanges, defaultOutputFileName, projectDirName, SOURCE_FILE_EXTENSIONS } from './core/collector';
import { analyzeWithPmd } from './core/analyzeWithPmd';
import { CancelledError } from './core/git';
import { PMD_VERSION } from './core/pmdArtifacts';
import { installPmd, locatePmd } from './core/pmdInstaller';
import { ALL_RULES } from './core/pmdRunner';
import { runTopicModel } from './core/topics';
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
    'Usage: node out/cli.js <github-url> <keywords> [--out-dir dir] [--ext java,py] [--max N]\n' +
      '                         [--case-sensitive] [--regex] [--merges] [--ignore-ws] [--cache dir] [--git path]\n' +
      '  <keywords> is a comma-separated list; use "" to collect every commit.\n' +
      '  --ext defaults to source files of static-analyzable languages.\n' +
      '\n' +
      '       node out/cli.js pmd <result.json> [--ruleset all|<rulesets>] [--pmd-home dir] [--java path]\n' +
      '  Runs PMD on the saved before/after files; PMD is downloaded to ~/.warnpriority/pmd unless --pmd-home is given.\n' +
      '\n' +
      '       node out/cli.js topics <result.json> [--python python3] [--model nomic-ai/CodeRankEmbed] [--min-topic-size 10] [--extra-stopwords a,b] [--include-tests]\n' +
      '  Topic modeling (BERTopic) of the before files; the Python needs resources/topics/requirements.txt installed.',
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
      if (['case-sensitive', 'regex', 'merges', 'ignore-ws', 'include-tests', 'quiet'].includes(name)) {
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
  if (positional[0] === 'topics') {
    if (positional.length < 2) {
      usage();
    }
    await runTopicsCommand(path.resolve(positional[1]), flags);
    return;
  }
  if (positional[0] === 'pmd') {
    if (positional.length < 2) {
      usage();
    }
    await runPmdCommand(path.resolve(positional[1]), flags);
    return;
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
    // Default (and for an empty list): source files of static-analyzable languages.
    fileExtensions: typeof flags.ext === 'string' ? flags.ext.split(',') : [...SOURCE_FILE_EXTENSIONS],
    includeMergeCommits: flags.merges === true,
    ignoreWhitespace: flags['ignore-ws'] === true,
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
    console.log('No matching commit changed source code files.');
    return;
  }
  const s = result.summary;
  console.log(
    `${result.cancelled ? 'Cancelled; partial results' : 'Done'}: ${s.commitsWithCodeChanges}/${s.matchedCommits} commits, ` +
      `${s.codeChanges.total} code changes (added ${s.codeChanges.added}, deleted ${s.codeChanges.deleted}, modified ${s.codeChanges.modified}), ` +
      `${s.savedFiles} before/after files saved`,
  );
  console.log(result.outputFile);
}

async function runPmdCommand(resultFile: string, flags: Record<string, string | boolean>): Promise<void> {
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  const quiet = flags.quiet === true;
  const log = quiet ? undefined : (m: string) => console.error(m);
  const storageDir = path.join(os.homedir(), '.warnpriority');

  let pmd = await locatePmd(typeof flags['pmd-home'] === 'string' ? path.resolve(flags['pmd-home']) : '', storageDir);
  if (!pmd) {
    console.error(`Downloading PMD ${PMD_VERSION} from Maven Central...`);
    pmd = await installPmd(storageDir, {
      signal: controller.signal,
      log,
      onProgress: quiet ? undefined : (done, total) => process.stderr.write(`\r\x1b[K${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`),
    });
    process.stderr.write('\n');
  }
  const result = await analyzeWithPmd({
    resultFile,
    ruleset: (flags.ruleset as string) ?? ALL_RULES,
    javaPath: (flags.java as string) ?? defaultJava(),
    pmd,
    signal: controller.signal,
    log,
    onProgress: (e) => log?.(e.stage === 'pmd' ? `Running PMD on ${e.files} files...` : 'Comparing warnings...'),
  });
  const s = result.summary;
  console.log(
    `Done: warnings changed in ${s.commitsWithWarningChanges}/${s.commits} commits: ${s.removed} disappeared, ${s.added} appeared, ` +
      `${s.unchanged} unchanged; in the changed code ${s.changedCodeBefore} before, ${s.changedCodeAfter} after` +
      (s.warningRemovalRate !== null ? ` (warning removal rate ${s.warningRemovalRate})` : '') +
      (s.filesWithErrors > 0 ? `; ${s.filesWithErrors} files could not be parsed` : '') +
      (s.skippedRules > 0 ? `; ${s.skippedRules} rules skipped because of their configuration` : ''),
  );
  console.log(result.outputFile);
  console.log(result.rulesFile);
}

async function runTopicsCommand(resultFile: string, flags: Record<string, string | boolean>): Promise<void> {
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  const quiet = flags.quiet === true;
  const result = await runTopicModel({
    python: (flags.python as string) ?? (process.platform === 'win32' ? 'python' : 'python3'),
    resultFile,
    model: flags.model as string | undefined,
    minTopicSize: flags['min-topic-size'] ? parseInt(flags['min-topic-size'] as string, 10) : undefined,
    extraStopwords: typeof flags['extra-stopwords'] === 'string' ? flags['extra-stopwords'].split(',') : [],
    includeTests: flags['include-tests'] === true,
    signal: controller.signal,
    log: quiet ? undefined : (l) => console.error(l),
    onProgress: quiet
      ? undefined
      : (p) => {
          if (p.stage === 'embed') {
            process.stderr.write(`\r\x1b[KEmbedding ${p.done}/${p.total}`);
            if (p.done === p.total) {
              process.stderr.write('\n');
            }
          } else if (p.stage !== 'done') {
            console.error(`[${p.stage}]`);
          }
        },
  });
  console.log(
    `Done: ${result.topics} topics over ${result.files} before files (${result.uniqueChunks} distinct code chunks` +
      (result.unclassifiedChunks > 0 ? `, ${result.unclassifiedChunks} unclassified` : '') +
      (result.testFiles > 0 ? `; ${result.testFiles} test files left out` : '') +
      ').',
  );
  console.log(result.csv);
  console.log(result.keywordsCsv);
}

function defaultJava(): string {
  return process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
}

main().catch((e) => {
  console.error(e instanceof CancelledError ? 'Cancelled.' : `Error: ${(e as Error).message}`);
  process.exit(1);
});
