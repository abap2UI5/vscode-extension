import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GUIDE_MARKER,
  NAMED_FILES,
  PLACEHOLDER_CLASS,
  TEMPLATE_FILES,
  TEMPLATE_SPEC,
  VERBATIM_FILES,
  applyClass,
  applyElement,
  applyJsonKey,
  frameworkPin,
  guideSection,
  linterActionRef,
  unitActionRef,
  scaffoldFiles,
  scaffoldScripts,
  scaffoldText,
  starterClassSource,
  substitutePath,
} from "../scaffold";

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

test("the verbatim list is app-template's, minus what the scaffold composes", () => {
  // A hand-kept list here would go stale the moment app-template adds a file,
  // and a project would quietly be missing it. This is the shape of that guard:
  // everything the template calls shared is either copied or composed.
  const composed = TEMPLATE_SPEC.files.shared.filter((f) => !VERBATIM.includes(f));
  assert.deepEqual(composed.sort(), [
    ".github/workflows/check.yml",
    "AGENTS.md",
    "package.json",
  ]);
  assert.ok(VERBATIM.length > 0, "the template still hands out files to copy");
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

test("the dependency versions are the template's, not a second copy of them", () => {
  const template = JSON.parse(TEMPLATE_FILES["package.json"]) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const scaffolded = JSON.parse(contentOf("package.json")) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.deepEqual(
    scaffolded.devDependencies,
    template.devDependencies,
    "every gate is the version app-template installs"
  );
  for (const [name, body] of Object.entries(scaffolded.scripts)) {
    // A body is the template's, or the template's with the links into a
    // dropped script taken out - never a third thing written here.
    const segments = new Set(template.scripts[name]?.split("&&").map((s) => s.trim()));
    for (const segment of body.split("&&").map((s) => s.trim())) {
      assert.ok(
        segments.has(segment),
        `script "${name}" runs \`${segment}\`, which app-template's "${name}" does not`
      );
    }
  }
  // The one the scaffold drops on purpose: it runs a file out of the
  // template's scripts/ directory, which a scaffolded project does not get.
  for (const dropped of ["check:pin"]) {
    assert.equal(scaffolded.scripts[dropped], undefined, `"${dropped}" is not offered`);
  }
  assert.ok(scaffolded.scripts.check, "one command still runs the gates");
  // And every script it DOES offer can run: a body chaining `npm run` into a
  // script the project does not have is one that dies with "missing script".
  for (const [name, body] of Object.entries(scaffolded.scripts)) {
    for (const [, target] of body.matchAll(/\bnpm\s+run\s+([\w:.@/-]+)/g)) {
      assert.ok(
        scaffolded.scripts[target],
        `"${name}" runs \`npm run ${target}\`, which this project has`
      );
    }
  }
});

test("a script that chains into a dropped one is rewritten, not shipped broken", () => {
  // app-template's own shape: `check:all` chains through `check:pin`, which
  // runs a file out of its scripts/ directory and is therefore not scaffolded.
  assert.deepEqual(
    scaffoldScripts({
      check: "abap2ui5lint",
      "check:pin": "node scripts/check-pin.mjs",
      "check:all": "npm run check:pin && npm run check",
      test: "npm run check:all",
    }),
    { check: "abap2ui5lint", "check:all": "npm run check", test: "npm run check:all" }
  );
  // A body that was NOTHING but the dropped link goes with it, and so does
  // whatever was only reachable through it - resolved to a fixpoint.
  assert.deepEqual(
    scaffoldScripts({
      rename: "node scripts/rename.mjs",
      "rename:all": "npm run rename",
      test: "npm run rename:all",
    }),
    {}
  );
});

test("no scaffolded file names a linter version of its own", () => {
  // The failure mode literally: `"@abap2ui5/linter": "^0.1.1"` sat in this
  // file's package.json literal while app-template had moved to ^0.2.1. A
  // version written anywhere in the scaffold has to be the template's.
  const want = (JSON.parse(TEMPLATE_FILES["package.json"]) as {
    devDependencies: Record<string, string>;
  }).devDependencies["@abap2ui5/linter"];
  for (const file of files()) {
    for (const [, found] of file.content.matchAll(/"@abap2ui5\/linter":\s*"([^"]+)"/g)) {
      assert.equal(found, want, `${file.path} names linter ${found}, app-template says ${want}`);
    }
  }
});

test("the CI workflow runs the app's unit tests through the same pinned mcp-server action app-template runs", () => {
  const ref = unitActionRef();
  assert.ok(ref, "app-template's workflow carries the unit job, so the scaffold's must too");
  assert.match(ref!, /^abap2UI5\/mcp-server@[0-9a-f]{40} # v\d+$/, "pinned to a commit, the major tag in the comment");
  const workflow = contentOf(".github/workflows/check.yml");
  assert.ok(workflow.includes(`uses: ${ref}`), "the scaffolded workflow runs the same pin");
  assert.match(workflow, /^  unit:\n    runs-on: ubuntu-latest/m, "as a job of its own");
  assert.match(workflow, /paths: src/);
  // and the local form is a script a project keeps: npx, not a template-only file
  assert.match(contentOf("package.json"), /"test:unit": "npx --yes -p @abap2ui5\/mcp-server abap2ui5-unit src"/);
});

test("the CI workflow runs the same pinned linter action app-template runs", () => {
  const ref = linterActionRef();
  assert.match(
    ref,
    /^abap2UI5\/linter@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
    "the action is pinned to a commit with its tag in the comment - the template's convention"
  );
  assert.ok(
    TEMPLATE_FILES[".github/workflows/check.yml"].includes(ref),
    "the pin comes out of app-template's workflow"
  );
  assert.ok(
    contentOf(".github/workflows/check.yml").includes(`uses: ${ref}`),
    "and is what the scaffolded workflow uses"
  );
  // Every script the workflow calls has to exist in the project it is written
  // into - the template's own workflow runs a `check:pin` this one must not.
  const workflow = contentOf(".github/workflows/check.yml");
  const scripts = (JSON.parse(contentOf("package.json")) as { scripts: Record<string, string> })
    .scripts;
  for (const [, name] of workflow.matchAll(/npm run ([\w:-]+)/g)) {
    assert.ok(scripts[name], `the workflow runs "npm run ${name}", which this project has`);
  }
});

test("a scaffolded project carries the app-building guide, verbatim", () => {
  const guide = guideSection();
  assert.ok(
    guide.startsWith(GUIDE_MARKER),
    "the guide starts at app-template's provenance block"
  );
  assert.ok(guide.length > 20000, `the whole guide travels (${guide.length} chars)`);
  const agents = contentOf("AGENTS.md");
  assert.ok(agents.endsWith(guide), "AGENTS.md ends with app-template's guide, unedited");
  // and the head above it describes THIS project, not the template's
  const head = agents.slice(0, agents.length - guide.length);
  assert.ok(head.includes("zcl_my_app"), "the head names the class that was created");
  assert.ok(!head.includes("zcl_app_001"), "and not app-template's starter class");
  // and the commands it tells the reader to run are commands this project has
  // (app-template's head also lists `npm run rename` and `npm run check:pin`,
  // neither of which is scaffolded)
  const scripts = (JSON.parse(contentOf("package.json")) as { scripts: Record<string, string> })
    .scripts;
  const block = /```bash\n([\s\S]*?)```/.exec(head);
  assert.ok(block, "the head has a build-and-verify block");
  for (const [, name] of block[1].matchAll(/npm run ([\w:-]+)/g)) {
    assert.ok(scripts[name], `the head tells the reader to run "npm run ${name}"`);
  }
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
    if (!NAMED_FILES.includes(rel)) {
      continue; // AGENTS.md is composed here, its head names the class itself
    }
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
  // the composed package.json carries the name too - the spec's jsonKey
  // substitution says which key, and the composed file agrees with it
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
  for (const needed of [...VERBATIM, "AGENTS.md", "README.md", "package.json"]) {
    assert.ok(paths.includes(needed), `the scaffold writes ${needed}`);
  }
  assert.equal(new Set(paths).size, paths.length, "no path written twice");
});
