/*
 * Inline colour swatches for view code.
 *
 * A colour written into a view - `#1873b4` on an `iconColor`, `rgb(…)` on a
 * `backgroundColor` - is just an opaque string in the source. The UI5
 * metadata knows which properties are colour-typed (`sap.ui.core.CSSColor`
 * and friends), so those values get VS Code's colour decorator and picker,
 * the way Tailwind and CSS files have it.
 *
 * `vscode`-free: source text and a member predicate in, colour spans out -
 * covered by the test suite. The provider plumbing lives in language.ts.
 */

import { abapNsMap, DEFAULT_LIBRARY, splitName, xmlNsMap } from "./context";
import { blankComments } from "./abapscan";

/** Channels 0..1, the way VS Code's Color wants them. */
export interface RgbaColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export interface ColorSpan {
  /** Content span of the colour value inside its literal. */
  start: number;
  end: number;
  color: RgbaColor;
}

// ---------------------------------------------------------------------------
// CSS colour parsing
// ---------------------------------------------------------------------------

/** The CSS named colours (level 4), lower-cased hex without `#`. */
const NAMED: Record<string, string> = {
  aliceblue: "f0f8ff", antiquewhite: "faebd7", aqua: "00ffff",
  aquamarine: "7fffd4", azure: "f0ffff", beige: "f5f5dc", bisque: "ffe4c4",
  black: "000000", blanchedalmond: "ffebcd", blue: "0000ff",
  blueviolet: "8a2be2", brown: "a52a2a", burlywood: "deb887",
  cadetblue: "5f9ea0", chartreuse: "7fff00", chocolate: "d2691e",
  coral: "ff7f50", cornflowerblue: "6495ed", cornsilk: "fff8dc",
  crimson: "dc143c", cyan: "00ffff", darkblue: "00008b", darkcyan: "008b8b",
  darkgoldenrod: "b8860b", darkgray: "a9a9a9", darkgreen: "006400",
  darkgrey: "a9a9a9", darkkhaki: "bdb76b", darkmagenta: "8b008b",
  darkolivegreen: "556b2f", darkorange: "ff8c00", darkorchid: "9932cc",
  darkred: "8b0000", darksalmon: "e9967a", darkseagreen: "8fbc8f",
  darkslateblue: "483d8b", darkslategray: "2f4f4f", darkslategrey: "2f4f4f",
  darkturquoise: "00ced1", darkviolet: "9400d3", deeppink: "ff1493",
  deepskyblue: "00bfff", dimgray: "696969", dimgrey: "696969",
  dodgerblue: "1e90ff", firebrick: "b22222", floralwhite: "fffaf0",
  forestgreen: "228b22", fuchsia: "ff00ff", gainsboro: "dcdcdc",
  ghostwhite: "f8f8ff", gold: "ffd700", goldenrod: "daa520", gray: "808080",
  green: "008000", greenyellow: "adff2f", grey: "808080",
  honeydew: "f0fff0", hotpink: "ff69b4", indianred: "cd5c5c",
  indigo: "4b0082", ivory: "fffff0", khaki: "f0e68c", lavender: "e6e6fa",
  lavenderblush: "fff0f5", lawngreen: "7cfc00", lemonchiffon: "fffacd",
  lightblue: "add8e6", lightcoral: "f08080", lightcyan: "e0ffff",
  lightgoldenrodyellow: "fafad2", lightgray: "d3d3d3", lightgreen: "90ee90",
  lightgrey: "d3d3d3", lightpink: "ffb6c1", lightsalmon: "ffa07a",
  lightseagreen: "20b2aa", lightskyblue: "87cefa", lightslategray: "778899",
  lightslategrey: "778899", lightsteelblue: "b0c4de", lightyellow: "ffffe0",
  lime: "00ff00", limegreen: "32cd32", linen: "faf0e6", magenta: "ff00ff",
  maroon: "800000", mediumaquamarine: "66cdaa", mediumblue: "0000cd",
  mediumorchid: "ba55d3", mediumpurple: "9370db", mediumseagreen: "3cb371",
  mediumslateblue: "7b68ee", mediumspringgreen: "00fa9a",
  mediumturquoise: "48d1cc", mediumvioletred: "c71585",
  midnightblue: "191970", mintcream: "f5fffa", mistyrose: "ffe4e1",
  moccasin: "ffe4b5", navajowhite: "ffdead", navy: "000080",
  oldlace: "fdf5e6", olive: "808000", olivedrab: "6b8e23", orange: "ffa500",
  orangered: "ff4500", orchid: "da70d6", palegoldenrod: "eee8aa",
  palegreen: "98fb98", paleturquoise: "afeeee", palevioletred: "db7093",
  papayawhip: "ffefd5", peachpuff: "ffdab9", peru: "cd853f", pink: "ffc0cb",
  plum: "dda0dd", powderblue: "b0e0e6", purple: "800080",
  rebeccapurple: "663399", red: "ff0000", rosybrown: "bc8f8f",
  royalblue: "4169e1", saddlebrown: "8b4513", salmon: "fa8072",
  sandybrown: "f4a460", seagreen: "2e8b57", seashell: "fff5ee",
  sienna: "a0522d", silver: "c0c0c0", skyblue: "87ceeb",
  slateblue: "6a5acd", slategray: "708090", slategrey: "708090",
  snow: "fffafa", springgreen: "00ff7f", steelblue: "4682b4", tan: "d2b48c",
  teal: "008080", thistle: "d8bfd8", tomato: "ff6347", turquoise: "40e0d0",
  violet: "ee82ee", wheat: "f5deb3", white: "ffffff", whitesmoke: "f5f5f5",
  yellow: "ffff00", yellowgreen: "9acd32",
};

