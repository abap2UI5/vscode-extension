import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_SETUP,
  adaptSourceFolder,
  agentSetupReport,
  confirmationDetail,
  mergeLines,
  mergePackageJson,
  PackageJsonShapeError,
  packageNameFor,
  planAgentSetup,
  planFromSnapshot,
  samePlan,
  startingFolder,
  writesOf,
  type AgentSetupPlan,
  type WorkspaceProbe,
} from "../agentsetup";
import { TEMPLATE_FILES, TEMPLATE_SPEC } from "../scaffold";

/*
 * "Add Agent Setup to Workspace" over an in-memory folder.
 *
 * The cases are the create package's (app-template's create/agent-setup.mjs
 * and its tests): a fresh folder, a project with its own package.json and
 * AGENTS.md, another STARTING_FOLDER, and the second run that changes
 * nothing. They run against the REAL snapshot's agentSetup key, so a
 * regenerated snapshot the planner cannot execute fails here.
 */

/** A workspace folder as a map of relative path -> text. A directory exists
 *  when it is listed explicitly (`dirs`) or some file lives under it. */
class MemoryFolder implements WorkspaceProbe {
  constructor(
    public files: Record<string, string> = {},
    public dirs: string[] = []
  ) {}
  async exists(rel: string): Promise<boolean> {
    return (
      rel in this.files ||
      this.dirs.includes(rel) ||
      Object.keys(this.files).some((f) => f.startsWith(`${rel}/`))
    );
  }
  async readText(rel: string): Promise<string> {
    const text = this.files[rel];
    if (text === undefined) {
      throw new Error(`ENOENT ${rel}`);
    }
    return text;
  }
  apply(plan: AgentSetupPlan): void {
    for (const a of writesOf(plan)) {
      this.files[a.path] = a.text;
    }
  }
}

