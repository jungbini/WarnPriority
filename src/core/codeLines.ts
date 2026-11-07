import * as path from 'path';

/*
 * Finds out which lines of a source file contain code, as opposed to only
 * comments or whitespace. The whole file is scanned, because a line inside a
 * block comment, or a "//" inside a string literal, cannot be judged on its
 * own.
 *
 * This is a lexer for comments and string literals only, not a parser. When
 * in doubt it errs towards "code" (an unrecognised construct is kept as code),
 * so a real code change is never dropped because of a misread comment.
 */

interface StringRule {
  open: string;
  close: string;
  /** May contain raw line breaks. Single-line strings end at the line end even if unterminated. */
  multiline: boolean;
  /** backslash: \x escapes; doubled: "" inside @"..."; none: raw. */
  escape: 'backslash' | 'doubled' | 'none';
}

export interface Syntax {
  lineComments: string[];
  block?: { open: string; close: string; nested: boolean };
  /** Longest openers first. */
  strings: StringRule[];
  /** ' starts a short char literal ('a', '\n'); otherwise it is plain code (Rust lifetimes, Scala symbols). */
  charLiterals?: boolean;
  /** JavaScript /regex/ literals (may contain "//" or quotes). */
  regexLiterals?: boolean;
  /** C++ R"delim( ... )delim" */
  cppRawStrings?: boolean;
  /** Rust r"..." / r#"..."# */
  rustRawStrings?: boolean;
  /** Python: a triple-quoted string on its own line after ":" (or at file start) is a docstring. */
  pythonDocstrings?: boolean;
  /** Ruby =begin ... =end */
  rubyBlockComments?: boolean;
  /** PHP 8: "#[" starts an attribute, not a comment. */
  phpAttributes?: boolean;
}

const dq = (multiline = false): StringRule => ({ open: '"', close: '"', multiline, escape: 'backslash' });
const sq = (multiline = false): StringRule => ({ open: "'", close: "'", multiline, escape: 'backslash' });
const tripleDq = (escape: StringRule['escape']): StringRule => ({ open: '"""', close: '"""', multiline: true, escape });
const tripleSq: StringRule = { open: "'''", close: "'''", multiline: true, escape: 'backslash' };
const C_BLOCK = { open: '/*', close: '*/', nested: false };
const NESTED_BLOCK = { open: '/*', close: '*/', nested: true };

const C_FAMILY: Syntax = { lineComments: ['//'], block: C_BLOCK, strings: [dq()], charLiterals: true, cppRawStrings: true };
const JAVA: Syntax = { lineComments: ['//'], block: C_BLOCK, strings: [tripleDq('backslash'), dq()], charLiterals: true };
const KOTLIN_SCALA: Syntax = { lineComments: ['//'], block: NESTED_BLOCK, strings: [tripleDq('none'), dq()], charLiterals: true };
const GROOVY: Syntax = { lineComments: ['//'], block: C_BLOCK, strings: [tripleDq('backslash'), tripleSq, dq(), sq()] };
const CSHARP: Syntax = {
  lineComments: ['//'],
  block: C_BLOCK,
  strings: [tripleDq('none'), { open: '@"', close: '"', multiline: true, escape: 'doubled' }, dq()],
  charLiterals: true,
};
const GO: Syntax = {
  lineComments: ['//'],
  block: C_BLOCK,
  strings: [{ open: '`', close: '`', multiline: true, escape: 'none' }, dq()],
  charLiterals: true,
};
const RUST: Syntax = { lineComments: ['//'], block: NESTED_BLOCK, strings: [dq(true)], charLiterals: true, rustRawStrings: true };
const SWIFT: Syntax = { lineComments: ['//'], block: NESTED_BLOCK, strings: [tripleDq('backslash'), dq()] };
const JAVASCRIPT: Syntax = {
  lineComments: ['//'],
  block: C_BLOCK,
  strings: [{ open: '`', close: '`', multiline: true, escape: 'backslash' }, dq(), sq()],
  regexLiterals: true,
};
const PHP: Syntax = { lineComments: ['//', '#'], block: C_BLOCK, strings: [dq(true), sq(true)], phpAttributes: true };
const PYTHON: Syntax = { lineComments: ['#'], strings: [tripleDq('backslash'), tripleSq, dq(), sq()], pythonDocstrings: true };
const RUBY: Syntax = { lineComments: ['#'], strings: [dq(true), sq(true)], rubyBlockComments: true };

