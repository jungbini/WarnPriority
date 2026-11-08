import { existsSync, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { analyzeWithPmd, PmdAnalysisResult } from './core/analyzeWithPmd';
import { collectCommitChanges, CollectResult, defaultOutputFileName, projectDirName, SOURCE_FILE_EXTENSIONS } from './core/collector';
import { CancelledError } from './core/git';
import { PMD_VERSION } from './core/pmdArtifacts';
import { downloadSize, installPmd, locatePmd, PmdLocation } from './core/pmdInstaller';
import { ALL_RULES } from './core/pmdRunner';
import { DEFAULT_EMBEDDING_MODEL, managedPython, runTopicModel, setupManagedPython, TopicProgress, TopicResult } from './core/topics';
import { parseRepositoryInput } from './core/githubUrl';
import { ProgressEvent } from './core/types';

const LAST_URL_KEY = 'warnPriority.lastRepositoryUrl';
const LAST_KEYWORDS_KEY = 'warnPriority.lastKeywords';

let running = false;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('WarnPriority');
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('warnPriority.collectCommitChanges', () => runCollect(context, output)),
    vscode.commands.registerCommand('warnPriority.clearRepositoryCache', () => clearCache(context, output)),
    vscode.commands.registerCommand('warnPriority.runPmd', (uri?: vscode.Uri) => runPmdCommand(context, output, uri)),
    vscode.commands.registerCommand('warnPriority.topicModel', (uri?: vscode.Uri) => runTopicsCommand(context, output, uri)),
  );
}

export function deactivate(): void {
  // nothing to clean up; running git processes are killed via their AbortSignal
}

async function runCollect(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  if (running) {
    vscode.window.showWarningMessage(vscode.l10n.t('Another WarnPriority task is running. Wait for it to finish or cancel it.'));
    return;
  }

  // Step 1: GitHub address
  const url = await vscode.window.showInputBox({
    title: vscode.l10n.t('Collect changed code (1/2): GitHub repository'),
    prompt: vscode.l10n.t('Enter the GitHub repository address'),
    placeHolder: 'https://github.com/owner/repo',
    value: context.globalState.get<string>(LAST_URL_KEY, ''),
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value.trim()) {
        return vscode.l10n.t('Enter a repository address, e.g. https://github.com/owner/repo');
      }
      try {
        parseRepositoryInput(value);
        return null;
      } catch (e) {
        return vscode.l10n.t('Invalid repository address: {0}', (e as Error).message);
      }
    },
  });
  if (url === undefined) {
    return;
  }
  const repo = parseRepositoryInput(url);

  // Step 2: commit message keywords
  const keywordInput = await vscode.window.showInputBox({
    title: vscode.l10n.t('Collect changed code (2/2): commit message keywords'),
    prompt: vscode.l10n.t('Keywords to search for in commit messages, separated by commas (leave empty to collect every commit)'),
    placeHolder: 'fix, bug',
    value: context.globalState.get<string>(LAST_KEYWORDS_KEY, ''),
    ignoreFocusOut: true,
  });
  if (keywordInput === undefined) {
    return;
  }
  const keywords = keywordInput
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  await context.globalState.update(LAST_URL_KEY, url.trim());
  await context.globalState.update(LAST_KEYWORDS_KEY, keywordInput.trim());

  const config = vscode.workspace.getConfiguration('warnPriority');
  const outputRoot = await chooseOutputRoot(config);
  if (!outputRoot) {
    return;
  }

  running = true;
  output.appendLine(
    `[${new Date().toLocaleString()}] WarnPriority v${context.extension.packageJSON.version} | ` +
      `${repo.webUrl ?? repo.cloneUrl} | keywords: ${keywords.join(', ') || '(all commits)'}`,
  );
  let result: CollectResult;
  try {
    result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `WarnPriority: ${repo.owner ? `${repo.owner}/` : ''}${repo.name}`,
        cancellable: true,
      },
      async (progress, token) => {
        const controller = new AbortController();
        const sub = token.onCancellationRequested(() => controller.abort());
        let percent = 0;
        const report = (e: ProgressEvent) => {
          const target = e.stage === 'process' ? 10 + (90 * e.done) / Math.max(e.total, 1) : e.stage === 'count' ? 10 : percent;
          progress.report({ message: describeProgress(e), increment: Math.max(0, target - percent) });
          percent = Math.max(percent, target);
        };
        try {
          return await collectCommitChanges({
            repo,
            keywords,
            caseSensitive: config.get<boolean>('caseSensitive', false),
            useRegex: config.get<boolean>('useRegex', false),
            fileExtensions: config.get<string[]>('fileExtensions', [...SOURCE_FILE_EXTENSIONS]),
            includeMergeCommits: config.get<boolean>('includeMergeCommits', false),
            ignoreWhitespace: config.get<boolean>('ignoreWhitespace', false),
            maxCommits: config.get<number>('maxCommits', 0),
            outputDir: path.join(outputRoot, projectDirName(repo)),
            outputFileName: defaultOutputFileName(repo, keywords),
            cacheDir: path.join(context.globalStorageUri.fsPath, 'repos'),
            gitPath: await resolveGitPath(config),
            signal: controller.signal,
            log: (m) => output.appendLine(m),
            onProgress: report,
          });
        } finally {
          sub.dispose();
        }
      },
    );
  } catch (e) {
    if (e instanceof CancelledError) {
      vscode.window.showInformationMessage(vscode.l10n.t('Collection cancelled.'));
      return;
    }
    const message = (e as Error).message;
    output.appendLine(`ERROR: ${message}`);
    const showLog = vscode.l10n.t('Show Log');
    const choice = await vscode.window.showErrorMessage(
      vscode.l10n.t('WarnPriority: collection failed. {0}', message.split('\n')[0]),
      showLog,
    );
    if (choice === showLog) {
      output.show();
    }
    return;
  } finally {
    running = false;
  }

  // Outside withProgress, so the progress notification closes right away.
  output.appendLine(JSON.stringify(result.summary));
  await showResult(result, keywords, output);
}

