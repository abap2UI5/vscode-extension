import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import {
  ClassIndex,
  ClassIndexOf,
  ClassIndexStore,
  LINTER_CLASS_INDEX_OF,
} from "../classindex";
import { runGate } from "../gate";

/*
 * The incremental class index against a full build.
 *
 * `ClassIndexStore` assembles what `classIndexOf( allSources )` returns out
 * of per-file calls (`classindex.ts` says why and how). The one property that
 * matters is that the assembly is the SAME index - so every test here drives
 * a store through edits, deletions, renames and new classes and compares it,
 * after every step, with a full build over the sources as they then stand.
 *
 * The pinned linter (0.8.5) has no `classIndexOf`, so the property is
 * measured against `referenceIndexOf` below - a transcription of the linter's
 * algorithm (its `factsOf` / `outsideAccesses`, lib/guide-rules.mjs on the
 * branch that adds it) with a simplified comment/literal scrub. The store
 * only relies on its contract - facts from the first CLASS DEFINITION, reads
 * recorded for the classes the run knows - and when a linter checkout sits
 * beside this repository the same comparison runs against the REAL function
 * over the real sample corpora.
 */

// ---------------------------------------------------------------------------
// A reference classIndexOf
// ---------------------------------------------------------------------------

/** Comments blanked (a `*` line, a `"` tail outside a literal), and with
 *  `blankLiterals` the literal contents too - offsets kept. */
