import * as vscode from "vscode";
import { DIAG_SOURCE, ruleOf } from "./diagnostics";
import { CONFIG_SECTION } from "./settings";
import { buildsViews, reconstructedXmlOf } from "./xmlpreview";
import {
  CHAT_TOOLS_SETTING,
  ChatToolHost,
  ChatToolSurface,
  chatTools,
  DocumentFindings,
  invokeChatTool,
  ReconstructedView,
  ToolFinding,
  Unavailable,
} from "./chattools";

/*
 * The plumbing around `chattools.ts`, shared by both entries: what the
 * window knows (the published diagnostics, the open documents), and the
 * registration with `vscode.lm`.
 *
 * Nothing here checks or reconstructs on its own. The findings are the
 * diagnostics the view check has published - the Problems panel's and the
 * findings tree's source - and the view is `xmlpreview.ts`'s reconstruction.
 * The running app's model needs the preview and is handed in by the desktop
 * entry; the web entry hands in nothing, and the manifest keeps that tool
 * out of the web host (`when`).
 */

const NO_EDITOR =
  "No document is active in the editor. Open the abap2UI5 app class (or pass " +
  "its `uri`) and ask again.";

/** A `uri` argument as a Uri: a real uri, or an absolute path. */
function toUri(target: string): vscode.Uri {
  // a drive letter is not a scheme
  return /^[a-z][\w+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)
    ? vscode.Uri.parse(target)
    : vscode.Uri.file(target);
}

/** The document a tool call is about: the named one, else the active one. */
function targetUri(target: string | undefined): vscode.Uri | undefined {
  return target ? toUri(target) : vscode.window.activeTextEditor?.document.uri;
}

function nameOf(uri: vscode.Uri): string {
  return uri.scheme === "file" ? vscode.workspace.asRelativePath(uri) : uri.toString();
}

function severityOf(diagnostic: vscode.Diagnostic): ToolFinding["severity"] {
  if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
    return "error";
  }
  return diagnostic.severity === vscode.DiagnosticSeverity.Warning ? "warning" : "hint";
}

/** The view check's published findings of one document. */
function publishedFindings(uri: vscode.Uri): ToolFinding[] {
  const out: ToolFinding[] = [];
  for (const diagnostic of vscode.languages.getDiagnostics(uri)) {
    const rule = diagnostic.source === DIAG_SOURCE ? ruleOf(diagnostic) : undefined;
    if (!rule) {
      continue;
    }
    out.push({
      rule,
      severity: severityOf(diagnostic),
      line: diagnostic.range.start.line,
      message: diagnostic.message,
    });
  }
  return out;
}

async function findings(target: string | undefined): Promise<DocumentFindings | Unavailable> {
  const uri = targetUri(target);
  if (!uri) {
    return { unavailable: NO_EDITOR };
  }
  return { document: nameOf(uri), findings: publishedFindings(uri) };
}

async function reconstructedView(
  target: string | undefined
): Promise<ReconstructedView | Unavailable> {
  const uri = targetUri(target);
  if (!uri) {
    return { unavailable: NO_EDITOR };
  }
  const key = uri.toString();
  let doc = vscode.workspace.textDocuments.find((open) => open.uri.toString() === key);
  if (!doc) {
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch (err) {
      return {
        unavailable:
          `${nameOf(uri)} could not be read ` +
          `(${err instanceof Error ? err.message : String(err)}).`,
      };
    }
  }
  if (!buildsViews(doc)) {
    return {
      unavailable:
        `${nameOf(uri)} is not an ABAP class that builds views with ` +
        "z2ui5_cl_ui5_view_builder - there is nothing to reconstruct.",
    };
  }
  return { document: nameOf(uri), ...reconstructedXmlOf(doc) };
}

/** `vscode.lm.registerTool`, when this host has it - an older or a
 *  different editor behind the same engine range may not. */
function registerToolApi(): typeof vscode.lm.registerTool | undefined {
  const lm = (vscode as { lm?: Partial<typeof vscode.lm> }).lm;
  return typeof lm?.registerTool === "function" ? lm.registerTool.bind(lm) : undefined;
}

/**
 * Registers the surface's language model tools while `abap2ui5.chatTools`
 * is on, and follows the setting: off disposes them, on registers again.
 */
export function registerChatTools(
  context: vscode.ExtensionContext,
  surface: ChatToolSurface,
  log: (m: string) => void,
  runningAppModel?: ChatToolHost["runningAppModel"]
): void {
  const registerTool = registerToolApi();
  if (!registerTool) {
    log("chat tools: this editor has no language model tool API - none registered");
    return;
  }
  const tools = chatTools(surface, { findings, reconstructedView, runningAppModel });
  let registered: vscode.Disposable[] = [];
  const enabled = () =>
    vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(CHAT_TOOLS_SETTING, true);
  const sync = () => {
    if (!enabled()) {
      if (registered.length) {
        log("chat tools: switched off");
      }
      registered.forEach((entry) => entry.dispose());
      registered = [];
      return;
    }
    if (registered.length) {
      return;
    }
    try {
      registered = tools.map((tool) =>
        registerTool<unknown>(tool.name, {
          // all three only read - no `prepareInvocation`, nothing to confirm
          invoke: async (options) => {
            const answer = await invokeChatTool(tool, options.input);
            return new vscode.LanguageModelToolResult(
              answer.parts.map((part) => new vscode.LanguageModelTextPart(part))
            );
          },
        })
      );
      log(`chat tools: registered ${tools.map((tool) => tool.name).join(", ")}`);
    } catch (err) {
      log(`chat tools: could not be registered (${String(err)})`);
    }
  };
  sync();
  context.subscriptions.push(
    { dispose: () => registered.forEach((entry) => entry.dispose()) },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.${CHAT_TOOLS_SETTING}`)) {
        sync();
      }
    })
  );
}
