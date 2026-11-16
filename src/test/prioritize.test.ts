import { strict as assert } from 'assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { formatRuleTable } from '../core/ruleTable';
import {
  formatPriorityTable,
  MissingInputError,
  parseCsv,
  prioritize,
  prioritizeWarnings,
  PRIORITY_TABLE_HEADER,
  readRuleRows,
  readTopicShares,
  RuleRow,
  TopicShares,
} from '../core/prioritize';

/** A rule row whose removal rate is Removed / Before (nothing added), as in the example of the TOP paper. */
function row(file: string, rule: string, removed: number, before: number): RuleRow {
  return { sha: 's', file, rule, ruleset: 'Design', priority: 3, before, after: before - removed, removed, added: 0, warningRemovalRate: (before - (before - removed)) / before };
}

const example: TopicShares = {
  topics: [
    { name: 'Topic #1', keywords: 'a' },
    { name: 'Topic #2', keywords: 'b' },
    { name: 'Topic #3', keywords: 'c' },
  ],
  files: new Map([
    ['s/before/Cassandra1.java', [0.5, 0.25, 0.25]],
    ['s/before/Cassandra2.java', [0.25, 0.5, 0.25]],
    ['s/before/Util1.java', [0.25, 0.25, 0.5]],
    ['s/before/Util2.java', [0.5, 0.4, 0.1]],
  ]),
};
const exampleRules = [
  row('Cassandra1.java', 'Category1', 5, 20),
  row('Cassandra1.java', 'Category3', 12, 13),
  row('Cassandra2.java', 'Category2', 4, 7),
  row('Util1.java', 'Category1', 3, 4),
  row('Util2.java', 'Category1', 2, 10),
  row('Util2.java', 'Category2', 10, 20),
];

test('TOP weights: W_c[k] = sum over files of the normalized topic share times the removal rate (example of the paper)', () => {
  const r = prioritize(example, exampleRules, (sha, file) => `${sha}/before/${file}`);
  const weight = (topic: string, rule: string) => r.rows.find((x) => x.topic === topic && x.rule === rule)!.weight;
  // The values of the paper, which rounds the normalized shares to two decimals first (e.g. 0.33 x 12/13 = 0.30, exactly 0.31).
  const paper: [string, string, number][] = [
    ['Topic #1', 'Category1', 0.28],
    ['Topic #1', 'Category2', 0.26],
    ['Topic #1', 'Category3', 0.3],
    ['Topic #2', 'Category1', 0.24],
    ['Topic #2', 'Category2', 0.35],
    ['Topic #2', 'Category3', 0.17],
  ];
  for (const [topic, rule, expected] of paper) {
    assert.ok(Math.abs(weight(topic, rule) - expected) <= 0.01, `${topic} ${rule}: ${weight(topic, rule)} vs ${expected}`);
  }
  assert.equal(weight('Topic #1', 'Category1').toFixed(4), ((0.5 / 1.5) * (5 / 20) + (0.25 / 1.5) * (3 / 4) + (0.5 / 1.5) * (2 / 10)).toFixed(4));
  assert.deepEqual(
    r.rows.filter((x) => x.topic === 'Topic #2').map((x) => [x.rank, x.rule]),
    [
      [1, 'Category2'],
      [2, 'Category1'],
      [3, 'Category3'],
    ],
  );
  // Nothing was added, so the removal rate equals the removal likelihood Removed / Before.
  for (const x of r.rows) {
    assert.equal(x.weight.toFixed(10), x.removalLikelihoodWeight.toFixed(10));
  }
  assert.deepEqual([r.files, r.ruleRows, r.ruleRowsWithoutTopics], [4, 6, 0]);
});

