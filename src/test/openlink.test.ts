import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { inflateCode, MAX_SOURCE, parseOpenUri, readCapped, sourceUrl } from "../openlink";

const HELLO =
  "CLASS zcl_hello DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    INTERFACES z2ui5_if_app.\nENDCLASS.\n";

/** What the layout editor's "Open in VS Code" wrote for HELLO (src/handoff.js there). */
const EDITOR_LINK =
  "vscode://abap2ui5.abap2ui5/open?code=c_ZxDA5WqErOic9IzcnJV3BxdfP08wzx9PdTCAh18vF01uNSgLIUgl2dQRIgEQUFT78Q1yA3R2fXYIUqo9JM0_jMtPjEggI9Llc_F2eQoXpcAA&name=zcl_hello.clas.abap";

const base64url = (bytes: Buffer) =>
  bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("the layout editor's link opens its class", async () => {
  const request = parseOpenUri(EDITOR_LINK);
  assert.equal(request.kind, "inline");
  if (request.kind !== "inline") return;
  assert.equal(request.name, "zcl_hello.clas.abap");
  assert.equal(await inflateCode(request.code), HELLO);
});

test("a class deflated here comes back byte for byte, umlauts and all", async () => {
  const source = HELLO.replace("PUBLIC.", "PUBLIC. \" Größe – ünïcode");
  const code = base64url(deflateRawSync(Buffer.from(source, "utf8")));
  const request = parseOpenUri(`vscode://abap2ui5.abap2ui5/open?code=${code}&name=ZCL_HELLO.clas.abap`);
  assert.equal(request.kind, "inline");
  if (request.kind !== "inline") return;
  assert.equal(request.name, "zcl_hello.clas.abap", "the file name in lower case");
  assert.equal(await inflateCode(request.code), source);
});

test("src= takes GitHub's raw hosts over https, and a github.com file page", () => {
  const raw = "https://raw.githubusercontent.com/abap2UI5/samples/main/src/z2ui5_cl_smp_app_493.clas.abap";
  assert.deepEqual(parseOpenUri(`vscode://abap2ui5.abap2ui5/open?src=${encodeURIComponent(raw)}`), {
    kind: "url",
    name: "z2ui5_cl_smp_app_493.clas.abap",
    url: raw,
  });
  assert.equal(
    sourceUrl("https://github.com/abap2UI5/samples/blob/main/src/z2ui5_cl_smp_app_493.clas.abap"),
    raw
  );
  const named = parseOpenUri(
    `vscode://abap2ui5.abap2ui5/open?src=${encodeURIComponent("https://gist.githubusercontent.com/u/abc/raw/app")}&name=zcl_gist.clas.abap`
  );
  assert.equal(named.kind, "url");
  assert.equal(named.kind === "url" && named.name, "zcl_gist.clas.abap");
});

test("what a link may not ask for is refused with the reason", () => {
  const refused = (uri: string, why: RegExp) => {
    const r = parseOpenUri(uri);
    assert.equal(r.kind, "error", uri);
    assert.match(r.kind === "error" ? r.message : "", why, uri);
  };
  const src = (u: string) => `vscode://abap2ui5.abap2ui5/open?src=${encodeURIComponent(u)}`;
  refused("vscode://abap2ui5.abap2ui5/run?code=abc&name=zcl_x.clas.abap", /opens classes with \/open/);
  refused("vscode://abap2ui5.abap2ui5/open", /neither code= nor src=/);
  refused("vscode://abap2ui5.abap2ui5/open?code=abc&src=https://raw.githubusercontent.com/a/b/c/zcl_x.clas.abap", /one of them/);
  refused("vscode://abap2ui5.abap2ui5/open?code=abc", /not the file name of a class/);
  refused("vscode://abap2ui5.abap2ui5/open?code=abc&name=../../etc/zcl_x.clas.abap", /not the file name/);
  refused("vscode://abap2ui5.abap2ui5/open?code=abc&name=zcl_x.abap", /not the file name/);
  refused("vscode://abap2ui5.abap2ui5/open?code=a%2Bb&name=zcl_x.clas.abap", /not base64url/);
  refused(src("http://raw.githubusercontent.com/a/b/main/zcl_x.clas.abap"), /over https/);
  refused(src("https://example.com/zcl_x.clas.abap"), /not from example.com/);
  refused(src("https://127.0.0.1:8000/zcl_x.clas.abap"), /not from 127.0.0.1:8000/);
  refused(src("https://user:pw@raw.githubusercontent.com/a/b/main/zcl_x.clas.abap"), /no user name or password/);
  refused(src("https://raw.githubusercontent.com/a/b/main/README.md"), /does not name a class file/);
});

test("a link that unpacks to too much, or to nothing readable, says so", async () => {
  const bomb = base64url(deflateRawSync(Buffer.alloc(MAX_SOURCE + 1, 0x20)));
  await assert.rejects(inflateCode(bomb), /more code than a class link carries/);
  await assert.rejects(inflateCode("bm90LWRlZmxhdGU"), /could not be unpacked/);
});

/* The `src=` download used to be read whole (`res.text( )`) and compared
 * against MAX_SOURCE afterwards - the cap limited what was kept, not what
 * was downloaded. Now a declared length over the cap is refused before the
 * body is touched, and a stream is cancelled the moment it passes it. */
test("readCapped refuses an oversized download before and while reading it", async () => {
  const response = (chunks: Uint8Array[], length?: number) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) {
          controller.enqueue(next);
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const headers = { get: (name: string) => (name === "content-length" && length !== undefined ? String(length) : null) };
    return { res: { headers, body }, wasCancelled: () => cancelled };
  };
  const bytes = (n: number) => new Uint8Array(n).fill(0x61);
  // within the cap, chunk by chunk
  assert.equal(await readCapped(response([bytes(3), bytes(2)]).res, 5, "u"), "aaaaa");
  // the declared length alone refuses it - nothing is read
  const declared = response([bytes(1)], 6);
  await assert.rejects(readCapped(declared.res, 5, "u"), /larger than a class link carries/);
  // undeclared and over the cap: cancelled on the chunk that passes it
  const streamed = response([bytes(4), bytes(4), bytes(4)]);
  await assert.rejects(readCapped(streamed.res, 5, "u"), /larger than a class link carries/);
  assert.equal(streamed.wasCancelled(), true);
  // a body-less answer is an empty class, not a crash
  assert.equal(await readCapped({ headers: { get: () => null }, body: null }, 5, "u"), "");
});
