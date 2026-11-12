/*
 * The connection check's decisions - `vscode`-free, so what a probe MEANS is
 * covered by the test suite. The plumbing that actually asks the system lives
 * in `launch.ts` and goes through the same proxy the preview loads through
 * (`fetchFromSystem`), so the diagnosis describes the requests a launch
 * really makes rather than a second HTTP stack's.
 *
 * Why this exists: the biggest first-run failure is a launch URL that is
 * slightly wrong, and its symptom is the least helpful one possible - a white
 * preview. Which of the things between F9 and a rendered app went wrong (the
 * URL's shape, DNS, the port, TLS, the logon, the ICF path, the page itself)
 * is exactly what the white rectangle does not say. This module says it, one
 * step at a time, with the fix next to the finding.
 */

import { URL } from "url";
import { shortUrl } from "./urls";
import { isClientCertificateRefusal } from "./clientcert";

/** One probe of the check: what was looked at, what was found, what fixes it. */
export interface CheckStep {
  /** Which probe this is - "Launch URL", "Host reachable", ... */
  label: string;
  ok: boolean;
  /** What was found, one sentence. */
  detail: string;
  /** The action that fixes a failed step - always set when `ok` is false. */
  fix?: string;
}

// ---------------------------------------------------------------------------
// Step 1: the launch URL itself
// ---------------------------------------------------------------------------

/** Whether the configured template can launch anything at all - before any
 *  network is touched, because a URL that does not parse fails silently as a
 *  white frame, never as a message. */
export function checkTemplate(template: string): CheckStep {
  const label = "Launch URL";
  const trimmed = template.trim();
  if (!trimmed) {
    return {
      label,
      ok: false,
      detail: "no launch URL is configured",
      fix:
        'Run "abap2UI5: Set Launch URL" - e.g. ' +
        "https://host:44300/sap/bc/z2ui5?app_start={class}&sap-client=100.",
    };
  }
  if (!/\{class\}/i.test(trimmed)) {
    return {
      label,
      ok: false,
      detail: "the launch URL has no {class} placeholder",
      fix:
        "Put {class} where the app class belongs, usually " +
        "?app_start={class} - without it every launch opens the same URL.",
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      label,
      ok: false,
      detail: "the launch URL does not parse as a URL",
      fix:
        "It needs a scheme and a host, e.g. " +
        "https://host:44300/sap/bc/z2ui5?app_start={class}.",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      label,
      ok: false,
      detail: `the scheme is ${parsed.protocol.replace(/:$/, "")}, not http or https`,
      fix: "Use the URL exactly as a browser would open it, scheme included.",
    };
  }
  return {
    label,
    ok: true,
    detail: `${shortUrl(trimmed)} parses and carries the {class} placeholder`,
  };
}

// ---------------------------------------------------------------------------
// Step 2: was the host reachable at all (DNS / TCP / TLS)
// ---------------------------------------------------------------------------

/** The step a SUCCESSFUL connection reports - the failure shapes are below. */
export function reachedStep(origin: string): CheckStep {
  return { label: "Host reachable", ok: true, detail: `connected to ${origin}` };
}

/**
 * What a failed connection attempt means. The interesting part is the error
 * CODE - Node says precisely whether DNS, TCP or TLS gave up, and each of the
 * three has a different fix.
 */
