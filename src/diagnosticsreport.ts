import * as vscode from "vscode";
import { buildReport, ReportDocument } from "./report";
import { CONFIG_SECTION } from "./settings";
import { isCheckable } from "./viewcheck";
import { findConfigFile } from "./lintconfig";
import { usesBuilder } from "./abap";
import { labelOf } from "./abapsources";
import { DIAG_SOURCE } from "./diagnostics";
import { renderGateCli } from "./rendergate";
import { activeSystem, allSystems } from "./systems";
import { Session } from "./session";
import * as path from "path";

/*
 * Collecting what `report.ts` formats.
 *
 * Everything interesting about a misbehaving window is spread across places
 * a user cannot reasonably be asked to visit: the output channel, the
 * settings, the extension list, and the scheme of whatever documents are
 * open. This walks them once.
 */

/** Extensions whose presence changes what the schemes in this window are -
 *  every ABAP one, since that is where an `adt:` document comes from. */
function relatedExtensions(): string[] {
  return vscode.extensions.all
    .filter((e) => {
      const id = e.id.toLowerCase();
      return (
        (id.includes("abap") || id.includes("sap")) && !id.startsWith("abap2ui5.")
      );
    })
    .map((e) => `${e.id} ${String(e.packageJSON?.version ?? "?")}`)
    .sort();
}

/** Every `abap2ui5.` setting the manifest declares, so a new one cannot be
 *  forgotten here. */
function settingKeys(context: vscode.ExtensionContext): string[] {
  const properties = (context.extension.packageJSON?.contributes?.configuration
    ?.properties ?? {}) as Record<string, unknown>;
  return Object.keys(properties)
    .filter((key) => key.startsWith(`${CONFIG_SECTION}.`))
    .map((key) => key.slice(CONFIG_SECTION.length + 1));
}

/** The `abap2ui5.*` settings the user actually set, defaults left out - a
 *  report full of defaults hides the two lines that were changed. */
function changedSettings(keys: string[]): Record<string, unknown> {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const info = cfg.inspect(key);
    const set =
      info?.workspaceFolderValue ??
      info?.workspaceValue ??
      info?.globalValue;
    if (set !== undefined) {
      out[key] = set;
    }
  }
  return out;
}

export function registerDiagnosticsReport(
  context: vscode.ExtensionContext,
  session: Session
): void {
  const keys = settingKeys(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("abap2ui5.copyDiagnostics", async () => {
      const documents: ReportDocument[] = [];
      for (const doc of vscode.workspace.textDocuments) {
        const isAbap =
          doc.languageId === "abap" ||
          /\.(abap|view\.xml|fragment\.xml)$/i.test(doc.uri.path);
        if (!isAbap) {
          continue;
        }
        const findings = vscode.languages
          .getDiagnostics(doc.uri)
          .filter((d) => d.source === DIAG_SOURCE).length;
        documents.push({
          label: labelOf(doc.uri),
          scheme: doc.uri.scheme,
          languageId: doc.languageId,
          checkable: isCheckable(doc),
          usesBuilder: usesBuilder(doc.getText()),
          configFile: findConfigFile(
            doc.uri.scheme === "file"
              ? path.dirname(doc.uri.fsPath)
              : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
          ),
          findings,
        });
      }

      const cli = renderGateCli(context);
      const report = buildReport({
        extensionVersion: String(context.extension.packageJSON?.version ?? "?"),
        vscodeVersion: vscode.version,
        platform: `${process.platform} ${process.arch}`,
        // Web first, then a remote name, then plain desktop. Written as one
        // ?? chain this parsed as `(remoteName ?? (uiKind === Web)) ? …`,
        // which called every WSL and SSH window "web".
        host:
          vscode.env.uiKind === vscode.UIKind.Web
            ? "web"
            : (vscode.env.remoteName ?? "desktop"),
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(
          (f) => f.name
        ),
        documents,
        settings: changedSettings(keys),
        renderGate: {
          installed: !!cli,
          cli,
          pin: (process.env.LINTER_PIN || "").slice(0, 12) || undefined,
        },
        systems: {
          configured: allSystems().length,
          active: activeSystem(context)?.name,
          proxyRunning: session.proxy.isRunning,
        },
        relatedExtensions: relatedExtensions(),
        recentLog: session.recentLog(),
      });

      /*
       * Opened AND copied. The clipboard is what makes it one gesture, and
       * the document is what makes it reviewable - this goes into a public
       * issue, and nobody should have to take the redaction on trust.
       */
      const doc = await vscode.workspace.openTextDocument({
        content: report,
        language: "markdown",
      });
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.env.clipboard.writeText(report);
      session.log(
        `diagnostics: report built - ${documents.length} document(s), ` +
          `${session.recentLog().length} log line(s)`
      );
      vscode.window.showInformationMessage(
        "abap2UI5: the report is in your clipboard and open here. " +
          "Hostnames, credentials and the proxy token are already removed - " +
          "have a look before you paste it anywhere."
      );
    })
  );
}
