import {
  abapBindingContextAt,
  abapContextAt,
  abapNsMap,
  BindingContext,
  WriteContext,
  xmlContextAt,
  xmlNsMap,
} from "./context";
import {
  absoluteOffers,
  PathKind,
  PathOffer,
  relativeOffers,
  resolvePathKind,
  rowShapeFor,
} from "./bindingpaths";
import {
  controlsIn,
  describeControl,
  describeMember,
  deprecationText,
  memberInfo,
  membersOf,
  Section,
  Snapshot,
  valuesFor,
} from "./metadata";

/*
 * Completion and hover from the bundled UI5 metadata - the `vscode`-free
 * core. `context.ts` answers where the cursor is, `metadata.ts` answers
 * what may go there; this module combines the two into plain offers
 * (label, kind, documentation, span) that `language.ts` only has to wrap
 * into VS Code types. Everything interesting - which entries, in which
 * order, with which documentation - is decided here, where the test suite
 * can reach it.
 */

export const VIEW_XML_RE = /\.(view|fragment)\.xml$/i;

/** Which analysis a document gets - the builder's method chains, or plain
 *  XML. A `*.view.xml` is XML whatever language id it was given. */
export function isXmlView(fileName: string, text: string): boolean {
  return VIEW_XML_RE.test(fileName) || /^\s*</.test(text);
}

function contextAt(
  text: string,
  fileName: string,
  offset: number
): WriteContext | undefined {
  return isXmlView(fileName, text)
    ? xmlContextAt(text, offset)
    : abapContextAt(text, offset);
}

/** Members are offered properties-first: that is what a view writes most. */
const SECTION_ORDER: Record<Section, string> = {
  properties: "1",
  aggregations: "2",
  associations: "3",
  events: "4",
};

/** What one completion entry is - the section for members, so the plumbing
 *  can pick the icon that reads right in the list. */
export type CompletionKind =
  | "control"
  | Section
  | "value"
  | "namespace"
  | "binding-path"
  | "binding-table";

export interface CompletionEntry {
  label: string;
  kind: CompletionKind;
  detail?: string;
  /** Markdown for the details pane. */
  documentation?: string;
  sortText?: string;
  deprecated?: boolean;
}

/** The entries to offer, replacing the span `[start, end)` of the text. */
export interface CompletionOffer {
  start: number;
  end: number;
  entries: CompletionEntry[];
}

/** The predicate `abapBindingContextAt` needs: is this member of this
 *  control an aggregation (whose binding hands a row down)? */
function aggregationPredicate(data: Snapshot) {
  return (control: string, member: string): boolean =>
    membersOf(data, control).some(
      (m) => m.name === member && m.section === "aggregations"
    );
}

/**
 * Completions inside a `{…}` binding: the paths the derived model actually
 * has - the same shape the gate reports `unknown-binding-path` against, so
 * what is offered here is exactly what will not squiggle afterwards. Row
 * fields of the enclosing aggregation first, absolute paths after.
 */
function bindingEntries(
  binding: BindingContext,
  shape: unknown
): CompletionEntry[] {
  if (!shape) {
    return [];
  }
  const make = (offer: PathOffer, group: string): CompletionEntry => ({
    label: offer.path,
    kind: offer.table ? "binding-table" : "binding-path",
    detail: offer.table ? "table - what an aggregation binds" : "model path",
    sortText: `${group}${offer.path}`,
  });
  const entries: CompletionEntry[] = [];
  if (binding.aggregations.length) {
    const row = rowShapeFor(shape, binding.aggregations);
    if (row) {
      // The row the enclosing aggregation hands down - what a relative
      // path means right here.
      entries.push(...relativeOffers(row).map((offer) => make(offer, "0")));
    }
  }
  entries.push(...absoluteOffers(shape).map((offer) => make(offer, "1")));
  return entries;
}

/**
 * The completion offer at one position, or undefined when nothing is
 * completable there. `shapeOf` supplies the derived model shape lazily -
 * deriving it walks the whole source, and most positions never need it.
 */
