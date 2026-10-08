/*
 * "Add Agent Setup to Workspace" - what it writes, decided without writing.
 *
 * abap2UI5/app-template's `template.json` carries an `agentSetup` key: the
 * part of the template that makes a repository ready for an AI agent
 * (AGENTS.md, CLAUDE.md, the four skills, the MCP server, the permission
 * allowlist), the two gates the setup tells the agent to run and the CI job
 * that runs them - for the project that did NOT start from the template,
 * which is most abap2UI5 projects. The template's create package executes it
 * as `npm create abap2ui5-app@latest -- --agent-setup`; this module executes
 * the same key over the open workspace folder, from the extension's snapshot
 * (`src/data/app-template.json`), so it needs no network and works in the web
 * host as well.
 *
 * A PORT, not a re-design: every function below mirrors one of
 * app-template's `create/agent-setup.mjs`, with the same rules -
 *
 *   a file the project has is NEVER overwritten. It is skipped and named; a
 *   second run over a finished setup changes nothing.
 *
 *   the files under `agentSetup.merge` (package.json, .gitignore) only ever
 *   GAIN entries. An entry the project has keeps its value, and every one
 *   kept on a value that differs from the template's is named.
 *
 *   src/ is the template's folder, not necessarily the project's. The
 *   project's `.abapgit.xml` says where its classes are (STARTING_FOLDER),
 *   and the files `agentSetup.sourceFolder` names are pointed there.
 *
 * Which files, which are merged and which text names the source folder is
 * all the snapshot's - nothing is listed here. The one difference from the
 * create package is where the bytes come from and go to: the workspace is
 * read through a `WorkspaceProbe` (the caller's `vscode.workspace.fs`, a
 * test's in-memory folder), so this module needs neither `vscode` nor `fs`
 * nor `path` and is safe in the web bundle.
 *
 * Two additions the create package does not need: nothing is ever planned
 * INTO the project's source folder (no `agentSetup` file lives under one
 * today; this keeps it that way should the folder be named like one of
 * them), and the pin check is answered from the text rather than by
 * importing the project's `scripts/check-pin.mjs` - an extension must not
 * execute a workspace's code, and the web host could not.
 */

import { TEMPLATE_FILES, TEMPLATE_SPEC } from "./scaffold";

/** The `agentSetup` key of app-template's template.json. */
export interface AgentSetupSpec {
  files: Record<string, string>;
  leftOut?: Record<string, string>;
  merge?: Record<string, { how: string; keys?: string[] }>;
  sourceFolder?: {
    placeholder: string;
    edits: { file: string; text: string }[];
  };
  existingVariants?: { files: Record<string, string[]> };
}

/** The snapshot's agentSetup, or undefined when the snapshot predates it. */
export const AGENT_SETUP: AgentSetupSpec | undefined = (
  TEMPLATE_SPEC as { agentSetup?: AgentSetupSpec }
).agentSetup;

/** What the plan needs from the workspace folder. Paths are relative,
 *  `/`-separated. `readText` is only called for a path `exists` said yes to. */
export interface WorkspaceProbe {
  exists(rel: string): Promise<boolean>;
  readText(rel: string): Promise<string>;
  /** Whether `rel` ITSELF is a symbolic link (not what it points at). A
   *  probe of a file system without links (the web host's virtual folders,
   *  a test's map) may leave it out. */
  isLink?(rel: string): Promise<boolean>;
}

export type AgentSetupAction =
  | { path: string; kind: "add"; text: string; detail: string }
  | { path: string; kind: "merge"; text: string; detail: string; added: string[] }
  | { path: string; kind: "skip"; detail: string };

export interface AgentSetupPlan {
  /** Where the gates are pointed, relative to the workspace folder. */
  folder: string;
  /** How `folder` was decided. */
  from: string;
  actions: AgentSetupAction[];
  warnings: string[];
}

/** `<STARTING_FOLDER>/abap/src/</STARTING_FOLDER>` -> `abap/src`; '' for the
 *  repository root; null when the file says nothing. */
