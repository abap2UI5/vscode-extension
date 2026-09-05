import { xmlToAbap, XmlElement } from "./xmltoabap";

/*
 * abbreviation - Emmet for builder chains.
 *
 * `Page>content>Button*3` becomes the chain that builds it. Emmet is the one
 * feature HTML authors never give back, and a builder chain is the case where
 * it pays even better: the nesting is written as `ele( )` calls whose
 * indentation IS the tree, and every level has to be balanced by hand.
 *
 * The grammar is Emmet's, cut down to what a view needs:
 *
 *   >          child            Page>content
 *   +          sibling          Button+Input
 *   *n         repeat           Button*3
 *   #id        the id attribute Button#GO
 *   [a=b c=d]  attributes       Button[text=Go type=Emphasized]
 *   {text}     the text one     Button{Go}
 *   (…)*n      group            Page>(Label+Input)*3
 *   $          repeat counter   Button#btn$*3 - $$ pads to two digits, and
 *                               `${…}` stays an expression binding
 *
 * The chain itself is emitted by `xmltoabap.ts`, which already writes the
 * house layout - one call per line, four spaces per level, the closing call
 * in its element's column. Re-implementing that here would be a second
 * opinion about the thing this project has exactly one opinion about.
 */

export interface Abbreviation {
  roots: XmlElement[];
  error?: string;
}

interface Token {
  name: string;
  attrs: Array<[string, string]>;
  repeat: number;
}

/**
 * The `[a=b c="two words"]` block.
 *
 * Quotes are what separates a value from the next attribute, and a view needs
 * them more than HTML does: an expression binding is full of spaces, braces
 * and `+`, and unquoted it would be read as four attributes with no values.
 */
function parseAttributes(block: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /([\w:.-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g;
  for (const match of block.matchAll(re)) {
    out.push([match[1], match[2] ?? match[3] ?? match[4] ?? ""]);
  }
  return out;
}

/** `Button#GO[text=Go type=Emphasized]{Press me}*2` -> its parts. `$` is
 *  legal in a name or id - it is the repeat counter. */
function parseToken(text: string): Token | undefined {
  const match = /^([\w:.$-]+)/.exec(text);
  if (!match) {
    return undefined;
  }
  const token: Token = { name: match[1], attrs: [], repeat: 1 };
  let rest = text.slice(match[1].length);
  for (;;) {
    const id = /^#([\w$-]+)/.exec(rest);
    if (id) {
      token.attrs.push(["id", id[1]]);
      rest = rest.slice(id[0].length);
      continue;
    }
    const attrs = /^\[([^\]]*)\]/.exec(rest);
    if (attrs) {
      token.attrs.push(...parseAttributes(attrs[1]));
      rest = rest.slice(attrs[0].length);
      continue;
    }
    const text_ = /^\{([^}]*)\}/.exec(rest);
    if (text_) {
      token.attrs.push(["text", text_[1]]);
      rest = rest.slice(text_[0].length);
      continue;
    }
    const repeat = /^\*(\d+)/.exec(rest);
    if (repeat) {
      token.repeat = Math.min(Number(repeat[1]), 50); // a typo is not a reason to write 4000 lines
      rest = rest.slice(repeat[0].length);
      continue;
    }
    break;
  }
  return rest ? undefined : token;
}

/** The abbreviation as (separator, token) pairs. `>` and `+` inside `[]`,
 *  `{}` or a `(…)` group belong to a value or to the group -
 *  `Button[text=a+b]` and `(Label+Input)*2` are one token each. */
