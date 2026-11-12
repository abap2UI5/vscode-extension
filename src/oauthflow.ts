import * as http from "http";
import * as https from "https";
import { randomBytes } from "crypto";
import { AddressInfo } from "net";
import {
  authorizeUrl,
  createPkce,
  createState,
  exchangeCode,
  OAuthTokens,
  readCallback,
  ServiceKey,
  TokenPost,
} from "./oauth";
import { isLoopbackHost, tokensEqual } from "./proxyheaders";

/*
 * oauthflow - the I/O of the OAuth logon (`auth: "oauth"`): the loopback
 * listener the browser is redirected back to, the form POST to the token
 * endpoint, and the authorization-code flow that strings them together.
 *
 * `vscode`-free: the browser is opened through an injected `openBrowser`
 * (`vscode.env.openExternal` in the editor, an HTTP client in the tests).
 *
 * The listener follows the AGENTS.md convention for every local listener:
 * `127.0.0.1` only, a `randomBytes(16)` segment as its whole path (every
 * other path 404), a `Host` that is not loopback refused, and it closes after
 * the first callback on its path - which ends the logon either way. Nothing
 * here logs a request URL: the callback's query carries the code.
 */

/** How long the browser logon may take (an IdP prompt, a second factor). */
export const CALLBACK_TIMEOUT_MS = 5 * 60_000;

/** A token answer is a few KB; the cap keeps a misbehaving host bounded. */
const TOKEN_ANSWER_MAX_BYTES = 256 * 1024;
const TOKEN_TIMEOUT_MS = 30_000;

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // the address bar holds the code - no page this tab opens may see it
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'",
  "x-content-type-options": "nosniff",
  // the listener closes after this answer; the socket goes with it
  connection: "close",
};

function page(title: string, text: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
    `<body><h1>${title}</h1><p>${text}</p></body></html>`
  );
}

/** The listener one browser logon waits on. */
export interface CallbackListener {
  /** `http://127.0.0.1:<port>/<token>` - the redirect URI. */
  readonly redirectUri: string;
  /** The authorization code, once the browser came back with this logon's
   *  `state`; rejects with the reason the logon is refused, on timeout or
   *  abort. */
  readonly code: Promise<string>;
  /** Stops listening (idempotent). */
  close(): void;
}

/**
 * Starts the loopback listener for one logon with `state`. Resolves once it
 * listens.
 */
export async function startCallbackListener(options: {
  state: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CallbackListener> {
  const token = randomBytes(16).toString("hex");
  let settle: { resolve(code: string): void; reject(err: Error): void } | undefined;
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // a rejection nobody awaits yet (the browser is still being opened) must
  // not surface as an unhandled one
  code.catch(() => undefined);
  let done = false;
  const server = http.createServer((req, res) => {
    if (!isLoopbackHost(req.headers.host)) {
      // the shape of DNS rebinding: refused outright, before the path is read
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (done || req.method !== "GET" || !tokensEqual(url.pathname, `/${token}`)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    const answer = readCallback(url.searchParams, options.state);
    if ("code" in answer) {
      res
        .writeHead(200, PAGE_HEADERS)
        .end(page("abap2UI5: logged on", "You can close this tab and return to VS Code."));
      finish(undefined, answer.code);
    } else {
      res
        .writeHead(400, PAGE_HEADERS)
        .end(page("abap2UI5: logon refused", `The logon was refused: ${answer.refused}.`));
      finish(new Error(answer.refused));
    }
  });
  const timeoutMs = options.timeoutMs ?? CALLBACK_TIMEOUT_MS;
  const timer = setTimeout(
    () =>
      finish(
        new Error(
          `the browser logon did not come back within ${Math.max(1, Math.round(timeoutMs / 60_000))} min`
        )
      ),
    timeoutMs
  );
  const onAbort = () => finish(new Error("the browser logon was cancelled"));
  function finish(err: Error | undefined, value?: string): void {
    if (done) {
      return;
    }
    done = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    // let the answer page go out, then stop listening for good
    server.close();
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 2000).unref();
    if (err) {
      settle!.reject(err);
    } else {
      settle!.resolve(value!);
    }
  }
  if (options.signal?.aborted) {
    onAbort();
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    redirectUri: `http://127.0.0.1:${port}/${token}`,
    code,
    close: () => finish(new Error("the browser logon was cancelled")),
  };
}

/**
 * One form POST over node's own `http`/`https` (which the editor's proxy
 * support patches). Certificates are verified as always; the answer is
 * capped and timed out. The body and the headers are never logged.
 */
export const postForm: TokenPost = (url, headers, body) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "http:" ? http : https;
    const req = client.request(
      target,
      {
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body) },
        timeout: TOKEN_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > TOKEN_ANSWER_MAX_BYTES) {
            req.destroy(Object.assign(new Error("answer too large"), { code: "ETOOLARGE" }));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })
        );
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end(body);
  });

/**
 * The authorization-code flow with PKCE (`S256`) and `state`: listen on
 * loopback, send the browser to the UAA's authorize endpoint, wait for the
 * redirect back with this logon's state, exchange the code (with the
 * verifier and the very same redirect URI) for tokens.
 *
 * `openBrowser` answers false when the browser could not be opened.
 * `externalRedirect` maps the loopback URI for a remote host
 * (`env.asExternalUri`) - identity on the local desktop.
 */
export async function logOnInBrowser(options: {
  key: ServiceKey;
  openBrowser: (url: string) => Promise<boolean>;
  post?: TokenPost;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
  externalRedirect?: (uri: string) => Promise<string>;
}): Promise<OAuthTokens> {
  const pkce = createPkce();
  const state = createState();
  const listener = await startCallbackListener({
    state,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  try {
    const redirectUri = options.externalRedirect
      ? await options.externalRedirect(listener.redirectUri)
      : listener.redirectUri;
    const opened = await options.openBrowser(
      authorizeUrl(options.key, { redirectUri, state, challenge: pkce.challenge })
    );
    if (!opened) {
      throw new Error("the browser could not be opened for the logon");
    }
    const code = await listener.code;
    return await exchangeCode(
      options.key,
      { code, redirectUri, verifier: pkce.verifier },
      options.post ?? postForm,
      options.now
    );
  } finally {
    listener.close();
  }
}