export function describeConnectFailure(failure: {
  code?: string;
  message?: string;
  /** The profile's logon mechanism - a refused client certificate means
   *  something else for a certificate profile than for a basic one. */
  auth?: string;
}): CheckStep {
  const label = "Host reachable";
  const code = failure.code ?? "";
  const message = failure.message ?? "connection failed";
  if (isClientCertificateRefusal(code, message)) {
    return {
      label: "Client certificate",
      ok: false,
      detail:
        failure.auth === "certificate"
          ? "the system refused the client certificate in the TLS handshake - nothing was sent"
          : "the system requires a client certificate in the TLS handshake",
      fix:
        failure.auth === "certificate"
          ? "Check that the certificate is issued by a CA the system trusts " +
            "(STRUST) and has not expired, or choose another one with " +
            '"abap2UI5: Choose Client Certificate".'
          : 'This system logs on with a client certificate: set "auth": ' +
            '"certificate" in its abap2ui5.systems entry and choose one with ' +
            '"abap2UI5: Choose Client Certificate".',
    };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      label,
      ok: false,
      detail: "the hostname does not resolve (DNS)",
      fix:
        "Check the host in the launch URL for typos, and whether this " +
        "machine can see it at all - a VPN that is not connected looks " +
        "exactly like this.",
    };
  }
  if (code === "ECONNREFUSED") {
    return {
      label,
      ok: false,
      detail: "the host answered, but nothing listens on that port",
      fix:
        "Check the port in the launch URL against one that works in a " +
        "normal browser - 44300 is the usual HTTPS ICM port, and SMICM " +
        "shows the real ones.",
    };
  }
  if (
    code === "ETIMEDOUT" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    /timed out/i.test(message)
  ) {
    return {
      label,
      ok: false,
      detail: "the connection attempt timed out",
      fix:
        "The host does not answer from here - typically a VPN that is not " +
        "connected, or a firewall between this machine and the system.",
    };
  }
  if (code === "CERT_PIN_MISMATCH") {
    return {
      label,
      ok: false,
      detail:
        "the system presents a different TLS certificate than the one that " +
        "was trusted for it - nothing was sent",
      fix:
        "If the certificate was renewed, run \"abap2UI5: Forget Trusted " +
        "Certificates\" and check again to review the new one. If nobody " +
        "changed it, something sits between this machine and the system.",
    };
  }
  if (/^(CERT_|ERR_TLS_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|ERR_SSL)/.test(code) ||
    code === "HOSTNAME_MISMATCH"
  ) {
    return {
      label,
      ok: false,
      detail:
        code === "CERT_NOT_TRUSTED"
          ? "the TLS certificate cannot be verified and was not trusted - nothing was sent"
          : `the TLS certificate was rejected (${code})`,
      fix:
        "For a dev system with a self-signed certificate, run this check " +
        "(or press F9) again and choose \"Trust This Certificate\" - it is " +
        "then accepted for this system only. For a system that should have " +
        "a valid certificate, fix the trust chain instead. " +
        "abap2ui5.allowUnauthorizedCerts accepts every certificate of every " +
        "system, unasked.",
    };
  }
  if (code === "EPROTO") {
    return {
      label,
      ok: false,
      detail: "the port does not speak the expected protocol",
      fix:
        "https:// against a plain-HTTP port fails like this (and the other " +
        "way round) - check that scheme and port belong together.",
    };
  }
  return {
    label,
    ok: false,
    detail: message,
    fix:
      "The system could not be reached - compare the launch URL with one " +
      "that works in a normal browser.",
  };
}

// ---------------------------------------------------------------------------
// Step 3: what the HTTP status means
// ---------------------------------------------------------------------------

/**
 * The meaning of the status the system answered with. 401/403/404 each have
 * ONE likely cause on an ABAP system, and naming it is the whole point - a
 * beginner cannot tell "wrong password" from "ICF node inactive" through a
 * white iframe.
 */
