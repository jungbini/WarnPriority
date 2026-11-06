import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { collectCommitChanges, defaultOutputFileName } from './core/collector';
import { CancelledError } from './core/git';
import { parseRepositoryInput } from './core/githubUrl';
import { OutputFormat, ProgressEvent, RepoRef } from './core/types';

const LAST_URL_KEY = 'warnPriority.lastRepositoryUrl';
const LAST_KEYWORDS_KEY = 'warnPriority.lastKeywords';

let running = false;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('WarnPriority');
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('warnPriority.collectCommitChanges', () => runCollect(context, output)),
    vscode.commands.registerCommand('warnPriority.clearRepositoryCache', () => clearCache(context, output)),
  );
}

export function deactivate(): void {
  // nothing to clean up; running git processes are killed via their AbortSignal
}

async function runCollect(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  if (running) {
    vscode.window.showWarningMessage(vscode.l10n.t('A collection is already running. Wait for it to finish or cancel it.'));
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
  const format = config.get<OutputFormat>('outputFormat', 'json') === 'csv' ? 'csv' : 'json';
  const outputFile = await chooseOutputFile(config, repo, keywords, format);
  if (!outputFile) {
    return;
  }

  running = true;
  output.appendLine(`[${new Date().toLocaleString()}] ${repo.webUrl ?? repo.cloneUrl} | keywords: ${keywords.join(', ') || '(all commits)'}`);
  try {
    await vscode.window.withProgress(
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
          const result = await collectCommitChanges({
            repo,
            keywords,
            caseSensitive: config.get<boolean>('caseSensitive', false),
            useRegex: config.get<boolean>('useRegex', false),
            fileExtensions: config.get<string[]>('fileExtensions', []),
            includeMergeCommits: config.get<boolean>('includeMergeCommits', false),
            ignoreWhitespace: config.get<boolean>('ignoreWhitespace', false),
            maxCommits: config.get<number>('maxCommits', 0),
            format,
            outputFile,
            cacheDir: path.join(context.globalStorageUri.fsPath, 'repos'),
            gitPath: await resolveGitPath(config),
            signal: controller.signal,
            log: (m) => output.appendLine(m),
            onProgress: report,
          });
          output.appendLine(JSON.stringify(result.summary));
          await showResult(result.outputFile, result.cancelled, result.summary, keywords, result.warnings.length > 0, output);
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
  } finally {
    running = false;
  }
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

async function showResult(
  outputFile: string | null,
  cancelled: boolean,
  summary: { matchedCommits: number; commitsWithCodeChanges: number; codeChanges: { total: number; modify: number; insert: number; delete: number } },
  keywords: string[],
  hadWarnings: boolean,
  output: vscode.OutputChannel,
): Promise<void> {
  if (hadWarnings) {
    output.show(true);
  }
  if (!outputFile) {
    vscode.window.showInformationMessage(
      keywords.length > 0
        ? vscode.l10n.t('No commit message contains "{0}".', keywords.join('", "'))
        : vscode.l10n.t('The repository has no matching commits.'),
    );
    return;
  }
  const c = summary.codeChanges;
  const text = cancelled
    ? vscode.l10n.t('Cancelled. Partial results ({0} commits) were saved to {1}.', summary.matchedCommits, path.basename(outputFile))
    : vscode.l10n.t(
        'Collected {0} code changes (modify {1}, insert {2}, delete {3}) from {4} commits. Saved to {5}.',
        c.total,
        c.modify,
        c.insert,
        c.delete,
        summary.commitsWithCodeChanges,
        path.basename(outputFile),
      );
  const open = vscode.l10n.t('Open File');
  const reveal = vscode.l10n.t('Reveal in File Explorer');
  const choice = cancelled
    ? await vscode.window.showWarningMessage(text, open, reveal)
    : await vscode.window.showInformationMessage(text, open, reveal);
  if (choice === open) {
    await vscode.window.showTextDocument(vscode.Uri.file(outputFile));
  } else if (choice === reveal) {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outputFile));
  }
}

/**
 * Output location: `warnPriority.outputDirectory` if set (relative paths are
 * resolved against the first workspace folder), otherwise
 * `<workspace>/warnpriority-output`. Without a workspace the user picks a file.
 */
async function chooseOutputFile(
  config: vscode.WorkspaceConfiguration,
  repo: RepoRef,
  keywords: string[],
  format: OutputFormat,
): Promise<string | undefined> {
  const fileName = defaultOutputFileName(repo, keywords, format);
  const workspaceDir = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri.fsPath;
  let dir = config.get<string>('outputDirectory', '').trim();
  if (dir.startsWith('~')) {
    dir = path.join(os.homedir(), dir.slice(1));
  }

  if (!dir && !workspaceDir) {
    const uri = await vscode.window.showSaveDialog({
      title: vscode.l10n.t('Save collected code changes'),
      defaultUri: vscode.Uri.file(path.join(os.homedir(), fileName)),
      filters: format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
    });
    return uri?.fsPath;
  }
  if (!dir) {
    dir = path.join(workspaceDir!, 'warnpriority-output');
  } else if (!path.isAbsolute(dir)) {
    dir = path.join(workspaceDir ?? os.homedir(), dir);
  }
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, fileName);
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
    vscode.window.showWarningMessage(vscode.l10n.t('A collection is already running. Wait for it to finish or cancel it.'));
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
