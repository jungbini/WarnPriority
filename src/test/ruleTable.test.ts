import { strict as assert } from 'assert';
import { test } from 'node:test';
import { fileRuleRows, formatRuleTable, RULE_TABLE_HEADER } from '../core/ruleTable';
import { RuleWarningCounts, warningRemovalRate } from '../core/warningDiff';

function r(rule: string, before: number, after: number, removed: number, added: number): RuleWarningCounts {
  return { rule, ruleset: 'Design', priority: 3, before, after, removed, added, warningRemovalRate: warningRemovalRate(before, after) };
}

test('fileRuleRows: one row per commit, file and rule, not summed; rules with before = 0 left out', () => {
  const rows = fileRuleRows([
    {
      sha: 'c1',
      files: [
        { file: 'A.java', rules: [r('X', 2, 0, 2, 0), r('New', 0, 3, 0, 3), r('Y', 1, 2, 0, 1)] },
        { file: 'B.java', rules: [r('X', 1, 1, 0, 0)] },
        { file: 'Broken.java' }, // PMD could not parse it: no rules
      ],
    },
    { sha: 'c2', files: [{ file: 'A.java', rules: [r('X', 4, 1, 3, 0)] }] },
  ]);
  assert.deepEqual(
    rows.map((x) => [x.sha, x.file, x.rule, x.before, x.after, x.removed, x.added, x.warningRemovalRate]),
    [
      ['c1', 'A.java', 'X', 2, 0, 2, 0, 1],
      ['c1', 'A.java', 'Y', 1, 2, 0, 1, -1],
      ['c1', 'B.java', 'X', 1, 1, 0, 0, 0],
      ['c2', 'A.java', 'X', 4, 1, 3, 0, 0.75],
    ],
  );
});

test('formatRuleTable writes a CSV for Excel', () => {
  const csv = formatRuleTable(fileRuleRows([{ sha: 'abc', files: [{ file: 'src/A, "B".java', rules: [r('X', 2, 1, 1, 0)] }] }]));
  assert.ok(csv.startsWith('﻿'));
  assert.deepEqual(csv.slice(1).split('\r\n'), [RULE_TABLE_HEADER.join(','), 'abc,"src/A, ""B"".java",X,Design,3,2,1,1,0,0.5', '']);
});
