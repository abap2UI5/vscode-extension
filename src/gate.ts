/*
 * The in-process property gate - every rule that runs without I/O, extracted
 * from `viewcheck.ts` so both bundles share it: the desktop build wraps it
 * in the full checker (repo config, render gate, workspace sweep), the web
 * build runs exactly this and nothing more.
 *
 * `vscode`-free by design; the linter modules it calls are pure too (the
 * snapshot is handed in by `snapshot.ts`).
 */

import * as abapRules from "@abap2ui5/linter/abap-rules";
import {
  checkAbapRules,
  elementBoundSlots,
  namedModels,
  obsoleteCcHelperFindings,
} from "@abap2ui5/linter/abap-rules";
import { prepareAbap } from "@abap2ui5/linter/reconstruct";
import {
  checkNodes,
  collectControlIds,
  collectEnumBoundFields,
  DEFAULT_TRUE_BOOLEAN,
  parseXml,
  PropertyFinding,
  WALK_ONLY_RULES,
} from "@abap2ui5/linter/properties";
import { checkIcons } from "@abap2ui5/linter/icons";
import {
  annotate,
  applyDirectives,
  applyRules,
  attachSourceFixes,
  attachSuggestionFixes,
} from "@abap2ui5/linter/findings";
import * as linterFix from "@abap2ui5/linter/fix";
import { snapshot } from "./snapshot";
import { blankComments } from "./abapscan";
import type { CheckOptions } from "./lintconfig";

/**
 * A linter export the PINNED release may not have yet - the function, or
 * undefined. The gate runs against whatever `@abap2ui5/linter` it is built
 * with, and an input the next release adds (the class index, the line-ending
 * pass) has to switch on with the bump rather than wait for an edit here; a
 * named import of a missing export would not even bundle. The name is a
 * parameter on purpose: read as a constant property of the namespace,
 * esbuild resolves it at build time and warns that it is always undefined.
 */
export function linterExport<T>(ns: object, name: string): T | undefined {
  const value = (ns as Record<string, unknown>)[name];
  return typeof value === "function" ? (value as T) : undefined;
}

type FixFinding = { type: string; fixes?: Array<{ start: number; end: number; text: string }> };

/** The linter's own pass when it has one (its `settle` step, from the release
 *  after 0.8.5 on), else {@link matchLineEndingsPort}. */
export const LINTER_MATCH_EOL = linterExport<(findings: FixFinding[], source: string) => FixFinding[]>(
  linterFix,
  "matchLineEndings"
);

/**
 * Makes every fix write the line ending the file will have - a port of the
 * linter's `matchLineEndings` (lib/fix.mjs), used while the pinned release
 * does not export it. The rules write replacement text with `\n`; in a file
 * whose line breaks are mostly CRLF every `\n` of a fix text becomes `\r\n`
 * (a `\n` at the very start of a text inserted right behind a `\r` completes
 * that line break and stays). While a `crlf-line-ending` finding is among
 * them it is the other way round: its fix turns the file into LF, so every
 * other text writes LF too. Mutates and returns `findings`.
 *
 * VS Code would normalise an inserted text to the document's line ending
 * anyway, so the lightbulb never wrote a mixed file; what this changes is the
 * findings themselves - what the MCP system server hands an agent, and what
 * `gate.parity.test.ts` compares against the CLI's `--fix`.
 */
export function matchLineEndingsPort<F extends FixFinding>(findings: F[], source: string): F[] {
  const text = String(source ?? "");
  const toLf = findings.some((f) => f.type === "crlf-line-ending");
  if (!toLf) {
    const crlf = text.split("\r\n").length - 1;
    if (!crlf || crlf * 2 <= text.split("\n").length - 1) {
      return findings;
    }
  }
  for (const f of findings) {
    if (f.type === "crlf-line-ending") {
      continue;
    }
    for (const e of f.fixes ?? []) {
      if (typeof e.text !== "string" || !e.text.includes("\n")) {
        continue;
      }
      e.text = toLf
        ? e.text.replace(/\r\n/g, "\n")
        : e.text.replace(/\r?\n/g, (nl, at: number) =>
            at === 0 && nl === "\n" && text[e.start - 1] === "\r" ? nl : "\r\n"
          );
    }
  }
  return findings;
}