function tokenize(text: string): Array<{ op: ">" | "+" | ""; text: string }> {
  const out: Array<{ op: ">" | "+" | ""; text: string }> = [];
  let depth = 0;
  let start = 0;
  let op: ">" | "+" | "" = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[" || ch === "{" || ch === "(") {
      depth++;
    } else if (ch === "]" || ch === "}" || ch === ")") {
      depth--;
    } else if ((ch === ">" || ch === "+") && depth === 0) {
      out.push({ op, text: text.slice(start, i) });
      op = ch;
      start = i + 1;
    }
  }
  out.push({ op, text: text.slice(start) });
  return out;
}

/** `$` runs replaced by the 1-based repeat counter, `$$` zero-padded - and
 *  `${…}` left alone, that is an expression binding, not a counter. */
function numbered(text: string, n: number | undefined): string {
  if (n === undefined) {
    return text;
  }
  return text.replace(/\$+(?!\{)/g, (run) =>
    String(n).padStart(run.length, "0")
  );
}

function element(token: Token, n?: number): XmlElement {
  return {
    name: numbered(token.name, n),
    attrs: token.attrs.map(
      ([name, value]) => [name, numbered(value, n)] as [string, string]
    ),
    children: [],
  };
}

/** A deep copy with the group's repeat counter applied throughout. */
function cloneNumbered(el: XmlElement, n: number | undefined): XmlElement {
  return {
    name: numbered(el.name, n),
    attrs: el.attrs.map(
      ([name, value]) => [name, numbered(value, n)] as [string, string]
    ),
    children: el.children.map((child) => cloneNumbered(child, n)),
  };
}

/** A `(…)` group with an optional repeat suffix. */
const GROUP_RE = /^\((.*)\)(?:\*(\d+))?$/s;

/**
 * The element tree an abbreviation describes.
 *
 * Left to right with a parent context, because that is what Emmet's
 * precedence actually is: `>` binds tighter than `+`, so `Page>content>Button+Input`
 * puts BOTH controls in the content aggregation. Splitting on `+` first - the
 * obvious implementation - makes the Input a sibling of the Page, which reads
 * the same and builds a different view.
 */
export function parseAbbreviation(text: string): Abbreviation {
  const trimmed = text.trim();
  if (!trimmed) {
    return { roots: [], error: "nothing to expand" };
  }
  return parseSequence(trimmed);
}

function parseSequence(text: string): Abbreviation {
  const roots: XmlElement[] = [];
  /** Where the next elements attach - null while at the top level. */
  let attach: XmlElement[] | null = null;
  /** What the previous token created, which is what a `>` descends into. */
  let last: XmlElement[] = [];
  for (const [index, { op, text: piece }] of tokenize(text).entries()) {
    const part = piece.trim();
    if (!part) {
      // `>Button`, `Page>`, `Page>>` - a separator with nothing on one side
      return {
        roots: [],
        error:
          index === 0
            ? "a `>` needs an element in front of it"
            : "a separator needs an element on both sides",
      };
    }
    if (op === ">") {
      if (!last.length) {
        return { roots: [], error: "a `>` needs an element in front of it" };
      }
      attach = last;
    }
    const created: XmlElement[] = [];
    const grow = (make: (n: number | undefined) => XmlElement[], repeat: number) => {
      /* A repeated parent gets its own copy of what follows, the way Emmet
       * does it: `Column*2>Text` is two columns each holding a text, not two
       * columns sharing one. The counter only counts when there IS a repeat,
       * so a lone `$` in a binding stays what was written. */
      for (const parent of attach ?? [null]) {
        for (let i = 0; i < repeat; i++) {
          for (const made of make(repeat > 1 ? i + 1 : undefined)) {
            (parent === null ? roots : parent.children).push(made);
            created.push(made);
          }
        }
      }
    };

    const group = GROUP_RE.exec(part);
    if (group) {
      const inner = parseSequence(group[1].trim());
      if (inner.error) {
        return inner;
      }
      if (!inner.roots.length) {
        return { roots: [], error: "an empty group expands to nothing" };
      }
      const repeat = Math.min(group[2] ? Number(group[2]) : 1, 50);
      grow((n) => inner.roots.map((root) => cloneNumbered(root, n)), repeat);
    } else {
      const token = parseToken(part);
      if (!token) {
        return { roots: [], error: `not an abbreviation: "${part}"` };
      }
      grow((n) => [element(token, n)], token.repeat);
    }
    last = created;
  }
  return { roots };
}

/** An attribute value on its way into XML. `&` FIRST - without it the
 *  emitter's entity decoding read `Button{5 &gt; 3}` as `5 > 3`, silently
 *  altering what the user typed. */
function escapeXmlValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

/** The XML an element tree stands for - the emitter's input. */
function toXml(nodes: readonly XmlElement[]): string {
  return nodes
    .map((node) => {
      const attrs = node.attrs
        .map(([name, value]) => ` ${name}="${escapeXmlValue(value)}"`)
        .join("");
      return node.children.length
        ? `<${node.name}${attrs}>${toXml(node.children)}</${node.name}>`
        : `<${node.name}${attrs}/>`;
    })
    .join("");
}

export interface Expansion {
  abap: string;
  error?: string;
}

/**
 * The chain an abbreviation expands to.
 *
 * `continuation` is the difference between scaffolding a view and adding to
 * one: inside an existing chain the first call has to hang off the previous
 * one (`)->ele(`) and the statement neither starts with a factory nor ends
 * with `view_display( )`. Getting that wrong produces something that looks
 * right and does not compile, which is the whole reason it is decided here
 * rather than left to the caller.
 */
export function expandAbbreviation(
  text: string,
  indent: string,
  continuation: boolean
): Expansion {
  const parsed = parseAbbreviation(text);
  if (parsed.error || !parsed.roots.length) {
    return { abap: "", error: parsed.error ?? "nothing to expand" };
  }
  if (parsed.roots.length > 1 && !continuation) {
    return {
      abap: "",
      error: "a view has one root - write `Page>…`, or expand inside a chain",
    };
  }
  /* Several roots are siblings, and the emitter converts one root. Inside a
   * chain they are wrapped in a throwaway element and its line is removed
   * again afterwards - which is not a trick but the only way to get the
   * emitter's own `end( )` placement between siblings, the part that is
   * genuinely easy to get wrong. */
  const wrapped = continuation && parsed.roots.length > 1;
  const xml = wrapped
    ? `<siblings>${toXml(parsed.roots)}</siblings>`
    : toXml(parsed.roots);
  /* A statement of its own may leave the trailing `end( )`s off - stringify
   * closes what is still open. An expansion INSIDE a chain may not: the
   * caller's next line was written for the container the cursor is in, and
   * with `Panel>content>Button` emitted as three unclosed calls it became a
   * child of `content`. */
  const { abap } = xmlToAbap(xml, indent, { keepTrailingEnds: continuation });
  if (!continuation) {
    return { abap };
  }
  /* The emitter writes a whole statement: a factory line, the chain, and the
   * display call. Inside a chain only the middle is wanted, and its first
   * call has to continue the previous one. */
  const lines = abap.split("\n");
  const body = lines.slice(1, -2);
  while (body.length && !body[0].trim()) {
    body.shift();
  }
  if (wrapped) {
    body.shift(); // the throwaway root
    // and the `)->end( ).` that closes it: the siblings belong to the
    // container the cursor is in, which nothing here closes
    body.pop();
    while (body.length && !body[body.length - 1].trim()) {
      body.pop();
    }
    for (const [index, line] of body.entries()) {
      body[index] = line.startsWith(`${indent}    `)
        ? indent + line.slice(indent.length + 4)
        : line;
    }
  }
  if (!body.length) {
    return { abap: "", error: "nothing to expand" };
  }
  body[0] = body[0].replace(/^(\s*)view->/, `$1)->`);
  // the statement continues below the insertion, so the emitter's closing
  // `).` has to go back to being an open call - the leading `)` of the
  // caller's next line closes it
  const last = body.length - 1;
  body[last] = body[last].replace(/\s*\)\.$/, "");
  return { abap: body.join("\n") };
}