export function startingFolder(abapgitXml: string | undefined): string | null {
  const m = /<STARTING_FOLDER>([^<]*)<\/STARTING_FOLDER>/.exec(abapgitXml ?? "");
  if (!m) {
    return null;
  }
  return m[1].trim().replace(/^\/+|\/+$/g, "");
}

/** One file's text with the template's source folder replaced by the
 *  project's, at the places `sourceFolder` names - inside the first
 *  occurrence of each `text` only. Unchanged when the folder is the
 *  template's own, or when no edit names the file. */
export function adaptSourceFolder(
  rel: string,
  text: string,
  sourceFolder: AgentSetupSpec["sourceFolder"],
  folder: string
): string {
  if (!sourceFolder || folder === sourceFolder.placeholder) {
    return text;
  }
  let out = text;
  for (const edit of sourceFolder.edits) {
    if (edit.file !== rel) {
      continue;
    }
    const at = out.indexOf(edit.text);
    if (at === -1) {
      continue;
    }
    const replaced = edit.text.replace(sourceFolder.placeholder, folder);
    out = out.slice(0, at) + replaced + out.slice(at + edit.text.length);
  }
  return out;
}

/** The indentation a JSON file is written with, so a merge does not reformat
 *  somebody's package.json from four spaces to two. */
function indentOf(text: string): string {
  return /^([ \t]+)"/m.exec(text)?.[1] ?? "  ";
}

const stripBom = (text: string): string => text.replace(/^﻿/, "");

export interface KeptEntry {
  entry: string;
  have: unknown;
  want: unknown;
}

/** A package.json that parses but is not an object - a different fix than
 *  a syntax error, so a different message. */
export class PackageJsonShapeError extends Error {}

/**
 * package.json, merged: every entry under `keys` the project lacks is added,
 * every entry it has keeps its value. Returns the new text (null when nothing
 * was added), what was added, and what was kept on a value that differs from
 * the template's. Throws when the project's package.json is not JSON, and a
 * `PackageJsonShapeError` when it is JSON but not an object.
 */
export function mergePackageJson(
  existingText: string,
  templateText: string,
  keys: readonly string[]
): { text: string | null; added: string[]; kept: KeptEntry[] } {
  const tpl = JSON.parse(stripBom(templateText)) as Record<string, unknown>;
  const parsed: unknown = JSON.parse(stripBom(existingText));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    // Valid JSON, just not a manifest. Merged anyway, `null` threw a
    // TypeError that the caller reported as "not valid JSON", and an array
    // took the entries as properties that JSON.stringify then dropped - the
    // plan announced additions to a file it would write back unchanged.
    throw new PackageJsonShapeError(
      `its top level is ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : `a ${typeof parsed}`}, not an object`
    );
  }
  const pkg = parsed as Record<string, unknown>;
  const section = (key: string): Record<string, unknown> | undefined => {
    const value = pkg[key];
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  };
  const added: string[] = [];
  const kept: KeptEntry[] = [];
  for (const key of keys) {
    const want = tpl[key];
    if (!want || typeof want !== "object") {
      continue;
    }
    for (const [name, value] of Object.entries(want as Record<string, unknown>)) {
      // a gate the project already depends on at runtime is a gate it has
      const have =
        section(key)?.[name] ??
        (key === "devDependencies" ? section("dependencies")?.[name] : undefined);
      if (have === undefined) {
        pkg[key] = { ...(section(key) ?? {}), [name]: value };
        added.push(`${key}.${name}`);
      } else if (have !== value) {
        kept.push({ entry: `${key}.${name}`, have, want: value });
      }
    }
  }
  if (!added.length) {
    return { text: null, added, kept };
  }
  const eol = existingText.endsWith("\n") || !existingText.length ? "\n" : "";
  return {
    text: JSON.stringify(pkg, null, indentOf(existingText)) + eol,
    added,
    kept,
  };
}

/** `node_modules`, `/node_modules`, `node_modules/` - one pattern to a
 *  reader, three strings to a Set. */
const normalisePattern = (line: string): string => line.trim().replace(/^\/+|\/+$/g, "");

/**
 * .gitignore, merged: the template's patterns the project does not ignore yet
 * are appended, each block with the comment lines above it in the template.
 * Returns the new text (null when nothing was missing) and the patterns added.
 */
