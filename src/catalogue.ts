/*
 * catalogue - reading the sample repositories' own `catalogue.json`.
 *
 * The three sample repositories describe themselves in a committed
 * `catalogue.json` at their root - one entry per sample, with the class name,
 * the file path and the words the sample is about. `examples.ts` searches the
 * ABAP of a local checkout; this module is the answer for the beginner who
 * has no checkout at all: the same three repositories, matched through their
 * catalogues fetched from GitHub, with each hit opening on github.com.
 *
 * The shapes are external contracts owned by the sample repositories, and
 * they are three SIBLINGS, not one format: `samples` and `samples-stack`
 * list under "samples", `samples-controls` under "ports"; the entry's path
 * is "file" in two of them and "path" in the third; keywords arrive as an
 * array in two and as one space-separated string in the other. The parser
 * reads only what it needs, skips what it cannot read, and ignores every
 * unknown field - a catalogue that grows a section must not break an
 * installed extension. `src/test/fixtures/catalogue-*.json` pin the shapes
 * this module relies on, one trimmed real excerpt per repository.
 *
 * `vscode`-free: parsing and matching are plain string work. The fetch, the
 * cache and the QuickPick live in `exampleview.ts`.
 */

/** One sample out of a repository's `catalogue.json`, reduced to what the
 *  example search needs. */
export interface CatalogueEntry {
  /** The sample's class name, e.g. `z2ui5_cl_smpc_app_092`. */
  className: string;
  /** Repo-relative path of the class, e.g. `src/02/01/z2ui5_cl_smpc_app_092.clas.abap`. */
  file: string;
  /** The entry's human title. */
  title: string;
  /** What the sample shows - the entry's summary or description. */
  summary: string;
  /** Lower-cased keyword tokens, whichever form the catalogue carried them in. */
  keywords: string[];
  /** The full UI5 entity a port demonstrates (`sap.m.Table`), when the
   *  catalogue names one - only samples-controls does. */
  entity?: string;
  /** The branch the file lives on, when the catalogue names one. Only
   *  samples-stack does, and it means it: its entries sit on per-topic
   *  branches (`02-smart-controls`), so a link to `main` is a 404. */
  branch?: string;
}

/** A catalogue entry matched against a control, ready to show. */
export interface CatalogueHit extends CatalogueEntry {
  /** The repository the entry came from, e.g. `samples-controls`. */
  repo: string;
  /** How specifically this entry is about the control (higher is better). */
  score: number;
  /** Where the class can be read without a checkout. */
  url: string;
}

/** The GitHub repositories that commit a `catalogue.json`, and therefore can
 *  answer remotely - the same three the local search walks. */
export const CATALOGUE_REPOS = ["samples", "samples-controls", "samples-stack"] as const;

/** Where a repository's committed catalogue is fetched from (default branch). */
export function catalogueUrl(repo: string): string {
  return `https://raw.githubusercontent.com/abap2UI5/${repo}/main/catalogue.json`;
}

/**
 * Where a catalogue entry's class opens when there is no local checkout.
 *
 * The branch is the entry's own when it names one. samples-stack keeps its
 * samples on per-topic branches and says so in every entry - and the branch
 * was read nowhere, so each of its hits opened a `blob/main/...` url for a
 * file that only exists on `02-smart-controls` and answered 404.
 */
export function blobUrl(repo: string, file: string, branch = "main"): string {
  return `https://github.com/abap2UI5/${repo}/blob/${branch}/${file}`;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Keywords arrive as `["table", "grid"]` in samples/samples-stack and as
 *  `"table sap.m grid"` in samples-controls - both become lower-cased tokens. */
function asKeywords(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((k): k is string => typeof k === "string").map((k) => k.toLowerCase());
  }
  if (typeof value === "string") {
    return value.toLowerCase().split(/\s+/).filter(Boolean);
  }
  return [];
}

function asEntry(value: unknown): CatalogueEntry | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const className = asString(raw.class);
  // "file" in samples and samples-controls, "path" in samples-stack
  const file = asString(raw.file) || asString(raw.path);
  if (!className || !file) {
    return undefined;
  }
  return {
    className,
    file,
    title: asString(raw.title),
    summary: asString(raw.summary) || asString(raw.description),
    keywords: asKeywords(raw.keywords),
    entity: asString(raw.entity) || undefined,
    branch: asString(raw.branch) || undefined,
  };
}

/**
 * The entries out of one repository's `catalogue.json` text.
 *
 * Tolerant on purpose: the list is whichever top-level array holds
 * class-and-path entries (today "samples" or "ports"), entries missing either
 * field are skipped rather than fatal, and unknown fields everywhere are
 * ignored. Unparseable text is an empty catalogue, not an exception - the
 * caller treats "nothing" the same either way.
 */
export function parseCatalogue(raw: string): CatalogueEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const entries: CatalogueEntry[] = [];
  for (const value of Object.values(parsed)) {
    if (!Array.isArray(value)) {
      continue;
    }
    const found = value.map(asEntry).filter((e): e is CatalogueEntry => e !== undefined);
    // "packages" in samples-stack is also an array of objects, but its rows
    // have no class - only the real entry list survives the filter.
    if (found.length) {
      entries.push(...found);
    }
  }
  return entries;
}

/**
 * The entries that are about the given control, most specific first.
 *
 * A catalogue names no source lines, so the match runs over what it does
 * name: the demonstrated entity (samples-controls - the strongest signal, it
 * IS the control), the keyword list, and the title/summary words. A control
 * name that merely appears inside a longer word is not a hit - `Table` must
 * not match `TableSelectDialog`, the same distinction the source search draws.
 */
export function matchCatalogue(
  entries: readonly CatalogueEntry[],
  control: string,
  repo: string,
  limit = 8
): CatalogueHit[] {
  const full = control.toLowerCase();
  const local = full.includes(".") ? full.slice(full.lastIndexOf(".") + 1) : full;
  if (!local) {
    return [];
  }
  const word = new RegExp(`\\b${local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const scored: CatalogueHit[] = [];
  for (const entry of entries) {
    let score = 0;
    const entity = (entry.entity ?? "").toLowerCase();
    if (entity && (entity === full || entity.slice(entity.lastIndexOf(".") + 1) === local)) {
      score = entity === full ? 4 : 3;
    } else if (entry.keywords.includes(local)) {
      score = 2;
    } else if (word.test(entry.title) || word.test(entry.summary)) {
      score = 1;
    }
    if (score > 0) {
      scored.push({
        ...entry,
        repo,
        score,
        url: blobUrl(repo, entry.file, entry.branch),
      });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.className.localeCompare(b.className))
    .slice(0, limit);
}
