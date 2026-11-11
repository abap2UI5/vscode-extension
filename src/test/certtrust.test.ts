import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CertificateTrustError,
  changedMessage,
  decideTrust,
  describeCertificate,
  explainTlsError,
  isCertificateErrorCode,
  mayConnect,
  normalizeFingerprint,
  pinFor,
  pinKey,
  readPins,
  untrustedMessage,
  withPin,
} from "../certtrust";

const FP_A = Array.from({ length: 32 }, () => "AB").join(":");
const FP_B = Array.from({ length: 32 }, () => "CD").join(":");

// ---------------------------------------------------------------------------
// The four answers
// ---------------------------------------------------------------------------

test("a certificate the trust store verifies is trusted - pin or no pin", () => {
  assert.equal(decideTrust({ authorized: true, fingerprint256: FP_A }, undefined), "trusted");
  // a pin is an exception to verification, not a second lock: a system that
  // moved to a proper certificate keeps working
  assert.equal(decideTrust({ authorized: true, fingerprint256: FP_B }, FP_A), "trusted");
});

test("an unverifiable certificate that is the pinned one matches", () => {
  assert.equal(decideTrust({ authorized: false, fingerprint256: FP_A }, FP_A), "pinned-match");
  // the spelling of a fingerprint is not part of it
  assert.equal(
    decideTrust(
      { authorized: false, fingerprint256: FP_A.toLowerCase().replace(/:/g, "") },
      FP_A
    ),
    "pinned-match"
  );
});

test("an unverifiable certificate that is not the pinned one is a mismatch", () => {
  assert.equal(decideTrust({ authorized: false, fingerprint256: FP_B }, FP_A), "pinned-mismatch");
  // a peer without a usable fingerprint never matches a pin
  assert.equal(decideTrust({ authorized: false, fingerprint256: "" }, FP_A), "pinned-mismatch");
  assert.equal(decideTrust({ authorized: false, fingerprint256: "AB:CD" }, FP_A), "pinned-mismatch");
});

test("an unverifiable certificate nobody was asked about is unknown", () => {
  assert.equal(decideTrust({ authorized: false, fingerprint256: FP_A }, undefined), "unknown");
  // a stored value that is no fingerprint is no pin - and must not match an
  // equally empty presented one
  assert.equal(decideTrust({ authorized: false, fingerprint256: "" }, ""), "unknown");
  assert.equal(decideTrust({ authorized: false, fingerprint256: "xyz" }, "xyz"), "unknown");
});

test("only a trusted or matching certificate may carry a request", () => {
  assert.ok(mayConnect("trusted"));
  assert.ok(mayConnect("pinned-match"));
  assert.ok(!mayConnect("pinned-mismatch"));
  assert.ok(!mayConnect("unknown"));
});

// ---------------------------------------------------------------------------
// Fingerprints and pins
// ---------------------------------------------------------------------------

test("fingerprints normalise to upper-case colon pairs, or to nothing", () => {
  assert.equal(normalizeFingerprint("ab".repeat(32)), FP_A);
  assert.equal(normalizeFingerprint(FP_A.toLowerCase()), FP_A);
  assert.equal(normalizeFingerprint("AB CD"), "");
  assert.equal(normalizeFingerprint(undefined), "");
  assert.equal(normalizeFingerprint("ab".repeat(20)), "", "a SHA-1 is not a pin");
});

test("pins are keyed by https origin", () => {
  assert.equal(pinKey("https://Host.example:44300/sap/bc/z2ui5?x=1"), "https://host.example:44300");
  assert.equal(pinKey("https://host.example:443"), "https://host.example");
  assert.equal(pinKey("http://host.example:8000"), undefined, "nothing to pin on plain http");
  assert.equal(pinKey("not a url"), undefined);

  const pins = withPin({}, "https://dev:44300/path", FP_A.toLowerCase());
  assert.deepEqual(pins, { "https://dev:44300": FP_A });
  assert.equal(pinFor(pins, "https://DEV:44300"), FP_A);
  // per system: another port, another host, another scheme is another origin
  assert.equal(pinFor(pins, "https://dev:44301"), undefined);
  assert.equal(pinFor(pins, "https://qas:44300"), undefined);
  assert.equal(pinFor(pins, "http://dev:44300"), undefined);
});

