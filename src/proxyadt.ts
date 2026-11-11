/**
 * The ADT side of the auth proxy: what a class lookup answers and how a
 * quick-search answer is read. Pure parsing and types - the requests
 * themselves are `SapProxy`'s (`fetchFromSystem`, `fetchClassState`).
 * `proxy.ts` re-exports all of it and is the module to import from.
 */

/** Non-2xx answer from the ADT class lookup, with the status to decide on. */
export class AdtStatusError extends Error {
  constructor(public readonly status: number) {
    super(`ADT answered ${status}`);
  }
}

/** What the ADT metadata of a class says about its current state. */
export interface AdtClassState {
  version?: "active" | "inactive";
  /** Timestamp of the last change, e.g. `2026-07-29T23:28:37Z`. */
  changedAt?: string;
}

/** One class reference out of an ADT quick-search answer. */
export interface AdtClassRef {
  name: string;
  /** The class's short text, when the answer carried one. */
  description?: string;
  /** The package the class lives in, when the answer carried it. */
  packageName?: string;
}

/** The five named XML entities, plus the numeric forms. An attribute value
 *  arrives escaped - a short text of `Sales &amp; Distribution` used to reach
 *  the QuickPick with the `&amp;` still in it. */
function decodeXmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (all, entity: string) => {
      if (entity[0] === "#") {
        const code =
          entity[1] === "x" || entity[1] === "X"
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
      }
      return named[entity.toLowerCase()];
    }
  );
}

/** One attribute of a matched tag, entity-decoded; undefined when absent or
 *  empty. */
function attributeOf(tag: string, name: string): string | undefined {
  const raw = new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
  return raw ? decodeXmlEntities(raw) : undefined;
}

/**
 * Class references out of an ADT quick-search answer. The tag's attribute
 * order is not fixed, so the tag is matched first and its attributes second;
 * only classes count (`CLAS/OC`) - the search itself is not told, because not
 * every ADT version accepts the filter parameter.
 */
export function parseAdtClassRefs(xml: string): AdtClassRef[] {
  const refs: AdtClassRef[] = [];
  for (const tag of xml.matchAll(/<adtcore:objectReference\b[^>]*>/g)) {
    const type = attributeOf(tag[0], "adtcore:type");
    const name = attributeOf(tag[0], "adtcore:name");
    if (type !== "CLAS/OC" || !name || refs.some((ref) => ref.name === name)) {
      continue;
    }
    refs.push({
      name,
      description: attributeOf(tag[0], "adtcore:description"),
      packageName: attributeOf(tag[0], "adtcore:packageName"),
    });
  }
  return refs;
}
