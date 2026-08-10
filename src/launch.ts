import * as vscode from "vscode";
import { classNameOf, isAppClass } from "./abap";
import { originOf, sapClientOf } from "./urls";
import { suggestSystemUi5 } from "./ui5detect";
import { clearCredentials, ensureCredentials, ensureSystem } from "./systems";
import { PreviewSurface, Session } from "./session";
import { reloadShownApp, showInTab } from "./preview";

/*
 * Launching an app: F9, the activation command behind Ctrl+F3, and the
 * proxy-status watch that turns a rejected logon into an actionable offer.
 */

/**
 * Launches one app. Without a class name it takes the one in the active
 * editor - and, when that editor holds no abap2UI5 app at all, hands F9 back
 * to what it normally does so the key is not lost.
 */
export async function runApp(
  session: Session,
  provider: PreviewSurface,
  className?: string
): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!className) {
    // Not an ABAP editor or not a z2ui5 app: keep the normal F9 behaviour.
    if (
      !editor ||
      editor.document.languageId !== "abap" ||
      !isAppClass(editor.document.getText())
    ) {
      await vscode.commands.executeCommand("editor.debug.action.toggleBreakpoint");
      return;
    }
    className = classNameOf(editor.document.getText(), editor.document.fileName);
  }

  const system = await ensureSystem(session.ctx);
  if (!system) {
    return;
  }

  const externalUrl = session.urlFor(system, className);
  const origin = originOf(externalUrl);
  if (!origin) {
    vscode.window.showErrorMessage(
      `abap2UI5: the launch URL of ${system.name} is not a valid URL.`
    );
    return;
  }

  const mode = session.openMode();

  await session.rememberApp(className);

  if (mode === "external") {
    await vscode.env.openExternal(vscode.Uri.parse(externalUrl));
    return;
  }

  // tab / panel: load through the auth proxy so the login takes effect.
  const creds = await ensureCredentials(session.ctx, origin);
  if (!creds) {
    return;
  }

  let frameUrl: string;
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `abap2UI5: starting ${className}`,
      },
      () => session.proxy.start(origin, creds.user, creds.pass)
    );
    frameUrl = externalUrl.replace(origin, session.proxy.origin);
  } catch (err) {
    vscode.window.showErrorMessage(
      "abap2UI5: could not start the proxy - " +
        (err instanceof Error ? err.message : String(err))
    );
    return;
  }

  // First contact with this system: ask it which UI5 it serves, and offer
  // to align the view check with the answer. Fire-and-forget by design.
  void suggestSystemUi5(session.ctx, session.proxy, origin, (m) => session.log(m));

  // Remember the cursor position; open the window in which focus stolen by
  // the loading app is handed back (the content loads asynchronously).
  if (editor) {
    session.rememberSource(editor);
  }
  session.bounceFocusUntil = Date.now() + 2500;

  // Remember for auto-reload on save and for the status bar.
  session.watch.stop();
  session.currentTarget = { className, frameUrl, externalUrl, system: system.name };
  session.updateStatusItem();

  if (mode === "panel") {
    await provider.show(session.currentTarget);
  } else {
    showInTab(session, session.currentTarget);
    provider.refreshWelcome();
  }
  session.watch.captureBaseline();

  // Focus straight back to the same spot in the source.
  await session.restoreSourceFocus();
}

// ---------------------------------------------------------------------------
// Activate the ABAP object, then reload
// ---------------------------------------------------------------------------

/**
 * Activation commands of the ABAP extensions we know about, in the order they
 * are tried. Ctrl+F3 delegates to the first one that is actually installed.
 *
 * `abapfs.activate` is the ABAP remote filesystem extension; it activates the
 * object of the active editor and saves it first if it is dirty.
 */
const ABAP_ACTIVATE_COMMANDS = ["abapfs.activate"];

async function findAbapActivateCommand(): Promise<string | undefined> {
  const available = new Set(await vscode.commands.getCommands(true));
  return ABAP_ACTIVATE_COMMANDS.find((command) => available.has(command));
}

/**
 * Saves, activates through the installed ABAP tooling and reloads the preview.
 * Only the activation puts the new source on the server, which is why this -
 * and not a plain save - is what the preview reloads on.
 */
