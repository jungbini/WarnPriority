import { strict as assert } from 'assert';
import { test } from 'node:test';
import { countLines, diffWarnings, Warning } from '../core/warningDiff';

function w(rule: string, line: number, message = `${rule} message`, endLine = line): Warning {
  return { rule, ruleset: 'Best Practices', priority: 3, line, endLine, message };
}

const brief = (ws: { rule: string; line: number; onChangedLine: boolean }[]) => ws.map((x) => [x.rule, x.line, x.onChangedLine]);

test('a warning on an unchanged line that only moved is unchanged', () => {
  // 2 lines inserted after line 3: old line 8 is new line 10.
  const r = diffWarnings([w('A', 8)], [w('A', 10)], [{ before: [], after: [4, 5] }], 10, 12);
  assert.deepEqual(r, { removed: [], added: [], unchanged: 1 });
});

test('a warning that stays on a modified line is unchanged, even if its message changed', () => {
  const r = diffWarnings([w('A', 5, 'variable x')], [w('A', 5, 'variable y')], [{ before: [5], after: [5] }], 10, 10);
  assert.deepEqual(r, { removed: [], added: [], unchanged: 1 });
});

test('removed and added warnings, with onChangedLine', () => {
  const r = diffWarnings(
    [w('Fixed', 5), w('GoneElsewhere', 2), w('Stays', 8)],
    [w('Stays', 8), w('New', 5), w('NewOnUnchangedLine', 9)],
    [{ before: [5], after: [5] }],
    10,
    10,
  );
  assert.deepEqual(brief(r.removed), [
    ['GoneElsewhere', 2, false],
    ['Fixed', 5, true],
  ]);
  assert.deepEqual(brief(r.added), [
    ['New', 5, true],
    ['NewOnUnchangedLine', 9, false],
  ]);
  assert.equal(r.unchanged, 1);
});

test('a warning spanning changed lines counts as on a changed line', () => {
  const r = diffWarnings([w('Method', 3, 'm', 9)], [], [{ before: [6], after: [] }], 10, 9);
  assert.deepEqual(brief(r.removed), [['Method', 3, true]]);
});

test('identical warnings are matched one to one', () => {
  const r = diffWarnings([w('A', 4), w('A', 4)], [w('A', 4)], [], 5, 5);
  assert.equal(r.unchanged, 1);
  assert.equal(r.removed.length, 1);
});

test('warnings in a different change block are not matched', () => {
  const r = diffWarnings(
    [w('A', 2)],
    [w('A', 8)],
    [
      { before: [2], after: [2] },
      { before: [8], after: [8] },
    ],
    10,
    10,
  );
  assert.equal(r.unchanged, 0);
  assert.deepEqual(brief(r.removed), [['A', 2, true]]);
  assert.deepEqual(brief(r.added), [['A', 8, true]]);
});

test('added and deleted files', () => {
  assert.deepEqual(brief(diffWarnings([], [w('A', 1)], [{ before: [], after: [1, 2] }], 0, 2).added), [['A', 1, true]]);
  assert.deepEqual(brief(diffWarnings([w('A', 2)], [], [{ before: [1, 2], after: [] }], 2, 0).removed), [['A', 2, true]]);
});

test('countLines counts like git', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\r\nb\r\n'), 2);
});
