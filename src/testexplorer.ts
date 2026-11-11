import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { CONFIG_SECTION } from "./settings";
import { SERVER_DIRS } from "./repolayout";
import { checkoutEnv } from "./mcp";
import { run } from "./childproc";
import { onDidChangeTestInclude } from "./codelens";
import { trustedOrExplain } from "./unittests";
import {
  classOfFile,
  resolveUnitRunner,
  unitTestArgs,
  unitTestBanner,
  unitTestCommandLine,
} from "./unitrunner";
import { discoverTests, type SourceRange, type TestClass } from "./unitdiscovery";
import { outcomesFor, parseUnitReport, type TestOutcome, type UnitResult } from "./unitresults";

/*
 * The app's ABAP Unit tests in the Testing view - the plumbing around
 * `unitdiscovery.ts` (what a test include holds) and `unitresults.ts` (what
 * the runner's `--json` report says), run by the same `abap2ui5-unit` the
 * terminal command starts (`unitrunner.ts`).
 *
 * Desktop only: registered from `src/extension.ts` alone, because a run is a
 * child process.
 *
 * Lazy by construction. Creating the controller reads nothing and starts
 * nothing; the workspace is searched for test includes when the Testing view
 * asks (the controller's resolve handler, or a run of "everything"), and one
 * include is parsed when it is expanded there, opened in an editor or run.
 * The exception that costs nothing: a test include already open in the
 * window is listed from the text the editor holds.
 *
 * What a run can and cannot say follows the runner (see unitresults.ts): it
 * filters by global class, so running one method runs its class and marks
 * only the method that was asked for; it reports no source line, so a
 * failure is shown at the method's declaration; and it stops at the first
 * failure, so what it never reached is marked skipped, not passed.
 */

const INCLUDE_GLOB = "**/*.clas.testclasses.abap";
const EXCLUDE = "**/node_modules/**";
/** A first run clones or installs the framework and builds; half an hour is
 *  past any of that and short of "forever" for a runner that hangs. */
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

type Level = "include" | "class" | "method";

interface ItemData {
  level: Level;
  /** The include's file. */
  file: string;
  testClass?: string;
  method?: string;
}

function isTestInclude(uri: vscode.Uri): boolean {
  return uri.scheme === "file" && /\.clas\.testclasses\.abap$/i.test(uri.fsPath);
}

function toRange(range: SourceRange): vscode.Range {
  return new vscode.Range(
    range.startLine,
    range.startCharacter,
    range.endLine,
    range.endCharacter
  );
}

