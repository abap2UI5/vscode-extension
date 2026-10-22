/*
 * The in-process property gate - every rule that runs without I/O, extracted
 * from `viewcheck.ts` so both bundles share it: the desktop build wraps it
 * in the full checker (repo config, render gate, workspace sweep), the web
 * build runs exactly this and nothing more.
 *
 * `vscode`-free by design; the linter modules it calls are pure too (the
 * snapshot is handed in by `snapshot.ts`).
 */

import * as fs from "fs";
import { fileURLToPath } from "url";
import * as abapRules from "@abap2ui5/linter/abap-rules";
import {
  checkAbapRules,
  checkSourceRules,
  elementBoundSlots,
  namedModels,
  obsoleteCcHelperFindings,
} from "@abap2ui5/linter/abap-rules";
import { prepareAbap } from "@abap2ui5/linter/reconstruct";
import * as linterProperties from "@abap2ui5/linter/properties";
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
  isOptInEnabled,
} from "@abap2ui5/linter/findings";
import { matchLineEndings } from "@abap2ui5/linter/fix";
import {
  declaresApp,
  frozenBuilderOf as linterFrozenBuilderOf,
  sizeLimitRaised,
  standDownUnusedNamespaces,
  VIEWLESS_APP_RULE,
} from "@abap2ui5/linter/check";
import * as portable from "@abap2ui5/linter/portable";
import { snapshot } from "./snapshot";
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

/* The linter's own `declaresApp`, `VIEWLESS_APP_RULE`, `sizeLimitRaised`,
 * `standDownUnusedNamespaces` and `matchLineEndings` are called here as of
 * the 0.9.0 pin (`./check`, `./fix`). The gate used to carry ports of each
 * while the pinned release exported them from its main entry only - the one
 * the web host cannot bundle - and `gate.parity.test.ts` pinned the copies
 * to the linter's source. Re-exported, so the callers that read them through
 * this module (`checkcore.ts`, the parity tests) keep one import. */
export { declaresApp, matchLineEndings, sizeLimitRaised, standDownUnusedNamespaces, VIEWLESS_APP_RULE };

/** The linter's "another class reads this class's public attributes" test
 *  (from the release after 0.8.5 on): with it, `checkAbapSource` stands the
 *  two public-attribute rules down for the class, and a waiver of either is
 *  unjudged rather than unused. */
export const LINTER_PUBLIC_READ_FROM_OUTSIDE = linterExport<
  (source: string, classIndex?: ReadonlyMap<string, unknown> | null) => boolean
>(abapRules, "publicReadFromOutside");

/** The linter's `collectContainerPages` (`./properties`, from the release
 *  after 0.8.5 on): the page ids each container control of a document holds.
 *  `checkAbapSource` hands them to `checkAbapRules` as `containerPages`, and
 *  `navigation-lost-on-rebuild` judges a bound field holding one of a
 *  container's page ids with it. Undefined at the pin, whose `checkAbapRules`
 *  takes no such input. */
export const LINTER_COLLECT_CONTAINER_PAGES = linterExport<
  (root: unknown) => Record<string, string[]>
>(linterProperties, "collectContainerPages");

/** The linter's `./portable` module - the opt-in `portable-app` rule. The
 *  0.8.5 pin exported no such subpath, and the gate reached for it through
 *  a `require` inside a try; from 0.9.0 on it is a plain import. Exported
 *  under the name the parity tests know. */
export const LINTER_PORTABLE = portable;
type PortableModule = typeof portable;

/** The vendored portable profile, read on first use - a port of
 *  `portableProfileOf` in the linter's `lib/index.mjs`, with the same path
 *  (`PORTABLE_PROFILE_URL`: `data/portable-v1.json` beside the bundle's
 *  parent, where `esbuild.js` copies it - the web host seeds the `fs` shim
 *  there, `web/linterdata.ts`). Undefined when it cannot be read. */
let portableProfile: unknown;
function portableProfileOf(mod: PortableModule): unknown {
  if (portableProfile === undefined) {
    try {
      portableProfile = JSON.parse(
        fs.readFileSync(fileURLToPath(mod.PORTABLE_PROFILE_URL), "utf8")
      ) as unknown;
    } catch {
      return undefined;
    }
  }
  return portableProfile;
}

