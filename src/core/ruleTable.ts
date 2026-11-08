/*
 * The per-file rule counts of <result>.pmd.json as a table: one row per
 * commit, file and rule, written as <result>.pmd-rules.csv. Rules without
 * warnings in the changed code before the commit (Before = 0) are left out,
 * so every row has a warning removal rate.
 */
import { RuleWarningCounts } from './warningDiff';

export interface FileRuleRow {
  sha: string;
  file: string;
  rule: string;
  ruleset: string;
  priority: number;
  /** Warnings of the rule in the file's changed code before / after the commit. */
  before: number;
  after: number;
  removed: number;
  added: number;
  /** (before - after) / before. */
  warningRemovalRate: number;
}

/** Rows in the order of the analysis result (commits, then files, then rules by name); rows with before = 0 left out. */
export function fileRuleRows(commits: { sha: string; files: { file: string; rules?: RuleWarningCounts[] }[] }[]): FileRuleRow[] {
  const rows: FileRuleRow[] = [];
  for (const commit of commits) {
    for (const file of commit.files) {
      for (const r of file.rules ?? []) {
        if (r.before > 0 && r.warningRemovalRate !== null) {
          rows.push({
            sha: commit.sha,
            file: file.file,
            rule: r.rule,
            ruleset: r.ruleset,
            priority: r.priority,
            before: r.before,
            after: r.after,
            removed: r.removed,
            added: r.added,
            warningRemovalRate: r.warningRemovalRate,
          });
        }
      }
    }
  }
  return rows;
}

export const RULE_TABLE_HEADER = ['Commit', 'File', 'Rule', 'Ruleset', 'Priority', 'Before', 'After', 'Removed', 'Added', 'Warning Removal Rate'];

/** CSV with a UTF-8 BOM and CRLF line ends (opens correctly in Excel). */
export function formatRuleTable(rows: FileRuleRow[]): string {
  const lines = [RULE_TABLE_HEADER, ...rows.map((r) => [r.sha, r.file, r.rule, r.ruleset, r.priority, r.before, r.after, r.removed, r.added, r.warningRemovalRate])];
  return '﻿' + lines.map((cells) => cells.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
