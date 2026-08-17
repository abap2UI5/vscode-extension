import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { controlCallAt } from "./context";
import { ExampleHit, findControlUses, rankExamples } from "./examples";
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
 */

const CONFIG_SECTION = "abap2ui5";

/** Where the catalogues live, newest directory name first - the same names
 *  the MCP registration probes for. */
const CATALOGUES = [...SAMPLES_DIRS, ...CORPUS_DIRS, ...SAMPLES_STACK_DIRS];

/** A corpus is thousands of classes; the walk stays bounded so a mistyped
 *  repos root pointing at a home directory cannot turn this into a
 *  filesystem crawl. */
const FILE_LIMIT = 4000;

function catalogueRoots(): Array<{ dir: string; name: string }> {
  const root = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>("mcp.reposRoot", "")
    .trim();
  if (!root) {
    return [];
  }
  const found: Array<{ dir: string; name: string }> = [];
  for (const name of CATALOGUES) {
    const dir = path.join(root, name, "src");
    if (fs.existsSync(dir)) {
      found.push({ dir, name });
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

function search(control: string, log: (m: string) => void): ExampleHit[] {
  const budget = { left: FILE_LIMIT };
  const hits: ExampleHit[] = [];
  for (const catalogue of catalogueRoots()) {
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
  log(`examples: ${control} - ${hits.length} use(s) in the catalogues`);
  return rankExamples(hits);
}

export function registerExamples(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("abap2ui5.showExamples", async () => {
      const roots = catalogueRoots();
      if (!roots.length) {
        /* The catalogues are git checkouts, not something the extension
         * ships - so the honest answer names the setting and offers to open
         * it, rather than reporting "nothing found" for a corpus that was
         * never there. */
        const pick = await vscode.window.showInformationMessage(
          "abap2UI5: no sample catalogue found. Clone samples, samples-controls " +
            "or samples-stack next to each other and point " +
            "abap2ui5.mcp.reposRoot at the folder holding them.",
          "Open setting"
        );
        if (pick === "Open setting") {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "abap2ui5.mcp.reposRoot"
          );
        }
        return;
      }
      const control = await askControl(vscode.window.activeTextEditor);
      if (!control) {
        return;
      }
      const hits = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `abap2UI5: searching ${control}` },
        async () => search(control, log)
      );
      if (!hits.length) {
        vscode.window.showInformationMessage(
          `abap2UI5: no example of ${control} in ${roots
            .map((r) => r.name)
            .join(", ")}.`
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        hits.map((hit) => ({
          label: `$(symbol-class) ${path.basename(hit.file).replace(/\.clas\.abap$/i, "")}`,
          description: `${hit.catalogue} · ${hit.attributes} attribute${
            hit.attributes === 1 ? "" : "s"
          }`,
          detail: hit.text,
          hit,
        })),
        {
          title: `${hits.length} example(s) of ${control}`,
          matchOnDetail: true,
          placeHolder: "Richest example first - pick one to open it at the line",
        }
      );
      if (!picked) {
        return;
      }
      const doc = await vscode.workspace.openTextDocument(picked.hit.file);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      const at = new vscode.Position(picked.hit.line - 1, 0);
      editor.selection = new vscode.Selection(at, at);
      editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenter);
    })
  );
  log("examples: command registered");
}