/** The opt-in `portable-app` findings for one source - the linter's
 *  `portableFindings`: none unless the `rules` block switches the rule on,
 *  none on a release without the rule. */
function portableFindings(
  rules: Record<string, unknown> | undefined,
  args: { nodes: unknown[]; source: string; abap?: boolean; data?: unknown }
): PropertyFinding[] {
  const mod = LINTER_PORTABLE;
  if (!isOptInEnabled(rules ?? null, mod.PORTABLE_RULE)) {
    return [];
  }
  const profile = portableProfileOf(mod);
  return profile === undefined
    ? []
    : mod.checkPortable({ ...args, profile } as Parameters<typeof mod.checkPortable>[0]);
}

export const VIEW_XML_RE = /\.(view|fragment)\.xml$/i;

/** The frozen builder a source builds its view with, or undefined - the
 *  linter's `frozenBuilderOf` (`./check`, null for none), in the shape the
 *  callers here compare against. */
export function frozenBuilderOf(text: string): string | undefined {
  return linterFrozenBuilderOf(text) ?? undefined;
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

/** The notes behind "view check passed for …" when part of the pipeline did
 *  not apply - said, so a pass does not claim more than was judged. */
const APP_WITHOUT_VIEW = " (app class building no view here - judged by its class rules)";
const SOURCE_RULES_ONLY = " (no view - judged by the source rules, allClasses)";
const PROPERTIES_OFF = " (property gate off - properties: false)";

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
  /* The config's `properties: false` switches the PROPERTY GATE off - the
   * walk over the view tree against the metadata snapshot - and nothing
   * else: the ABAP-side rules run either way, handed `data: null` as the
   * linter's checkAbapSource hands them. The gate used to run the walk
   * regardless, so a repository that switched it off saw its findings in the
   * editor and never in CI. */
  const walk = options.properties !== false;
  const data = walk ? snapshot() : null;
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
     * still saw it in the editor), which rules ran (with the property gate
     * off - `properties: false`, or no snapshot - the walk did not, and a
     * waiver of one of its rules is unjudged, not unused) and which stood
     * down on this source. */
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
    if (!walk) {
      /* checkXmlSource runs nothing at all over a raw view with the property
       * gate off - not the icon scan, not the directives. */
      return { findings: [], renderable: true, helperNote: PROPERTIES_OFF };
    }
    findings.push(
      ...checkNodes(parseXml(text), { data, minUi5, allow, distribution })
    );
    /* The icon scan is a TEXT scan, not a walk of the tree - an icon name
     * travels as data (a bound column, a constant) as often as it travels as
     * an attribute. `checkXmlSource` runs it here and this gate could not:
     * `checkIcons` had no subpath export, so the editor judged a `.view.xml`
     * without the icon rules while CI judged it with them. `xml: true` is
     * the linter's too: the view's comments are blanked first, so an icon in
     * a commented-out control is not reported (the gate passed nothing and
     * reported it). */
    findings.push(...checkIcons(text, { minUi5, xml: true }));
    findings.push(
      ...portableFindings(options.rules, { nodes: [parseXml(text)], source: text, data })
    );
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
      const frozen = frozenBuilderOf(text);
      if (frozen) {
        // the offset `checkAbapSource` reports: the factory call itself
        const at = text.search(new RegExp(`\\b${frozen}\\s*=>\\s*factory`, "i"));
        return {
          findings: settled([
            { type: "frozen-view-builder", value: frozen, offset: at < 0 ? 0 : at },
            ...obsoleteCcHelperFindings(text),
          ]),
          renderable: false,
          helperNote: "",
        };
      }
      /* A class that builds no view. `checkAbapSource` judges it in two
       * cases, and the gate answered "nothing to check" in both while CI
       * reported findings: an APP class (its view comes from another class -
       * judged by the source-side rules and the ABAP rules that read the
       * class rather than a view, VIEWLESS_APP_RULE), and, under the
       * config's `allClasses`, any class (the source-side rules alone). */
      const app = declaresApp(text);
      if (app || options.allClasses) {
        const own: PropertyFinding[] = [...checkSourceRules(text)];
        if (app) {
          const seen = new Set(own.map((f) => `${f.type}@${f.offset}`));
          const classRules = checkAbapRules(text, {
            data: null,
            minUi5,
            rules: options.rules,
            ...(options.classIndex ? { classIndex: options.classIndex } : {}),
          } as Parameters<typeof checkAbapRules>[1]);
          for (const f of classRules) {
            if (VIEWLESS_APP_RULE.test(f.type) && !seen.has(`${f.type}@${f.offset}`)) {
              own.push(f);
            }
          }
          // the class half of the portable profile: actions, nested slots, wires
          own.push(...portableFindings(options.rules, { nodes: [], source: text, abap: true }));
        }
        attachSourceFixes(own, text);
        return {
          findings: settled(own),
          renderable: false,
          helperNote: app ? APP_WITHOUT_VIEW : SOURCE_RULES_ONLY,
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
    const containerPages: Record<string, string[]> = {};
    const enumFields = new Map<string, Set<string>>();
    /* The same collection, one predicate over: fields bound to a boolean
     * property whose own default is `true`. Two maps rather than one, because
     * the two defects are judged differently - an unseeded ENUM field is
     * wrong on its own, an unseeded BOOLEAN one only where the seed is
     * inconsistent (absent-boolean-overrides-default, which never fired in
     * the editor while this map was not passed). */
    const boolFields = new Map<string, Set<string>>();
    if (walk) {
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
      // whether the class ever raises a model's size limit (rows-hidden-by-visible)
      const raised = sizeLimitRaised(text);
      const start = prep;
      for (const [index, node] of prep.nodes.entries()) {
        /* A document the FIRST display shows is judged against the start-path
         * model (the linter's `initModel`): what an event handler assigns has
         * not run yet, and borrowing its value hid an enum bound to an
         * attribute that ships as "" on every start. */
        const onInit = Boolean(start.nodeOnInit?.[index] && start.initModel);
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
            model: onInit ? start.initModel : prep.model,
            shape: onInit ? start.initModelShape : prep.modelShape,
            // the fields the start path leaves initial, for a document the
            // first display shows (enum-bound-to-initial-field) - and whether
            // the class raises the size limit
            initialFields: onInit ? start.initialFields : null,
            sizeLimitRaised: raised,
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
          } as Parameters<typeof checkNodes>[1])
        );
      }
    }
    for (const node of prep.nodes) {
      Object.assign(controlIds, collectControlIds(node));
      if (LINTER_COLLECT_CONTAINER_PAGES) {
        Object.assign(containerPages, LINTER_COLLECT_CONTAINER_PAGES(node));
      }
      /* Both collections resolve a property's TYPE, so they say nothing
       * without the snapshot - with `properties: false` the two row rules
       * stay silent, as in the linter. */
      if (data) {
        // the enum-typed fields a bound aggregation exposes, by table: a row
        // appended without setting one reaches UI5 as '' and fails its strict
        // validation, which takes the binding update - and the view - down
        mergeFields(enumFields, collectEnumBoundFields(node, data));
        mergeFields(boolFields, collectEnumBoundFields(node, data, DEFAULT_TRUE_BOOLEAN));
      }
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
        // the cross-file facts CI's checkFiles judges with (see GateOptions),
        // and the container pages navigation-lost-on-rebuild reads - spread
        // in, because the pinned typings name neither option yet
        ...(LINTER_COLLECT_CONTAINER_PAGES ? { containerPages } : {}),
        ...(options.classIndex ? { classIndex: options.classIndex } : {}),
      } as Parameters<typeof checkAbapRules>[1])
    );
    // a stand-down that depends on the other classes leaves a waiver of the
    // two public-attribute rules unjudged (a linter release after 0.8.5)
    if (LINTER_PUBLIC_READ_FROM_OUTSIDE?.(text, options.classIndex ?? null)) {
      stoodDown.push("unused-public-attribute", "unbound-public-attribute");
    }
    // the opt-in portable profile, documents and class together
    findings.push(
      ...portableFindings(options.rules, { nodes: prep.nodes, source: text, abap: true, data })
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
    if (!walk) {
      helperNote += PROPERTIES_OFF;
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