const SETUP = AGENT_SETUP!;
const abapgit = (folder: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<asx:abap><asx:values><DATA><MASTER_LANGUAGE>E</MASTER_LANGUAGE>` +
  `<STARTING_FOLDER>${folder}</STARTING_FOLDER><FOLDER_LOGIC>PREFIX</FOLDER_LOGIC></DATA></asx:values></asx:abap>\n`;
const plan = (folder: MemoryFolder, name = "my-project") =>
  planAgentSetup(SETUP, TEMPLATE_FILES, folder, name);
const action = (p: AgentSetupPlan, rel: string) => p.actions.find((a) => a.path === rel);

test("the snapshot carries agentSetup, and every file it lists is a shared file of the snapshot", () => {
  assert.ok(AGENT_SETUP, "src/data/app-template.json has no template.agentSetup - regenerate it");
  const shared: string[] = TEMPLATE_SPEC.files.shared;
  const named: string[] = TEMPLATE_SPEC.files.named;
  for (const rel of Object.keys(SETUP.files)) {
    assert.ok(shared.includes(rel), `${rel} is in agentSetup but not in files.shared`);
    assert.ok(!named.includes(rel), `${rel} carries a name - an existing project has its own`);
    assert.equal(typeof TEMPLATE_FILES[rel], "string", `${rel} is missing from the snapshot`);
  }
  for (const [rel, merge] of Object.entries(SETUP.merge ?? {})) {
    assert.ok(rel in SETUP.files, `merge names ${rel}, which agentSetup does not take`);
    assert.ok(["json", "lines"].includes(merge.how), `merge "${merge.how}" on ${rel} is not executed here`);
  }
  for (const edit of SETUP.sourceFolder?.edits ?? []) {
    assert.ok(
      TEMPLATE_FILES[edit.file]?.includes(edit.text),
      `sourceFolder edit for ${edit.file} does not find ${edit.text}`
    );
  }
  // the source folder is never written: no file of the set lives in src/
  assert.ok(!Object.keys(SETUP.files).some((f) => f.startsWith("src/")));
  // what the issue names, so a template that dropped one fails loudly
  for (const rel of ["AGENTS.md", "CLAUDE.md", ".claude/settings.json", ".mcp.json", "abaplint.jsonc",
    "abap2ui5lint.jsonc", "package.json", ".gitignore", ".github/workflows/check.yml", ".nvmrc"]) {
    assert.ok(rel in SETUP.files, `agentSetup no longer takes ${rel}`);
  }
});

test("startingFolder reads abapGit's STARTING_FOLDER", () => {
  assert.equal(startingFolder(abapgit("/src/")), "src");
  assert.equal(startingFolder(abapgit("/abap/src/")), "abap/src");
  assert.equal(startingFolder(abapgit("/")), "");
  assert.equal(startingFolder("<asx:abap/>"), null);
  assert.equal(startingFolder(undefined), null);
});

test("a fresh folder gets every file, a package.json under its own name", async () => {
  const folder = new MemoryFolder({ ".abapgit.xml": abapgit("/src/") }, ["src"]);
  const p = await plan(folder, "My Project");
  assert.equal(p.folder, "src");
  assert.equal(p.from, ".abapgit.xml STARTING_FOLDER");
  assert.deepEqual(p.warnings, []);
  assert.deepEqual(
    p.actions.map((a) => [a.path, a.kind]),
    Object.keys(SETUP.files).map((f) => [f, "add"])
  );
  // copied verbatim where nothing names the folder
  for (const rel of ["AGENTS.md", "abaplint.jsonc", ".claude/settings.json", ".mcp.json"]) {
    const a = action(p, rel);
    assert.ok(a && a.kind === "add");
    assert.equal(a.text, TEMPLATE_FILES[rel], rel);
  }
  // package.json: the project's name, not the template's license/description
  const pkgAction = action(p, "package.json");
  assert.ok(pkgAction && pkgAction.kind === "add");
  const pkg = JSON.parse(pkgAction.text);
  const tpl = JSON.parse(TEMPLATE_FILES["package.json"]);
  assert.equal(pkg.name, "my-project");
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, undefined);
  assert.equal(pkg.description, undefined);
  assert.deepEqual(pkg.scripts, tpl.scripts);
  assert.deepEqual(pkg.devDependencies, tpl.devDependencies);
  assert.deepEqual(pkg.engines, tpl.engines);
  // never into the source folder, never .abapgit.xml
  assert.ok(!p.actions.some((a) => a.path.startsWith("src/") || a.path === ".abapgit.xml"));
});

test("an existing package.json and AGENTS.md: AGENTS.md skipped, package.json only gains entries", async () => {
  const own = `{
    "name": "my-app",
    "version": "2.0.0",
    "scripts": {
        "check": "echo mine",
        "build": "tsc"
    },
    "dependencies": {
        "@abaplint/cli": "2.100.0"
    }
}
`;
  const folder = new MemoryFolder(
    {
      ".abapgit.xml": abapgit("/src/"),
      "package.json": own,
      "AGENTS.md": "# My own agent notes\n",
      ".gitignore": "/node_modules\n*.log\n",
    },
    ["src"]
  );
  const p = await plan(folder);
  assert.deepEqual(action(p, "AGENTS.md"), {
    path: "AGENTS.md",
    kind: "skip",
    detail: "already there - left as it is",
  });

  const merged = action(p, "package.json");
  assert.ok(merged && merged.kind === "merge");
  const pkg = JSON.parse(merged.text);
  assert.equal(pkg.name, "my-app");
  assert.equal(pkg.version, "2.0.0");
  assert.equal(pkg.scripts.check, "echo mine", "a script the project has keeps its value");
  assert.equal(pkg.scripts.build, "tsc");
  assert.equal(pkg.scripts["check:abap"], "abaplint abaplint.jsonc");
  assert.equal(pkg.devDependencies["@abaplint/cli"], undefined, "a runtime dependency counts as present");
  assert.ok(pkg.devDependencies["@abap2ui5/linter"]);
  assert.deepEqual(pkg.engines, { node: ">=22" });
  assert.match(merged.text, /^ {4}"name"/m, "the project's four-space indent survives");
  assert.ok(merged.text.endsWith("}\n"));
  assert.ok(!merged.added.includes("scripts.check"));
  assert.match(merged.detail, /\+\d+ scripts, \+2 devDependencies, \+1 engines/);
  assert.ok(p.warnings.some((w) => w.startsWith('package.json: kept your scripts.check "echo mine"')));
  assert.ok(p.warnings.some((w) => w.includes("kept your devDependencies.@abaplint/cli")));

  // .gitignore: /node_modules is node_modules/ - only .playwright/ is added, with its comment
  const ignore = action(p, ".gitignore");
  assert.ok(ignore && ignore.kind === "merge");
  assert.deepEqual(ignore.added, [".playwright/"]);
  assert.equal(
    ignore.text,
    "/node_modules\n*.log\n\n# the render gate's browser, when playwright is told to keep it in-project\n.playwright/\n"
  );
});

test("another STARTING_FOLDER: the gates are pointed there, the dependency's folder stays", async () => {
  const folder = new MemoryFolder({ ".abapgit.xml": abapgit("/abap/src/") }, ["abap/src"]);
  const p = await plan(folder);
  assert.equal(p.folder, "abap/src");
  assert.deepEqual(p.warnings, []);
  const text = (rel: string) => {
    const a = action(p, rel);
    assert.ok(a && a.kind !== "skip", rel);
    return a.text;
  };
  const abaplint = text("abaplint.jsonc");
  assert.match(abaplint, /"files": "\/abap\/src\/\*\*\/\*\.\*"/);
  assert.equal(
    (abaplint.match(/"files": "\/src\/\*\*\/\*\.\*"/g) ?? []).length,
    1,
    "the framework dependency's own files glob is left as it is"
  );
  assert.match(text("abap2ui5lint.jsonc"), /"paths": \["abap\/src"\]/);
  assert.match(text(".github/workflows/check.yml"), /paths: abap\/src/);
  assert.equal(JSON.parse(text("package.json")).scripts["test:unit"].endsWith("abap2ui5-unit abap/src"), true);
  assert.equal(action(p, "abaplint.jsonc")?.detail, "sources: abap/src/");
  assert.equal(text("AGENTS.md"), TEMPLATE_FILES["AGENTS.md"]);
  // and nothing under abap/src/
  assert.ok(!p.actions.some((a) => a.path.startsWith("abap/src/")));
});

test("a second run over a finished setup changes nothing", async () => {
  const folder = new MemoryFolder(
    { ".abapgit.xml": abapgit("/abap/src/"), "package.json": '{"name":"x"}', ".gitignore": "dist/" },
    ["abap/src"]
  );
  const first = await plan(folder);
  assert.ok(writesOf(first).length > 0);
  folder.apply(first);
  const second = await plan(folder);
  assert.deepEqual(writesOf(second), []);
  assert.ok(second.actions.every((a) => a.kind === "skip"));
  assert.equal(action(second, "package.json")?.detail, "already has every entry of scripts, devDependencies, engines");
  assert.equal(action(second, ".gitignore")?.detail, "already ignores everything the template does");
  assert.match(agentSetupReport(second, "/ws/x"), /0 written, \d+ skipped - the agent setup was already complete/);
});

test("folder decisions and their warnings", async () => {
  const none = await plan(new MemoryFolder({}, ["src"]));
  assert.equal(none.folder, "src");
  assert.equal(none.from, "no .abapgit.xml - assuming src/");

  const unnamed = await plan(new MemoryFolder({ ".abapgit.xml": "<asx:abap/>" }));
  assert.equal(unnamed.from, ".abapgit.xml names no STARTING_FOLDER - assuming src/");
  assert.ok(unnamed.warnings.includes("src/ does not exist - the gates are configured for it and will find no classes there"));

  const root = await plan(new MemoryFolder({ ".abapgit.xml": abapgit("/") }, ["src"]));
  assert.equal(root.folder, "src");
  assert.ok(root.warnings[0].startsWith(".abapgit.xml's STARTING_FOLDER is the repository root"));

  const variant = await plan(new MemoryFolder({ "abaplint.json": "{}" }, ["src"]));
  assert.ok(variant.warnings.some((w) => w.startsWith("this project has abaplint.json, and now abaplint.jsonc as well")));
});

test("nothing is ever planned into the source folder", async () => {
  // a STARTING_FOLDER named like one of the setup's folders
  const p = await plan(new MemoryFolder({ ".abapgit.xml": abapgit("/.claude/") }, [".claude"]));
  for (const a of p.actions.filter((x) => x.path.startsWith(".claude/"))) {
    assert.equal(a.kind, "skip", a.path);
    assert.equal(a.detail, "inside the source folder .claude/ - never written");
  }
});

test("nothing is written through a symbolic link", async () => {
  /* `.claude -> ~/.claude` in a cloned repository: `exists` follows the link,
   * so `.claude/settings.json` looked absent whenever the user had no global
   * Claude Code settings - and the template's permission allowlist was
   * written into them, for every project. A linked package.json would have
   * been merged into wherever it points. */
  class LinkedFolder extends MemoryFolder {
    constructor(files: Record<string, string>, dirs: string[], public links: string[]) {
      super(files, dirs);
    }
    async isLink(rel: string): Promise<boolean> {
      return this.links.includes(rel);
    }
  }
  const folder = new LinkedFolder(
    { "package.json": '{"name":"x"}' },
    ["src", ".claude"],
    [".claude", "package.json"]
  );
  const p = await plan(folder);
  const claude = p.actions.filter((a) => a.path.startsWith(".claude/"));
  assert.ok(claude.length >= 2, "the setup has files under .claude/");
  for (const a of claude) {
    assert.equal(a.kind, "skip", a.path);
    assert.equal(a.detail, ".claude is a symbolic link - never written through one");
  }
  assert.equal(action(p, "package.json")?.kind, "skip");
  assert.equal(action(p, "package.json")?.detail, "package.json is a symbolic link - never written through one");
  // everything else is planned as before
  assert.equal(action(p, "AGENTS.md")?.kind, "add");
  assert.ok(!writesOf(p).some((a) => a.path.startsWith(".claude/") || a.path === "package.json"));
});

test("a kept abaplint.jsonc without a framework pin is named", async () => {
  const p = await plan(new MemoryFolder({ "abaplint.jsonc": '{ "global": { "files": "/src/**/*.*" } }' }, ["src"]));
  assert.equal(action(p, "abaplint.jsonc")?.kind, "skip");
  assert.ok(p.warnings.some((w) => w.startsWith("`npm run check:pin` (the first step of check.yml)")));

  const own = await plan(
    new MemoryFolder(
      { "abaplint.jsonc": "{}", "package.json": '{"scripts":{"check:pin":"echo ok"}}' },
      ["src"]
    )
  );
  assert.ok(own.warnings.some((w) => w.startsWith("`npm run doctor` would report the framework pin as FAIL")));

  const pinned = await plan(new MemoryFolder({ "abaplint.jsonc": '{"branch": "1.145.0"}' }, ["src"]));
  assert.ok(!pinned.warnings.some((w) => w.includes("check:pin")));
});

test("a package.json that is not JSON stops the plan before anything is written", async () => {
  await assert.rejects(
    plan(new MemoryFolder({ "package.json": "{ nope" }, ["src"])),
    /package\.json is not valid JSON .* - fix it, or move it aside and run again/
  );
});

test("a package.json that is JSON but no object is not called invalid JSON", async () => {
  // `null` used to throw a TypeError out of the merge, reported as "not
  // valid JSON"; an array took the entries as properties JSON.stringify
  // drops, and the plan announced additions it would write back as `[]`
  for (const [text, shape] of [
    ["null", "null"],
    ["[]", "an array"],
    ['"x"', "a string"],
  ]) {
    await assert.rejects(
      plan(new MemoryFolder({ "package.json": text }, ["src"])),
      new RegExp(`package\\.json is not a package manifest \\(its top level is ${shape}, not an object\\)`)
    );
  }
  assert.throws(() => mergePackageJson("[]", '{"scripts":{"a":"1"}}', ["scripts"]), PackageJsonShapeError);
});

test("the pure merges, as the create package has them", () => {
  assert.deepEqual(mergePackageJson('{"scripts":{"a":"1"}}', '{"scripts":{"a":"2"}}', ["scripts"]), {
    text: null,
    added: [],
    kept: [{ entry: "scripts.a", have: "1", want: "2" }],
  });
  const added = mergePackageJson('{"name":"x"}', '{"engines":{"node":">=22"}}', ["engines"]);
  assert.equal(added.text, '{\n  "name": "x",\n  "engines": {\n    "node": ">=22"\n  }\n}');
  assert.deepEqual(mergeLines("node_modules\n", "# deps\nnode_modules/\n"), { text: null, added: [] });
  assert.deepEqual(mergeLines("a", "b"), { text: "a\n\nb\n", added: ["b"] });
  assert.deepEqual(mergeLines("", "# c\nb\n"), { text: "# c\nb\n", added: ["b"] });
  assert.equal(packageNameFor("My Project!"), "my-project-");
  assert.equal(packageNameFor("..."), "abap2ui5-app");
  assert.equal(
    adaptSourceFolder("x.json", '"paths": ["src"]', { placeholder: "src", edits: [{ file: "x.json", text: '"paths": ["src"]' }] }, "lib"),
    '"paths": ["lib"]'
  );
});

test("the confirmation lists writes and skips, the report the next steps", async () => {
  const folder = new MemoryFolder({ "AGENTS.md": "mine", "package.json": "{}" }, ["src"]);
  const p = await planFromSnapshot(folder, "proj");
  const detail = confirmationDetail(p);
  assert.match(detail, /^Sources: src\/ \(no \.abapgit\.xml - assuming src\/\)/);
  assert.match(detail, /Will write \d+:\n {2}add {2}CLAUDE\.md/);
  assert.match(detail, /merge {2}package\.json \(\+\d+ scripts/);
  assert.match(detail, /Left as they are \(1\):\n {2}AGENTS\.md - already there - left as it is/);
  assert.match(detail, /Nothing is overwritten/);

  const report = agentSetupReport(p, "/ws/proj");
  assert.match(report, /^abap2UI5 agent setup: \/ws\/proj/);
  assert.match(report, /^  added +CLAUDE\.md$/m);
  assert.match(report, /^  skipped +AGENTS\.md +already there/m);
  assert.match(report, /npm install/);
  assert.match(report, /npm run check {19}# abaplint \+ abap2UI5-linter over src\//);
  assert.match(report, /\/plugin marketplace add abap2UI5\/abap2UI5\n {2}\/plugin install abap2ui5@abap2ui5/);
  assert.doesNotMatch(report, /Rewrite it for this one/, "AGENTS.md was the project's own");

  const fresh = agentSetupReport(await planFromSnapshot(new MemoryFolder({}, ["src"]), "p"), "p");
  assert.match(fresh, /AGENTS\.md's first section \("This repository"\)/);
});

test("samePlan tells a folder that moved under the confirmation apart", async () => {
  const folder = new MemoryFolder({}, ["src"]);
  const a = await plan(folder);
  assert.ok(samePlan(a, await plan(folder)));
  folder.files["CLAUDE.md"] = "appeared meanwhile";
  assert.ok(!samePlan(a, await plan(folder)));
});
