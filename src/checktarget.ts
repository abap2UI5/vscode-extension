import * as vscode from "vscode";
import { CONFIG_SECTION } from "./settings";
import { settingsForSystem, SystemTarget } from "./configcore";
import type { SettingsOptions } from "./lintconfig";

/*
 * checktarget - the settings half of a check's options on the desktop: the
 * four `viewCheck` settings, with the active system's profile laid over them
 * (`settingsForSystem` in configcore.ts owns that precedence; this module
 * only reads the two sides).
 *
 * The active system lives in the window's state, which `systems.ts` reads
 * with the extension context - so `extension.ts` hands a reader in. Nobody
 * does in the web build, which has no systems: there `webcheck.ts` reads the
 * settings itself and this module is not part of the bundle.
 */

let activeTarget: () => SystemTarget | undefined = () => undefined;

const changed = new vscode.EventEmitter<void>();

/** Fires when the system the checks compare against may have changed: the
 *  active system was switched, or the `systems` setting edited. */
export const onDidChangeCheckTarget = changed.event;

/** Wires the reader of the active system's profile. */
export function setCheckTargetSource(source: () => SystemTarget | undefined): void {
  activeTarget = source;
}

/** What the active system contributes right now, as one comparable string. */
function signature(): string {
  const system = activeTarget();
  return system ? `${system.name}\n${system.minUi5 ?? ""}\n${system.distribution ?? ""}` : "";
}

let lastSignature = "";
let generation = 0;

/**
 * Counts the changes of what the active system contributes - compared by the
 * caches of what was checked against it. The event above covers the paths
 * that announce a switch; this covers every other one (the first F9 picking
 * a system, an edited launch URL), noticed at the next check.
 */
export function checkTargetGeneration(): number {
  const now = signature();
  if (now !== lastSignature) {
    lastSignature = now;
    generation++;
  }
  return generation;
}

/** Announces a switch of the active system (or an edit of its profile). */
export function checkTargetChanged(): void {
  changed.fire();
}

/** The settings a check starts from - see the header. */
export function checkSettings(): SettingsOptions {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rules = cfg.get<Record<string, unknown>>("viewCheck.rules");
  return settingsForSystem(
    {
      minUi5: cfg.get<string>("viewCheck.minUi5", "1.71"),
      /* "" is the setting's default and means "not decided" - handed on as
       * null, the linter's own default and its own answer: a SAPUI5-only
       * control is then a hint rather than an error (openui5) or nothing
       * (sapui5). Defaulting to "sapui5" here used to silence in the editor
       * what a configless CLI run reports. */
      distribution: cfg.get<string>("viewCheck.distribution", "") || null,
      allow: cfg.get<string[]>("viewCheck.allow", []),
      rules: rules && Object.keys(rules).length > 0 ? rules : undefined,
    },
    activeTarget()
  );
}
