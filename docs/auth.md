# Logon beyond basic authentication - design note (T06a)

Status: **decided** (section 6); T06c started with the interface and the certificate. It
answers T06a in `ROADMAP.md`: which mechanisms, in which order, how each gets,
stores, renews and sends its secret, and what `AuthStrategy` (T06b) must gain
for T06c. No SAP system was available: every unconfirmed statement about the
SAP side is marked *(verify)*. Statements about this repository are from the
code as it is now.

---

## 1. Where things stand

| Place | What it does today | Basic-auth assumption |
| --- | --- | --- |
| `src/authstrategy.ts` | `AuthStrategy { kind; requestHeaders(); onUnauthorized(answer) }`, `UnauthorizedVerdict = "rejected" \| "ignore"`; `BasicAuthStrategy` keeps one prepared `Authorization` header in a `#private` field | `requestHeaders()` is synchronous and answers the same thing for the whole proxy session; nothing can renew it |
| `src/proxy.ts` | `start(origin, auth)` (and the `user, pass` overload); `prepareForwardHeaders` does `Object.assign(headers, auth.requestHeaders())` on forwarded requests and the WebSocket upgrade; `fetchFromSystem` spreads the same headers; `rejectedBy401` asks the strategy and sets `authRejected`, the retry breaker | Two texts are basic-specific: the breaker's local 401 body (*"the system rejected the stored user or password ... Enter the credentials again"*) and `fetchFromSystem`'s rejection (*"the system rejected the stored credentials"*). TLS options are built in three places (`handle`, `fetchFromSystem`, `handleUpgrade`) from `tlsStance` only - there is no hook for a client certificate |
| `src/systems.ts` | `ensureCredentials` prompts for user and password and stores them under `abap2ui5.user:<origin>` / `abap2ui5.pass:<origin>`; `clearCredentials` and the remembered-origins list | The only secret shape is user + password |
| `src/systemprofile.ts` | `auth` is reserved: `"basic"` accepted, any other word ignored with a log line | - |
| `src/connectcheck.ts` | `classifyStatus`: 401 without `WWW-Authenticate` -> *"does not offer basic authentication ... set abap2ui5.openMode to external"*; 3xx -> *"usually a redirect to a logon page ... form-based logon or SSO ... openMode external"* | Both fixes send the user away from the proxy |
| `src/launch.ts` | `watchProxyStatus` offers *Re-enter Credentials* on a 401 and says *"or this system does not accept basic auth - in which case set abap2ui5.openMode to external"*; four call sites `ensureCredentials` + `proxy.start(origin, creds.user, creds.pass)` (F9, the connection check, the re-logon, `makeConnectSystem`) | The strategy is built from user + password at each call site |
| `src/agentapps.ts` | `createSystemTransport` goes through the proxy, keeps the system's cookies in its own jar and sends them back; CSRF and `sap-contextid` are the vendored client's headers | Sends its own `cookie` header - which the proxy would currently REPLACE if a strategy returned `cookie` from `requestHeaders()` (`Object.assign`) |
| `src/activationwatch.ts` | Polls `fetchClassState` (-> `fetchFromSystem`); a 401 is "not a statement about ADT", 403/404 stop the watch | A logon that expires mid-watch looks like a rejected password |
| `src/report.ts` | Redacts `authorization` / `proxy-authorization` values (scheme kept) | `cookie`, `set-cookie`, `MYSAPSSO2=`, bearer tokens outside an `authorization` header and OAuth `code=` / `refresh_token=` are not redacted |

Constraints from `AGENTS.md` every mechanism keeps: secrets only in
`context.secrets`, keyed by origin, in the proxy only in memory (`#private`),
never in a log, the traffic channel, the roundtrip ring or *Copy
Diagnostics*; every local listener (an OAuth callback too) has a
`randomBytes(16)` path token and refuses a non-loopback `Host`; an
unverifiable server certificate is trusted per origin by pin only; a profile
field may only tighten - `abap2ui5.systems` is workspace-settable, so a
repository may not decide where a secret goes beyond what it decides today
(the launch URL's origin); the mechanism is chosen by the profile's `auth`
field, never guessed after a failure (ROADMAP T06).

---

## 2. Can VS Code get hold of an SSO session at all?

The core problem of every SSO variant: the logon happens in a browser (SAML
2.0 redirect to an IdP, SPNEGO, a client certificate in the OS store), and the
result is an `HttpOnly` cookie in that browser's jar - `MYSAPSSO2` (the logon
ticket) and/or `SAP_SESSIONID_<SID>_<client>` (the ICF security session)
*(verify the exact names per release)*. The proxy is a Node process and needs
those values. The options, honestly:

