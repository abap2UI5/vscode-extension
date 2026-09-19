/*
 * mockgen - a `<class>.mock.json` skeleton out of the model shape the linter
 * derives from a class.
 *
 * Both the systemless preview and the linter's `--screenshot` read a
 * `zcl_app.mock.json` next to `zcl_app.clas.abap` and merge it over the
 * derived model, root by root. Without one, a table the class fills from a
 * SELECT renders empty; the shape says what the file has to look like, and
 * typing every field of every row by hand is where the mismatch comes from.
 *
 * So the shape is walked once: per bound root a string gets a short sample
 * text, a number 0, a boolean false, a structure its fields recursively, a
 * table two example rows of its row shape. A root typed by something the
 * class does not declare (a DDIC structure, marked `__unknownShape`) has no
 * fields to invent and is written as an empty object with its name in the
 * report, so the author knows where to fill in by hand.
 *
 * `vscode`-free: shape in, JSON text out.
 */

/** How many rows a table gets - enough to see a list is a list. */
export const MOCK_ROWS = 2;

/** A runaway or self-referential shape has to end somewhere; the linter's
 *  own cap for declared types is deeper, real view models are not. */
const MAX_DEPTH = 8;

/** The linter's marker for a bound variable typed by something the class
 *  does not declare - non-enumerable, so it never reaches the JSON. */
function isUnknown(node: unknown): boolean {
  return (
    !!node &&
    typeof node === "object" &&
    (node as { __unknownShape?: boolean }).__unknownShape === true
  );
}

/**
 * A readable sample for a string field: the field name without its
 * Hungarian prefix, in sentence case, numbered by row inside a table.
 * `MV_NAME` -> `Name`, `CITY` in row 2 -> `City 2`. Empty strings would
 * satisfy the shape and show nothing, which is what the file exists to fix.
 */
export function sampleText(field: string, row?: number): string {
  const bare = field.replace(/^[A-Za-z]{1,2}_(?=\w)/, "").replace(/_/g, " ").toLowerCase();
  const text = bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : "Sample";
  return row === undefined ? text : `${text} ${row}`;
}

export interface MockSkeleton {
  /** The data, ready for `JSON.stringify`. */
  data: Record<string, unknown>;
  /** Roots whose shape the class does not declare - written as `{}`. */
  unknownRoots: string[];
}

function sample(
  node: unknown,
  field: string,
  row: number | undefined,
  depth: number,
  unknown: string[],
  path: string
): unknown {
  if (depth > MAX_DEPTH) {
    return null;
  }
  if (Array.isArray(node)) {
    const rowShape = node[0];
    if (rowShape === undefined || rowShape === null) {
      return []; // a table of scalars, or one whose row the class does not declare
    }
    const rows: unknown[] = [];
    for (let i = 1; i <= MOCK_ROWS; i++) {
      rows.push(sample(rowShape, field, i, depth + 1, unknown, path));
    }
    return rows;
  }
  if (node !== null && typeof node === "object") {
    if (isUnknown(node)) {
      unknown.push(path);
      return {};
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(node as Record<string, unknown>)) {
      out[key] = sample(
        (node as Record<string, unknown>)[key],
        key,
        row,
        depth + 1,
        unknown,
        `${path}/${key}`
      );
    }
    return out;
  }
  if (typeof node === "number") {
    return 0;
  }
  if (typeof node === "boolean") {
    return false;
  }
  return sampleText(field, row);
}

/**
 * The skeleton for a model shape as `prepareAbap( ).modelShape` hands it
 * out: every bound root, filled as described above. A shape that is not an
 * object (no builder, no bindings) yields an empty skeleton.
 */
export function mockSkeleton(shape: unknown): MockSkeleton {
  const unknownRoots: string[] = [];
  const data: Record<string, unknown> = {};
  if (shape !== null && typeof shape === "object" && !Array.isArray(shape)) {
    for (const root of Object.keys(shape as Record<string, unknown>)) {
      data[root] = sample(
        (shape as Record<string, unknown>)[root],
        root,
        undefined,
        0,
        unknownRoots,
        root
      );
    }
  }
  return { data, unknownRoots };
}

/** The file's text: pretty-printed, two-space indented, final newline - what
 *  the linter's `mockModelFor` parses and abapGit-style diffs read well. */
export function mockJson(shape: unknown): string {
  return `${JSON.stringify(mockSkeleton(shape).data, null, 2)}\n`;
}
