import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PmdLocation } from './pmdInstaller';
import { fileKey, runPmd } from './pmdRunner';
import { fileRuleRows, formatRuleTable } from './ruleTable';
import { OutputCommit } from './types';
import { countLines, diffWarnings, FileWarningDiff, warningRemovalRate } from './warningDiff';
import { formatJson } from './writers';

export interface PmdAnalysisOptions {
  /** A result JSON written by the collector; its commit folders sit next to it. */
  resultFile: string;
  ruleset: string;
  javaPath: string;
  pmd: PmdLocation;
  signal?: AbortSignal;
  log?: (message: string) => void;
  onProgress?: (event: { stage: 'pmd'; files: number } | { stage: 'compare' }) => void;
}

export interface PmdAnalysisSummary {
  commits: number;
  /** Commits where at least one warning disappeared or appeared. */
  commitsWithWarningChanges: number;
  filesAnalyzed: number;
  /** Files skipped because PMD could not parse the before or after version. */
  filesWithErrors: number;
  /** Rules PMD could not use because of their configuration (logged; the other rules ran). */
  skippedRules: number;
  removed: number;
  added: number;
  unchanged: number;
  /** Warnings in the changed code (the change blocks) of all analyzed files, before and after the commits. */
  changedCodeBefore: number;
  changedCodeAfter: number;
  /** (changedCodeBefore - changedCodeAfter) / changedCodeBefore; null when changedCodeBefore is 0. */
  warningRemovalRate: number | null;
}

export interface PmdAnalysisResult {
  outputFile: string;
  /** Per file and rule, the warnings in the changed code before and after (<result>.pmd-rules.csv). */
  rulesFile: string;
  summary: PmdAnalysisSummary;
}

/**
 * Result file of the analysis, e.g. "x.json" -> "x.pmd.json". Format:
 *
 *   [
 *     { "sha": "...",
 *       "files": [
 *         { "file": "src/A.java",
 *           "rules": [ { "rule": "...", "ruleset": "...", "priority": 3, "before": 2, "after": 1, "removed": 1, "added": 0, "warningRemovalRate": 0.5 } ],
 *           "removed": [ { "rule": "...", "ruleset": "...", "priority": 3, "line": 12, "endLine": 12, "onChangedLine": true, "message": "..." } ],
 *           "added":   [ ... ],
 *           "unchanged": 4 } ] }
 *   ]
 */
export function pmdOutputFile(resultFile: string): string {
  return resultFile.replace(/\.json$/i, '') + '.pmd.json';
}

/** The per-file rule table of the analysis, e.g. "x.json" -> "x.pmd-rules.csv" (see ruleTable.ts). */
export function pmdRulesFile(resultFile: string): string {
  return resultFile.replace(/\.json$/i, '') + '.pmd-rules.csv';
}

interface OutputFileEntry {
  file: string;
  oldFile?: string;
  error?: string;
  rules?: FileWarningDiff['rules'];
  removed?: FileWarningDiff['removed'];
  added?: FileWarningDiff['added'];
  unchanged?: number;
}

/**
 * Runs PMD over the before/after files of every commit in a result JSON and
 * records, per commit and file, which warnings disappeared and which appeared,
 * and per rule how many warnings the changed code had before and after.
 */
