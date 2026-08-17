import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

/*
 * The manifest and the code drift silently: a command registered without a
 * `contributes.commands` entry never reaches the palette, an entry without
 * a registration errors at runtime - and `tsc` sees neither. This test
 * cross-checks the two, in both directions, by statically scanning every
 * source for `registerCommand("…")`.
 */

const ROOT = path.join(__dirname, "..");

interface Manifest {
  contributes: {
    commands: Array<{ command: string; title: string }>;
    /** An entry is a command OR a nested submenu, never both. */
    menus?: Record<string, Array<{ command?: string; submenu?: string }>>;
    submenus?: Array<{ id: string; label: string }>;
    keybindings?: Array<{ command: string }>;
  };
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
) as Manifest;

/**
 * Commands registered in code but deliberately NOT contributed: internal
 * commands that take arguments and are only ever invoked programmatically
 * (from a code action, a webview, another command). Adding one here is a
 * statement that it must never appear in the palette.
 */
const NOT_CONTRIBUTED = new Set([
  // invoked by the quick-fix code action with (baselineFile, sourceFile,
  // finding) arguments - meaningless without them
  "abap2ui5.addToBaseline",
]);

/** Every `registerCommand("abap2ui5.…")` in the sources, with its file. */
function registeredCommands(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "test") {
          continue; // fixtures in tests are not registrations
        }
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) {
        continue;
      }
      const text = fs.readFileSync(full, "utf8");
      for (const m of text.matchAll(
        /registerCommand\(\s*["'`]([^"'`]+)["'`]/g
      )) {
        const list = found.get(m[1]) ?? [];
        list.push(path.relative(ROOT, full));
        found.set(m[1], list);
      }
    }
  };
  walk(path.join(ROOT, "src"));
  return found;
}

const registered = registeredCommands();
const contributed = manifest.contributes.commands.map((c) => c.command);

test("the scan finds the registrations at all", () => {
  // guards the regex against a refactor that changes the call shape -
  // an empty scan would make the two direction tests pass vacuously
  assert.ok(registered.size >= 20, `only found ${registered.size} commands`);
  assert.ok(registered.has("abap2ui5.run"));
});

test("every contributed command is registered somewhere in the code", () => {
  const missing = contributed.filter((command) => !registered.has(command));
  assert.deepEqual(
    missing,
    [],
    "contributes.commands entries without a registerCommand - " +
      "these error at runtime when invoked"
  );
});

test("every registered command is contributed (or a documented exception)", () => {
  const missing = [...registered.keys()].filter(
    (command) =>
      !contributed.includes(command) && !NOT_CONTRIBUTED.has(command)
  );
  assert.deepEqual(
    missing,
    [],
    "registerCommand calls without a contributes.commands entry - " +
      "add the entry, or document the exception in NOT_CONTRIBUTED"
  );
});

test("the exception list does not go stale", () => {
  for (const command of NOT_CONTRIBUTED) {
    assert.ok(
      registered.has(command),
      `${command} is excepted but no longer registered - drop it from NOT_CONTRIBUTED`
    );
    assert.ok(
      !contributed.includes(command),
      `${command} is excepted but IS contributed now - drop it from NOT_CONTRIBUTED`
    );
  }
});

test("no command is contributed twice", () => {
  assert.equal(new Set(contributed).size, contributed.length);
});

test("menus and keybindings only reference contributed commands", () => {
  const known = new Set(contributed);
  const declaredSubmenus = new Set(
    (manifest.contributes.submenus ?? []).map((entry) => entry.id)
  );
  for (const [menu, entries] of Object.entries(
    manifest.contributes.menus ?? {}
  )) {
    for (const entry of entries) {
      // A menu entry is either a command or a nested submenu - the submenu
      // that puts every abap2UI5 action behind one right-click entry is the
      // second kind, and carries no command of its own.
      if (entry.submenu) {
        assert.ok(
          declaredSubmenus.has(entry.submenu),
          `menus.${menu} opens submenu ${entry.submenu}, which is not declared in contributes.submenus`
        );
        continue;
      }
      assert.ok(
        entry.command !== undefined && known.has(entry.command),
        `menus.${menu} references unknown command ${entry.command}`
      );
    }
  }
  // and every declared submenu is actually opened from somewhere, or it is
  // invisible to the user no matter what it holds
  for (const id of declaredSubmenus) {
    const opened = Object.values(manifest.contributes.menus ?? {}).some(
      (entries) => entries.some((entry) => entry.submenu === id)
    );
    assert.ok(opened, `submenu ${id} is declared but no menu opens it`);
  }
  for (const binding of manifest.contributes.keybindings ?? []) {
    assert.ok(
      known.has(binding.command),
      `keybinding references unknown command ${binding.command}`
    );
  }
});

test("every command carries the abap2ui5 prefix and an English title", () => {
  for (const entry of manifest.contributes.commands) {
    assert.match(entry.command, /^abap2ui5\./);
    assert.match(
      entry.title,
      /^abap2UI5: /,
      `${entry.command} - palette entries all start with "abap2UI5: "`
    );
  }
});
