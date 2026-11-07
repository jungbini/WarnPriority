import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { CancelledError } from './git';
import { PMD_MAIN_CLASS } from './pmdArtifacts';
import { Warning } from './warningDiff';

export interface PmdRunOptions {
  /** java executable. */
  javaPath: string;
  classpath: string;
  /** Comma-separated rulesets / rule categories / ruleset XML paths. */
  ruleset: string;
  files: string[];
  /** Folder for PMD's file list and report (temporary). */
  workDir: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface PmdReport {
  /** Keyed by normalised absolute path (see `fileKey`). */
  warnings: Map<string, Warning[]>;
  /** Files PMD could not parse, with the reason. */
  errors: Map<string, string>;
  pmdVersion: string;
}

/** Map key for a file path (case-insensitive on Windows). */
export function fileKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Runs PMD once over all `files` and returns its warnings per file. */
export async function runPmd(opts: PmdRunOptions): Promise<PmdReport> {
  await fs.mkdir(opts.workDir, { recursive: true });
  const listFile = path.join(opts.workDir, 'pmd-files.txt');
  const reportFile = path.join(opts.workDir, 'pmd-report.json');
  await fs.writeFile(listFile, opts.files.join('\n') + '\n');
  await fs.rm(reportFile, { force: true });

  const args = [
    '-cp',
    opts.classpath,
    PMD_MAIN_CLASS,
    'check',
    '--no-cache',
    '--no-progress',
    '--no-fail-on-violation',
    '--no-fail-on-error',
    '--rulesets',
    opts.ruleset,
    '--format',
    'json',
    '--report-file',
    reportFile,
    '--file-list',
    listFile,
  ];
  opts.log?.(`> ${opts.javaPath} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);
  const { code, output } = await run(opts.javaPath, args, opts.signal, opts.log);

  const raw = await fs.readFile(reportFile, 'utf8').catch(() => null);
  if (raw === null) {
    throw new Error(`PMD did not produce a report (exit code ${code}): ${lastLines(output)}`);
  }
  const report = parsePmdReport(raw);
  if (code !== 0 && report.warnings.size === 0 && report.errors.size === 0) {
    throw new Error(`PMD failed (exit code ${code}): ${lastLines(output)}`);
  }
  return report;
}

/** Parses PMD's JSON report format. */
export function parsePmdReport(json: string): PmdReport {
  const data = JSON.parse(json) as {
    pmdVersion?: string;
    files?: { filename: string; violations: PmdViolation[] }[];
    processingErrors?: { filename: string; message: string }[];
    configurationErrors?: { rule?: string; message: string }[];
  };
  if (data.configurationErrors?.length) {
    throw new Error(`PMD ruleset error: ${data.configurationErrors.map((e) => `${e.rule ?? ''} ${e.message}`.trim()).join('; ')}`);
  }
  const warnings = new Map<string, Warning[]>();
  for (const f of data.files ?? []) {
    warnings.set(
      fileKey(f.filename),
      f.violations.map((v) => ({
        rule: v.rule,
        ruleset: v.ruleset,
        priority: v.priority,
        line: v.beginline,
        endLine: v.endline,
        message: v.description,
      })),
    );
  }
  const errors = new Map<string, string>();
  for (const e of data.processingErrors ?? []) {
    errors.set(fileKey(e.filename), e.message.split('\n')[0]);
  }
  return { warnings, errors, pmdVersion: data.pmdVersion ?? '' };
}

interface PmdViolation {
  beginline: number;
  endline: number;
  description: string;
  rule: string;
  ruleset: string;
  priority: number;
}

function run(cmd: string, args: string[], signal?: AbortSignal, log?: (m: string) => void): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-32 * 1024);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() && !line.startsWith('Picked up JAVA_TOOL_OPTIONS')) {
          log?.(line);
        }
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e: NodeJS.ErrnoException) => {
      signal?.removeEventListener('abort', onAbort);
      reject(
        e.code === 'ENOENT'
          ? new Error(`Java not found ("${cmd}"). PMD needs Java 8 or newer: install a JDK/JRE or set warnPriority.pmd.java.`)
          : e,
      );
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(new CancelledError());
      } else {
        resolve({ code, output });
      }
    });
  });
}

function lastLines(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('Picked up JAVA_TOOL_OPTIONS'))
      .slice(-3)
      .join(' | ') || '(no output)'
  );
}
