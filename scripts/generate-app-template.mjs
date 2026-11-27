#!/usr/bin/env node
/*
 * Builds src/data/app-template.json - the files "New Project from Template"
 * writes verbatim, taken from abap2UI5/app-template.
 *
 * Why a snapshot and not a clone: `abap2ui5.newProject` is registered in the
 * WEB entry too (src/web/extension.ts), where there is no git, no child
 * process and no guarantee of network - vscode.dev has to be able to scaffold
 * a project as well as a desktop window does. So the content ships with the
 * extension - next to the bundle as `dist/app-template.json`, read through
 * `workspace.fs` on first use. The price of that is drift, and drift is exactly what happened: the
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
// under src/ so tsc (rootDir: src, resolveJsonModule) can type the suite's
// import of it; esbuild COPIES it next to the bundle (dist/app-template.json)
// rather than inlining it - 300 KB nobody needs at activation - and the two
// commands read it through workspace.fs on both hosts (src/apptemplatefile.ts)
const OUT = path.join(ROOT, "src", "data", "app-template.json");
const REPO = "abap2UI5/app-template";
const RAW = (file) => `https://raw.githubusercontent.com/${REPO}/main/${file}`;

/*
 * WHICH files is not decided here either. app-template describes itself in
 * `template.json` - `files.shared` is every file a new project can take from
 * it UNCHANGED, `files.named` the ones that carry a name (the starter class,
 * its sidecar and its test include, the abapGit and package descriptors) and
 * `files.templateOwn` what belongs to the template. This snapshot takes the
 * first two: the shared files to copy, the named ones AS THE TEMPLATE HAS
 * THEM - placeholder class and all - for `src/scaffold.ts` to substitute the
 * way `template.json`'s `substitutions` describe, which is what the
 * template's own `rename.mjs` and mcp-server's `scaffold_app` execute. The
 * scaffold used to write the named files itself, and the day the template
 * grew a test include and a `WITH_UNIT_TESTS` flag, a project created from
 * the IDE had neither.
 *
 * abapGit serializes its XML with a UTF-8 BOM, and the template's `.xml`
 * files carry it. The snapshot holds TEXT - the BOM is stripped here and the
 * scaffold puts it back when it writes (`bom: true`), where the test suite
 * can see the decision.
 *
 * No shared file is rewritten by the scaffold any more. It used to compose
 * its own `package.json`, CI workflow and AGENTS.md around values read out of
 * the template's (the template's scripts ran files a project did not get, and
 * its AGENTS.md was one page of project text above the whole framework
 * guide). Both reasons are gone upstream: every script in the shared
 * `package.json` resolves to a shared file, and AGENTS.md is the project's own
 * part plus a GENERATED block of the guide's essentials between two marker
 * lines, with the guide itself as ONE shared file under the build-an-app
 * skill. So the scaffold copies all of `files.shared` and applies the
 * substitutions `template.json` names - and what this script still demands of
 * the template is listed below, each because some text or code here relies on
 * it.
 *
 * The spec itself is snapshotted alongside the files: the scaffold needs the
 * list to know what to copy, and one list is the whole point.
 */
const SPEC_FILE = "template.json";

/** The framework release app-template pins abaplint's clone to. */
export function frameworkPin(abaplintConfig) {
  const m = /"branch":\s*"([^"]+)"/.exec(abaplintConfig);
  return m ? m[1] : null;
}

/*
 * The layout of the template's AGENTS.md, as far as this extension names it
 * to a user: the essentials of the framework's app-building guide sit between
 * two marker lines (`ESSENTIALS_BEGIN` / `ESSENTIALS_END` in app-template's
 * `scripts/app-guide-deviations.mjs` - the begin line carries a sentence
 * after this prefix), and the whole guide is one file (`TEMPLATE_GUIDE_FILE`
 * there). Mirrored in `src/scaffold.ts`, because a .mjs generator cannot
 * import the bundle's TypeScript; `src/test/scaffold.test.ts` holds the two
 * copies together.
 */
export const ESSENTIALS_BEGIN = "<!-- guide-essentials:begin";
export const ESSENTIALS_END = "<!-- guide-essentials:end -->";
export const GUIDE_FILE = ".claude/skills/build-an-app/references/building-apps.md";

const TOOL = "generate-app-template";

/** How often `needle` occurs in `text`. */
const count = (text, needle) => text.split(needle).length - 1;

/**
 * What is wrong with the essentials block of an AGENTS.md, as a list - empty
 * when it has exactly one, well formed. "Exactly one" matters: the extension
 * tells a user to keep "the block between the two marker lines", and the
 * template's own generator rewrites the text between the FIRST begin and the
 * first end.
 */
