/*
 * extractview - moving the tail of a builder chain into a method of its own.
 *
 * A view built with `z2ui5_cl_ui5_view_builder` is one statement, and a real
 * screen is a long one. The abap2UI5 answer is the handle idiom: a helper
 * method taking the builder as an importing parameter and returning it, so a
 * section of the view lives in a method with a name. The linter follows it
 * (a handle-typed helper is reconstructed, not counted as unattributable) -
 * but doing it by hand means splitting a chain without breaking its
 * parenthesis balance, inventing the parameter, and remembering to declare
 * the method in the right section.
 *
 * This is that edit, computed. `vscode`-free: what makes it correct is where
 * a chain may be cut, and that is string work with rules.
 *
 * The cut is deliberately restricted to a TAIL - from a chain-segment
 * boundary to the end of the statement. A middle section would have to hand
 * the handle back for the rest of the chain to continue from, which is
 * neither the corpus idiom nor readable; a tail produces exactly the shape
 * the samples use.
 */

import { blankNonCode } from "./abapscan";

export interface ExtractEdit {
  start: number;
  end: number;
  text: string;
}

export interface ExtractPlan {
  edits: ExtractEdit[];
  /** The variable the extracted method is handed. */
  handle: string;
}

/** Why an extraction was refused - shown to the user as it stands. */
export interface ExtractRefusal {
  error: string;
}