function describeProgress(e: ProgressEvent): string {
  const detail = 'detail' in e && e.detail ? ` (${e.detail})` : '';
  switch (e.stage) {
    case 'clone':
      return vscode.l10n.t('Cloning repository (first run only)...') + detail;
    case 'fetch':
      return vscode.l10n.t('Updating cached repository...') + detail;
    case 'count':
      return vscode.l10n.t('Searching commit messages...');
    case 'process':
      return vscode.l10n.t('Extracting changed code: {0}/{1} commits', e.done, e.total);
  }
}

/** Opens the result file in an editor and reports what was collected. */
async function showResult(result: CollectResult, keywords: string[], output: vscode.OutputChannel): Promise<void> {
  if (result.warnings.length > 0) {
    output.show(true);
  }
  const { outputFile, summary } = result;
  if (!outputFile) {
    vscode.window.showInformationMessage(
      keywords.length > 0
        ? vscode.l10n.t('No commit whose message contains "{0}" changed source code files.', keywords.join('", "'))
        : vscode.l10n.t('No commit changed source code files.'),
    );
    return;
  }

  const uri = vscode.Uri.file(outputFile);
  try {
    // "vscode.open" (unlike openTextDocument) also works for files over 50 MB,
    // which VS Code does not sync to extensions.
    await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
  } catch (e) {
    output.appendLine(`Could not open ${outputFile}: ${(e as Error).message}`);
  }

  const c = summary.codeChanges;
  const folder = path.basename(result.outputDir);
  const text = result.cancelled
    ? vscode.l10n.t('Cancelled. Partial results ({0} commits) were saved to {1}.', summary.matchedCommits, folder)
    : vscode.l10n.t(
        'Collected {0} code changes (added {1}, deleted {2}, modified {3}) from {4} commits and saved {5} before/after files in the {6} folder.',
        c.total,
        c.added,
        c.deleted,
        c.modified,
        summary.commitsWithCodeChanges,
        summary.savedFiles,
        folder,
      );
  const analyze = vscode.l10n.t('Analyze with PMD');
  const reveal = vscode.l10n.t('Reveal in File Explorer');
  const choice = result.cancelled
    ? await vscode.window.showWarningMessage(text, analyze, reveal)
    : await vscode.window.showInformationMessage(text, analyze, reveal);
  if (choice === analyze) {
    await vscode.commands.executeCommand('warnPriority.runPmd', uri);
  } else if (choice === reveal) {
    await vscode.commands.executeCommand('revealFileInOS', uri);
  }
}