export function mergeLines(
  existingText: string,
  templateText: string
): { text: string | null; added: string[] } {
  const have = new Set(
    existingText
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith("#"))
      .map(normalisePattern)
  );
  const out: string[] = [];
  const added: string[] = [];
  let comments: string[] = [];
  let fresh = true; // the next pattern starts a block: a blank line above it, as in the template
  for (const line of templateText.split(/\r?\n/)) {
    if (!line.trim()) {
      comments = [];
      fresh = true;
      continue;
    }
    if (line.trim().startsWith("#")) {
      comments.push(line);
      continue;
    }
    if (have.has(normalisePattern(line))) {
      continue;
    }
    if (fresh && out.length) {
      out.push("");
    }
    out.push(...comments, line);
    comments = [];
    fresh = false;
    added.push(line.trim());
  }
  if (!added.length) {
    return { text: null, added };
  }
  let text = existingText;
  if (text.length && !text.endsWith("\n")) {
    text += "\n";
  }
  if (text.length) {
    text += "\n";
  }
  return { text: `${text}${out.join("\n")}\n`, added };
}

/** The npm package name a project without a package.json gets: its folder's,
 *  in the characters npm accepts. Takes the folder NAME - the caller knows it
 *  from the workspace folder, and this module stays free of `path`. */
export function packageNameFor(folderName: string): string {
  return (
    folderName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[._-]+/, "") || "abap2ui5-app"
  );
}

/** Where the project's classes are, and how that was decided, from the text
 *  of its `.abapgit.xml` (undefined when it has none). */
export function sourceFolderOf(
  abapgitXml: string | undefined,
  placeholder: string
): { folder: string; from: string } {
  if (abapgitXml === undefined) {
    return { folder: placeholder, from: `no .abapgit.xml - assuming ${placeholder}/` };
  }
  const folder = startingFolder(abapgitXml);
  if (folder === null) {
    return {
      folder: placeholder,
      from: `.abapgit.xml names no STARTING_FOLDER - assuming ${placeholder}/`,
    };
  }
  return { folder, from: ".abapgit.xml STARTING_FOLDER" };
}

/**
 * The first component of `rel` - `.claude`, then `.claude/settings.json` -
 * that is a symbolic link, or undefined. A write through one lands wherever
 * it points: a cloned repository carrying `.claude -> ~/.claude` would have
 * the template's permission allowlist written into the user's GLOBAL Claude
 * Code settings, every project's. `exists` follows links, so it cannot tell.
 */
async function linkOnTheWay(probe: WorkspaceProbe, rel: string): Promise<string | undefined> {
  if (!probe.isLink) {
    return undefined;
  }
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    if (await probe.isLink(prefix)) {
      return prefix;
    }
  }
  return undefined;
}

/** Whether `rel` lies inside `folder` (both workspace-relative). */
function inside(rel: string, folder: string): boolean {
  const f = folder.replace(/\/+$/, "");
  return f !== "" && (rel === f || rel.startsWith(`${f}/`));
}

/**
 * The whole agent setup for one workspace folder, decided and not written:
 * one action per file - `add` (text to write), `merge` (text to write over
 * the project's, with what was added), `skip` (the project has it, or has
 * everything the merge would add) - plus the warnings to show.
 *
 * `templateFiles` is the snapshot's file map (the template's files as text),
 * `folderName` the workspace folder's name (a project without a package.json
 * gets it as its npm name).
 */