function scrubbed(source: string, blankLiterals: boolean): string {
  let out = "";
  let i = 0;
  let lineStart = true;
  while (i < source.length) {
    const ch = source[i];
    if (lineStart && ch === "*") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? source.length : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    lineStart = ch === "\n";
    if (ch === '"') {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? source.length : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (ch === "`" || ch === "'" || ch === "|") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== "\n") {
        j++;
      }
      const body = source.slice(i + 1, j);
      out += ch + (blankLiterals ? body.replace(/[^\n]/g, " ") : body) + (source[j] === ch ? ch : "");
      i = source[j] === ch ? j + 1 : j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const referenceIndexOf: ClassIndexOf = (sources) => {
  const OWN_CS_EVENT = /\b(?:BEGIN\s+OF\s+cs_event\b|cs_event\s+(?:TYPE|LIKE)\b)/i;
  const index: ClassIndex = new Map();
  const readers: Array<{ own: string | null; src: string }> = [];
  for (const source of sources) {
    const src = scrubbed(String(source), false);
    const m = src.match(/\bCLASS\s+([\w/]+)\s+DEFINITION\b(?!\s+(?:DEFERRED|LOAD)\b)([^.]*)/i);
    const facts = m
      ? {
          name: m[1].toLowerCase(),
          superclass: m[2].match(/\bINHERITING\s+FROM\s+([\w/]+)/i)?.[1].toLowerCase() ?? null,
          csEvent: OWN_CS_EVENT.test(src),
        }
      : null;
    if (facts && !index.has(facts.name)) {
      index.set(facts.name, { superclass: facts.superclass, csEvent: facts.csEvent, outsideReads: new Set() });
    }
    if (src.includes("->")) {
      readers.push({ own: facts?.name ?? null, src });
    }
  }
  for (const { own, src } of readers) {
    const code = scrubbed(src, true);
    const vars = new Map<string, string>();
    for (const m of code.matchAll(/\bTYPE\s+REF\s+TO\s+([\w/]+)/gi)) {
      const v = /(?<![\w-])(\w+)\s+$/.exec(code.slice(Math.max(0, m.index - 200), m.index));
      const cls = m[1].toLowerCase();
      if (v && cls !== own && index.has(cls)) {
        vars.set(v[1].toLowerCase(), cls);
      }
    }
    for (const m of code.matchAll(/\bDATA\(\s*(\w+)\s*\)\s*=\s*(?:(?:CAST|NEW)\s+([\w/]+)\s*\(|([\w/]+)=>\w+\s*\()/gi)) {
      const cls = (m[2] ?? m[3]).toLowerCase();
      if (cls !== own && index.has(cls)) {
        vars.set(m[1].toLowerCase(), cls);
      }
    }
    for (const m of code.matchAll(/->\s*(\w+)\b(?!\s*\()/g)) {
      const before = code.slice(Math.max(0, m.index - 200), m.index);
      const recv = before.match(/(?:(?:^|[^\w>-])me\s*->\s*|^|[^\w>-])(\w+)\s*$/i);
      let cls: string | null = null;
      if (recv) {
        cls = vars.get(recv[1].toLowerCase()) ?? null;
      } else if (/\)\s*$/.test(before)) {
        let depth = 0;
        let i = before.length - 1;
        for (; i >= 0; i--) {
          if (before[i] === ")") {
            depth++;
          } else if (before[i] === "(" && --depth === 0) {
            break;
          }
        }
        const head = i > 0 ? before.slice(0, i).match(/(?:\b(?:CAST|NEW)\s+([\w/]+)|([\w/]+)=>\w+)\s*$/i) : null;
        const c = head ? (head[1] ?? head[2]).toLowerCase() : null;
        if (c && c !== own && index.has(c)) {
          cls = c;
        }
      }
      if (cls) {
        index.get(cls)!.outsideReads.add(m[1].toLowerCase());
      }
    }
  }
  return index;
};

/** An index as plain, ordered data - what two builds are compared by. */
const plain = (index: ClassIndex | undefined) =>
  index === undefined
    ? undefined
    : [...index]
        .map(([name, f]) => [name, f.superclass, f.csEvent, [...f.outsideReads].sort()] as const)
        .sort((a, b) => a[0].localeCompare(b[0]));

// ---------------------------------------------------------------------------
// A corpus of classes that read each other
// ---------------------------------------------------------------------------

/** A deterministic PRNG - a failing sequence must be reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function classSource(name: string, pick: () => number, names: string[]): string {
  const other = () => names[Math.floor(pick() * names.length)];
  const lines = [`CLASS ${name} DEFINITION PUBLIC`];
  if (pick() < 0.4) {
    lines.push(`  INHERITING FROM ${other()}`);
  }
  lines.push("  CREATE PUBLIC.", "  PUBLIC SECTION.", "    INTERFACES z2ui5_if_app.");
  if (pick() < 0.3) {
    lines.push("    CONSTANTS: BEGIN OF cs_event, go TYPE string VALUE `GO`, END OF cs_event.");
  }
  lines.push("    DATA ms_result TYPE string.", "ENDCLASS.", `CLASS ${name} IMPLEMENTATION.`, "  METHOD z2ui5_if_app~main.");
  const reads = Math.floor(pick() * 4);
  for (let i = 0; i < reads; i++) {
    const target = other();
    switch (Math.floor(pick() * 5)) {
      case 0:
        lines.push(`    DATA lo_${i} TYPE REF TO ${target}.`, `    DATA(x${i}) = lo_${i}->ms_result.`);
        break;
      case 1:
        lines.push(`    DATA(lo_${i}) = CAST ${target}( client->get_app( client->get( )-s_draft-id_prev_app ) ).`, `    DATA(y${i}) = lo_${i}->mv_value.`);
        break;
      case 2:
        lines.push(`    DATA(z${i}) = ${target}=>factory( )->ms_popup.`);
        break;
      case 3:
        lines.push(`    " DATA(c${i}) = CAST ${target}( x )->commented.`);
        break;
      default:
        lines.push(`    DATA(lo_${i}) = NEW ${target}( ).`, `    lo_${i}->mt_rows = VALUE #( ).`);
    }
  }
  lines.push("  ENDMETHOD.", "ENDCLASS.");
  return lines.join("\n") + "\n";
}

/** Drives a store and a full build through the same random edits. */
function fuzz(indexOf: ClassIndexOf, seed: number, steps: number, initial?: Map<string, string>): number {
  const pick = rng(seed);
  const names = Array.from({ length: 12 }, (_, i) => `zcl_c${i}`);
  const files = new Map<string, string>(initial ?? []);
  const store = new ClassIndexStore(indexOf);
  for (const [key, text] of files) {
    store.set(key, text);
  }
  let compared = 0;
  let measured = 0;
  const keys = () => [...files.keys()];
  for (let step = 0; step < steps; step++) {
    const roll = pick();
    if (roll < 0.15 && files.size) {
      const key = keys()[Math.floor(pick() * files.size)];
      files.delete(key);
      store.delete(key);
    } else if (roll < 0.3 && files.size) {
      // a rename: same file, another class name (or no class at all)
      const key = keys()[Math.floor(pick() * files.size)];
      const text = pick() < 0.2 ? "REPORT zfoo.\n" : classSource(`zcl_n${step}`, pick, names);
      names.push(`zcl_n${step}`);
      files.set(key, text);
      store.set(key, text);
    } else {
      const key = pick() < 0.5 && files.size ? keys()[Math.floor(pick() * files.size)] : `file:///f${step}.clas.abap`;
      const name = names[Math.floor(pick() * names.length)];
      const text = classSource(name, pick, names);
      files.set(key, text);
      store.set(key, text);
    }
    assert.deepEqual(
      plain(store.index()),
      plain(indexOf([...files.values()])),
      `seed ${seed}, step ${step}: the assembled index is not the full build`
    );
    compared++;
    const values = [...(store.index()?.values() ?? [])];
    if (values.some((f) => f.outsideReads.size) && values.some((f) => f.superclass)) {
      measured++;
    }
  }
  // a run whose index never held a read or a superclass compared nothing
  assert.ok(measured > steps / 5, `seed ${seed}: the corpus produced too few reads (${measured})`);
  return compared;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

test("without a classIndexOf the store keeps nothing and offers no index", () => {
  const store = new ClassIndexStore(null);
  assert.equal(store.enabled, false);
  store.set("a", "CLASS zcl_a DEFINITION PUBLIC.\nENDCLASS.\n");
  assert.equal(store.size, 0);
  assert.equal(store.index(), undefined);
  assert.equal(store.depsOf("zcl_a"), "");
});

test("the assembled index is the full build after every edit (reference classIndexOf)", () => {
  let compared = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    compared += fuzz(referenceIndexOf, seed, 60);
  }
  assert.ok(compared >= 400);
});

test("a superclass chain and a popup's result read from outside, through the store", () => {
  const store = new ClassIndexStore(referenceIndexOf);
  const dir = path.join(__dirname, "..", "src", "test", "fixtures", "classindex");
  for (const file of fs.readdirSync(dir)) {
    store.set(file, fs.readFileSync(path.join(dir, file), "utf8"));
  }
  const index = store.index()!;
  assert.equal(index.get("zcl_fx_worklist")?.superclass, "zcl_fx_list_report");
  assert.equal(index.get("zcl_fx_list_report")?.csEvent, true);
  assert.equal(index.get("zcl_fx_close_popup")?.csEvent, false);
  // the subclass's deps name its superclass's facts - editing that class
  // changes the subclass's key, editing an unrelated one does not
  const before = store.depsOf("zcl_fx_worklist");
  assert.match(before, /zcl_fx_list_report/);
  const unrelated = store.depsOf("zcl_fx_close_popup");
  store.set(
    "zcl_fx_list_report.clas.abap",
    fs
      .readFileSync(path.join(dir, "zcl_fx_list_report.clas.abap"), "utf8")
      .replace(/BEGIN OF cs_event,[\s\S]*?END OF cs_event\./, "c TYPE i.")
  );
  assert.notEqual(store.depsOf("zcl_fx_worklist"), before);
  assert.equal(store.depsOf("zcl_fx_close_popup"), unrelated);
  // a caller reaching the popup's attribute through a typed reference
  store.set(
    "caller",
    [
      "CLASS zcl_caller DEFINITION PUBLIC.",
      "ENDCLASS.",
      "CLASS zcl_caller IMPLEMENTATION.",
      "  METHOD on_return.",
      "    DATA(popup) = CAST zcl_fx_close_popup( client->get_app( id ) ).",
      "    DATA(result) = popup->ms_result.",
      "  ENDMETHOD.",
      "ENDCLASS.",
    ].join("\n")
  );
  assert.deepEqual([...store.index()!.get("zcl_fx_close_popup")!.outsideReads], ["ms_result"]);
  store.delete("caller");
  assert.deepEqual([...store.index()!.get("zcl_fx_close_popup")!.outsideReads], []);
});

test("the generation moves when the index's content does, and only then", () => {
  const store = new ClassIndexStore(referenceIndexOf);
  store.set("a", "CLASS zcl_a DEFINITION PUBLIC.\nENDCLASS.\n");
  const g1 = store.generation;
  // a text change that changes no fact
  store.set("a", "CLASS zcl_a DEFINITION PUBLIC.\n  \" a comment\nENDCLASS.\n");
  assert.equal(store.generation, g1);
  // the same text again is not even a change
  store.set("a", "CLASS zcl_a DEFINITION PUBLIC.\n  \" a comment\nENDCLASS.\n");
  assert.equal(store.generation, g1);
  store.set("b", "CLASS zcl_b DEFINITION PUBLIC INHERITING FROM zcl_a.\nENDCLASS.\n");
  assert.ok(store.generation > g1);
});

test("a rescan's retain drops the files that are gone", () => {
  const store = new ClassIndexStore(referenceIndexOf);
  store.set("a", "CLASS zcl_a DEFINITION PUBLIC.\nENDCLASS.\n");
  store.set("b", "CLASS zcl_b DEFINITION PUBLIC.\nENDCLASS.\n");
  store.retain(new Set(["b"]));
  assert.deepEqual(plain(store.index())?.map((row) => row[0]), ["zcl_b"]);
});

// ---------------------------------------------------------------------------
// Against the real linter, when there is one to run
// ---------------------------------------------------------------------------

/** A linter checkout beside this repository whose abap-rules export
 *  `classIndexOf` - the release after 0.8.5, or its branch. */
async function checkoutIndexOf(): Promise<ClassIndexOf | undefined> {
  const file = path.join(__dirname, "..", "..", "linter", "lib", "abap-rules.mjs");
  if (!fs.existsSync(file)) {
    return undefined;
  }
  try {
    const mod = (await import(pathToFileURL(file).href)) as { classIndexOf?: ClassIndexOf };
    return typeof mod.classIndexOf === "function" ? mod.classIndexOf : undefined;
  } catch {
    return undefined;
  }
}

test("the assembled index is the full build of the REAL classIndexOf (bundled or checkout)", async (t) => {
  const real = LINTER_CLASS_INDEX_OF ?? (await checkoutIndexOf());
  if (!real) {
    t.skip("neither the pinned linter nor a ../linter checkout exports classIndexOf");
    return;
  }
  let compared = 0;
  for (const seed of [11, 12, 13]) {
    compared += fuzz(real, seed, 40);
  }
  // and over real sources, when the sample repositories are checked out too
  const corpus = new Map<string, string>();
  for (const repo of ["samples", "samples-controls", "samples-stack", "abap2UI5"]) {
    const root = path.join(__dirname, "..", "..", repo, "src");
    const walk = (dir: string): void => {
      for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
        } else if (entry.name.endsWith(".clas.abap") && corpus.size < 600) {
          corpus.set(p, fs.readFileSync(p, "utf8"));
        }
      }
    };
    walk(root);
  }
  if (corpus.size) {
    const store = new ClassIndexStore(real);
    for (const [key, text] of corpus) {
      store.set(key, text);
    }
    assert.deepEqual(plain(store.index()), plain(real([...corpus.values()])), "the corpus index");
    // an edit to every tenth file - a reader's reads, a class's superclass
    let i = 0;
    for (const [key, text] of corpus) {
      if (i++ % 10 === 0) {
        const edited = text.replace(/\bINHERITING\s+FROM\s+[\w/]+/i, "").replace(/->\s*ms_/g, "->mx_");
        corpus.set(key, edited);
        store.set(key, edited);
      }
    }
    assert.deepEqual(plain(store.index()), plain(real([...corpus.values()])), "the corpus index after edits");
  }
  assert.ok(compared > 0);
});

// ---------------------------------------------------------------------------
// The gate with an index
// ---------------------------------------------------------------------------

test("the gate takes a class index - and with a linter that ignores it, nothing changes", () => {
  const dir = path.join(__dirname, "..", "src", "test", "fixtures", "classindex");
  const store = new ClassIndexStore(LINTER_CLASS_INDEX_OF ?? referenceIndexOf);
  for (const file of fs.readdirSync(dir)) {
    store.set(file, fs.readFileSync(path.join(dir, file), "utf8").replace(/\r\n/g, "\n"));
  }
  const worklist = fs.readFileSync(path.join(dir, "zcl_fx_worklist.clas.abap"), "utf8").replace(/\r\n/g, "\n");
  const options = { minUi5: "1.71", allow: [], rules: {}, distribution: null };
  const without = runGate(worklist, "src/zcl_fx_worklist.clas.abap", false, options).findings;
  const withIndex = runGate(worklist, "src/zcl_fx_worklist.clas.abap", false, {
    ...options,
    classIndex: store.index(),
  }).findings;
  const rule = "frontend-action-as-backend-event";
  if (!LINTER_CLASS_INDEX_OF) {
    // the pinned linter takes no index: the option must be harmless
    assert.deepEqual(
      withIndex.map((f) => [f.type, f.offset]),
      without.map((f) => [f.type, f.offset])
    );
    return;
  }
  // a linter that reads it: the inherited cs_event is the class's own, as
  // `checkFiles` (CI) judges it with the index it builds over the run
  assert.ok(!withIndex.some((f) => f.type === rule), `${rule} reported on an inherited cs_event`);
  const popup = fs.readFileSync(path.join(dir, "zcl_fx_close_popup.clas.abap"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(
    runGate(popup, "src/zcl_fx_close_popup.clas.abap", false, { ...options, classIndex: store.index() }).findings.some(
      (f) => f.type === rule
    ),
    `${rule} is the true positive on a class with no cs_event of its own`
  );
});
