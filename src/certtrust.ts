/*
 * Certificate trust per system - `vscode`-free.
 *
 * The auth proxy puts the SAP credentials on every request it forwards, so
 * whether it believes the certificate of the host it talks to is the one
 * decision that must not be made by accident. It used to be one global
 * switch, on by default: no certificate was verified anywhere.
 *
 * Now there are three stances, decided per ORIGIN:
 *
 * - the certificate verifies against the trust store -> it is trusted, and
 *   nobody is asked anything;
 * - it does not, and the user has reviewed and pinned exactly this
 *   certificate for exactly this origin -> the connection is made with
 *   verification off, and the peer's SHA-256 fingerprint is compared with the
 *   pin on EVERY connection, before anything is sent;
 * - it does not, and there is no pin -> nothing is sent. An interactive flow
 *   (F9, "Check System Connection") shows the certificate and asks once; a
 *   flow without a UI of its own (the MCP tools) refuses and says where to
 *   answer the question.
 *
 * `abap2ui5.allowUnauthorizedCerts` stays as the blanket override above all
 * of this: explicitly `true`, every certificate of every system is accepted
 * and nobody is asked - the behaviour before pins existed.
 *
 * This module holds the decision, the pin bookkeeping, the wording and the
 * one probe that reads a certificate without sending a request. The modal
 * and the `globalState` plumbing live in `certprompt.ts`.
 */

import * as tls from "tls";
import { URL } from "url";

/** What a presented certificate means for the origin it was presented by. */
export type TrustAnswer =
  /** Verified against the trust store (chain and hostname). */
  | "trusted"
  /** Not verifiable, but exactly the certificate the user pinned. */
  | "pinned-match"
  /** Not verifiable, and NOT the certificate the user pinned. */
  | "pinned-mismatch"
  /** Not verifiable, and nobody has been asked about it yet. */
  | "unknown";

/** What a TLS handshake said about the peer - all the decision needs. */
export interface PeerCertificate {
  /** Whether Node verified chain and hostname against the trust store. */
  authorized: boolean;
  /** Why it did not, as Node's code (`DEPTH_ZERO_SELF_SIGNED_CERT`, ...). */
  authorizationError?: string;
  /** SHA-256 fingerprint of the leaf certificate, in any spelling. */
  fingerprint256: string;
  subject?: string;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
}

/**
 * A fingerprint in the one spelling pins are stored and compared in: upper
 * case hex pairs joined by colons. Node prints them that way, OpenSSL and
 * browsers do not always - and a pin must not stop matching over a colon.
 * Anything that is not 32 bytes of hex is no fingerprint: "".
 */
export function normalizeFingerprint(value: unknown): string {
  const hex = String(value ?? "")
    .replace(/[^0-9a-f]/gi, "")
    .toUpperCase();
  if (hex.length !== 64) {
    return "";
  }
  return hex.match(/../g)!.join(":");
}

/**
 * The decision. A certificate the trust store vouches for is trusted whether
 * or not the origin carries a pin - a pin is an exception to verification,
 * not a second lock in front of a certificate that verifies. Without that
 * verdict only the pin counts, and a peer that presents no usable
 * fingerprint never matches one.
 */
export function decideTrust(
  peer: Pick<PeerCertificate, "authorized" | "fingerprint256">,
  pin: string | undefined
): TrustAnswer {
  if (peer.authorized) {
    return "trusted";
  }
  const pinned = normalizeFingerprint(pin);
  if (!pinned) {
    return "unknown";
  }
  const presented = normalizeFingerprint(peer.fingerprint256);
  return presented && presented === pinned ? "pinned-match" : "pinned-mismatch";
}

