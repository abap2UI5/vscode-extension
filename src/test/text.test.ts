import { test } from "node:test";
import assert from "node:assert/strict";
import { plural } from "../text";

test("plural counts and inflects", () => {
  assert.equal(plural(1, "file"), "1 file");
  assert.equal(plural(3, "file"), "3 files");
  assert.equal(plural(0, "problem"), "0 problems");
  // x/s/sh/ch endings take "es"
  assert.equal(plural(2, "fix"), "2 fixes");
  assert.equal(plural(1, "fix"), "1 fix");
  // an irregular plural names itself
  assert.equal(plural(2, "entry", "entries"), "2 entries");
  assert.equal(plural(1, "entry", "entries"), "1 entry");
});
