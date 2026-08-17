import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutGraph, navGraph, navMapSvg, navTargetsOf } from "../navmap";

function app(name: string, body = ""): { fileName: string; source: string } {
  return {
    fileName: `${name.toLowerCase()}.clas.abap`,
    source: `CLASS ${name.toLowerCase()} DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
ENDCLASS.
CLASS ${name.toLowerCase()} IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    ${body}
  ENDMETHOD.
ENDCLASS.`,
  };
}

test("navTargetsOf reads NEW and factory forms, skips noise words", () => {
  assert.deepEqual(
    navTargetsOf("client->nav_app_call( NEW zcl_next_app( ) )."),
    ["ZCL_NEXT_APP"]
  );
  assert.deepEqual(
    navTargetsOf("client->nav_app_call( zcl_other=>factory( 42 ) )."),
    ["ZCL_OTHER"]
  );
  assert.deepEqual(
    navTargetsOf("client->nav_app_leave( client->get_app_prev( ) )."),
    []
  );
});

test("navGraph builds nodes for apps and external targets", () => {
  const graph = navGraph([
    app("ZCL_HOME", "client->nav_app_call( NEW zcl_detail( ) )."),
    app("ZCL_DETAIL", "client->nav_app_call( NEW zcl_unknown( ) )."),
    { fileName: "helper.clas.abap", source: "CLASS zcl_helper DEFINITION PUBLIC.\nENDCLASS." },
  ]);
  assert.deepEqual(
    graph.nodes.map((n) => [n.className, n.isApp]),
    [
      ["ZCL_HOME", true],
      ["ZCL_DETAIL", true],
      ["ZCL_UNKNOWN", false],
    ]
  );
  assert.deepEqual(graph.edges, [
    { from: "ZCL_HOME", to: "ZCL_DETAIL" },
    { from: "ZCL_DETAIL", to: "ZCL_UNKNOWN" },
  ]);
});

test("layoutGraph puts roots left and targets one column right", () => {
  const layout = layoutGraph(
    navGraph([
      app("ZCL_HOME", "client->nav_app_call( NEW zcl_detail( ) )."),
      app("ZCL_DETAIL"),
    ])
  );
  const home = layout.nodes.find((n) => n.className === "ZCL_HOME")!;
  const detail = layout.nodes.find((n) => n.className === "ZCL_DETAIL")!;
  assert.ok(home.x < detail.x);
  assert.equal(layout.edges.length, 1);
  assert.ok(layout.width > 0 && layout.height > 0);
});

test("a navigation cycle still lays out instead of looping", () => {
  const layout = layoutGraph(
    navGraph([
      app("ZCL_A", "client->nav_app_call( NEW zcl_b( ) )."),
      app("ZCL_B", "client->nav_app_call( NEW zcl_a( ) )."),
    ])
  );
  assert.equal(layout.nodes.length, 2);
});

test("the SVG carries clickable app nodes and escapes names", () => {
  const svg = navMapSvg(
    layoutGraph(
      navGraph([app("ZCL_HOME", "client->nav_app_call( NEW zcl_detail( ) ).")])
    )
  );
  assert.ok(svg.includes('data-file="zcl_home.clas.abap"'));
  assert.ok(svg.includes(">ZCL_HOME</text>"));
  assert.ok(svg.includes('class="node ext"')); // the unresolved target
  assert.ok(svg.includes('marker-end="url(#arrow)"'));
});

test("a namespaced class is a nav target", () => {
  // regression: the word pattern could only start at a letter, so `/dmo/...`
  // never matched and the edge silently vanished from the map
  const targets = navTargetsOf(
    "client->nav_app_call( NEW /dmo/cl_travel_app( ) )."
  );
  assert.deepEqual(targets, ["/DMO/CL_TRAVEL_APP"]);
});

test("an ordinary target still resolves next to a namespaced one", () => {
  assert.deepEqual(
    navTargetsOf("client->nav_app_call( NEW zcl_next( ) )."),
    ["ZCL_NEXT"]
  );
});
