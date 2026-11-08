import { strict as assert } from 'assert';
import { test } from 'node:test';
import { countLines, diffWarnings, messageIdentity, RuleWarningCounts, Warning, warningRemovalRate } from '../core/warningDiff';

function w(rule: string, line: number, message = `${rule} message`, endLine = line): Warning {
  return { rule, ruleset: 'Best Practices', priority: 3, line, endLine, message };
}

const brief = (ws: { rule: string; line: number; onChangedLine: boolean }[]) => ws.map((x) => [x.rule, x.line, x.onChangedLine]);
/** rule: [before, after, removed, added, warningRemovalRate] */
const counts = (rs: RuleWarningCounts[]) => Object.fromEntries(rs.map((r) => [r.rule, [r.before, r.after, r.removed, r.added, r.warningRemovalRate]]));

test('a warning on an unchanged line that only moved is unchanged', () => {
  // 2 lines inserted after line 3: old line 8 is new line 10.
  const r = diffWarnings([w('A', 8)], [w('A', 10)], [{ before: [], after: [4, 5] }], 10, 12);
  assert.deepEqual(r, { removed: [], added: [], unchanged: 1, rules: [] });
});

test('a warning that stays on a modified line is unchanged, even if its message changed', () => {
  const r = diffWarnings([w('A', 5, 'variable x')], [w('A', 5, 'variable y')], [{ before: [5], after: [5] }], 10, 10);
  assert.deepEqual(r, {
    removed: [],
    added: [],
    unchanged: 1,
    rules: [{ rule: 'A', ruleset: 'Best Practices', priority: 3, before: 1, after: 1, removed: 0, added: 0, warningRemovalRate: 0 }],
  });
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

test('per rule: warnings in the changed code before and after, and the warning removal rate', () => {
  const r = diffWarnings(
    // before: block 1 = lines 3-4, block 2 = line 8
    [w('Fixed', 3), w('Fixed', 4), w('Half', 3), w('Half', 4), w('Worse', 8), w('Outside', 1), w('Gone', 6)],
    [w('Half', 3), w('Worse', 8), w('Worse', 8, 'another'), w('Worse', 8, 'third'), w('Fresh', 8), w('Outside', 1)],
    [
      { before: [3, 4], after: [3, 4] },
      { before: [8], after: [8] },
    ],
    10,
    10,
  );
  assert.deepEqual(counts(r.rules), {
    Fixed: [2, 0, 2, 0, 1], // every warning removed
    Fresh: [0, 1, 0, 1, null], // none before: no rate
    Half: [2, 1, 1, 0, 0.5],
    Worse: [1, 3, 0, 2, -2], // more than before: negative
  });
  // 'Outside' (unchanged line) and 'Gone' (removed from an unchanged line) are not in the changed code.
  assert.deepEqual(brief(r.removed.filter((x) => x.rule === 'Gone')), [['Gone', 6, false]]);
  for (const x of r.rules) {
    assert.equal(x.after, x.before - x.removed + x.added, x.rule);
  }
});

test('a warning enclosing lines that were only added or only deleted is in the changed code', () => {
  // Lines 5-6 inserted into a method spanning lines 2-9 (2-11 after); its warning stays.
  const inserted = diffWarnings([w('Method', 2, 'm', 9)], [w('Method', 2, 'm', 11)], [{ before: [], after: [5, 6] }], 10, 12);
  assert.deepEqual(counts(inserted.rules), { Method: [1, 1, 0, 0, 0] });
  // The insertion removed a method-level warning: it is on the changed code although no before line changed.
  const fixed = diffWarnings([w('Method', 2, 'm', 9), w('Field', 1)], [w('Field', 1)], [{ before: [], after: [5, 6] }], 10, 12);
  assert.deepEqual(brief(fixed.removed), [['Method', 2, true]]);
  assert.deepEqual(counts(fixed.rules), { Method: [1, 0, 1, 0, 1] });
  // Lines 5-6 deleted from a method spanning 2-9 (2-7 after); a warning starting after the method is not affected.
  const deleted = diffWarnings([w('Method', 2, 'm', 9), w('Later', 10)], [w('Method', 2, 'm', 7), w('Later', 8), w('New', 3, 'n', 6)], [{ before: [5, 6], after: [] }], 12, 10);
  assert.deepEqual(counts(deleted.rules), { Method: [1, 1, 0, 0, 0], New: [0, 1, 0, 1, null] });
  assert.deepEqual(brief(deleted.added), [['New', 3, true]]);
});

test('a warning the commit only moved is unchanged when its message names the same thing', () => {
  const literal = (text: string, n: number, first: number) => `The String literal "${text}" appears ${n} times in this file; the first occurrence is on line ${first}`;
  // A new use of "yyyy" above its first occurrence moves the warning into the added lines.
  const r = diffWarnings(
    [w('AvoidDuplicateLiterals', 19, literal('yyyy', 4, 19)), w('AvoidDuplicateLiterals', 30, literal('1.5', 3, 30))],
    [w('AvoidDuplicateLiterals', 6, literal('yyyy', 5, 6)), w('AvoidDuplicateLiterals', 8, literal('1.0', 3, 8))],
    [{ before: [], after: [5, 6, 7, 8] }],
    40,
    44,
  );
  assert.equal(r.unchanged, 1);
  assert.deepEqual(brief(r.removed), [['AvoidDuplicateLiterals', 30, false]]); // "1.5" is not "1.0": numbers in quotes count
  assert.deepEqual(brief(r.added), [['AvoidDuplicateLiterals', 8, true]]);
  assert.deepEqual(counts(r.rules), { AvoidDuplicateLiterals: [1, 2, 0, 1, -1] });
});

test('a moved warning is not paired when its message names nothing or is not unique', () => {
  const comment = 'Public method and constructor comments are required';
  const generic = diffWarnings([w('CommentRequired', 30, comment)], [w('CommentRequired', 6, comment)], [{ before: [], after: [5, 6] }], 40, 42);
  assert.equal(generic.unchanged, 0);
  const param = "Parameter 'src' is not assigned and could be declared final";
  const twice = diffWarnings([w('MethodArgumentCouldBeFinal', 30, param)], [w('MethodArgumentCouldBeFinal', 6, param), w('MethodArgumentCouldBeFinal', 7, param)], [{ before: [], after: [5, 6, 7] }], 40, 43);
  assert.equal(twice.unchanged, 0);
});

test('a multi-line warning whose lines overlap after the commit is unchanged', () => {
  // An import added at line 3: the import list warning now starts on the added line.
  const r = diffWarnings([w('ExcessiveImports', 3, 'imports (31)', 40)], [w('ExcessiveImports', 3, 'imports (32)', 41)], [{ before: [], after: [3] }], 100, 101);
  assert.equal(r.unchanged, 1);
  assert.deepEqual(counts(r.rules), { ExcessiveImports: [1, 1, 0, 0, 0] });
});

test('messageIdentity keeps quoted names and drops other numbers', () => {
  assert.equal(messageIdentity('The String literal "1.5" appears 4 times; first on line 398'), 'The String literal "1.5" appears # times; first on line #');
  assert.equal(messageIdentity("The method 'f(int)' has a cyclomatic complexity of 10."), "The method 'f(int)' has a cyclomatic complexity of #.");
  assert.equal(messageIdentity('Field comments are required'), null);
});

test('a warning removed or added right below changed code is in the changed code', () => {
  const before = ['class A {', '  int x;', '', '  /*', '   * Old comment', '   */', '  public void f() {}', '  public void g() {}', '}', ''].join('\n');
  const after = ['class A {', '  int x;', '', '  /**', '   * Old comment', '   */', '  public void f() {}', '  /** New. */', '  public void g() {}', '}', ''].join('\n');
  const missing = (line: number) => w('CommentRequired', line, 'Public method and constructor comments are required');
  // Line 4 "/*" became "/**" (comment lines 5-6 between it and f), and a Javadoc was added above g.
  const r = diffWarnings([missing(7), missing(8), w('Field', 2)], [w('Field', 2)], [{ before: [4], after: [4] }, { before: [], after: [8] }], 9, 10, { before, after });
  assert.deepEqual(brief(r.removed), [
    ['CommentRequired', 7, true],
    ['CommentRequired', 8, true],
  ]);
  assert.deepEqual(counts(r.rules), { CommentRequired: [2, 0, 2, 0, 1] });
  // Without the text, only the line right above counts.
  assert.deepEqual(brief(diffWarnings([missing(7), missing(8)], [], [{ before: [4], after: [4] }, { before: [], after: [8] }], 9, 10).removed), [
    ['CommentRequired', 7, false],
    ['CommentRequired', 8, true],
  ]);
});

test('right below changed code: blank and code lines stop it, and a warning that stays is not counted', () => {
  const text = ['void f() {', '  a();', '  int x = 1;', '', '  int y = 2;', '  b();', '}', ''].join('\n');
  const r = diffWarnings(
    [w('Gone', 3), w('BlankBetween', 5), w('Stays', 3, 'stays')],
    [w('Stays', 3, 'stays'), w('New', 3)],
    [{ before: [2], after: [2] }],
    7,
    7,
    { before: text, after: text },
  );
  assert.deepEqual(brief(r.removed), [
    ['Gone', 3, true], // a statement right above it changed
    ['BlankBetween', 5, false],
  ]);
  assert.deepEqual(brief(r.added), [['New', 3, true]]);
  assert.deepEqual(counts(r.rules), { Gone: [1, 0, 1, 0, 1], New: [0, 1, 0, 1, null] });
});

test('warningRemovalRate', () => {
  assert.equal(warningRemovalRate(2, 0), 1);
  assert.equal(warningRemovalRate(3, 1), 0.6667);
  assert.equal(warningRemovalRate(4, 4), 0);
  assert.equal(warningRemovalRate(1, 3), -2);
  assert.equal(warningRemovalRate(0, 2), null);
});

test('countLines counts like git', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\r\nb\r\n'), 2);
});
