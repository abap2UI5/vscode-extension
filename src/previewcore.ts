import { prepareAbap } from "@abap2ui5/linter/reconstruct";
import { shortUrl } from "./urls";
import { redactQueryCredentials } from "./report";

/*
 * The `vscode`-free core of the preview: what a launched app IS (the
 * target), the messages posted into the preview webview, and the small
 * decisions around them (reload trigger, recent list, model roots). The
 * plumbing in `session.ts` / `preview.ts` / `launch.ts` only moves these
 * values around - the logic lives here, where the test suite can reach it.
 */

/** Everything needed to show (and later reload) one app. */
export interface AppTarget {
  className: string;
  frameUrl: string;
  externalUrl: string;
  system: string;
}

/** Message posted into a preview webview to (re)load an app. */
export function loadMessage(
  target: AppTarget,
  theme: string,
  language: string,
  modelRoots: string[],
  reason?: string
) {
  return {
    type: "load" as const,
    className: target.className,
    frameUrl: target.frameUrl,
    // display only (the toolbar tooltip) - so without logon parameters
    externalUrl: redactQueryCredentials(target.externalUrl),
    shortUrl: shortUrl(target.externalUrl),
    theme,
    language,
    modelRoots,
    reason,
  };
}

/**
 * Message posted when the shown class was saved but not activated: the preview
 * still shows the active version, so it says so instead of reloading. With
 * `force` the toast shows even when the badge is already up - how the
 * activation watch's give-up reaches a preview that is already marked stale.
 */
export function staleMessage(reason: string, force = false) {
  return force
    ? { type: "stale" as const, reason, force: true as const }
    : { type: "stale" as const, reason };
}

/**
 * A class name reduced to something safe as a file-name stem: namespaced
 * classes (`/UI2/CL_X`) carry separators, and names arriving over MCP are
 * arbitrary strings - neither may steer where a file lands.
 */
export function safeFileStem(name: string): string {
  const stem = name.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "");
  return stem || "APP";
}

/** When the preview reloads by itself. */
export type ReloadTrigger = "activation" | "save" | "never";

/**
 * The effective reload trigger from the two settings: an explicit `reloadOn`
 * wins; without one, an explicit legacy `reloadOnSave` keeps its pre-0.9.0
 * meaning (`false` = never, `true` = save); the default is `activation`.
 */
export function resolveReloadTrigger(
  explicit: string | undefined,
  legacy: boolean | undefined
): ReloadTrigger {
  if (explicit === "activation" || explicit === "save" || explicit === "never") {
    return explicit;
  }
  if (legacy === false) {
    return "never";
  }
  if (legacy === true) {
    return "save";
  }
  return "activation";
}

/**
 * The class's own top-level model paths, derived the way the linter derives
 * them - what a stateful reload is allowed to restore. Everything else in
 * the runtime model is the framework's and belongs to the fresh page.
 */
export function modelRootsOfSource(source: string): string[] {
  try {
    const prep = prepareAbap(source);
    const shape = prep.usesBuilder ? prep.modelShape : undefined;
    if (shape && typeof shape === "object" && !Array.isArray(shape)) {
      return Object.keys(shape);
    }
  } catch {
    // no shape, no restore - the pin simply has nothing to carry over
  }
  return [];
}

/** The recent-apps list after one launch: newest first, no duplicate, capped. */
export function nextRecentApps(
  recent: string[],
  className: string,
  max: number
): string[] {
  return [className, ...recent.filter((c) => c !== className)].slice(0, max);
}

/** True when timestamp `a` is later than `b` (same-format fallback: differs). */
export function isNewer(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!isNaN(ta) && !isNaN(tb)) {
    return ta > tb;
  }
  return a !== b;
}
