/*
 * Binding-path offers from the model shape the linter derives out of a class.
 *
 * `prepareAbap( ).modelShape` is what the property gate judges binding paths
 * against: every declared field of every declared structure, tables as a
 * one-row array, and an `__unknownShape` marker on anything typed by a
 * structure the class does not declare (a DDIC type). The gate uses it to
 * report a path the model does not have - this module walks the same shape
 * forwards, so the paths that exist can be OFFERED while the binding is being
 * written instead of only reported afterwards.
 *
 * `vscode`-free: shapes in, paths out - covered by the test suite.
 */

/** A row/structure node whose fields the class does not declare - nothing
 *  below it can be offered (the gate does not report below it either). */
function isUnknown(node: unknown): boolean {
  return (
    !!node &&
    typeof node === "object" &&
    (node as { __unknownShape?: boolean }).__unknownShape === true
  );
}

/** The row a table node hands to its aggregation template. */
function rowOf(node: unknown): unknown {
  return Array.isArray(node) ? node[0] : node;
}

export interface PathOffer {
  /** The full path from the offer's root, e.g. `/TRAVELS/STATUS` or `NAME`. */
  path: string;
  /** True for a table - what an aggregation (`items`, `rows`, ...) binds. */
  table: boolean;
}

/** A runaway or self-referential shape has to end somewhere; real view
 *  models are nowhere near this deep. */
const MAX_DEPTH = 4;

function collect(
  node: unknown,
  prefix: string,
  depth: number,
  out: PathOffer[]
): void {
  if (depth > MAX_DEPTH || node === null || typeof node !== "object" || isUnknown(node)) {
    return;
  }
  const row = rowOf(node);
  if (row === null || typeof row !== "object" || isUnknown(row)) {
    return;
  }
  for (const key of Object.keys(row)) {
    const value = (row as Record<string, unknown>)[key];
    const path = `${prefix}${key}`;
    out.push({ path, table: Array.isArray(value) });
    // Deeper levels mirror how the gate resolves a path: a table is entered
    // through its row, so `/TAB/FIELD` addresses a field of one row.
    collect(value, `${path}/`, depth + 1, out);
  }
}

/**
 * Every absolute path the model shape can resolve, with the leading `/`.
 */
export function absoluteOffers(shape: unknown): PathOffer[] {
  const out: PathOffer[] = [];
  collect(shape, "/", 0, out);
  return out;
}

/**
 * Every relative path resolvable against a row shape - what a binding inside
 * an aggregation template addresses.
 */
export function relativeOffers(row: unknown): PathOffer[] {
  const out: PathOffer[] = [];
  collect(row, "", 0, out);
  return out;
}

/** What a written path resolves to in the shape - the hover's answer. */
export type PathKind =
  | "table"
  | "structure"
  | "field"
  /** Below a structure the class does not declare - accepted unchecked. */
  | "unknown-shape"
  /** Not in the derived model at all - the gate reports this. */
  | "missing";

/**
 * Resolves one written path the way the gate does: segment by segment,
 * entering a table through its row, giving up the moment an undeclared
 * shape is entered (below it, everything is accepted unchecked).
 */
export function resolvePathKind(root: unknown, path: string): PathKind {
  let current: unknown = root;
  for (const segment of path.split("/").filter(Boolean)) {
    current = rowOf(current);
    if (current === null || typeof current !== "object") {
      return "missing";
    }
    if (isUnknown(current)) {
      return "unknown-shape";
    }
    if (!(segment in (current as Record<string, unknown>))) {
      return "missing";
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (Array.isArray(current)) {
    return "table";
  }
  if (current !== null && typeof current === "object") {
    return isUnknown(current) ? "unknown-shape" : "structure";
  }
  return "field";
}

/**
 * The row shape the innermost enclosing aggregation binding hands down.
 *
 * `aggregations` are the bound aggregation paths of the `ele( )` chain
 * around the cursor, outermost first - `/TRAVELS` then `SUBITEMS` for a list
 * nested in a list. Each is resolved the way the gate resolves it: an
 * absolute path against the model root, a relative one against the row of
 * the level above. Returns undefined when any level cannot be followed
 * (a named model, an expression, an unknown shape) - offering guessed row
 * fields would be noise, not help.
 */
export function rowShapeFor(
  shape: unknown,
  aggregations: string[]
): unknown | undefined {
  let row: unknown;
  for (const path of aggregations) {
    const base = path.startsWith("/") ? shape : row;
    if (base === null || base === undefined || typeof base !== "object") {
      return undefined;
    }
    let current: unknown = base;
    for (const segment of path.split("/").filter(Boolean)) {
      current = rowOf(current);
      if (
        current === null ||
        typeof current !== "object" ||
        isUnknown(current) ||
        !(segment in (current as Record<string, unknown>))
      ) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    row = rowOf(current);
    if (row === null || typeof row !== "object" || isUnknown(row)) {
      return undefined;
    }
  }
  return row;
}