const CHAIN_CALL = /->\s*(ele|tag|a|end|shut|factory|stringify)\s*\(/i;

/*
 * Everything below reads the BLANKED source (see `abapscan.ts`): same length
 * and same offsets, with the content of literals, comments and templates
 * replaced by spaces. So a character that is still a `.` or a `-` there is one
 * in code, and a `'` inside a `" don't` comment neither opens a literal nor
 * hides the statement's real end. Scanning the source from the beginning to
 * answer "is this offset inside a literal" was also quadratic - the cost the
 * old version paid on every candidate, in a loop over the whole file.
 */

/** The ABAP statement around an offset: from after the previous `.` to the
 *  next one, both outside literals and comments. */
function statementAround(
  code: string,
  offset: number
): { start: number; end: number } | undefined {
  let start = 0;
  for (let i = offset; i > 0; i--) {
    if (code[i - 1] === ".") {
      start = i;
      break;
    }
  }
  const end = code.indexOf(".", offset);
  return end < 0 ? undefined : { start, end };
}

/** A `->` that begins a chain call, with the `)` closing the previous one
 *  staying behind. `view->ele(` is not one: it starts the chain, and there is
 *  nothing before it to leave behind. */
function isBoundary(code: string, at: number): boolean {
  if (code[at] !== "-" || code[at + 1] !== ">") {
    return false;
  }
  let before = at - 1;
  while (before >= 0 && /\s/.test(code[before])) {
    before--;
  }
  return code[before] === ")";
}

/**
 * The chain-segment boundary the cursor means.
 *
 * Forward on the cursor's own line first, then backwards. A chain is written
 * one call per line beginning `)->ele(`, so the cursor sits at the start of
 * that line or on its `)` - both are BEFORE the `->` they refer to, and
 * searching backwards alone would silently pick the previous call and extract
 * one section too much.
 */
function boundaryAt(code: string, offset: number): number | undefined {
  const lineEnd = code.indexOf("\n", offset);
  for (let i = offset; i < (lineEnd < 0 ? code.length : lineEnd); i++) {
    if (isBoundary(code, i)) {
      return i;
    }
  }
  for (let i = Math.min(offset, code.length - 2); i > 1; i--) {
    if (isBoundary(code, i)) {
      return i;
    }
  }
  return undefined;
}

/** Shift a block of lines so its shallowest line sits at `indent` spaces,
 *  keeping every relative step - the chain's own picture of its tree. */
function reindent(block: string, indent: number): string {
  const lines = block.split("\n");
  const depths = lines
    .slice(1)
    .filter((line) => line.trim())
    .map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
  const shallowest = depths.length ? Math.min(...depths) : 0;
  const shift = indent - shallowest;
  return lines
    .map((line, index) => {
      if (index === 0 || !line.trim()) {
        return line;
      }
      const current = /^[ \t]*/.exec(line)?.[0].length ?? 0;
      return " ".repeat(Math.max(0, current + shift)) + line.trimStart();
    })
    .join("\n");
}

/** Where a `METHODS` declaration goes: the PROTECTED section if the class has
 *  one (that is where the samples put view helpers), else PRIVATE, else just
 *  before the definition's ENDCLASS. */
function declarationPoint(source: string): number | undefined {
  for (const keyword of ["PROTECTED SECTION.", "PRIVATE SECTION."]) {
    const at = source.toUpperCase().indexOf(keyword);
    if (at >= 0) {
      return at + keyword.length;
    }
  }
  const endclass = source.toUpperCase().indexOf("ENDCLASS.");
  return endclass < 0 ? undefined : endclass;
}

/** Where the implementation goes: before the last `ENDCLASS.` of the file,
 *  which is the implementation part's end. */
function implementationPoint(source: string): number | undefined {
  const at = source.toUpperCase().lastIndexOf("ENDCLASS.");
  return at < 0 ? undefined : at;
}

const NAME_RE = /^[a-z][a-z0-9_]{0,28}$/i;

/**
 * The edits that move the selected tail of a chain into `methodName`.
 *
 * Refuses rather than guesses. Everything it will not do is something whose
 * result would have to be checked by hand anyway: a selection that is not a
 * chain, one that stops before the statement does, a name that is not a name.
 */
export function planExtract(
  source: string,
  selectionStart: number,
  methodName: string,
  builderClass = "z2ui5_cl_ui5_view_builder"
): ExtractPlan | ExtractRefusal {
  if (!NAME_RE.test(methodName)) {
    return { error: "A method name starts with a letter and holds letters, digits and _." };
  }
  if (new RegExp(String.raw`\bMETHODS\s+${methodName}\b`, "i").test(source)) {
    return { error: `The class already declares a method called ${methodName}.` };
  }
  // the statement and the cut are decided on code alone - a period or a `->`
  // inside a literal or a comment is neither a statement end nor a boundary
  const code = blankNonCode(source);
  const statement = statementAround(code, selectionStart);
  if (!statement) {
    return { error: "The cursor is not inside a statement that ends with a period." };
  }
  const text = source.slice(statement.start, statement.end);
  if (!CHAIN_CALL.test(text)) {
    return { error: "This is not a view builder chain - put the cursor in one." };
  }
  const boundary = boundaryAt(code, selectionStart);
  if (boundary === undefined || boundary <= statement.start || boundary >= statement.end) {
    return {
      error:
        "No chain call starts here. Put the cursor on the `)->ele( )` or " +
        "`)->tag( )` that should become the first line of the new method.",
    };
  }
  const head = source.slice(statement.start, boundary);
  const tail = source.slice(boundary, statement.end);
  if (!CHAIN_CALL.test(tail)) {
    return { error: "There is no chain call left after the cursor to extract." };
  }

  /*
   * The chain has to BE the statement, not sit inside another call.
   *
   * The classic one-statement style writes the whole view as an argument:
   *
   *     client->view_display( z2ui5_cl_ui5_view_builder=>factory(
   *       )->ele( `Page`
   *       )->stringify( ) ).
   *
   * Cutting that at a `)->` leaves a head with an unclosed `view_display(`
   * and a tail carrying a `)` and a `stringify( )` that belong to it - the
   * "extraction" then produced a head that does not compile and a method body
   * with a foreign call and a spare paren in it. Everything before the chain
   * begins must therefore be balanced; when it is not, this is a shape to
   * refuse rather than to guess at.
   */
  const chainStart = /(?:=>\s*factory\s*\(|\w\s*->\s*(?:ele|tag)\s*\()/i.exec(
    code.slice(statement.start, statement.end)
  );
  if (!chainStart) {
    return { error: "This is not a view builder chain - put the cursor in one." };
  }
  const before = code.slice(statement.start, statement.start + chainStart.index);
  let depth = 0;
  for (const c of before) {
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
    }
  }
  if (depth !== 0) {
    return {
      error:
        "This chain is written inside another call (client->view_display( … )). " +
        "Capture it in a variable first - DATA(view) = …factory( ) - then extract from that.",
    };
  }
  if (/->\s*stringify\s*\(/i.test(tail)) {
    return {
      error:
        "The selection reaches past the end of the view (stringify). Put the " +
        "cursor on the chain call that should start the new method.",
    };
  }

  /* The head has to end up in a variable, because that variable is what the
   * new method is handed. A chain already captured into one keeps its name -
   * re-capturing it would leave two handles for one chain. */
  const captured = /^\s*(?:DATA\(\s*([\w]+)\s*\)|([\w]+))\s*=\s/i.exec(head);
  const handle = captured ? (captured[1] ?? captured[2]) : "content";
  const indent = /^[ \t]*/.exec(head.replace(/^\n+/, ""))?.[0] ?? "    ";

  const edits: ExtractEdit[] = [];
  if (!captured) {
    // `view->ele( … )` becomes `DATA(content) = view->ele( … )`
    const at = statement.start + (head.length - head.trimStart().length);
    edits.push({ start: at, end: at, text: `DATA(${handle}) = ` });
  }
  // the tail leaves the statement; the head closes with a period, and the
  // call to the new method follows it
  edits.push({
    start: boundary,
    end: statement.end + 1, // include the statement's own period
    text: `.\n\n${indent}${methodName}( ${handle} ).`,
  });

  const declareAt = declarationPoint(source);
  const implementAt = implementationPoint(source);
  if (declareAt === undefined || implementAt === undefined) {
    return { error: "This file does not look like a class - no ENDCLASS found." };
  }
  edits.push({
    start: declareAt,
    end: declareAt,
    text:
      `\n\n    METHODS ${methodName}\n` +
      `      IMPORTING\n` +
      `        box           TYPE REF TO ${builderClass}\n` +
      `      RETURNING\n` +
      `        VALUE(result) TYPE REF TO ${builderClass}.`,
  });
  edits.push({
    start: implementAt,
    end: implementAt,
    text:
      `\n  METHOD ${methodName}.\n\n` +
      `    result = box${reindent(tail, 8).replace(/\s+$/, "")}.\n\n` +
      `  ENDMETHOD.\n\n`,
  });

  // applied back to front, so an earlier edit cannot move a later offset
  edits.sort((a, b) => b.start - a.start);
  return { edits, handle };
}
