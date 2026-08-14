/*
 * The in-process property gate - every rule that runs without I/O, extracted
 * from `viewcheck.ts` so both bundles share it: the desktop build wraps it
 * in the full checker (repo config, render gate, workspace sweep), the web
 * build runs exactly this and nothing more.
 *
 * `vscode`-free by design; the linter modules it calls are pure too (the
 * snapshot is handed in by `snapshot.ts`).
 */

import { checkAbapRules } from "@abap2ui5/linter/abap-rules";
import { prepareAbap } from "@abap2ui5/linter/reconstruct";
import {
  checkNodes,
  collectControlIds,
  parseXml,
  PropertyFinding,
} from "@abap2ui5/linter/properties";
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
    for (const node of prep.nodes) {
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
        })
      );
      Object.assign(controlIds, collectControlIds(node));
    }
    // rules that need the class itself, not just the view tree - the id map
    // and the snapshot let the CONTROL_BY_ID rules judge wire types
    findings.push(...checkAbapRules(text, { data, controlIds }));
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
