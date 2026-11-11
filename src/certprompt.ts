import * as vscode from "vscode";
import {
  CertificatePins,
  changedMessage,
  decideTrust,
  describeCertificate,
  PeerCertificate,
  pinFor,
  PINS_STATE_KEY,
  probeCertificate,
  readPins,
  TrustRefusalCode,
  untrustedMessage,
  withPin,
} from "./certtrust";
import { ALLOW_UNAUTHORIZED_KEY, CONFIG_SECTION, Session } from "./session";
import { plural } from "./text";

/*
 * The plumbing around `certtrust.ts`: where the pins are kept, the one modal
 * that asks about a certificate, and the command that forgets the answers.
 *
 * Pins live in `globalState`: per machine, not synced, and out of reach of
 * anything a workspace can write - a cloned repository can neither add a pin
 * nor read one. They are not secret (a fingerprint is public by nature).
 */

/** The stored pins, reduced to what a pin map may hold. */
export function certificatePins(context: vscode.ExtensionContext): CertificatePins {
  return readPins(context.globalState.get<unknown>(PINS_STATE_KEY));
}

/** Whether the blanket override is on - read from the user's settings only
 *  (the setting is machine scope). */
function acceptsEverything(): boolean {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<boolean>(ALLOW_UNAUTHORIZED_KEY, false);
}

/** Why a connection must not be made - or that it may. */
export type TrustOutcome =
  | { trusted: true }
  | { trusted: false; code: TrustRefusalCode; message: string };

const TRUST = "Trust This Certificate";
const FORGET = "Forget Trusted Certificates";

async function askAboutCertificate(
  origin: string,
  peer: PeerCertificate
): Promise<boolean> {
  const pick = await vscode.window.showWarningMessage(
    `abap2UI5: the TLS certificate of ${origin} cannot be verified. Trust it for this system?`,
    {
      modal: true,
      detail:
        describeCertificate(peer).join("\n") +
        "\n\nNothing has been sent to the system yet. Trust the certificate " +
        "only if you expect this system to use a self-signed or " +
        "private-CA certificate - ideally after comparing the fingerprint " +
        "with the one your administrator or a browser shows. It is then " +
        "accepted for this system only, and refused if it ever changes.",
    },
    TRUST
  );
  return pick === TRUST;
}

/**
 * Decides, BEFORE any request, whether the system at `origin` may be
 * connected to - asking the user about an unverifiable certificate when the
 * flow is interactive, refusing when it is not.
 *
 * - plain http, or the blanket override: nothing to decide.
 * - verified by the trust store: trusted, remembered for the session so a
 *   public-CA system costs one extra handshake per window, never a prompt.
 * - unverifiable and pinned: trusted while the pin matches; a different
 *   certificate is refused. (The proxy compares again on every connection -
 *   this look only turns the refusal into a message before the launch.)
 * - unverifiable and unknown: the modal when `interactive`, else a refusal
 *   that names the two commands that ask.
 *
 * A host that cannot be probed at all is let through: the request that
 * follows fails the same way and is reported by the path that owns it, and
 * the proxy verifies whatever this function did not.
 */
export async function ensureCertificateTrust(
  session: Session,
  origin: string,
  options: { interactive: boolean }
): Promise<TrustOutcome> {
  if (!/^https:/i.test(origin) || acceptsEverything()) {
    return { trusted: true };
  }
  const pin = pinFor(certificatePins(session.ctx), origin);
  if (!pin && session.verifiedOrigins.has(origin)) {
    return { trusted: true };
  }
  let peer: PeerCertificate;
  try {
    peer = await probeCertificate(origin);
  } catch {
    return { trusted: true };
  }
  const answer = decideTrust(peer, pin);
  if (answer === "trusted") {
    session.verifiedOrigins.add(origin);
    return { trusted: true };
  }
  if (answer === "pinned-match") {
    return { trusted: true };
  }
  if (answer === "pinned-mismatch") {
    const message = changedMessage(origin, pin ?? "", peer.fingerprint256);
    session.log(`certificate: ${message}`);
    return { trusted: false, code: "CERT_PIN_MISMATCH", message };
  }
  const refusal: TrustOutcome = {
    trusted: false,
    code: "CERT_NOT_TRUSTED",
    message: untrustedMessage(origin, peer.authorizationError),
  };
  if (!options.interactive) {
    session.log(`certificate: ${refusal.message}`);
    return refusal;
  }
  if (!(await askAboutCertificate(origin, peer))) {
    session.log(`certificate: ${origin} was not trusted - nothing was sent`);
    return refusal;
  }
  // re-read: another window may have pinned something in the meantime
  await session.ctx.globalState.update(
    PINS_STATE_KEY,
    withPin(certificatePins(session.ctx), origin, peer.fingerprint256)
  );
  session.log(
    `certificate: ${origin} trusted (SHA-256 ${peer.fingerprint256}) - ` +
      "pinned for this system"
  );
  return { trusted: true };
}

/** Tells the user about a refusal the flow cannot recover from. A declined
 *  question needs no second message - the user just answered it. */
export function reportTrustRefusal(outcome: TrustOutcome): void {
  if (outcome.trusted || outcome.code !== "CERT_PIN_MISMATCH") {
    return;
  }
  void vscode.window
    .showErrorMessage(`abap2UI5: ${outcome.message}`, { modal: true }, FORGET)
    .then((pick) => {
      if (pick === FORGET) {
        void vscode.commands.executeCommand("abap2ui5.forgetTrustedCertificates");
      }
    });
}

/** "abap2UI5: Forget Trusted Certificates" - drops every pin. The next
 *  connection to a system with an unverifiable certificate asks again. */
export async function forgetTrustedCertificates(session: Session): Promise<void> {
  const count = Object.keys(certificatePins(session.ctx)).length;
  await session.ctx.globalState.update(PINS_STATE_KEY, undefined);
  session.log(`certificate: ${plural(count, "trusted certificate")} forgotten`);
  vscode.window.showInformationMessage(
    count
      ? `abap2UI5: ${plural(count, "trusted certificate")} forgotten - a ` +
          "system whose certificate cannot be verified asks again on the " +
          "next connection."
      : "abap2UI5: no certificate was trusted - nothing to forget."
  );
}
