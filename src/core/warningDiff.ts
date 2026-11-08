/*
 * Compares static analysis warnings of a file before and after a commit.
 * Independent of the analyzer: PMD today, others (Checkstyle, Semgrep, ...)
 * can feed the same function.
 */

export interface Warning {
  rule: string;
  /** Rule category, e.g. "Error Prone", "Best Practices". */
  ruleset: string;
  /** Analyzer priority (PMD: 1 = highest ... 5 = lowest). */
  priority: number;
  line: number;
  endLine: number;
  message: string;
}

export interface ChangedWarning extends Warning {
  /**
   * The warning is in the code the commit changed: its lines (line..endLine)
   * include a changed line, or enclose a place where lines were only added
   * (before version) or only deleted (after version).
   */
  onChangedLine: boolean;
}

/** One rule's warnings in the code the commit changed (the change blocks of the file). */
export interface RuleWarningCounts {
  rule: string;
  ruleset: string;
  /** Analyzer priority of the rule (PMD: 1 = highest ... 5 = lowest). */
  priority: number;
  /** Warnings of the rule in the changed code before the commit. */
  before: number;
  /** Warnings of the rule in the changed code after the commit (= before - removed + added). */
  after: number;
  /** Of `before`, the warnings the commit removed. */
  removed: number;
  /** Of `after`, the warnings the commit added. */
  added: number;
  /**
   * (before - after) / before: 1 = every warning removed, 0 = as many as
   * before, negative = more than before. null when before is 0.
   */
  warningRemovalRate: number | null;
}

export interface FileWarningDiff {
  /** Warnings of the file before the commit that are gone after it (line numbers: before version). */
  removed: ChangedWarning[];
  /** Warnings of the file after the commit that were not there before (line numbers: after version). */
  added: ChangedWarning[];
  /** Warnings present both before and after. */
  unchanged: number;
  /** Per rule, the warnings in the changed code before and after the commit (sorted by rule). */
  rules: RuleWarningCounts[];
}

/** (before - after) / before, rounded to 4 decimals; null when before is 0. */
export function warningRemovalRate(before: number, after: number): number | null {
  return before > 0 ? Math.round(((before - after) / before) * 10000) / 10000 : null;
}

/**
 * Matches warnings across the commit. A warning counts as the same one when
 * it has the same rule at the corresponding place:
 *  - on an unchanged line: the line it moved to (unchanged lines keep their
 *    order, so the k-th unchanged line before is the k-th unchanged line after);
 *  - on a changed line: anywhere in the same change block.
 * Same rule and same message is preferred over same rule only.
 *
 * @param diff the file's change blocks from the result JSON (changed line numbers)
 */