/**
 * Root folder for results (a subfolder per repository is created inside):
 * `warnPriority.outputDirectory` if set (relative paths are resolved against
 * the first workspace folder), otherwise `<workspace>/warnpriority-output`.
 * Without a workspace the user picks a folder.
 */
async function chooseOutputRoot(config: vscode.WorkspaceConfiguration): Promise<string | undefined> {
  const dir = configuredOutputRoot(config);
  if (!dir) {
    const picked = await vscode.window.showOpenDialog({
      title: vscode.l10n.t('Select a folder to save the results in'),
      openLabel: vscode.l10n.t('Save Here'),
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(os.homedir()),
    });
    return picked?.[0]?.fsPath;
  }
  if (!config.get<string>('outputDirectory', '').trim()) {
    await keepOutOfGit(dir);
  }
  return dir;
}

/** The output root from the settings / workspace, or undefined when neither is available. */
function configuredOutputRoot(config: vscode.WorkspaceConfiguration): string | undefined {
  const workspaceDir = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri.fsPath;
  let dir = config.get<string>('outputDirectory', '').trim();
  if (dir.startsWith('~')) {
    dir = path.join(os.homedir(), dir.slice(1));
  }
  if (!dir) {
    return workspaceDir ? path.join(workspaceDir, 'warnpriority-output') : undefined;
  }
  return path.isAbsolute(dir) ? dir : path.join(workspaceDir ?? os.homedir(), dir);
}

/**
 * The default output folder lives inside the user's workspace. Ignore it in
 * git so thousands of checked-out before/after files do not flood the
 * Source Control view. An existing .gitignore is left alone.
 */
async function keepOutOfGit(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs
    .writeFile(path.join(dir, '.gitignore'), '# Created by WarnPriority: keep collected results out of git.\n*\n', { flag: 'wx' })
    .catch(() => undefined);
}

/** `warnPriority.gitPath`, else the Git that VS Code's Git extension uses, else "git" on PATH. */
async function resolveGitPath(config: vscode.WorkspaceConfiguration): Promise<string> {
  const configured = config.get<string>('gitPath', '').trim();
  if (configured) {
    return configured;
  }
  try {
    const ext = vscode.extensions.getExtension<{ getAPI(version: 1): { git: { path: string } } }>('vscode.git');
    if (ext) {
      const exports = ext.isActive ? ext.exports : await ext.activate();
      const gitPath = exports.getAPI(1).git.path;
      if (gitPath) {
        return gitPath;
      }
    }
  } catch {
    // Git extension disabled or unavailable
  }
  return 'git';
}

async function clearCache(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  if (running) {
    vscode.window.showWarningMessage(vscode.l10n.t('Another WarnPriority task is running. Wait for it to finish or cancel it.'));
    return;
  }
  const dir = path.join(context.globalStorageUri.fsPath, 'repos');
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  if (entries.length === 0) {
    vscode.window.showInformationMessage(vscode.l10n.t('The repository cache is already empty.'));
    return;
  }
  const confirm = vscode.l10n.t('Delete');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('Delete {0} cached repository clone(s)? They will be downloaded again on the next run.', entries.length),
    { modal: true },
    confirm,
  );
  if (choice !== confirm) {
    return;
  }
  await fs.rm(dir, { recursive: true, force: true });
  output.appendLine(`Cleared repository cache: ${dir}`);
  vscode.window.showInformationMessage(vscode.l10n.t('Repository cache cleared.'));
}

/**
 * Runs PMD on the before/after files of a result JSON and writes
 * <result>.pmd.json with the warnings that disappeared or appeared.
 */
