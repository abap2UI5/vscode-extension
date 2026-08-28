/*
 * Launch-URL helpers — pure, `vscode`-free, and therefore covered by the test
 * suite. The launch URL is the one thing that ties the extension to a system,
 * so the handful of string operations around it are worth pinning down.
 */

import { URL } from "url";

/** Collapses duplicate slashes in the path but leaves `://` in the protocol
 *  intact — a template ending in `/` next to a path starting with `/`. */
export function normalizeUrl(url: string): string {
  return url.replace(/(?<!:)\/{2,}/g, "/");
}

/** `https://host:44300/sap/bc/z2ui5?app_start=X` -> `host:44300/sap/bc/z2ui5` */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host + parsed.pathname;
  } catch {
    return url;
  }
}

/** The launch URL of one app: `{class}` replaced, slashes collapsed. */
export function expandTemplate(template: string, className: string): string {
  return normalizeUrl(
    template.replace(/\{class\}/gi, encodeURIComponent(className.toUpperCase()))
  );
}

/**
 * Adds or replaces query parameters — how the preview switches the UI5 theme
 * and the logon language without touching the configured template. An empty
 * value removes the parameter again, so "back to the system default" is not a
 * special case.
 */
export function withParams(
  url: string,
  params: Record<string, string | undefined>
): string {
  try {
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(params)) {
      if (value) {
        parsed.searchParams.set(key, value);
      } else {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * The launch URL rebased onto the running proxy: same path, query and hash,
 * loaded through `http://127.0.0.1:<port>/__abap2ui5/<token>` instead of the
 * system's origin.
 *
 * Rebuilt from the parsed parts rather than by replacing the origin substring,
 * for two reasons a plain `replace(origin, proxyOrigin)` got wrong:
 *
 * - `URL.origin` is normalised (lowercased host, default port dropped), so a
 *   launch URL written as `https://MyHost:443/...` never contained its own
 *   origin verbatim - the replace was a no-op and the iframe loaded the system
 *   DIRECTLY, where without the injected credentials it has nothing to show.
 * - a launch URL without a path (`https://host?app_start=X`) put the query
 *   right behind the token, making the token the LAST PATH SEGMENT - which the
 *   browser drops when resolving every relative url on the page
 *   (`resources/sap-ui-core.js` against `.../__abap2ui5/<token>?...` is
 *   `.../__abap2ui5/resources/sap-ui-core.js`, token gone). `pathname` is
 *   never empty, so the token always ends up followed by `/` and survives as
 *   a directory.
 */
export function proxiedUrl(
  externalUrl: string,
  proxyOrigin: string
): string | undefined {
  try {
    const parsed = new URL(externalUrl);
    return proxyOrigin + parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return undefined;
  }
}

/** The `sap-client` of a launch URL, needed for the ADT lookups. */
export function sapClientOf(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("sap-client") ?? undefined;
  } catch {
    return undefined;
  }
}

/** Origin of a launch URL, or undefined when it is not a URL at all. */
export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** True when the template can actually launch something. */
export function isUsableTemplate(template: string): boolean {
  const trimmed = template.trim();
  if (!trimmed || !/\{class\}/i.test(trimmed)) {
    return false;
  }
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** The port a URL actually talks to, default ports spelled out - `URL.port`
 *  is empty for 80/443, which makes two spellings of one authority compare
 *  unequal. */
function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

/**
 * A `Location` header from the system, rebased onto the proxy when it points
 * back at the system - and left exactly as it is when it does not.
 *
 * This is `proxiedUrl`'s problem a second time, and it had the same wrong
 * answer: `location.replace(target.origin, proxyOrigin)`. `URL.origin` is
 * NORMALISED - lowercased host, default port dropped - so a system answering
 * `Location: https://MyHost:44300/sap/bc/...` (or dropping `:443` where the
 * configured origin kept it) does not contain the origin verbatim, the
 * replace silently does nothing, and the browser follows the redirect to the
 * system DIRECTLY. There it has no injected credentials, so it gets a 401 and
 * the preview stays white - the exact symptom the connection check exists to
 * explain.
 *
 * Compared by host and port rather than by whole origin on purpose: a system
 * that redirects http -> https on the same authority still has to be followed
 * through the proxy, which is the only route that carries the credentials.
 *
 * A relative `Location` (`/sap/bc/...`, `../x`) is already resolved against
 * the proxy's own origin by the browser, so it is returned untouched.
 */
export function rebasedLocation(
  location: string,
  target: URL,
  proxyOrigin: string
): string {
  let parsed: URL;
  try {
    // a relative Location has no origin of its own; resolving it against the
    // target is how we find out whether it would leave the system
    parsed = new URL(location, target);
  } catch {
    return location;
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(location) && !location.startsWith("//")) {
    return location; // relative: the browser resolves it against the proxy
  }
  if (
    parsed.hostname !== target.hostname ||
    effectivePort(parsed) !== effectivePort(target)
  ) {
    return location; // somewhere else entirely - not ours to rewrite
  }
  return proxyOrigin + parsed.pathname + parsed.search + parsed.hash;
}
