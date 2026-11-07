import { codeLines, syntaxForFile } from './codeLines';
import { ChangeType, CodeChange, FileChange } from './types';

/**
 * Removes what is not source code from a file's changes:
 *  - changed lines that hold only comments or whitespace are dropped from a block;
 *  - a block is dropped when nothing is left, or when its remaining code is
 *    identical before and after (only a comment on a code line changed);
 *  - the block type is recomputed from what is left (a block that replaced a
 *    comment with code becomes "added").
 *
 * `before` / `after` are the full file contents; when one is missing (could
 * not be read) its lines are all treated as code, i.e. nothing is dropped on
 * that side.
 */
export function filterCodeChanges(
  file: FileChange,
  before: Buffer | null,
  after: Buffer | null,
): { changes: CodeChange[]; dropped: number } {
  const beforeCode = before && file.oldPath !== null ? codeLines(before.toString('utf8'), syntaxForFile(file.oldPath)) : null;
  const afterCode = after && file.newPath !== null ? codeLines(after.toString('utf8'), syntaxForFile(file.newPath)) : null;
  const isCode = (lines: string[] | null, n: number) => lines === null || (lines[n - 1] ?? '').trim() !== '';

  const changes: CodeChange[] = [];
  let dropped = 0;
  for (const c of file.changes) {
    const keepDeleted = c.deletedLineNumbers.map((n) => isCode(beforeCode, n));
    const keepAdded = c.addedLineNumbers.map((n) => isCode(afterCode, n));
    const deletedLineNumbers = c.deletedLineNumbers.filter((_, k) => keepDeleted[k]);
    const addedLineNumbers = c.addedLineNumbers.filter((_, k) => keepAdded[k]);

    if (deletedLineNumbers.length === 0 && addedLineNumbers.length === 0) {
      dropped++;
      continue;
    }
    if (
      beforeCode &&
      afterCode &&
      deletedLineNumbers.length === addedLineNumbers.length &&
      deletedLineNumbers.every((n, k) => beforeCode[n - 1] === afterCode[addedLineNumbers[k] - 1])
    ) {
      dropped++;
      continue;
    }

    const type: ChangeType =
      deletedLineNumbers.length > 0 && addedLineNumbers.length > 0 ? 'modified' : addedLineNumbers.length > 0 ? 'added' : 'deleted';
    changes.push({
      ...c,
      type,
      deletedCode: c.deletedCode.filter((_, k) => keepDeleted[k]),
      addedCode: c.addedCode.filter((_, k) => keepAdded[k]),
      deletedLineNumbers,
      addedLineNumbers,
    });
  }
  return { changes, dropped };
}
