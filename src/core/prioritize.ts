/*
 * Topic-based warning prioritization (TOP). For each topic k and warning
 * category c (a PMD rule):
 *
 *   W_c[k] = Σ_b TC_k(b) × RL_c(b)
 *
 *   b        a "before" file of a commit that has both a topic modeling
 *            result (<result>.topics.csv) and rule rows (<result>.pmd-rules.csv)
 *   TC_k(b)  b's share of topic k, normalized over these files so that
 *            Σ_b TC_k(b) = 1 for every topic
 *   RL_c(b)  the warning removal rate of rule c in b's changed code,
 *            (Before - After) / Before
 *
 * A rule that is often removed in files about topic k gets a high weight in
 * topic k's list. Next to the weight, the weight with the removal likelihood
 * Removed / Before instead of the removal rate is given.
 */
import { promises as fs } from 'fs';
import { pmdRulesFile } from './analyzeWithPmd';

/** Parses CSV (RFC 4180: quoted fields, "" inside quotes, CRLF or LF; a leading BOM is ignored). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') {
        i++;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface Topic {
  /** "Topic #1" */
  name: string;
  /** "peeked, pos, stack, ..." (c-TF-IDF keywords from the column header) */
  keywords: string;
}

export interface TopicShares {
  topics: Topic[];
  /** "<sha>/before/<path>" -> share of each topic (0..1), in the order of `topics`. */
  files: Map<string, number[]>;
}