const SYNTAX_BY_EXTENSION: Record<string, Syntax> = {
  java: JAVA,
  kt: KOTLIN_SCALA,
  kts: KOTLIN_SCALA,
  scala: KOTLIN_SCALA,
  groovy: GROOVY,
  c: C_FAMILY,
  h: C_FAMILY,
  cc: C_FAMILY,
  cpp: C_FAMILY,
  cxx: C_FAMILY,
  hh: C_FAMILY,
  hpp: C_FAMILY,
  hxx: C_FAMILY,
  m: C_FAMILY,
  mm: C_FAMILY,
  cs: CSHARP,
  go: GO,
  rs: RUST,
  swift: SWIFT,
  js: JAVASCRIPT,
  jsx: JAVASCRIPT,
  mjs: JAVASCRIPT,
  cjs: JAVASCRIPT,
  ts: JAVASCRIPT,
  tsx: JAVASCRIPT,
  php: PHP,
  py: PYTHON,
  rb: RUBY,
};

/** Comment syntax for a file, or null when the language is unknown. */
export function syntaxForFile(filePath: string): Syntax | null {
  return SYNTAX_BY_EXTENSION[path.posix.extname(filePath).slice(1).toLowerCase()] ?? null;
}

/**
 * The code of every line with comments removed (a comment becomes one space)
 * and trailing whitespace trimmed; index 0 is line 1. A line holds code iff
 * its entry is not blank. For an unknown language (null syntax) only blank
 * lines count as non-code.
 */
export function codeLines(text: string, syntax: Syntax | null): string[] {
  if (!syntax) {
    return text.split('\n').map(trimEnd);
  }
  return new Scanner(text, syntax).run();
}

function trimEnd(s: string): string {
  return s.replace(/\s+$/, '');
}

/**
 * Comments that static analyzers read: warning suppressions and inline
 * configuration. Adding or changing one changes the analysis results, so
 * such comments count as code. Matching errs on the side of keeping.
 */
export const ANALYZER_DIRECTIVE = new RegExp(
  [
    'type:\\s*ignore', 'pyright:', 'mypy:', 'noqa', 'pylint:', 'nosec', // Python
    'NOPMD', 'CHECKSTYLE:', 'checkstyle:', 'NOSONAR', 'noinspection', 'SuppressWarnings', 'SuppressFBWarnings', '\\$NON-NLS-', // Java
    'eslint-disable', 'eslint-enable', 'eslint\\s', 'jshint', 'jslint', 'tslint:', '@ts-ignore', '@ts-expect-error', '@ts-nocheck', '@ts-check', // JS/TS
    'NOLINT', 'nolint', 'lint:ignore', 'cppcheck-suppress', 'coverity\\[', // C/C++/Go
    'ReSharper disable', 'ReSharper restore', 'rubocop:', 'phpcs:', '@phpstan-ignore', '@psalm-suppress', 'swiftlint:',
    'codeql\\[', 'lgtm\\[',
  ].join('|'),
  'i',
);

