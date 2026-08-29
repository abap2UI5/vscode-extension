/*
 * The bug report this extension can write about itself.
 *
 * "It does not work" is expensive to answer, and this setup makes it more so:
 * the same window can hold a checked-out repository AND classes opened
 * straight from a system through ADT, and almost every difference in
 * behaviour between the two comes down to one thing - which SCHEME a document
 * has. That is invisible in a screenshot, invisible in the Problems panel,
 * and it was invisible in the log too.
 *
 * So the report says it for every open document, next to the answers that
 * depend on it: is this checkable, does it build a view, which config governs
 * it. Together with the versions and the recent log lines that is most of
 * what a diagnosis needs, in one paste.
 *
 * `vscode`-free: the collecting is plumbing, the SHAPE is the part worth
 * testing - especially the redaction, since a report that leaks a token or a
 * password is worse than no report at all.
 */

export interface ReportDocument {
  /** As `labelOf` names it - a file name, or the class for an ADT document. */
  label: string;
  /** `file`, `adt`, `abapfs`, … - the distinction the whole report exists for. */
  scheme: string;
  languageId: string;
  checkable: boolean;
  usesBuilder: boolean;
  /** The config file governing it, or undefined when the settings do. */
  configFile?: string;
  /** How many findings it currently carries. */
  findings?: number;
}

export interface ReportInput {
  extensionVersion: string;
  vscodeVersion: string;
  platform: string;
  /** "desktop", "web", or the remote name. */
  host: string;
  workspaceFolders: string[];
  documents: ReportDocument[];
  /** The `abap2ui5.*` settings, already flattened to key -> value. */
  settings: Record<string, unknown>;
  renderGate: { installed: boolean; cli?: string; pin?: string };
  systems: { configured: number; active?: string; proxyRunning: boolean };
  /** Other extensions that matter here - the ADT ones above all. */
  relatedExtensions: string[];
  /** Newest last. */
  recentLog: string[];
}

/**
 * Anything that could carry a credential, a token or an internal hostname.
 *
 * Deliberately blunt: a report is pasted into a public issue, and a redaction
 * that is too eager costs a detail, while one that is too clever costs a
 * password. The shape survives - `https://<host>:44300` still says "https on
 * 44300" - because that shape is usually the diagnostic part.
 */
export function redact(text: string): string {
  return (
    text
      // the proxy's own capability token, which authorizes a session
      .replace(/__abap2ui5\/[A-Za-z0-9_-]+/g, "__abap2ui5/<token>")
      /*
       * The authority of a url, in one pass: scheme, optional credentials,
       * host, optional port. One pass rather than three rules, because three
       * rules ran over each other's output - the host rule replaced the
       * `<user>` a previous rule had just written and left the real hostname
       * standing behind the `@`.
       *
       * The PORT stays. It is not a secret and it is frequently the answer:
       * 44300 is the HTTPS ICM, 50000 the Java stack, and "which port did it
       * even try" is a question this report should not need a second round
       * for. Loopback stays whole for the same reason - it says the proxy
       * answered rather than the system.
       */
      .replace(
        /(https?:\/\/)(?:([^/@\s]+)@)?([^/\s?#"']*)/gi,
        (_all, scheme: string, userinfo: string | undefined, host: string) => {
          const credentials = userinfo ? "<user>:<password>@" : "";
          const port = /:(\d+)$/.exec(host)?.[1];
          if (/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) {
            return `${scheme}${credentials}${host}`;
          }
          return `${scheme}${credentials}<host>${port ? `:${port}` : ""}`;
        }
      )
      // sap-user / sap-password style query parameters
      .replace(/([?&](?:sap-user|sap-password|password|user)=)[^&\s]*/gi, "$1<redacted>")
  );
}

/**
 * One markdown table row, with the cells escaped enough for a table.
 *
 * The backslash goes first: escaping only the pipe turns a cell that already
 * ends in a backslash into `\\|`, an escaped backslash followed by a LIVE
 * column separator, so the row the escaping exists to keep intact is the row
 * it breaks. A Windows path in a diagnostic cell is exactly that input.
 */
function row(cells: string[]): string {
  return `| ${cells.map((c) => c.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

/**
 * The report as markdown - pasteable into an issue as it stands.
 *
 * Ordered by how often it turns out to be the answer: what is open and under
 * which scheme first, then the versions, then the settings, and the log last
 * because it is the longest.
 */
export function buildReport(input: ReportInput): string {
  const out: string[] = [];
  out.push("# abap2UI5 diagnostics");
  out.push("");

  out.push("## Open documents");
  out.push("");
  if (!input.documents.length) {
    out.push("_No ABAP or view document is open._");
  } else {
    out.push(
      row(["document", "scheme", "language", "checkable", "builder", "findings", "config"])
    );
    out.push(row(["---", "---", "---", "---", "---", "---", "---"]));
    for (const doc of input.documents) {
      out.push(
        row([
          doc.label,
          doc.scheme,
          doc.languageId,
          yesNo(doc.checkable),
          yesNo(doc.usesBuilder),
          doc.findings === undefined ? "-" : String(doc.findings),
          doc.configFile ?? "(settings)",
        ])
      );
    }
  }
  out.push("");

  out.push("## Environment");
  out.push("");
  out.push(row(["what", "value"]));
  out.push(row(["---", "---"]));
  out.push(row(["extension", input.extensionVersion]));
  out.push(row(["VS Code", input.vscodeVersion]));
  out.push(row(["platform", input.platform]));
  out.push(row(["host", input.host]));
  out.push(
    row([
      "workspace folders",
      input.workspaceFolders.length
        ? input.workspaceFolders.join(", ")
        : "(none - everything comes from open editors)",
    ])
  );
  out.push(
    row([
      "render gate",
      input.renderGate.installed
        ? `installed${input.renderGate.pin ? ` (pin ${input.renderGate.pin})` : ""}`
        : "not installed",
    ])
  );
  out.push(
    row([
      "systems",
      `${input.systems.configured} configured` +
        (input.systems.active ? `, active: ${input.systems.active}` : "") +
        `, proxy ${input.systems.proxyRunning ? "running" : "stopped"}`,
    ])
  );
  if (input.relatedExtensions.length) {
    out.push(row(["other extensions", input.relatedExtensions.join(", ")]));
  }
  out.push("");

  out.push("## Settings");
  out.push("");
  const keys = Object.keys(input.settings).sort();
  if (!keys.length) {
    out.push("_Everything at its default._");
  } else {
    out.push("```json");
    out.push(
      JSON.stringify(
        Object.fromEntries(keys.map((k) => [k, input.settings[k]])),
        null,
        2
      )
    );
    out.push("```");
  }
  out.push("");

  out.push(`## Recent log (${input.recentLog.length} lines)`);
  out.push("");
  out.push("```");
  out.push(...(input.recentLog.length ? input.recentLog : ["(nothing logged yet)"]));
  out.push("```");

  return redact(out.join("\n")) + "\n";
}