export async function planAgentSetup(
  setup: AgentSetupSpec,
  templateFiles: Record<string, string>,
  probe: WorkspaceProbe,
  folderName: string
): Promise<AgentSetupPlan> {
  const placeholder = setup.sourceFolder?.placeholder ?? "src";
  const warnings: string[] = [];
  const abapgitXml = (await probe.exists(".abapgit.xml"))
    ? await probe.readText(".abapgit.xml")
    : undefined;
  const decided = sourceFolderOf(abapgitXml, placeholder);
  let folder = decided.folder;
  const from = decided.from;
  if (folder === "") {
    warnings.push(
      `.abapgit.xml's STARTING_FOLDER is the repository root - the gates were left pointing at ${placeholder}/; ` +
        "set abaplint.jsonc's global.files and abap2ui5lint.jsonc's paths to your classes by hand"
    );
    folder = placeholder;
  }
  if (!(await probe.exists(folder))) {
    warnings.push(
      `${folder}/ does not exist - the gates are configured for it and will find no classes there`
    );
  }

  const actions: AgentSetupAction[] = [];
  for (const rel of Object.keys(setup.files)) {
    if (inside(rel, folder)) {
      actions.push({
        path: rel,
        kind: "skip",
        detail: `inside the source folder ${folder}/ - never written`,
      });
      continue;
    }
    const link = await linkOnTheWay(probe, rel);
    if (link) {
      actions.push({
        path: rel,
        kind: "skip",
        detail: `${link} is a symbolic link - never written through one`,
      });
      continue;
    }
    const exists = await probe.exists(rel);
    const merge = setup.merge?.[rel];
    if (exists && !merge) {
      actions.push({ path: rel, kind: "skip", detail: "already there - left as it is" });
      continue;
    }
    const template = templateFiles[rel];
    if (template === undefined) {
      throw new Error(
        `the extension's app-template snapshot has no ${rel}, which its agentSetup lists - the snapshot is inconsistent`
      );
    }
    const adapted = adaptSourceFolder(rel, template, setup.sourceFolder, folder);
    const folderNote = adapted !== template ? `sources: ${folder}/` : "";

    if (!exists && merge?.how === "json") {
      // A project without a package.json gets the entries a merge would add,
      // under its own name - not the template's file, whose license and
      // description are the template's to declare, not this project's.
      const base = `${JSON.stringify({ name: packageNameFor(folderName), private: true }, null, 2)}\n`;
      const result = mergePackageJson(base, adapted, merge.keys ?? []);
      actions.push({ path: rel, kind: "add", text: result.text ?? base, detail: folderNote });
      continue;
    }
    if (!exists) {
      actions.push({ path: rel, kind: "add", text: adapted, detail: folderNote });
      continue;
    }

    const existing = await probe.readText(rel);
    if (merge?.how === "json") {
      const keys = merge.keys ?? [];
      let result: ReturnType<typeof mergePackageJson>;
      try {
        result = mergePackageJson(existing, adapted, keys);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(
          err instanceof PackageJsonShapeError
            ? `${rel} is not a package manifest (${why}) - fix it, or move it aside and run again`
            : `${rel} is not valid JSON (${why}) - fix it, or move it aside and run again`
        );
      }
      for (const k of result.kept) {
        warnings.push(
          `${rel}: kept your ${k.entry} ${JSON.stringify(k.have)} - the template has ${JSON.stringify(k.want)}`
        );
      }
      if (!result.text) {
        actions.push({
          path: rel,
          kind: "skip",
          detail: `already has every entry of ${keys.join(", ")}`,
        });
      } else {
        const counts = keys
          .map((key) => [key, result.added.filter((a) => a.startsWith(`${key}.`)).length] as const)
          .filter(([, n]) => n)
          .map(([key, n]) => `+${n} ${key}`);
        actions.push({
          path: rel,
          kind: "merge",
          text: result.text,
          detail: counts.join(", "),
          added: result.added,
        });
      }
    } else if (merge?.how === "lines") {
      const result = mergeLines(existing, adapted);
      if (!result.text) {
        actions.push({
          path: rel,
          kind: "skip",
          detail: "already ignores everything the template does",
        });
      } else {
        actions.push({
          path: rel,
          kind: "merge",
          text: result.text,
          detail: `+ ${result.added.join(" ")}`,
          added: result.added,
        });
      }
    } else {
      throw new Error(
        `the app-template snapshot's agentSetup.merge asks for "${merge?.how}" on ${rel}, which this version of the extension cannot do - update it`
      );
    }
  }

  for (const [rel, variants] of Object.entries(setup.existingVariants?.files ?? {})) {
    for (const v of variants) {
      if (
        actions.find((a) => a.path === rel)?.kind === "add" &&
        (await probe.exists(v))
      ) {
        warnings.push(
          `this project has ${v}, and now ${rel} as well - \`npm run check:abap\` and the pin check read ${rel}; ` +
            `move your rules into it and delete ${v}, or keep both on purpose`
        );
      }
    }
  }

  const pin = await pinWarning(setup, templateFiles, probe, actions);
  if (pin) {
    warnings.push(pin);
  }
  return { folder, from, actions, warnings };
}

