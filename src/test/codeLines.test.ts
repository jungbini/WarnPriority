import { strict as assert } from 'assert';
import { test } from 'node:test';
import { codeLines, syntaxForFile } from '../core/codeLines';
import { filterCodeChanges } from '../core/codeFilter';
import { CodeChange, FileChange } from '../core/types';

/** For each line: does it contain code? */
function hasCode(source: string, ext: string): boolean[] {
  return codeLines(source, syntaxForFile(`file.${ext}`)).map((l) => l.trim() !== '');
}

test('Java: comments, Javadoc, strings, char literals and text blocks', () => {
  const src = [
    '/**', // 1
    ' * Javadoc with "quotes" and // slashes', // 2
    ' */', // 3
    'public class A { // trailing comment', // 4
    '  String s = "not // a comment";', // 5
    '  String t = "/* not a comment either */";', // 6
    "  char q = '\"';", // 7  a char literal, not a string start
    '  /* block */ int x = 1;', // 8
    '  int y = 2; /* start', // 9
    '     still comment', // 10
    '  end */ int z = 3;', // 11
    '  String tb = """', // 12
    '      text block with // and /* inside', // 13
    '      """;', // 14
    '', // 15
    '  // only comment', // 16
    '}', // 17
  ].join('\n');
  assert.deepEqual(hasCode(src, 'java'), [false, false, false, true, true, true, true, true, true, false, true, true, true, true, false, false, true]);
  const code = codeLines(src, syntaxForFile('A.java'));
  assert.equal(code[3], 'public class A {');
  assert.equal(code[4], '  String s = "not // a comment";');
  assert.equal(code[7], '    int x = 1;');
});

test('Python: # comments, docstrings vs. multi-line string arguments', () => {
  const src = [
    '"""Module docstring."""', // 1
    'import os  # comment', // 2
    '', // 3
    'def f(x):', // 4
    '    """Docstring', // 5
    '    spanning lines', // 6
    '    """', // 7
    '    s = "# not a comment"', // 8
    "    q = '''", // 9
    '    # inside a string', // 10
    "    '''", // 11
    '    cursor.execute(', // 12
    '        """', // 13  an argument, not a docstring
    '        SELECT 1', // 14
    '        """', // 15
    '    )', // 16
    '    # comment', // 17
    '    return x', // 18
  ].join('\n');
  assert.deepEqual(hasCode(src, 'py'), [
    false, true, false, true, false, false, false, true, true, true, true, true, true, true, true, true, false, true,
  ]);
});

test('JavaScript/TypeScript: regex literals, template literals, division', () => {
  const src = [
    'const re = /[/*]+/g; // regex containing /*', // 1
    'const url = "http://example.com";', // 2
    'const t = `template', // 3
    '// not a comment', // 4
    '${x}`;', // 5
    'const d = a / b / c; // division', // 6
    '/* block', // 7
    '   comment */', // 8
    'foo();', // 9
  ].join('\n');
  assert.deepEqual(hasCode(src, 'ts'), [true, true, true, true, true, true, false, false, true]);
  const code = codeLines(src, syntaxForFile('a.js'));
  assert.equal(code[0], 'const re = /[/*]+/g;');
  assert.equal(code[5], 'const d = a / b / c;');
});

test('Rust: nested comments, lifetimes, raw and multi-line strings', () => {
  const src = [
    '/* outer /* nested */ still comment */', // 1
    "fn f<'a>(x: &'a str) -> char { // lifetime, not a char literal", // 2
    "    let c = '\"';", // 3
    '    let r = r#"raw "string" with // inside"#;', // 4
    '    let s = "multi', // 5
    'line // string";', // 6
    '    c', // 7
    '}', // 8
  ].join('\n');
  assert.deepEqual(hasCode(src, 'rs'), [false, true, true, true, true, true, true, true]);
  assert.equal(codeLines(src, syntaxForFile('a.rs'))[1], "fn f<'a>(x: &'a str) -> char {");
});

test('C/C++, Go, C#, Kotlin, PHP, Ruby specifics', () => {
  assert.deepEqual(hasCode('auto s = R"(raw // not a comment\n/* still raw */)";\nint x = 1; // c', 'cpp'), [true, true, true]);
  assert.deepEqual(hasCode("s := `raw\n// not a comment`\n// comment\nr := '\\''", 'go'), [true, true, false, true]);
  assert.deepEqual(hasCode('var p = @"C:\\path\\""quoted"" // not comment\nsecond line";\n// comment', 'cs'), [true, true, false]);
  assert.deepEqual(hasCode('/* a /* b */ c */\nval x = 1', 'kt'), [false, true]);
  assert.deepEqual(hasCode('<?php\n#[Attribute]\n# hash comment\n$x = 1; // comment', 'php'), [true, true, false, true]);
  assert.deepEqual(hasCode('=begin\nblock comment\n=end\nx = "#{y} # not comment"\n# comment', 'rb'), [false, false, false, true, false]);
});

