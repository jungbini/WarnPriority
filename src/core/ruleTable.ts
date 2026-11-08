/*
 * Totals per rule over a whole PMD analysis: the per-file "rules" counts of
 * <result>.pmd.json added up, written as <result>.pmd-rules.csv.
 */
import { RuleWarningCounts, warningRemovalRate } from './warningDiff';

export interface RuleTotals {
  rule: string;
  ruleset: string;
  priority: number;
  /** Sums over all files of the per-file counts (warnings in the changed code). */
  before: number;
  after: number;
  removed: number;
  added: number;
  /** (before - after) / before of the sums; null when before is 0. */
  warningRemovalRate: number | null;
  /** Files (and commits) whose changed code had warnings of the rule before or after. */
  files: number;
  commits: number;
}

/**
 * Adds up the per-file rule counts. Sorted by warning removal rate (highest
 * first; rules without warnings before the commits last), then by the
 * number of warnings before.
 */
export function totalRules(commits: { files: { rules?: RuleWarningCounts[] }[] }[]): RuleTotals[] {
  const totals = new Map<string, RuleTotals>();
  for (const commit of commits) {
    const inCommit = new Set<string>();
    for (const file of commit.files) {
      for (const r of file.rules ?? []) {
        let t = totals.get(r.rule);
        if (!t) {
          t = { rule: r.rule, ruleset: r.ruleset, priority: r.priority, before: 0, after: 0, removed: 0, added: 0, warningRemovalRate: null, files: 0, commits: 0 };
          totals.set(r.rule, t);
        }
        t.before += r.before;
        t.after += r.after;
        t.removed += r.removed;
        t.added += r.added;
        t.files++;
        if (!inCommit.has(r.rule)) {
          inCommit.add(r.rule);
          t.commits++;
        }
      }
    }
  }
  const rows = [...totals.values()].map((t) => ({ ...t, warningRemovalRate: warningRemovalRate(t.before, t.after) }));
  return rows.sort(
    (a, b) =>
      (b.warningRemovalRate ?? -Infinity) - (a.warningRemovalRate ?? -Infinity) ||
      b.before - a.before ||
      b.after - a.after ||
      a.rule.localeCompare(b.rule),
  );
}

export const RULE_TABLE_HEADER = ['Rule', 'Ruleset', 'Priority', 'Before', 'After', 'Removed', 'Added', 'Warning Removal Rate', 'Files', 'Commits'];

/** CSV with a UTF-8 BOM and CRLF line ends (opens correctly in Excel); an empty cell for a null rate. */
export function formatRuleTable(rows: RuleTotals[]): string {
  const lines = [RULE_TABLE_HEADER, ...rows.map((r) => [r.rule, r.ruleset, r.priority, r.before, r.after, r.removed, r.added, r.warningRemovalRate ?? '', r.files, r.commits])];
  return '﻿' + lines.map((cells) => cells.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