/** The pin `scripts/check-pin.mjs` requires: abaplint.jsonc's `"branch"` as a
 *  release tag - the first of its `SITES`, the one that is not optional. */
const PIN_SITE = /"branch":\s*"(\d+\.\d+\.\d+)"/;

/**
 * The offline half of `npm run check:pin` that a setup can break: a project
 * that KEPT its own abaplint.jsonc usually pins no framework release there,
 * and check.yml's first step would fail on its first push. The create
 * package answers this by importing the project's check-pin.mjs (when it is
 * the template's); this reads the one required site from the text instead -
 * see the header. Undefined when there is nothing to say: the template's
 * abaplint.jsonc is being added (it carries the pin), or check-pin.mjs is
 * neither being added nor the template's (somebody else's check).
 */
async function pinWarning(
  setup: AgentSetupSpec,
  templateFiles: Record<string, string>,
  probe: WorkspaceProbe,
  actions: AgentSetupAction[]
): Promise<string | undefined> {
  const CHECK_PIN = "scripts/check-pin.mjs";
  const CONFIG = "abaplint.jsonc";
  if (!setup.files[CHECK_PIN] || !setup.files[CONFIG]) {
    return undefined;
  }
  const kind = (rel: string) => actions.find((a) => a.path === rel)?.kind;
  const templatePin = kind(CHECK_PIN) === "add"
    || (await probe.exists(CHECK_PIN) && (await probe.readText(CHECK_PIN)) === templateFiles[CHECK_PIN]);
  if (!templatePin || kind(CONFIG) === "add" || !(await probe.exists(CONFIG))) {
    return undefined;
  }
  if (PIN_SITE.test(await probe.readText(CONFIG))) {
    return undefined;
  }
  // whose check:pin check.yml runs: the template's, or one the project kept
  const scriptOf = (text: string | undefined): unknown => {
    try {
      return (JSON.parse(stripBom(text ?? "")) as { scripts?: Record<string, unknown> })
        .scripts?.["check:pin"];
    } catch {
      return undefined;
    }
  };
  const pkg = actions.find((a) => a.path === "package.json");
  const pkgText =
    pkg && pkg.kind !== "skip"
      ? pkg.text
      : (await probe.exists("package.json"))
        ? await probe.readText("package.json")
        : undefined;
  const owns = scriptOf(pkgText) === scriptOf(templateFiles["package.json"]);
  const who = owns
    ? "`npm run check:pin` (the first step of check.yml) and `npm run doctor` would fail as things stand:"
    : "`npm run doctor` would report the framework pin as FAIL (your own check:pin script is not affected):";
  return (
    `${who} your ${CONFIG} pins no framework release. ` +
    `abaplint.jsonc's "branch" is the framework pin - a release tag such as "1.145.0", not a branch - and ` +
    "every other place that names a release has to agree with it; scripts/check-pin.mjs lists the places"
  );
}

/** The plan with the snapshot's own spec and files - what the command runs. */
export function planFromSnapshot(
  probe: WorkspaceProbe,
  folderName: string
): Promise<AgentSetupPlan> {
  if (!AGENT_SETUP?.files) {
    return Promise.reject(
      new Error("the extension's app-template snapshot has no agentSetup - it predates the agent setup")
    );
  }
  return planAgentSetup(AGENT_SETUP, TEMPLATE_FILES, probe, folderName);
}

/** The actions that write something. */
export function writesOf(plan: AgentSetupPlan): Exclude<AgentSetupAction, { kind: "skip" }>[] {
  return plan.actions.filter(
    (a): a is Exclude<AgentSetupAction, { kind: "skip" }> => a.kind !== "skip"
  );
}

/** Two plans write the same bytes to the same places - the command re-plans
 *  after the confirmation and refuses to write when the folder moved. */
