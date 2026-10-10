/*
 * The agent app tools on a REAL system - `app_list`, `app_start`,
 * `app_describe`, `app_act` - for the system MCP server (mcpsystem.ts).
 *
 * abap2UI5/mcp-server has the same four tools against its transpiled local
 * backend: an agent fills fields, fires events and reads results by model
 * path, label and event name, over the JSON protocol the browser frontend
 * speaks, and every answer is an "agent snapshot v1" (mcp-server's
 * docs/agent-snapshot.md). The snapshot, the protocol client and its
 * validation are NOT re-implemented here: they are mcp-server's own modules,
 * vendored at a recorded commit into src/vendor/agent/ by
 * scripts/vendor-agent.mjs. What this module adds is what only the extension
 * has:
 *
 *   - the TRANSPORT (the client's `transport` option): every request goes
 *     through the extension's auth proxy (the credentials stay in the proxy,
 *     the traffic shows in its log, a 401 trips its breaker), with the
 *     system's cookies; the frontend's handshakes for a real system - a CSRF
 *     token layer in front of the backend, a stateful session's
 *     `sap-contextid` - are the vendored client's own, so the transport
 *     only carries their headers;
 *   - the LOCATION (the `location` option): the start request's
 *     ORIGIN/PATHNAME/SEARCH are the system's launch URL, never the proxy's,
 *     which must never reach the backend; no `generation` (drafts live on
 *     the system, not in a process this extension restarts), and a
 *     `backendHint` that points at this extension's connection check;
 *   - the SYSTEM: the active one, as for run_app_on_system, with an optional
 *     `system` argument that must name it (nothing here switches systems);
 *     a session remembers the system it was started on;
 *   - the GATE: the tools act as the configured user on a real system, so
 *     they answer only while `abap2ui5.agent.enableAppTools` is on.
 *
 * `vscode`-free: the setting, the systems and the proxy arrive as functions,
 * so the whole decision tree is covered by src/test/agentapps.test.ts.
 */

import * as http from "http";
import * as https from "https";
import { URL } from "url";
import { createRequire } from "module";
import * as path from "path";
import type { AppClient, AppLocation, AppTransport } from "./vendor/agent/appclient";
import type { AgentSnapshot } from "./vendor/agent/snapshot";

/**
 * The vendored client is NOT in this bundle: `esbuild.js` builds
 * `src/agent-client.ts` into `dist/agent-client.js` next to it, and it is
 * loaded here on the first app_* call - ~50 KB that every activation parsed
 * for four tools behind a setting that is off by default. Through
 * `createRequire`, not `require`: the bundler would inline a literal
 * `require("./agent-client")`, and it must leave this one for node to
 * resolve at runtime (the test build puts the same file in `dist-test/`,
 * next to the test bundles, so the real loader runs there too).
 */
type AgentClientModule = typeof import("./agent-client");
let agentClientModule: AgentClientModule | undefined;
function agentClient(): AgentClientModule {
  if (!agentClientModule) {
    agentClientModule = createRequire(__filename)(
      path.join(__dirname, "agent-client.js")
    ) as AgentClientModule;
  }
  return agentClientModule;
}
import { textResult, type McpTool, type McpToolResult } from "./mcprpc";
import { TOKEN_COOKIE } from "./proxy";
import { originOf, proxiedUrl, sapClientOf } from "./urls";

/** The setting that allows the tools, under the `abap2ui5.` prefix. */
export const ENABLE_APP_TOOLS_KEY = "agent.enableAppTools";

/** What a tool says while the setting is off. The tools stay LISTED: an MCP
 *  client reads the tool list once per server start, so tools that appeared
 *  only after the setting flipped would need a restart nobody would think
 *  of - and an agent that can see them can tell the user how to allow them. */
export const DISABLED_MESSAGE =
  "The abap2UI5 app tools are switched off. app_list, app_start, " +
  "app_describe and app_act operate abap2UI5 apps on the REAL SAP system as " +
  "the configured user - every event an agent fires runs for real (it may " +
  'save, post or delete data). To allow it, set "abap2ui5.agent.' +
  'enableAppTools": true in the VS Code User settings (a workspace cannot ' +
  "set it). Nothing was sent.";

