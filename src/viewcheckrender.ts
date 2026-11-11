import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { run } from "./childproc";
import {
  installRenderGate,
  noteRenderGateFailure,
  renderGateBrowsers,
  renderGateCli,
  renderGateState,
} from "./rendergate";
import { VIEW_CHECK_DIRS } from "./repolayout";
import { LINTER_RELEASE } from "./linterrelease";
import {
  augmentedPath,
  CheckerCommand,
  checkerCwd,
  parseRenderReport,
  RenderGateOutcome,
  RenderResult,
  resolveCheckerCommand,
  scratchFileName,
} from "./checkcore";
import { config } from "./viewcheckoptions";

/*
 * viewcheckrender - the view check's call of the external render gate: which
 * checker to start (`checkerCommand`), with which environment, and one run of
 * it over a scratch copy of the document (`runRenderGate`). Split out of
 * viewcheck.ts, which re-exports `checkerCommand` and `spawnEnv` and decides
 * WHETHER the gate runs (`checkDocument`). The two things registration hands
 * in live here and are set through `setRenderGateHost` alone.
 */

/** Set by registerViewCheck - checkerCommand needs the extension's global
 *  storage to find a self-installed render gate. */
let extContext: vscode.ExtensionContext | undefined;

/** Set by registerViewCheck - what a failed install's "Show Log" button
 *  reveals, the same channel extension.ts hands to installRenderGate. */
let showLogFn: (() => void) | undefined;

/** Called by registerViewCheck, once. */
export function setRenderGateHost(
  context: vscode.ExtensionContext,
  showLog: (() => void) | undefined
): void {
  extContext = context;
  showLogFn = showLog;
}

// ---------------------------------------------------------------------------
// External render gate (optional)
// ---------------------------------------------------------------------------

/** The render gate's command, resolved from the settings and what is
 *  installed - the decision itself lives in `checkcore.ts`. The systemless
 *  preview spawns the same binary, so this is the one place that knows how to
 *  find it. */
export function checkerCommand(): CheckerCommand {
  const gateCli = extContext ? renderGateCli(extContext) : undefined;
  return resolveCheckerCommand({
    explicit: config().get<string>("viewCheck.command", ""),
    installedGate:
      gateCli && extContext
        ? { cli: gateCli, browsersPath: renderGateBrowsers(extContext) }
        : undefined,
    reposRoot: config().get<string>("mcp.reposRoot", ""),
    checkoutDirs: VIEW_CHECK_DIRS,
    exists: (file) => fs.existsSync(file),
    linterCommit: LINTER_RELEASE.commit,
  });
}

/** See `augmentedPath` - the environment to spawn npx with. */
export function spawnEnv(): NodeJS.ProcessEnv {
  const PATH = augmentedPath(process.platform, process.env.PATH);
  return PATH === process.env.PATH ? process.env : { ...process.env, PATH };
}

/**
 * How long the render gate may take before it is killed. Launching Chromium
 * and rendering a view is seconds; the npx fallback resolving a GitHub
 * dependency on a slow line is tens of them. Beyond this something is stuck -
 * and without a limit every save added another stuck child that nothing ever
 * reaped, with `checkDocument` waiting on the first one forever.
 */
const RENDER_TIMEOUT_MS = 180_000;

/** What one render-gate run produced: the report when there is one, and in
 *  every other case WHY there is none - a timeout, a checker that could not be
 *  started and an unreadable report are all "the render half did not run", and
 *  the check has to be able to say so instead of showing an empty result. */
export interface RenderRun {
  outcome: RenderGateOutcome;
  result?: RenderResult;
}