/** The line-ending pass the gate's `settle` ends with - the linter's when the
 *  pinned release exports it. */
export function matchLineEndings<F extends FixFinding>(findings: F[], source: string): F[] {
  return LINTER_MATCH_EOL
    ? (LINTER_MATCH_EOL(findings, source) as F[])
    : matchLineEndingsPort(findings, source);
}

/** The linter's "another class reads this class's public attributes" test
 *  (from the release after 0.8.5 on): with it, `checkAbapSource` stands the
 *  two public-attribute rules down for the class, and a waiver of either is
 *  unjudged rather than unused. */
export const LINTER_PUBLIC_READ_FROM_OUTSIDE = linterExport<
  (source: string, classIndex?: ReadonlyMap<string, unknown> | null) => boolean
>(abapRules, "publicReadFromOutside");

/**
 * The linter's stand-down of `unused-namespace-declaration` - a port of the
 * block in `checkAbapSource` (lib/index.mjs), which exports no function for
 * it. The rule is a claim about the WHOLE view, only as good as the
 * reconstruction behind it: a class whose reconstruction is incomplete
 * (`unplacedTokens`), or that writes the prefix in more builder literals
 * (`ns = \`form\``, `\`form:SimpleForm\``) than its reconstructed documents
 * carry, may use it exactly where nobody looked - and the finding came with a
 * deleting fix that broke the view. Without the port the editor reported it,
 * and the lightbulb offered that fix, on classes CI is silent about.
 *
 * Returns the surviving findings and the rules that stood down (for
 * `applyDirectives`: a waiver of a rule that did not judge the class is not
 * "unused"). The literal count reads the source with its comments blanked
 * (`blankComments`, the linter reads it through its own `scrub`).
 */