export function classifyStatus(answer: {
  status: number;
  /** The system path that was asked for - the 404 hint quotes it. */
  path: string;
  /** The WWW-Authenticate header of a 401, when the system sent one. */
  authenticate?: string;
  /** The rejection page's own sentence, when there is one. */
  reason?: string;
  /** The profile's logon mechanism (`auth`); absent means basic. */
  auth?: string;
}): CheckStep {
  const label = "HTTP status";
  const certificate = answer.auth === "certificate";
  const { status, path } = answer;
  const said = answer.reason ? ` The system says: "${answer.reason}".` : "";
  if (status >= 200 && status < 300) {
    return { label, ok: true, detail: `the system answered ${status}` };
  }
  if ((status === 401 || (status >= 300 && status < 400)) && answer.auth === "browser") {
    return {
      label,
      ok: false,
      detail:
        status === 401
          ? "the system did not accept the browser logon (401)." + said
          : `the system redirects (${status}) to its logon instead of serving the page`,
      fix:
        "The session of the browser logon has run out, or it was made for " +
        "another client than the sap-client of the launch URL. Run " +
        '"abap2UI5: Log On in Browser" (or this check again) and finish the ' +
        "logon in the browser window.",
    };
  }
  if (status === 401 && certificate) {
    return {
      label,
      ok: false,
      detail:
        "the system did not log on with the client certificate (401)." + said,
      fix:
        "The certificate reached the system but is not mapped to a user " +
        "there (rule-based mapping in CERTRULE, or table USREXTID), or the " +
        "ICF node does not accept certificate logon - or a load balancer in " +
        "front terminates TLS and drops it. " +
        '"abap2UI5: Choose Client Certificate" picks another one.',
    };
  }
  if (status === 401) {
    if (!answer.authenticate) {
      return {
        label,
        ok: false,
        detail:
          "401 without a WWW-Authenticate header - the system is not " +
          "asking for a password." + said,
        fix:
          "This service does not offer basic authentication, so no stored " +
          "password can help. If it logs you on with a client certificate, " +
          'set "auth": "certificate" in its abap2ui5.systems entry. ' +
          'Otherwise set abap2ui5.openMode to "external" to reuse ' +
          "your browser logon (SSO), or allow basic auth on the ICF node.",
      };
    }
    return {
      label,
      ok: false,
      detail: "the system rejected the stored logon (401)." + said,
      fix:
        'Re-enter user and password ("abap2UI5: Clear Stored SAP ' +
        'Credentials", then run again) - and mind the sap-client in the ' +
        "launch URL: without one the logon goes to the default client.",
    };
  }
  if (status === 403) {
    return {
      label,
      ok: false,
      detail: "the system refuses the request (403)." + said,
      fix:
        "The user lacks an authorization for this service, or the ICF node " +
        "refuses logons in this client - SU53 right after a try shows the " +
        "missing authorization.",
    };
  }
  if (status === 404) {
    return {
      label,
      ok: false,
      detail: `nothing is served at ${path} (404)`,
      fix:
        "The ICF path of the launch URL does not exist or is inactive on " +
        "this system. In transaction SICF, find and activate the abap2UI5 " +
        "service (default: /sap/bc/z2ui5), and make the path in the launch " +
        "URL match it exactly.",
    };
  }
  if (status >= 300 && status < 400 && certificate) {
    return {
      label,
      ok: false,
      detail: `the system redirects (${status}) instead of serving the page`,
      fix:
        "Usually a redirect to a logon page: the client certificate did not " +
        "log on - it is not mapped to a user, or the ICF node's logon " +
        "procedure does not include certificates.",
    };
  }
  if (status >= 300 && status < 400) {
    return {
      label,
      ok: false,
      detail: `the system redirects (${status}) instead of serving the page`,
      fix:
        "Usually a redirect to a logon page: the service wants form-based " +
        "logon or SSO rather than basic authentication. If it logs you on " +
        'with a client certificate, set "auth": "certificate" in its ' +
        'abap2ui5.systems entry; otherwise set abap2ui5.openMode to ' +
        '"external" to reuse the browser session, or switch the ICF ' +
        "node's logon procedure.",
    };
  }
  if (status >= 500) {
    return {
      label,
      ok: false,
      detail:
        `the system answered ${status} - the request arrived and the ` +
        "server failed handling it." + said,
      fix:
        "URL, host and logon are fine; check ST22 on the system for the " +
        "dump behind this answer.",
    };
  }
  return {
    label,
    ok: false,
    detail: `the system answered ${status}`,
    fix: "Unexpected answer - open the launch URL in a normal browser to see it.",
  };
}

// ---------------------------------------------------------------------------
// Step 3b: does the sap-client change the answer
// ---------------------------------------------------------------------------

/**
 * What it means when the same probe answers differently with and without the
 * launch URL's `sap-client`. Credentials live per client, so "valid in 100,
 * invalid in the default client" is a real and confusing state: the launch
 * works while every request that forgets the parameter is rejected - or the
 * other way round, which points at a wrong `sap-client` in the URL. Nothing
 * worth a step when the two answers agree, or when the URL names no client.
 */
