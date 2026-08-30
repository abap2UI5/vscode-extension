import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleTrust } from "../checkcore";

/*
 * The render gate's trust policy: what may be executed out of the archive
 * `rendergate.ts` downloads at runtime.
 *
 * This is the one security decision in the extension - the bundle is
 * extracted and run with VS Code's own Node, so whoever can change that
 * release asset chooses code that runs on every machine that installs the
 * gate. The decision itself is `bundleTrust` in `checkcore.ts`, deliberately
 * `vscode`-free so it can be tested; `verifyBundle` around it only fetches the
 * published checksum, reads and writes the remembered digest, and turns a
 * rejection into a throw that aborts the install BEFORE anything is unpacked.
 *
 * The reject cases are the ones worth the test: an accept that should have
 * been a reject is a silent code download.
 */

const ROLLING =
  "https://github.com/abap2UI5/linter/releases/download/render-gate-bundle/view-check-bundle.tgz";
const PINNED =
  "https://github.com/abap2UI5/linter/releases/download/render-gate-bundle-0123456789ab/view-check-bundle.tgz";

const A = "a".repeat(64);
const B = "b".repeat(64);

// ---------------------------------------------------------------------------
// 1. The published checksum, when there is one - authoritative either way
// ---------------------------------------------------------------------------

test("a published checksum that matches is accepted, and says so", () => {
  const decision = bundleTrust({
    url: PINNED,
    actual: A,
    published: A,
    remembered: undefined,
    rolling: false,
  });
  assert.ok(decision.accept);
  assert.equal(decision.reason, "published-match");
  assert.match(decision.log, /matches the published checksum/);
});

test("a published checksum that does not match is refused", () => {
  const decision = bundleTrust({
    url: PINNED,
    actual: A,
    published: B,
    rolling: false,
  });
  assert.ok(!decision.accept);
  assert.equal(decision.reason, "published-mismatch");
  assert.match(decision.message, /Nothing was installed/);
  // both digests, so a report says WHAT was expected and what arrived
  assert.match(decision.message, /aaaaaaaaaaaa/);
  assert.match(decision.message, /bbbbbbbbbbbb/);
});

test("the published checksum wins over the remembered one, in both directions", () => {
  // it is the stronger check: a remembered digest is only what this machine
  // downloaded once, the published one is what the publisher says it is
  const good = bundleTrust({
    url: PINNED,
    actual: A,
    published: A,
    remembered: B,
    rolling: false,
  });
  assert.ok(good.accept);
  assert.equal(good.reason, "published-match");

  const bad = bundleTrust({
    url: PINNED,
    actual: A,
    published: B,
    remembered: A,
    rolling: false,
  });
  assert.ok(!bad.accept);
  assert.equal(bad.reason, "published-mismatch");
});

// ---------------------------------------------------------------------------
// 2. Trust on first use, per url, when no checksum is published
// ---------------------------------------------------------------------------

test("a first install from a url is accepted and named as such", () => {
  const decision = bundleTrust({ url: PINNED, actual: A, rolling: false });
  assert.ok(decision.accept);
  assert.equal(decision.reason, "first-install");
  assert.match(decision.log, /first install from this URL/);
});

test("the same bytes from the same url are accepted again", () => {
  const decision = bundleTrust({
    url: PINNED,
    actual: A,
    remembered: A,
    rolling: false,
  });
  assert.ok(decision.accept);
  assert.equal(decision.reason, "unchanged");
  assert.match(decision.log, /unchanged since the last install/);
});

test("a per-commit url that answers with different bytes is refused", () => {
  // the case the policy exists for: that url names ONE immutable linter
  // commit, so its content moving cannot happen by accident
  const decision = bundleTrust({
    url: PINNED,
    actual: B,
    remembered: A,
    rolling: false,
  });
  assert.ok(!decision.accept);
  assert.equal(decision.reason, "immutable-moved");
  assert.match(decision.message, /should never move/);
  assert.match(decision.message, /Nothing was installed/);
});

test("the rolling bundle is ALLOWED to move - that is what rolling means", () => {
  const decision = bundleTrust({
    url: ROLLING,
    actual: B,
    remembered: A,
    rolling: true,
  });
  assert.ok(decision.accept);
  assert.equal(decision.reason, "rolling-moved");
  assert.match(decision.log, /expected for a rolling tag/);
  // the log carries both digests: it is the only record of what changed
  assert.match(decision.log, /aaaaaaaaaaaa/);
  assert.match(decision.log, /bbbbbbbbbbbb/);
});

test("the rolling exemption is the URL's, not the caller's mood", () => {
  // `rolling` is derived from the url in rendergate.ts; a pinned url must not
  // reach the exemption however the digests look
  const decision = bundleTrust({
    url: PINNED,
    actual: B,
    remembered: A,
    rolling: false,
  });
  assert.ok(!decision.accept);
});

test("a published mismatch is refused for the rolling bundle too", () => {
  // rolling means "the bytes may change", never "the publisher's own
  // checksum may disagree with them"
  const decision = bundleTrust({
    url: ROLLING,
    actual: A,
    published: B,
    remembered: A,
    rolling: true,
  });
  assert.ok(!decision.accept);
  assert.equal(decision.reason, "published-mismatch");
});

// ---------------------------------------------------------------------------
// 3. What the policy does NOT promise
// ---------------------------------------------------------------------------

test("a first install is trusted - the documented limit of the policy", () => {
  // neither check protects a first install against a bundle that was already
  // tampered with, and the code says so rather than implying otherwise. The
  // test pins the honesty: if this ever becomes a reject, the comment in
  // checkcore.ts is what has to change with it.
  const decision = bundleTrust({ url: ROLLING, actual: B, rolling: true });
  assert.ok(decision.accept);
  assert.equal(decision.reason, "first-install");
});
