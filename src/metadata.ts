/*
 * Queries over the bundled UI5 metadata snapshot.
 *
 * The snapshot the property gate validates against carries far more than the
 * gate uses: every control's parent chain, `@since` and `@deprecated`, all
 * declared properties, aggregations, associations and events with their
 * types, plus the enum tables. That is a complete UI5 API reference sitting in
 * `dist/properties.json` already — this module turns it into the answers
 * completion and hover need, so both features cost no dependency, no network
 * and no SAP system.
 *
 * `vscode`-free: the snapshot comes in as data.
 */

/** One control's entry in the snapshot. */
interface ControlEntry {
  parent?: string;
  since?: string;
  deprecated?: Deprecation;
  defaultAggregation?: string;
  /** member -> @since, the flattened index the gate uses. */
  members?: Record<string, string | undefined>;
  properties?: Record<string, MemberEntry>;
  aggregations?: Record<string, MemberEntry>;
  associations?: Record<string, MemberEntry>;
  events?: Record<string, MemberEntry>;
}

interface MemberEntry {
  type?: string;
  since?: string;
  multiple?: boolean;
  deprecated?: Deprecation;
  params?: Record<string, { type?: string }>;
}

type Deprecation = { since?: string | null; text?: string } | string | boolean;

/** The snapshot as `loadSnapshot( )` hands it over: the controls map, with the
 *  enum table and the snapshot's UI5 version riding along non-enumerably. */
export type Snapshot = Record<string, ControlEntry> & {
  __enums?: Record<string, string[]>;
  __ui5Version?: string | null;
};

/** The four member kinds, in the order they are offered. */
export const SECTIONS = [
  "properties",
  "aggregations",
  "associations",
  "events",
] as const;

export type Section = (typeof SECTIONS)[number];

export interface MemberInfo {
  name: string;
  section: Section;
  type?: string;
  since?: string;
  multiple?: boolean;
  deprecated?: Deprecation;
  /** Where in the parent chain it is declared — shown in the hover. */
  declaredOn: string;
}

export interface ControlInfo {
  name: string;
  parent?: string;
  since?: string;
  deprecated?: Deprecation;
  defaultAggregation?: string;
}

/** Guards against a cycle in a hand-edited snapshot; the deepest real UI5
 *  chain is nowhere near this. */
const MAX_DEPTH = 20;

/** The control and every ancestor of it that the snapshot knows. */
function chainOf(data: Snapshot, control: string): string[] {
  const chain: string[] = [];
  let current: string | undefined = control;
  for (let depth = 0; current && data[current] && depth < MAX_DEPTH; depth++) {
    chain.push(current);
    current = data[current].parent;
  }
  return chain;
}

export function controlInfo(
  data: Snapshot,
  control: string
): ControlInfo | undefined {
  const entry = data[control];
  return entry
    ? {
        name: control,
        parent: entry.parent,
        since: entry.since,
        deprecated: entry.deprecated,
        defaultAggregation: entry.defaultAggregation,
      }
    : undefined;
}

/** Local names of every control in a library — what a control position
 *  completes to. Sorted, so the list does not jump around between snapshots. */
export function controlsIn(data: Snapshot, library: string): string[] {
  const prefix = `${library}.`;
  const out: string[] = [];
  for (const name of Object.keys(data)) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const local = name.slice(prefix.length);
    // Only direct children of the library — `sap.m.semantic.X` belongs to
    // `sap.m.semantic`, and a view naming it writes that namespace itself.
    if (!local.includes(".")) {
      out.push(local);
    }
  }
  return out.sort();
}

/**
 * Memo for {@link membersOf}, per snapshot. The snapshot is loaded once and
 * never mutated, so what is derived from it holds for as long as it does; a
 * WeakMap keeps a replaced snapshot (and everything derived from it)
 * collectable.
 *
 * Without it one member completion rebuilt this list a few hundred times:
 * `describeMember` asks per offered entry, and it asks twice - once for the
 * member and once for its type's values - each time walking the whole
 * inheritance chain and sorting the result. The same call also backs the
 * aggregation test in every binding query and the colour pass over the
 * document, both of which run per attribute.
 */
const memberCache = new WeakMap<Snapshot, Map<string, MemberInfo[]>>();

/**
 * Every member the control accepts, walking the parent chain. A member
 * redeclared further down the chain wins — that is where its own `@since` and
 * `@deprecated` live.
 */
export function membersOf(data: Snapshot, control: string): MemberInfo[] {
  let perControl = memberCache.get(data);
  if (!perControl) {
    perControl = new Map();
    memberCache.set(data, perControl);
  }
  const cached = perControl.get(control);
  if (cached) {
    return cached;
  }
  const members = computeMembersOf(data, control);
  perControl.set(control, members);
  return members;
}