export function completionAt(
  text: string,
  fileName: string,
  offset: number,
  data: Snapshot,
  shapeOf: () => unknown
): CompletionOffer | undefined {
  // A binding being written wins over the enum values of the member - the
  // `{` says the value is a path, not a literal.
  if (!isXmlView(fileName, text)) {
    const binding = abapBindingContextAt(text, offset, aggregationPredicate(data));
    if (binding) {
      return {
        start: binding.start,
        end: binding.end,
        entries: bindingEntries(binding, shapeOf()),
      };
    }
  }

  const context = contextAt(text, fileName, offset);
  if (!context) {
    return undefined;
  }
  const span = { start: context.start, end: context.end };

  if (context.kind === "control" && context.library) {
    return {
      ...span,
      entries: controlsIn(data, context.library).map((local) => {
        const full = `${context.library}.${local}`;
        return {
          label: local,
          kind: "control" as const,
          detail: context.library,
          documentation: describeControl(data, full),
          deprecated: !!deprecationText(data[full]?.deprecated),
        };
      }),
    };
  }

  if (context.kind === "member" && context.control) {
    return {
      ...span,
      entries: membersOf(data, context.control).map((member) => {
        // Own members before inherited ones, properties before the rest.
        const inherited = member.declaredOn === context.control ? "0" : "1";
        return {
          label: member.name,
          kind: member.section,
          detail: member.type ?? member.section,
          documentation: describeMember(data, context.control!, member.name),
          sortText: `${SECTION_ORDER[member.section]}${inherited}${member.name}`,
          deprecated: !!deprecationText(member.deprecated),
        };
      }),
    };
  }

  if (context.kind === "value" && context.control && context.member) {
    const values = valuesFor(data, context.control, context.member);
    return {
      ...span,
      entries: (values ?? []).map((value) => ({
        label: value,
        kind: "value" as const,
      })),
    };
  }

  if (context.kind === "namespace") {
    const map = VIEW_XML_RE.test(fileName) ? xmlNsMap(text) : abapNsMap(text);
    return {
      ...span,
      entries: Object.entries(map)
        .filter(([prefix]) => prefix)
        .map(([prefix, library]) => ({
          label: prefix,
          kind: "namespace" as const,
          detail: library,
        })),
    };
  }

  return { ...span, entries: [] };
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

/** What the hover says about one resolved binding path. */
export const PATH_KIND_TEXT: Record<PathKind, string> = {
  table:
    "a **table** in the derived model - what an aggregation (`items`, `rows`, …) " +
    "binds. Inside its template, relative paths address one row.",
  structure: "a **structure** in the derived model.",
  field: "a **field** in the derived model - the binding resolves.",
  "unknown-shape":
    "below a structure this class does not declare (a DDIC or foreign type). " +
    "The view check accepts any path here rather than guess.",
  missing:
    "**not in the derived model** - the view check reports this as " +
    "`unknown-binding-path`, and at runtime the binding stays silently empty.",
};

/** Markdown to show for the span `[start, end)`. */
export interface HoverInfo {
  start: number;
  end: number;
  text: string;
}

/** Hover for a `{…}` path: what the derived model says about it. */
function bindingHoverAt(
  text: string,
  offset: number,
  data: Snapshot,
  shapeOf: () => unknown
): HoverInfo | undefined {
  const binding = abapBindingContextAt(text, offset, aggregationPredicate(data));
  if (!binding) {
    return undefined;
  }
  const path = text.slice(binding.start, binding.end);
  if (!path) {
    return undefined;
  }
  const shape = shapeOf();
  if (!shape) {
    return undefined;
  }
  let explained: string;
  if (path.startsWith("/")) {
    explained = PATH_KIND_TEXT[resolvePathKind(shape, path)];
  } else if (binding.aggregations.length) {
    const row = rowShapeFor(shape, binding.aggregations);
    explained = row
      ? PATH_KIND_TEXT[resolvePathKind(row, path)] +
        `\n\nRelative to the row of \`{${binding.aggregations[binding.aggregations.length - 1]}}\`.`
      : "a relative path - the enclosing aggregation binds something the " +
        "derived model cannot follow, so the row's fields are unknown here.";
  } else {
    explained =
      "a **relative path** - it addresses the row handed down by an " +
      "enclosing aggregation binding, and none is in effect here.";
  }
  return {
    start: binding.start,
    end: binding.end,
    text: `\`{${path}}\` — ${explained}`,
  };
}

/** The hover at one position, or undefined when there is nothing to say. */
export function hoverAt(
  text: string,
  fileName: string,
  offset: number,
  data: Snapshot,
  shapeOf: () => unknown
): HoverInfo | undefined {
  if (!isXmlView(fileName, text)) {
    const binding = bindingHoverAt(text, offset, data, shapeOf);
    if (binding) {
      return binding;
    }
  }
  const context = contextAt(text, fileName, offset);
  if (!context) {
    return undefined;
  }
  const span = { start: context.start, end: context.end };
  const word = text.slice(context.start, context.end);
  if (!word) {
    return undefined;
  }

  if (context.kind === "control" && context.library) {
    const explained = describeControl(data, `${context.library}.${word}`);
    return explained ? { ...span, text: explained } : undefined;
  }
  if (context.kind === "member" && context.control) {
    const explained = describeMember(data, context.control, word);
    return explained ? { ...span, text: explained } : undefined;
  }
  // On a value, what helps is the member it belongs to: its type and, for
  // an enum, everything else that would have been allowed there.
  if (context.kind === "value" && context.control && context.member) {
    const explained = describeMember(data, context.control, context.member);
    return explained ? { ...span, text: explained } : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Colour-typed members
// ---------------------------------------------------------------------------

/** Whether a member takes a CSS colour - `sap.ui.core.CSSColor` (and the
 *  types derived from it) say so themselves; a string property whose name
 *  ends in "color" (`backgroundColor` on a few older controls) counts too. */
export function isColorMember(
  data: Snapshot,
  control: string,
  member: string
): boolean {
  const type = memberInfo(data, control, member)?.type;
  if (!type) {
    return false;
  }
  return /CSSColor$/.test(type) || (type === "string" && /color$/i.test(member));
}
