import type { ViewNode } from "@abap2ui5/linter/reconstruct";

/*
 * annotations - what the editor can say ABOUT a line without being asked.
 *
 * Two things, one mechanism. Both are patterns borrowed from ecosystems where
 * they became the feature nobody gives up again:
 *
 *   - the UI5 `@since` of the control or member being written, next to it
 *     (Version Lens, which puts the current version behind a dependency). The
 *     abap2UI5 question is permanent - "does my system have this yet?" - and
 *     the answer is already in the bundled metadata, but today it only arrives
 *     as a finding once the floor is crossed.
 *
 *   - what a PUBLIC attribute costs per roundtrip (Import Cost, which puts the
 *     bundle size behind an import). abap2UI5 serializes every PUBLIC
 *     attribute into the model on EVERY roundtrip, which is the kind of thing
 *     one knows and still forgets.
 *
 * `vscode`-free: deciding what a line deserves is string and metadata work,
 * and the decorations around it are plumbing.
 */

export interface Annotation {
  /** Character offset the annotation belongs to - the caller turns it into a
   *  line and hangs the text off its end. */
  offset: number;
  /** The short text shown after the line. */
  text: string;
  /** Worth a warning colour: a version above the floor, a cost worth seeing. */
  warn?: boolean;
  /** The longer form, for the hover. */
  tooltip?: string;
}

/**
 * Compare two UI5 versions. `1.71` < `1.120` - the reason this cannot be a
 * string or a float comparison, and the mistake that would make every control
 * introduced in a three-digit minor look ancient.
 */
export function versionAbove(version: string, floor: string): boolean {
  const parts = (v: string) => v.split(".").map((p) => Number(p) || 0);
  const [a, b] = [parts(version), parts(floor)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) {
      return left > right;
    }
  }
  return false;
}

/** What the metadata knows about when something arrived. Injected, so the
 *  decision stays testable without loading a 4 MB snapshot. */
export interface SinceLookup {
  control(control: string): string | undefined;
  member(control: string, member: string): string | undefined;
}

/** `f:Card` + the class's namespace map -> `sap.f.Card`. */
function qualify(node: ViewNode, ns: Record<string, string>): string | undefined {
  if (!node.name) {
    return undefined;
  }
  const library = ns[node.ns ?? ""] ?? ns[""];
  return library ? `${library}.${node.name}` : undefined;
}

/**
 * The `@since` of every control and every attribute a view writes.
 *
 * Only where the metadata HAS a version: a control declared in no release we
 * know about gets no annotation rather than a guess, and an aggregation the
 * snapshot does not model is silently skipped - the property gate is what
 * reports those, and saying it twice in two ways would be noise.
 */
export function sinceAnnotations(
  nodes: readonly ViewNode[],
  ns: Record<string, string>,
  floor: string,
  lookup: SinceLookup
): Annotation[] {
  const out: Annotation[] = [];
  const walk = (node: ViewNode) => {
    const control = qualify(node, ns);
    if (control && node.offset !== undefined) {
      const since = lookup.control(control);
      if (since) {
        out.push({
          offset: node.offset,
          text: since,
          warn: versionAbove(since, floor),
          tooltip: `${control} is available from UI5 ${since} (your floor is ${floor})`,
        });
      }
    }
    if (control) {
      for (const attr of node.attrs) {
        const [name, , offset] = attr as [string, string, number | undefined];
        if (offset === undefined) {
          continue;
        }
        const since = lookup.member(control, name);
        if (!since) {
          continue;
        }
        out.push({
          offset,
          text: since,
          warn: versionAbove(since, floor),
          tooltip: `${control} ${name} is available from UI5 ${since} (your floor is ${floor})`,
        });
      }
    }
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out.sort((a, b) => a.offset - b.offset);
}

// ---------------------------------------------------------------------------
// What a PUBLIC attribute costs per roundtrip
// ---------------------------------------------------------------------------

/** A declaration in the class's PUBLIC SECTION, with where its name stands. */
interface PublicAttribute {
  name: string;
  offset: number;
}

/**
 * The attributes the class ships. Only the PUBLIC section, because that is
 * exactly what abap2UI5 serializes - a protected attribute costs nothing per
 * roundtrip and would be a lie to annotate.
 */
export function publicAttributes(source: string): PublicAttribute[] {
  const start = /^\s*PUBLIC\s+SECTION\s*\./im.exec(source);
  if (!start) {
    return [];
  }
  const from = start.index + start[0].length;
  const rest = source.slice(from);
  const end = /^\s*(?:PROTECTED\s+SECTION|PRIVATE\s+SECTION)\s*\.|^\s*ENDCLASS\s*\./im.exec(rest);
  const section = rest.slice(0, end ? end.index : rest.length);
  const out: PublicAttribute[] = [];
  /*
   * Statement by statement, not line by line. A declaration comes in two
   * shapes - `DATA a TYPE x.` and the chained `DATA: a TYPE x,\n b TYPE y.` -
   * and in the chained one every entry after the first begins on a line that
   * says nothing about being a declaration. A per-line regex finds the first
   * and silently drops the rest.
   */
  for (const statement of statements(section)) {
    if (!/^\s*(?:CLASS-)?DATA\b/i.test(statement.text)) {
      continue;
    }
    for (const declared of statement.text.matchAll(/([a-z_]\w*)\s+TYPE\b/gi)) {
      out.push({
        name: declared[1],
        offset: from + statement.start + (declared.index ?? 0),
      });
    }
  }
  return out;
}

/** ABAP statements of a source fragment: split at the periods that are not
 *  inside a string literal (`VALUE '3.14'` ends no statement). */
function statements(source: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  let start = 0;
  let quote: string | undefined;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) {
        quote = source[i + 1] === quote ? (i++, quote) : undefined;
      }
      continue;
    }
    if (ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === ".") {
      out.push({ text: source.slice(start, i), start });
      start = i + 1;
    }
  }
  if (source.slice(start).trim()) {
    out.push({ text: source.slice(start), start });
  }
  return out;
}

/**
 * What each PUBLIC attribute adds to a roundtrip.
 *
 * The number comes from the model the picture would render with - the class's
 * own literal seeds, or the mock file when there is one - so it is measured
 * rather than guessed, and the label says which. Where the model knows
 * nothing (a table a SELECT fills at runtime), the annotation still says the
 * attribute IS shipped, because that is the fact worth seeing; inventing a
 * size for it would be worse than saying nothing.
 */
export function costAnnotations(
  source: string,
  model: Record<string, unknown>,
  fromMock: boolean
): Annotation[] {
  return publicAttributes(source).map(({ name, offset }) => {
    const value = model[name.toUpperCase()];
    if (value === undefined || value === null || value === "") {
      return {
        offset,
        text: "sent every roundtrip",
        tooltip:
          `${name.toUpperCase()} is PUBLIC, so abap2UI5 serializes it into the model on ` +
          "every roundtrip. Its size here is unknown - the derived model has no data for it.",
      };
    }
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    return {
      offset,
      text: `${formatBytes(bytes)} / roundtrip`,
      // a model measured in KB is worth a second look: it travels in both
      // directions on every single event
      warn: bytes >= 2048,
      tooltip:
        `${name.toUpperCase()} is PUBLIC, so it is serialized into the model on every ` +
        `roundtrip - ${bytes} bytes as ${fromMock ? "the mock file" : "the class's own seeds"} ` +
        "fill it here.",
    };
  });
}

export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}
