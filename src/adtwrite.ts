import {
  ActivationOutcome,
  CLASS_PARTS,
  ClassPart,
  parseActivationResponse,
} from "./adtmessages";

/**
 * Push a class's source to a system and activate it over ADT -
 * `vscode`-free (T07a).
 *
 * Every request goes through an injected function of the shape
 * `agentapps.ts`'s `SystemRequest` has (method, url, headers, body ->
 * status, headers, body). In the extension that function sends to the auth
 * proxy's own loopback origin, so the credentials, the certificate pins and
 * the logon strategy are the proxy's and this module never sees any of them.
 *
 * The request shapes follow the open-source ADT client abap-adt-api (read,
 * not run, not copied); each step names the file it was checked against:
 *
 *   1. `GET /sap/bc/adt/oo/classes/<name>` with `x-csrf-token: fetch` - the
 *      token arrives in the answer's `x-csrf-token` header (`src/AdtHTTP.ts`:
 *      `FETCH_CSRF_TOKEN`, `CSRF_TOKEN_HEADER`, `_handleResponse`). Every
 *      request carries `X-sap-adt-sessiontype` (`SESSION_HEADER`):
 *      `stateless` for the reads and the activation, `stateful` from the
 *      lock to the unlock - that library logs on stateless too and switches
 *      to stateful before it locks (`src/test/disruptive.test.ts`). A 404
 *      means the class does not exist: refused before anything is locked
 *      (creating a class needs a package and a transport decision).
 *   2. `GET .../source/main` and `GET .../includes/<part>` - the server's
 *      source, so only what differs is written (`src/api/objectcontents.ts`
 *      `getObjectSource`; the include names are `classIncludes` in
 *      `src/api/objectstructure.ts`).
 *   3. `POST <class>?_action=LOCK&accessMode=MODIFY` with the lock-result
 *      `Accept`; the answer is `asx:abap/asx:values/DATA` with `LOCK_HANDLE`,
 *      `CORRNR`, `IS_LOCAL`, ... (`objectcontents.ts` `lock`, `AdtLock`).
 *   4. A local test include the server lacks is created first:
 *      `POST <class>/includes` with an `abapClassInclude` body of
 *      `includeType="testclasses"` (`src/api/objectcreator.ts`
 *      `createTestInclude`).
 *   5. `PUT .../source/main` / `.../includes/<part>?lockHandle=...`
 *      (`&corrNr=...` when a transport request is needed), content type
 *      `text/plain; charset=utf-8` (`objectcontents.ts` `setObjectSource`).
 *   6. `POST <class>?_action=UNLOCK&lockHandle=...` (`objectcontents.ts`
 *      `unLock`) - in a `finally`, so it is sent after any failure once the
 *      lock is held; then the stateful session is ended with a stateless
 *      `GET /sap/bc/adt/compatibility/graph` (`AdtHTTP.ts` `dropSession`).
 *   7. `POST /sap/bc/adt/activation?method=activate&preauditRequested=true`
 *      with an `adtcore:objectReferences` body (`src/api/activate.ts`
 *      `activate`) - after the unlock, in the order that library's own write
 *      test uses (`src/test/disruptive.test.ts` `writeobject`). Its answer is
 *      read by `adtmessages.ts`.
 *
 * A transport request is never invented: the lock's own `CORRNR` is used
 * when the system already has the object in one, otherwise the user is
 * asked (`askTransport`) when the lock says the object is not local or a
 * write is refused for want of one. Nothing here was run against a real
 * system - the tests replay fixtures shaped after the library above.
 */

/** One answer of the system. Lower-case header names, as node delivers them. */
export interface AdtResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One request - the same shape as `agentapps.ts`'s `SystemRequest`. */
export type AdtRequest = (
  url: string,
  init: { method: "GET" | "POST" | "PUT"; headers: Record<string, string>; body?: string }
) => Promise<AdtResponse>;

export interface AdtWriteDeps {
  request: AdtRequest;
  /** The proxy's loopback base url (token included); paths are appended. */
  base: string;
  /** Asked when the system wants a transport request; undefined cancels. */
  askTransport(question: { className: string; reason: string }): Promise<string | undefined>;
  log?(message: string): void;
}

