import { test } from "node:test";
import assert from "node:assert/strict";
import { run, shellSafe } from "../childproc";

/*
 * The one spawn.
 *
 * Three call sites used to start the same checker three times over, and each
 * had learned a different subset of the lessons: the render gate had the
 * timeout and the kill, the preview had neither, and none of them quoted the
 * PROGRAM - which is what broke an explicit `viewCheck.command` pointing at
 * `C:\Program Files\nodejs\node.exe`.
 */

test("shellSafe quotes the program as well as the arguments", () => {
  const { cmd, args } = shellSafe(
    "C:\\Program Files\\nodejs\\node.exe",
    ["C:\\Users\\John Smith\\cli.mjs", "--json"],
    "win32"
  );
  assert.equal(cmd, '"C:\\Program Files\\nodejs\\node.exe"');
  assert.deepEqual(args, ['"C:\\Users\\John Smith\\cli.mjs"', "--json"]);
});

test("shellSafe leaves posix alone - the shell is only used on Windows", () => {
  const { cmd, args } = shellSafe("/usr/bin/node", ["/tmp/a b/cli.mjs"], "linux");
  assert.equal(cmd, "/usr/bin/node");
  assert.deepEqual(args, ["/tmp/a b/cli.mjs"]);
});

test("a command that finishes reports its code and both streams", async () => {
  const outcome = await run(process.execPath, [
    "-e",
    "process.stdout.write('out');process.stderr.write('err');process.exit(3)",
  ]);
  assert.equal(outcome.kind, "closed");
  if (outcome.kind !== "closed") {
    return;
  }
  assert.equal(outcome.code, 3);
  assert.equal(outcome.stdout, "out");
  assert.equal(outcome.stderr, "err");
});

test("a command that does not exist resolves as spawn-failed, never rejects", async () => {
  const outcome = await run("definitely-not-a-program-here", []);
  assert.equal(outcome.kind, "spawn-failed");
});

test("a hanging command is killed at the timeout", async () => {
  const started = Date.now();
  const outcome = await run(process.execPath, [
    "-e",
    "process.stdout.write('hi');setInterval(() => {}, 1000)",
  ], { timeoutMs: 300 });
  assert.equal(outcome.kind, "timeout");
  if (outcome.kind === "timeout") {
    // what it managed to say before it was killed is still reported
    assert.equal(outcome.stdout, "hi");
  }
  assert.ok(
    Date.now() - started < 5000,
    "the timeout did not actually stop the child"
  );
});

test("a command nobody is waiting for any more is killed", async () => {
  let wanted = true;
  const promise = run(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { abandoned: () => !wanted, pollMs: 20, timeoutMs: 10_000 }
  );
  setTimeout(() => (wanted = false), 50);
  const outcome = await promise;
  assert.equal(outcome.kind, "abandoned");
});

test("a child that ends normally is not reported as abandoned afterwards", async () => {
  // the poll keeps running until the promise settles; whoever is first wins
  const outcome = await run(process.execPath, ["-e", "process.exit(0)"], {
    abandoned: () => false,
    pollMs: 10,
    timeoutMs: 5000,
  });
  assert.equal(outcome.kind, "closed");
});
