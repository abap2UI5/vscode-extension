import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeMcpRequest } from "../mcprpc";
import { isLoopbackHost } from "../proxy";

/*
 * The system MCP server's front door.
 *
 * `mcpsystem.ts` itself imports `vscode` (it reads the view-check settings for
 * `check_view_source`), so the decision that authorizes acting with the SYSTEM
 * CREDENTIALS lives in `mcprpc.ts` - the same move `proxy.ts` made for its own
 * routing. This file exercises it with the REAL loopback predicate the proxy
 * exports, because half the invariant is that both listeners answer a
 * non-loopback `Host` identically.
 *
 * AGENTS.md: "Every local listener carries a secret in its path" - a token in
 * the url, everything else 404, and a `Host` that is not loopback refused
 * outright. These are that rule's negative cases.
 */

/** What the server hands out: `/<randomBytes(16).toString("base64url")>`. */
const TOKEN_PATH = "/Zm9vYmFyYmF6cXV4MTIzNA";

test("the POST a client makes with the token, from loopback, is dispatched", () => {
  for (const host of ["127.0.0.1:53535", "localhost:53535", "[::1]:53535"]) {
    assert.equal(
      authorizeMcpRequest(
        { method: "POST", url: TOKEN_PATH, host },
        TOKEN_PATH,
        isLoopbackHost
      ),
      "dispatch",
      host
    );
  }
});

test("a wrong, missing or merely prefixed token is 404 - not a hint", () => {
  for (const url of [
    undefined,
    "",
    "/",
    "/wrong",
    `${TOKEN_PATH}x`, // longer
    TOKEN_PATH.slice(0, -1), // shorter
    `${TOKEN_PATH}/tools`, // the token is the WHOLE path here, no sub-paths
    TOKEN_PATH.toLowerCase(), // the token is case-sensitive
    `${TOKEN_PATH}?x=1`,
  ]) {
    assert.equal(
      authorizeMcpRequest(
        { method: "POST", url, host: "127.0.0.1:53535" },
        TOKEN_PATH,
        isLoopbackHost
      ),
      "not-found",
      `url ${JSON.stringify(url)}`
    );
  }
});

test("a Host that is not loopback is refused even WITH the token", () => {
  // A page that resolves its own name to 127.0.0.1 reaches this port with a
  // correct url; the Host header is what gives it away. Refusing it is the
  // half of the rule this server was missing.
  for (const host of [
    "rebind.example.com",
    "rebind.example.com:53535",
    "127.0.0.1.nip.io",
    "192.168.1.10",
    undefined,
  ]) {
    assert.equal(
      authorizeMcpRequest(
        { method: "POST", url: TOKEN_PATH, host },
        TOKEN_PATH,
        isLoopbackHost
      ),
      "not-found",
      `host ${String(host)}`
    );
  }
});

test("DELETE is the session teardown, everything else 405", () => {
  assert.equal(
    authorizeMcpRequest(
      { method: "DELETE", url: TOKEN_PATH, host: "127.0.0.1" },
      TOKEN_PATH,
      isLoopbackHost
    ),
    "teardown"
  );
  for (const method of ["GET", "PUT", "HEAD", "OPTIONS", undefined]) {
    assert.equal(
      authorizeMcpRequest(
        { method, url: TOKEN_PATH, host: "127.0.0.1" },
        TOKEN_PATH,
        isLoopbackHost
      ),
      "method-not-allowed",
      `method ${String(method)}`
    );
  }
});

test("the token is checked before the method - an unauthorized GET is a 404", () => {
  // 405 to an unauthorized caller would confirm that something answers here
  assert.equal(
    authorizeMcpRequest(
      { method: "GET", url: "/", host: "127.0.0.1" },
      TOKEN_PATH,
      isLoopbackHost
    ),
    "not-found"
  );
});
