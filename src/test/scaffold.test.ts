import { test } from "node:test";
import assert from "node:assert/strict";
import appTemplate from "../data/app-template.json";
import {
  ESSENTIALS_BEGIN,
  ESSENTIALS_END,
  GUIDE_FILE,
  applyClass,
  applyElement,
  applyJsonKey,
  essentialsBlock,
  frameworkPin,
  projectClassNameError,
  projectFilePaths,
  scaffoldFiles,
  scaffoldText,
  starterClassSource,
  substitutePath,
  substituteText,
  substitutedFilePaths,
  namedFilePaths,
  placeholderClass,
  setAppTemplate,
  templateFiles,
  templateSpec,
  verbatimFilePaths,
  xmlEscape,
} from "../scaffold";

// the snapshot is read from next to the bundle at runtime - the suite hands
// the generated file in directly
setAppTemplate(appTemplate);
const TEMPLATE_FILES = templateFiles();
const TEMPLATE_SPEC = templateSpec();
const VERBATIM_FILES = verbatimFilePaths();
const NAMED_FILES = namedFilePaths();
const PLACEHOLDER_CLASS = placeholderClass();

/*
 * The drift gate over "New Project from Template".
 *
 * WHAT THIS PROVES, exactly: that what the scaffold writes is what
 * `src/data/app-template.json` holds - the snapshot of abap2UI5/app-template's
 * own files. It does NOT prove the snapshot is current; that is
 * `node scripts/generate-app-template.mjs --check`, which reads the real
 * repository (a checkout or raw.githubusercontent.com) and which
 * `.github/workflows/bump-app-template.yml` runs weekly. Splitting it that way
 * is deliberate: this repository's tests must not go red because somebody
 * merged a pull request in another repository, and they must not claim to have
 * verified something they did not.
 *
 * The half that runs here is the half that failed before. The scaffold used to
 * carry its own hand-typed copy of app-template's configs, and every one of
 * these assertions is a defect it shipped: `@abap2ui5/linter@^0.1.1` while the
 * ecosystem was on 0.2.1; no `"branch"` pin, so a scaffolded project linted
 * against abap2UI5's moving default branch; no `chain-house-layout`; no
 * AGENTS.md at all, which is the one file an AI assistant opens first.
 */

const files = (): ReturnType<typeof scaffoldFiles> =>
  scaffoldFiles("my-app", "zcl_my_app");
const contentOf = (path: string): string => {
  const file = files().find((f) => f.path === path);
  assert.ok(file, `the scaffold writes ${path}`);
  return file.content;
};

/** The files a project takes from app-template unchanged - app-template's own
 *  list, not a second one kept here. */
const VERBATIM = VERBATIM_FILES;
const count = (text: string, needle: string): number => text.split(needle).length - 1;

test("the scaffold writes app-template's files - every one it lists, and one README", () => {
  // A hand-kept list here would go stale the moment app-template adds a file,
  // and a project would quietly be missing it. The scaffold used to compose
  // three shared files itself (package.json, check.yml, AGENTS.md), and each
  // was a second description that drifted; now the only path it writes that
  // template.json does not list is the README the template says a project
  // writes for itself.
  const listed = projectFilePaths().map((rel) => substitutePath(rel, "zcl_my_app"));
  const written = files().map((f) => f.path);
  assert.deepEqual(written.filter((p) => !listed.includes(p)), ["README.md"]);
  assert.deepEqual(listed.filter((p) => !written.includes(p)), []);
  assert.ok("README.md" in TEMPLATE_SPEC.files.templateOwn, "the template still keeps its README to itself");
});