| Route | Can it read the HttpOnly cookies? | Notes |
| --- | --- | --- |
| Webview iframe (the preview itself) | **No.** `document.cookie` never shows `HttpOnly` cookies, the iframe is cross-origin to the webview, and the extension has no API into the webview's cookie jar | The iframe could *perform* a logon through the proxy (next row but one), but nothing outside it can read the result |
| `vscode.authentication` API | **No.** It is a registry: an extension registers an `AuthenticationProvider` and still implements the flow itself. It gives the *Accounts* menu entry, sign-out and session-change events - presentation, not a capture mechanism | Worth using as the UI for a mechanism that has sessions (OAuth, browser logon) *(decide)* |
| External browser (`env.openExternal`) + loopback redirect | **No** for cookies: a redirect to `http://127.0.0.1:<port>/...` carries no cookie of the SAP host. **Yes** when the server puts a *code or ticket in the redirect URL* - which is exactly OAuth's authorization code, and possibly the ADT reentrance logon *(verify, see 3.2)* | The loopback listener needs the AGENTS.md token-in-path + `Host` check; `state`/PKCE as the OAuth anti-forgery |
| External browser + the user pastes cookies | **Yes, by hand** (DevTools shows HttpOnly cookies). abapfs ships this as "Browser SSO (Cookie Capture)": a local helper page the user pastes cookies into | Poor UX, invites users to paste session cookies into chats and issues; not recommended |
| Proxy-observed logon inside the iframe | **Yes, for same-origin form logon only.** The proxy already sees every `Set-Cookie` (it rewrites them in `rewriteSetCookie`). If the strategy injects nothing and the ICF node serves its own logon form, the user logs on in the iframe and the proxy can keep `MYSAPSSO2` from the answer | **Breaks for SAML 2.0**: the IdP is another host (the iframe leaves the proxy, many IdPs refuse framing), and the assertion is POSTed to the system's real ACS URL, not to the proxy. Also breaks for SPNEGO and certificates, which the webview's network stack would have to do itself *(verify)* |
| A browser the extension controls (Chromium over the DevTools protocol) | **Yes.** `Storage.getCookies` / `Network.getAllCookies` return HttpOnly cookies. The extension already installs a Chromium for the render gate and `screenshot.ts` already starts it | Start it *headed*, with a throwaway `--user-data-dir`, and `--remote-debugging-pipe` (a pipe on fds 3/4: no TCP port, so no new listener). The user completes whatever the IdP wants; the extension reads the cookies for the system's host and closes the browser. Desktop only; not on a Remote host without a display. Whether the render gate's Chromium build runs headed on every platform *(verify)* |

So a "browser logon whose cookies the proxy replays" is real only through a
**controlled Chromium** (any IdP flow) or a **proxy-observed form logon**
(same-origin ICF logon form only). The external system browser cannot hand
over cookies, and a webview cannot read them.

---

## 3. The candidates

Per candidate: how the secret is obtained, where it is stored, expiry and
renewal, what the proxy sends, the fit with `AuthStrategy`, what the
connection check and the agent tools must change, and the risks.

### 3.1 Browser logon, session cookies replayed (`auth: "browser"`)

**SAP side.** An ICF node checks its logon procedures in order (standard
order: HTTP fields, client certificate, logon/assertion ticket, basic auth,
..., SPNEGO, SAML 2.0, service data), or an alternative order per node, with
SAML 2.0 switchable per service [1][2][3]. A logon ticket (`MYSAPSSO2`) is
accepted on later requests by the ticket step, provided the system accepts
SSO2 tickets (`login/accept_sso2_ticket`) [4]. So a request carrying a valid
`MYSAPSSO2` is logged on without SAML being involved *(verify on a SAML-only
node - whether the ticket step stays in its logon order)*.

**Obtaining.** Command *"abap2UI5: Log On in Browser"*, and the same flow
when F9 finds no valid session for a `browser` profile:

1. find the render gate's Chromium (`findChromium`); none -> offer the
   install, as the screenshot does;