export async function runRenderGate(
  doc: vscode.TextDocument,
  log: (m: string) => void,
  superseded: () => boolean
): Promise<RenderRun> {
  const scratchDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "abap2ui5-viewcheck-")
  );
  const scratch = path.join(scratchDir, scratchFileName(doc.fileName));
  try {
    fs.writeFileSync(scratch, doc.getText());
  } catch (err) {
    // before the try/finally below owns the directory - a full disk must not
    // leave it behind
    fs.rmSync(scratchDir, { recursive: true, force: true });
    throw err;
  }

  const checker = checkerCommand();
  const useShell = checker.cmd !== "node" && process.platform === "win32";
  /* `--no-config`: the CLI is run over a SCRATCH COPY in the temp directory,
   * and its config discovery walks up from cwd (the workspace) and from the
   * scratch file's path. Two things follow from that, both unwanted here.
   * The workspace's own `abap2ui5lint.jsonc` would be discovered and its
   * `badge` written on every save/on-demand check - the editor silently
   * clobbering a repository's committed shields.io badge with a one-file
   * verdict. And a config sitting anywhere above the world-writable temp
   * directory (or above the home directory, the ADT fallback cwd) would be
   * honoured for a file that is not in that tree at all. The extension does
   * not need the CLI to read the config: `optionsFor` discovers it from the
   * real document's own folder, and `settleRenderErrors` re-applies
   * `rules['render-error']` over the real file precisely because the CLI's
   * scratch-copy application is unreliable. So the render half runs in
   * isolation and the repository's config governs it through the extension. */
  const args = [...checker.args, scratch, "--json", "--advisory", "--no-properties", "--no-config"];
  const cwd = checkerCwd(
    vscode.workspace.getWorkspaceFolder(doc.uri)?.uri,
    os.homedir(),
    (dir) => fs.existsSync(dir)
  );
  log(`view-check: render gate - ${checker.cmd} ${args.join(" ")}`);

  try {
    // `run` quotes the PROGRAM as well as its arguments under a shell, which
    // this call site did not: an explicit `viewCheck.command` naming
    // `C:\Program Files\nodejs\node.exe` was split at the space by cmd.exe
    // and reported as "not recognized", with an offer to install a gate that
    // could not have fixed it.
    const outcome = await run(
      checker.cmd === "node" ? process.execPath : checker.cmd,
      args,
      checker.cmd === "node"
        ? {
            // run with the Node.js inside VS Code itself - works without any
            // node installation on the PATH
            cwd,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...checker.env },
            timeoutMs: RENDER_TIMEOUT_MS,
            abandoned: superseded,
          }
        : {
            cwd,
            env: { ...spawnEnv(), ...checker.env },
            shell: useShell,
            timeoutMs: RENDER_TIMEOUT_MS,
            abandoned: superseded,
          }
    );

    if (outcome.kind === "abandoned") {
      // the buffer moved on, or the document was closed - nothing will be
      // done with this answer, so it was not paid for to the end
      log("view-check: render gate no longer needed - killed");
      return { outcome: "abandoned" };
    }
    if (outcome.kind === "timeout") {
      log(
        `view-check: render gate exceeded ${RENDER_TIMEOUT_MS} ms - killed, ` +
          "the property gate's findings still stand"
      );
      return { outcome: "timeout" };
    }
    if (outcome.kind === "spawn-failed") {
      log(`view-check: render gate failed to start - ${String(outcome.error)}`);
      const known = renderGateState(checker.installed).kind === "failed";
      noteRenderGateFailure(`${checker.cmd} could not be started`);
      if (!known) {
        void vscode.window
          .showWarningMessage(
            "abap2UI5: the render gate is enabled but its checker could not " +
              `be started (${checker.cmd} not found). Install it once - ` +
              "everything runs with VS Code's own runtime. The property " +
              "gate keeps working either way.",
            "Install Render Gate"
          )
          .then(async (pick) => {
            if (pick === "Install Render Gate" && extContext) {
              // a successful install clears the recorded failure itself -
              // installRenderGate owns that state
              await installRenderGate(extContext, log, showLogFn);
            }
          });
      }
      return { outcome: "spawn-failed" };
    }

    const parsed = parseRenderReport(outcome.stdout);
    if (!parsed.ok) {
      log(
        parsed.reason === "no-json"
          ? `view-check: render gate produced no JSON` +
              (outcome.stderr ? ` - stderr: ${outcome.stderr.slice(0, 400)}` : "")
          : parsed.reason === "not-rendered"
            ? "view-check: render gate did not render the view - the checker " +
              "has no UI5 runtime (@abap2ui5/linter-render); only the property " +
              "gate's findings stand"
            : `view-check: render gate returned broken JSON - ${parsed.detail}`
      );
      return { outcome: "no-report" };
    }
    return { outcome: "ok", result: parsed.result };
  } finally {
    /* On every path, including a throw: the scratch directory is this run's
     * alone. It used to be removed inside a timer callback, where a Windows
     * EBUSY (the killed child had not let go yet) threw with nothing to catch
     * it - the promise then never settled and its caller waited forever. */
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch (err) {
      log(`view-check: scratch directory left behind - ${String(err)}`);
    }
  }
}
