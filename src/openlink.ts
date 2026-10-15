/*
 * The extension's URI handler, the half that decides - `vscode`-free, so the
 * test suite covers it. Another tool hands a class over with a link
 *
 *   vscode://abap2ui5.abap2ui5/open?code=<base64url of the deflated source>&name=zcl_my_app.clas.abap
 *   vscode://abap2ui5.abap2ui5/open?src=https://raw.githubusercontent.com/<owner>/<repo>/<ref>/src/zcl_my_app.clas.abap
 *
 * (the abap2UI5 layout editor's "Open in VS Code" writes the first). The
 * class opens as an unsaved `.clas.abap` document; nothing runs until the
 * user says so. `code` is deflate-raw, the playground's share-link
 * compression, so a class of a few hundred lines fits in a link.
 *
 * Any web page can open a vscode:// link, so the link is read as untrusted
 * input: the file name is a class file name and nothing else, `src` is
 * https on GitHub's raw hosts only (a github.com file page is translated
 * to its raw URL), never a URL with credentials in it, and the source
 * inflates or downloads to at most MAX_SOURCE bytes.
 */

import { URL } from "url";

export const OPEN_PATH = "/open";

/** More ABAP than any one class link should carry - the playground's cap. */
export const MAX_SOURCE = 8 * 1024 * 1024;

export const SOURCE_HOSTS = ["raw.githubusercontent.com", "gist.githubusercontent.com"];

/** What a link asks for: a class to open from the link itself or from a URL. */
export type OpenRequest =
  | { kind: "inline"; name: string; code: string }
  | { kind: "url"; name: string; url: string }
  | { kind: "error"; message: string };

/** `zcl_my_app.clas.abap`, `#ns#cl_app.clas.abap` - a class file, no path. */
const CLASS_FILE = /^[A-Za-z0-9_#]{1,40}\.clas\.abap$/;

/** Reads a link the handler was given (the whole URI as a string). */
export function parseOpenUri(uri: string): OpenRequest {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { kind: "error", message: "The link is not a URI." };
  }
  if (parsed.pathname.replace(/\/+$/, "").toLowerCase() !== OPEN_PATH) {
    return {
      kind: "error",
      message: `The link asks for ${parsed.pathname || "nothing"} - the extension opens classes with ${OPEN_PATH}.`,
    };
  }
  const params = parsed.searchParams;
  const code = params.get("code");
  const src = params.get("src");
  if (code && src) {
    return { kind: "error", message: "The link carries both a class (code=) and a URL (src=) - one of them." };
  }
  if (!code && !src) {
    return { kind: "error", message: "The link carries no class: neither code= nor src=." };
  }
  if (code) {
    if (!/^[A-Za-z0-9_-]+$/.test(code)) {
      return { kind: "error", message: "The class in the link (code=) is not base64url." };
    }
    const name = params.get("name") ?? "";
    if (!CLASS_FILE.test(name)) {
      return { kind: "error", message: `${name || "The file name (name=)"} is not the file name of a class, like zcl_my_app.clas.abap.` };
    }
    return { kind: "inline", name: name.toLowerCase(), code };
  }
  const url = sourceUrl(src as string);
  if (typeof url !== "string") {
    return url;
  }
  const name = params.get("name") ?? decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  if (!CLASS_FILE.test(name)) {
    return { kind: "error", message: `${name || "The URL"} does not name a class file, like zcl_my_app.clas.abap.` };
  }
  return { kind: "url", name: name.toLowerCase(), url };
}

/** The URL a class may be downloaded from, or why not. */
export function sourceUrl(raw: string): string | { kind: "error"; message: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "error", message: `${raw} is not a URL.` };
  }
  if (url.username || url.password) {
    return { kind: "error", message: "A link to a class carries no user name or password." };
  }
  if (url.hostname === "github.com") {
    const page = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(url.pathname);
    if (page) {
      url = new URL(`https://raw.githubusercontent.com/${page[1]}/${page[2]}/${page[3]}`);
    }
  }
  if (url.protocol !== "https:" || !SOURCE_HOSTS.includes(url.hostname)) {
    return {
      kind: "error",
      message: `Classes are opened from ${SOURCE_HOSTS.join(" or ")} over https - not from ${url.host || url.protocol}.`,
    };
  }
  return url.href;
}

/** The source a `code=` parameter carries: base64url, deflate-raw, UTF-8. */
export async function inflateCode(code: string, limit = MAX_SOURCE): Promise<string> {
  const bytes = Buffer.from(code.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  } catch {
    throw new Error("The class in the link could not be unpacked.");
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error("The link unpacks to more code than a class link carries.");
      }
      parts.push(value);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("The link unpacks")) {
      throw err;
    }
    throw new Error("The class in the link could not be unpacked.");
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(parts));
}