2. start it headed: throwaway profile directory under the extension's
   global storage (deleted afterwards), `--remote-debugging-pipe`,
   `--no-first-run`, the system's launch URL (with `sap-client`) as the only
   tab; for SPNEGO add `--auth-server-allowlist=<host>` *(verify flag name
   for the bundled build)*;
3. watch the page over CDP until the top frame is back on the system's origin
   with a non-logon answer (status 200 and not the ICF logon form), or the
   user closes the window (= cancel), or a timeout (5 min);
4. read the cookies for the system's host: keep `MYSAPSSO2` and
   `SAP_SESSIONID_*`; discard everything else (IdP cookies stay in the
   throwaway profile, which is deleted);
5. close the browser, delete the profile directory.

Fallback where Chromium is unavailable: the proxy-observed form logon, but
only on nodes that serve the ICF form - say so instead of trying SAML through
it.

**Stored.** `context.secrets` under `abap2ui5.session:<origin>`: a JSON blob
`{ cookies: {name: value}, obtainedAt }`. Decision: store `MYSAPSSO2` only and
keep `SAP_SESSIONID_*` in memory (a security session is short-lived and bound
to the server's session store), or store both *(decide)*. Never a file, never
`globalState`.

**Expiry and renewal.** The ticket carries its own validity
(`login/ticket_expiration_time`, default 8 h *(verify)*); the security
session expires after inactivity *(verify default)*. Neither is reliably
visible in the cookie attributes, so expiry is detected from answers:

- 401 on a request that carried the cookies;
- a 3xx whose `Location` leaves the origin (IdP) or points at the SAML
  endpoints (`/sap/saml2/...`) *(verify path)*;
- a 200 HTML logon form on a request that expected XML/JSON (ADT, the
  abap2UI5 roundtrip POST).

Renewal is interactive only: the proxy stops forwarding with an *expired*
state (not *rejected*: there is no lockout risk, but replaying a dead cookie
helps nobody), and the host offers *Log On Again*, which reruns the flow and
`start( )`s the proxy with the new strategy. `Set-Cookie` answers that renew
`MYSAPSSO2` or issue a new `SAP_SESSIONID_*` are taken over by the strategy
(sliding session) - in memory, and written to secrets only for `MYSAPSSO2`.

**Per request.** `Cookie: MYSAPSSO2=...; SAP_SESSIONID_...=...` merged into
the cookie header the client sent (the iframe's own cookies, the agent
transport's jar): the strategy's value wins for its own names, every other
cookie passes. No `Authorization` header.

**Fit with `AuthStrategy`.** Needs cookies as a separate channel (a
`cookie` entry in `requestHeaders()` would overwrite the client's cookies),
a third verdict (`expired`), and answer classification beyond 401 (the
redirect and the logon form). Should the proxy also stop handing the
strategy's cookies to the iframe in `Set-Cookie`? Recommended: yes, strip
`MYSAPSSO2` from answers to the iframe - the proxy injects it anyway, and the
webview's cookie jar should not hold a domain-wide ticket *(decide)*.

**Connection check / messages.** `classifyStatus` gets the profile's
mechanism: for `browser`, a 401 or a redirect to the IdP means "your browser
logon expired - Log On Again", not "set openMode external". A new step
*Logon* reports mechanism and age of the session (never the value).
`watchProxyStatus` offers *Log On Again* instead of *Re-enter Credentials*.

**Agent tools / activation watch.** Both go through the proxy and inherit
the cookies, but never open a browser themselves: `makeConnectSystem` with
`askAboutCertificates: false` (the MCP path) gets a refusal *"no valid browser
logon for <system> - press F9 or run Log On in Browser"*, like the certificate
refusal. The activation watch pauses on *expired* instead of failing a poll.

**Risks.**

- **Cookie scope:** `MYSAPSSO2` is usually issued for the parent domain and
  accepted by every system that trusts the issuing system [4] *(verify per
  landscape)*. A stolen ticket is worth more than one system's password.
  Store per origin, inject only toward that exact origin, never log it.
- The throwaway profile must really be deleted (crash path: delete leftovers
  at the next start).
- `report.ts` must redact `cookie`/`set-cookie` header values and any
  `MYSAPSSO2=` / `SAP_SESSIONID_...=` pair.
- A workspace can name the launch URL's origin today (and so where a basic
  password goes); with `browser` it decides where the user is sent to log on
  - same reach, no new weakening. It must not be able to name anything else
  (no IdP URL, no cookie names in the profile).

### 3.2 ADT reentrance ticket

Not a mechanism of its own, but an **exchange**: a client that is already
logged on to ADT asks `GET /sap/bc/adt/security/reentranceticket` (on-premise)
or `/sap/bc/adt/core/http/reentranceticket` (seen on S/4HANA Cloud) for a
ticket [5][6][7]; the ticket is accepted by the SSO redirect service
`/sap/public/myssocntl` only as a header or POST form field
(`sap-mysapsso=<client><ticket>`, optional `sap-mysapred=<url>`), never as a
query parameter, and the answer sets the session cookie [6]. abapfs uses it to
open WebGUI and Playwright sessions already logged on.

Eclipse ADT's browser logon for ABAP Environment ("Open Logon Page in
Browser", "Copy Logon URL to Clipboard" [8][9]) is believed to run through a
reentrance endpoint with a loopback redirect that carries a ticket
(`/sap/bc/sec/reentrance?scenario=...&redirect-url=http://localhost:...`)
*(verify - no public documentation found; this would be the one external
browser flow that hands a credential to a loopback listener without OAuth
client credentials)*.

**Use here.** Two places where it could matter:

- on BTP ABAP Environment, after an OAuth logon to the API host (3.3), a
  reentrance ticket could produce cookies for the host that serves the
  abap2UI5 HTTP service, if that is a different host *(verify which host
  serves `/sap/bc/http/...` HTTP services and whether it accepts the bearer
  token directly)*;
- should the loopback reentrance flow above be confirmed, it is an
  alternative to the controlled Chromium on systems that support it: the
  user's own browser, no Chromium, no cookie reading.

The ticket is single-use and short-lived *(verify)* and never stored; the
cookie it buys is stored as in 3.1.

### 3.3 OAuth 2.0 with a service key - BTP ABAP Environment (`auth: "oauth"`)

**SAP side.** A service key of the ABAP Environment instance contains the
system URL (`url`) and a `uaa` block (`url`, `clientid`, `clientsecret`).
Tools authorize with the authorization-code grant against
`<uaa.url>/oauth/authorize` and exchange the code at `<uaa.url>/oauth/token`;
the bearer token is then sent to the system URL, not to the UAA [10][11][12].
abapfs (`client/src/oauth/oauth.ts`) does exactly that with a loopback
callback and a 60 s timeout, and keeps the refresh token in the OS credential
store [12]. abapfs also has a *BTP Endpoint* option with an interactive Cloud
Foundry login [13]. Basic authentication is not offered to business users on
the ABAP Environment *(verify; communication users of a communication
arrangement do get basic auth or certificates [14], but that is a technical
user, not the developer - see 3.6)*.

**Obtaining.** Command *"abap2UI5: Import Service Key"*: an open dialog
(or paste box) for the JSON; validated (`url`, `uaa.url`, `uaa.clientid`,
`uaa.clientsecret`, `https` only); the profile's launch URL origin must match
the key's `url` origin or the user confirms the mapping. Then:

1. a loopback listener on `127.0.0.1:<random>` with a `randomBytes(16)`
   segment in the callback path and the `Host` check (AGENTS.md); PKCE
   `S256` and a random `state`;
2. `env.openExternal(<uaa.url>/oauth/authorize?response_type=code&client_id=...&redirect_uri=...&state=...&code_challenge=...)`;
   whether XSUAA accepts an arbitrary loopback port and path for this client
   *(verify - abapfs uses `http://localhost/...` style redirects)*; on a
   Remote host, `env.asExternalUri` for the callback *(verify)*;
3. the callback checks `state`, answers a static "you can close this tab"
   page, closes the listener; the code is exchanged for access + refresh
   token with client id/secret.

**Stored.** `context.secrets` under `abap2ui5.oauth:<origin>`:
`{ uaaUrl, clientId, clientSecret, refreshToken }`. The access token stays in
memory. The service key itself is a secret (client secret) and is never a
setting or a profile field.

**Expiry and renewal.** `expires_in` from the token answer (XSUAA defaults
are commonly 12 h access / 7 d refresh *(verify for ABAP Environment)*).
The strategy refreshes **before** expiry (e.g. at 80 % of the lifetime), in
`prepare( )` ahead of a request, single-flight. A 401 on a request carrying a
token younger than its lifetime: try one refresh; if the refresh is refused,
verdict *expired* (interactive logon again). A refused authorization code or
client secret is *rejected*. The proxy cannot replay a streamed POST, so the
401 path is for the next request, which is why the proactive refresh matters.

**Per request.** `Authorization: Bearer <access token>`; system cookies
pass through as today. **Fit:** an asynchronous `prepare` before the headers
(then `requestHeaders()` can stay synchronous), the `expired` verdict.

**Connection check / agent tools.** A *Logon* step (token obtained, expires
in N min). The MCP path refreshes silently, never starts the browser flow
(refusal as in 3.1). ADT and the HTTP service may live on different hosts of
one instance *(verify)*; the activation watch and app search ask ADT on the
launch URL's origin today.

**Risks.** Token in logs: the `code=`, `access_token`, `refresh_token`
strings must be covered by `report.ts`; the callback URL carries the code
and must never be logged. A malicious workspace must not be able to point
the logon at its own UAA: the UAA URL comes only from the key the user
imported, never from `abap2ui5.systems`. The client secret grants a logon
flow, not a session - still secret-store only.

### 3.4 X.509 client certificate (`auth: "certificate"`)

**SAP side.** ICF checks a client certificate early in the standard order,
or mandatorily per node; the certificate is mapped to a user (rule-based
mapping / `CERTRULE`, or the `USREXTID` table) [1][15]. Requires the ICM to
request client certificates (`icm/HTTPS/verify_client`) *(verify)* and a
TLS connection that reaches the ICM (an SSL-terminating load balancer in
front breaks it unless it forwards the certificate) *(verify)*.

**Obtaining.** Command *"abap2UI5: Choose Client Certificate"*: an open
dialog for a `.p12`/`.pfx` (or PEM cert + key), then the passphrase.
**Honest limit:** many SSO landscapes put short-lived certificates into the
Windows certificate store or onto a smart card (SAP Secure Login Client),
with a non-exportable key. Node's TLS cannot use such a key; those users are
served by the controlled Chromium (3.1), which uses the OS store natively
*(verify for the bundled Chromium)*.

**Stored.** The PKCS#12 bytes (base64) and the passphrase in
`context.secrets` under `abap2ui5.cert:<origin>`, or only the passphrase and
a path in a machine-scoped setting *(decide; bytes in secrets keeps a moved
file from breaking the logon and keeps the path out of workspace reach)*.

**Expiry.** `notAfter` is known locally (`crypto.X509Certificate`): warn
from 14 days before; expired -> refuse before connecting. Renewal is the
user choosing a new file. A 401/403 after a successful handshake means "not
mapped" -> *rejected* (the breaker matters less - no password lockout - but
a burst still makes noise in the security audit log).

**Per request.** Nothing in the headers. `cert`/`key` or `pfx` +
`passphrase` in the TLS options of **all three** request sites (`handle`,
`fetchFromSystem`, `handleUpgrade`). The certificate pin logic
(`tlsStance`, `whenTrusted`) is unchanged: the client certificate is
presented during the handshake, i.e. before the proxy's own pin comparison
on a pinned origin - that discloses the public certificate to an unverified
server, never the key.

**Fit.** A `tlsOptions()` hook - not a header at all. **Risks.** Smallest:
the key never leaves the process, no cookie to steal; identity disclosure to
a wrong host (above); the passphrase stays out of every log.

### 3.5 Kerberos / SPNEGO

SPNEGO is an ICF logon procedure of its own, needs SAP Single Sign-On on the
system [1] and answers `401` + `WWW-Authenticate: Negotiate`. Node has no
GSSAPI/SSPI: the options are the native `kerberos` npm module (per-platform
builds in the `.vsix`, a new dependency) or what abapfs does on Windows -
PowerShell with .NET `UseDefaultCredentials` lets SSPI do the handshake, and
the resulting `MYSAPSSO2` / `SAP_SESSIONID_*` cookies are kept [16]. Both end
in **cookies**, i.e. in the strategy of 3.1, and the controlled Chromium does
SPNEGO itself for an allow-listed host *(verify)*. **No mechanism of its
own**; revisit only if users ask for a headless Kerberos logon.

### 3.6 Others considered

| Mechanism | Verdict |
| --- | --- |
| On-premise OAuth 2.0 via `SOAUTH2` (`/sap/bc/sec/oauth2/authorize`, `/token`, PKCE, loopback callback) - abapfs has it as `oauth_onprem` [17] | Same strategy class as 3.3 with other endpoints; needs an OAuth client registered on every system. Add later as a variant of `oauth` if asked for |
| Communication user of a communication arrangement (BTP inbound) [14] | Basic auth or certificate of a *technical* user - works today, but every app runs as that user, not the developer; document it, do not build for it |
| `sap-user` / `sap-password` in the launch URL | Already redacted (`redactQueryCredentials`); never a mechanism - it puts the password into URLs, logs and the backend's stored start URL |
| `saml2=disabled` URL parameter to fall back to a logon form [18] | A workaround the system admin may block [19]; never set silently by the extension |
| Assertion tickets / `MYSAPSSO2` issued by a portal | Covered by 3.1 - a cookie is a cookie |

---

## 4. Cross-cutting decisions

**Profile field.** `auth` becomes `"basic" | "browser" | "oauth" |
"certificate"` (T06c accepts only the one it implements). It only chooses;
every secret, every endpoint (UAA URL, certificate) and every cookie is the
user's own, in `context.secrets`. "May only tighten" applied to `auth`: a
workspace's list replaces the user's array, so - like `tightenRoles` - a
`tightenAuth` keeps a non-basic mechanism the user's own scope names for an
origin; a workspace cannot turn a `browser`/`oauth`/`certificate` origin back
into a password prompt *(decide whether that is wanted; the risk it closes is
a repository nudging a user into typing an SSO password into a prompt for an
origin that normally never asks)*.

**No guessing.** A 401 on a `basic` profile never starts a browser; the
message may *name* the profile field ("this system does not offer basic
auth - set `"auth": "browser"` in its profile"), which replaces today's
"set openMode external" once T06d lands.

**Secret keys.** New per-origin keys `abap2ui5.session:`, `abap2ui5.oauth:`,
`abap2ui5.cert:`; *Clear Stored SAP Credentials* deletes all of them for an
origin; the legacy `abap2ui5.user` / `abap2ui5.pass` names stay reserved.

**Redaction (acceptance of T06).** `report.ts`: `cookie` / `set-cookie`
header values, `MYSAPSSO2=` and `SAP_SESSIONID_[^=]*=` pairs, `Bearer` after
any header name, `access_token` / `refresh_token` / `code=` / `client_secret`
in JSON and query strings. The traffic log already logs paths only; it must
stay that way (the OAuth callback path carries the code - it is not proxied,
but the listener must not log it either).

**Hosts.** Desktop only (the web build has no proxy). On a Remote host the
Chromium cannot be shown *(verify)*; OAuth via `asExternalUri` *(verify)*.

---

## 5. Comparison

| | Browser logon (Chromium) | OAuth service key | X.509 file | Kerberos |
| --- | --- | --- | --- | --- |
| Systems served | any SSO: SAML 2.0, SPNEGO, cert-in-browser, form | BTP ABAP Environment (and on-prem `SOAUTH2` later) | on-prem with certificate mapping | on-prem with SPNEGO |
| Secret source | user's IdP logon in a throwaway Chromium | imported service key + browser consent | user-chosen `.p12` | OS ticket |
| Stored | `MYSAPSSO2` (+ session id?) | client id/secret, refresh token | PKCS#12 + passphrase | via `browser` |
| Expiry seen by | 401 / IdP redirect / logon form | `expires_in`, 401 | `notAfter` | via `browser` |
| Renewal | interactive | silent refresh, then interactive | user picks a new file | via `browser` |
| Per request | `Cookie` (merged) | `Authorization: Bearer` | TLS options | via `browser` |
| Interface needs | cookies, `expired`, answer classification | `prepare` (async), `expired`, renew | `tlsOptions` | - |
| New dependency | none (CDP over a pipe, own code) | none | none | none if via `browser` |
| Main risk | domain-wide ticket in secrets | token/code in logs; UAA URL from workspace | identity disclosure only | - |
| Effort | **M** | **M** | **S** | - (or L native) |

---

## 6. Recommendation

1. **Browser logon via the render gate's Chromium (`auth: "browser"`) -
   first, M.** The only candidate that makes *every* SSO-only on-premise
   system work (T06 acceptance: "an SSO-only system runs in the embedded
   preview with the inspector working"); absorbs Kerberos and OS-store
   certificates; no new dependency; the Chromium is already installed and
   started by this extension. Its interface needs (cookies, `expired`, answer
   classification) are the most general, so the others fit behind them.
2. **OAuth with a service key (`auth: "oauth"`) - second, M.** The standard
   BTP ABAP Environment route (abapfs, Eclipse). Second because abap2UI5
   there is a development scenario only [20] and because which host serves the
   HTTP service, and whether it takes the bearer token, is unverified. First
   if the users are mainly on BTP.
3. **X.509 client certificate from a file (`auth: "certificate"`) - third,
   S.** Small, safe, narrow: only where keys are exportable.
4. **Kerberos and the reentrance ticket: no mechanism of their own**; the
   ticket is a BTP add-on to evaluate once a system is available.

**Decided.** The ranking stands - browser logon first, OAuth second,
certificate third - but the implementation starts with the interface of
section 7 and the certificate, because the certificate is the one mechanism
fully testable without a system (a local https server that requires a client
certificate). Session cookies of a browser logon are kept in memory only
(`SAP_SESSIONID_*` and `MYSAPSSO2` alike; nothing under
`abap2ui5.session:` yet). `MYSAPSSO2` is stripped from the answers to the
preview iframe whenever the strategy injects cookies itself. `tightenAuth`
is wanted. No `AuthenticationProvider`. For the certificate, the file PATH
is stored in `globalState` per origin (machine-local, never from a
workspace) and the passphrase in `context.secrets` under
`abap2ui5.cert:<origin>`; the file is read when the proxy starts (the option
"bytes in secrets" of 3.4 was not taken).

What was built (T06c, first part, and T06d): all six interface changes of
section 7 in `authstrategy.ts`, wired into the three request sites of
`proxy.ts`; with `texts` optional and two sentences per verdict (`page`,
`error`) - a strategy without `texts` gets basic's wording, which kept every
existing test unchanged. `strategyFor(profile, origin, deps)` lives in
`logon.ts` (vscode-free) rather than `systems.ts`; its plumbing is
`logonprompt.ts`. A refused client certificate is detected from the
server's TLS alert; under TLS 1.3 the alert can lose the race against the
server's close, and the client then sees a bare reset - reported as a
connection failure, not as a certificate problem.

**What a maintainer must decide**

- the ranking above (browser first vs OAuth first);
- whether depending on the render gate's Chromium for logon is acceptable
  (a ~150 MB download for a logon *(verify size)*), and whether to allow the
  user's own installed Chrome/Edge as an alternative executable (machine-scope
  setting, since it names a program to start);
- store `SAP_SESSIONID_*` in secrets or memory only; strip `MYSAPSSO2` from
  answers to the iframe;
- whether `tightenAuth` is wanted;
- whether to register an `AuthenticationProvider` for the *Accounts* menu;
- who verifies on a real SSO system (T06c cannot - see the ROADMAP note).

---

## 7. Interface changes T06c would make

In `src/authstrategy.ts` (all additive; `BasicAuthStrategy` keeps its
behaviour, every existing proxy test unchanged):

1. `UnauthorizedVerdict = "rejected" | "expired" | "ignore"` - *expired*
   stops forwarding like the breaker but with the strategy's own text and no
   lockout wording.
2. `UnauthorizedAnswer` gains `location?: string` and `contentType?: string`,
   and a new optional `classifyAnswer?(answer & { status; expectsData }):
   "ok" | "expired"` lets a strategy call a 3xx to the IdP or a 200 logon form
   an expiry.
3. `prepare?(signal?: AbortSignal): Promise<void>` - awaited by the proxy
   before every request it sends (single-flight inside the strategy); OAuth
   refreshes here; a strategy that needs the user rejects with an
   `InteractiveLogonRequired` error the hosts map to *Log On Again* / the MCP
   refusal.
4. `requestCookies?(): Record<string, string>` - merged by
   `prepareForwardHeaders` and `fetchFromSystem` into the client's `Cookie`
   header, strategy wins per name; and `takeSetCookie?(name, value): void` for
   the sliding session.
5. `tlsOptions?(): { pfx?: Buffer; cert?: string; key?: string; passphrase?: string }`
   - spread into the request options at the three request sites in
   `proxy.ts`.
6. `readonly texts: { rejected: string; expired: string }` - the two
   basic-auth sentences of the retry breaker (`handle`'s local 401 body,
   `fetchFromSystem`'s rejection) move into `BasicAuthStrategy` verbatim.

Around it: `profileFieldsOf` accepts the new `auth` word; a factory
`strategyFor(profile, origin)` in `systems.ts` replaces the four
`ensureCredentials` + `start(origin, user, pass)` call sites in `launch.ts`;
`clearCredentials` deletes the new keys; `report.ts` redaction as in 4.

---

## Sources

1. SAP Help, ICF logon procedures / standard logon order: https://help.sap.com/saphelp_me60/helpdata/en/48/d18310f6c96745e10000000a421937/content.htm
2. SAP Help, alternative logon order in SICF: https://help.sap.com/saphelp_nw73/helpdata/en/48/c7bf0cda5e31ebe10000000a42189b/content.htm
3. SAP KBA 2573379, adjusting the logon procedure list of an ICF service: https://userapps.support.sap.com/sap/support/knowledge/en/2573379
4. SAP KBA 2721256, reentrance ticket / SSO2 parameters `login/create_sso2_ticket`, `login/accept_sso2_ticket`: https://userapps.support.sap.com/sap/support/knowledge/en/2721256 ; background: https://en.wikipedia.org/wiki/SAP_Logon_Ticket
5. abap-adt-api, `reentranceTicket()` -> `/sap/bc/adt/security/reentranceticket`: https://github.com/marcellourbani/abap-adt-api/blob/master/src/AdtClient.ts
6. abapfs, `ssoLaunch.ts` (ticket only as header or POST to `/sap/public/myssocntl`): https://github.com/marcellourbani/vscode_abap_remote_fs/blob/master/client/src/adt/sapgui/ssoLaunch.ts
7. SAP Community, reentrance ticket on S/4HANA Cloud (`/sap/bc/adt/core/http/reentranceticket`): https://answers.sap.com/questions/13720277/cannot-connect-to-s4hana-cloud-instance-embedded-s.html
8. SAP tutorial, ADT logon to ABAP Environment ("Open Logon Page in Browser"): https://developers.sap.com/tutorials/abap-s4hanacloud-login
9. SAP KBA 3688834 ("Copy Logon URL to Clipboard"): https://userapps.support.sap.com/sap/support/knowledge/en/3688834
10. SAP Community, testing ABAP Environment APIs with OAuth 2.0: https://groups.community.sap.com/t5/technology-blogs-by-sap/manually-testing-sap-btp-abap-environment-apis-with-postman-using-oauth-2-0/bc-p/13556446
11. adt-cli authentication (service key fields, browser SSO with a controlled browser): https://adt-cli.netlify.app/getting-started/auth
12. abapfs, `oauth.ts` (authorization code via `abap_cloud_platform`, refresh token in the vault): https://github.com/marcellourbani/vscode_abap_remote_fs/blob/master/client/src/oauth/oauth.ts
13. abapfs connection manager (Basic, BTP Service Key, BTP Endpoint, OAuth): https://marcellourbani.github.io/vscode_abap_remote_fs/getting-started/connection-manager/
14. SAP tutorial, HTTP service in the ABAP Environment: https://developers.sap.com/tutorials/abap-environment-create-http-service
15. abapfs, `auth/certificate.ts` (CERTRULE/STRUST mapping) and `auth/types.ts` (basic, cert, kerberos, browser_sso, oauth_onprem): https://github.com/marcellourbani/vscode_abap_remote_fs/tree/master/client/src/auth
16. abapfs, `auth/kerberos.ts` (PowerShell/SSPI, cookies captured): same folder as 15
17. abapfs, `auth/oauthOnPrem.ts` (`SOAUTH2`, PKCE, loopback callback): same folder as 15
18. SAP Help, disabling SAML 2.0 authentication (`saml2=disabled`): https://help.sap.com/saphelp_me60/helpdata/en/3c/88d43713bf40ff98ca4795f40cedd4/content.htm
19. SAP KBA 3152577, blocking URLs at ICM / Web Dispatcher: https://userapps.support.sap.com/sap/support/knowledge/en/3152577
20. abap2UI5 docs, S/4 Public Cloud and BTP ABAP Environment (endpoint needs S_DEVELOP, not for productive use): https://abap2ui5.github.io/docs/configuration/s4_public_cloud.html