test("a shared file is either copied or named by a substitution - nothing else touches it", () => {
  const substituted = substitutedFilePaths();
  const shared: string[] = TEMPLATE_SPEC.files.shared;
  assert.deepEqual(
    shared.filter((f) => !VERBATIM.includes(f)).sort(),
    shared.filter((f) => substituted.includes(f)).sort()
  );
  // by name, so a spec that stopped naming one of them fails here and not in
  // a user's project: the documentation that names the starter class, and
  // npm's idea of the repository name
  for (const rel of ["AGENTS.md", "docs/project.md", "package.json"]) {
    assert.ok(substituted.includes(rel), `template.json substitutes in ${rel}`);
    assert.ok(!VERBATIM.includes(rel), `${rel} is not handed out unsubstituted`);
  }
  assert.ok(VERBATIM.length > 0, "the template still hands out files to copy");
  // every file a substitution names is one the snapshot carries
  for (const rel of substituted) {
    assert.equal(typeof TEMPLATE_FILES[rel], "string", `${rel} is in the snapshot`);
  }
});

test("the copied files are copied - byte for byte, from the snapshot", () => {
  for (const path of VERBATIM) {
    assert.ok(TEMPLATE_FILES[path], `the snapshot carries ${path}`);
    assert.equal(
      contentOf(path),
      TEMPLATE_FILES[path],
      `${path} differs from abap2UI5/app-template's copy - it is not the scaffold's to edit; ` +
        "change it in app-template and run `npm run app-template`"
    );
  }
});

test("a substituted shared file is the template's with exactly the substitutions template.json names", () => {
  // AGENTS.md and docs/project.md: the class, in both spellings, and nothing else
  for (const rel of ["AGENTS.md", "docs/project.md"]) {
    assert.ok(/zcl_app_001/i.test(TEMPLATE_FILES[rel]), `the template's ${rel} names its starter class`);
    assert.equal(contentOf(rel), applyClass(TEMPLATE_FILES[rel], PLACEHOLDER_CLASS, "zcl_my_app"), rel);
  }
  // package.json: the name key, as text - formatting, scripts, versions, the
  // rest of the file are the template's bytes
  assert.equal(contentOf("package.json"), applyJsonKey(TEMPLATE_FILES["package.json"], "name", "my-app"));
  assert.notEqual(contentOf("package.json"), TEMPLATE_FILES["package.json"]);
  // and the general statement, for whatever the spec names next
  for (const rel of substitutedFilePaths()) {
    assert.equal(
      contentOf(substitutePath(rel, "zcl_my_app")),
      substituteText(rel, TEMPLATE_FILES[rel], { className: "zcl_my_app", projectName: "my-app" }),
      rel
    );
  }
});

test("no file of a new project still names the template's placeholder class", () => {
  // The class is renamed where template.json says it is written. A file that
  // names it and is NOT listed there would hand every project a pointer to a
  // class it does not have - in the template that is a missing entry in
  // substitutions.class.files, and this is where the extension notices.
  for (const file of files()) {
    assert.ok(!file.path.toLowerCase().includes(PLACEHOLDER_CLASS), `${file.path}: the path is renamed`);
    assert.ok(
      !file.content.toLowerCase().includes(PLACEHOLDER_CLASS),
      `${file.path} still names ${PLACEHOLDER_CLASS} after the rename`
    );
  }
  // and the files that carried it now carry the chosen name
  for (const rel of TEMPLATE_SPEC.substitutions.class.files) {
    const content = contentOf(substitutePath(rel, "zcl_my_app"));
    assert.ok(/zcl_my_app/i.test(content), `${rel} names the class that was created`);
  }
});

test("a scaffolded project pins the framework, like the template does", () => {
  // The bug this replaces: no `dependencies[].branch` at all, so abaplint
  // cloned abap2UI5's default branch. A branch moves - a rename upstream turns
  // into a red build in a repository nobody touched, and a starter class that
  // stopped compiling against what people install passes just as quietly.
  const pin = frameworkPin();
  assert.match(pin, /^\d+\.\d+\.\d+$/, "the pin is a release tag");
  assert.match(
    contentOf("abaplint.jsonc"),
    new RegExp(`"branch":\\s*"${pin}"`),
    "the scaffolded abaplint config pins the framework clone"
  );
  // and the reader is told which release to install, from the same source
  assert.ok(contentOf("README.md").includes(pin), "the README names the pinned release");
  assert.ok(contentOf("AGENTS.md").includes(pin), "AGENTS.md names the pinned release");
});