export interface PushRequest {
  className: string;
  /** The local source of each part there is a file for. */
  sources: Partial<Record<ClassPart, string>>;
  sapClient?: string;
}

export type PushResult =
  | {
      outcome: "activated" | "activation-failed";
      /** The parts that were written - empty when nothing differed. */
      written: ClassPart[];
      activation: ActivationOutcome;
      corrNr?: string;
    }
  | { outcome: "refused"; reason: string }
  | { outcome: "failed"; reason: string };

const CLASSES = "/sap/bc/adt/oo/classes/";
/** `src/api/objectcontents.ts` `lock`. */
const LOCK_ACCEPT =
  "application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result";

/** The class's ADT path - lower case, encoded (a namespaced `/NS/CL_X`
 *  becomes `%2Fns%2Fcl_x`, the way `fetchClassState` addresses it). */
export function classPath(className: string): string {
  return CLASSES + encodeURIComponent(className.toLowerCase());
}

/** Where a part's source is read and written. */
export function partPath(className: string, part: ClassPart): string {
  return classPath(className) + (part === "main" ? "/source/main" : `/includes/${part}`);
}

/** A path with its query; `sap-client` rides on every request. */
function withQuery(path: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) {
      params.set(k, v);
    }
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Line endings and the final newline do not count as a difference - abapGit
 *  writes LF, the server may answer CRLF. */
export function sameSource(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  return norm(a) === norm(b);
}

