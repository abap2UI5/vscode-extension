/*
 * Raw `*.view.xml` / `*.fragment.xml`: the element tags with the namespaces
 * in scope at each, and the write position (tag name, attribute name,
 * attribute value) at an offset.
 *
 * Split out of `context.ts`, which re-exports it - import from there.
 * `vscode`-free.
 */

import { WriteContext, libraryOf, splitName } from "./contextnames";

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/** The `xmlns` declarations written in one tag's attribute text - in either
 *  quote, as XML allows: reading `"` alone left every prefix of a view
 *  written with `xmlns:m='sap.m'` unknown, so its `m:` controls completed and
 *  hovered as nothing and an unprefixed one was taken for sap.m whatever the
 *  default namespace said. */
function nsDeclarations(attrText: string): Record<string, string> {
  const map: Record<string, string> = {};
  const re = /(?:^|\s)xmlns(?::([\w.-]+))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText))) {
    map[m[1] ?? ""] = m[2] ?? m[3];
  }
  return map;
}

/** One element tag of a raw XML document, with the namespaces in scope at
 *  it (its own declarations included). */
export interface ScopedXmlTag {
  /** Offset of the `<`. */
  start: number;
  /** Offset of the `>` ending the tag, or -1 for one still being typed (it
   *  then runs to the next `<` or the end of the text). */
  end: number;
  name: string;
  /** Offset where the attribute text starts (right behind the name). */
  attrsAt: number;
  attrText: string;
  close: boolean;
  selfClose: boolean;
  /** Prefix -> namespace in scope at this element; `""` is the default. */
  ns: Record<string, string>;
}

/**
 * Every element tag of a raw view/fragment XML, in order, each with the
 * namespaces in scope at it - scoped as XML scopes them: a declaration binds
 * the element that carries it and that element's subtree, not its siblings
 * and not the elements above it (the linter resolves its controls the same
 * way since it scoped them per element). Comments, CDATA sections,
 * processing instructions and the doctype are skipped, so an `xmlns` or a
 * `<Tag>` in a comment's prose is neither a declaration nor an element.
 *
 * Read as one document-wide map, an inner `<VBox xmlns="sap.ui.layout.form">`
 * re-resolved every unprefixed tag of the view, a prefix declared in one
 * subtree passed as declared in another, and a commented-out declaration
 * counted.
 */
export function xmlScopedTags(source: string): ScopedXmlTag[] {
  const out: ScopedXmlTag[] = [];
  const stack: Array<Record<string, string>> = [{}];
  let i = 0;
  while ((i = source.indexOf("<", i)) >= 0) {
    const skip = (opener: string, closer: string): boolean => {
      if (!source.startsWith(opener, i)) {
        return false;
      }
      const e = source.indexOf(closer, i + opener.length);
      i = e < 0 ? source.length : e + closer.length;
      return true;
    };
    if (skip("<!--", "-->") || skip("<![CDATA[", "]]>") || skip("<?", "?>") || skip("<!", ">")) {
      continue;
    }
    const close = source[i + 1] === "/";
    const nameAt = i + (close ? 2 : 1);
    const name = /^[\w:.-]+/.exec(source.slice(nameAt, nameAt + 256))?.[0];
    if (!name) {
      i++;
      continue;
    }
    // the `>` that ends the tag - one inside a quoted value ends nothing -
    // or, for a tag still being typed, the next `<` outside a quote
    let end = -1;
    let stop = source.length;
    let quote: string | undefined;
    for (let j = nameAt + name.length; j < source.length; j++) {
      const c = source[j];
      if (quote) {
        if (c === quote) {
          quote = undefined;
        }
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        end = j;
        stop = j;
        break;
      } else if (c === "<") {
        stop = j;
        break;
      }
    }
    const attrsAt = nameAt + name.length;
    const attrText = source.slice(attrsAt, stop);
    if (close) {
      if (stack.length > 1) {
        stack.pop();
      }
      out.push({ start: i, end, name, attrsAt, attrText, close, selfClose: false, ns: stack[stack.length - 1] });
    } else {
      const own = nsDeclarations(attrText);
      const outer = stack[stack.length - 1];
      const ns = Object.keys(own).length ? { ...outer, ...own } : outer;
      const selfClose = end >= 0 && /\/\s*$/.test(attrText);
      out.push({ start: i, end, name, attrsAt, attrText, close, selfClose, ns });
      if (!selfClose) {
        stack.push(ns);
      }
    }
    i = end < 0 ? stop : end + 1;
  }
  return out;
}

/**
 * The namespaces in scope at `offset` of a raw view/fragment XML (see
 * `xmlScopedTags`): inside a tag, that element's own declarations included;
 * between tags, the scope of the innermost element still open there.
 */
export function xmlNsMapAt(source: string, offset: number): Record<string, string> {
  const open: Array<Record<string, string>> = [{}];
  for (const tag of xmlScopedTags(source)) {
    if (tag.start >= offset) {
      break;
    }
    const tagStop = tag.end >= 0 ? tag.end : tag.attrsAt + tag.attrText.length;
    if (offset <= tagStop) {
      return tag.ns; // inside this tag
    }
    if (tag.close) {
      if (open.length > 1) {
        open.pop();
      }
    } else if (!tag.selfClose) {
      open.push(tag.ns);
    }
  }
  return open[open.length - 1];
}