// ---------------------------------------------------------------------------
// Argument checks - mcp-server's, so a refusal reads the same on both servers
// ---------------------------------------------------------------------------

/** mcp-server's `boundedInt` (lib/args.mjs): absent is the default, a
 *  non-number is refused, anything else is clamped. */
export function boundedInt(
  value: unknown,
  { name, dflt, min = 1, max = Number.MAX_SAFE_INTEGER }: {
    name: string;
    dflt: number | undefined;
    min?: number;
    max?: number;
  }
): number | undefined {
  if (value === undefined || value === null || value === "") {
    return dflt;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(
      `${name} must be a number, not '${String(value)}' — leaving it out means ${dflt}`
    );
  }
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** mcp-server's customer-namespace rule (lib/runtime.mjs `classNameOf`),
 *  plus the one shape only a real system has: a namespaced class
 *  (`/ns/cl_app`). Lower case, as mcp-server sends it. */
const CLASS_RE = /^(?:[zy][a-z0-9_]*|\/[a-z0-9_]{1,10}\/[a-z0-9_]+)$/;
const CLASS_MAX = 30;

export function classNameOf(className: unknown): string {
  const cls = String(className ?? "").trim().toLowerCase();
  if (!CLASS_RE.test(cls) || cls.length > CLASS_MAX) {
    throw new Error(
      `invalid class name '${String(className ?? "")}' — must be a plain ABAP class name in the customer namespace: ` +
        `/^[zy][a-z0-9_]*$/ (letters, digits and underscores only, starting z or y) or a namespaced one (/ns/cl_app), ` +
        `and <= ${CLASS_MAX} chars. e.g. zcl_my_app, z2ui5_cl_my_app`
    );
  }
  return cls;
}

// ---------------------------------------------------------------------------
// Where the roundtrips go
// ---------------------------------------------------------------------------

/** The class name the endpoint is derived with - any name works, it only has
 *  to be findable again in the expanded template. */
export const PROBE_CLASS = "Z2UI5_AGENT_PROBE";

/**
 * The abap2UI5 endpoint behind a launch URL: the URL the frontend POSTs every
 * roundtrip to, without the class. The browser POSTs to its own page
 * (`window.location.href`), and the start request names the class in its
 * body (`S_FRONT.SEARCH`), so the endpoint is the launch URL minus the query
 * parameter that carries the class, minus the hash a request never sends.
 * A template that puts `{class}` into the PATH has no such endpoint - that
 * is refused with what to configure instead.
 */
export function agentEndpoint(
  launchUrl: string,
  className: string = PROBE_CLASS
): { endpoint: string } | { problem: string } {
  let url: URL;
  try {
    url = new URL(launchUrl);
  } catch {
    return { problem: `the launch URL '${launchUrl}' does not parse` };
  }
  const cls = className.toUpperCase();
  for (const [key, value] of [...url.searchParams.entries()]) {
    if (value.toUpperCase() === cls) {
      url.searchParams.delete(key);
    }
  }
  url.hash = "";
  if (decodeURIComponent(url.pathname).toUpperCase().includes(cls)) {
    return {
      problem:
        "the launch URL template puts {class} into the path - the app tools POST to the " +
        "abap2UI5 endpoint and name the class in the request, so they need the class as a " +
        "query parameter: https://host:44300/sap/bc/z2ui5?app_start={class}&sap-client=100",
    };
  }
  return { endpoint: url.toString() };
}

/** One answer of the system, as the transport reads it. */
export interface SystemResponse {
  status: number;
  /** Lower-case header names, as node delivers them. */
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One request to the system - through the auth proxy in the extension, a
 *  scripted fake in the tests. */
export type SystemRequest = (
  url: string,
  init: {
    method: "POST" | "HEAD";
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<SystemResponse>;

/** A roundtrip answer carries a whole view and its model, so the cap is
 *  generous - it only exists so that a runaway answer cannot fill the
 *  extension host's memory. */
const RESPONSE_CAP = 32 * 1024 * 1024;

/** The real `SystemRequest`: plain node http(s), which is what the proxy
 *  speaks on loopback. Not `fetch` - the extension host may route `fetch`
 *  through the user's HTTP proxy settings, and loopback must never leave the
 *  machine. */
export const nodeRequest: SystemRequest = (url, init) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const mod = target.protocol === "https:" ? https : http;
    const req = mod.request(
      target,
      {
        method: init.method,
        headers: {
          ...init.headers,
          ...(init.body !== undefined
            ? { "content-length": String(Buffer.byteLength(init.body)) }
            : {}),
        },
        signal: init.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > RESPONSE_CAP) {
            res.destroy();
            reject(new Error(`the answer exceeded ${RESPONSE_CAP / 1024 / 1024} MB`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end(init.body);
  });

/**
 * The start request's location on a real system: the endpoint's origin and
 * path, and its query (sap-client, theme, language) with the class added as
 * `app_start` - what the browser sends from the launch URL. The backend
 * builds URLs out of it and keeps it with the app's session.
 */
export function systemLocation(endpoint: string, app: string): AppLocation {
  const url = new URL(endpoint);
  const query = new URLSearchParams(url.search);
  query.set("app_start", app);
  return { origin: url.origin, pathname: url.pathname, search: `?${query}` };
}

/**
 * The client's `transport`, on a real system: every request the vendored
 * client makes goes to the system's abap2UI5 endpoint through the auth
 * proxy, as the client built it - a roundtrip `POST`, or the `HEAD` of the
 * CSRF token fetch (no body).
 *
 * The frontend's handshakes (core/Server.js) are the CLIENT's, not this
 * transport's (mcp-server lib/appclient.mjs, the protocol's
 * spec/transport.md): it sends `sap-contextid-accept: header` on every POST
 * and the `sap-contextid` a session was handed with every later POST of
 * THAT session, and it answers a token layer's 403 + `X-CSRF-Token:
 * Required` (an approuter or Gateway in front of the backend) with the HEAD
 * fetch and ONE re-send, the token then sent with every POST. Both arrive
 * here as request headers and leave as response headers; doing them here
 * as well would fetch twice and re-send twice. What this adds is what only
 * the extension has:
 *
 *   - the route through the auth proxy (credentials never pass through
 *     here: the proxy injects them);
 *   - the system's cookies, kept and sent back as a browser would (the
 *     token layer binds its token to a session cookie).
 */
export function createSystemTransport(options: {
  /** The system's abap2UI5 endpoint (external URL, no class). */
  endpoint: () => string;
  /** The proxy's base url when it currently forwards to `origin`. */
  proxyBase: (origin: string) => string | undefined;
  request: SystemRequest;
}): AppTransport {
  const cookies = new Map<string, string>();

  const keepCookies = (res: SystemResponse): void => {
    const raw = res.headers["set-cookie"];
    for (const line of Array.isArray(raw) ? raw : raw ? [raw] : []) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // the proxy's own authorization cookie stops at the proxy anyway
      if (name.startsWith(TOKEN_COOKIE)) {
        continue;
      }
      const expired = attrs.some((a) => {
        const [k, v = ""] = a.split("=").map((x) => x.trim());
        if (/^max-age$/i.test(k)) {
          return Number(v) <= 0;
        }
        if (/^expires$/i.test(k)) {
          const t = Date.parse(v);
          return Number.isFinite(t) && t <= Date.now();
        }
        return false;
      });
      if (expired || value === "") {
        cookies.delete(name);
      } else {
        cookies.set(name, value);
      }
    }
  };

  return async ({ method = "POST", body, headers, signal }) => {
    const endpoint = new URL(options.endpoint());
    const base = options.proxyBase(endpoint.origin);
    if (!base) {
      throw new Error(
        `the extension's auth proxy is not connected to ${endpoint.host}`
      );
    }
    const target = proxiedUrl(endpoint.toString(), base);
    if (!target) {
      throw new Error(`cannot route ${endpoint.host} through the auth proxy`);
    }
    const sent: Record<string, string> = { ...headers };
    if (cookies.size) {
      sent.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const res = await options.request(
      target,
      method === "HEAD"
        ? { method: "HEAD", headers: sent, signal }
        : { method: "POST", headers: sent, body, signal }
    );
    keepCookies(res);
    return res;
  };
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

/** The active system as the tools need it. */
export interface AgentSystem {
  name: string;
  /** The external launch URL of a class (theme/language params included). */
  launchUrlFor(className: string): string;
}

export interface AgentAppsDeps {
  /** `abap2ui5.agent.enableAppTools`, read at call time. */
  enabled(): boolean;
  /** The active system, or undefined while none is chosen. */
  activeSystem(): AgentSystem | undefined;
  /** The names of every configured system. */
  systemNames(): string[];
  /** The shared connect flow (may prompt); undefined when the user backs out. */
  connect(): Promise<{ sapClient?: string } | undefined>;
  /** The proxy's base url (token included) when it forwards to `origin`. */
  proxyBase(origin: string): string | undefined;
  /** The ADT class-name search. */
  searchClasses(
    query: string,
    sapClient: string | undefined
  ): Promise<Array<{ name: string; description?: string; packageName?: string }>>;
  /** The linter's UI5 control snapshot for the snapshot builder, or null. */
  metadata?(): unknown;
  /** Defaults to `nodeRequest`. */
  request?: SystemRequest;
  log(message: string): void;
}

/** The client's `backendHint`: what follows "the backend did not answer
 *  (...)" - this extension's connection check, not mcp-server's `backend`
 *  tool. */
export const SYSTEM_HINT =
  'is the system reachable? "abap2UI5: Check System Connection" says';

const REAL =
  "Runs FOR REAL on the active SAP system as the configured user, through " +
  "the extension's auth proxy - an event may save, post or delete data. " +
  "Answers only while the user allows it (setting abap2ui5.agent.enableAppTools).";

const SYSTEM_PROP = {
  type: "string",
  description:
    "optional: the configured system to use (list_systems) - must be the ACTIVE one; " +
    "the tools never switch systems (the user does, with \"abap2UI5: Select System\")",
};

/** How many draft ids remember their system. */
const REGISTRY_MAX = 2000;

export function createAgentAppTools(deps: AgentAppsDeps): McpTool[] {
  const request = deps.request ?? nodeRequest;
  const clients = new Map<string, AppClient>();
  /** draft id -> the system the session runs on */
  const registry = new Map<string, string>();
  let nobody: AppClient | undefined;

  const endpointOf = (system: AgentSystem): string => {
    const where = agentEndpoint(system.launchUrlFor(PROBE_CLASS));
    if ("problem" in where) {
      throw new (agentClient().AgentError)(where.problem);
    }
    return where.endpoint;
  };

  const clientFor = (system: AgentSystem): AppClient => {
    let client = clients.get(system.name);
    if (!client) {
      const name = system.name;
      // read per request: theme and language may change between roundtrips,
      // and the act handler has already refused a session whose system is
      // no longer the active one
      const endpoint = (): string => {
        const active = deps.activeSystem();
        if (!active || active.name !== name) {
          throw new (agentClient().AgentError)(`system '${name}' is no longer the active system`);
        }
        return endpointOf(active);
      };
      client = agentClient().createAppClient({
        transport: createSystemTransport({
          endpoint,
          proxyBase: (origin) => deps.proxyBase(origin),
          request,
        }),
        location: (app) => systemLocation(endpoint(), app),
        backendHint: SYSTEM_HINT,
        metadata: () => deps.metadata?.() ?? null,
      });
      clients.set(name, client);
    }
    return client;
  };

  /** The client that knows a session, or one that says it does not exist
   *  in the vendored client's words. */
  const clientOfSession = (session: unknown): AppClient => {
    const name = registry.get(String(session ?? ""));
    const known = name ? clients.get(name) : undefined;
    if (known) {
      return known;
    }
    const active = deps.activeSystem();
    if (active && clients.has(active.name)) {
      return clients.get(active.name)!;
    }
    nobody ??= agentClient().createAppClient({
      transport: async () => {
        throw new Error("no system");
      },
      backendHint: SYSTEM_HINT,
    });
    return nobody;
  };

  const remember = (snapshot: AgentSnapshot, system: string): void => {
    if (snapshot.session) {
      registry.delete(snapshot.session);
      registry.set(snapshot.session, system);
      while (registry.size > REGISTRY_MAX) {
        registry.delete(registry.keys().next().value as string);
      }
    }
  };

  /** A snapshot as the answer (compact JSON, as mcp-server answers it), a
   *  refusal as an isError result; anything else is the handler's failure. */
  const snapshotAnswer = async (
    run: () => Promise<AgentSnapshot> | AgentSnapshot,
    system?: string
  ): Promise<McpToolResult> => {
    try {
      const snapshot = await run();
      if (system) {
        remember(snapshot, system);
      }
      return textResult(JSON.stringify(snapshot));
    } catch (err) {
      if (err instanceof agentClient().AgentError) {
        return textResult(err.message, true);
      }
      throw err;
    }
  };

  const listOf = (names: string[]) =>
    names.length ? names.map((n) => `'${n}'`).join(", ") : "none configured";

  /** Whether the proxy already forwards to this system - then no connect:
   *  the connect flow restarts the proxy's credentials, which would reset its
   *  breaker after a rejected logon on every agent call (and the agent loops). */
  const served = (system: AgentSystem): boolean => {
    const origin = originOf(system.launchUrlFor(PROBE_CLASS));
    return !!origin && !!deps.proxyBase(origin);
  };

  /**
   * The system a start-shaped call acts on: the active one, connected (the
   * proxy started with its credentials - which may prompt) unless the proxy
   * already forwards there, and the one `system` names when it names one.
   * Never switches systems.
   */
  const systemFor = async (
    wanted: unknown
  ): Promise<{ system: AgentSystem; sapClient?: string } | McpToolResult> => {
    const want = typeof wanted === "string" ? wanted.trim() : "";
    if (want && !deps.systemNames().includes(want)) {
      return textResult(
        `no configured system '${want}' - configured: ${listOf(deps.systemNames())} (list_systems)`,
        true
      );
    }
    const before = deps.activeSystem();
    if (want && before && before.name !== want) {
      return textResult(
        `system '${want}' is not the active system ('${before.name}') - the app tools act on the ` +
          'active system only; the user switches with "abap2UI5: Select System"',
        true
      );
    }
    if (before && served(before)) {
      return {
        system: before,
        sapClient: sapClientOf(before.launchUrlFor(PROBE_CLASS)),
      };
    }
    const connection = await deps.connect();
    if (!connection) {
      return textResult("the user cancelled the system/credential picker", true);
    }
    const system = deps.activeSystem();
    if (!system) {
      return textResult(
        'no active system - the user picks one with "abap2UI5: Select System"',
        true
      );
    }
    if (want && system.name !== want) {
      return textResult(
        `system '${want}' is not the active system ('${system.name}') - the app tools act on the ` +
          'active system only; the user switches with "abap2UI5: Select System"',
        true
      );
    }
    return { system, sapClient: connection.sapClient };
  };

  const disabled = () => textResult(DISABLED_MESSAGE, true);

  return [
    {
      name: "app_list",
      description:
        "The classes on the active SAP system app_start can start - an ADT class-name search " +
        "(the system counterpart of the abap2UI5 server's app_list over its build). `filter`: the " +
        "start of the class name, `*` as a wildcard (default 'Z'); at most 50 names. Names only: " +
        "whether a class implements z2ui5_if_app is not checked - app_start says so. Starts " +
        "nothing. " +
        REAL,
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            description:
              "class-name pattern for the ADT quick search: the start of the name, * as wildcard " +
              "(e.g. \"z2ui5_cl_smp_app_00\", \"*travel\")",
          },
          system: SYSTEM_PROP,
        },
      },
      handler: async (args) => {
        if (!deps.enabled()) {
          return disabled();
        }
        const chosen = await systemFor(args.system);
        if ("content" in chosen) {
          return chosen;
        }
        const filter = String(args.filter ?? "").trim();
        const refs = await deps.searchClasses(filter || "Z", chosen.sapClient);
        const apps = refs.map((ref) => ({
          app: ref.name,
          source: "system",
          ...(ref.description ? { description: ref.description } : {}),
          ...(ref.packageName ? { package: ref.packageName } : {}),
        }));
        return textResult(
          JSON.stringify(
            {
              system: chosen.system.name,
              count: apps.length,
              apps,
              hint: apps.length
                ? "app_start { app } starts one and answers with its agent snapshot; the names " +
                  "come from a class-name search, so a class that is no abap2UI5 app is refused " +
                  "by app_start with the backend's error"
                : `no class on ${chosen.system.name} matches '${filter || "Z"}*'`,
            },
            null,
            2
          )
        );
      },
    },
    {
      name: "app_start",
      description:
        "Start an abap2UI5 app class on the active SAP system and get its screen as an AGENT " +
        "SNAPSHOT (v1): the fields you can fill (id, model path, label, kind, current value, " +
        "editable, choice values), the actions you can fire (the event name and arguments of each " +
        "button/link/row/value-help wire), the tables (columns, the first rows, selection), the " +
        "messages (toast, message box, MessageStrip, field value states) and some static text - " +
        "read from the real abap2UI5 JSON protocol, no browser, no screenshot. Continue with " +
        "app_act using the snapshot's `session`. Optional `values` are applied as pending edits " +
        "right after the start. Same tools, snapshot and refusals as the abap2UI5 server's " +
        "sandbox app_start; run_app_on_system shows a screenshot instead. May ask the user for " +
        "credentials on first contact. " +
        REAL,
      inputSchema: {
        type: "object",
        properties: {
          app: {
            type: "string",
            description:
              "the app class to start, e.g. z2ui5_cl_smp_app_009 or zcl_my_app (app_list searches the system)",
          },
          values: {
            type: "object",
            description:
              'optional { "<field id, model path or name>": value } kept as pending edits (sent with the next app_act event)',
          },
          max_rows: {
            type: "number",
            description: "table rows per table in the snapshot (default 20, max 200)",
          },
          system: SYSTEM_PROP,
        },
        required: ["app"],
      },
      handler: async (args) => {
        if (!deps.enabled()) {
          return disabled();
        }
        const cls = classNameOf(args.app);
        const maxRows = boundedInt(args.max_rows, {
          name: "max_rows",
          dflt: 20,
          min: 0,
          max: 200,
        });
        const chosen = await systemFor(args.system);
        if ("content" in chosen) {
          return chosen;
        }
        const { system } = chosen;
        return snapshotAnswer(
          () => clientFor(system).start(cls, { values: args.values, maxRows }),
          system.name
        );
      },
    },
    {
      name: "app_describe",
      description:
        "The current agent snapshot of a running app session (see app_start) - answered from " +
        "the last response this server kept, no roundtrip, so it is free and sends nothing. " +
        "Pending edits (values sent without an event) show as the fields' values and are listed " +
        "under `pending`. Answers only while the user allows the app tools (setting " +
        "abap2ui5.agent.enableAppTools).",
      inputSchema: {
        type: "object",
        properties: {
          session: {
            type: "string",
            description: "the `session` of the last snapshot (the draft id to continue with)",
          },
          max_rows: {
            type: "number",
            description: "table rows per table (default: what app_start used)",
          },
        },
        required: ["session"],
      },
      handler: async (args) => {
        if (!deps.enabled()) {
          return disabled();
        }
        const maxRows = boundedInt(args.max_rows, {
          name: "max_rows",
          dflt: undefined,
          min: 0,
          max: 200,
        });
        return snapshotAnswer(() =>
          clientOfSession(args.session).describe(args.session, { maxRows })
        );
      },
    },
    {
      name: "app_act",
      description:
        "Operate a running app session on the SAP system semantically: fill fields and fire an " +
        "event, then get the new agent snapshot. `values` { \"<field id | model path | name>\": " +
        "value } (table cells as \"<table path or id>/<row>/<COLUMN>\", e.g. \"/T_TAB/2/SELKZ\" to " +
        "select a row) go out as the model delta of the roundtrip; `event` is an action's event " +
        "name or its id (\"a3\"); `row` (0-based) fills the row-dependent arguments of a row action " +
        "(\"$row:FIELD\", \"$source:text\", and the row-valued event parameters such as " +
        "${$parameters>/listItem}.getBindingContext()...); on a SelectDialog/TableSelectDialog the " +
        "`confirm` action is the pick: `row` selects that row as a click does (its selectionField, " +
        "sent as the model delta) and fills selectedItem/selectedContexts arguments from it; " +
        "`args` (positional, null = let the client fill it) " +
        "supplies arguments the browser would compute (\"$expr:...\", \"$parameters:...\", a message " +
        "box's \"$action\"). Without `event` the values stay pending, as typing does in the browser " +
        "- nothing is sent. Strict: an event that is not among the snapshot's actions, a field " +
        "that is not on the screen or not editable, a choice outside its values is refused - the " +
        "error names what is allowed - and nothing is sent. \"@CLOSE_POPUP\" / \"@CLOSE_POPOVER\" " +
        "actions close the dialog locally, as the browser does without a roundtrip. The session " +
        "must still run on the active system. " +
        REAL,
      inputSchema: {
        type: "object",
        properties: {
          session: { type: "string", description: "the `session` of the last snapshot" },
          values: {
            type: "object",
            description:
              '{ "<field id, model path or name>": value, "<table path>/<row>/<COLUMN>": value }',
          },
          event: {
            type: "string",
            description: 'the action to fire: its event name (e.g. "SAVE") or its id ("a3")',
          },
          args: {
            type: "array",
            description:
              "event arguments, positional to the action's `args`; null where the client fills the value in",
          },
          row: {
            type: "number",
            description:
              "for a row action: the row index (0-based) in its table - for a selection dialog's confirm, the row to pick",
          },
          max_rows: {
            type: "number",
            description: "table rows per table in the answer (default: what app_start used)",
          },
        },
        required: ["session"],
      },
      handler: async (args) => {
        if (!deps.enabled()) {
          return disabled();
        }
        const maxRows = boundedInt(args.max_rows, {
          name: "max_rows",
          dflt: undefined,
          min: 0,
          max: 200,
        });
        const row =
          args.row === undefined || args.row === null ? undefined : Number(args.row);
        const session = String(args.session ?? "");
        const systemName = registry.get(session);
        if (systemName) {
          const active = deps.activeSystem();
          if (!active || active.name !== systemName) {
            return textResult(
              `session '${session}' runs on system '${systemName}', but the active system is ` +
                `${active ? `'${active.name}'` : "none"} - the app tools act on the active system ` +
                'only; the user switches back with "abap2UI5: Select System" (the session is kept)',
              true
            );
          }
          // connect only when the proxy does not already forward there (see
          // `served`)
          if (!served(active)) {
            const connection = await deps.connect();
            if (!connection) {
              return textResult("the user cancelled the system/credential picker", true);
            }
          }
          return snapshotAnswer(
            () =>
              clientFor(active).act(args.session, {
                values: args.values,
                event: args.event,
                args: args.args,
                row,
                maxRows,
              }),
            systemName
          );
        }
        // unknown here: the client refuses it in its own words, sending nothing
        return snapshotAnswer(() =>
          clientOfSession(session).act(args.session, {
            values: args.values,
            event: args.event,
            args: args.args,
            row,
            maxRows,
          })
        );
      },
    },
  ];
}
