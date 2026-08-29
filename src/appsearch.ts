import * as vscode from "vscode";
import { AdtClassRef, parseAdtClassRefs, SapProxy } from "./proxy";

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

/** Below this many characters nothing is asked - the seed list stands. */
const MIN_QUERY_LENGTH = 2;

export async function searchClassRefs(
  proxy: SapProxy,
  query: string,
  sapClient: string | undefined,
  signal?: AbortSignal
): Promise<AdtClassRef[]> {
  const path =
    "/sap/bc/adt/repository/informationsystem/search?operation=quickSearch" +
    `&query=${encodeURIComponent(query.toUpperCase() + "*")}&maxResults=50` +
    (sapClient ? `&sap-client=${encodeURIComponent(sapClient)}` : "");
  const { status, body } = await proxy.fetchFromSystem(path, undefined, {
    signal,
  });
  if (status < 200 || status >= 300) {
    throw new Error(`ADT search answered ${status}`);
  }
  return parseAdtClassRefs(body);
}

/** The names alone - what the MCP tools hand on. */
export async function searchClasses(
  proxy: SapProxy,
  query: string,
  sapClient: string | undefined
): Promise<string[]> {
  return (await searchClassRefs(proxy, query, sapClient)).map((ref) => ref.name);
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
      type SearchItem = vscode.QuickPickItem & {
        /** Marks the row that reports a failed search - a notice, never a
         *  class name the accept handler may launch. */
        failed?: boolean;
      };
      const picker = vscode.window.createQuickPick<SearchItem>();
      picker.title = "abap2UI5: run an app on the system";
      picker.placeholder =
        "Type part of the class name - searched on the system (ADT quick search)";
      const recentItems = () =>
        deps.recent().map((name) => ({
          label: name,
          description: "recently launched",
        }));
      picker.items = recentItems();

      let timer: NodeJS.Timeout | undefined;
      let generation = 0;
      let inflight: AbortController | undefined;
      picker.onDidChangeValue((value) => {
        if (timer) {
          clearTimeout(timer);
        }
        const query = value.trim();
        if (query.length < MIN_QUERY_LENGTH) {
          // back below the threshold: an answer for the LONGER query that is
          // still in flight must not land on a list it no longer matches
          generation++;
          inflight?.abort();
          picker.items = recentItems();
          picker.busy = false;
          return;
        }
        timer = setTimeout(async () => {
          const mine = ++generation;
          inflight?.abort();
          const abort = new AbortController();
          inflight = abort;
          picker.busy = true;
          try {
            const refs = await searchClassRefs(
              deps.proxy,
              query,
              connection.sapClient,
              abort.signal
            );
            if (mine !== generation) {
              return; // a newer keystroke's answer is already on its way
            }
            picker.items = refs.map((ref) => ({
              label: ref.name,
              description: ref.description,
              detail: ref.packageName,
            }));
          } catch (err) {
            if (mine === generation) {
              const reason = err instanceof Error ? err.message : String(err);
              deps.log(`app-search: ${reason}`);
              // said in the picker itself: a silent stale list after a failed
              // search reads exactly like "no matches"
              picker.items = [
                {
                  label: "$(warning) search failed",
                  description: reason,
                  alwaysShow: true,
                  failed: true,
                },
              ];
            }
          } finally {
            if (mine === generation) {
              picker.busy = false;
            }
          }
        }, SEARCH_DEBOUNCE_MS);
      });

      picker.onDidAccept(() => {
        if (picker.selectedItems[0]?.failed) {
          return; // the failure notice is not launchable - keep the picker up
        }
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
        generation++;
        inflight?.abort();
        picker.dispose();
      });
      picker.show();
    })
  );
}