async function runPmdCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel, uri?: vscode.Uri): Promise<void> {
  if (running) {
    vscode.window.showWarningMessage(vscode.l10n.t('Another WarnPriority task is running. Wait for it to finish or cancel it.'));
    return;
  }
  const config = vscode.workspace.getConfiguration('warnPriority');
  const resultFile = uri?.scheme === 'file' ? uri.fsPath : await pickResultFile(config, vscode.l10n.t('Select a result file to analyze with PMD'));
  if (!resultFile) {
    return;
  }
  if (/\.pmd\.json$/i.test(resultFile)) {
    vscode.window.showErrorMessage(vscode.l10n.t('Select a result JSON written by "Collect Changed Code", not a .pmd.json file.'));
    return;
  }

  running = true;
  output.appendLine(`[${new Date().toLocaleString()}] WarnPriority v${context.extension.packageJSON.version} | PMD analysis of ${resultFile}`);
  try {
    const pmd = await ensurePmd(context, config, output);
    if (!pmd) {
      return;
    }
    output.appendLine(`Using ${pmd.description}`);
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'WarnPriority: PMD', cancellable: true },
      async (progress, token) => {
        const controller = new AbortController();
        const sub = token.onCancellationRequested(() => controller.abort());
        try {
          return await analyzeWithPmd({
            resultFile,
            ruleset: config.get<string>('pmd.ruleset', ALL_RULES),
            javaPath: resolveJava(config),
            pmd,
            signal: controller.signal,
            log: (m) => output.appendLine(m),
            onProgress: (e) =>
              progress.report({
                message:
                  e.stage === 'pmd'
                    ? vscode.l10n.t('Running PMD on {0} files...', e.files)
                    : vscode.l10n.t('Comparing warnings before and after each commit...'),
              }),
          });
        } finally {
          sub.dispose();
        }
      },
    );
    running = false;
    await showPmdResult(result, output);
  } catch (e) {
    if (e instanceof CancelledError) {
      vscode.window.showInformationMessage(vscode.l10n.t('PMD analysis cancelled.'));
      return;
    }
    const message = (e as Error).message;
    output.appendLine(`ERROR: ${message}`);
    const showLog = vscode.l10n.t('Show Log');
    if ((await vscode.window.showErrorMessage(vscode.l10n.t('WarnPriority: PMD analysis failed. {0}', message.split('\n')[0]), showLog)) === showLog) {
      output.show();
    }
  } finally {
    running = false;
  }
}

/** The configured PMD, the downloaded one, or a fresh download (after asking). */
async function ensurePmd(context: vscode.ExtensionContext, config: vscode.WorkspaceConfiguration, output: vscode.OutputChannel): Promise<PmdLocation | undefined> {
  const storageDir = context.globalStorageUri.fsPath;
  const found = await locatePmd(config.get<string>('pmd.home', '').trim(), storageDir);
  if (found) {
    return found;
  }
  const mb = (bytes: number) => (bytes / 1048576).toFixed(1);
  const download = vscode.l10n.t('Download');
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t('PMD {0} is needed to analyze the files. Download it from Maven Central now ({1} MB, only once)?', PMD_VERSION, mb(downloadSize())),
    { modal: true },
    download,
  );
  if (choice !== download) {
    return undefined;
  }
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Downloading PMD {0}', PMD_VERSION), cancellable: true },
    async (progress, token) => {
      const controller = new AbortController();
      const sub = token.onCancellationRequested(() => controller.abort());
      let reported = 0;
      try {
        return await installPmd(storageDir, {
          signal: controller.signal,
          log: (m) => output.appendLine(m),
          onProgress: (done, total) => {
            const percent = (100 * done) / total;
            progress.report({ message: `${mb(done)} / ${mb(total)} MB`, increment: Math.max(0, percent - reported) });
            reported = Math.max(reported, percent);
          },
        });
      } finally {
        sub.dispose();
      }
    },
  );
}

async function showPmdResult(result: PmdAnalysisResult, output: vscode.OutputChannel): Promise<void> {
  const s = result.summary;
  output.appendLine(JSON.stringify(s));
  const uri = vscode.Uri.file(result.outputFile);
  await Promise.resolve(vscode.commands.executeCommand('vscode.open', uri, { preview: false })).catch((e: Error) =>
    output.appendLine(`Could not open ${result.outputFile}: ${e.message}`),
  );
  let text = vscode.l10n.t(
    'PMD: warnings changed in {0} of {1} commits ({2} disappeared, {3} appeared, {4} unchanged). Saved to {5}.',
    s.commitsWithWarningChanges,
    s.commits,
    s.removed,
    s.added,
    s.unchanged,
    path.basename(result.outputFile),
  );
  if (s.filesWithErrors > 0) {
    text += ' ' + vscode.l10n.t('{0} files could not be parsed by PMD and were skipped.', s.filesWithErrors);
  }
  if (s.skippedRules > 0) {
    text += ' ' + vscode.l10n.t('{0} PMD rules were skipped because of their configuration (see the log).', s.skippedRules);
    output.show(true);
  }
  const reveal = vscode.l10n.t('Reveal in File Explorer');
  if ((await vscode.window.showInformationMessage(text, reveal)) === reveal) {
    await vscode.commands.executeCommand('revealFileInOS', uri);
  }
}

