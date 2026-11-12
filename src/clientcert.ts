import { X509Certificate } from "crypto";
import { createSecureContext } from "tls";
import type { ClientCertificateMaterial } from "./authstrategy";

/*
 * clientcert - the X.509 client certificate of `auth: "certificate"`, as data.
 *
 * `vscode`-free. The user chooses the certificate per origin (a `.pfx`/`.p12`
 * file, or a PEM certificate plus its key); what is remembered is the FILE
 * PATH, in `globalState` per origin - machine-local, never a setting a
 * workspace could write - and the passphrase, in the SecretStorage. The file
 * itself is read when the proxy starts (`loadClientCertificate`), so a
 * renewed file at the same path is picked up by the next F9.
 *
 * Here: the shape of the remembered choice (read tolerantly - `globalState`
 * outlives versions), loading and checking the files (passphrase, key match,
 * expiry), and the wording of every refusal.
 */

/** Where the certificate of one origin lives. */
export type ClientCertificateChoice =
  | { kind: "pfx"; path: string }
  | { kind: "pem"; cert: string; key: string };

/** The `globalState` key of the choices, a map origin -> choice. */
export const CLIENT_CERTIFICATES_KEY = "abap2ui5.clientCertificates";

/** Warn about a certificate that expires within this many days. */
export const EXPIRY_WARNING_DAYS = 14;

/** A certificate that cannot be used - with a message the user can act on. */
export class ClientCertificateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientCertificateError";
  }
}

/** One remembered choice, or undefined for anything that is not one. */
export function choiceFrom(value: unknown): ClientCertificateChoice | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const text = (key: string) =>
    typeof raw[key] === "string" && (raw[key] as string).trim() ? (raw[key] as string) : undefined;
  if (raw.kind === "pfx" && text("path")) {
    return { kind: "pfx", path: text("path")! };
  }
  if (raw.kind === "pem" && text("cert") && text("key")) {
    return { kind: "pem", cert: text("cert")!, key: text("key")! };
  }
  return undefined;
}

/** The choice remembered for `origin` in the stored map. */
export function choiceFor(map: unknown, origin: string): ClientCertificateChoice | undefined {
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return undefined;
  }
  return choiceFrom((map as Record<string, unknown>)[origin]);
}

/** The stored map with `origin`'s choice set - or removed, for undefined. */
export function withChoice(
  map: unknown,
  origin: string,
  choice: ClientCertificateChoice | undefined
): Record<string, ClientCertificateChoice> {
  const next: Record<string, ClientCertificateChoice> = {};
  if (map && typeof map === "object" && !Array.isArray(map)) {
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      const kept = choiceFrom(value);
      if (kept) {
        next[key] = kept;
      }
    }
  }
  if (choice) {
    next[origin] = choice;
  } else {
    delete next[origin];
  }
  return next;
}

/** What a picked file is: a PKCS#12 bundle by its extension, else PEM. */
export function isPkcs12Path(path: string): boolean {
  return /\.(pfx|p12)$/i.test(path);
}

/** The choice in one line, for a log or a message - paths only. */
export function describeChoice(choice: ClientCertificateChoice): string {
  return choice.kind === "pfx" ? choice.path : `${choice.cert} (key ${choice.key})`;
}

export interface LoadedClientCertificate {
  material: ClientCertificateMaterial;
  /** `notAfter` of the certificate, when it could be read. */
  validTo?: Date;
  /** The subject, for a log line (`CN=...`) - no secret. */
  subject?: string;
  /** A warning to show - the certificate expires soon. */
  warning?: string;
}

/**
 * Reads the chosen files and checks that they make a usable certificate:
 * the passphrase opens it, certificate and key belong together, and it has
 * not expired. Throws a {@link ClientCertificateError} that says which of
 * those failed - before anything is sent to the system.
 */
