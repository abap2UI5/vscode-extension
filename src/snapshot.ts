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
 * file - the enum table, the per-value `@since` of the enums, the
 * value-to-key table of the enums whose two differ, the DataType patterns,
 * the model types and the UI5 version ride along non-enumerably.
 * `snapshot.test.ts` holds this to every hidden key `loadSnapshot` attaches:
 * the `__enumSince` table went missing here once, and with it
 * `enum-value-too-new` never fired on vscode.dev.
 */
export function setSnapshotText(raw: string): void {
  try {
    const parsed = JSON.parse(raw) as {
      controls: Snapshot;
      enums?: Record<string, string[]>;
      enumSince?: Record<string, Record<string, string>>;
      enumKeys?: Record<string, Record<string, string>>;
      typePatterns?: Record<string, unknown>;
      modelTypes?: Record<string, unknown>;
      ui5Version?: string;
    };
    Object.defineProperty(parsed.controls, "__enums", {
      value: parsed.enums || {},
      enumerable: false,
    });
    Object.defineProperty(parsed.controls, "__enumSince", {
      value: parsed.enumSince || {},
      enumerable: false,
    });
    Object.defineProperty(parsed.controls, "__enumKeys", {
      value: parsed.enumKeys || {},
      enumerable: false,
    });
    /* The DataType patterns (invalid-css-value) and the model types a
     * binding may name (unknown-binding-type, binding-type-too-new). The
     * linter's loadSnapshot( ) attaches both in every release after 0.8.5,
     * `{}` when the file has no such section; without them those three rules
     * would stay silent in the browser host while CI reports them. An older
     * linter reads neither, so carrying them early costs nothing. */
    Object.defineProperty(parsed.controls, "__typePatterns", {
      value: parsed.typePatterns || {},
      enumerable: false,
    });
    Object.defineProperty(parsed.controls, "__modelTypes", {
      value: parsed.modelTypes || {},
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

/** The UI5 version the snapshot was generated from — undefined for an older
 *  snapshot without the field. `loadSnapshot( )` (and `setSnapshotText( )`)
 *  already ride it along non-enumerably, so this costs no second read of a
 *  several-MB file — and it answers in the web host too, where there is no
 *  `fs` to re-read it with. */
export function snapshotUi5Version(): string | undefined {
  return snapshot().__ui5Version ?? undefined;
}
