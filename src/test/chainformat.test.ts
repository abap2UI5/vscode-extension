import { test } from "node:test";
import assert from "node:assert/strict";
import { chainIndentEdits } from "../chainformat";

/*
 * The canonical shape is the samples-controls corpus style: an element one step
 * (4 spaces) under its parent, an attribute one step under its element, a
 * shut( ) on the level of the open( ) it closes. A file already in that
 * shape must round-trip UNCHANGED - a formatter that touches canonical code
 * is how formatters lose trust.
 */

const CANONICAL = [
  "  METHOD render.",
  "    DATA(view) = z2ui5_cl_ai_xml=>factory( ).",
  "    view->open( n = `View` ns = `mvc`",
  "        )->a( n = `xmlns`     v = `sap.m`",
  "        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`",
  "        )->open( n = `Page`",
  "            )->a( n = `title` v = `My Page`",
  "            )->open( `content`",
  "                )->leaf( `Text`",
  "                    )->a( n = `text` v = `(parens) in a literal`",
  "                )->leaf( `Button`",
  "                    )->a( n = `text`  v = `Go`",
  "                    )->a( n = `press` v = client->_event( `GO` )",
  "            )->shut(",
  "        )->shut( ).",
  "    client->view_display( view->stringify( ) ).",
  "  ENDMETHOD.",
].join("\n");

test("a canonically formatted chain produces no edits", () => {
  assert.deepEqual(chainIndentEdits(CANONICAL), []);
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
  const edits = chainIndentEdits(scrambled);
  const restored = scrambled.split("\n");
  for (const edit of edits) {
    restored[edit.line] = edit.indent + restored[edit.line].trimStart();
  }
  assert.equal(restored.join("\n"), CANONICAL);
});

test("lines outside a chain are never edited", () => {
  const source = [
    "  METHOD anything.",
    "        DATA(x) = 1.  \" badly indented, but not a chain",
    "    )->a( n = `stray` v = `line` )",
    "  ENDMETHOD.",
  ].join("\n");
  assert.deepEqual(chainIndentEdits(source), []);
});

test("continuation lines of a multi-line value keep their bytes", () => {
  const source = [
    "view->open( n = `View`",
    "    )->leaf( `Text`",
    "        )->a( n = `text` v = |a value",
    "spanning lines|",
    "    )->shut( ).",
  ].join("\n");
  // the continuation line does not start with )->verb, so no edit names it
  assert.ok(chainIndentEdits(source).every((e) => e.line !== 3));
});

test("two chains in one file are each formatted from their own base", () => {
  const source = [
    "    view->open( n = `View`",
    ")->a( n = `xmlns` v = `sap.m`",
    "    )->shut( ).",
    "      popup->open( n = `Dialog`",
    "  )->a( n = `title` v = `T`",
    "      )->shut( ).",
  ].join("\n");
  const edits = chainIndentEdits(source);
  const byLine = new Map(edits.map((e) => [e.line, e.indent]));
  assert.equal(byLine.get(1), "        ");
  assert.equal(byLine.get(4), "          ");
});
