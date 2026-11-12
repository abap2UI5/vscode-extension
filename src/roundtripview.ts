import * as vscode from "vscode";
import { Session } from "./session";
import { activeSystem, allSystems } from "./systems";
import { nodeRequest } from "./agentapps";
import {
  bodyDocument,
  jsoncDocument,
  replayRoundtrip,
  Roundtrip,
  roundtripDescription,
  roundtripDetail,
  roundtripHeader,
  roundtripLabel,
} from "./roundtrips";

/*
 * "Show Roundtrip" and "Replay Roundtrip": the plumbing around
 * `roundtrips.ts`, which holds the ring and decides what the model is.
 *
 * Both sides of a diff are virtual documents served from a map in memory.
 * Nothing here writes a body anywhere else - no file, no output channel, no
 * log line (the log gets the roundtrip's number and nothing of its content)
 * - and the map is emptied together with the ring: when the proxy stops or
 * the system changes, an open diff says so instead of keeping the data.
 */

const SCHEME = "abap2ui5-roundtrip";
const GONE =
  "// This roundtrip is no longer stored - bodies are kept in memory only, " +
  "and dropped when the proxy stops or the system changes.\n";

/** Documents kept at most - each replay and each look adds two. */
const MAX_DOCUMENTS = 12;

export function registerRoundtripCommands(
  context: vscode.ExtensionContext,
  session: Session
): void {
  const contents = new Map<string, string>();
  const emitter = new vscode.EventEmitter<vscode.Uri>();
  const ring = session.proxy.roundtrips;

  session.proxy.roundtripScope = () => activeSystem(context)?.name ?? "";
  ring.onClear = () => {
    const open = [...contents.keys()];
    contents.clear();
    for (const key of open) {
      emitter.fire(vscode.Uri.parse(key));
    }
  };

  const publish = (name: string, text: string): vscode.Uri => {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${name}.json` });
    contents.delete(uri.toString());
    contents.set(uri.toString(), text);
    for (const key of contents.keys()) {
      if (contents.size <= MAX_DOCUMENTS) {
        break;
      }
      contents.delete(key);
    }
    emitter.fire(uri);
    return uri;
  };

  const showDiff = async (left: vscode.Uri, right: vscode.Uri, title: string) => {
    for (const uri of [left, right]) {
      // jsonc, because the header is comment lines
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.languages.setTextDocumentLanguage(doc, "jsonc");
    }
    await vscode.commands.executeCommand("vscode.diff", left, right, title, {
      preview: false,
    });
  };

  type Item = vscode.QuickPickItem & { entry: Roundtrip };
  const pick = async (title: string, onlyReplayable: boolean): Promise<Roundtrip | undefined> => {
    const items: Item[] = ring
      .list()
      .filter((entry) => !onlyReplayable || entry.summary().replayable)
      .map((entry) => {
        const summary = entry.summary();
        return {
          label: roundtripLabel(summary),
          description: roundtripDescription(summary),
          detail: roundtripDetail(summary),
          entry,
        };
      });
    if (!items.length) {
      vscode.window.showInformationMessage(
        "abap2UI5: no roundtrip is stored yet - run an app in tab or panel " +
          "mode and press a button in it. The last 20 are kept, in memory " +
          "only, until the proxy stops or the system changes."
      );
      return undefined;
    }
    const chosen = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: "Newest first - time, event, class, duration, size",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    return chosen?.entry;
  };

  context.subscriptions.push(
    emitter,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      onDidChange: emitter.event,
      provideTextDocumentContent: (uri) => contents.get(uri.toString()) ?? GONE,
    }),
    vscode.commands.registerCommand("abap2ui5.showRoundtrip", async () => {
      const entry = await pick("abap2UI5: Show Roundtrip", false);
      if (!entry) {
        return;
      }
      const models = ring.models(entry);
      const header = roundtripHeader(entry, models);
      const before = publish(
        `roundtrip-${entry.seq}-model-before`,
        jsoncDocument(header, models.before, "The model before this roundtrip is not known - see the notes above.")
      );
      const after = publish(
        `roundtrip-${entry.seq}-model-after`,
        jsoncDocument(header, models.after, "The model after this roundtrip is not known - see the notes above.")
      );
      await showDiff(
        before,
        after,
        `Roundtrip #${entry.seq} ${entry.summary().event}: model before ↔ after`
      );
      session.log(`roundtrip: showed #${entry.seq}`);
    }),
    vscode.commands.registerCommand("abap2ui5.replayRoundtrip", async () => {
      // Refused before the picker too: in Restricted Mode not even the
      // question is put (replayRoundtrip refuses again, for every caller).
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage(
          "abap2UI5: a replay runs an event on the system as you - it is " +
            "not available in Restricted Mode. Trust the workspace first."
        );
        return;
      }
      const entry = await pick("abap2UI5: Replay Roundtrip", true);
      if (!entry) {
        return;
      }
      const host = session.proxy.systemOrigin
        ? new URL(session.proxy.systemOrigin).host
        : undefined;
      const name = session.currentTarget?.system ?? activeSystem(context)?.name;
      const system = name && host && name !== host ? `${name} (${host})` : (name ?? host ?? "the system");
      let result;
      try {
        result = await replayRoundtrip(
          entry,
          { system, className: session.currentTarget?.className },
          {
            isTrusted: () => vscode.workspace.isTrusted,
            // the system the proxy forwards to, not only the active profile:
            // a replay goes wherever the recorded roundtrip went
            isProduction: () => isProductionOrigin(context, session.proxy.systemOrigin),
            confirm: async (question) =>
              (await vscode.window.showWarningMessage(
                `abap2UI5: ${question.message}`,
                { modal: true, detail: question.detail },
                "Replay"
              )) === "Replay",
            proxyBase: () => (session.proxy.isRunning ? session.proxy.origin : undefined),
            isStored: (candidate) => ring.get(candidate.seq) === candidate,
            request: (url, init) => nodeRequest(url, init),
          }
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        session.log(`roundtrip: the replay of #${entry.seq} failed - ${reason}`);
        vscode.window.showErrorMessage(`abap2UI5: the replay failed - ${reason}`);
        return;
      }
      if ("cancelled" in result) {
        return;
      }
      if ("refused" in result) {
        vscode.window.showWarningMessage(`abap2UI5: ${result.refused}`);
        return;
      }
      session.log(
        `roundtrip: replayed #${entry.seq} - ${result.status} in ${result.durationMs} ms`
      );
      const summary = entry.summary();
      const recorded = publish(
        `roundtrip-${entry.seq}-answer-recorded`,
        bodyDocument(
          [`Roundtrip ${roundtripLabel(summary)} - the answer as recorded (${entry.status}, ${entry.durationMs} ms)`],
          entry.responseText(),
          "The recorded answer was not stored - " + summary.notes.join("; ")
        )
      );
      const replayed = publish(
        `roundtrip-${entry.seq}-answer-replayed`,
        bodyDocument(
          [`Roundtrip ${roundtripLabel(summary)} - the answer of the replay (${result.status}, ${result.durationMs} ms)`],
          result.body,
          ""
        )
      );
      await showDiff(
        recorded,
        replayed,
        `Roundtrip #${entry.seq} ${summary.event}: recorded answer ↔ replay`
      );
      if (result.status < 200 || result.status >= 300) {
        vscode.window.showWarningMessage(
          `abap2UI5: the system answered the replay with ${result.status}.`
        );
      }
    })
  );
}

/** Whether the origin the proxy forwards to belongs to a profile marked
 *  `"role": "production"` - or, when the origin cannot be read, whether the
 *  active profile is one. */
function isProductionOrigin(
  context: vscode.ExtensionContext,
  origin: string | undefined
): boolean {
  if (activeSystem(context)?.role === "production") {
    return true;
  }
  if (!origin) {
    return false;
  }
  return allSystems().some((system) => {
    if (system.role !== "production") {
      return false;
    }
    try {
      return new URL(system.template.replace("{class}", "X")).origin === origin;
    } catch {
      return false;
    }
  });
}