test("pinning returns a new map and refuses what is no pin", () => {
  const before = { "https://dev:44300": FP_A };
  const after = withPin(before, "https://qas:44300", FP_B);
  assert.deepEqual(before, { "https://dev:44300": FP_A });
  assert.deepEqual(after, { "https://dev:44300": FP_A, "https://qas:44300": FP_B });
  assert.deepEqual(withPin(before, "https://qas:44300", "nonsense"), before);
  assert.deepEqual(withPin(before, "http://qas:8000", FP_B), before);
});

test("a stored pin map is reduced to what a pin map may hold", () => {
  assert.deepEqual(readPins(undefined), {});
  assert.deepEqual(readPins("https://dev"), {});
  assert.deepEqual(readPins([FP_A]), {});
  assert.deepEqual(
    readPins({
      "https://dev:44300/": FP_A.toLowerCase(),
      "http://plain:8000": FP_A,
      "https://broken:44300": "not a fingerprint",
      "https://number:44300": 42,
      nonsense: FP_B,
    }),
    { "https://dev:44300": FP_A }
  );
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("Node's certificate codes are recognised, connection codes are not", () => {
  for (const code of [
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "HOSTNAME_MISMATCH",
  ]) {
    assert.ok(isCertificateErrorCode(code), code);
  }
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EPROTO", "", undefined]) {
    assert.ok(!isCertificateErrorCode(code), String(code));
  }
});

test("the refusal for an unknown certificate names where the question is asked", () => {
  const message = untrustedMessage("https://dev:44300", "DEPTH_ZERO_SELF_SIGNED_CERT");
  assert.match(message, /https:\/\/dev:44300/);
  assert.match(message, /DEPTH_ZERO_SELF_SIGNED_CERT/);
  assert.match(message, /Check System Connection/);
  assert.match(message, /F9/);
  assert.match(message, /nothing was sent/);
});

test("the refusal for a changed certificate shows both fingerprints and the way out", () => {
  const message = changedMessage("https://dev:44300", FP_A, FP_B.toLowerCase());
  assert.match(message, /changed since it was trusted/);
  assert.ok(message.includes(FP_A));
  assert.ok(message.includes(FP_B));
  assert.match(message, /Forget Trusted Certificates/);
});

test("a verification error is explained with its code kept, anything else passes through", () => {
  const tlsError = Object.assign(new Error("self-signed certificate"), {
    code: "DEPTH_ZERO_SELF_SIGNED_CERT",
  });
  const explained = explainTlsError(tlsError, "https://dev:44300");
  assert.ok(explained instanceof CertificateTrustError);
  assert.equal((explained as CertificateTrustError).code, "DEPTH_ZERO_SELF_SIGNED_CERT");
  assert.match(explained.message, /Check System Connection/);

  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  assert.equal(explainTlsError(refused, "https://dev:44300"), refused);
  const own = new CertificateTrustError("CERT_PIN_MISMATCH", "changed");
  assert.equal(explainTlsError(own, "https://dev:44300"), own);
  assert.equal(explainTlsError("boom", "https://dev:44300").message, "boom");
});

test("the question shows subject, issuer, validity, fingerprint and the reason", () => {
  const lines = describeCertificate({
    authorized: false,
    authorizationError: "DEPTH_ZERO_SELF_SIGNED_CERT",
    fingerprint256: FP_A.toLowerCase(),
    subject: "CN=dev",
    issuer: "CN=dev",
    validFrom: "Aug 10 2026",
    validTo: "Jul 17 2126",
  }).join("\n");
  assert.match(lines, /Subject: CN=dev/);
  assert.match(lines, /Issuer: CN=dev/);
  assert.match(lines, /Valid: Aug 10 2026 - Jul 17 2126/);
  assert.ok(lines.includes(FP_A));
  assert.match(lines, /DEPTH_ZERO_SELF_SIGNED_CERT/);
});