/** Lets the user pick a result JSON: the open one, recent ones in the output folder, or any file. */
async function pickResultFile(config: vscode.WorkspaceConfiguration, title: string): Promise<string | undefined> {
  type Item = vscode.QuickPickItem & { file?: string };
  const items: Item[] = [];
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === 'file' && /\.json$/i.test(active.fsPath) && !/\.pmd\.json$/i.test(active.fsPath)) {
    items.push({ label: path.basename(active.fsPath), description: vscode.l10n.t('Currently open file'), file: active.fsPath });
  }
  const root = configuredOutputRoot(config);
  if (root) {
    for (const f of await findResultFiles(root)) {
      if (f.file !== items[0]?.file) {
        items.push({ label: path.basename(f.file), description: path.basename(path.dirname(f.file)), detail: f.mtime.toLocaleString(), file: f.file });
      }
    }
  }
  const browse: Item = { label: `$(folder-opened) ${vscode.l10n.t('Browse...')}` };
  let picked: Item | undefined = browse;
  if (items.length > 0) {
    picked = await vscode.window.showQuickPick([...items, browse], { title, matchOnDescription: true });
  }
  if (!picked) {
    return undefined;
  }
  if (picked.file) {
    return picked.file;
  }
  const uris = await vscode.window.showOpenDialog({
    title,
    canSelectMany: false,
    filters: { JSON: ['json'] },
    defaultUri: root ? vscode.Uri.file(root) : undefined,
  });
  return uris?.[0]?.fsPath;
}

/** Result JSONs in <root>/<project>/, newest first. */
async function findResultFiles(root: string): Promise<{ file: string; mtime: Date }[]> {
  const found: { file: string; mtime: Date }[] = [];
  for (const project of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!project.isDirectory()) {
      continue;
    }
    const dir = path.join(root, project.name);
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      if (/\.json$/i.test(name) && !/\.pmd\.json$/i.test(name)) {
        const stat = await fs.stat(path.join(dir, name)).catch(() => null);
        if (stat?.isFile()) {
          found.push({ file: path.join(dir, name), mtime: stat.mtime });
        }
      }
    }
  }
  return found.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/** warnPriority.pmd.java, else JAVA_HOME, else the JDK configured for VS Code's Java extension, else "java". */
function resolveJava(config: vscode.WorkspaceConfiguration): string {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const configured = config.get<string>('pmd.java', '').trim();
  if (configured) {
    return configured;
  }
  for (const home of [process.env.JAVA_HOME, vscode.workspace.getConfiguration('java').get<string>('jdt.ls.java.home')]) {
    if (home && existsSync(path.join(home, 'bin', exe))) {
      return path.join(home, 'bin', exe);
    }
  }
  return 'java';
}

/**
 * Topic modeling of the "before" files of a result JSON (BERTopic with
 * CodeRankEmbed embeddings); writes <result>.topics.csv and
 * <result>.topic-keywords.csv.
 */
