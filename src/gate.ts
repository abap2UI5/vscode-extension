/*
 * The in-process property gate - every rule that runs without I/O, extracted
 * from `viewcheck.ts` so both bundles share it: the desktop build wraps it
 * in the full checker (repo config, render gate, workspace sweep), the web
 * build runs exactly this and nothing more.
 *
 * `vscode`-free by design; the linter modules it calls are pure too (the
 * snapshot is handed in by `snapshot.ts`).
 */

import {
  checkAbapRules,
  elementBoundSlots,
  namedModels,
} from "@abap2ui5/linter/abap-rules";
import { prepareAbap } from "@abap2ui5/linter/reconstruct";
import {
  checkNodes,
  collectControlIds,
  collectEnumBoundFields,
  DEFAULT_TRUE_BOOLEAN,
  parseXml,
  PropertyFinding,
} from "@abap2ui5/linter/properties";
import { checkIcons } from "@abap2ui5/linter/icons";
import {
  annotate,
  applyDirectives,
  applyRules,
  attachSourceFixes,
  attachSuggestionFixes,
} from "@abap2ui5/linter/findings";
import { snapshot } from "./snapshot";
import type { CheckOptions } from "./lintconfig";

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

  // the linter's `settle`, plus the config-relative spelling of the file for
  // `rules.*.exclude` - see `configRelative`
  const settled = (raw: PropertyFinding[]): PropertyFinding[] => {
    annotate(raw, text);
    let out = applyRules(raw, options.rules, fileName);
    const rel = configRelative(fileName, options.configFile);
    if (rel !== undefined && rel !== fileName) {
      out = applyRules(out, options.rules, rel);
    }
    return applyDirectives(out, text);
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
      /* A class on a FROZEN builder gets the one finding `checkAbapSource`
       * gives it and nothing else - the other rules are written for the
       * current dialect. Answering "nothing to check" here while CI reported
       * `frozen-view-builder` was an editor/CI divergence. */
      const frozen = FROZEN_FACTORY_RES.find((f) => f.re.test(text));
      if (frozen) {
        const at = text.search(frozen.re);
        return {
          findings: settled([
            { type: "frozen-view-builder", value: frozen.name, offset: at < 0 ? 0 : at },
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
      })
    );
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
  const out = settled(findings);
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