export async function loadClientCertificate(
  choice: ClientCertificateChoice,
  passphrase: string | undefined,
  readFile: (path: string) => Promise<Buffer>,
  now: Date = new Date()
): Promise<LoadedClientCertificate> {
  const read = async (path: string): Promise<Buffer> => {
    try {
      return await readFile(path);
    } catch (err) {
      throw new ClientCertificateError(
        `the client certificate file ${path} cannot be read (${
          (err as { code?: string })?.code ?? (err instanceof Error ? err.message : String(err))
        }) - choose it again with "abap2UI5: Choose Client Certificate"`
      );
    }
  };
  const pass = passphrase || undefined;
  let material: ClientCertificateMaterial;
  if (choice.kind === "pfx") {
    material = { pfx: await read(choice.path), passphrase: pass };
  } else {
    material = {
      cert: (await read(choice.cert)).toString("utf8"),
      key: (await read(choice.key)).toString("utf8"),
      passphrase: pass,
    };
  }

  let der: Buffer | undefined;
  try {
    const context = createSecureContext(material) as unknown as {
      context?: { getCertificate?: () => Buffer | null };
    };
    // not public API: read when it is there, the expiry check is skipped when not
    der = context.context?.getCertificate?.() ?? undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/mac verify failure|bad decrypt|bad password|interrupted or cancelled/i.test(message)) {
      throw new ClientCertificateError(
        "the passphrase does not open the client certificate - choose it again " +
          'with "abap2UI5: Choose Client Certificate" and enter the passphrase'
      );
    }
    if (/key values mismatch/i.test(message)) {
      throw new ClientCertificateError(
        "the private key does not belong to the client certificate - choose " +
          'the matching pair with "abap2UI5: Choose Client Certificate"'
      );
    }
    throw new ClientCertificateError(
      `the client certificate cannot be used (${message}) - choose a ` +
        '.pfx/.p12 file or a PEM certificate and key with "abap2UI5: Choose Client Certificate"'
    );
  }

  let certificate: X509Certificate | undefined;
  try {
    certificate = der
      ? new X509Certificate(der)
      : choice.kind === "pem"
        ? new X509Certificate((material as { cert: string }).cert)
        : undefined;
  } catch {
    certificate = undefined;
  }
  if (!certificate) {
    return { material };
  }
  const validTo = new Date(certificate.validTo);
  const validFrom = new Date(certificate.validFrom);
  const subject = certificate.subject.replace(/\n/g, ", ");
  if (validTo.getTime() <= now.getTime()) {
    throw new ClientCertificateError(
      `the client certificate (${subject}) expired on ${validTo.toISOString().slice(0, 10)} - ` +
        'choose a current one with "abap2UI5: Choose Client Certificate"'
    );
  }
  if (validFrom.getTime() > now.getTime()) {
    throw new ClientCertificateError(
      `the client certificate (${subject}) is not valid before ` +
        `${validFrom.toISOString().slice(0, 10)}`
    );
  }
  const daysLeft = Math.floor((validTo.getTime() - now.getTime()) / 86_400_000);
  return {
    material,
    validTo,
    subject,
    warning:
      daysLeft < EXPIRY_WARNING_DAYS
        ? `the client certificate (${subject}) expires on ${validTo
            .toISOString()
            .slice(0, 10)} - ` + "renew it soon"
        : undefined,
  };
}

/**
 * Whether a TLS error is the SYSTEM refusing the client side of the handshake
 * - it wants a client certificate, or does not accept the one presented.
 * These are the alerts a server sends (`ERR_SSL_..._ALERT_...`); a server
 * certificate this side cannot verify is `certtrust.ts`'s business.
 */
export function isClientCertificateRefusal(code: string | undefined, message = ""): boolean {
  return (
    /ALERT_(CERTIFICATE_REQUIRED|BAD_CERTIFICATE|UNKNOWN_CA|CERTIFICATE_UNKNOWN|CERTIFICATE_EXPIRED|CERTIFICATE_REVOKED|UNSUPPORTED_CERTIFICATE|ACCESS_DENIED|HANDSHAKE_FAILURE)/.test(
      code ?? ""
    ) || /alert (certificate required|bad certificate|unknown ca|certificate unknown)/i.test(message)
  );
}

/**
 * The sentence for such a refusal: what the system did and what to change,
 * by the mechanism the profile names. Undefined for any other error.
 */
export function clientCertificateRefusal(
  err: unknown,
  host: string,
  authKind: string | undefined
): string | undefined {
  const code = (err as { code?: unknown } | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (!isClientCertificateRefusal(typeof code === "string" ? code : undefined, message)) {
    return undefined;
  }
  const what = /CERTIFICATE_REQUIRED|certificate required/i.test(`${String(code)} ${message}`)
    ? "requires a client certificate in the TLS handshake"
    : "refused the client certificate in the TLS handshake";
  return authKind === "certificate"
    ? `${host} ${what} and did not accept the one presented - check that it ` +
        "is issued by a CA the system trusts (STRUST) and has not expired, or " +
        'choose another with "abap2UI5: Choose Client Certificate"'
    : `${host} ${what} - set "auth": "certificate" in its abap2ui5.systems ` +
        'entry and choose one with "abap2UI5: Choose Client Certificate"';
}