export function essentialsProblems(agents) {
  const problems = [];
  const begins = count(agents, ESSENTIALS_BEGIN);
  const ends = count(agents, ESSENTIALS_END);
  if (begins !== 1 || ends !== 1) {
    problems.push(
      `AGENTS.md has ${begins} "${ESSENTIALS_BEGIN}" and ${ends} "${ESSENTIALS_END}" marker lines - exactly one of each is expected`
    );
  } else if (agents.indexOf(ESSENTIALS_BEGIN) > agents.indexOf(ESSENTIALS_END)) {
    problems.push("AGENTS.md's guide-essentials markers are in the wrong order");
  } else if (
    !agents.slice(agents.indexOf(ESSENTIALS_BEGIN), agents.indexOf(ESSENTIALS_END)).includes(GUIDE_FILE)
  ) {
    problems.push(`AGENTS.md's essentials block no longer says the whole guide is ${GUIDE_FILE}`);
  }
  return problems;
}

/**
 * The files and scripts a shared `package.json` and CI workflow invoke that a
 * project would not have. The scaffold copies both files as they are, so the
 * template's own rule - every script in the shared package.json resolves to a
 * shared file - is what keeps `npm run doctor` from dying in a new project
 * with "Cannot find module". Checked here because a snapshot that broke the
 * rule would ship in the extension before the template's own gate was read.
 *
 * `shipped` is every path a project gets (files.shared and files.named).
 */
