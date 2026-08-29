/*
 * The bundled UI5 metadata snapshot.
 *
 * `esbuild.js` copies the linter's `data/properties.json` next to the bundle,
 * because a bundled `.mjs` cannot resolve its own package's data directory.
 * Three features read it — the property gate, completion and hover — so it is
 * loaded once, here, and handed out as data.
 *
 * If `dist/properties.json` is ever missing, the property gate runs with no
 * metadata and finds nothing at all, silently. `snapshotError( )` is what
 * makes that visible in the output channel instead.
 */

import * as fs from "fs";
import * as path from "path";
import { loadSnapshot } from "@abap2ui5/linter/properties";
import type { Snapshot } from "./metadata";

const FILE = path.join(__dirname, "properties.json");

let cached: Snapshot | undefined;
let failure: string | undefined;

/**
 * Web build only: the snapshot arrives as text, read through
 * `vscode.workspace.fs` (there is no `fs` in a browser extension host).
 * Mirrors exactly what the linter's `loadSnapshot( )` does with the parsed
 * file - the enum table and the UI5 version ride along non-enumerably.
 */
export function setSnapshotText(raw: string): void {
  try {
    const parsed = JSON.parse(raw) as {
      controls: Snapshot;
      enums?: Record<string, string[]>;
      ui5Version?: string;
    };
    Object.defineProperty(parsed.controls, "__enums", {
      value: parsed.enums || {},
      enumerable: false,
    });
    Object.defineProperty(parsed.controls, "__ui5Version", {
      value: parsed.ui5Version || null,
      enumerable: false,
    });
    cached = parsed.controls;
    failure = undefined;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    cached = {} as Snapshot;
  }
}

/** The controls map, or an empty one when the snapshot could not be read. */
export function snapshot(): Snapshot {
  if (cached === undefined) {
    try {
      cached = loadSnapshot(FILE) as Snapshot;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      cached = {} as Snapshot;
    }
  }
  return cached;
}

/** Why the snapshot is unusable, or undefined when it loaded. */
export function snapshotError(): string | undefined {
  snapshot();
  return failure;
}

let ui5Version: { value: string | undefined } | undefined;

/** The UI5 version the snapshot was generated from — read straight from the
 *  file, so an older snapshot without the field is fine. Read once: the file
 *  is several MB and does not change while the extension runs. */
export function snapshotUi5Version(): string | undefined {
  if (!ui5Version) {
    let value: string | undefined;
    try {
      value = JSON.parse(fs.readFileSync(FILE, "utf8")).ui5Version;
    } catch {
      value = undefined;
    }
    ui5Version = { value };
  }
  return ui5Version.value;
}