export async function activateAndReload(session: Session): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const isAbap = editor?.document.languageId === "abap";
  const activateCommand = await findAbapActivateCommand();

  if (!activateCommand) {
    // Nothing to delegate to (the key binding is not active in this case, so
    // this is a deliberate call from the palette): reload what is shown and
    // say why nothing was activated.
    vscode.window.showInformationMessage(
      "abap2UI5: no ABAP extension with an activation command found - activate the class in your ABAP tooling, the preview only reloads."
    );
    if (session.currentTarget) {
      reloadShownApp(session, "Reloaded");
    }
    return;
  }

  if (editor && isAbap && editor.document.isDirty) {
    await editor.document.save();
  }

  if (editor && isAbap) {
    session.rememberSource(editor);
  }

  try {
    // Hand over the exact document instead of relying on the tooling's
    // active-editor fallback. Note that at least abapfs.activate reports its
    // own failures and resolves anyway, so reaching the reload below does not
    // guarantee the activation worked — the server watch (see below) covers a
    // late activation after a failed first try.
    await vscode.commands.executeCommand(
      activateCommand,
      editor && isAbap && editor.document.uri.scheme === "adt"
        ? editor.document.uri
        : undefined
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      "abap2UI5: activation failed - " +
        (err instanceof Error ? err.message : String(err))
    );
    return;
  }

  if (!session.currentTarget) {
    return;
  }
  // Keep focus in the code in case the reloading app tries to grab it. The
  // window starts here: activating can take a moment.
  if (editor && isAbap) {
    session.bounceFocusUntil = Date.now() + 2500;
  }
  reloadShownApp(session, "Reloaded after activation");
}

// ---------------------------------------------------------------------------
// A rejected logon, made actionable
// ---------------------------------------------------------------------------

/**
 * The proxy sees every answer the system gives; inside the iframe a 401 is
 * just an unhelpful page, and the only cure used to be finding "Clear Stored
 * SAP Credentials" in the palette. This turns it into one offer to retype
 * them, with the retry that follows.
 */
export function watchProxyStatus(session: Session): void {
  session.proxy.onResponse = ({ status, path }) => {
    if (status !== 401 && status !== 403) {
      if (status >= 500) {
        session.log(`proxy: the system answered ${status} for ${path}`);
      }
      return;
    }
    session.log(`proxy: the system answered ${status} for ${path}`);
    const now = Date.now();
    if (now - session.lastAuthPrompt < 30_000) {
      return;
    }
    session.lastAuthPrompt = now;
    const origin = session.currentTarget
      ? originOf(session.currentTarget.externalUrl)
      : undefined;
    void vscode.window
      .showWarningMessage(
        `abap2UI5: the system rejected the logon (HTTP ${status}). The stored ` +
          "user or password may be wrong, or this system does not accept basic " +
          "auth - in which case set `abap2ui5.openMode` to `external`.",
        "Re-enter credentials"
      )
      .then(async (pick) => {
        if (pick !== "Re-enter credentials" || !origin) {
          return;
        }
        await clearCredentials(session.ctx, origin);
        const creds = await ensureCredentials(session.ctx, origin);
        if (!creds) {
          return;
        }
        await session.proxy.start(origin, creds.user, creds.pass);
        session.lastAuthPrompt = 0;
        reloadShownApp(session, "Reloaded with new credentials");
      });
  };
}

/**
 * The system pick and credential flow F9 uses, ending in a started proxy -
 * shared by "Run an App from the System" and the system MCP tools.
 */
export function makeConnectSystem(
  session: Session
): () => Promise<{ sapClient?: string } | undefined> {
  return async () => {
    const system = await ensureSystem(session.ctx);
    if (!system) {
      return undefined;
    }
    const expanded = session.urlFor(system, "PROBE");
    const origin = originOf(expanded);
    if (!origin) {
      vscode.window.showErrorMessage(
        `abap2UI5: the launch URL of ${system.name} is not a valid URL.`
      );
      return undefined;
    }
    const creds = await ensureCredentials(session.ctx, origin);
    if (!creds) {
      return undefined;
    }
    await session.proxy.start(origin, creds.user, creds.pass);
    return { sapClient: sapClientOf(expanded) };
  };
}