/** Whether a request may be sent over a connection with this answer. */
export function mayConnect(answer: TrustAnswer): boolean {
  return answer === "trusted" || answer === "pinned-match";
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

/** The `globalState` key the pins are kept under: per machine, out of reach
 *  of anything a workspace can write. */
export const PINS_STATE_KEY = "abap2ui5.trustedCertificates";

/** Origin -> pinned SHA-256 fingerprint. Machine-local, not secret. */
export type CertificatePins = Record<string, string>;

/** The key an origin is pinned under - scheme, host and port, normalised. */
export function pinKey(origin: string): string | undefined {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whatever was stored, reduced to what a pin map may hold. The store is
 * outside this module's control; an entry that is not an https origin with a
 * SHA-256 fingerprint is dropped rather than half-believed.
 */
export function readPins(stored: unknown): CertificatePins {
  const pins: CertificatePins = {};
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return pins;
  }
  for (const [origin, value] of Object.entries(stored as Record<string, unknown>)) {
    const key = pinKey(origin);
    const fingerprint = normalizeFingerprint(value);
    if (key && fingerprint) {
      pins[key] = fingerprint;
    }
  }
  return pins;
}

/** The pin of one origin, or undefined. */
export function pinFor(pins: CertificatePins, origin: string): string | undefined {
  const key = pinKey(origin);
  return key ? pins[key] : undefined;
}

/** The pins with this origin pinned to this fingerprint - a new map. */
export function withPin(
  pins: CertificatePins,
  origin: string,
  fingerprint: string
): CertificatePins {
  const key = pinKey(origin);
  const normalized = normalizeFingerprint(fingerprint);
  if (!key || !normalized) {
    return { ...pins };
  }
  return { ...pins, [key]: normalized };
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** The two reasons this module refuses a connection, as error codes. Both
 *  start with `CERT_`, which is how the connection check recognises a
 *  certificate problem. */
export type TrustRefusalCode = "CERT_NOT_TRUSTED" | "CERT_PIN_MISMATCH";

/** A connection refused over the certificate, with a message that says what
 *  to do about it. */
export class CertificateTrustError extends Error {
  constructor(
    public readonly code: TrustRefusalCode | string,
    message: string
  ) {
    super(message);
    this.name = "CertificateTrustError";
  }
}

/** Node's error codes for a certificate it would not verify. */
export function isCertificateErrorCode(code: string | undefined): boolean {
  return (
    !!code &&
    (/^(CERT_|ERR_TLS_CERT|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_)/.test(code) ||
      code === "HOSTNAME_MISMATCH")
  );
}

/**
 * The refusal for a certificate nobody has been asked about. It names the
 * two places the question is asked - this text is what an agent, a log line
 * or the preview's error page ends up showing, none of which can ask.
 */
export function untrustedMessage(origin: string, reason?: string): string {
  return (
    `the TLS certificate of ${origin} could not be verified` +
    (reason ? ` (${reason})` : "") +
    " and is not trusted yet - nothing was sent to the system. Run " +
    '"abap2UI5: Check System Connection" or press F9 once in VS Code to ' +
    "review the certificate and trust it for this system."
  );
}

/** The refusal for a pinned origin that presents another certificate. */
export function changedMessage(
  origin: string,
  pinned: string,
  presented: string
): string {
  return (
    `the TLS certificate of ${origin} changed since it was trusted - the ` +
    "connection was refused and nothing was sent to the system. Trusted " +
    `SHA-256 ${normalizeFingerprint(pinned) || "(none)"}, presented ` +
    `${normalizeFingerprint(presented) || "(none)"}. If the system's ` +
    'certificate was renewed, run "abap2UI5: Forget Trusted Certificates" ' +
    "and connect again to review the new one."
  );
}

/**
 * A request error as the caller should see it: a certificate Node refused to
 * verify becomes the refusal that says how to trust it, with Node's code
 * kept (the connection check classifies by it). Everything else passes
 * through untouched.
 */
export function explainTlsError(err: unknown, origin: string): Error {
  if (err instanceof CertificateTrustError) {
    return err;
  }
  const code = (err as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && isCertificateErrorCode(code)) {
    return new CertificateTrustError(code, untrustedMessage(origin, code));
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** The lines of the "trust this certificate?" question - everything a user
 *  can compare against what the system's administrator or a browser shows. */
export function describeCertificate(peer: PeerCertificate): string[] {
  return [
    `Subject: ${peer.subject || "(none)"}`,
    `Issuer: ${peer.issuer || "(none)"}`,
    `Valid: ${peer.validFrom || "?"} - ${peer.validTo || "?"}`,
    `SHA-256 fingerprint: ${normalizeFingerprint(peer.fingerprint256) || "(none)"}`,
    `Why it is not verified: ${peer.authorizationError || "unknown"}`,
  ];
}

// ---------------------------------------------------------------------------
// The live side: reading a certificate off a socket, and off a host
// ---------------------------------------------------------------------------

/** A distinguished name as one line (`CN=host, O=Org`). */
function nameOf(name: unknown): string {
  if (!name || typeof name !== "object") {
    return "";
  }
  return Object.entries(name as Record<string, unknown>)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("+") : String(value)}`)
    .join(", ");
}

/**
 * What a connected TLS socket says about its peer, or undefined while the
 * handshake has not produced a certificate yet.
 */
export function peerOf(socket: tls.TLSSocket): PeerCertificate | undefined {
  const cert = socket.getPeerCertificate() as tls.PeerCertificate | null;
  if (!cert || !cert.fingerprint256) {
    return undefined;
  }
  const error: unknown = socket.authorizationError;
  return {
    authorized: socket.authorized === true,
    authorizationError: error
      ? String((error as { code?: string }).code ?? (error as Error).message ?? error)
      : undefined,
    fingerprint256: cert.fingerprint256,
    subject: nameOf(cert.subject),
    issuer: nameOf(cert.issuer),
    validFrom: cert.valid_from,
    validTo: cert.valid_to,
  };
}

/** How long the certificate probe waits for a handshake. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Reads the certificate an https origin presents - a TLS handshake and
 * nothing else. No request is written, so no credential and no path reaches
 * a host whose certificate is still in question.
 *
 * Rejects when the host cannot be reached or does not finish a handshake;
 * that is the connection's problem, and the caller's ordinary request will
 * report it better than this probe could.
 */
export function probeCertificate(
  origin: string,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<PeerCertificate> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(origin);
    } catch {
      reject(new Error(`${origin} is not a URL`));
      return;
    }
    const host = target.hostname.replace(/^\[(.*)\]$/, "$1");
    const socket = tls.connect({
      host,
      port: Number(target.port) || 443,
      // SNI must be a name; for an IP literal there is none to send
      servername: /^[\d.]+$|:/.test(host) ? undefined : host,
      // verification failures are the ANSWER here, not an error: the
      // handshake completes, `authorized` says what Node thought of it
      rejectUnauthorized: false,
    });
    let settled = false;
    const finish = (err: Error | undefined, peer?: PeerCertificate) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (peer) {
        resolve(peer);
      } else {
        reject(err ?? new Error("no certificate"));
      }
    };
    const timer = setTimeout(
      () => finish(new Error("the TLS handshake timed out")),
      timeoutMs
    );
    socket.once("secureConnect", () => {
      const peer = peerOf(socket);
      finish(peer ? undefined : new Error("the host presented no certificate"), peer);
    });
    socket.once("error", (err) => finish(err));
  });
}
