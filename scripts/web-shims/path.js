// Web-build shim: `path` for the browser extension host.
//
// This started as "enough for the module-load-time constants" (the linter
// computes its default snapshot path on import) - three string helpers. That
// stopped being enough the moment the linter's `applyRules` began deriving
// the absolute and cwd-relative spellings of a file name to match `exclude`
// patterns against: it calls `path.resolve` and `path.relative` on EVERY
// check, so the missing exports turned every web check into a swallowed
// `TypeError` and the whole view check went silent on vscode.dev.
//
// So this is now a real POSIX `path`, pure string work, no cwd of its own -
// `CWD` below is the virtual root every relative path resolves against.
// `src/test/webshim.test.ts` holds it to node's own `path.posix`, and to the
// set of members the bundled linter actually calls.

/** The browser host has no working directory; this is the one it pretends to
 *  have. Only relative-vs-absolute spelling depends on it. */
const CWD = "/";

/** Collapses `.` and `..` segments. Above an absolute root, `..` is dropped -
 *  as node does. */
const normalizeSegments = (segments, absolute) => {
  const out = [];
  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!absolute) {
        out.push("..");
      }
      continue;
    }
    out.push(segment);
  }
  return out;
};

const isAbsolute = (p) => String(p).startsWith("/");

const resolve = (...parts) => {
  let joined = "";
  let absolute = false;
  for (let i = parts.length - 1; i >= 0 && !absolute; i--) {
    const part = parts[i];
    if (!part) {
      continue;
    }
    joined = joined ? `${part}/${joined}` : String(part);
    absolute = isAbsolute(part);
  }
  if (!absolute) {
    joined = joined ? `${CWD}/${joined}` : CWD;
  }
  return `/${normalizeSegments(joined.split("/"), true).join("/")}`;
};

const relative = (from, to) => {
  const a = resolve(from).split("/").filter(Boolean);
  const b = resolve(to).split("/").filter(Boolean);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) {
    shared++;
  }
  const up = new Array(a.length - shared).fill("..");
  return [...up, ...b.slice(shared)].join("/");
};

const normalize = (p) => {
  const raw = String(p);
  if (!raw) {
    return ".";
  }
  const absolute = isAbsolute(raw);
  const segments = normalizeSegments(raw.split("/"), absolute);
  const trailing = raw.endsWith("/") && segments.length > 0 ? "/" : "";
  if (segments.length === 0) {
    return absolute ? "/" : ".";
  }
  return (absolute ? "/" : "") + segments.join("/") + trailing;
};

const join = (...parts) => {
  const joined = parts.filter(Boolean).join("/");
  return joined ? normalize(joined) : ".";
};

const dirname = (p) => {
  const raw = String(p).replace(/\/+$/, "");
  if (!raw) {
    // "/" (or "///") - the root is its own parent, as in node
    return isAbsolute(p) ? "/" : ".";
  }
  const cut = raw.lastIndexOf("/");
  if (cut < 0) {
    return ".";
  }
  return cut === 0 ? "/" : raw.slice(0, cut);
};

const basename = (p, ext) => {
  const name = String(p).replace(/\/+$/, "").replace(/^.*\//, "");
  return ext && name !== ext && name.endsWith(ext)
    ? name.slice(0, -ext.length)
    : name;
};

const extname = (p) => {
  const name = basename(p);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
};

const posix = {
  join,
  resolve,
  relative,
  normalize,
  dirname,
  basename,
  extname,
  isAbsolute,
  sep: "/",
  delimiter: ":",
};

module.exports = { ...posix, posix, win32: posix, default: posix };