export function unresolvedInvocations({ scripts = {}, workflow = "", shipped = [] }) {
  const have = new Set(shipped);
  const problems = [];
  for (const [name, body] of Object.entries(scripts)) {
    for (const [, file] of String(body).matchAll(/\bnode\s+((?:\.\/)?[\w./-]+\.[cm]?js)\b/g)) {
      if (!have.has(file.replace(/^\.\//, ""))) {
        problems.push(`package.json's "${name}" script runs ${file}, which the template does not list as a file a project gets`);
      }
    }
    for (const [, target] of String(body).matchAll(/\bnpm\s+run\s+([\w:.@/-]+)/g)) {
      if (!(target in scripts)) {
        problems.push(`package.json's "${name}" script runs \`npm run ${target}\`, which package.json does not define`);
      }
    }
  }
  for (const [, target] of workflow.matchAll(/^\s*(?:-\s+)?run:\s*npm\s+run\s+([\w:.@/-]+)/gm)) {
    if (!(target in scripts)) {
      problems.push(`check.yml runs \`npm run ${target}\`, which package.json does not define`);
    }
  }
  return problems;
}

if (invokedDirectly(import.meta.url)) {
  const { check, local } = parseArgs();
  const read = (file) => readUpstream({ tool: TOOL, file, local, url: RAW(file) });

  /* The template's own description first - it says which files to take. */
  const spec = JSON.parse(await read(SPEC_FILE));
  const FILES = spec.files?.shared;
  const NAMED = spec.files?.named;
  requireShape({
    problems: [
      ...(Array.isArray(FILES) && FILES.length
        ? []
        : [`${TOOL}: ${SPEC_FILE} has no files.shared[] - the template no longer says what a project takes from it`]),
      ...(Array.isArray(NAMED) && NAMED.length
        ? []
        : [`${TOOL}: ${SPEC_FILE} has no files.named[] - the template no longer says which files carry a name`]),
    ],
  });

  const files = {};
  for (const file of [...FILES, ...NAMED]) {
    // readUpstream normalises the line endings: the template commits LF
    // (.gitattributes), and a CRLF checkout on Windows must not produce a
    // different snapshot. The BOM goes too - see the header.
    files[file] = (await read(file)).replace(/^\uFEFF/, "");
  }

  /* Fail loudly rather than write a snapshot the scaffold silently cannot use:
   * each of these is something scaffold.ts reads OUT of the copied text. */
  const missing = [];
  /* Presence FIRST: every probe below reads one of these out of `files`, so a
   * files.shared that stopped listing one used to crash the probe with a
   * TypeError instead of reaching the "template changed shape" report. */
  const PROBED = [
    "AGENTS.md",
    GUIDE_FILE,
    "abaplint.jsonc",
    "abap2ui5lint.jsonc",
    ".github/workflows/check.yml",
    "package.json",
  ];
  for (const required of PROBED) {
    if (!FILES.includes(required)) {
      missing.push(`${SPEC_FILE} files.shared no longer lists ${required}, which the scaffold reads or names to the user`);
    }
  }
  if (!missing.length) {
    /* The extension's own texts (the scaffolded README, the agent setup's
     * next steps) say where the essentials are and where the whole guide is. */
    missing.push(...essentialsProblems(files["AGENTS.md"]));
    if (!files[GUIDE_FILE].trim()) {
      missing.push(`${GUIDE_FILE} is empty - a project would get no app-building guide`);
    }
    if (!frameworkPin(files["abaplint.jsonc"])) {
      missing.push('abaplint.jsonc has no "branch" pin - a scaffolded project would resolve the framework\'s default branch');
    }
    if (!/"chain-house-layout"/.test(files["abap2ui5lint.jsonc"])) {
      missing.push("abap2ui5lint.jsonc no longer names chain-house-layout");
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
    /* `npm run check` is the one command the scaffolded README and the
     * wizard's closing message tell the reader to run. */
    if (pkg && !pkg.scripts?.check) {
      missing.push('package.json has no "check" script - the one command a new project is told to run');
    }
    /* package.json and check.yml are copied as they are, so what they invoke
     * has to be something a project gets. */
    if (pkg) {
      missing.push(
        ...unresolvedInvocations({
          scripts: pkg.scripts,
          workflow: files[".github/workflows/check.yml"],
          shipped: [...FILES, ...NAMED],
        })
      );
    }
    /* Every file a substitution names has to be one the snapshot carries, and
     * the text it replaces has to be there - or a project keeps the
     * template's name in that file, silently. */
    for (const rel of spec.substitutions?.class?.files ?? []) {
      if (!(rel in files)) {
        missing.push(`${SPEC_FILE} substitutions.class.files names ${rel}, which is neither in files.shared nor in files.named`);
      }
    }
    for (const t of [...(spec.substitutions?.packageText ?? []), ...(spec.substitutions?.repo ?? [])]) {
      const text = files[t.file];
      const found =
        typeof text === "string" &&
        (t.element
          ? new RegExp(`<${t.element}>[^<]*</${t.element}>`).test(text)
          : t.jsonKey
            ? new RegExp(`"${t.jsonKey}":\\s*"[^"]*"`).test(text)
            : false);
      if (!found) {
        missing.push(
          `${SPEC_FILE} substitutes ${t.element ? `<${t.element}>` : `"${t.jsonKey}"`} in ${t.file}, which src/scaffold.ts cannot find there (it replaces an XML element or a JSON string key)`
        );
      }
    }
    /* The named files are SUBSTITUTED, not copied, and the scaffold executes
     * the description literally: the placeholder class in the listed files
     * and paths, in the listed cases. A spec that stopped saying any of it
     * would scaffold the template's own class name into every project. */
    const cls = spec.substitutions?.class;
    if (typeof spec.placeholderClass !== "string" || !spec.placeholderClass) {
      missing.push(`${SPEC_FILE} has no placeholderClass - the scaffold cannot know what to rename`);
    }
    if (!Array.isArray(cls?.files) || !Array.isArray(cls?.cases)) {
      missing.push(`${SPEC_FILE} has no substitutions.class.files/.cases - the scaffold cannot rename the class`);
    }
    if (!NAMED.some((f) => /\.clas\.abap$/.test(f))) {
      missing.push(`${SPEC_FILE} files.named lists no *.clas.abap - a project would get no starter class`);
    }
    for (const named of NAMED) {
      // a named ABAP file the class substitution does not reach keeps the
      // placeholder name: an object abapGit imports under one name and ABAP
      // activates under another, which is what template.json exists to rule out
      if (/\.abap$/.test(named) && cls?.files && !cls.files.includes(named)) {
        missing.push(`${SPEC_FILE} files.named lists ${named}, which substitutions.class.files does not rename`);
      }
    }
    /* "Add Agent Setup to Workspace" executes `agentSetup` (src/agentsetup.ts)
     * from THIS snapshot, which holds files.shared and files.named only: a
     * file it lists outside files.shared would be one the command cannot
     * write, a merge kind it does not know one it refuses, and a source-folder
     * edit that finds no text a gate silently left pointing at src/. */
    const setup = spec.agentSetup;
    if (!setup?.files || typeof setup.files !== "object") {
      missing.push(`${SPEC_FILE} has no agentSetup.files - "Add Agent Setup to Workspace" would have nothing to add`);
    } else {
      for (const rel of Object.keys(setup.files)) {
        if (!FILES.includes(rel)) {
          missing.push(`${SPEC_FILE} agentSetup lists ${rel}, which files.shared does not - the snapshot would not carry it`);
        }
      }
      for (const [rel, merge] of Object.entries(setup.merge ?? {})) {
        if (!["json", "lines"].includes(merge?.how)) {
          missing.push(`${SPEC_FILE} agentSetup.merge asks for "${merge?.how}" on ${rel} - src/agentsetup.ts merges json and lines only`);
        }
      }
      for (const edit of setup.sourceFolder?.edits ?? []) {
        if (!files[edit.file]?.includes(edit.text)) {
          missing.push(`${SPEC_FILE} agentSetup.sourceFolder: ${edit.file} does not contain ${edit.text}`);
        }
      }
    }
  }
  requireShape({
    problems: missing,
    header: `${TOOL}: the template changed shape:`,
    hint: "Fix src/scaffold.ts (and this script) rather than committing a snapshot it cannot read.",
  });

  const json = `${JSON.stringify(
    {
      note: "abap2UI5/app-template's files for the New Project scaffold: the project-independent ones (files.shared) and the name-carrying ones (files.named), both as the template has them, placeholder class and all, for the scaffold to copy and to substitute where template.json says so; plus that repository's own template.json, which says which files those are and what to substitute - and, under agentSetup, which of them Add Agent Setup to Workspace adds to an existing project. Generated by scripts/generate-app-template.mjs - do not edit.",
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
    upToDate: `app-template.json: up to date (${FILES.length} shared + ${NAMED.length} named files)`,
    wrote: `app-template.json: ${FILES.length} shared + ${NAMED.length} named files from ${local ? local : `${REPO}@main`}`,
  });
}