export function standDownUnusedNamespaces<F extends { type: string; member?: unknown }>(
  findings: F[],
  source: string,
  prep: Pick<PreparedAbap, "unplacedTokens" | "nodes">
): { findings: F[]; stoodDown: string[] } {
  const RULE = "unused-namespace-declaration";
  const incomplete = prep.unplacedTokens > 0;
  const stoodDown = incomplete ? [RULE] : [];
  if (!findings.some((f) => f.type === RULE)) {
    return { findings, stoodDown };
  }
  const code = blankComments(source);
  const inSource = (prefix: string): number => {
    const p = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      (code.match(new RegExp(`\\bns\\s*=\\s*[\`']${p}[\`']`, "gi")) ?? []).length +
      (code.match(new RegExp(`[(=]\\s*[\`']${p}:[A-Za-z]`, "gi")) ?? []).length
    );
  };
  const inDocs = new Map<string, number>();
  const count = (p: string) => inDocs.set(p, (inDocs.get(p) ?? 0) + 1);
  const walk = (node: PreparedAbap["nodes"][number]): void => {
    if (node.name) {
      if (node.ns) {
        count(node.ns);
      } else if (String(node.name).includes(":")) {
        count(String(node.name).split(":")[0]);
      }
      for (const [n] of node.attrs ?? []) {
        const at = String(n).indexOf(":");
        if (at > 0 && !String(n).startsWith("xmlns")) {
          count(String(n).slice(0, at));
        }
      }
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  for (const root of prep.nodes ?? []) {
    walk(root);
  }
  const kept = findings.filter(
    (f) =>
      f.type !== RULE ||
      (!incomplete &&
        inSource(String(f.member ?? "")) <= (inDocs.get(String(f.member ?? "")) ?? 0))
  );
  if (kept.length < findings.length && !stoodDown.length) {
    stoodDown.push(RULE);
  }
  return { findings: kept, stoodDown };
}

export const VIEW_XML_RE = /\.(view|fragment)\.xml$/i;

/** The frozen builders the linter reports `frozen-view-builder` for. Like
 *  `checkIcons` before it, `frozenBuilderOf` has no subpath in the linter's
 *  `exports` map, so the two names are mirrored here - `gate.parity.test.ts`
 *  pins this list to `checkAbapSource`'s answer. */
const FROZEN_BUILDERS = ["z2ui5_cl_xml_view", "z2ui5_cl_xml_view_cc"];

/** Compiled once: `frozenBuilderOf` runs inside `isCheckableSource`, i.e. on
 *  every keystroke, code-action request and sweep file - not the place to
 *  build regexes. No `g` flag, so `test` and `search` stay stateless. */
const FROZEN_FACTORY_RES = FROZEN_BUILDERS.map((name) => ({
  name,
  re: new RegExp(`\\b${name}\\s*=>\\s*factory`, "i"),
}));

/** The frozen builder a source builds its view with, or undefined. */
export function frozenBuilderOf(text: string): string | undefined {
  return FROZEN_FACTORY_RES.find((f) => f.re.test(text))?.name;
}

/**
 * The file as the repo's CI names it: relative to the governing config's
 * directory. `rules.*.exclude` patterns are written against that spelling
 * (`^src/02/`), and the linter derives its relative form from `process.cwd()`
 * - the repo root for a CLI run, the extension host's arbitrary directory
 * here. So the config-relative spelling is derived too and `applyRules` runs
 * over both, or an exclude CI honours kept squiggling in the editor.
 *
 * Exported for the render gate's `rules['render-error'].exclude`, which the
 * desktop check matches against the same two spellings (`checkcore.ts`,
 * `settleRenderErrors`).
 */
export function configRelative(
  file: string,
  configFile: string | undefined
): string | undefined {
  if (!configFile) {
    return undefined;
  }
  const norm = (p: string): string => p.replace(/\\/g, "/");
  const config = norm(configFile);
  const cut = config.lastIndexOf("/");
  if (cut < 0) {
    return undefined;
  }
  const dir = config.slice(0, cut);
  const f = norm(file);
  return f.startsWith(`${dir}/`) ? f.slice(dir.length + 1) : undefined;
}

/** The linter's reconstruction of a class - what `prepareAbap` returns. */
export type PreparedAbap = ReturnType<typeof prepareAbap>;

/**
 * What the gate is run with: the resolved check options, plus optionally the
 * caller's own reconstruction of the SAME text.
 *
 * `prepareAbap` walks the whole source, and the vscode layer already memoises
 * it per document version for completion, hover and the inline annotations
 * (`preparedAbapOf`). Without the handover every keystroke and every CodeLens
 * pass parsed the identical text a second time in here. A caller that has no
 * document at hand (the workspace sweep over files on disk, the parity tests)
 * simply leaves `prep` out and the gate derives it itself - the two paths are
 * pinned to the same findings in `gate.parity.test.ts`.
 */
export interface GateOptions extends CheckOptions {
  /** MUST be `prepareAbap` of exactly the `text` handed to `runGate`. */
  prep?: PreparedAbap;
  /**
   * The other classes of the workspace, as the linter's `classIndexOf( )`
   * describes them (`classindex.ts` keeps it). CI's `checkFiles` builds this
   * index over the files of the run and judges the class-level rules with it
   * - an INHERITED `cs_event` is the class's own (frontend-action-as-backend-
   * event), a public attribute another class reads is read
   * (`outsideReads`). Without it the editor reported what CI silences.
   * Undefined when the pinned linter has no `classIndexOf`; a linter whose
   * `checkAbapRules` takes no index ignores it.
   */
  classIndex?: ReadonlyMap<string, unknown>;
}

export interface GateResult {
  findings: PropertyFinding[];
  /** True when the source is one the render gate could load as a whole. */
  renderable: boolean;
  /** Set when nothing was validated - the caller must not claim a pass. */
  nothingChecked?: string;
  helperNote: string;
}

/** What the callers say about a builder class that reconstructs no view. */
const NO_VIEW = "builder call found but no view could be reconstructed";

/** Merge one `collectEnumBoundFields` answer into the per-table map. */
function mergeFields(
  into: Map<string, Set<string>>,
  from: Map<string, Set<string>>
): void {
  for (const [table, fields] of from) {
    const known = into.get(table) ?? new Set<string>();
    for (const field of fields) {
      known.add(field);
    }
    into.set(table, known);
  }
}

/**
 * Runs every in-process rule over one source and returns the surviving
 * findings: after the repo config's `rules` block (severity overrides and
 * switch-offs) and after the source's own `abap2ui5lint-disable…` directives.
 * Both of those are what the CLI and the GitHub Action apply, and leaving
 * them out here is what used to make a waived line squiggle in the editor
 * anyway.
 */
export function runGate(
  text: string,
  fileName: string,
  isXml: boolean,
  options: GateOptions
): GateResult {
  const { minUi5, allow } = options;
  /* `""`/null is "nobody said which distribution" - the linter's own default,
   * and its own answer (a SAPUI5-only control is then a HINT). It is handed
   * on as the absence it is, never turned into "sapui5" on the way: that
   * would silence the one finding an undecided repository should see. */
  const distribution = options.distribution || undefined;
  const data = snapshot();
  const findings: PropertyFinding[] = [];
  let renderable = true;
  let helperNote = "";
  /** ABAP only: the builder is called but nothing was reconstructable. */
  let noView = false;
  /** Rules that ran and withdrew their verdict on this source - a waiver of
   *  one is unjudged, not unused (the linter's `stoodDown`). */
  const stoodDown: string[] = [];

  // the linter's `settle`, plus the config-relative spelling of the file for
  // `rules.*.exclude` - see `configRelative`
  const rel = configRelative(fileName, options.configFile);
  const settled = (raw: PropertyFinding[], stoodDown: string[] = []): PropertyFinding[] => {
    annotate(raw, text);
    let out = applyRules(raw, options.rules, fileName);
    if (rel !== undefined && rel !== fileName) {
      out = applyRules(out, options.rules, rel);
    }
    /* The directives with what the linter's settle tells them: the `rules`
     * block and the file (a directive's OWN findings - unused-directive,
     * unknown-directive-rule - are switched off, re-graded and excluded like
     * any other; without it a repository that turned `unused-directive` off
     * still saw it in the editor), which rules ran (with no snapshot the
     * property walk did not, and a waiver of one of its rules is unjudged,
     * not unused) and which stood down on this source. */
    const directed = applyDirectives(out, text, {
      rules: options.rules,
      file: rel ?? fileName,
      ran: (id) => Boolean(data) || !WALK_ONLY_RULES.has(id),
      stoodDown,
    });
    // last, as the linter's settle does: the fixes of what survived speak
    // the file's line ending (which needs to know whether crlf-line-ending
    // survived the rules block and the directives)
    return matchLineEndings(directed, text);
  };

  if (isXml) {
    findings.push(
      ...checkNodes(parseXml(text), { data, minUi5, allow, distribution })
    );
    /* The icon scan is a TEXT scan, not a walk of the tree - an icon name
     * travels as data (a bound column, a constant) as often as it travels as
     * an attribute. `checkXmlSource` runs it here and this gate could not:
     * `checkIcons` had no subpath export, so the editor judged a `.view.xml`
     * without the icon rules while CI judged it with them. */
    findings.push(...checkIcons(text, { minUi5 }));
    // the did-you-mean fixes (unknown-control, unknown-property, …): the
    // rule records `written`/`suggestion`, this turns them into a span -
    // exactly what `checkXmlSource` does, so the lightbulb offers what
    // `--fix` applies
    attachSuggestionFixes(findings, text, { xml: true });
  } else {
    const prep = options.prep ?? prepareAbap(text);
    if (!prep.usesBuilder) {
      /* A class on a FROZEN builder gets the findings `checkAbapSource`
       * gives it and nothing else - the other rules are written for the
       * current dialect. Answering "nothing to check" here while CI reported
       * `frozen-view-builder` was an editor/CI divergence. The one rule that
       * still reads such a class is `obsolete-custom-control`: the old
       * builder's `_z2ui5( )->timer( )` & co. are method names, and a Timer
       * stays obsolete on the frozen builder too. */
      const frozen = FROZEN_FACTORY_RES.find((f) => f.re.test(text));
      if (frozen) {
        const at = text.search(frozen.re);
        return {
          findings: settled([
            { type: "frozen-view-builder", value: frozen.name, offset: at < 0 ? 0 : at },
            ...obsoleteCcHelperFindings(text),
          ]),
          renderable: false,
          helperNote: "",
        };
      }
      return {
        findings: [],
        renderable: false,
        helperNote: "",
        nothingChecked: "no z2ui5_cl_ui5_view_builder=>factory call found",
      };
    }
    /* No early exit for a class that reconstructs no view. `checkAbapSource`
     * has none either: the ABAP-side rules run over the class regardless -
     * and a class that builds a view it never displays is exactly what
     * `view-never-displayed` and the flow rules are for. Leaving here with
     * "nothing to check" kept such a class clean in the editor and red in
     * CI; whether the answer is "nothing checked" is decided at the end,
     * from the findings. */
    noView = prep.nodes.length === 0;
    const controlIds: Record<string, string> = {};
    const enumFields = new Map<string, Set<string>>();
    /* The same collection, one predicate over: fields bound to a boolean
     * property whose own default is `true`. Two maps rather than one, because
     * the two defects are judged differently - an unseeded ENUM field is
     * wrong on its own, an unseeded BOOLEAN one only where the seed is
     * inconsistent (absent-boolean-overrides-default, which never fired in
     * the editor while this map was not passed). */
    const boolFields = new Map<string, Set<string>>();
    // Which `name>` prefixes a binding may use: the class itself is the only
    // place that can widen the framework's three (SET_ODATA_MODEL). `null`
    // means "widened non-literally", which silences unknown-model rather than
    // guessing - passing nothing at all silenced it just the same, and that
    // is not the same statement.
    const models = namedModels(text);
    /* `cs_event-bind_element` sets a binding context on a whole view slot at
     * RUNTIME, so a relative path under it resolves against a row the document
     * never names. No static walk can see that, so the rules that ask "is
     * there a context here" have to be told - and told per DOCUMENT, because
     * the wire binds one slot and a document knows the slot it is displayed
     * into.
     *
     * Without it this gate is STRICTER than the CLI: it reports
     * relative-binding-without-context on a path the linter accepts, which is
     * a false positive in the editor. The parity fixture "a relative path
     * under an element-bound slot" is what measures that. */
    const bound = elementBoundSlots(text);
    for (const node of prep.nodes) {
      /* Per DOCUMENT, not per class: the wire binds ONE slot, and a document
       * knows the slot it is displayed into. A document with no consumer in
       * its own statement has no slot to compare and keeps the class-wide
       * answer rather than being judged on a guess. */
      const boundElement =
        bound.all ||
        (bound.slots.size > 0 &&
          (!node.displaySlot || bound.slots.has(node.displaySlot)));
      // the model derived from the class is what makes the binding-path
      // rules possible - a path nothing in the model has stays silently
      // empty at runtime, and without passing it those rules never run
      findings.push(
        ...checkNodes(node, {
          data,
          minUi5,
          allow,
          distribution,
          model: prep.model,
          shape: prep.modelShape,
          rootFields: prep.rootFields,
          // what the class writes into its own fields - the second author of
          // every two-way-bound string (picker-value-without-format)
          rootWrites: prep.rootWrites,
          models,
          // json-bind-on-scalar-property needs the paths a JSON seed wrote,
          // and both raw-javascript-to-frontend rules only judge a value as
          // ABAP-authored when the caller says the source was ABAP.
          jsonPaths: prep.jsonPaths,
          boundElement,
          fromAbap: true,
        })
      );
      Object.assign(controlIds, collectControlIds(node));
      // the enum-typed fields a bound aggregation exposes, by table: a row
      // appended without setting one reaches UI5 as '' and fails its strict
      // validation, which takes the binding update - and the view - down
      mergeFields(enumFields, collectEnumBoundFields(node, data));
      mergeFields(boolFields, collectEnumBoundFields(node, data, DEFAULT_TRUE_BOOLEAN));
    }
    // the stand-down checkAbapSource applies right here, before the
    // structural and class-level findings join (see the function)
    const namespaces = standDownUnusedNamespaces(findings, text, prep);
    findings.splice(0, findings.length, ...namespaces.findings);
    stoodDown.push(...namespaces.stoodDown);
    // Structural defects of the builder chain itself - an excess shut( )
    // asserts at RUNTIME, so this is the loudest thing the gate can find and
    // it was the one part of the pipeline this module never copied.
    findings.push(...(prep.structure ?? []));
    // rules that need the class itself, not just the view tree - the id map
    // and the snapshot let the CONTROL_BY_ID rules judge wire types.
    // `rules` has to go in HERE, not only into applyRules below: an OPT-IN
    // rule (chain-house-layout) is not produced at all unless the config asks
    // for it, so leaving it out kept the editor silent about a rule the
    // repository's own `abap2ui5lint.jsonc` switches on - and CI reported it.
    // That is exactly the editor/CI divergence this gate exists to close.
    findings.push(
      ...checkAbapRules(text, {
        data,
        controlIds,
        enumFields,
        boolFields,
        rules: options.rules,
        // the ABAP-side icon check judges against the target release; without
        // it every repo was judged against the 1.71 default, so a higher floor
        // reported icons in the editor that CI called fine
        minUi5,
        // the cross-file facts CI's checkFiles judges with (see GateOptions);
        // spread in, because the pinned typings may not name the option yet
        ...(options.classIndex ? { classIndex: options.classIndex } : {}),
      } as Parameters<typeof checkAbapRules>[1])
    );
    // a stand-down that depends on the other classes leaves a waiver of the
    // two public-attribute rules unjudged (a linter release after 0.8.5)
    if (LINTER_PUBLIC_READ_FROM_OUTSIDE?.(text, options.classIndex ?? null)) {
      stoodDown.push("unused-public-attribute", "unbound-public-attribute");
    }
    /* Every fix the pipeline attaches, in the linter's one call: the
     * undeclared-namespace declaration, the `json = abap_true` deletion and
     * the did-you-mean rewrites. Calling only the first of the three meant
     * `--fix` corrected what the lightbulb, "fix all", the Autofix lens and
     * the workspace fix could not. */
    attachSourceFixes(findings, text);
    renderable = prep.docs.length > 0 && prep.helperTokens === 0;
    if (prep.helperTokens > 0) {
      helperNote = " (render gate skipped - view built in helper methods)";
    }
  }

  // severity, wording and the line/column behind each recorded offset - the
  // directives are keyed by line, so annotation has to happen before they
  // are applied; both live in `settled`
  const out = settled(findings, stoodDown);
  if (noView) {
    // usesBuilder matched, but nothing was reconstructable: the ABAP-side
    // rules had their say above, the view rules had nothing to look at. With
    // no finding either, saying "passed" would claim a validation that never
    // happened - so it is "nothing checked", exactly as before.
    if (out.length === 0) {
      return { findings: out, renderable: false, helperNote: "", nothingChecked: NO_VIEW };
    }
    return { findings: out, renderable: false, helperNote: ` (${NO_VIEW})` };
  }
  return { findings: out, renderable, helperNote };
}
