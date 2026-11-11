import { blankNonCode } from "./abapscan";

/*
 * What a `*.clas.testclasses.abap` holds, without `vscode` and without a
 * parser: the local test classes (`CLASS … DEFINITION … FOR TESTING`) and
 * their test methods (`METHODS … FOR TESTING`), each with the range it is
 * declared at - what the Testing view lists and where a failure is put when
 * the runner names a method and no line.
 *
 * Everything is read off the BLANKED source (`abapscan.ts`): a test include
 * is full of the words this looks for inside literals and comments - an
 * expected message `'CLASS x DEFINITION FOR TESTING.'`, a commented-out
 * `" METHODS old FOR TESTING.` - and blanking keeps every offset where it
 * was, so a range found in the blanked text is the range in the file.
 */

/** A range in the include, zero-based like the editor's. */
export interface SourceRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface TestMethod {
  /** As written in the declaration. */
  name: string;
  /** The method's name in its `METHODS` statement. */
  range: SourceRange;
}

export interface TestClass {
  /** As written in `CLASS … DEFINITION`. */
  name: string;
  /** The class's name in its definition statement. */
  range: SourceRange;
  methods: TestMethod[];
  /** `class_setup`, `setup`, `teardown`, `class_teardown` where the class
   *  declares them - not tests, but where a failing fixture is shown. */
  fixtures: TestMethod[];
}

const FIXTURES = new Set(["class_setup", "setup", "teardown", "class_teardown"]);

/** Offsets to editor positions, over one source. */
function locator(source: string): (from: number, to: number) => SourceRange {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") {
      lineStarts.push(i + 1);
    }
  }
  const at = (offset: number): { line: number; character: number } => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { line: lo, character: offset - lineStarts[lo] };
  };
  return (from, to) => {
    const a = at(from);
    const b = at(to);
    return {
      startLine: a.line,
      startCharacter: a.character,
      endLine: b.line,
      endCharacter: b.character,
    };
  };
}

/** The methods one `METHODS` / `CLASS-METHODS` statement declares, with the
 *  offset of each name and whether it is `FOR TESTING`. `code` is blanked,
 *  `base` its offset in the include. */
function methodsOf(
  code: string,
  base: number
): Array<{ name: string; at: number; testing: boolean }> {
  const keyword = /^\s*(?:CLASS-)?METHODS\b\s*(:)?/i.exec(code);
  if (!keyword) {
    return [];
  }
  const out: Array<{ name: string; at: number; testing: boolean }> = [];
  let at = keyword[0].length;
  const parts = keyword[1] === ":" ? code.slice(at).split(",") : [code.slice(at)];
  for (const part of parts) {
    const name = /^\s*([A-Za-z_][\w/]*)/.exec(part);
    if (name) {
      out.push({
        name: name[1],
        at: base + at + name[0].length - name[1].length,
        testing: /\bFOR\s+TESTING\b/i.test(part),
      });
    }
    at += part.length + 1; // the comma the split ate
  }
  return out;
}

/**
 * The test classes of a test include, in the order they are declared. A class
 * that is not `FOR TESTING` (a test double, a helper) is left out, and so is
 * an `ABSTRACT` one - the runner instantiates neither. A test class without a
 * test method is listed with none: the runner reports that case, and the
 * report needs somewhere to go.
 */
export function discoverTests(source: string): TestClass[] {
  const code = blankNonCode(source);
  const range = locator(source);
  const out: TestClass[] = [];
  const definition = /\bCLASS\s+([A-Za-z_][\w/]*)\s+DEFINITION\b([^.]*)\./gi;
  for (let m = definition.exec(code); m; m = definition.exec(code)) {
    const options = m[2];
    // `DEFINITION DEFERRED` and `DEFINITION LOAD` announce a class, they do
    // not declare one - and have no ENDCLASS to stop the body at
    if (/\b(?:DEFERRED|LOAD)\b/i.test(options)) {
      continue;
    }
    const bodyFrom = m.index + m[0].length;
    const end = /\bENDCLASS\b/i.exec(code.slice(bodyFrom));
    const bodyTo = end ? bodyFrom + end.index : code.length;
    definition.lastIndex = bodyTo;
    if (!/\bFOR\s+TESTING\b/i.test(options) || /\bABSTRACT\b/i.test(options)) {
      continue;
    }
    const nameAt = m.index + m[0].indexOf(m[1], 5);
    const cls: TestClass = {
      name: m[1],
      range: range(nameAt, nameAt + m[1].length),
      methods: [],
      fixtures: [],
    };
    let start = bodyFrom;
    for (let i = bodyFrom; i <= bodyTo; i++) {
      if (i < bodyTo && code[i] !== ".") {
        continue;
      }
      for (const method of methodsOf(code.slice(start, i), start)) {
        const entry = {
          name: method.name,
          range: range(method.at, method.at + method.name.length),
        };
        if (method.testing) {
          cls.methods.push(entry);
        } else if (FIXTURES.has(method.name.toLowerCase())) {
          cls.fixtures.push(entry);
        }
      }
      start = i + 1;
    }
    out.push(cls);
  }
  return out;
}
