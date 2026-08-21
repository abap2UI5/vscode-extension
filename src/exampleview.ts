import * as vscode from "vscode";
import { CONFIG_SECTION } from "./settings";
import * as fs from "fs";
import * as path from "path";
import { controlCallAt } from "./context";
import { ExampleHit, findControlUses, rankExamples } from "./examples";
import { CatalogueEntry, CatalogueHit, catalogueUrl, matchCatalogue, parseCatalogue } from "./catalogue";
import { CORPUS_DIRS, SAMPLES_DIRS, SAMPLES_STACK_DIRS } from "./repolayout";

/*
 * "Show abap2UI5 Examples for this Control" - the sample catalogues, read for
 * the person rather than for an agent.
 *
 * The MCP server already searches these three repositories; that answer goes
 * to a language model. This is the same corpus with the cursor as the query:
 * put it on an `ele( n = `Table` )`, run the command, and get the places a
 * working `Table` is built in the samples - richest example first, opened at
 * the line.
 *
 * A local checkout is the primary source and always wins: it is searched
 * line by line and opens in the editor. But the catalogues are git checkouts,
 * not something the extension ships, and the beginner most in need of an
 * example is exactly the person who has cloned nothing yet. So each
 * repository WITHOUT a local checkout is answered from the `catalogue.json`
 * it commits at its root, fetched from GitHub and cached for a day - those
 * hits name whole samples rather than lines, and open on github.com.
 */

/** The three sample repositories: the GitHub name that publishes the
 *  catalogue, and the local directory names a checkout can carry (newest
 *  first - the same names the MCP registration probes for). */
const GROUPS: ReadonlyArray<{ repo: string; dirs: readonly string[] }> = [
  { repo: "samples", dirs: SAMPLES_DIRS },
  { repo: "samples-controls", dirs: CORPUS_DIRS },
  { repo: "samples-stack", dirs: SAMPLES_STACK_DIRS },
];

/** A corpus is thousands of classes; the walk stays bounded so a mistyped
 *  repos root pointing at a home directory cannot turn this into a
 *  filesystem crawl. */
const FILE_LIMIT = 4000;

/** How long a fetched catalogue stays good. A day, like the ecosystem's
 *  other snapshots-of-elsewhere: the catalogues move with sample merges,
 *  which is far slower than anyone re-runs this command. */
const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedCatalogue {
  at: number;
  entries: CatalogueEntry[];
}

/** Fetched catalogues, per repo - the session-lifetime layer over the
 *  `globalState` layer that survives a window reload. */
const memoryCache = new Map<string, CachedCatalogue>();

function cacheKey(repo: string): string {
  return `examples.catalogue.${repo}`;
}

/**
 * The remote catalogue of one repository: memory, then `globalState`, then
 * a fetch of the committed `catalogue.json` (cached back into both).
 *
 * `undefined` means "this repository could not answer at all" - fetch failed
 * and nothing cached - which the caller distinguishes from an answer with no
 * matches. On a failed fetch an EXPIRED cache is still served: a day-old
 * catalogue beats no examples, and the next successful fetch replaces it.
 */
