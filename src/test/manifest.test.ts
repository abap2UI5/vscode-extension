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
    viewsWelcome?: Array<{ view: string; contents: string }>;
    views?: Record<string, Array<{ id: string; when?: string }>>;
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

test("the welcome text of an empty view links only to real commands", () => {
  // These are the one thing a user sees when a tree has nothing to show, and
  // a link to a command that no longer exists fails silently on click.
  const known = new Set(contributed);
  const viewIds = new Set(
    Object.values(manifest.contributes.views ?? {}).flatMap((entries) =>
      entries.map((entry) => entry.id)
    )
  );
  for (const welcome of manifest.contributes.viewsWelcome ?? []) {
    assert.ok(
      viewIds.has(welcome.view),
      `viewsWelcome targets ${welcome.view}, which is not a contributed view`
    );
    for (const [, command] of welcome.contents.matchAll(
      /command:([\w.]+)/g
    )) {
      assert.ok(
        known.has(command),
        `the welcome text of ${welcome.view} links to unknown command ${command}`
      );
    }
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

/*
 * Desktop-only commands, and where they may appear.
 *
 * The web extension host registers a fraction of the commands: the language
 * features, the property gate, the wizards. Everything that needs a socket or
 * a process - the preview, F9, the ADT integration, the MCP server - exists
 * only in `src/extension.ts`. A contribution that offers one of those in the
 * web host is a button (or a key) that answers "command not found".
 *
 * `menus.commandPalette` has carried `"when": "!isWeb"` entries for this from
 * the start. The editor-title buttons and the keybindings did not, so on
 * vscode.dev a play button appeared over any ABAP file and F9 failed - which
 * is exactly the kind of drift no compiler sees.
 *
 * The web command set is computed the way the bundler sees it: walk the
 * relative imports out of `src/web/extension.ts` and collect every
 * `registerCommand` in the modules it actually reaches.
 */

/** Every `abap2ui5.*` command reachable from an entry point's import graph. */
function commandsReachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const found = new Set<string>();
  const visit = (file: string): void => {
    const resolved = [file, `${file}.ts`, path.join(file, "index.ts")].find(
      (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    );
    if (!resolved || seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    const text = fs.readFileSync(resolved, "utf8");
    for (const m of text.matchAll(/registerCommand\(\s*["'`]([^"'`]+)["'`]/g)) {
      found.add(m[1]);
    }
    // `import … from "./x"`, `export … from "./x"` and `import("./x")`
    for (const m of text.matchAll(/from\s+["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']/g)) {
      const spec = m[1] ?? m[2];
      visit(path.resolve(path.dirname(resolved), spec));
    }
  };
  visit(path.join(ROOT, entry));
  return found;
}

const webCommands = commandsReachableFrom("src/web/extension.ts");

test("the web entry really is a subset - the scan resolves something", () => {
  assert.ok(
    webCommands.has("abap2ui5.openHomepage"),
    "the web import walk found nothing - the scan is broken, not the manifest"
  );
  assert.ok(
    !webCommands.has("abap2ui5.run"),
    "abap2ui5.run is reachable from the web entry now - if the preview really " +
      "works there, the !isWeb gating below is what should change"
  );
});

test("no contribution offers a desktop-only command in the web host", () => {
  const desktopOnly = (command: string): boolean =>
    command.startsWith("abap2ui5.") && !webCommands.has(command);
  const hidden = (when: string | undefined): boolean =>
    /!isWeb\b/.test(when ?? "") || (when ?? "").trim() === "false";

  /** Views carry their own `when`; a menu entry scoped to a view that does
   *  not exist in the web host cannot be reached there either. */
  const viewGate = new Map<string, string | undefined>();
  for (const entries of Object.values(manifest.contributes.views ?? {})) {
    for (const view of entries) {
      viewGate.set(view.id, (view as { when?: string }).when);
    }
  }
  const throughAGatedView = (when: string | undefined): boolean => {
    const view = /view\s*==\s*'?([\w.]+)'?/.exec(when ?? "")?.[1];
    return view !== undefined && hidden(viewGate.get(view));
  };

  /** A submenu is only as reachable as the places that open it. */
  const submenuGate = new Map<string, boolean>();
  for (const id of (manifest.contributes.submenus ?? []).map((e) => e.id)) {
    const openers = Object.values(manifest.contributes.menus ?? {}).flatMap(
      (entries) =>
        entries.filter((e) => e.submenu === id) as Array<{ when?: string }>
    );
    submenuGate.set(
      id,
      openers.length > 0 && openers.every((e) => hidden(e.when))
    );
  }

  const offenders: string[] = [];
  for (const [menu, entries] of Object.entries(manifest.contributes.menus ?? {})) {
    if (submenuGate.get(menu)) {
      continue; // every opener of this submenu is desktop-only
    }
    for (const entry of entries) {
      const when = (entry as { when?: string }).when;
      if (
        entry.command &&
        desktopOnly(entry.command) &&
        !hidden(when) &&
        !throughAGatedView(when)
      ) {
        offenders.push(`menus.${menu} -> ${entry.command}`);
      }
    }
  }
  for (const binding of manifest.contributes.keybindings ?? []) {
    const b = binding as { command: string; when?: string };
    if (desktopOnly(b.command) && !hidden(b.when)) {
      offenders.push(`keybinding ${b.command}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these are not registered by the web entry and need "!isWeb" in their ' +
      'when clause - in the web host they fail with "command not found"'
  );
});