test('analyzer directives (warning suppressions) in comments count as code', () => {
  assert.deepEqual(hasCode('# type: ignore\n# noqa: E501\n# pylint: disable=W0611\n# just a note', 'py'), [true, true, true, false]);
  assert.deepEqual(hasCode('// NOPMD\n/* NOSONAR */\n// @SuppressWarnings explained\n// a note', 'java'), [true, true, true, false]);
  assert.deepEqual(hasCode('// eslint-disable-next-line no-console\n// @ts-ignore\n// note', 'ts'), [true, true, false]);
  assert.deepEqual(hasCode('x := f() //nolint:errcheck\n// note', 'go'), [true, false]);
  assert.equal(codeLines('import chardet  # type: ignore[import]', syntaxForFile('a.py'))[0], 'import chardet  # type: ignore[import]');
});

test('unknown languages: only blank lines are non-code', () => {
  assert.deepEqual(hasCode('a\n\n  \n# b', 'txt'), [true, false, false, true]);
  assert.equal(syntaxForFile('README'), null);
});

function change(type: CodeChange['type'], deleted: [number, string][], added: [number, string][]): CodeChange {
  return {
    type,
    oldStart: deleted[0]?.[0] ?? 0,
    oldLines: deleted.length,
    newStart: added[0]?.[0] ?? 0,
    newLines: added.length,
    deletedCode: deleted.map(([, c]) => c),
    addedCode: added.map(([, c]) => c),
    deletedLineNumbers: deleted.map(([n]) => n),
    addedLineNumbers: added.map(([n]) => n),
  };
}

function file(changes: CodeChange[], name = 'A.java'): FileChange {
  return { oldPath: name, newPath: name, status: 'modified', changes };
}

test('filterCodeChanges drops comment/blank-only changes and comment edits on code lines', () => {
  const before = Buffer.from(['class A {', '  int f() {', '    return 1; // one', '  }', '}', ''].join('\n'));
  const after = Buffer.from(['class A {', '  /** Docs. */', '  int f() {', '', '    return 1; // uno', '  }', '}', ''].join('\n'));
  const { changes, dropped } = filterCodeChanges(
    file([
      change('added', [], [[2, '  /** Docs. */']]),
      change('modified', [[3, '    return 1; // one']], [[4, ''], [5, '    return 1; // uno']]),
    ]),
    before,
    after,
  );
  assert.deepEqual(changes, []);
  assert.equal(dropped, 2);
});

test('filterCodeChanges keeps code lines, skips blank ones inside a block and recomputes the type', () => {
  const before = Buffer.from(['int f() {', '  // TODO', '  return 1;', '}', ''].join('\n'));
  const after = Buffer.from(['int f() {', '  doIt();', '', '  return 2;', '}', ''].join('\n'));
  const { changes, dropped } = filterCodeChanges(
    file([change('modified', [[2, '  // TODO'], [3, '  return 1;']], [[2, '  doIt();'], [3, ''], [4, '  return 2;']])]),
    before,
    after,
  );
  assert.equal(dropped, 0);
  assert.deepEqual(
    changes.map((c) => [c.type, c.deletedLineNumbers, c.addedLineNumbers, c.deletedCode, c.addedCode]),
    [['modified', [3], [2, 4], ['  return 1;'], ['  doIt();', '  return 2;']]],
  );

  // A comment replaced by code is an addition of code.
  const r = filterCodeChanges(
    file([change('modified', [[2, '  // TODO']], [[2, '  doIt();']])]),
    Buffer.from('int f() {\n  // TODO\n}\n'),
    Buffer.from('int f() {\n  doIt();\n}\n'),
  );
  assert.deepEqual(
    r.changes.map((c) => [c.type, c.deletedLineNumbers, c.addedLineNumbers]),
    [['added', [], [2]]],
  );
});

test('filterCodeChanges keeps a change that only adds a warning suppression comment', () => {
  const r = filterCodeChanges(
    file([change('modified', [[1, 'import chardet']], [[1, 'import chardet  # type: ignore[import-not-found]']])], 'help.py'),
    Buffer.from('import chardet\n'),
    Buffer.from('import chardet  # type: ignore[import-not-found]\n'),
  );
  assert.deepEqual(
    r.changes.map((c) => [c.type, c.deletedLineNumbers, c.addedLineNumbers]),
    [['modified', [1], [1]]],
  );
});

test('filterCodeChanges keeps everything on a side whose content could not be read', () => {
  const c = change('modified', [[1, '// x']], [[1, '// y']]);
  assert.equal(filterCodeChanges(file([c]), null, null).changes.length, 1);
});
