import { test } from "node:test";
import assert from "node:assert/strict";
import { blobUrl, catalogueUrl, matchCatalogue, parseCatalogue } from "../catalogue";
import samples from "./fixtures/catalogue-samples.json";
import samplesControls from "./fixtures/catalogue-samples-controls.json";
import samplesStack from "./fixtures/catalogue-samples-stack.json";

/*
 * The committed `catalogue.json` of each sample repository is an external
 * contract, and the three are siblings rather than one format. The fixtures
 * are trimmed REAL excerpts - one per repository - pinning exactly the shape
 * differences the parser bridges: "samples" vs "ports" as the list, "file"
 * vs "path" as the location, keywords as array vs space-separated string.
 * A repository changing its catalogue shape fails here, not in a user's
 * QuickPick.
 */

const SAMPLES = JSON.stringify(samples);
const CONTROLS = JSON.stringify(samplesControls);
const STACK = JSON.stringify(samplesStack);

test("all three real catalogue shapes parse into the same entries", () => {
  const fromSamples = parseCatalogue(SAMPLES);
  assert.equal(fromSamples.length, 3);
  assert.equal(fromSamples[0].className, "z2ui5_cl_smp_app_493");
  assert.equal(fromSamples[0].file, "src/01/z2ui5_cl_smp_app_493.clas.abap");
  assert.ok(fromSamples[0].keywords.includes("hello"));

  // samples-controls lists under "ports", keywords as one string, plus entity
  const fromControls = parseCatalogue(CONTROLS);
  assert.equal(fromControls.length, 4);
  const table = fromControls.find((e) => e.entity === "sap.m.Table");
  assert.ok(table);
  assert.equal(table.file, "src/02/01/z2ui5_cl_smpc_app_092.clas.abap");
  assert.ok(table.keywords.includes("table"));

  // samples-stack names the location "path", not "file"
  const fromStack = parseCatalogue(STACK);
  assert.equal(fromStack.length, 2);
  assert.equal(fromStack[0].file, "src/z2ui5_cl_smps_app_000.clas.abap");
});

test("rows that are not sample entries do not leak in", () => {
  // samples-stack's "packages" is also a top-level array of objects - but its
  // rows carry no class, so they must not become entries
  const entries = parseCatalogue(STACK);
  assert.ok(entries.every((e) => e.className.toLowerCase().startsWith("z2ui5_cl_")));
});

test("unknown fields and unknown sections are ignored, not fatal", () => {
  const grown = JSON.stringify({
    ...(samplesControls as object),
    futureSection: [{ shape: "unknown" }],
    ports: (samplesControls as { ports: object[] }).ports.map((p) => ({
      ...p,
      addedLater: { nested: true },
    })),
  });
  assert.equal(parseCatalogue(grown).length, 4);
});

test("broken or foreign JSON is an empty catalogue, not an exception", () => {
  assert.deepEqual(parseCatalogue("not json at all"), []);
  assert.deepEqual(parseCatalogue("[1,2,3]"), []);
  assert.deepEqual(parseCatalogue('{"samples": [{"title": "no class or file"}]}'), []);
});

test("the demonstrated entity is the strongest match", () => {
  const hits = matchCatalogue(parseCatalogue(CONTROLS), "sap.m.Table", "samples-controls");
  assert.ok(hits.length >= 2);
  // the exact entity beats the grid table, which beats keyword-only mentions
  assert.equal(hits[0].entity, "sap.m.Table");
  assert.equal(hits[1].entity, "sap.ui.table.Table");
  assert.ok(hits[0].score > hits[1].score);
});

test("a bare control name still finds the entity ports", () => {
  const hits = matchCatalogue(parseCatalogue(CONTROLS), "Table", "samples-controls");
  assert.ok(hits.some((h) => h.entity === "sap.m.Table"));
  assert.ok(hits.some((h) => h.entity === "sap.ui.table.Table"));
});

test("catalogues without entities answer through their keywords", () => {
  const hits = matchCatalogue(parseCatalogue(SAMPLES), "Table", "samples");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].className, "z2ui5_cl_smp_app_144");
});

test("a name that merely CONTAINS the search is not a hit", () => {
  // the same distinction the source search draws: Table vs TableSelectDialog
  const entries = parseCatalogue(
    JSON.stringify({
      samples: [
        {
          class: "z2ui5_cl_smp_app_001",
          file: "src/01/z2ui5_cl_smp_app_001.clas.abap",
          title: "TableSelectDialog",
          summary: "a TableSelectDialog demo",
          keywords: ["tableselectdialog"],
        },
      ],
    })
  );
  assert.deepEqual(matchCatalogue(entries, "Table", "samples"), []);
});

test("a hit knows where it opens without a checkout", () => {
  const [hit] = matchCatalogue(parseCatalogue(CONTROLS), "sap.m.Table", "samples-controls");
  assert.equal(
    hit.url,
    "https://github.com/abap2UI5/samples-controls/blob/main/src/02/01/z2ui5_cl_smpc_app_092.clas.abap"
  );
  assert.equal(
    catalogueUrl("samples"),
    "https://raw.githubusercontent.com/abap2UI5/samples/main/catalogue.json"
  );
  assert.equal(blobUrl("samples", "a/b.clas.abap"), "https://github.com/abap2UI5/samples/blob/main/a/b.clas.abap");
});

test("the list stays bounded however big the catalogue grows", () => {
  const big = {
    samples: Array.from({ length: 50 }, (_, i) => ({
      class: `z2ui5_cl_smp_app_${100 + i}`,
      file: `src/01/z2ui5_cl_smp_app_${100 + i}.clas.abap`,
      title: "Table demo",
      summary: "a table",
      keywords: ["table"],
    })),
  };
  assert.equal(matchCatalogue(parseCatalogue(JSON.stringify(big)), "Table", "samples").length, 8);
});