async function runTopicsCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel, uri?: vscode.Uri): Promise<void> {
  if (running) {
    vscode.window.showWarningMessage(vscode.l10n.t('Another WarnPriority task is running. Wait for it to finish or cancel it.'));
    return;
  }
  const config = vscode.workspace.getConfiguration('warnPriority');
  const resultFile = uri?.scheme === 'file' ? uri.fsPath : await pickResultFile(config, vscode.l10n.t('Select a result file for topic modeling'));
  if (!resultFile) {
    return;
  }
  if (/\.pmd\.json$/i.test(resultFile)) {
    vscode.window.showErrorMessage(vscode.l10n.t('Select a result JSON written by "Collect Changed Code", not a .pmd.json file.'));
    return;
  }

  running = true;
  output.appendLine(`[${new Date().toLocaleString()}] WarnPriority v${context.extension.packageJSON.version} | topic modeling of ${resultFile}`);
  try {
    const python = await ensureTopicPython(context, config, output);
    if (!python) {
      return;
    }
    output.appendLine(`Using Python ${python}`);
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'WarnPriority: BERTopic', cancellable: true },
      async (progress, token) => {
        const controller = new AbortController();
        const sub = token.onCancellationRequested(() => controller.abort());
        let percent = 0;
        const report = (message: string, target: number) => {
          progress.report({ message, increment: Math.max(0, target - percent) });
          percent = Math.max(percent, target);
        };
        try {
          return await runTopicModel({
            python,
            resultFile,
            model: config.get<string>('topics.model', DEFAULT_EMBEDDING_MODEL).trim() || DEFAULT_EMBEDDING_MODEL,
            minTopicSize: config.get<number>('topics.minTopicSize', 10),
            extraStopwords: config.get<string[]>('topics.extraStopwords', []),
            signal: controller.signal,
            log: (l) => output.appendLine(l),
            onProgress: (p: TopicProgress) => {
              switch (p.stage) {
                case 'read':
                  return report(vscode.l10n.t('Reading {0} before files...', p.files), 2);
                case 'model':
                  return report(vscode.l10n.t('Loading the embedding model {0} (downloaded on first use)...', p.model), 5);
                case 'embed':
                  return report(vscode.l10n.t('Embedding code chunks: {0}/{1}', p.done, p.total), 5 + (75 * p.done) / Math.max(p.total, 1));
                case 'topics':
                  return report(vscode.l10n.t('Finding topics with BERTopic...'), 82);
                case 'write':
                  return report(vscode.l10n.t('Saving the results...'), 97);
              }
            },
          });
        } finally {
          sub.dispose();
        }
      },
    );
    running = false;
    await showTopicResult(result, output);
  } catch (e) {
    if (e instanceof CancelledError) {
      vscode.window.showInformationMessage(vscode.l10n.t('Topic modeling cancelled.'));
      return;
    }
    const message = (e as Error).message;
    output.appendLine(`ERROR: ${message}`);
    const showLog = vscode.l10n.t('Show Log');
    if ((await vscode.window.showErrorMessage(vscode.l10n.t('WarnPriority: topic modeling failed. {0}', message.split('\n')[0]), showLog)) === showLog) {
      output.show();
    }
  } finally {
    running = false;
  }
}

/** warnPriority.topics.pythonPath, or the extension's own environment (created after asking). */
async function ensureTopicPython(context: vscode.ExtensionContext, config: vscode.WorkspaceConfiguration, output: vscode.OutputChannel): Promise<string | undefined> {
  const configured = config.get<string>('topics.pythonPath', '').trim();
  if (configured) {
    return configured;
  }
  const storageDir = context.globalStorageUri.fsPath;
  const ready = await managedPython(storageDir);
  if (ready) {
    return ready;
  }
  const install = vscode.l10n.t('Install');
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t('Topic modeling needs Python packages (BERTopic, sentence-transformers, PyTorch; about 1-4 GB). Create a Python environment for WarnPriority and install them now?'),
    { modal: true },
    install,
  );
  if (choice !== install) {
    return undefined;
  }
  output.show(true);
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Setting up Python for topic modeling'), cancellable: true },
    async (progress, token) => {
      const controller = new AbortController();
      const sub = token.onCancellationRequested(() => controller.abort());
      try {
        return await setupManagedPython(storageDir, {
          signal: controller.signal,
          log: (l) => output.appendLine(l),
          onStep: (step) =>
            progress.report({
              message:
                step === 'venv'
                  ? vscode.l10n.t('Creating the Python environment...')
                  : vscode.l10n.t('Installing BERTopic, sentence-transformers and PyTorch (this can take several minutes)...'),
            }),
        });
      } finally {
        sub.dispose();
      }
    },
  );
}

async function showTopicResult(result: TopicResult, output: vscode.OutputChannel): Promise<void> {
  output.appendLine(JSON.stringify(result));
  const csvUri = vscode.Uri.file(result.csv);
  await Promise.resolve(vscode.commands.executeCommand('vscode.open', csvUri, { preview: false })).catch((e: Error) =>
    output.appendLine(`Could not open ${result.csv}: ${e.message}`),
  );
  const keywords = vscode.l10n.t('Show Keywords');
  const reveal = vscode.l10n.t('Reveal in File Explorer');
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t('Found {0} topics. Saved the topic shares of {1} before files to {2}.', result.topics, result.files, path.basename(result.csv)),
    keywords,
    reveal,
  );
  if (choice === keywords) {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(result.keywordsCsv), { preview: false });
  } else if (choice === reveal) {
    await vscode.commands.executeCommand('revealFileInOS', csvUri);
  }
}