/** The namespaces the document's top-level element declares - the scope
 *  every element without declarations of its own sees (comments skipped). */
export function xmlNsMap(source: string): Record<string, string> {
  return xmlScopedTags(source).find((tag) => !tag.close)?.ns ?? {};
}

// ---------------------------------------------------------------------------
// Raw view / fragment XML
// ---------------------------------------------------------------------------

/**
 * The quote character of an attribute value still open at the end of `attrs`,
 * or undefined when the cursor stands between attributes. Walks rather than
 * counts, so the `"` inside `title='He said "hi"'` belongs to the value it
 * sits in instead of ending it.
 */
function unclosedQuote(attrs: string): '"' | "'" | undefined {
  let open: '"' | "'" | undefined;
  for (const ch of attrs) {
    if (open) {
      if (ch === open) {
        open = undefined;
      }
    } else if (ch === '"' || ch === "'") {
      open = ch;
    }
  }
  return open;
}

/** The `>` actually ending the tag opened at `open` - one inside a quoted
 *  attribute value (`tooltip="a > b"`) ends nothing, and taking it for the
 *  tag end made everything after it in the tag a dead zone. */
function xmlTagEnd(source: string, open: number): number {
  let quote: '"' | "'" | undefined;
  for (let i = open + 1; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) {
        quote = undefined;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

/** The write position at `offset` in a view/fragment XML. */
export function xmlContextAt(
  source: string,
  offset: number
): WriteContext | undefined {
  // The tag the cursor sits in: the last `<` not yet closed by a `>`.
  // Nothing lies before offset 0 - and `lastIndexOf` reads a negative start
  // as 0, which found the document's own first `<` AFTER the cursor: a
  // completion there replaced the root tag's name (`mvc:View`, prefix and
  // all) with whatever control was picked.
  const open = offset > 0 ? source.lastIndexOf("<", offset - 1) : -1;
  if (open < 0) {
    return undefined;
  }
  /* Inside a comment nothing is written: a `<footer>` in the prose of a
   * `<!-- … -->` was taken for a tag, and completion offered controls in
   * the middle of a sentence. The comment's own `<!` is refused below; this
   * is for a `<` it contains. */
  const comment = source.lastIndexOf("<!--", offset - 1);
  if (comment >= 0 && comment < open) {
    const end = source.indexOf("-->", comment + 4);
    if (end < 0 || end + 3 > offset) {
      return undefined;
    }
  }
  const closed = xmlTagEnd(source, open);
  if (closed >= 0 && closed < offset) {
    return undefined; // between tags — nothing to complete
  }
  if (source[open + 1] === "/" || source[open + 1] === "!" || source[open + 1] === "?") {
    return undefined;
  }
  // the namespaces in scope at THIS element - its own declarations included
  const ns = xmlNsMapAt(source, offset);
  const tagEnd = /[\s/>]/.exec(source.slice(open + 1))?.index;
  const nameEnd = open + 1 + (tagEnd ?? offset - open - 1);

  // Inside the tag name itself.
  if (offset <= nameEnd) {
    const written = source.slice(open + 1, offset);
    const prefix = splitName(written).prefix;
    const library = libraryOf(ns, prefix);
    return library
      ? {
          kind: "control",
          library,
          prefix: splitName(written).local,
          start: open + 1 + (prefix ? prefix.length + 1 : 0),
          end: nameEnd,
        }
      : undefined;
  }

  const tagName = source.slice(open + 1, nameEnd);
  const split = splitName(tagName);
  const library = libraryOf(ns, split.prefix);
  if (!library) {
    return undefined;
  }
  const control = `${library}.${split.local}`;

  // Inside an attribute value? XML allows either quote around one, and the
  // extension's own parser accepts both - counting only `"` meant the cursor
  // in `type='Emph'` was read as an attribute NAME position, where completing
  // would have replaced the value with a property name.
  const attrs = source.slice(nameEnd, offset);
  const openQuote = unclosedQuote(attrs);
  if (openQuote) {
    const start = nameEnd + attrs.lastIndexOf(openQuote) + 1;
    const closeQuote = source.indexOf(openQuote, start);
    const member = new RegExp(
      `([\\w:.]+)\\s*=\\s*${openQuote}[^${openQuote}]*$`
    ).exec(attrs)?.[1];
    return member
      ? {
          kind: "value",
          control,
          member,
          prefix: source.slice(start, offset),
          start,
          end: closeQuote < 0 ? offset : closeQuote,
        }
      : undefined;
  }

  // Attribute name position. The span runs on past the cursor to the end of
  // the name: ending it AT the cursor had hover on `te‸xt` ask about `te`,
  // and a completion accepted mid-word keep the old name's tail behind it.
  const word = /([\w:.]*)$/.exec(attrs)?.[1] ?? "";
  const rest = /^[\w:.]*/.exec(source.slice(offset))?.[0] ?? "";
  return {
    kind: "member",
    control,
    prefix: word,
    start: offset - word.length,
    end: offset + rest.length,
  };
}