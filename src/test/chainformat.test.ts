import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChainEdits, chainFormatEdits } from "../chainformat";

/*
 * The canonical shape is the samples-controls corpus style: an element one step
 * (4 spaces) under its parent, an attribute one step under its element, a
 * end( ) on the level of the ele( ) it closes. A file already in that
 * shape must round-trip UNCHANGED - a formatter that touches canonical code
 * is how formatters lose trust.
 *
 * The rule itself is the linter's `chain-house-layout` and is tested there;
 * what these assert is the CONTRACT this module has to the editor - canonical
 * in, nothing out; non-chain lines never touched; and the fixes applied in
 * order producing the canonical text. Working the layout out a second time
 * here is what made Format Document disagree with the linter about eight
 * files of the corpus.
 */

/** What the editor would end up with. */
const formatted = (text: string): string =>
  applyChainEdits(text, chainFormatEdits(text));

const CANONICAL = [
  "  METHOD render.",
  "    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).",
  "    view->ele( n = `View` ns = `mvc`",
  "        )->a( n = `xmlns`     v = `sap.m`",
  "        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`",
  "        )->ele( n = `Page`",
  "            )->a( n = `title` v = `My Page`",
  "            )->ele( `content`",
  "                )->tag( `Text`",
  "                    )->a( n = `text` v = `(parens) in a literal`",
  "                )->tag( `Button`",
  "                    )->a( n = `text`  v = `Go`",
  "                    )->a( n = `press` v = client->_event( `GO` )",
  "            )->end(",
  "        )->end( ).",
  "    client->view_display( view->stringify( ) ).",
  "  ENDMETHOD.",
].join("\n");

test("a canonically formatted chain produces no edits", () => {
  assert.deepEqual(chainFormatEdits(CANONICAL), []);
});

test("a scrambled chain is restored to the canonical shape", () => {
  const lines = CANONICAL.split("\n");
  const scrambled = lines
    .map((line, i) => {
      // mangle only builder-verb lines - everything else must keep its bytes
      if (!/^\s*\)->/.test(line)) {
        return line;
      }
      return `${" ".repeat((i * 3) % 7)}${line.trimStart()}`;
    })
    .join("\n");
  assert.equal(formatted(scrambled), CANONICAL);
});

test("lines outside a chain are never edited", () => {
  const source = [
    "  METHOD anything.",
    "        DATA(x) = 1.  \" badly indented, but not a chain",
    "    )->a( n = `stray` v = `line` )",
    "  ENDMETHOD.",
  ].join("\n");
  assert.deepEqual(chainFormatEdits(source), []);
});

test("continuation lines of a multi-line value keep their bytes", () => {
  const source = [
    "view->ele( n = `View`",
    "    )->tag( `Text`",
    "        )->a( n = `text` v = |a value",
    "spanning lines|",
    "    )->end( ).",
  ].join("\n");
  // the value's own second line is content, not layout - it keeps its bytes
  assert.equal(formatted(source).split("\n")[3], "spanning lines|");
});

test("two chains in one file are each formatted from their own base", () => {
  const source = [
    "    view->ele( n = `View`",
    ")->a( n = `xmlns` v = `sap.m`",
    "    )->end( ).",
    "      popup->ele( n = `Dialog`",
    "  )->a( n = `title` v = `T`",
    "      )->end( ).",
  ].join("\n");
  const out = formatted(source).split("\n");
  // each chain is measured from the column its own first line starts in
  assert.equal(out[1], "        )->a( n = `xmlns` v = `sap.m`");
  assert.equal(out[4], "          )->a( n = `title` v = `T`");
});

test("a commented-out chain line changes no level", () => {
  // regression: verbs were read off the raw line, so a commented-out
  // `)->end( ).` closed a level that had never been left and every line after
  // it was "corrected" one step too far out
  const lines = [
    "  METHOD render.",
    "    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).",
    "    view->ele( n = `Page`",
    "        )->ele( n = `VBox`",
    "            )->a( n = `id` v = `BOX`",
    "*        )->end( )",
    "            )->tag( n = `Text`",
    "                )->a( n = `text` v = `Hi`",
    "        )->end( )",
    "    )->end( ).",
    "  ENDMETHOD.",
  ];
  assert.deepEqual(chainFormatEdits(lines.join("\n")), []);
});

test("a paren inside a comment does not hold the statement open", () => {
  // regression: the paren balance ignored comments, so `inChain` never
  // cleared and unrelated lines further down were formatted against a chain
  // that had long ended
  const lines = [
    "  METHOD render.",
    "    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).",
    "    view->ele( n = `Page`",
    "        )->a( n = `title` v = `Hi`",
    "    )->end( ). \" closes the page (finally",
    "  ENDMETHOD.",
    "",
    "  METHOD other.",
    "        )->a( n = `stray` v = `x` )",
    "  ENDMETHOD.",
  ];
  // the stray line belongs to no chain, so it is left exactly as written
  assert.deepEqual(chainFormatEdits(lines.join("\n")), []);
});

test("a single-quoted literal with an open paren does not unbalance a chain", () => {
  const lines = [
    "  METHOD render.",
    "    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).",
    "    view->ele( n = `Page`",
    "        )->a( n = `text` v = 'a ( in a literal'",
    "    )->end( ).",
    "  ENDMETHOD.",
  ];
  assert.deepEqual(chainFormatEdits(lines.join("\n")), []);
});

test("formatting is idempotent - a formatted file is already formatted", () => {
  /*
   * The property that makes Format Document safe to bind to a keystroke, and
   * the one a locally derived layout algorithm kept breaking against the
   * linter: measured over the 637 builder classes of samples-controls, this
   * module now proposes an edit for none of them (it used to re-indent eight
   * that the rule considers correct), and formatting the formatted text is a
   * no-op everywhere.
   */
  const scrambled = CANONICAL.split("\n")
    .map((line, i) =>
      /^\s*\)->/.test(line)
        ? `${" ".repeat((i * 3) % 7)}${line.trimStart()}`
        : line
    )
    .join("\n");
  const once = formatted(scrambled);
  assert.equal(formatted(once), once, "a second pass changed the text again");
  assert.deepEqual(chainFormatEdits(once), []);
});

test("the edits never overlap - the editor applies them in one pass", () => {
  const scrambled = CANONICAL.split("\n")
    .map((line, i) =>
      /^\s*\)->/.test(line) ? `${" ".repeat(i % 5)}${line.trimStart()}` : line
    )
    .join("\n");
  const edits = chainFormatEdits(scrambled);
  assert.ok(edits.length > 0, "the fixture needs to produce edits at all");
  for (let i = 1; i < edits.length; i++) {
    assert.ok(
      edits[i].start >= edits[i - 1].end,
      `edit ${i} overlaps its predecessor`
    );
  }
});