function header(res: AdtResponse, name: string): string | undefined {
  const v = res.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * The text of an ADT error answer: `exc:exception` with `message` and
 * `localizedMessage` (`src/AdtException.ts` `fromResponse`), or the status
 * when the body is something else.
 */
export function adtErrorText(res: AdtResponse): string {
  const localized = /<localizedMessage\b[^>]*>([\s\S]*?)<\/localizedMessage>/.exec(res.body)?.[1];
  const message = /<message\b[^>]*>([\s\S]*?)<\/message>/.exec(res.body)?.[1];
  const text = (localized || message || "").trim();
  return text ? decodeXml(text) : `the system answered ${res.status}`;
}

/** Whether a refused write names the missing transport request (verify the
 *  wording against a system - the library has no fixture for it). */
export function demandsTransport(res: AdtResponse): boolean {
  return res.status >= 400 && /transport|corrnr/i.test(adtErrorText(res));
}

export interface AdtLockResult {
  lockHandle: string;
  corrNr: string;
  isLocal: boolean;
}

/** `asx:abap/asx:values/DATA` of a lock answer (`objectcontents.ts` `lock`). */
export function parseLock(xml: string): AdtLockResult | undefined {
  const field = (name: string) =>
    decodeXml(new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? "").trim();
  const lockHandle = field("LOCK_HANDLE");
  if (!lockHandle) {
    return undefined;
  }
  return { lockHandle, corrNr: field("CORRNR"), isLocal: field("IS_LOCAL") === "X" };
}

/** The include types the class metadata lists (`class:includeType`). */
export function listedIncludes(xml: string): Set<string> {
  return new Set([...xml.matchAll(/class:includeType="([^"]+)"/g)].map((m) => m[1]));
}

/** The activation request body (`src/api/activate.ts`). */
export function activationBody(className: string): string {
  const name = className.toUpperCase().replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
    `<adtcore:objectReference adtcore:uri="${classPath(className)}" adtcore:name="${name}"/>` +
    `</adtcore:objectReferences>`
  );
}

/** The cookies of a stateful ADT session, sent back as a browser would. */
class CookieJar {
  private readonly cookies = new Map<string, string>();
  keep(res: AdtResponse): void {
    const raw = res.headers["set-cookie"];
    for (const line of Array.isArray(raw) ? raw : raw ? [raw] : []) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || /;\s*max-age=0\b/i.test(line)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }
  header(): string | undefined {
    return this.cookies.size ? [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") : undefined;
  }
}

/** One ADT conversation: the CSRF token, the session type and the cookies. */
class AdtSession {
  private token = "fetch";
  private readonly jar = new CookieJar();
  constructor(
    private readonly deps: AdtWriteDeps,
    private readonly sapClient: string | undefined
  ) {}

  async send(
    method: "GET" | "POST" | "PUT",
    path: string,
    query: Record<string, string | undefined>,
    options: { headers?: Record<string, string>; body?: string; stateful?: boolean } = {}
  ): Promise<AdtResponse> {
    const headers: Record<string, string> = {
      accept: "*/*",
      "cache-control": "no-cache",
      "x-csrf-token": this.token,
      "x-sap-adt-sessiontype": options.stateful ? "stateful" : "stateless",
      ...options.headers,
    };
    const cookie = this.jar.header();
    if (cookie) {
      headers.cookie = cookie;
    }
    const url = this.deps.base + withQuery(path, { ...query, "sap-client": this.sapClient });
    const res = await this.deps.request(url, { method, headers, body: options.body });
    this.jar.keep(res);
    const token = header(res, "x-csrf-token");
    if (this.token === "fetch" && token && token.toLowerCase() !== "required") {
      this.token = token;
    }
    return res;
  }
}

const ok = (res: AdtResponse) => res.status >= 200 && res.status < 300;

/**
 * The server's current source of one part, or undefined when the system has
 * no such include (404). Used by the diff the conflict check offers, too.
 */
export async function readServerSource(
  deps: AdtWriteDeps,
  className: string,
  part: ClassPart,
  sapClient?: string
): Promise<string | undefined> {
  const session = new AdtSession(deps, sapClient);
  const res = await session.send("GET", partPath(className, part), {}, {
    headers: { accept: "text/plain" },
    stateful: false,
  });
  if (res.status === 404) {
    return undefined;
  }
  if (!ok(res)) {
    throw new Error(`reading ${className} (${part}) failed - ${adtErrorText(res)}`);
  }
  return res.body;
}

/**
 * The whole sequence for one class: check it exists, compare, lock, write
 * what differs, unlock, activate. The unlock is in a `finally` from the
 * moment the lock is held, so an exception in between (a dropped
 * connection, a refused write) still releases it before the error leaves.
 */
export async function pushClass(req: PushRequest, deps: AdtWriteDeps): Promise<PushResult> {
  const { className } = req;
  const log = deps.log ?? (() => undefined);
  const session = new AdtSession(deps, req.sapClient);

  // 1. the class must exist - and the answer brings the CSRF token
  const meta = await session.send("GET", classPath(className), {});
  if (meta.status === 404) {
    return {
      outcome: "refused",
      reason: `${className} does not exist on the system. Creating a class needs a package and a transport decision - create it in your ABAP tooling first, then push.`,
    };
  }
  if (!ok(meta)) {
    return { outcome: "failed", reason: `reading ${className} failed - ${adtErrorText(meta)}` };
  }
  const includes = listedIncludes(meta.body);

  // 2. what differs from the server
  const toWrite: ClassPart[] = [];
  const missingOnServer = new Set<ClassPart>();
  for (const part of CLASS_PARTS) {
    const local = req.sources[part];
    if (local === undefined) {
      continue;
    }
    const res = await session.send("GET", partPath(className, part), {}, {
      headers: { accept: "text/plain" },
    });
    if (res.status === 404) {
      missingOnServer.add(part);
      toWrite.push(part);
    } else if (!ok(res)) {
      return { outcome: "failed", reason: `reading ${className} (${part}) failed - ${adtErrorText(res)}` };
    } else if (!sameSource(res.body, local)) {
      toWrite.push(part);
    }
  }
  if (part404WithoutCreate(missingOnServer)) {
    return {
      outcome: "refused",
      reason: `the system has no ${[...missingOnServer].join(", ")} include for ${className} - create it in your ABAP tooling first.`,
    };
  }

  let corrNr: string | undefined;
  if (toWrite.length > 0) {
    // 3. lock
    const lockRes = await session.send("POST", classPath(className), {
      _action: "LOCK",
      accessMode: "MODIFY",
    }, { headers: { accept: LOCK_ACCEPT }, stateful: true });
    if (!ok(lockRes)) {
      return {
        outcome: "refused",
        reason: `${className} could not be locked - ${adtErrorText(lockRes)}. Nothing was written.`,
      };
    }
    const lock = parseLock(lockRes.body);
    if (!lock) {
      return { outcome: "failed", reason: `the lock answer for ${className} carried no lock handle - nothing was written.` };
    }
    log(`push: ${className} locked`);
    try {
      corrNr = lock.corrNr || undefined;
      if (!corrNr && !lock.isLocal) {
        corrNr = await deps.askTransport({
          className,
          reason: `${className} is not a local object and is in no transport request yet.`,
        });
        if (!corrNr) {
          return { outcome: "refused", reason: `no transport request given - nothing was written to ${className}.` };
        }
      }
      // 4. a test include the server lacks
      if (
        missingOnServer.has("testclasses") ||
        (req.sources.testclasses !== undefined && includes.size > 0 && !includes.has("testclasses"))
      ) {
        const res = await session.send(
          "POST",
          classPath(className) + "/includes",
          { lockHandle: lock.lockHandle, corrNr },
          {
            headers: { "content-type": "application/*" },
            stateful: true,
            body:
              `<?xml version="1.0" encoding="UTF-8"?><class:abapClassInclude ` +
              `xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core" ` +
              `adtcore:name="dummy" class:includeType="testclasses"/>`,
          }
        );
        if (!ok(res)) {
          return { outcome: "failed", reason: `creating the test include of ${className} failed - ${adtErrorText(res)}` };
        }
      }
      // 5. write
      for (const part of toWrite) {
        const put = () =>
          session.send("PUT", partPath(className, part), { lockHandle: lock.lockHandle, corrNr }, {
            headers: { "content-type": "text/plain; charset=utf-8" },
            stateful: true,
            body: req.sources[part],
          });
        let res = await put();
        if (!ok(res) && !corrNr && demandsTransport(res)) {
          corrNr = await deps.askTransport({ className, reason: adtErrorText(res) });
          if (!corrNr) {
            return { outcome: "refused", reason: `no transport request given - ${className} was not written completely.` };
          }
          res = await put();
        }
        if (!ok(res)) {
          return { outcome: "failed", reason: `writing ${className} (${part}) failed - ${adtErrorText(res)}` };
        }
        log(`push: ${className} ${part} written`);
      }
    } finally {
      // 6. unlock - whatever happened above
      try {
        const res = await session.send("POST", classPath(className), {
          _action: "UNLOCK",
          lockHandle: lock.lockHandle,
        }, { stateful: true });
        log(ok(res) ? `push: ${className} unlocked` : `push: unlocking ${className} answered ${res.status}`);
      } catch (err) {
        log(`push: unlocking ${className} failed - ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await session.send("GET", "/sap/bc/adt/compatibility/graph", {}, { stateful: false });
      } catch {
        // best effort: the server ends an idle stateful session on its own
      }
    }
  }

  // 7. activate
  const act = await session.send(
    "POST",
    "/sap/bc/adt/activation",
    { method: "activate", preauditRequested: "true" },
    { headers: { "content-type": "application/xml" }, body: activationBody(className) }
  );
  if (!ok(act)) {
    return { outcome: "failed", reason: `activating ${className} failed - ${adtErrorText(act)}` };
  }
  const activation = parseActivationResponse(act.body, className);
  return {
    outcome: activation.success ? "activated" : "activation-failed",
    written: toWrite,
    activation,
    corrNr,
  };
}

/** Only the test include can be created here; a missing main source or
 *  local-definition include means something this command does not repair. */
function part404WithoutCreate(missing: Set<ClassPart>): boolean {
  return [...missing].some((part) => part !== "testclasses");
}

/** The refusal for a production system - its wording in one place. */
export function productionRefusal(system: string): string {
  return `${system} is a production system - pushing source to it is refused.`;
}
