import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API_REFERENCE_PAGE,
  apiReferenceAnchor,
  apiReferenceUrl,
  clientCallAt,
  clientMethod,
  clientMethods,
  clientSignatureContext,
  isClientCompletion,
  signatureHead,
  signatureParameters,
} from "../clientapi";

test("the bundled client API knows the methods every app calls", () => {
  const names = clientMethods().map((m) => m.name);
  for (const expected of [
    "view_display",
    "_bind",
    "_event",
    "popup_display",
    "message_toast_display",
    "nav_app_call",
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});

test("lookups are case-insensitive - ABAP is", () => {
  assert.equal(clientMethod("VIEW_DISPLAY")?.name, "view_display");
  assert.equal(clientMethod("View_Display")?.name, "view_display");
  assert.equal(clientMethod("no_such_method"), undefined);
});

test("the cursor position decides which client-> call is meant", () => {
  const line = "    client->view_display( client->_bind( x ) ).";
  const first = line.indexOf("view_display");
  assert.equal(clientCallAt(line, first), "view_display");
  assert.equal(clientCallAt(line, first + 4), "view_display");
  // at the very end of the name still counts - that is where typing stops
  assert.equal(clientCallAt(line, first + "view_display".length), "view_display");
  assert.equal(clientCallAt(line, line.indexOf("_bind") + 1), "_bind");
  // on the word `client` itself there is no method yet
  assert.equal(clientCallAt(line, 5), undefined);
});

test("me->client-> and upper case count too", () => {
  const line = "me->CLIENT->MESSAGE_TOAST_DISPLAY( `hi` ).";
  assert.equal(
    clientCallAt(line, line.indexOf("MESSAGE") + 2),
    "MESSAGE_TOAST_DISPLAY"
  );
});

test("completion opens right after the arrow and inside a partial name", () => {
  assert.ok(isClientCompletion("    client->"));
  assert.ok(isClientCompletion("    client->view_"));
  assert.ok(isClientCompletion("x = me->client->nav"));
  assert.equal(isClientCompletion("    client"), false);
  assert.equal(isClientCompletion("    view->ele( "), false);
});

test("reference anchors match how the docs site slugs the method headings", () => {
  // Pinned against the deployed page's ids: the docs generator writes
  // `### \`name\`` and VitePress's default slugify turns underscore runs
  // into one hyphen and trims leading/trailing separators.
  assert.equal(apiReferenceAnchor("view_display"), "view-display");
  assert.equal(apiReferenceAnchor("_bind_edit"), "bind-edit");
  assert.equal(apiReferenceAnchor("nest2_view_display"), "nest2-view-display");
});

test("every bundled method deep-links; a nameless name falls back to the page", () => {
  for (const method of clientMethods()) {
    const url = apiReferenceUrl(method.name);
    assert.match(
      url,
      new RegExp(`^${API_REFERENCE_PAGE.replace(/[.]/g, "\\.")}#[a-z0-9][a-z0-9-]*$`),
      `no deep link for ${method.name}: ${url}`
    );
  }
  // nothing derivable -> the top of the page, never a dangling `#`
  assert.equal(apiReferenceAnchor("_"), undefined);
  assert.equal(apiReferenceUrl("_"), API_REFERENCE_PAGE);
});

test("the signature head is one line, for the completion detail", () => {
  const method = clientMethod("view_display");
  assert.ok(method);
  const head = signatureHead(method);
  assert.ok(!head.includes("\n"));
  assert.match(head, /METHODS view_display/);
});

test("signatureParameters reads the parameter lines, not the result", () => {
  const method = clientMethod("_event");
  assert.ok(method);
  const params = signatureParameters(method!);
  assert.ok(params.includes("val"));
  assert.ok(params.includes("t_arg"));
  // `VALUE(result)` is the returning value, not a parameter to fill
  assert.ok(!params.includes("VALUE"));
  assert.ok(!params.includes("result"));
});

test("the open client call and its written parameter are recognised", () => {
  const open = clientSignatureContext("    client->_event( val = ");
  assert.equal(open?.method.name, "_event");
  assert.equal(open?.parameter, "val");

  // a later parameter, past a nested closed call
  const later = clientSignatureContext(
    "    client->_event( val = get_name( x = 1 ) t_arg = "
  );
  assert.equal(later?.method.name, "_event");
  assert.equal(later?.parameter, "t_arg");

  // right after the paren nothing is written yet
  const fresh = clientSignatureContext("client->popup_display(");
  assert.equal(fresh?.method.name, "popup_display");
  assert.equal(fresh?.parameter, undefined);

  // inside some OTHER call's parentheses there is nothing to say
  assert.equal(clientSignatureContext("client->_event( get_name( "), undefined);
  // a closed call is over
  assert.equal(clientSignatureContext("client->_event( `GO` ) "), undefined);
  assert.equal(clientSignatureContext("no call here"), undefined);
});
