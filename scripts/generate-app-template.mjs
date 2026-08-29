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
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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

/** A stalled fetch fails the weekly run promptly instead of hanging to the
 *  job's cap. Per file - the snapshot is fetched one file at a time. */
const FETCH_TIMEOUT_MS = 30000;

async function read(file, local) {
  if (local) {
    return fs.readFileSync(path.join(local, file), "utf8");
  }
  const res = await fetch(RAW(file), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    console.error(`generate-app-template: ${RAW(file)} -> HTTP ${res.status}`);
    process.exit(2);
  }
  return res.text();
}

const invokedDirectly =
  process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const local = args.find((a) => !a.startsWith("--"));

  /* The template's own description first - it says which files to take. */
  const spec = JSON.parse((await read(SPEC_FILE, local)).replace(/\r\n/g, "\n"));
  const FILES = spec.files?.shared;
  if (!Array.isArray(FILES) || FILES.length === 0) {
    console.error(`generate-app-template: ${SPEC_FILE} has no files.shared[] - the template no longer says what a project takes from it`);
    process.exit(1);
  }

  const files = {};
  for (const file of FILES) {
    // Line endings are normalised: the template commits LF (.gitattributes),
    // and a CRLF checkout on Windows must not produce a different snapshot.
    files[file] = (await read(file, local)).replace(/\r\n/g, "\n");
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
    const checkScript = pkg?.scripts?.check;
    if (pkg && (!checkScript || checkScript.includes("scripts/"))) {
      missing.push(
        'package.json\'s "check" script is missing or runs files under scripts/ - the scaffold drops such scripts, so a new project would lose `npm run check`'
      );
    }
  }
  if (missing.length) {
    console.error("generate-app-template: the template changed shape:");
    for (const m of missing) console.error(`  ${m}`);
    console.error("Fix src/scaffold.ts (and this script) rather than committing a snapshot it cannot read.");
    process.exit(1);
  }

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

  if (check) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
    if (current !== json) {
      console.error(
        "app-template.json is STALE against abap2UI5/app-template - a project created from the IDE is not the project the template hands out. Run `npm run app-template` and commit."
      );
      process.exit(1);
    }
    console.log(`app-template.json: up to date (${FILES.length} files)`);
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, json);
    console.log(
      `app-template.json: ${FILES.length} files from ${local ? local : `${REPO}@main`}`
    );
  }
}
