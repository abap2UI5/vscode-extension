#!/usr/bin/env node
/*
 * Builds src/data/app-template.json - the files "New Project from Template"
 * writes verbatim, taken from abap2UI5/app-template.
 *
 * Why a snapshot and not a clone: `abap2ui5.newProject` is registered in the
 * WEB entry too (src/web/extension.ts), where there is no git, no child
 * process and no guarantee of network - vscode.dev has to be able to scaffold
 * a project as well as a desktop window does. So the content ships inside the
 * bundle. The price of that is drift, and drift is exactly what happened: the
 * scaffold carried its own hand-written copy of app-template's configs, and by
 * the time anyone looked it was emitting `@abap2ui5/linter@^0.1.1` (the
 * ecosystem was on 0.2.1), no framework pin at all (so a scaffolded project
 * resolved the framework's moving default branch - the failure app-template's
 * config comment documents at length), no `chain-house-layout` rule and no
 * AGENTS.md whatsoever.
 *
 * So: one source, copied mechanically, and a test that fails when the copy
 * and what the scaffold emits stop agreeing.
 *
 *   node scripts/generate-app-template.mjs /path/to/app-template
 *   node scripts/generate-app-template.mjs           (fetches from GitHub main)
 *   node scripts/generate-app-template.mjs --check   (fail when the committed
 *                                                     JSON is stale - what the
 *                                                     weekly workflow runs)
 *
 * What this file proves and what it does not, stated once so nobody has to
 * guess: `--check` compares the committed snapshot against app-template's main
 * (or a local checkout). `src/test/scaffold.test.ts` compares the SCAFFOLD
 * against the committed snapshot. Together they close the loop; neither half
 * alone does, and the second half is the one that runs in this repository's CI
 * - the first runs weekly, because a repository's own build must not go red
 * the moment somebody edits a different repository.
 */
import path from "path";
import { fileURLToPath } from "url";
import {
  emitSnapshot,
  invokedDirectly,
  parseArgs,
  readUpstream,
  requireShape,
} from "./lib/snapshot.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// under src/ so tsc (rootDir: src, resolveJsonModule) can import it; esbuild
// inlines it into both bundles, so the web build needs no fs for it either
const OUT = path.join(ROOT, "src", "data", "app-template.json");
const REPO = "abap2UI5/app-template";
const RAW = (file) => `https://raw.githubusercontent.com/${REPO}/main/${file}`;

/*
 * WHICH files is not decided here either. app-template describes itself in
 * `template.json` - `files.shared` is every file a new project can take from
 * it UNCHANGED, and `files.named` / `files.templateOwn` are the ones that
 * carry a name or belong to the template. This snapshot takes `files.shared`,
 * because the named ones are exactly what `src/scaffold.ts` writes itself,
 * where the project name and the class name are known.
 *
 * Two of the shared files are here to be READ, not copied: the scaffold takes
 * the dependency versions and the shared scripts out of `package.json` and the
 * linter action's pin out of `.github/workflows/check.yml`, and writes its own
 * file around them. See src/scaffold.ts.
 *
 * The spec itself is snapshotted alongside the files: the scaffold needs the
 * list to know what to copy, and one list is the whole point.
 */
const SPEC_FILE = "template.json";

/** The one line the scaffold's own workflow shares with the template's. */
export function linterActionLine(workflow) {
  const m = /^\s*uses:\s*abap2UI5\/linter@.*$/m.exec(workflow);
  return m ? m[0].trim() : null;
}

/** The framework release app-template pins abaplint's clone to. */
export function frameworkPin(abaplintConfig) {
  const m = /"branch":\s*"([^"]+)"/.exec(abaplintConfig);
  return m ? m[1] : null;
}

/** Where the mirrored app-building guide starts inside AGENTS.md. */
export const GUIDE_MARKER = "> **Provenance:**";

const TOOL = "generate-app-template";

/**
 * The scripts a scaffolded project is left with - `scaffoldScripts` in
 * `src/scaffold.ts`, mirrored here because a .mjs generator cannot import the
 * bundle's TypeScript (the same arrangement `frameworkPin` already has).
 *
 * `src/scaffold.ts` drops every script whose body runs files out of the
 * template's own `scripts/` directory - a scaffolded project does not get
 * one - and then removes the `npm run <dropped>` links the surviving bodies
 * chain through, to a fixpoint.
 */
export function scaffoldScripts(scripts = {}) {
  const kept = Object.fromEntries(
    Object.entries(scripts).filter(([, body]) => !String(body).includes("scripts/"))
  );
  for (;;) {
    let changed = false;
    for (const [name, body] of Object.entries(kept)) {
      const rewritten = String(body)
        .split("&&")
        .map((segment) => segment.trim())
        .filter((segment) => {
          const link = /^npm\s+run\s+([\w:.@/-]+)$/.exec(segment);
          return !link || link[1] in kept;
        })
        .filter(Boolean)
        .join(" && ");
      if (rewritten === body) {
        continue;
      }
      changed = true;
      if (rewritten) {
        kept[name] = rewritten;
      } else {
        delete kept[name];
      }
    }
    if (!changed) {
      return kept;
    }
  }
}

/**
 * Which `npm run` targets a scaffolded project would still be left chasing.
 *
 * The gate used to check only that `check` itself is not a `scripts/` script,
 * which a KEPT script chaining to a DROPPED one walks straight past: a
 * template edit to `"check:all": "npm run check:pin && npm run check"` passed
 * here and every scaffolded project's `npm run check:all` died with "missing
 * script". The scaffold resolves that shape itself now (above), so what is
 * left here is what it CANNOT resolve: a reference the template does not
 * define at all, and a dropped one written into a richer command than a bare
 * `npm run <target>` - both of which want a human, not a rewrite.
 */