export function registerTestExplorer(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): void {
  const controller = vscode.tests.createTestController(
    "abap2ui5.unitTests",
    "abap2UI5 Unit Tests (No System)"
  );
  const data = new WeakMap<vscode.TestItem, ItemData>();
  /** The includes whose text has been read into children. */
  const parsed = new WeakSet<vscode.TestItem>();
  /** Whether the workspace has been searched - from then on a created
   *  include is added; before, nothing is listed that nobody asked for. */
  /** Where each test class declares its fixtures, by class item id. */
  const fixtures = new Map<string, Map<string, vscode.Range>>();
  let swept = false;
  let sweeping: Promise<void> | undefined;

  const includeItem = (uri: vscode.Uri): vscode.TestItem => {
    const id = uri.toString();
    const known = controller.items.get(id);
    if (known) {
      return known;
    }
    const item = controller.createTestItem(
      id,
      (classOfFile(uri.fsPath) ?? path.basename(uri.fsPath)).toUpperCase(),
      uri
    );
    item.description = vscode.workspace.asRelativePath(path.dirname(uri.fsPath), true);
    item.canResolveChildren = true;
    data.set(item, { level: "include", file: uri.fsPath });
    controller.items.add(item);
    return item;
  };

  /** The include's classes and methods as the item's children - replaced
   *  whole, with ids that survive a re-parse so results stay on their test. */
  const setChildren = (item: vscode.TestItem, classes: readonly TestClass[]): void => {
    const uri = item.uri;
    const file = data.get(item)?.file;
    if (!uri || !file) {
      return;
    }
    const children: vscode.TestItem[] = [];
    for (const cls of classes) {
      const classId = `${item.id}::${cls.name.toLowerCase()}`;
      const classItem = controller.createTestItem(classId, cls.name, uri);
      classItem.range = toRange(cls.range);
      data.set(classItem, { level: "class", file, testClass: cls.name });
      const methods: vscode.TestItem[] = [];
      for (const method of cls.methods) {
        const methodItem = controller.createTestItem(
          `${classId}::${method.name.toLowerCase()}`,
          method.name,
          uri
        );
        methodItem.range = toRange(method.range);
        data.set(methodItem, {
          level: "method",
          file,
          testClass: cls.name,
          method: method.name,
        });
        methods.push(methodItem);
      }
      classItem.children.replace(methods);
      fixtures.set(
        classId,
        new Map(cls.fixtures.map((f) => [f.name.toLowerCase(), toRange(f.range)]))
      );
      children.push(classItem);
    }
    item.children.replace(children);
    item.error = undefined;
    parsed.add(item);
  };

  /** Parses one include: from the open document when there is one (it may
   *  be ahead of the disk), from the file otherwise. */
  const parseInclude = async (item: vscode.TestItem): Promise<void> => {
    const uri = item.uri;
    if (!uri) {
      return;
    }
    const open = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === uri.toString()
    );
    try {
      const text = open
        ? open.getText()
        : new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(uri));
      setChildren(item, discoverTests(text));
    } catch (err) {
      item.children.replace([]);
      item.error = `The test include could not be read: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  };

  const sweep = (): Promise<void> => {
    sweeping ??= (async () => {
      try {
        const found = await vscode.workspace.findFiles(INCLUDE_GLOB, EXCLUDE);
        const live = new Set<string>();
        for (const uri of found) {
          if (isTestInclude(uri)) {
            live.add(includeItem(uri).id);
          }
        }
        controller.items.forEach((item) => {
          if (!live.has(item.id)) {
            controller.items.delete(item.id);
          }
        });
        swept = true;
        log(`test explorer: ${live.size} test include(s) in the workspace`);
      } finally {
        sweeping = undefined;
      }
    })();
    return sweeping;
  };

  controller.resolveHandler = async (item) => {
    if (!item) {
      await sweep();
      return;
    }
    if (data.get(item)?.level === "include") {
      await parseInclude(item);
    }
  };
  controller.refreshHandler = async () => {
    await sweep();
    const again: Promise<void>[] = [];
    controller.items.forEach((item) => {
      if (parsed.has(item)) {
        again.push(parseInclude(item));
      }
    });
    await Promise.all(again);
  };

  /** A test include shown in the window: listed, from the editor's text. */
  const fromDocument = (doc: vscode.TextDocument): void => {
    if (isTestInclude(doc.uri)) {
      setChildren(includeItem(doc.uri), discoverTests(doc.getText()));
    }
  };

  /** Typing re-reads the include once it rests - the lexer walks the whole
   *  text, which is not worth doing per keystroke. */
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const later = (doc: vscode.TextDocument): void => {
    const key = doc.uri.toString();
    clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        if (!doc.isClosed) {
          fromDocument(doc);
        }
      }, 400)
    );
  };

  // ------------------------------------------------------------- a run ----

  /** The method items a request means, with the include each belongs to. */
  const wantedMethods = async (
    request: vscode.TestRunRequest
  ): Promise<Map<vscode.TestItem, vscode.TestItem[]>> => {
    if (!request.include && !swept) {
      await sweep(); // "run all" before the view ever listed anything
    }
    const excluded = new Set(request.exclude ?? []);
    const byInclude = new Map<vscode.TestItem, vscode.TestItem[]>();
    const roots: vscode.TestItem[] = [];
    if (request.include) {
      roots.push(...request.include);
    } else {
      controller.items.forEach((item) => roots.push(item));
    }
    const includeOf = (item: vscode.TestItem): vscode.TestItem | undefined => {
      let at: vscode.TestItem | undefined = item;
      while (at?.parent) {
        at = at.parent;
      }
      return at;
    };
    const visit = async (item: vscode.TestItem): Promise<void> => {
      if (excluded.has(item)) {
        return;
      }
      const level = data.get(item)?.level;
      if (level === "include" && !parsed.has(item)) {
        await parseInclude(item);
      }
      if (level === "method") {
        const include = includeOf(item);
        if (include) {
          byInclude.set(include, [...(byInclude.get(include) ?? []), item]);
        }
        return;
      }
      const children: vscode.TestItem[] = [];
      item.children.forEach((child) => children.push(child));
      for (const child of children) {
        await visit(child);
      }
    };
    for (const root of roots) {
      await visit(root);
    }
    return byInclude;
  };

  const message = (outcome: TestOutcome, item: vscode.TestItem): vscode.TestMessage => {
    const text = outcome.message ?? "The test failed.";
    const msg =
      outcome.expected !== undefined && outcome.actual !== undefined
        ? vscode.TestMessage.diff(text, outcome.expected, outcome.actual)
        : new vscode.TestMessage(text);
    // the runner's line when a runner reports one; the declaration otherwise
    if (item.uri) {
      const range =
        outcome.line !== undefined && (!outcome.file || sameFile(outcome.file, item.uri.fsPath))
          ? new vscode.Range(outcome.line - 1, 0, outcome.line - 1, 0)
          : item.range;
      if (range) {
        msg.location = new vscode.Location(item.uri, range);
      }
    }
    return msg;
  };

  const sameFile = (reported: string, file: string): boolean =>
    path.basename(reported).toLowerCase() === path.basename(file).toLowerCase();

  const report = (
    testRun: vscode.TestRun,
    includes: Map<vscode.TestItem, vscode.TestItem[]>,
    results: readonly UnitResult[]
  ): void => {
    for (const [include, methods] of includes) {
      const cls = classOfFile(data.get(include)?.file ?? "") ?? "";
      const outcomes = outcomesFor(
        results,
        methods.map((item) => ({
          cls,
          testClass: data.get(item)?.testClass ?? "",
          method: data.get(item)?.method ?? "",
        }))
      );
      methods.forEach((item, i) => {
        const outcome = outcomes[i];
        if (outcome.status === "passed") {
          testRun.passed(item);
        } else if (outcome.status === "failed") {
          testRun.failed(item, message(outcome, item));
        } else if (outcome.status === "errored") {
          testRun.errored(item, message(outcome, item));
        } else {
          testRun.skipped(item);
          if (outcome.message) {
            testRun.appendOutput(`${item.label}: ${outcome.message}\r\n`, undefined, item);
          }
        }
      });
      // a fixture that threw belongs to no test method: shown on the test
      // class it is declared in, at its declaration where there is one
      for (const result of results) {
        if (!result.fixture || result.cls !== cls) {
          continue;
        }
        let target: vscode.TestItem | undefined = include;
        if (result.testClass) {
          target = include.children.get(`${include.id}::${result.testClass.toLowerCase()}`);
        }
        const cause = target;
        if (!cause || (cause !== include && !methods.some((m) => m.parent === cause))) {
          continue;
        }
        const msg = new vscode.TestMessage(
          `${result.method} failed before a test method ran.\n\n${result.message ?? ""}`
        );
        const at = fixtures.get(cause.id)?.get(result.method.toLowerCase()) ?? cause.range;
        if (cause.uri && at) {
          msg.location = new vscode.Location(cause.uri, at);
        }
        testRun.failed(cause, msg);
      }
    }
  };

  const runHandler = async (
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
  ): Promise<void> => {
    if (!(await trustedOrExplain())) {
      return;
    }
    const includes = await wantedMethods(request);
    if (!includes.size || token.isCancellationRequested) {
      return;
    }
    const testRun = controller.createTestRun(request);
    const output = (text: string): void => testRun.appendOutput(text.replace(/\r?\n/g, "\r\n"));
    try {
      // one runner per project folder: it reads that folder's abaplint.jsonc
      const byFolder = new Map<string, Map<vscode.TestItem, vscode.TestItem[]>>();
      for (const [include, methods] of includes) {
        const file = data.get(include)?.file ?? "";
        const cwd =
          vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath ??
          path.dirname(file);
        const group = byFolder.get(cwd) ?? new Map<vscode.TestItem, vscode.TestItem[]>();
        group.set(include, methods);
        byFolder.set(cwd, group);
        methods.forEach((item) => testRun.enqueued(item));
      }
      for (const [cwd, group] of byFolder) {
        if (token.isCancellationRequested) {
          break;
        }
        const all = [...group.values()].flat();
        all.forEach((item) => testRun.started(item));
        // the same *_HOME variables, program and arguments the terminal
        // command uses - plus the report flag
        const env = checkoutEnv();
        const home = env.A2UI5_HOME;
        const runner = resolveUnitRunner({
          reposRoot: vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .get<string>("mcp.reposRoot", ""),
          serverDirs: SERVER_DIRS,
          exists: (file) => fs.existsSync(file),
        });
        const args = unitTestArgs({
          cwd,
          classFiles: [...group.keys()].map((include) => data.get(include)?.file ?? ""),
          home,
          json: true,
          exists: (dir) => fs.existsSync(dir),
        });
        const line = unitTestCommandLine(runner, args, process.platform);
        output(`${unitTestBanner(runner, home).join("\n")}\n> ${line}\n`);
        log(`test explorer: (${runner.source}) ${line} - in ${cwd}`);
        const outcome = await run(runner.cmd, [...runner.args, ...args], {
          cwd,
          env: { ...process.env, ...env },
          // npx is npx.cmd on Windows, which only a shell starts
          shell: process.platform === "win32" && runner.cmd === "npx",
          timeoutMs: RUN_TIMEOUT_MS,
          abandoned: () => token.isCancellationRequested,
          onStderr: output,
        });
        if (outcome.kind === "abandoned") {
          all.forEach((item) => testRun.skipped(item));
          break;
        }
        let results: UnitResult[];
        if (outcome.kind === "closed") {
          results = parseUnitReport(outcome.stdout, {
            code: outcome.code,
            stderr: outcome.stderr,
          });
        } else {
          results = [
            {
              cls: "",
              testClass: "",
              method: "",
              status: "errored",
              message:
                outcome.kind === "timeout"
                  ? `The unit test runner did not finish within ${RUN_TIMEOUT_MS / 60000} minutes and was stopped.`
                  : `The unit test runner could not be started (${runner.cmd}): ${outcome.error.message}`,
            },
          ];
        }
        const broken = results.find((r) => !r.cls && r.status === "errored");
        if (broken?.message) {
          output(`${broken.message}\n`);
        }
        report(testRun, group, results);
      }
    } finally {
      testRun.end();
    }
  };

  controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, runHandler, true);

  context.subscriptions.push(
    controller,
    { dispose: () => pending.forEach((timer) => clearTimeout(timer)) },
    // the one test-include watcher (codelens.ts)
    onDidChangeTestInclude(({ kind, uri }) => {
      if (!isTestInclude(uri)) {
        return;
      }
      const known = controller.items.get(uri.toString());
      if (kind === "delete") {
        controller.items.delete(uri.toString());
      } else if (known) {
        if (parsed.has(known)) {
          void parseInclude(known);
        }
      } else if (swept) {
        includeItem(uri);
      }
    }),
    vscode.workspace.onDidOpenTextDocument(fromDocument),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isTestInclude(e.document.uri)) {
        later(e.document);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (swept) {
        void sweep();
      }
    })
  );
  // already open when the extension activated: no file is read for these
  vscode.workspace.textDocuments.forEach(fromDocument);
}
