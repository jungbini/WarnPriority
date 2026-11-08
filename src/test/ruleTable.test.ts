import { strict as assert } from 'assert';
import { test } from 'node:test';
import { formatRuleTable, RULE_TABLE_HEADER, totalRules } from '../core/ruleTable';
import { RuleWarningCounts, warningRemovalRate } from '../core/warningDiff';

function r(rule: string, before: number, after: number, removed: number, added: number): RuleWarningCounts {
  return { rule, ruleset: 'Design', priority: 3, before, after, removed, added, warningRemovalRate: warningRemovalRate(before, after) };
}

test('totalRules adds up the per-file counts and rates the sums', () => {
  const rows = totalRules([
    { files: [{ rules: [r('A', 2, 0, 2, 0), r('B', 1, 1, 0, 0)] }, { rules: [r('A', 1, 2, 1, 2)] }, {}] },
    { files: [{ rules: [r('A', 1, 1, 0, 0), r('New', 0, 3, 0, 3)] }] },
  ]);
  assert.deepEqual(
    rows.map((x) => [x.rule, x.before, x.after, x.removed, x.added, x.warningRemovalRate, x.files, x.commits]),
    [
      // Sorted by rate, highest first; rules with nothing before last.
      ['A', 4, 3, 3, 2, 0.25, 3, 2], // the rate of the sums, not the mean of the per-file rates (1, -1, 0)
      ['B', 1, 1, 0, 0, 0, 1, 1],
      ['New', 0, 3, 0, 3, null, 1, 1],
    ],
  );
});

test('rules with the same rate are ordered by the warnings before', () => {
  const rows = totalRules([{ files: [{ rules: [r('Small', 1, 0, 1, 0), r('Big', 5, 0, 5, 0), r('Zeta', 0, 1, 0, 1), r('Alpha', 0, 4, 0, 4)] }] }]);
  assert.deepEqual(
    rows.map((x) => x.rule),
    ['Big', 'Small', 'Alpha', 'Zeta'],
  );
});

test('formatRuleTable writes a CSV for Excel', () => {
  const csv = formatRuleTable(totalRules([{ files: [{ rules: [r('A', 2, 1, 1, 0), r('B "x", y', 0, 1, 0, 1)] }] }]));
  assert.ok(csv.startsWith('﻿'));
  assert.deepEqual(csv.slice(1).split('\r\n'), [RULE_TABLE_HEADER.join(','), 'A,Design,3,2,1,1,0,0.5,1,1', '"B ""x"", y",Design,3,0,1,0,1,,1,1', '']);
});
