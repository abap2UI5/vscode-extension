import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareAbap } from "@abap2ui5/linter/reconstruct";
import { APP_TEMPLATE, APP_TEMPLATES, templateSource } from "../template";
import { whenBranchOf } from "../context";
import { isAppClass, usesBuilder } from "../abap";
import { modelRootsOfSource } from "../previewcore";

/*
 * The template gallery as a contract. `snippets.test.ts` already proves
 * every template passes the bundled linter; these pin the properties the
 * extension itself builds on: the wizard's renaming, the corpus recipe
 * (dispatch, events handled, model_init last), and that the view check can
 * actually reconstruct what the wizard hands out.
 */

test("the gallery is well-formed: unique ids, labels, descriptions", () => {
  const ids = APP_TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const template of APP_TEMPLATES) {
    assert.ok(template.label.trim(), `${template.id} has a label`);
    assert.ok(template.description.trim(), `${template.id} has a description`);
    assert.ok(template.source.trim(), `${template.id} has a source`);
  }
});

test("the plain skeleton is the gallery's first entry", () => {
  assert.equal(APP_TEMPLATES[0].source, APP_TEMPLATE);
  assert.equal(APP_TEMPLATES[0].id, "empty");
});

test("every template is an app class building views with the ai builder", () => {
  for (const template of APP_TEMPLATES) {
    assert.ok(
      isAppClass(template.source),
      `${template.id} implements z2ui5_if_app`
    );
    assert.ok(
      usesBuilder(template.source),
      `${template.id} uses z2ui5_cl_ui5_view_builder - the builder the view check reconstructs`
    );
    assert.ok(
      !/z2ui5_cl_xml_view/i.test(template.source),
      `${template.id} does not teach the old builder`
    );
  }
});

test("the view check can reconstruct every template's view", () => {
  for (const template of APP_TEMPLATES) {
    const prep = prepareAbap(template.source);
    assert.ok(prep.usesBuilder, `${template.id} is reconstructable`);
    assert.ok(prep.nodes.length > 0, `${template.id} reconstructs to nodes`);
    // each document sits in a synthetic wrapper node (name null)
    const roots = prep.nodes.flatMap((n) =>
      n.name ? [n.name] : n.children.map((c) => c.name)
    );
    assert.ok(roots.length > 0, `${template.id} has a reconstructed root`);
    assert.ok(
      roots.every((name) => name === "View" || name === "Dialog"),
      `${template.id} roots are views or dialogs, got: ${roots.join(", ")}`
    );
  }
});

