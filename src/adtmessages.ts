/**
 * What an ADT activation answer says about a class, and where on disk it
 * says it - `vscode`-free (T09).
 *
 * The answer's shape is the one the open-source ADT client abap-adt-api
 * reads in `src/api/activate.ts` (`activate`): a `chkl:messages` root with
 * one `msg` element per message, its attributes `objDescr`, `type`, `line`,
 * `href` and `forceSupported`, the text in a `shortText` child's `txt`, and -
 * when objects stayed inactive - an `ioc:inactiveObjects` list with
 * `ioc:entry` elements. That library counts an activation as failed when any
 * message has a type of E, A or X, or when anything stayed inactive; this
 * module decides the same way. The position is the `#start=line,column`
 * fragment of the `href` (the same fragment `src/api/syntax.ts` reads out of
 * check-run messages, `/([^#]+)#start=(\d+),(\d+)/`), and its path names the
 * include: `/source/main` or `/includes/<definitions|implementations|
 * testclasses>` under `/sap/bc/adt/oo/classes/<name>`. Not verified against
 * a running system here - no SAP system was available.
 */

/** The four parts of a class this extension pushes, as ADT names them. */
export type ClassPart = "main" | "definitions" | "implementations" | "testclasses";

export const CLASS_PARTS: readonly ClassPart[] = [
  "main",
  "definitions",
  "implementations",
  "testclasses",
];

/** The abapGit file of each part, as a suffix of the class's file name. */
export const PART_SUFFIX: Readonly<Record<ClassPart, string>> = {
  main: ".clas.abap",
  definitions: ".clas.locals_def.abap",
  implementations: ".clas.locals_imp.abap",
  testclasses: ".clas.testclasses.abap",
};

export type MessageSeverity = "error" | "warning" | "info";

/** One activation message, placed. `line` is 1-based, `column` 0-based (the
 *  way ADT's `#start=` fragment counts). */
export interface ActivationMessage {
  part: ClassPart;
  line: number;
  column: number;
  severity: MessageSeverity;
  text: string;
}

export interface ActivationOutcome {
  /** False when any message is an error or anything stayed inactive. */
  success: boolean;
  messages: ActivationMessage[];
  /** Names of the objects the answer lists as still inactive. */
  inactive: string[];
}

function decodeXml(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return named[entity.toLowerCase()];
  });
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : undefined;
}

/** E, A and X fail an activation (abap-adt-api's `activate`); W warns. */
export function severityOf(type: string | undefined): MessageSeverity {
  const t = (type ?? "").toUpperCase();
  if (/^[EAX]/.test(t)) {
    return "error";
  }
  if (t.startsWith("W")) {
    return "warning";
  }
  return "info";
}

/**
 * The part of `className` an ADT href points into, or undefined when it
 * points somewhere else (another object, a path this module does not know).
 */
export function partOfHref(href: string, className: string): ClassPart | undefined {
  const path = href.replace(/[?#].*$/, "");
  let decoded: string;
  try {
    decoded = decodeURIComponent(path).toLowerCase();
  } catch {
    decoded = path.toLowerCase();
  }
  const prefix = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`;
  if (!decoded.startsWith(prefix)) {
    return undefined;
  }
  const rest = decoded.slice(prefix.length);
  if (rest === "" || rest === "/" || rest === "/source/main") {
    return "main";
  }
  const include = /^\/includes\/([a-z]+)$/.exec(rest)?.[1];
  if (include === "main") {
    return "main";
  }
  return CLASS_PARTS.includes(include as ClassPart) ? (include as ClassPart) : undefined;
}

/** `#start=line,column` (or `#start=line`) out of an href. */
function startOf(href: string): { line: number; column: number } | undefined {
  const m = /#(?:.*;)?start=(\d+)(?:,(\d+))?/.exec(href);
  if (!m) {
    return undefined;
  }
  return { line: Number(m[1]), column: m[2] ? Number(m[2]) : 0 };
}

/**
 * The activation answer of `className`, read. An empty body is a success
 * without messages (abap-adt-api reads nothing out of an empty answer
 * either). A message without a position, or one about another object, lands
 * on line 1 of the main source - never nowhere - with the object named in
 * front of its text when it is about another one.
 */
export function parseActivationResponse(xml: string, className: string): ActivationOutcome {
  const messages: ActivationMessage[] = [];
  for (const m of xml.matchAll(/<msg\b([^>]*?)(\/>|>([\s\S]*?)<\/msg>)/g)) {
    const tag = m[1];
    const inner = m[3] ?? "";
    const severity = severityOf(attr(tag, "type"));
    const txt = /<txt>([\s\S]*?)<\/txt>/.exec(inner)?.[1];
    // abap-adt-api's fallback for a message without a short text
    let text = txt !== undefined ? decodeXml(txt).trim() : "Syntax error";
    const href = attr(tag, "href") ?? "";
    const part = href ? partOfHref(href, className) : undefined;
    const start = href ? startOf(href) : undefined;
    let line = 1;
    let column = 0;
    if (part) {
      const lineAttr = Number(attr(tag, "line"));
      if (start && start.line > 0) {
        line = start.line;
        column = start.column;
      } else if (Number.isInteger(lineAttr) && lineAttr > 0) {
        line = lineAttr;
      }
    } else {
      const about = attr(tag, "objDescr");
      if (about) {
        text = `${about}: ${text}`;
      }
    }
    messages.push({ part: part ?? "main", line, column, severity, text });
  }
  const inactive: string[] = [];
  const list = /<ioc:inactiveObjects\b[\s\S]*?<\/ioc:inactiveObjects>/.exec(xml)?.[0] ?? "";
  for (const entry of list.matchAll(/<ioc:object\b[^>]*>[\s\S]*?<\/ioc:object>/g)) {
    const ref = /<ioc:ref\b[^>]*>/.exec(entry[0])?.[0];
    const name = ref ? attr(ref, "adtcore:name") : undefined;
    if (name) {
      inactive.push(name);
    }
  }
  const success = inactive.length === 0 && !messages.some((m) => m.severity === "error");
  return { success, messages, inactive };
}

/**
 * Which class part an abapGit file holds, and the class's base path (the
 * file name without the part suffix) - undefined for any other file.
 */
export function partOfFileName(fileName: string): { base: string; part: ClassPart } | undefined {
  const lower = fileName.toLowerCase();
  // longest suffix first: `.clas.abap` is a suffix of none of the others,
  // but the include suffixes must be tried before it all the same
  for (const part of ["definitions", "implementations", "testclasses", "main"] as const) {
    const suffix = PART_SUFFIX[part];
    if (lower.endsWith(suffix)) {
      return { base: fileName.slice(0, fileName.length - suffix.length), part };
    }
  }
  return undefined;
}

/** The abapGit file of `part` beside a class whose base path is `base`. */
export function partFileName(base: string, part: ClassPart): string {
  return base + PART_SUFFIX[part];
}

/** Messages grouped by the file they belong to - every part that has one. */
export function messagesByFile(
  base: string,
  messages: readonly ActivationMessage[]
): Map<string, ActivationMessage[]> {
  const out = new Map<string, ActivationMessage[]>();
  for (const message of messages) {
    const file = partFileName(base, message.part);
    const list = out.get(file) ?? [];
    list.push(message);
    out.set(file, list);
  }
  return out;
}