export function danglingScriptRefs(scripts = {}) {
  const kept = scaffoldScripts(scripts);
  const dangling = [];
  for (const [name, body] of Object.entries(kept)) {
    for (const [, target] of String(body).matchAll(/\bnpm\s+run\s+([\w:.@/-]+)/g)) {
      if (target in kept) {
        continue;
      }
      dangling.push({
        name,
        target,
        // a target the template does not have at all is upstream's own typo;
        // one it has is a script this scaffold deliberately drops
        reason: target in scripts ? "dropped" : "unknown",
      });
    }
  }
  return dangling;
}

if (invokedDirectly(import.meta.url)) {
  const { check, local } = parseArgs();
  const read = (file) => readUpstream({ tool: TOOL, file, local, url: RAW(file) });

  /* The template's own description first - it says which files to take. */
  const spec = JSON.parse(await read(SPEC_FILE));
  const FILES = spec.files?.shared;
  requireShape({
    problems:
      Array.isArray(FILES) && FILES.length
        ? []
        : [
            `${TOOL}: ${SPEC_FILE} has no files.shared[] - the template no longer says what a project takes from it`,
          ],
  });

  const files = {};
  for (const file of FILES) {
    // readUpstream normalises the line endings: the template commits LF
    // (.gitattributes), and a CRLF checkout on Windows must not produce a
    // different snapshot.
    files[file] = await read(file);
  }

  /* Fail loudly rather than write a snapshot the scaffold silently cannot use:
   * each of these is something scaffold.ts reads OUT of the copied text. */
  const missing = [];
  /* Presence FIRST: every probe below reads one of these out of `files`, so a
   * files.shared that stopped listing one used to crash the probe with a
   * TypeError instead of reaching the "template changed shape" report. */
  const PROBED = [
    "AGENTS.md",
    "abaplint.jsonc",
    "abap2ui5lint.jsonc",
    ".github/workflows/check.yml",
    "package.json",
  ];
  for (const required of PROBED) {
    if (!FILES.includes(required)) {
      missing.push(`${SPEC_FILE} files.shared no longer lists ${required}, which the scaffold reads`);
    }
  }
  if (!missing.length) {
    if (!files["AGENTS.md"].includes(GUIDE_MARKER)) {
      missing.push(`AGENTS.md no longer contains "${GUIDE_MARKER}" - the guide half cannot be located`);
    }
    if (!frameworkPin(files["abaplint.jsonc"])) {
      missing.push('abaplint.jsonc has no "branch" pin - a scaffolded project would resolve the framework\'s default branch');
    }
    if (!/"chain-house-layout"/.test(files["abap2ui5lint.jsonc"])) {
      missing.push("abap2ui5lint.jsonc no longer names chain-house-layout");
    }
    if (!linterActionLine(files[".github/workflows/check.yml"])) {
      missing.push("check.yml no longer uses the abap2UI5/linter action - the scaffold takes its pin from there");
    }
    let pkg;
    try {
      pkg = JSON.parse(files["package.json"]);
    } catch {
      missing.push("package.json is not valid JSON");
    }
    if (pkg && !pkg.devDependencies?.["@abap2ui5/linter"]) {
      missing.push("package.json no longer depends on @abap2ui5/linter");
    }
    /* The scaffold drops every template script that runs files out of the
     * template's own scripts/ directory (a scaffolded project does not get
     * one). `check` moving there would silently take `npm run check` away from
     * every new project - the one command its README and AGENTS.md tell the
     * reader to run. */
    if (pkg && !scaffoldScripts(pkg.scripts).check) {
      missing.push(
        'package.json\'s "check" script is missing or runs files under scripts/ - the scaffold drops such scripts, so a new project would lose `npm run check`'
      );
    }
    /* And the same trap one hop further out: a KEPT script chaining via
     * `npm run` into a DROPPED one is a script that exists and cannot run. */
    for (const { name, target, reason } of danglingScriptRefs(pkg?.scripts)) {
      missing.push(
        `package.json's "${name}" script runs \`npm run ${target}\`, which ` +
          (reason === "dropped"
            ? "the scaffold drops (it runs files under scripts/) and cannot strip from this command"
            : "the template does not define") +
          ` - a scaffolded project's \`npm run ${name}\` would die with "missing script"`
      );
    }
  }
  requireShape({
    problems: missing,
    header: `${TOOL}: the template changed shape:`,
    hint: "Fix src/scaffold.ts (and this script) rather than committing a snapshot it cannot read.",
  });

  const json = `${JSON.stringify(
    {
      note: "abap2UI5/app-template's project-independent files, copied verbatim for the New Project scaffold, plus that repository's own template.json - which says which files those are. Generated by scripts/generate-app-template.mjs - do not edit.",
      source: REPO,
      template: spec,
      files,
    },
    null,
    2
  )}\n`;

  emitSnapshot({
    out: OUT,
    json,
    check,
    stale:
      "app-template.json is STALE against abap2UI5/app-template - a project created from the IDE is not the project the template hands out. Run `npm run app-template` and commit.",
    upToDate: `app-template.json: up to date (${FILES.length} files)`,
    wrote: `app-template.json: ${FILES.length} files from ${local ? local : `${REPO}@main`}`,
  });
}