test("every event a template raises has a WHEN branch handling it", () => {
  for (const template of APP_TEMPLATES) {
    const events = [
      ...template.source.matchAll(/client->_event\(\s*(?:val\s*=\s*)?`(\w+)`/g),
    ].map((m) => m[1]);
    for (const event of events) {
      assert.notEqual(
        whenBranchOf(template.source, event),
        undefined,
        `template "${template.id}" raises ${event} but never handles it`
      );
    }
  }
});

test("every bound attribute is a declared model root", () => {
  // what the stateful reload would restore - the templates must declare
  // what they bind, or the derived shape (and the binding check) go empty
  for (const template of APP_TEMPLATES) {
    const binds = [
      ...template.source.matchAll(/client->_bind\(\s*(\w+)\s*\)/g),
    ].map((m) => m[1]);
    if (!binds.length) {
      continue;
    }
    const roots = modelRootsOfSource(template.source);
    for (const bound of binds) {
      assert.ok(
        roots.some((root) => root.toLowerCase() === bound.toLowerCase()),
        `template "${template.id}" binds ${bound}, which is not in its derived model (${roots.join(", ")})`
      );
    }
  }
});

test("model_init goes last where a template has one - the corpus recipe", () => {
  for (const template of APP_TEMPLATES) {
    const methods = [
      ...template.source.matchAll(/^\s*METHOD\s+([\w~]+)\s*\./gim),
    ].map((m) => m[1].toLowerCase());
    if (methods.includes("model_init")) {
      assert.equal(
        methods[methods.length - 1],
        "model_init",
        `template "${template.id}" keeps model_init last`
      );
    }
  }
});

test("the wizard renames the class case-insensitively and everywhere", () => {
  for (const template of APP_TEMPLATES) {
    const renamed = templateSource(template, "ZCL_Mixed_Case");
    assert.ok(!/zcl_my_app/i.test(renamed), "no old name survives");
    assert.match(renamed, /CLASS zcl_mixed_case DEFINITION PUBLIC/);
    // the implementation half is renamed too
    assert.match(renamed, /CLASS zcl_mixed_case IMPLEMENTATION/);
  }
});

/*
 * The project scaffold. What matters is not that files appear but that the
 * result is a project the gates accept: the config the extension itself
 * looks for, an abapGit sidecar whose CLSNAME matches its file name, and a
 * class that passes the bundled linter - the same bar the single-class
 * templates are held to.
 */
test("the project scaffold writes what a project needs", () => {
  const { scaffoldFiles } = require("../scaffold") as typeof import("../scaffold");
  for (const template of APP_TEMPLATES) {
    const files = scaffoldFiles("my-app", "zcl_my_app", template);
    const paths = files.map((f) => f.path);
    for (const needed of [
      "abap2ui5lint.jsonc",   // the one the extension searches for
      "abaplint.jsonc",
      "package.json",
      ".abapgit.xml",
      "src/package.devc.xml",
      "src/zcl_my_app.clas.abap",
      "src/zcl_my_app.clas.xml",
      ".github/workflows/check.yml",
    ]) {
      assert.ok(paths.includes(needed), `${template.id}: scaffold has ${needed}`);
    }

    const xml = files.find((f) => f.path === "src/zcl_my_app.clas.xml")!;
    assert.match(xml.content, /<CLSNAME>ZCL_MY_APP<\/CLSNAME>/,
      `${template.id}: the sidecar names the class its file is named after`);
    assert.equal(xml.bom, true, `${template.id}: abapGit XML is written with a BOM`);

    const cfg = files.find((f) => f.path === "abap2ui5lint.jsonc")!.content;
    assert.match(cfg, /"render":\s*true/,
      `${template.id}: the render gate is ASKED for, so a missing runtime fails`);

    const pkg = JSON.parse(files.find((f) => f.path === "package.json")!.content);
    assert.ok(pkg.scripts.check, `${template.id}: there is one command that runs the gates`);
    assert.ok(pkg.devDependencies["@abap2ui5/linter"], `${template.id}: the linter is pinned`);
  }
});

/* The generated CONFIG is the half nothing checked. `snippets.test.ts` lints
 * every template's SOURCE, but a project is only usable if the files written
 * around it parse too - and a rule id that the linter later renames, or a
 * stray comma in the JSONC, turns "New Project from Template" into a project
 * that fails on its first `npm run check`. The linter's own loader is what
 * decides, so it is what this asks. */
test("the scaffolded configs are ones the tools accept", () => {
  const { scaffoldFiles } = require("../scaffold") as typeof import("../scaffold");
  const { loadConfig } = require("@abap2ui5/linter/config") as {
    loadConfig: (file: string) => Record<string, unknown>;
  };
  const os = require("os") as typeof import("os");
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2ui5-scaffold-"));
  try {
    for (const template of APP_TEMPLATES) {
      const files = scaffoldFiles("my-app", "zcl_my_app", template);

      const lintFile = path.join(dir, "abap2ui5lint.jsonc");
      fs.writeFileSync(lintFile, files.find((f) => f.path === "abap2ui5lint.jsonc")!.content);
      // throws with a precise message on an unknown key, a bad rule id or
      // malformed JSONC - which is exactly what has to fail here, not later
      const cfg = loadConfig(lintFile);
      assert.equal(cfg.render, true, `${template.id}: the render gate stays asked-for`);

      /* The scaffolded abaplint config IS abap2UI5/app-template's - copied out
       * of `src/data/app-template.json`, and `scaffold.test.ts` is what holds
       * the two together. What is checked here is that the copy still arrives
       * as a usable rule set at all: the size, and the four rules whose
       * absence would be hardest to notice in a starter project (an unchecked
       * sy-subrc, a type that does not activate on 7.02, a SELECT without
       * ORDER BY, a void type on cloud). */
      const abaplint = files.find((f) => f.path === "abaplint.jsonc")!.content;
      const ruleCount = (abaplint.match(/^\s{4}"[a-z_0-9]+":/gm) || []).length;
      assert.ok(
        ruleCount >= 70,
        `${template.id}: the curated core is still there (${ruleCount} rules, expected >= 70)`
      );
      for (const rule of ["check_subrc", "fully_type_itabs", "select_add_order_by", "forbidden_void_type"]) {
        assert.match(abaplint, new RegExp(`"${rule}"`), `${template.id}: ${rule} is in the core`);
      }

      for (const jsonc of ["abaplint.jsonc"]) {
        const raw = files.find((f) => f.path === jsonc)!.content;
        const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
        assert.doesNotThrow(() => JSON.parse(stripped), `${template.id}: ${jsonc} parses`);
      }

      const workflow = files.find((f) => f.path === ".github/workflows/check.yml")!.content;
      assert.match(workflow, /npm ci/, `${template.id}: CI installs before it checks`);
      const pkg = JSON.parse(files.find((f) => f.path === "package.json")!.content);
      for (const script of Object.values(pkg.scripts as Record<string, string>)) {
        for (const step of script.split("&&").map((s) => s.trim())) {
          const inner = step.startsWith("npm run ") ? step.slice(8) : null;
          if (inner) {
            assert.ok(pkg.scripts[inner], `${template.id}: "${step}" names a script that exists`);
          }
        }
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the scaffolded class is the same class the templates are", () => {
  const { scaffoldFiles } = require("../scaffold") as typeof import("../scaffold");
  for (const template of APP_TEMPLATES) {
    const files = scaffoldFiles("my-app", "zcl_my_app", template);
    const source = files.find((f) => f.path === "src/zcl_my_app.clas.abap")!.content;
    assert.ok(isAppClass(source), `${template.id}: scaffolded class implements z2ui5_if_app`);
    assert.ok(usesBuilder(source), `${template.id}: scaffolded class uses the current builder`);
    assert.ok(source.includes("zcl_my_app"), `${template.id}: the class carries the chosen name`);
    assert.ok(!source.includes("zcl_my_app".toUpperCase() + " DEFINITION"),
      `${template.id}: the ABAP keeps the lower-case name the file is named after`);
    // the same reconstruction bar the single-class templates are held to
    const prep = prepareAbap(source);
    assert.ok(prep.usesBuilder && prep.nodes.length > 0,
      `${template.id}: the view check can reconstruct what the scaffold writes`);
  }
});

/*
 * abapGit serializes its XML with a UTF-8 BOM. A scaffold that writes those
 * files without one produces a repository that comes back changed on the
 * first pull, for every developer - and the missing character is invisible in
 * every diff that would show it.
 */
test("the abapGit XML carries a BOM and nothing else does", () => {
  const { scaffoldFiles, scaffoldText } = require("../scaffold") as typeof import("../scaffold");
  const files = scaffoldFiles("my-app", "zcl_my_app", APP_TEMPLATES[0]);
  const withBom = files.filter((f) => scaffoldText(f).charCodeAt(0) === 0xfeff);
  assert.deepEqual(
    withBom.map((f) => f.path).sort(),
    [".abapgit.xml", "src/package.devc.xml", "src/zcl_my_app.clas.xml"],
    "exactly the abapGit-serialized files"
  );
  for (const file of withBom) {
    assert.ok(
      scaffoldText(file).startsWith(
        String.fromCharCode(0xfeff) + '<?xml version="1.0" encoding="utf-8"?>'
      ),
      `${file.path}: the BOM sits before the declaration, not inside it`
    );
  }
});

test("a folder name becomes a usable npm/package name", () => {
  const { projectNameFrom } = require("../scaffold") as typeof import("../scaffold");
  assert.equal(projectNameFrom("My App"), "my-app");
  assert.equal(projectNameFrom(".hidden"), "hidden");
  assert.equal(projectNameFrom("ok-name"), "ok-name");
  assert.equal(projectNameFrom("***"), "abap2ui5-app", "never an empty name");
});