async function remoteEntries(
  context: vscode.ExtensionContext,
  repo: string,
  log: (m: string) => void,
  force = false
): Promise<CatalogueEntry[] | undefined> {
  const now = Date.now();
  const stored = (): CachedCatalogue | undefined =>
    memoryCache.get(repo) ?? context.globalState.get<CachedCatalogue>(cacheKey(repo));
  if (!force) {
    const cached = stored();
    if (cached && Array.isArray(cached.entries) && now - cached.at < CATALOGUE_TTL_MS) {
      memoryCache.set(repo, cached);
      return cached.entries;
    }
  }
  try {
    const res = await fetch(catalogueUrl(repo), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const entries = parseCatalogue(await res.text());
    log(`examples: fetched ${repo} catalogue - ${entries.length} entries`);
    const value = { at: now, entries };
    memoryCache.set(repo, value);
    await context.globalState.update(cacheKey(repo), value);
    return entries;
  } catch (err) {
    log(
      `examples: ${repo} catalogue fetch failed - ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    const cached = stored();
    return cached && Array.isArray(cached.entries) ? cached.entries : undefined;
  }
}

function catalogueRoots(): Array<{ dir: string; name: string; repo: string }> {
  const root = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>("mcp.reposRoot", "")
    .trim();
  if (!root) {
    return [];
  }
  const found: Array<{ dir: string; name: string; repo: string }> = [];
  for (const group of GROUPS) {
    for (const name of group.dirs) {
      const dir = path.join(root, name, "src");
      if (fs.existsSync(dir)) {
        found.push({ dir, name, repo: group.repo });
      }
    }
  }
  return found;
}

/** Every ABAP class under a catalogue - the corpus is abapGit-shaped, so the
 *  naming convention is what tells a class from an include. */
function classFiles(dir: string, budget: { left: number }): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    if (budget.left <= 0) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget.left <= 0) {
        return;
      }
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".clas.abap") && !entry.name.endsWith(".testclasses.abap")) {
        out.push(full);
        budget.left--;
      }
    }
  };
  walk(dir);
  return out;
}

/** The control the command is about: the one under the cursor, or whatever
 *  the user types when the cursor is not on a builder call. */
async function askControl(editor: vscode.TextEditor | undefined): Promise<string | undefined> {
  const call =
    editor && editor.document.languageId === "abap"
      ? controlCallAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active))
      : undefined;
  if (call) {
    return call.control ?? call.label;
  }
  return vscode.window.showInputBox({
    title: "abap2UI5: examples for which control?",
    prompt: "A UI5 control name, e.g. sap.m.Table or Table",
    placeHolder: "sap.m.Table",
  });
}

function searchLocal(
  roots: ReadonlyArray<{ dir: string; name: string }>,
  control: string,
  log: (m: string) => void
): ExampleHit[] {
  const budget = { left: FILE_LIMIT };
  const hits: ExampleHit[] = [];
  for (const catalogue of roots) {
    for (const file of classFiles(catalogue.dir, budget)) {
      let source: string;
      try {
        source = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      hits.push(...findControlUses(source, control, { file, catalogue: catalogue.name }));
    }
  }
  log(`examples: ${control} - ${hits.length} use(s) in the local catalogues`);
  return rankExamples(hits);
}

type ExampleItem = vscode.QuickPickItem & ({ hit: ExampleHit } | { remote: CatalogueHit });

function quickPickItems(
  hits: readonly ExampleHit[],
  remote: readonly CatalogueHit[]
): Array<vscode.QuickPickItem | ExampleItem> {
  const items: Array<vscode.QuickPickItem | ExampleItem> = [];
  const separators = hits.length > 0 && remote.length > 0;
  if (separators) {
    items.push({ label: "in your checkouts", kind: vscode.QuickPickItemKind.Separator });
  }
  for (const hit of hits) {
    items.push({
      label: `$(symbol-class) ${path.basename(hit.file).replace(/\.clas\.abap$/i, "")}`,
      description: `${hit.catalogue} · ${hit.attributes} attribute${
        hit.attributes === 1 ? "" : "s"
      }`,
      detail: hit.text,
      hit,
    });
  }
  if (separators) {
    items.push({ label: "on github.com", kind: vscode.QuickPickItemKind.Separator });
  }
  for (const entry of remote) {
    items.push({
      label: `$(github) ${entry.className}`,
      description: `${entry.repo} · opens on GitHub`,
      detail: entry.summary ? `${entry.title} — ${entry.summary}` : entry.title,
      remote: entry,
    });
  }
  return items;
}

export function registerExamples(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("abap2ui5.showExamples", async () => {
      const control = await askControl(vscode.window.activeTextEditor);
      if (!control) {
        return;
      }
      let force = false;
      for (;;) {
        const roots = catalogueRoots();
        const searched = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: `abap2UI5: searching ${control}` },
          async () => {
            const hits = roots.length ? searchLocal(roots, control, log) : [];
            /* Each repository without a checkout is asked remotely - the
             * checkout stays primary, so a cloned samples-controls is never
             * shadowed by its own catalogue. */
            const remote: CatalogueHit[] = [];
            let remoteAnswered = false;
            for (const group of GROUPS) {
              if (roots.some((r) => r.repo === group.repo)) {
                continue;
              }
              const entries = await remoteEntries(context, group.repo, log, force);
              if (entries !== undefined) {
                remoteAnswered = true;
                remote.push(...matchCatalogue(entries, control, group.repo));
              }
            }
            return { hits, remote, remoteAnswered };
          }
        );
        const { hits, remote, remoteAnswered } = searched;
        if (!hits.length && !remote.length) {
          if (!roots.length && !remoteAnswered) {
            /* No checkout AND no fetch: name both ways out instead of
             * reporting "nothing found" for a corpus that was never there. */
            const pick = await vscode.window.showInformationMessage(
              "abap2UI5: no sample catalogue available - no local checkout under " +
                "abap2ui5.mcp.reposRoot, and the online catalogues could not be " +
                "fetched. Clone samples, samples-controls or samples-stack next " +
                "to each other and point the setting at the folder holding them, " +
                "or retry the download.",
              "Open setting",
              "Retry fetch"
            );
            if (pick === "Open setting") {
              await vscode.commands.executeCommand(
                "workbench.action.openSettings",
                "abap2ui5.mcp.reposRoot"
              );
              return;
            }
            if (pick === "Retry fetch") {
              force = true;
              continue;
            }
            return;
          }
          const sources = [
            ...new Set([
              ...roots.map((r) => r.name),
              ...GROUPS.filter((g) => !roots.some((r) => r.repo === g.repo)).map(
                (g) => `${g.repo} (online)`
              ),
            ]),
          ];
          vscode.window.showInformationMessage(
            `abap2UI5: no example of ${control} in ${sources.join(", ")}.`
          );
          return;
        }
        const picked = (await vscode.window.showQuickPick(quickPickItems(hits, remote), {
          title: `${hits.length + remote.length} example(s) of ${control}`,
          matchOnDetail: true,
          placeHolder: "Richest example first - pick one to open it at the line",
        })) as ExampleItem | undefined;
        if (!picked) {
          return;
        }
        if ("remote" in picked) {
          await vscode.env.openExternal(vscode.Uri.parse(picked.remote.url));
          return;
        }
        const doc = await vscode.workspace.openTextDocument(picked.hit.file);
        const editor = await vscode.window.showTextDocument(doc, { preview: true });
        const at = new vscode.Position(picked.hit.line - 1, 0);
        editor.selection = new vscode.Selection(at, at);
        editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenter);
        return;
      }
    })
  );
  log("examples: command registered");
}
