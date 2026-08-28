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
  parseXml,
  PropertyFinding,
} from "@abap2ui5/linter/properties";
import { checkIcons } from "@abap2ui5/linter/icons";
import {
  annotate,
  applyDirectives,
  applyRules,
  attachNamespaceFixes,
} from "@abap2ui5/linter/findings";
import { snapshot } from "./snapshot";
import type { CheckOptions } from "./lintconfig";

export const VIEW_XML_RE = /\.(view|fragment)\.xml$/i;

export interface GateResult {
  findings: PropertyFinding[];
  /** True when the source is one the render gate could load as a whole. */
  renderable: boolean;
  /** Set when nothing was validated - the caller must not claim a pass. */
  nothingChecked?: string;
  helperNote: string;
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
  options: CheckOptions
): GateResult {
  const { minUi5, distribution, allow } = options;
  const data = snapshot();
  let findings: PropertyFinding[] = [];
  let renderable = true;
  let helperNote = "";

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
  } else {
    const prep = prepareAbap(text);
    if (!prep.usesBuilder) {
      return {
        findings: [],
        renderable: false,
        helperNote: "",
        nothingChecked: "no z2ui5_cl_ui5_view_builder=>factory call found",
      };
    }
    if (prep.nodes.length === 0) {
      // usesBuilder matched, but nothing was reconstructable - saying
      // "passed" here would claim a validation that never happened
      return {
        findings: [],
        renderable: false,
        helperNote: "",
        nothingChecked: "builder call found but no view could be reconstructed",
      };
    }
    const controlIds: Record<string, string> = {};
    const enumFields = new Map<string, Set<string>>();
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
      for (const [table, fields] of collectEnumBoundFields(node, data)) {
        const known = enumFields.get(table) ?? new Set<string>();
        for (const field of fields) {
          known.add(field);
        }
        enumFields.set(table, known);
      }
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
        rules: options.rules,
        // the ABAP-side icon check judges against the target release; without
        // it every repo was judged against the 1.71 default, so a higher floor
        // reported icons in the editor that CI called fine
        minUi5,
      })
    );
    attachNamespaceFixes(findings, text);
    renderable = prep.docs.length > 0 && prep.helperTokens === 0;
    if (prep.helperTokens > 0) {
      helperNote = " (render gate skipped - view built in helper methods)";
    }
  }

  // severity, wording and the line/column behind each recorded offset - the
  // directives are keyed by line, so this has to happen before they are
  // applied
  annotate(findings, text);
  findings = applyRules(findings, options.rules, fileName);
  findings = applyDirectives(findings, text);
  return { findings, renderable, helperNote };
}