test('added warnings lower the weight; files without topic shares are left out; a share of 0 adds nothing', () => {
  const shares: TopicShares = {
    topics: [
      { name: 'Topic #1', keywords: '' },
      { name: 'Topic #2', keywords: '' },
    ],
    files: new Map([
      ['s/before/A.java', [1, 0]],
      ['s/before/Old.java', [0.5, 0.5]],
    ]),
  };
  const worse: RuleRow = { ...row('A.java', 'R', 1, 2), after: 4, added: 3, warningRemovalRate: -1 };
  const r = prioritize(shares, [worse, row('New.java', 'R', 1, 1), row('ATest.java', 'R', 1, 1)], (sha, file) => `${sha}/before/${file === 'New.java' ? 'Old.java' : file}`);
  const t1 = r.rows.find((x) => x.topic === 'Topic #1' && x.rule === 'R')!;
  // Topic 1: A.java 1/1.5, Old.java (renamed to New.java) 0.5/1.5
  assert.equal(t1.weight.toFixed(4), ((1 / 1.5) * -1 + (0.5 / 1.5) * 1).toFixed(4));
  assert.equal(t1.removalLikelihoodWeight.toFixed(4), ((1 / 1.5) * 0.5 + (0.5 / 1.5) * 1).toFixed(4));
  assert.deepEqual([t1.files, t1.before, t1.after, t1.removed, t1.added], [2, 3, 4, 2, 3]);
  const t2 = r.rows.find((x) => x.topic === 'Topic #2' && x.rule === 'R')!;
  assert.deepEqual([t2.files, t2.weight], [1, 1]); // A.java has no share of topic 2
  assert.equal(r.ruleRowsWithoutTopics, 1);
});

test('reads the CSVs that topic modeling and the PMD analysis write', () => {
  const topics = readTopicShares(
    '﻿File Name,"Topic #1 (json, reader)","Topic #2 (date)",Unclassified\r\nabc/before/src/A.java,36.0%,60.0%,4.0%\r\n"abc/before/src/B, C.java",0.0%,100.0%,0.0%\r\n',
  );
  assert.deepEqual(topics.topics, [
    { name: 'Topic #1', keywords: 'json, reader' },
    { name: 'Topic #2', keywords: 'date' },
  ]);
  assert.deepEqual(topics.files.get('abc/before/src/A.java'), [0.36, 0.6]);
  assert.deepEqual(topics.files.get('abc/before/src/B, C.java'), [0, 1]);

  const rules = readRuleRows(
    formatRuleTable([{ sha: 'abc', file: 'src/A.java', rule: 'R', ruleset: 'Design', priority: 2, before: 4, after: 1, removed: 3, added: 0, warningRemovalRate: 0.75 }]),
  );
  assert.deepEqual(rules, [{ sha: 'abc', file: 'src/A.java', rule: 'R', ruleset: 'Design', priority: 2, before: 4, after: 1, removed: 3, added: 0, warningRemovalRate: 0.75 }]);
  assert.throws(() => readTopicShares('a,b\r\n1,2\r\n'), /not a topic modeling result/);
  assert.throws(() => readRuleRows('Commit,File\r\n'), /not a PMD rule table/);
  assert.deepEqual(parseCsv('a,"b ""c""",\nd'), [['a', 'b "c"', ''], ['d']]);
});

test('prioritizeWarnings reads the files next to a result JSON and writes <result>.topic-warnings.csv', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'warnpriority-top-'));
  try {
    const result = path.join(dir, 'r.json');
    writeFileSync(result, JSON.stringify([{ sha: 'abc', files: [{ file: 'src/New.java', oldFile: 'src/Old.java', diff: [] }] }]));
    await assert.rejects(prioritizeWarnings(result), (e: unknown) => e instanceof MissingInputError && e.step === 'pmd');
    writeFileSync(
      path.join(dir, 'r.pmd-rules.csv'),
      formatRuleTable([{ sha: 'abc', file: 'src/New.java', rule: 'R', ruleset: 'Design', priority: 3, before: 2, after: 1, removed: 1, added: 0, warningRemovalRate: 0.5 }]),
    );
    await assert.rejects(prioritizeWarnings(result), (e: unknown) => e instanceof MissingInputError && e.step === 'topics');
    // topics.csv names the renamed file by its path before the commit
    writeFileSync(path.join(dir, 'r.topics.csv'), '\ufeffFile Name,"Topic #1 (x, y)"\r\nabc/before/src/Old.java,100.0%\r\n');
    const r = await prioritizeWarnings(result);
    assert.equal(r.outputFile, path.join(dir, 'r.topic-warnings.csv'));
    const csv = readFileSync(r.outputFile, 'utf8');
    assert.ok(csv.startsWith('\ufeff'));
    assert.deepEqual(csv.slice(1).split('\r\n'), [PRIORITY_TABLE_HEADER.join(','), 'Topic #1,"x, y",1,R,Design,3,0.5,0.5,1,2,1,1,0', '']);
    assert.equal(formatPriorityTable([]), '\ufeff' + PRIORITY_TABLE_HEADER.join(',') + '\r\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