export function classifyClientProbe(probe: {
  /** The `sap-client` the launch URL carries. */
  sapClient: string;
  /** Status of the probe WITH that client - what the launch experiences. */
  withClient: number;
  /** Status of the probe WITHOUT it - what the default client says. */
  withoutClient: number;
}): CheckStep | undefined {
  const label = "sap-client";
  const { sapClient, withClient, withoutClient } = probe;
  const rejected = (status: number) => status === 401 || status === 403;
  if (rejected(withClient) && !rejected(withoutClient)) {
    return {
      label,
      ok: false,
      detail:
        `the logon is rejected in client ${sapClient} but not in the ` +
        "system's default client",
      fix:
        "The stored user does not work in this client - check the " +
        "sap-client in the launch URL, or use credentials valid there.",
    };
  }
  if (!rejected(withClient) && rejected(withoutClient)) {
    return {
      label,
      ok: true,
      detail:
        `the logon works only with sap-client=${sapClient} - the default ` +
        `client answers ${withoutClient}, so requests without the ` +
        "parameter are rejected",
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Step 4: is the 200 actually an abap2UI5 page
// ---------------------------------------------------------------------------

/**
 * Whether a 200 answer is the page a launch needs. A 200 that is NOT the
 * abap2UI5 bootstrap is the sneakiest white preview of all: every earlier
 * step passes, and only the page itself says the URL points somewhere else.
 */
/** Whether an HTML answer is the SAP logon page (the ICF form) rather than
 *  an app - shared by `classifyBody` and the browser logon (`browserlogon.ts`),
 *  which waits for the first answer that is not it. */
export function looksLikeLogonPage(body: string): boolean {
  return /sap-system-login|logonForm|SL__FORM/i.test(body);
}

export function classifyBody(body: string, auth?: string): CheckStep {
  const label = "Page content";
  const ui5Bootstrap = /sap-ui-bootstrap|sap-ui-core\.js/i.test(body);
  if (ui5Bootstrap && /abap2ui5|z2ui5/i.test(body)) {
    return { label, ok: true, detail: "the answer is an abap2UI5 bootstrap page" };
  }
  if (looksLikeLogonPage(body)) {
    return {
      label,
      ok: false,
      detail: "the answer is the SAP logon page, not the app",
      fix:
        auth === "certificate"
          ? "The service did not log on with the client certificate and fell " +
            "back to its form - the certificate is not mapped to a user in " +
            "this client, or the node does not accept certificate logon. " +
            "Check the sap-client in the launch URL too."
          : "The service did not accept the logon and fell back to its form. " +
            'Check user and password ("abap2UI5: Clear Stored SAP Credentials" ' +
            "asks again) and the sap-client in the launch URL.",
    };
  }
  if (ui5Bootstrap) {
    return {
      label,
      ok: true,
      detail:
        "the answer is a UI5 bootstrap page (no abap2UI5 marker found - if " +
        "the preview stays empty, check that the path is abap2UI5's service)",
    };
  }
  if (!body.trim()) {
    return {
      label,
      ok: false,
      detail: "the answer is empty",
      fix:
        "The service answered 200 with nothing in it - the path probably " +
        "names an ICF node without abap2UI5's handler. Point the launch URL " +
        "at the z2ui5 service (default /sap/bc/z2ui5).",
    };
  }
  return {
    label,
    ok: false,
    detail: "the answer is not an abap2UI5 page",
    fix:
      "Something else is served at this path. Point the launch URL at the " +
      "ICF service of abap2UI5's HTTP handler, usually " +
      "/sap/bc/z2ui5?app_start={class}.",
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** Path plus query of a URL - what `fetchFromSystem` is given to ask for. */
export function pathAndQueryOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return undefined;
  }
}

/** The step the summary message is about - checks stop at the first failure,
 *  so this is also the LAST step taken when anything went wrong. */
export function firstFailure(steps: CheckStep[]): CheckStep | undefined {
  return steps.find((step) => !step.ok);
}

/** The stepwise report as log lines - pass/FAIL per step, the fix indented
 *  under the step it belongs to. */
export function renderReport(steps: CheckStep[]): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    lines.push(`${step.ok ? "pass" : "FAIL"}  ${step.label}: ${step.detail}`);
    if (step.fix) {
      lines.push(`      fix: ${step.fix}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The proxy's warning about a refused logon
// ---------------------------------------------------------------------------

/**
 * What the warning about a refused or expired logon says, and what it
 * offers - by the mechanism the proxy logs on with (T06d: no "openMode
 * external" for a system whose profile names a mechanism of its own).
 */
export function relogonOffer(
  kind: string,
  status: number,
  said: string,
  expired: boolean,
  offeredBasic: boolean
): { message: string; button: string } {
  if (expired && kind === "browser") {
    return {
      message:
        `abap2UI5: the browser logon to the system has expired (HTTP ${status})${said}. ` +
        "Log on again in the browser window that opens.",
      button: "Log On Again",
    };
  }
  if (expired) {
    return {
      message: `abap2UI5: the logon to the system has expired (HTTP ${status})${said}.`,
      button: "Log On Again",
    };
  }
  if (kind === "certificate") {
    return {
      message:
        `abap2UI5: the system did not accept the client certificate (HTTP ${status})${said}. ` +
        "It is not mapped to a user there, or the service does not accept certificate logon.",
      button: "Choose Client Certificate",
    };
  }
  return {
    message:
      `abap2UI5: the system rejected the logon (HTTP ${status})${said}.` +
      (offeredBasic
        ? " The stored user or password may be wrong."
        : " The stored user or password may be wrong, or this system does " +
          'not accept basic auth - if it logs on with a client certificate, set "auth": ' +
          '"certificate" in its abap2ui5.systems entry, otherwise set ' +
          'abap2ui5.openMode to "external".'),
    button: "Re-enter Credentials",
  };
}