export function diffWarnings(
  before: Warning[],
  after: Warning[],
  diff: { before: number[]; after: number[] }[],
  beforeLineCount: number,
  afterLineCount: number,
): FileWarningDiff {
  const changedBefore = new Set<number>();
  const changedAfter = new Set<number>();
  const blockOfBefore = new Map<number, number>();
  const blockOfAfter = new Map<number, number>();
  diff.forEach((block, k) => {
    block.before.forEach((l) => (changedBefore.add(l), blockOfBefore.set(l, k)));
    block.after.forEach((l) => (changedAfter.add(l), blockOfAfter.set(l, k)));
  });

  // Unchanged lines line up in order.
  const unchangedBefore: number[] = [];
  const unchangedAfter: number[] = [];
  for (let l = 1; l <= beforeLineCount; l++) {
    if (!changedBefore.has(l)) {
      unchangedBefore.push(l);
    }
  }
  for (let l = 1; l <= afterLineCount; l++) {
    if (!changedAfter.has(l)) {
      unchangedAfter.push(l);
    }
  }
  const moved = new Map<number, number>();
  for (let k = 0; k < Math.min(unchangedBefore.length, unchangedAfter.length); k++) {
    moved.set(unchangedBefore[k], unchangedAfter[k]);
  }

  // Blocks that only add lines leave a gap in the before version (and blocks
  // that only delete lines one in the after version): the place after the
  // last unchanged line in front of the block. A warning enclosing the gap
  // (e.g. a method that got new lines) is in the changed code.
  const gapsBefore: number[] = [];
  const gapsAfter: number[] = [];
  const gapAfterUnchanged = (firstChanged: number, unchangedHere: number[], unchangedThere: number[], lineCountThere: number) => {
    const k = unchangedHere.filter((l) => l < firstChanged).length;
    return k === 0 ? 0 : (unchangedThere[k - 1] ?? lineCountThere);
  };
  for (const block of diff) {
    if (block.before.length === 0 && block.after.length > 0) {
      gapsBefore.push(gapAfterUnchanged(Math.min(...block.after), unchangedAfter, unchangedBefore, beforeLineCount));
    } else if (block.after.length === 0 && block.before.length > 0) {
      gapsAfter.push(gapAfterUnchanged(Math.min(...block.before), unchangedBefore, unchangedAfter, afterLineCount));
    }
  }
  const inChangedBefore = (w: Warning) => inChangedCode(w, changedBefore, gapsBefore);
  const inChangedAfter = (w: Warning) => inChangedCode(w, changedAfter, gapsAfter);

  // Where each warning sits, in terms comparable across the commit.
  const placeBefore = (w: Warning) =>
    blockOfBefore.has(w.line) ? `block:${blockOfBefore.get(w.line)}` : moved.has(w.line) ? `line:${moved.get(w.line)}` : `gone:${w.line}`;
  const placeAfter = (w: Warning) => (blockOfAfter.has(w.line) ? `block:${blockOfAfter.get(w.line)}` : `line:${w.line}`);

  const available = new Array<boolean>(after.length).fill(true);
  const exact = groupIndexes(after, (w) => `${placeAfter(w)}\0${w.rule}\0${w.message}`);
  const loose = groupIndexes(after, (w) => `${placeAfter(w)}\0${w.rule}`);
  /** Index of an unmatched after-warning with this key (now matched), or -1. */
  const take = (index: Map<string, number[]>, key: string): number => {
    const found = index.get(key)?.find((i) => available[i]);
    if (found === undefined) {
      return -1;
    }
    available[found] = false;
    return found;
  };

  const rules = new Map<string, RuleWarningCounts>();
  const count = (w: Warning) => {
    let r = rules.get(w.rule);
    if (!r) {
      r = { rule: w.rule, ruleset: w.ruleset, priority: w.priority, before: 0, after: 0, removed: 0, added: 0, warningRemovalRate: null };
      rules.set(w.rule, r);
    }
    return r;
  };

  let unchanged = 0;
  const pairs: [Warning, Warning][] = [];
  const unmatched: Warning[] = [];
  for (const w of before) {
    const i = take(exact, `${placeBefore(w)}\0${w.rule}\0${w.message}`);
    if (i >= 0) {
      pairs.push([w, after[i]]);
    } else {
      unmatched.push(w);
    }
  }
  const removed: ChangedWarning[] = [];
  for (const w of unmatched) {
    const i = take(loose, `${placeBefore(w)}\0${w.rule}`);
    if (i >= 0) {
      pairs.push([w, after[i]]);
    } else {
      removed.push({ ...w, onChangedLine: inChangedBefore(w) });
    }
  }
  const added = after.filter((_, i) => available[i]).map((w) => ({ ...w, onChangedLine: inChangedAfter(w) }));

  for (const [b, a] of pairs) {
    unchanged++;
    if (inChangedBefore(b) || inChangedAfter(a)) {
      const r = count(b);
      r.before++;
      r.after++;
    }
  }
  for (const w of removed.filter((x) => x.onChangedLine)) {
    const r = count(w);
    r.before++;
    r.removed++;
  }
  for (const w of added.filter((x) => x.onChangedLine)) {
    const r = count(w);
    r.after++;
    r.added++;
  }
  const ruleCounts = [...rules.values()]
    .map((r) => ({ ...r, warningRemovalRate: warningRemovalRate(r.before, r.after) }))
    .sort((a, b) => a.rule.localeCompare(b.rule));

  const byLine = (a: Warning, b: Warning) => a.line - b.line || a.rule.localeCompare(b.rule);
  return { removed: removed.sort(byLine), added: added.sort(byLine), unchanged, rules: ruleCounts };
}

function groupIndexes(warnings: Warning[], key: (w: Warning) => string): Map<string, number[]> {
  const map = new Map<string, number[]>();
  warnings.forEach((w, i) => {
    const k = key(w);
    const list = map.get(k);
    if (list) {
      list.push(i);
    } else {
      map.set(k, [i]);
    }
  });
  return map;
}

function inChangedCode(w: Warning, changed: Set<number>, gaps: number[]): boolean {
  const end = Math.max(w.line, w.endLine);
  for (let l = w.line; l <= end; l++) {
    if (changed.has(l)) {
      return true;
    }
  }
  return gaps.some((gap) => w.line <= gap && end > gap);
}

/** Number of lines as git counts them (a final line without newline counts; an empty file has 0). */
export function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const n = content.split('\n').length;
  return content.endsWith('\n') ? n - 1 : n;
}