export function samePlan(a: AgentSetupPlan, b: AgentSetupPlan): boolean {
  const key = (p: AgentSetupPlan) =>
    JSON.stringify(p.actions.map((x) => [x.path, x.kind, x.kind === "skip" ? "" : x.text]));
  return key(a) === key(b);
}

const VERB = { add: "added", merge: "merged", skip: "skipped" } as const;
const WILL = { add: "add", merge: "merge", skip: "skip" } as const;

/** One line per file, aligned - `done` picks the past tense for the output
 *  channel, the future one for the confirmation. */
export function describeActions(plan: AgentSetupPlan, done: boolean): string[] {
  const width = Math.max(0, ...plan.actions.map((a) => a.path.length));
  const verbs = done ? VERB : WILL;
  const pad = Math.max(...Object.values(verbs).map((v) => v.length));
  return plan.actions.map((a) =>
    `${verbs[a.kind].padEnd(pad)}  ${a.detail ? `${a.path.padEnd(width)}  ${a.detail}` : a.path}`
  );
}

/** The confirmation's detail text: what will be written, what is left as it
 *  is, and the warnings - before anything is touched. */
export function confirmationDetail(plan: AgentSetupPlan): string {
  const writes = writesOf(plan);
  const skips = plan.actions.filter((a) => a.kind === "skip");
  const parts: string[] = [`Sources: ${plan.folder}/ (${plan.from})`];
  if (writes.length) {
    parts.push(
      `Will write ${writes.length}:\n` +
        writes
          .map((a) => `  ${a.kind === "merge" ? "merge" : "add"}  ${a.path}${a.detail ? ` (${a.detail})` : ""}`)
          .join("\n")
    );
  }
  if (skips.length) {
    parts.push(
      `Left as they are (${skips.length}):\n` +
        skips.map((a) => `  ${a.path} - ${a.detail}`).join("\n")
    );
  }
  if (plan.warnings.length) {
    parts.push(`Worth knowing:\n${plan.warnings.map((w) => `  - ${w}`).join("\n")}`);
  }
  parts.push("Nothing is overwritten; package.json and .gitignore only gain entries.");
  return parts.join("\n\n");
}

/** What to do after the setup was written - the create package's next steps,
 *  without its `cd`: the workspace folder is where the terminal opens. */
export function agentSetupNextSteps(folder: string, wroteAgents: boolean): string {
  const agents = wroteAgents
    ? `
AGENTS.md's first section ("This repository") describes a project made from
the template - zcl_app_001 in src/. Rewrite it for this one and keep
everything from "1. The model in one paragraph" down: that half is the
app-building reference, and it is the same for every abap2UI5 app.
`
    : "";
  return `
Next:

  npm install                     # both gates; writes package-lock.json - commit it, check.yml runs npm ci
  npx playwright install chromium # once - only the render gate needs a browser
  npm run check                   # abaplint + abap2UI5-linter over ${folder}/
  npm run doctor                  # when something above does not look right
${agents}
Only after the agent knowledge, without the gates? In Claude Code the
framework's plugin brings the four skills and the MCP server to any project:

  /plugin marketplace add abap2UI5/abap2UI5
  /plugin install abap2ui5@abap2ui5
`;
}

/** The whole report for the output channel, after writing. */
export function agentSetupReport(plan: AgentSetupPlan, folderLabel: string): string {
  const written = writesOf(plan).length;
  const skipped = plan.actions.length - written;
  const lines = [
    `abap2UI5 agent setup: ${folderLabel}`,
    "  template   the extension's snapshot of abap2UI5/app-template (agentSetup in template.json)",
    `  sources    ${plan.folder}/ (${plan.from})`,
    ...describeActions(plan, true).map((l) => `  ${l}`),
    `${written} written, ${skipped} skipped${written ? "" : " - the agent setup was already complete, nothing to do"}`,
  ];
  if (plan.warnings.length) {
    lines.push("", "Worth knowing:", ...plan.warnings.map((w) => `  - ${w}`));
  }
  const wroteAgents = plan.actions.some((a) => a.path === "AGENTS.md" && a.kind === "add");
  return `${lines.join("\n")}\n${agentSetupNextSteps(plan.folder, wroteAgents)}`;
}