export async function analyzeWithPmd(opts: PmdAnalysisOptions): Promise<PmdAnalysisResult> {
  const commits = await readResultFile(opts.resultFile);
  const projectDir = path.dirname(opts.resultFile);

  interface Entry {
    commit: OutputCommit;
    file: OutputCommit['files'][number];
    before: string | null;
    after: string | null;
  }
  const entries: Entry[] = [];
  const entriesByCommit = new Map<OutputCommit, Entry[]>();
  for (const commit of commits) {
    entriesByCommit.set(commit, []);
    for (const file of commit.files) {
      if (!/\.java$/i.test(file.file)) {
        continue; // PMD is set up for Java only
      }
      const before = path.join(projectDir, commit.sha, 'before', file.oldFile ?? file.file);
      const after = path.join(projectDir, commit.sha, 'after', file.file);
      const entry = { commit, file, before: (await exists(before)) ? before : null, after: (await exists(after)) ? after : null };
      entries.push(entry);
      entriesByCommit.get(commit)!.push(entry);
    }
  }
  const paths = entries.flatMap((e) => [e.before, e.after]).filter((p): p is string => p !== null);
  if (paths.length === 0) {
    throw new Error('The result file lists no Java files with saved before/after versions.');
  }

  opts.onProgress?.({ stage: 'pmd', files: paths.length });
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'warnpriority-pmd-'));
  let report;
  try {
    report = await runPmd({
      javaPath: opts.javaPath,
      classpath: opts.pmd.classpath,
      ruleset: opts.ruleset,
      files: paths,
      workDir,
      signal: opts.signal,
      log: opts.log,
    });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  for (const e of report.ruleErrors) {
    opts.log?.(`WARNING: PMD skipped a rule: ${e}`);
  }
  opts.onProgress?.({ stage: 'compare' });
  const summary: PmdAnalysisSummary = {
    commits: commits.length,
    commitsWithWarningChanges: 0,
    filesAnalyzed: 0,
    filesWithErrors: 0,
    skippedRules: report.ruleErrors.length,
    removed: 0,
    added: 0,
    unchanged: 0,
    changedCodeBefore: 0,
    changedCodeAfter: 0,
    warningRemovalRate: null,
  };
  const output: { sha: string; files: OutputFileEntry[] }[] = [];
  for (const commit of commits) {
    const files: OutputFileEntry[] = [];
    let changed = false;
    for (const e of entriesByCommit.get(commit)!) {
      const head: OutputFileEntry = { file: e.file.file, ...(e.file.oldFile ? { oldFile: e.file.oldFile } : {}) };
      const errors = [
        e.before && report.errors.get(fileKey(e.before)) ? `before: ${report.errors.get(fileKey(e.before))}` : null,
        e.after && report.errors.get(fileKey(e.after)) ? `after: ${report.errors.get(fileKey(e.after))}` : null,
      ].filter((x): x is string => x !== null);
      if (errors.length > 0) {
        summary.filesWithErrors++;
        files.push({ ...head, error: `PMD could not parse the file (${errors.join('; ')})` });
        continue;
      }
      const beforeText = e.before ? await fs.readFile(e.before, 'utf8') : undefined;
      const afterText = e.after ? await fs.readFile(e.after, 'utf8') : undefined;
      const d = diffWarnings(
        e.before ? (report.warnings.get(fileKey(e.before)) ?? []) : [],
        e.after ? (report.warnings.get(fileKey(e.after)) ?? []) : [],
        e.file.diff,
        beforeText === undefined ? 0 : countLines(beforeText),
        afterText === undefined ? 0 : countLines(afterText),
        { before: beforeText, after: afterText },
      );
      summary.filesAnalyzed++;
      summary.removed += d.removed.length;
      summary.added += d.added.length;
      summary.unchanged += d.unchanged;
      for (const r of d.rules) {
        summary.changedCodeBefore += r.before;
        summary.changedCodeAfter += r.after;
      }
      changed ||= d.removed.length > 0 || d.added.length > 0;
      files.push({ ...head, rules: d.rules, removed: d.removed, added: d.added, unchanged: d.unchanged });
    }
    if (changed) {
      summary.commitsWithWarningChanges++;
    }
    output.push({ sha: commit.sha, files });
  }

  summary.warningRemovalRate = warningRemovalRate(summary.changedCodeBefore, summary.changedCodeAfter);

  const outputFile = pmdOutputFile(opts.resultFile);
  await fs.writeFile(outputFile, formatJson(output) + '\n');
  const rulesFile = pmdRulesFile(opts.resultFile);
  await fs.writeFile(rulesFile, formatRuleTable(fileRuleRows(output)));
  return { outputFile, rulesFile, summary };
}

async function readResultFile(file: string): Promise<OutputCommit[]> {
  let data: unknown;
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read ${path.basename(file)}: ${(e as Error).message}`);
  }
  const ok =
    Array.isArray(data) &&
    data.every((c) => c && typeof c.sha === 'string' && Array.isArray(c.files) && c.files.every((f: { file?: unknown; diff?: unknown }) => typeof f.file === 'string' && Array.isArray(f.diff)));
  if (!ok) {
    throw new Error(`${path.basename(file)} is not a WarnPriority result file (expected the JSON written by "Collect Changed Code").`);
  }
  return data as OutputCommit[];
}

function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}
