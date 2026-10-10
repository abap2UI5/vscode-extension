import { test } from "node:test";
import assert from "node:assert/strict";
import appTemplate from "../data/app-template.json";
import {
  appTemplateLoaded,
  loadAppTemplate,
  setAppTemplate,
  templateFiles,
  templateSpec,
} from "../scaffold";

/*
 * The app-template snapshot is read from next to the bundle on first use
 * (`apptemplatefile.ts`), not imported: this file pins the registry that
 * hands it in - its own bundle, so the module starts unloaded here, unlike
 * in scaffold.test.ts.
 */

test("asking before the snapshot is in is an error that says so", () => {
  assert.equal(appTemplateLoaded(), false);
  assert.throws(() => templateFiles(), /loadAppTemplate/);
  assert.throws(() => templateSpec(), /loadAppTemplate/);
});

test("a file that is not a snapshot is refused whole", () => {
  for (const foreign of [null, 42, {}, { files: {} }, { files: {}, template: {} }, { template: appTemplate.template }]) {
    assert.throws(() => setAppTemplate(foreign), /not an app-template snapshot/);
  }
  assert.equal(appTemplateLoaded(), false);
});

test("loadAppTemplate reads once, shares the read, and retries after a failure", async () => {
  let reads = 0;
  const failing = loadAppTemplate(async () => {
    reads++;
    throw new Error("no such file");
  });
  await assert.rejects(failing, /no such file/);
  assert.equal(appTemplateLoaded(), false, "a failed read leaves nothing behind");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const read = async () => {
    reads++;
    await gate;
    return JSON.stringify(appTemplate);
  };
  const a = loadAppTemplate(read);
  const b = loadAppTemplate(read);
  release();
  await Promise.all([a, b]);
  assert.equal(reads, 2, "the failed read, then ONE shared read for both callers");
  assert.equal(appTemplateLoaded(), true);
  await loadAppTemplate(read);
  assert.equal(reads, 2, "loaded is loaded");
  assert.equal(templateFiles()["abaplint.jsonc"], appTemplate.files["abaplint.jsonc"]);
  assert.equal(templateSpec().placeholderClass, appTemplate.template.placeholderClass);
});