function fromHex(hex: string): RgbaColor | undefined {
  const h = hex.toLowerCase();
  if (!/^[0-9a-f]+$/.test(h)) {
    return undefined;
  }
  const pair = (s: string) => parseInt(s, 16) / 255;
  const nibble = (s: string) => parseInt(s + s, 16) / 255;
  if (h.length === 3 || h.length === 4) {
    return {
      red: nibble(h[0]),
      green: nibble(h[1]),
      blue: nibble(h[2]),
      alpha: h.length === 4 ? nibble(h[3]) : 1,
    };
  }
  if (h.length === 6 || h.length === 8) {
    return {
      red: pair(h.slice(0, 2)),
      green: pair(h.slice(2, 4)),
      blue: pair(h.slice(4, 6)),
      alpha: h.length === 8 ? pair(h.slice(6, 8)) : 1,
    };
  }
  return undefined;
}

function hslChannel(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** One CSS colour value, or undefined when the text is not a colour. */
/* CSS CLAMPS an out-of-range channel, it does not reject it: `rgb(300,0,0)`
 * is red and `hsl(0,300%,50%)` is red too. Carrying the raw number through
 * breaks both ends - VS Code's Color wants 0..1 for the swatch, and an alpha
 * outside it comes back out of formatCssColor as `rgba(0,0,0,-1)`, which is
 * not a colour at all and would be written into the user's source the moment
 * they touch the picker. */
const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export function parseCssColor(value: string): RgbaColor | undefined {
  const c = parseCssColorUnclamped(value);
  return c && {
    red: clamp01(c.red),
    green: clamp01(c.green),
    blue: clamp01(c.blue),
    alpha: clamp01(c.alpha),
  };
}

function parseCssColorUnclamped(value: string): RgbaColor | undefined {
  const v = value.trim();
  if (v.startsWith("#")) {
    return fromHex(v.slice(1));
  }
  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/i.exec(v);
  if (fn) {
    const parts = fn[2].split(/[\s,\/]+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) {
      return undefined;
    }
    const nums = parts.map((p) => parseFloat(p));
    if (nums.some((n) => isNaN(n))) {
      return undefined;
    }
    const alpha =
      parts.length === 4
        ? parts[3].endsWith("%")
          ? nums[3] / 100
          : nums[3]
        : 1;
    if (fn[1].toLowerCase().startsWith("rgb")) {
      const chan = (ix: number) =>
        (parts[ix].endsWith("%") ? (nums[ix] / 100) * 255 : nums[ix]) / 255;
      return { red: chan(0), green: chan(1), blue: chan(2), alpha };
    }
    const h = ((nums[0] % 360) + 360) % 360 / 360;
    const s = nums[1] / 100;
    const l = nums[2] / 100;
    if (s === 0) {
      return { red: l, green: l, blue: l, alpha };
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
      red: hslChannel(p, q, h + 1 / 3),
      green: hslChannel(p, q, h),
      blue: hslChannel(p, q, h - 1 / 3),
      alpha,
    };
  }
  const named = NAMED[v.toLowerCase()];
  return named ? fromHex(named) : undefined;
}

const to255 = (c: number) => Math.round(clamp01(c) * 255);
const hexByte = (c: number) => to255(c).toString(16).padStart(2, "0");

/** The colour written back when the picker chooses one: hex while opaque,
 *  rgba() once an alpha rides along. */
export function formatCssColor(color: RgbaColor): string {
  if (color.alpha >= 1) {
    return `#${hexByte(color.red)}${hexByte(color.green)}${hexByte(color.blue)}`;
  }
  // alpha is clamped like the other three - it is written verbatim into the
  // source, so a negative one would emit `rgba(…,-1)`
  return `rgba(${to255(color.red)},${to255(color.green)},${to255(color.blue)},${Number(clamp01(color.alpha).toFixed(2))})`;
}

/**
 * The spellings the colour picker offers, `formatCssColor`'s first - that is
 * what accepting writes. The second is the same colour in the other notation
 * (`rgb( )` while opaque, `#rrggbbaa` with an alpha), which is what makes the
 * picker's format label cycle the way it does in a CSS file.
 */
export function cssColorPresentations(color: RgbaColor): string[] {
  const alternate =
    color.alpha >= 1
      ? `rgb(${to255(color.red)},${to255(color.green)},${to255(color.blue)})`
      : `#${hexByte(color.red)}${hexByte(color.green)}${hexByte(color.blue)}${hexByte(color.alpha)}`;
  return [formatCssColor(color), alternate];
}

// ---------------------------------------------------------------------------
// Finding the colour values in a source
// ---------------------------------------------------------------------------

/** Whether a member of a control takes a colour - answered by the metadata
 *  (this module deliberately does not know it). */
export type IsColorMember = (control: string, member: string) => boolean;

const ABAP_CONTROL_RE =
  /->\s*(?:ele|tag)\s*\(\s*(?:n\s*=\s*)?([`'"])([\w:.]+)\1(?:\s*ns\s*=\s*([`'"])([\w.]+)\3)?/g;
const ABAP_ATTR_RE =
  /->\s*a\s*\(\s*n\s*=\s*([`'"])([\w:.]+)\1\s*v\s*=\s*([`'"])([^`'"]*)\3/g;

/** Colour values in an ABAP builder source. Regex-scanned on purpose - a
 *  full parse per keystroke would cost too much - but over blanked comments:
 *  a commented-out `->tag( )` between a control and its `a( )` used to become
 *  the owner, and the real attribute was judged against the wrong control. */
export function abapColorSpans(
  source: string,
  isColorMember: IsColorMember
): ColorSpan[] {
  const ns = abapNsMap(source);
  const code = blankComments(source);
  const controls: Array<{ at: number; control: string }> = [];
  for (const m of code.matchAll(ABAP_CONTROL_RE)) {
    const { prefix, local } = splitName(m[2]);
    const library =
      ns[prefix || m[4] || ""] ?? (prefix || m[4] ? undefined : DEFAULT_LIBRARY);
    if (library) {
      controls.push({ at: m.index, control: `${library}.${local}` });
    }
  }
  const out: ColorSpan[] = [];
  // Both lists come out in ascending offset order, so one index walks along
  // the controls as the attributes advance. Copying and reversing the whole
  // control list per attribute made this quadratic on exactly the long
  // generated views it runs over, on every document change.
  let ownerIndex = -1;
  for (const m of code.matchAll(ABAP_ATTR_RE)) {
    while (
      ownerIndex + 1 < controls.length &&
      controls[ownerIndex + 1].at < m.index
    ) {
      ownerIndex++;
    }
    const owner = ownerIndex >= 0 ? controls[ownerIndex] : undefined;
    if (!owner || !isColorMember(owner.control, m[2])) {
      continue;
    }
    const value = m[4];
    const color = parseCssColor(value);
    if (!color) {
      continue;
    }
    const start = m.index + m[0].length - 1 - value.length;
    out.push({ start, end: start + value.length, color });
  }
  return out;
}

const XML_TAG_RE = /<([\w:.]+)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g;
const XML_ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

/** Colour values in a raw view/fragment XML. */
export function xmlColorSpans(
  source: string,
  isColorMember: IsColorMember
): ColorSpan[] {
  const ns = xmlNsMap(source);
  const out: ColorSpan[] = [];
  for (const tag of source.matchAll(XML_TAG_RE)) {
    const { prefix, local } = splitName(tag[1]);
    const library = ns[prefix] ?? (prefix ? undefined : DEFAULT_LIBRARY);
    if (!library) {
      continue;
    }
    const control = `${library}.${local}`;
    const attrsAt = tag.index + 1 + tag[1].length;
    for (const attr of tag[2].matchAll(XML_ATTR_RE)) {
      if (!isColorMember(control, attr[1])) {
        continue;
      }
      const color = parseCssColor(attr[2]);
      if (!color) {
        continue;
      }
      const start = attrsAt + attr.index + attr[0].length - 1 - attr[2].length;
      out.push({ start, end: start + attr[2].length, color });
    }
  }
  return out;
}
