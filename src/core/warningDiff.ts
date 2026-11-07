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
  /** The warning's lines (line..endLine) include a line changed by the commit. */
  onChangedLine: boolean;
}

export interface FileWarningDiff {
  /** Warnings of the file before the commit that are gone after it (line numbers: before version). */
  removed: ChangedWarning[];
  /** Warnings of the file after the commit that were not there before (line numbers: after version). */
  added: ChangedWarning[];
  /** Warnings present both before and after. */
  unchanged: number;
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

  // Where each warning sits, in terms comparable across the commit.
  const placeBefore = (w: Warning) =>
    blockOfBefore.has(w.line) ? `block:${blockOfBefore.get(w.line)}` : moved.has(w.line) ? `line:${moved.get(w.line)}` : `gone:${w.line}`;
  const placeAfter = (w: Warning) => (blockOfAfter.has(w.line) ? `block:${blockOfAfter.get(w.line)}` : `line:${w.line}`);

  const available = new Array<boolean>(after.length).fill(true);
  const exact = groupIndexes(after, (w) => `${placeAfter(w)}\0${w.rule}\0${w.message}`);
  const loose = groupIndexes(after, (w) => `${placeAfter(w)}\0${w.rule}`);
  const take = (index: Map<string, number[]>, key: string): boolean => {
    const candidates = index.get(key);
    const found = candidates?.find((i) => available[i]);
    if (found === undefined) {
      return false;
    }
    available[found] = false;
    return true;
  };

  let unchanged = 0;
  const unmatched: Warning[] = [];
  for (const w of before) {
    if (take(exact, `${placeBefore(w)}\0${w.rule}\0${w.message}`)) {
      unchanged++;
    } else {
      unmatched.push(w);
    }
  }
  const removed: ChangedWarning[] = [];
  for (const w of unmatched) {
    if (take(loose, `${placeBefore(w)}\0${w.rule}`)) {
      unchanged++;
    } else {
      removed.push({ ...w, onChangedLine: touches(w, changedBefore) });
    }
  }
  const added = after.filter((_, i) => available[i]).map((w) => ({ ...w, onChangedLine: touches(w, changedAfter) }));

  const byLine = (a: Warning, b: Warning) => a.line - b.line || a.rule.localeCompare(b.rule);
  return { removed: removed.sort(byLine), added: added.sort(byLine), unchanged };
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

function touches(w: Warning, changed: Set<number>): boolean {
  for (let l = w.line; l <= Math.max(w.line, w.endLine); l++) {
    if (changed.has(l)) {
      return true;
    }
  }
  return false;
}

/** Number of lines as git counts them (a final line without newline counts; an empty file has 0). */
export function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const n = content.split('\n').length;
  return content.endsWith('\n') ? n - 1 : n;
}