test("a scaffolded project runs the chain-layout rule the guide documents", () => {
  // AGENTS.md tells the reader a gate catches a drifted chain "here". That is
  // only true while the config that comes with it names the opt-in rule.
  assert.match(
    contentOf("abap2ui5lint.jsonc"),
    /"chain-house-layout"/,
    "chain-house-layout is named - the rule is opt-in, an unnamed rule is not run"
  );
  assert.match(contentOf("abap2ui5lint.jsonc"), /"failOn":\s*"warning"/);
});

test("the manifest is the template's: versions, scripts and all - only the name is the project's", () => {
  const template = JSON.parse(TEMPLATE_FILES["package.json"]) as Record<string, unknown>;
  const scaffolded = JSON.parse(contentOf("package.json")) as Record<string, unknown>;
  assert.equal(scaffolded.name, "my-app");
  assert.deepEqual({ ...scaffolded, name: template.name }, template);
  // so the lockfile the template hands out still locks this manifest's
  // dependencies, which is what lets a new project start with `npm ci`
  const lock = JSON.parse(contentOf("package-lock.json")) as {
    packages: Record<string, { devDependencies?: Record<string, string> }>;
  };
  assert.deepEqual(lock.packages[""].devDependencies, scaffolded.devDependencies);
});

test("every script a new project offers can run: the files and scripts it invokes are in the project", () => {
  // The scaffold used to DROP the scripts that ran files under scripts/,
  // because a project did not get that directory. The template's rule is now
  // that every script in the shared package.json resolves to a shared file,
  // and this holds the scaffolded project to it - `npm run doctor` and
  // `npm run add-addon` are commands AGENTS.md tells the reader to run.
  const paths = new Set(files().map((f) => f.path));
  const { scripts } = JSON.parse(contentOf("package.json")) as { scripts: Record<string, string> };
  let ranFiles = 0;
  for (const [name, body] of Object.entries(scripts)) {
    for (const [, file] of body.matchAll(/\bnode\s+([\w./-]+\.[cm]?js)\b/g)) {
      ranFiles++;
      assert.ok(paths.has(file), `"${name}" runs ${file}, which this project has`);
    }
    for (const [, target] of body.matchAll(/\bnpm\s+run\s+([\w:.@/-]+)/g)) {
      assert.ok(scripts[target], `"${name}" runs \`npm run ${target}\`, which this project has`);
    }
  }
  assert.ok(ranFiles >= 3, "the template's scripts under scripts/ are offered, not dropped");
  for (const offered of ["check", "check:pin", "check:all", "doctor", "add-addon", "fix", "test:unit"]) {
    assert.ok(scripts[offered], `"npm run ${offered}" is offered`);
  }
  // add-addon reads the catalogue snapshot next to it
  assert.ok(paths.has("scripts/add-addon.mjs") && paths.has("scripts/addons.json"));
  assert.doesNotThrow(() => JSON.parse(contentOf("scripts/addons.json")));
  // and the agent may run it without a prompt
  assert.match(contentOf(".claude/settings.json"), /"Bash\(npm run add-addon:\*\)"/);
});

test("no scaffolded file names a linter version of its own", () => {
  // The failure mode literally: `"@abap2ui5/linter": "^0.1.1"` sat in this
  // file's package.json literal while app-template had moved to ^0.2.1. A
  // version written anywhere in the scaffold has to be the template's.
  const want = (JSON.parse(TEMPLATE_FILES["package.json"]) as {
    devDependencies: Record<string, string>;
  }).devDependencies["@abap2ui5/linter"];
  let named = 0;
  for (const file of files()) {
    for (const [, found] of file.content.matchAll(/"@abap2ui5\/linter":\s*"([^"]+)"/g)) {
      if (file.path === "package-lock.json") {
        continue; // the lockfile also records the RESOLVED version, by design
      }
      named++;
      assert.equal(found, want, `${file.path} names linter ${found}, app-template says ${want}`);
    }
  }
  assert.ok(named >= 1, "package.json names the linter");
});