const JS_REGEX_PRECEDERS = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const JS_REGEX_KEYWORDS = /\b(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
const CHAR_LITERAL = /'(?:\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{1,4}|[0-7]{1,3}|[^\n])|[^'\\\n])'/y;
const CPP_RAW = /R"([^()\\\s]{0,16})\(/y;
const RUST_RAW = /r(#*)"/y;

class Scanner {
  private readonly out: string[] = [];
  private cur = '';
  private i = 0;
  /** Last non-blank code character so far (comments excluded), for regex/docstring heuristics. */
  private prevSig = '';
  private readonly special: RegExp;

  constructor(
    private readonly text: string,
    private readonly syn: Syntax,
  ) {
    const starts = new Set<string>(['\n']);
    syn.lineComments.forEach((c) => starts.add(c[0]));
    if (syn.block) {
      starts.add(syn.block.open[0]);
    }
    syn.strings.forEach((s) => starts.add(s.open[0]));
    if (syn.charLiterals) {
      starts.add("'");
    }
    if (syn.regexLiterals) {
      starts.add('/');
    }
    if (syn.cppRawStrings) {
      starts.add('R');
    }
    if (syn.rustRawStrings) {
      starts.add('r');
    }
    if (syn.rubyBlockComments) {
      starts.add('=');
    }
    this.special = new RegExp(`[${[...starts].map((c) => c.replace(/[\\\]^-]/g, '\\$&')).join('')}]`, 'g');
  }

  run(): string[] {
    const { text } = this;
    while (this.i < text.length) {
      this.special.lastIndex = this.i;
      const m = this.special.exec(text);
      const next = m ? m.index : text.length;
      if (next > this.i) {
        this.code(text.slice(this.i, next));
        this.i = next;
      }
      if (this.i < text.length) {
        this.step();
      }
    }
    this.out.push(trimEnd(this.cur));
    return this.out;
  }

  private step(): void {
    const { text, syn } = this;
    const i = this.i;
    const c = text[i];

    if (c === '\n') {
      this.newline();
      this.i++;
      return;
    }

    if (c === '=' && syn.rubyBlockComments && (i === 0 || text[i - 1] === '\n') && /^=begin(\s|$)/.test(text.slice(i, i + 7))) {
      const endMarker = text.indexOf('\n=end', i);
      const end = endMarker === -1 ? text.length : lineEnd(text, endMarker + 1);
      this.skip(end);
      return;
    }

    for (const lc of syn.lineComments) {
      if (text.startsWith(lc, i) && !(lc === '#' && syn.phpAttributes && text[i + 1] === '[')) {
        const end = lineEnd(text, i);
        if (ANALYZER_DIRECTIVE.test(text.slice(i, end))) {
          this.emit(i, end, false);
        } else {
          this.i = end;
          this.cur += ' ';
        }
        return;
      }
    }

    if (syn.block && text.startsWith(syn.block.open, i)) {
      const end = this.blockEnd(i);
      if (ANALYZER_DIRECTIVE.test(text.slice(i, end))) {
        this.emit(i, end, false);
      } else {
        this.skip(end);
        this.cur += ' ';
      }
      return;
    }

    if (syn.cppRawStrings && c === 'R' && ['', 'u8', 'L', 'u', 'U'].includes(trailingWord(this.cur))) {
      CPP_RAW.lastIndex = i;
      const m = CPP_RAW.exec(text);
      if (m) {
        this.emit(i, this.stringEnd(i + m[0].length, `)${m[1]}"`, true, 'none'), false);
        return;
      }
    }

    if (syn.rustRawStrings && c === 'r' && ['', 'b'].includes(trailingWord(this.cur))) {
      RUST_RAW.lastIndex = i;
      const m = RUST_RAW.exec(text);
      if (m) {
        this.emit(i, this.stringEnd(i + m[0].length, `"${m[1]}`, true, 'none'), false);
        return;
      }
    }

    for (const rule of syn.strings) {
      if (text.startsWith(rule.open, i)) {
        const end = this.stringEnd(i + rule.open.length, rule.close, rule.multiline, rule.escape);
        this.emit(i, end, this.isDocstring(rule, end));
        return;
      }
    }

    if (syn.charLiterals && c === "'") {
      CHAR_LITERAL.lastIndex = i;
      const m = CHAR_LITERAL.exec(text);
      if (m) {
        this.code(m[0]);
        this.i += m[0].length;
        return;
      }
    }

    if (syn.regexLiterals && c === '/' && this.regexAllowed()) {
      const end = this.regexEnd(i);
      if (end > 0) {
        this.code(text.slice(i, end));
        this.i = end;
        return;
      }
    }

    this.code(c);
    this.i++;
  }

  private code(s: string): void {
    this.cur += s;
    const t = trimEnd(s);
    if (t) {
      this.prevSig = t[t.length - 1];
    }
  }

  private newline(): void {
    this.out.push(trimEnd(this.cur));
    this.cur = '';
  }

  /** Skips non-code text up to `end`, keeping line structure. */
  private skip(end: number): void {
    for (let k = this.i; k < end; k++) {
      if (this.text[k] === '\n') {
        this.newline();
      }
    }
    this.i = end;
  }

  /** Index just past the block comment starting at `from` (nesting-aware). */
  private blockEnd(from: number): number {
    const { text } = this;
    const { open, close, nested } = this.syn.block!;
    let depth = 0;
    let k = from;
    while (k < text.length) {
      if ((depth === 0 || nested) && text.startsWith(open, k)) {
        depth++;
        k += open.length;
      } else if (text.startsWith(close, k)) {
        k += close.length;
        if (--depth === 0) {
          break;
        }
      } else {
        k++;
      }
    }
    return k;
  }

  /** Index just past the closing delimiter (or the line end / file end if unterminated). */
  private stringEnd(from: number, close: string, multiline: boolean, escape: StringRule['escape']): number {
    const { text } = this;
    let k = from;
    while (k < text.length) {
      const ch = text[k];
      if (escape === 'backslash' && ch === '\\') {
        k += text[k + 1] === '\n' ? 1 : 2;
        continue;
      }
      if (text.startsWith(close, k)) {
        if (escape === 'doubled' && text.startsWith(close, k + close.length)) {
          k += 2 * close.length;
          continue;
        }
        return k + close.length;
      }
      if (ch === '\n' && !multiline) {
        return k;
      }
      k++;
    }
    return text.length;
  }

  /** Emits text[start, end) as code (a string literal) or, for docstrings, as a comment. */
  private emit(start: number, end: number, asComment: boolean): void {
    if (asComment) {
      this.skip(end);
      this.cur += ' ';
      return;
    }
    const parts = this.text.slice(start, end).split('\n');
    this.code(parts[0]);
    for (const part of parts.slice(1)) {
      this.newline();
      this.code(part);
    }
    this.i = end;
  }

  private isDocstring(rule: StringRule, end: number): boolean {
    if (!this.syn.pythonDocstrings || rule.open.length !== 3 || this.cur.trim() !== '') {
      return false;
    }
    if (this.prevSig !== '' && this.prevSig !== ':') {
      return false; // e.g. an argument: execute(\n """SQL""")
    }
    const rest = this.text.slice(end, lineEnd(this.text, end)).trim();
    return rest === '' || rest.startsWith('#');
  }

  private regexAllowed(): boolean {
    const before = trimEnd(this.cur);
    if (before === '') {
      return this.prevSig === '' || JS_REGEX_PRECEDERS.has(this.prevSig);
    }
    return JS_REGEX_PRECEDERS.has(before[before.length - 1]) || JS_REGEX_KEYWORDS.test(before);
  }

  /** End of a /regex/flags literal starting at `start`, or -1 if it does not close on this line. */
  private regexEnd(start: number): number {
    const { text } = this;
    let inClass = false;
    for (let k = start + 1; k < text.length; k++) {
      const ch = text[k];
      if (ch === '\n') {
        return -1;
      }
      if (ch === '\\') {
        k++;
      } else if (ch === '[') {
        inClass = true;
      } else if (ch === ']') {
        inClass = false;
      } else if (ch === '/' && !inClass) {
        return k + 1;
      }
    }
    return -1;
  }
}

function lineEnd(text: string, from: number): number {
  const nl = text.indexOf('\n', from);
  return nl === -1 ? text.length : nl;
}

function trailingWord(s: string): string {
  return /\w*$/.exec(s)![0];
}
