import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_TEMPLATES } from "../template";
import {
  GUIDE_MARKER,
  TEMPLATE_FILES,
  frameworkPin,
  guideSection,
  linterActionRef,
  scaffoldFiles,
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

const FIRST = APP_TEMPLATES[0];
const files = (): ReturnType<typeof scaffoldFiles> =>
  scaffoldFiles("my-app", "zcl_my_app", FIRST);
const contentOf = (path: string): string => {
  const file = files().find((f) => f.path === path);
  assert.ok(file, `the scaffold writes ${path}`);
  return file.content;
};

/** The files a project takes from app-template unchanged. */
const VERBATIM = [
  "abaplint.jsonc",
  "abap2ui5lint.jsonc",
  ".claude/settings.json",
  ".gitattributes",
  ".gitignore",
  ".github/dependabot.yml",
];

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
    assert.equal(
      body,
      template.scripts[name],
      `script "${name}" says something different here than in app-template`
    );
  }
  // The two the scaffold drops on purpose: they run files out of the
  // template's scripts/ directory, which a scaffolded project does not get.
  for (const dropped of ["rename", "check:pin"]) {
    assert.equal(scaffolded.scripts[dropped], undefined, `"${dropped}" is not offered`);
  }
  assert.ok(scaffolded.scripts.check, "one command still runs the gates");
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
  const read = new Set([
    ...VERBATIM,
    "AGENTS.md",
    "package.json",
    ".github/workflows/check.yml",
  ]);
  assert.deepEqual(
    Object.keys(TEMPLATE_FILES).sort(),
    [...read].sort(),
    "every snapshot file is one the scaffold copies or reads a value out of"
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
    for (const template of APP_TEMPLATES) {
      const written = scaffoldFiles("my-app", "zcl_my_app", template);
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
        `template "${template.id}": a project scaffolded from it fails its own first check`
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every template still scaffolds the same project around its class", () => {
  for (const template of APP_TEMPLATES) {
    const paths = scaffoldFiles("my-app", "zcl_my_app", template).map((f) => f.path);
    for (const needed of [...VERBATIM, "AGENTS.md", "README.md", "package.json"]) {
      assert.ok(paths.includes(needed), `${template.id}: the scaffold writes ${needed}`);
    }
    assert.equal(new Set(paths).size, paths.length, `${template.id}: no path written twice`);
  }
});