function computeMembersOf(data: Snapshot, control: string): MemberInfo[] {
  const seen = new Map<string, MemberInfo>();
  for (const owner of chainOf(data, control)) {
    const entry = data[owner];
    for (const section of SECTIONS) {
      for (const [name, decl] of Object.entries(entry[section] ?? {})) {
        if (seen.has(name)) {
          continue;
        }
        seen.set(name, {
          name,
          section,
          type: decl.type,
          since: decl.since ?? entry.members?.[name],
          multiple: decl.multiple,
          deprecated: decl.deprecated,
          declaredOn: owner,
        });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One member of a control, or undefined when nothing in the chain declares
 *  it — which is exactly what `unknown-property` reports. */
export function memberInfo(
  data: Snapshot,
  control: string,
  member: string
): MemberInfo | undefined {
  return membersOf(data, control).find((m) => m.name === member);
}

/** Drops the derived-member memo - for a test that swaps the snapshot for a
 *  fixture with the same identity, which nothing in the extension does. */
export function clearMemberCache(data: Snapshot): void {
  memberCache.delete(data);
}

/** The values of an enum type, e.g. `sap.m.ButtonType` -> Default, Accept, … */
export function enumValues(data: Snapshot, type?: string): string[] | undefined {
  if (!type) {
    return undefined;
  }
  return data.__enums?.[type];
}

/** The values a member accepts: an enum's, or the two booleans. */
export function valuesFor(
  data: Snapshot,
  control: string,
  member: string
): string[] | undefined {
  const info = memberInfo(data, control, member);
  if (!info?.type) {
    return undefined;
  }
  if (info.type === "boolean") {
    return ["true", "false"];
  }
  return enumValues(data, info.type);
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

/** The deprecation as one line, or undefined. The snapshot carries three
 *  shapes for it, because that is what the UI5 JSDoc carries. */
export function deprecationText(deprecated?: Deprecation): string | undefined {
  if (!deprecated) {
    return undefined;
  }
  if (typeof deprecated === "string") {
    return deprecated;
  }
  if (deprecated === true) {
    return "deprecated";
  }
  const since = deprecated.since ? ` since ${deprecated.since}` : "";
  const text = (deprecated.text ?? "").replace(/<\/?code>/g, "`").trim();
  return `Deprecated${since}${text ? ` — ${text}` : ""}`;
}

/** The UI5 API reference page of a control or type — the one link a developer
 *  actually wants next to a property they do not know. */
export function apiDocUrl(name: string): string {
  return `https://ui5.sap.com/#/api/${encodeURIComponent(name)}`;
}

/** Markdown documentation for a control, for the hover and the completion
 *  detail pane. */
export function describeControl(data: Snapshot, control: string): string {
  const info = controlInfo(data, control);
  if (!info) {
    return "";
  }
  const lines = [`**${control}**`];
  const facts: string[] = [];
  if (info.since) {
    facts.push(`since UI5 ${info.since}`);
  }
  if (info.parent) {
    facts.push(`extends \`${info.parent}\``);
  }
  if (info.defaultAggregation) {
    facts.push(`default aggregation \`${info.defaultAggregation}\``);
  }
  if (facts.length) {
    lines.push(facts.join(" · "));
  }
  const deprecated = deprecationText(info.deprecated);
  if (deprecated) {
    lines.push(`⚠️ ${deprecated}`);
  }
  lines.push(`[UI5 API reference](${apiDocUrl(control)})`);
  return lines.join("\n\n");
}

/** Markdown documentation for one member of a control. */
export function describeMember(
  data: Snapshot,
  control: string,
  member: string
): string {
  const info = memberInfo(data, control, member);
  if (!info) {
    return "";
  }
  const kind = info.section.replace(/ies$/, "y").replace(/s$/, "");
  const lines = [
    `**${member}** — ${kind} of \`${info.declaredOn}\``,
  ];
  const facts: string[] = [];
  if (info.type) {
    facts.push(`type \`${info.type}\``);
  }
  if (info.multiple) {
    facts.push("0..n");
  }
  if (info.since) {
    facts.push(`since UI5 ${info.since}`);
  }
  if (facts.length) {
    lines.push(facts.join(" · "));
  }
  const values = valuesFor(data, control, member);
  if (values?.length) {
    lines.push(values.map((v) => `\`${v}\``).join(", "));
  }
  const deprecated = deprecationText(info.deprecated);
  if (deprecated) {
    lines.push(`⚠️ ${deprecated}`);
  }
  lines.push(`[UI5 API reference](${apiDocUrl(info.declaredOn)})`);
  return lines.join("\n\n");
}