test("the CI workflow is app-template's own, and every script it runs exists", () => {
  const workflow = contentOf(".github/workflows/check.yml");
  assert.equal(workflow, TEMPLATE_FILES[".github/workflows/check.yml"]);
  // what the composed workflow used to assert one by one, now as facts about
  // the copied file: both actions pinned to a commit with the tag in the
  // comment, the unit job, and no step this project cannot execute
  assert.match(workflow, /uses: abap2UI5\/linter@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
  assert.match(workflow, /uses: abap2UI5\/mcp-server@[0-9a-f]{40} # v\d+/);
  assert.match(workflow, /^  unit:\n    runs-on: ubuntu-latest/m, "the unit tests are a job of their own");
  assert.match(workflow, /paths: src/);
  const { scripts } = JSON.parse(contentOf("package.json")) as { scripts: Record<string, string> };
  const ran = [...workflow.matchAll(/^\s*(?:-\s+)?run:\s*npm run ([\w:-]+)/gm)].map((m) => m[1]);
  assert.ok(ran.includes("check:pin"), "the workflow runs the pin check, like the template's");
  for (const name of ran) {
    assert.ok(scripts[name], `the workflow runs "npm run ${name}", which this project has`);
  }
  assert.match(contentOf("package.json"), /"test:unit": "npx --yes -p @abap2ui5\/mcp-server abap2ui5-unit src"/);
});

test("AGENTS.md is the template's: the project's part, then exactly one essentials block", () => {
  const agents = contentOf("AGENTS.md");
  // one block, well formed - the extension tells a user to keep "the block
  // between the two marker lines", and the template's generator rewrites the
  // text between the first begin and the first end
  assert.equal(count(agents, ESSENTIALS_BEGIN), 1, "one begin marker");
  assert.equal(count(agents, ESSENTIALS_END), 1, "one end marker");
  const block = essentialsBlock(agents);
  assert.ok(block.startsWith(ESSENTIALS_BEGIN) && block.endsWith(ESSENTIALS_END));
  assert.ok(agents.trimEnd().endsWith(ESSENTIALS_END), "nothing follows the generated block");
  // the block is generated upstream and carries no name: byte for byte the template's
  assert.equal(block, essentialsBlock(TEMPLATE_FILES["AGENTS.md"]));
  assert.ok(block.length > 3000, `the essentials travel (${block.length} chars)`);
  assert.ok(block.includes(GUIDE_FILE), "the block says where the whole guide is");
  // the old layout is gone: no provenance marker, no guide inlined below it
  assert.ok(!agents.includes("> **Provenance:**"));
  assert.ok(agents.length < TEMPLATE_FILES[GUIDE_FILE].length, "AGENTS.md is the essentials, not the guide");
  // the part above describes THIS project
  const head = agents.slice(0, agents.indexOf(ESSENTIALS_BEGIN));
  assert.ok(head.includes("zcl_my_app"), "the head names the class that was created");
  assert.ok(head.includes(GUIDE_FILE), "and points at the full guide");
  assert.ok(head.includes("docs/project.md"), "and at its own long form");
  // and the commands it tells the reader to run are commands this project has
  const { scripts } = JSON.parse(contentOf("package.json")) as { scripts: Record<string, string> };
  const bash = /```bash\n([\s\S]*?)```/.exec(head);
  assert.ok(bash, "the head has a build-and-verify block");
  const told = [...bash[1].matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
  assert.ok(told.includes("add-addon") && told.includes("doctor"));
  for (const name of told) {
    assert.ok(scripts[name], `the head tells the reader to run "npm run ${name}"`);
  }
});

test("the app-building guide is written once, as the one file the essentials point at", () => {
  const guides = files().filter((f) => f.path === GUIDE_FILE);
  assert.equal(guides.length, 1, `${GUIDE_FILE} is written exactly once`);
  const guide = guides[0].content;
  assert.equal(guide, TEMPLATE_FILES[GUIDE_FILE], "verbatim");
  assert.ok(guide.length > 20000, `the whole guide travels (${guide.length} chars)`);
  // ONE copy: the guide's closing pages are in no other file (the essentials
  // block is cut out of the guide, so its early sections repeat by design -
  // the guide as a whole does not)
  const carriers = files().filter((f) => f.content.includes(guide.slice(guide.length - 2000)));
  assert.deepEqual(carriers.map((f) => f.path), [GUIDE_FILE], "no second copy of the guide");
  // every section the essentials send a reader to exists in that file
  const block = essentialsBlock(contentOf("AGENTS.md"));
  const sent = [...block.matchAll(/^\| (\d+) \|/gm)].map((m) => m[1]);
  assert.ok(sent.length > 3, "the essentials name guide sections to read on");
  for (const n of sent) {
    assert.match(guide, new RegExp(`^## ${n}\\. `, "m"), `the guide has a section ${n}`);
  }
});

test("the four skills travel whole: a SKILL.md each, and every reference it links", () => {
  const paths = files().map((f) => f.path);
  for (const skill of ["build-an-app", "view-chain-layout", "abap-check", "ui5-check"]) {
    const dir = `.claude/skills/${skill}/`;
    assert.ok(paths.includes(`${dir}SKILL.md`), `${skill} has its SKILL.md`);
    for (const [, ref] of contentOf(`${dir}SKILL.md`).matchAll(/(?:`|\]\()(references\/[\w./-]+\.md)/g)) {
      assert.ok(paths.includes(dir + ref), `${skill}/SKILL.md names ${ref}, which the project has`);
    }
    // and no reference travels that its SKILL.md does not send a reader to
    for (const ref of paths.filter((p) => p.startsWith(`${dir}references/`))) {
      assert.ok(
        contentOf(`${dir}SKILL.md`).includes(ref.slice(dir.length)),
        `${ref} is named by its SKILL.md`
      );
    }
  }
  assert.ok(paths.filter((p) => /^\.claude\/skills\/[^/]+\/references\//.test(p)).length >= 10);
});

test("the README sends the reader where the template's layout has the guide", () => {
  const readme = contentOf("README.md");
  const paths = files().map((f) => f.path);
  assert.ok(readme.includes(GUIDE_FILE));
  for (const [, link] of readme.matchAll(/\]\((?!https?:)([^)#]+)\)/g)) {
    assert.ok(paths.includes(link), `the README links ${link}, which the project has`);
  }
  assert.ok(!/provenance/i.test(readme), "the provenance block is gone from the template");
  const { scripts } = JSON.parse(contentOf("package.json")) as { scripts: Record<string, string> };
  for (const [, name] of readme.matchAll(/npm run ([\w:-]+)/g)) {
    assert.ok(scripts[name], `the README tells the reader to run "npm run ${name}"`);
  }
  // `npm ci`: the project starts with the template's lockfile
  assert.match(readme, /^npm ci\b/m);
  assert.ok(paths.includes("package-lock.json"));
});

test("the snapshot has nothing in it nobody reads", () => {
  // A file added to scripts/generate-app-template.mjs and then never used is a
  // silent claim that the scaffold copies more than it does.
  const read = new Set([...TEMPLATE_SPEC.files.shared, ...TEMPLATE_SPEC.files.named]);
  assert.deepEqual(
    Object.keys(TEMPLATE_FILES).sort(),
    [...read].sort(),
    "every snapshot file is one the scaffold copies, substitutes or reads a value out of"
  );
});

/*
 * The named files: app-template's own, renamed the way its template.json
 * says. The scaffold used to write these itself, which is how a project
 * from the IDE came to lack the test include and the sidecar's
 * WITH_UNIT_TESTS the template had grown - the same drift as the configs,
 * one release later.
 */
test("every named file of the template reaches the project, under its renamed path", () => {
  const paths = files().map((f) => f.path);
  assert.ok(NAMED_FILES.length >= 5, "the template still names its starter files");
  for (const rel of NAMED_FILES) {
    const renamed = substitutePath(rel, "zcl_my_app");
    assert.ok(paths.includes(renamed), `the scaffold writes ${renamed} (from ${rel})`);
    assert.ok(!renamed.includes(PLACEHOLDER_CLASS), `${renamed} carries the chosen name`);
  }
  // the ones this change is about, by name
  for (const needed of [
    "src/zcl_my_app.clas.abap",
    "src/zcl_my_app.clas.xml",
    "src/zcl_my_app.clas.testclasses.abap",
    ".abapgit.xml",
    "src/package.devc.xml",
  ]) {
    assert.ok(paths.includes(needed), `the scaffold writes ${needed}`);
  }
});

test("the class is renamed in both spellings, in every file the spec names", () => {
  const cls = TEMPLATE_SPEC.substitutions.class;
  assert.deepEqual([...cls.cases].sort(), ["lower", "upper"]);
  for (const rel of cls.files) {
    const content = files().find((f) => f.path === substitutePath(rel, "zcl_my_app"))!.content;
    assert.ok(!/zcl_app_001/i.test(content), `${rel}: no placeholder name survives`);
    assert.equal(
      content,
      applyClass(TEMPLATE_FILES[rel], PLACEHOLDER_CLASS, "zcl_my_app"),
      `${rel} is the template's file with the class renamed and nothing else`
    );
  }
  // the ABAP writes it lower case, the sidecar's CLSNAME upper case
  assert.match(contentOf("src/zcl_my_app.clas.abap"), /^CLASS zcl_my_app DEFINITION PUBLIC\./m);
  assert.match(contentOf("src/zcl_my_app.clas.xml"), /<CLSNAME>ZCL_MY_APP<\/CLSNAME>/);
  // the test include tests THIS class
  assert.match(contentOf("src/zcl_my_app.clas.testclasses.abap"), /TYPE REF TO zcl_my_app\b/);
});

test("the sidecar says the class has unit tests, because the project has them", () => {
  const sidecar = contentOf("src/zcl_my_app.clas.xml");
  assert.match(sidecar, /<UNICODE>X<\/UNICODE>\s*<WITH_UNIT_TESTS>X<\/WITH_UNIT_TESTS>/);
  const include = contentOf("src/zcl_my_app.clas.testclasses.abap");
  assert.match(include, /FOR TESTING/);
  assert.match(include, /INTERFACES z2ui5_if_client PARTIALLY IMPLEMENTED/);
});

test("the descriptors carry the project's name, and only that changes", () => {
  const repo = TEMPLATE_SPEC.substitutions.repo.find((t) => t.file === ".abapgit.xml");
  assert.ok(repo?.element, "the repository name is one XML element of .abapgit.xml");
  assert.match(contentOf(".abapgit.xml"), /<NAME>my-app<\/NAME>/);
  assert.equal(
    contentOf(".abapgit.xml"),
    applyElement(TEMPLATE_FILES[".abapgit.xml"], repo!.element!, "my-app")
  );
  const pkg = TEMPLATE_SPEC.substitutions.packageText.find((t) => t.file === "src/package.devc.xml");
  assert.ok(pkg, "the package text is one XML element of package.devc.xml");
  assert.match(contentOf("src/package.devc.xml"), /<CTEXT>my-app<\/CTEXT>/);
  // a package text of its own is what the template's `--package` is
  const described = scaffoldFiles("my-app", "zcl_my_app", "Tom & Jerry's").find(
    (f) => f.path === "src/package.devc.xml"
  )!.content;
  assert.match(described, /<CTEXT>Tom &amp; Jerry&apos;s<\/CTEXT>/);
  // package.json carries the name too - the spec's jsonKey substitution
  // says which key
  const json = TEMPLATE_SPEC.substitutions.repo.find((t) => t.file === "package.json");
  assert.equal(json?.jsonKey, "name");
  assert.equal(JSON.parse(contentOf("package.json")).name, "my-app");
});

test("the substitutions are the template's own, edit for edit", () => {
  // mirrored from app-template's scripts/lib/substitute.mjs
  assert.equal(applyClass("zcl_app_001 ZCL_APP_001 zcl_app_0011", "zcl_app_001", "zcl_x"), "zcl_x ZCL_X zcl_x1");
  assert.equal(applyClass("a A", "a", "b", ["upper"]), "a B");
  assert.equal(applyElement("<X><NAME>old</NAME><NAME>old</NAME></X>", "NAME", "new"), "<X><NAME>new</NAME><NAME>old</NAME></X>");
  assert.equal(applyJsonKey('{\n  "name":   "old",\n  "x": "name"\n}', "name", "new"), '{\n  "name": "new",\n  "x": "name"\n}');
  // values are escaped for where they are written, and `$&` stays literal
  assert.equal(xmlEscape(`<a & "b" 'c'>`), "&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;");
  assert.equal(applyElement("<NAME>old</NAME>", "NAME", "R&D $&"), "<NAME>R&amp;D $&amp;</NAME>");
  assert.equal(applyJsonKey('{"name": "old"}', "name", 'a"b $&'), '{"name": "a\\"b $&"}');
  assert.equal(substitutePath("src/zcl_app_001.clas.xml", "ZCL_New"), "src/zcl_new.clas.xml");
  assert.equal(substitutePath("package.json", "zcl_new"), "package.json");
});

test("the abapGit XML gets its BOM back - the snapshot holds text", () => {
  for (const rel of NAMED_FILES) {
    assert.notEqual(TEMPLATE_FILES[rel].charCodeAt(0), 0xfeff, `${rel}: no BOM in the snapshot`);
  }
  const named = new Set(NAMED_FILES.map((rel) => substitutePath(rel, "zcl_my_app")));
  for (const file of files().filter((f) => named.has(f.path))) {
    assert.equal(
      scaffoldText(file).charCodeAt(0) === 0xfeff,
      file.path.endsWith(".xml"),
      `${file.path}: a BOM exactly on the abapGit XML`
    );
  }
});

test("the starter class is the template's, so New App's gallery is not it", () => {
  const { APP_TEMPLATES } = require("../template") as typeof import("../template");
  const source = starterClassSource("zcl_my_app");
  assert.equal(source, contentOf("src/zcl_my_app.clas.abap"));
  assert.ok(
    !APP_TEMPLATES.some((t) => t.source.replace(/zcl_my_app/g, "zcl_x") === source.replace(/zcl_my_app/g, "zcl_x")),
    "the project's class comes from the snapshot, not from a copy kept in template.ts"
  );
});

/*
 * The one thing neither half of the drift gate can see: the ABAP the scaffold
 * writes has to pass the CONFIG the scaffold writes. It did not - app-template
 * switches on `chain-house-layout`, the extension's own templates were laid
 * out flat, and a project created from the IDE therefore failed its very first
 * `npm run check`. Nothing caught it because the rule is opt-in: the snippet
 * gate runs the templates without a rules block, so the rule is not even
 * produced. Here the rules come out of the scaffolded config itself, read by
 * the linter's own loader.
 */
test("the scaffolded class passes the scaffolded config", () => {
  const { runGate } = require("../gate") as typeof import("../gate");
  const { loadConfig } = require("@abap2ui5/linter/config") as {
    loadConfig: (file: string) => Record<string, unknown>;
  };
  const os = require("os") as typeof import("os");
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2ui5-scaffold-gate-"));
  try {
    const written = files();
    const file = path.join(dir, "abap2ui5lint.jsonc");
    fs.writeFileSync(
      file,
      written.find((f) => f.path === "abap2ui5lint.jsonc")!.content
    );
    const config = loadConfig(file);
    const source = written.find((f) => f.path === "src/zcl_my_app.clas.abap")!.content;
    const findings = runGate(source, "zcl_my_app.clas.abap", false, {
      minUi5: String(config.ui5 ?? "1.71"),
      distribution: String(config.distribution ?? "sapui5"),
      allow: [],
      rules: config.rules as Record<string, unknown>,
    }).findings.filter((f) => f.severity !== "hint");
    assert.deepEqual(
      findings.map((f) => `${f.type} line ${f.line ?? "?"}`),
      [],
      "a project scaffolded from the template fails its own first check"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the scaffold writes every file once", () => {
  const paths = files().map((f) => f.path);
  for (const needed of [...VERBATIM, "AGENTS.md", "docs/project.md", "README.md", "package.json", GUIDE_FILE]) {
    assert.ok(paths.includes(needed), `the scaffold writes ${needed}`);
  }
  assert.equal(new Set(paths).size, paths.length, "no path written twice");
});

test("a new project's class name follows the template's naming rule", () => {
  // template.json's substitutions.class.rule mirrors the project's
  // abaplint object_naming - a name the wizard took used to fail there
  assert.equal(projectClassNameError("zcl_my_app"), undefined);
  assert.equal(projectClassNameError("ZCX_MY_ERROR"), undefined);
  assert.match(projectClassNameError("ycl_app") ?? "", /ZCL_/);
  assert.match(projectClassNameError("zmy_app") ?? "", /ZCL_/);
});

/*
 * The generator's half. `scripts/generate-app-template.mjs` refuses to write a
 * snapshot this module could not use, and a .mjs script cannot import the
 * bundle's TypeScript - so it carries its own copy of the three landmarks of
 * the template's AGENTS.md layout and its own checks. Imported here (it only
 * runs as a program when invoked directly) so the copies cannot part and the
 * checks are exercised against the committed snapshot and against the shapes
 * they exist to refuse.
 */
test("the snapshot generator agrees with the scaffold about the template's layout, and refuses the broken shapes", async () => {
  const path = require("path") as typeof import("path");
  const { pathToFileURL } = require("url") as typeof import("url");
  const file = path.join(__dirname, "..", "scripts", "generate-app-template.mjs");
  const generator = (await import(pathToFileURL(file).href)) as {
    ESSENTIALS_BEGIN: string;
    ESSENTIALS_END: string;
    GUIDE_FILE: string;
    frameworkPin: (config: string) => string | null;
    essentialsProblems: (agents: string) => string[];
    unresolvedInvocations: (input: {
      scripts?: Record<string, string>;
      workflow?: string;
      shipped?: string[];
    }) => string[];
  };
  assert.equal(generator.ESSENTIALS_BEGIN, ESSENTIALS_BEGIN);
  assert.equal(generator.ESSENTIALS_END, ESSENTIALS_END);
  assert.equal(generator.GUIDE_FILE, GUIDE_FILE);
  assert.equal(generator.frameworkPin(TEMPLATE_FILES["abaplint.jsonc"]), frameworkPin());

  // the committed snapshot passes both checks
  const agents = TEMPLATE_FILES["AGENTS.md"];
  assert.deepEqual(generator.essentialsProblems(agents), []);
  const { scripts } = JSON.parse(TEMPLATE_FILES["package.json"]) as { scripts: Record<string, string> };
  const workflow = TEMPLATE_FILES[".github/workflows/check.yml"];
  const shipped = projectFilePaths();
  assert.deepEqual(generator.unresolvedInvocations({ scripts, workflow, shipped }), []);

  // an AGENTS.md of the OLD layout - the guide inlined below a provenance
  // marker, no essentials block - is what this change is about
  assert.match(
    generator.essentialsProblems("# AGENTS.md\n\n> **Provenance:** mirrored\n\n## 1. The model in one paragraph\n")[0],
    /0 "<!-- guide-essentials:begin" and 0 "<!-- guide-essentials:end -->"/
  );
  const block = essentialsBlock(agents);
  assert.match(generator.essentialsProblems(`${agents}\n${block}\n`)[0], /2 "<!-- guide-essentials:begin"/);
  assert.match(
    generator.essentialsProblems(`${ESSENTIALS_END}\n${ESSENTIALS_BEGIN} -->\n`)[0],
    /wrong order/
  );
  assert.match(
    generator.essentialsProblems(agents.split(GUIDE_FILE).join("docs/guide.md"))[0],
    /no longer says the whole guide is/
  );

  // a script running a file a project does not get, a chain into a script
  // that is not there, and a workflow step doing the same
  assert.deepEqual(
    generator.unresolvedInvocations({
      scripts: { check: "abaplint", rename: "node scripts/rename.mjs", all: "npm run pin && npm run check" },
      workflow: "    steps:\n      - run: npm ci\n      - name: pin\n        run: npm run check:pin\n",
      shipped: ["scripts/doctor.mjs"],
    }),
    [
      'package.json\'s "rename" script runs scripts/rename.mjs, which the template does not list as a file a project gets',
      'package.json\'s "all" script runs `npm run pin`, which package.json does not define',
      "check.yml runs `npm run check:pin`, which package.json does not define",
    ]
  );
});