/** Reads <result>.topics.csv. The "Unclassified" column (code in no topic) is not a topic and is left out. */
export function readTopicShares(csv: string): TopicShares {
  const [header, ...rows] = parseCsv(csv).filter((r) => r.some((c) => c !== ''));
  if (!header || header[0] !== 'File Name') {
    throw new Error('not a topic modeling result (expected a "File Name" column)');
  }
  const columns: number[] = [];
  const topics: Topic[] = [];
  header.forEach((h, i) => {
    const m = /^(Topic #\d+)(?: \((.*)\))?$/.exec(h.trim());
    if (i > 0 && m) {
      columns.push(i);
      topics.push({ name: m[1], keywords: m[2] ?? '' });
    }
  });
  const files = new Map<string, number[]>();
  for (const r of rows) {
    files.set(
      r[0],
      columns.map((i) => {
        const v = parseFloat((r[i] ?? '').replace('%', ''));
        return Number.isFinite(v) ? v / 100 : 0;
      }),
    );
  }
  return { topics, files };
}

export interface RuleRow {
  sha: string;
  /** Path after the commit (as in the rule table). */
  file: string;
  rule: string;
  ruleset: string;
  priority: number;
  before: number;
  after: number;
  removed: number;
  added: number;
  warningRemovalRate: number;
}

/** Reads <result>.pmd-rules.csv. */
export function readRuleRows(csv: string): RuleRow[] {
  const [header, ...rows] = parseCsv(csv).filter((r) => r.some((c) => c !== ''));
  const col = (name: string) => {
    const i = header?.indexOf(name) ?? -1;
    if (i < 0) {
      throw new Error(`not a PMD rule table (no "${name}" column)`);
    }
    return i;
  };
  const [sha, file, rule, ruleset, priority, before, after, removed, added, rate] = [
    'Commit',
    'File',
    'Rule',
    'Ruleset',
    'Priority',
    'Before',
    'After',
    'Removed',
    'Added',
    'Warning Removal Rate',
  ].map(col);
  return rows
    .map((r) => ({
      sha: r[sha],
      file: r[file],
      rule: r[rule],
      ruleset: r[ruleset],
      priority: Number(r[priority]),
      before: Number(r[before]),
      after: Number(r[after]),
      removed: Number(r[removed]),
      added: Number(r[added]),
      warningRemovalRate: Number(r[rate]),
    }))
    .filter((r) => r.before > 0 && Number.isFinite(r.warningRemovalRate));
}

export interface TopicWarning {
  topic: string;
  keywords: string;
  /** 1 = highest priority in the topic. */
  rank: number;
  rule: string;
  ruleset: string;
  priority: number;
  /** Σ_b TC_k(b) × warning removal rate. */
  weight: number;
  /** Σ_b TC_k(b) × Removed / Before (the removal likelihood). */
  removalLikelihoodWeight: number;
  /** Files with this rule whose share of the topic is above 0, and their summed counts. */
  files: number;
  before: number;
  after: number;
  removed: number;
  added: number;
}

export interface PrioritizationResult {
  rows: TopicWarning[];
  topics: Topic[];
  /** Files with both a topic modeling result and rule rows (the b of the formula). */
  files: number;
  /** Rule rows used, and those whose file has no topic modeling result (e.g. test files, which topic modeling leaves out). */
  ruleRows: number;
  ruleRowsWithoutTopics: number;
}

/**
 * Builds the priority list of every topic.
 * @param topicFileName the topics.csv name of a rule row's file: "<sha>/before/<path before the commit>"
 */
export function prioritize(shares: TopicShares, rules: RuleRow[], topicFileName: (sha: string, file: string) => string): PrioritizationResult {
  const byFile = new Map<string, { tc: number[]; rows: RuleRow[] }>();
  let ruleRowsWithoutTopics = 0;
  for (const r of rules) {
    const name = topicFileName(r.sha, r.file);
    const tc = shares.files.get(name);
    if (!tc) {
      ruleRowsWithoutTopics++;
      continue;
    }
    const entry = byFile.get(name) ?? byFile.set(name, { tc, rows: [] }).get(name)!;
    entry.rows.push(r);
  }

  const out: TopicWarning[] = [];
  shares.topics.forEach((topic, k) => {
    let total = 0;
    for (const { tc } of byFile.values()) {
      total += tc[k];
    }
    if (total <= 0) {
      return;
    }
    const weights = new Map<string, TopicWarning>();
    for (const { tc, rows } of byFile.values()) {
      const share = tc[k] / total;
      if (share <= 0) {
        continue;
      }
      for (const r of rows) {
        let w = weights.get(r.rule);
        if (!w) {
          w = { topic: topic.name, keywords: topic.keywords, rank: 0, rule: r.rule, ruleset: r.ruleset, priority: r.priority, weight: 0, removalLikelihoodWeight: 0, files: 0, before: 0, after: 0, removed: 0, added: 0 };
          weights.set(r.rule, w);
        }
        w.weight += share * r.warningRemovalRate;
        w.removalLikelihoodWeight += share * (r.removed / r.before);
        w.files++;
        w.before += r.before;
        w.after += r.after;
        w.removed += r.removed;
        w.added += r.added;
      }
    }
    const ranked = [...weights.values()].sort(
      (a, b) => b.weight - a.weight || b.removalLikelihoodWeight - a.removalLikelihoodWeight || b.files - a.files || a.rule.localeCompare(b.rule),
    );
    ranked.forEach((w, i) => out.push({ ...w, rank: i + 1 }));
  });
  return {
    rows: out,
    topics: shares.topics,
    files: byFile.size,
    ruleRows: rules.length - ruleRowsWithoutTopics,
    ruleRowsWithoutTopics,
  };
}

export const PRIORITY_TABLE_HEADER = [
  'Topic',
  'Keywords',
  'Rank',
  'Rule',
  'Ruleset',
  'Priority',
  'Weight',
  'Weight (Removed/Before)',
  'Files',
  'Before',
  'After',
  'Removed',
  'Added',
];

/** CSV with a UTF-8 BOM and CRLF line ends (opens correctly in Excel); weights with 6 decimals. */
export function formatPriorityTable(rows: TopicWarning[]): string {
  const num = (x: number) => String(Math.round(x * 1e6) / 1e6);
  const lines = [
    PRIORITY_TABLE_HEADER,
    ...rows.map((r) => [r.topic, r.keywords, r.rank, r.rule, r.ruleset, r.priority, num(r.weight), num(r.removalLikelihoodWeight), r.files, r.before, r.after, r.removed, r.added]),
  ];
  return '﻿' + lines.map((cells) => cells.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** "x.json" -> "x.topics.csv" (written by topic modeling). */
export function topicsFile(resultFile: string): string {
  return resultFile.replace(/\.json$/i, '') + '.topics.csv';
}

/** "x.json" -> "x.topic-warnings.csv": the priority list of every topic. */
export function priorityOutputFile(resultFile: string): string {
  return resultFile.replace(/\.json$/i, '') + '.topic-warnings.csv';
}

export class MissingInputError extends Error {
  constructor(
    readonly step: 'pmd' | 'topics',
    readonly file: string,
  ) {
    super(`${file} not found: run ${step === 'pmd' ? 'the PMD analysis' : 'topic modeling'} on the result file first`);
  }
}

/**
 * Reads <result>.pmd-rules.csv and <result>.topics.csv next to a result JSON
 * and writes <result>.topic-warnings.csv.
 */
export async function prioritizeWarnings(resultFile: string): Promise<PrioritizationResult & { outputFile: string }> {
  const read = async (file: string, step: 'pmd' | 'topics') => {
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      throw new MissingInputError(step, file);
    }
  };
  const rulesCsv = await read(pmdRulesFile(resultFile), 'pmd');
  const topicsCsv = await read(topicsFile(resultFile), 'topics');
  // topics.csv names a renamed file by its path before the commit; the rule table by its path after.
  const commits = JSON.parse(await fs.readFile(resultFile, 'utf8')) as { sha: string; files: { file: string; oldFile?: string }[] }[];
  const oldPath = new Map<string, string>();
  for (const c of commits) {
    for (const f of c.files) {
      if (f.oldFile) {
        oldPath.set(`${c.sha}\0${f.file}`, f.oldFile);
      }
    }
  }
  const result = prioritize(readTopicShares(topicsCsv), readRuleRows(rulesCsv), (sha, file) => `${sha}/before/${oldPath.get(`${sha}\0${file}`) ?? file}`);
  const outputFile = priorityOutputFile(resultFile);
  await fs.writeFile(outputFile, formatPriorityTable(result.rows));
  return { ...result, outputFile };
}
