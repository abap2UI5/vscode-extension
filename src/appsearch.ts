import * as vscode from "vscode";
import { parseAdtClassNames, SapProxy } from "./proxy";

/*
 * "Run an App from the System" - launch without having the class open.
 *
 * *Run a Recently Launched App* only knows what this window has run before.
 * The system knows every class: its ADT quick search (the same service the
 * activation watch already talks to) answers name patterns, so the picker
 * searches while you type and F9-launches the choice. A name search, not an
 * interface search - ADT answers the former in one cheap GET; whether the
 * picked class really is an app the launch itself will show.
 */

/** Keystroke debounce before asking the system. */
const SEARCH_DEBOUNCE_MS = 300;

export async function searchClasses(
  proxy: SapProxy,
  query: string,
  sapClient: string | undefined
): Promise<string[]> {
  const path =
    "/sap/bc/adt/repository/informationsystem/search?operation=quickSearch" +
    `&query=${encodeURIComponent(query.toUpperCase() + "*")}&maxResults=50` +
    (sapClient ? `&sap-client=${encodeURIComponent(sapClient)}` : "");
  const { status, body } = await proxy.fetchFromSystem(path);
  if (status < 200 || status >= 300) {
    throw new Error(`ADT search answered ${status}`);
  }
  return parseAdtClassNames(body);
}

export interface AppSearchDeps {
  proxy: SapProxy;
  /** Origin + client of the active system, credentials already ensured -
   *  or undefined when the user backed out of the pickers. */
  connect(): Promise<{ sapClient?: string } | undefined>;
  /** What F9 does, given a class name. */
  run(className: string): Promise<void>;
  /** Seed for the empty picker. */
  recent(): string[];
  log: (m: string) => void;
}

export function registerAppSearch(
  context: vscode.ExtensionContext,
  deps: AppSearchDeps
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("abap2ui5.runFromSystem", async () => {
      const connection = await deps.connect();
      if (!connection) {
        return;
      }
      const picker = vscode.window.createQuickPick();
      picker.title = "abap2UI5: run an app on the system";
      picker.placeholder =
        "Type part of the class name - searched on the system (ADT quick search)";
      picker.items = deps.recent().map((name) => ({
        label: name,
        description: "recently launched",
      }));

      let timer: NodeJS.Timeout | undefined;
      let generation = 0;
      picker.onDidChangeValue((value) => {
        if (timer) {
          clearTimeout(timer);
        }
        const query = value.trim();
        if (query.length < 2) {
          return;
        }
        timer = setTimeout(async () => {
          const mine = ++generation;
          picker.busy = true;
          try {
            const names = await searchClasses(
              deps.proxy,
              query,
              connection.sapClient
            );
            if (mine !== generation) {
              return; // a newer keystroke's answer is already on its way
            }
            picker.items = names.map((name) => ({ label: name }));
          } catch (err) {
            if (mine === generation) {
              deps.log(
                `app-search: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          } finally {
            if (mine === generation) {
              picker.busy = false;
            }
          }
        }, SEARCH_DEBOUNCE_MS);
      });

      picker.onDidAccept(() => {
        const pick = picker.selectedItems[0]?.label ?? picker.value.trim();
        picker.hide();
        if (pick) {
          // Starting an app talks to a system: wrong credentials, a system
          // that is down, a class that is not an app. Rejecting into nothing
          // left the picker closed with no app and no explanation - the one
          // outcome a search is never allowed to have.
          deps.run(pick.toUpperCase()).catch((err: unknown) => {
            vscode.window.showErrorMessage(
              `abap2UI5: could not start ${pick.toUpperCase()} - ${String(err)}`
            );
          });
        }
      });
      picker.onDidHide(() => {
        if (timer) {
          clearTimeout(timer);
        }
        picker.dispose();
      });
      picker.show();
    })
  );
}
