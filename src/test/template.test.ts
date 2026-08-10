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
      `${template.id} uses z2ui5_cl_ai_xml - the builder the view check reconstructs`
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
