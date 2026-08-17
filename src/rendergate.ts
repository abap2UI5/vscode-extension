import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import * as tar from "tar";

/*
 * Self-installing render gate: downloads the self-contained checker bundle
 * (CLI + OpenUI5 runtime + playwright, published by abap2UI5-linter's CI)
 * into the extension's global storage and fetches
 * Chromium through playwright's own CLI - everything runs with VS Code's
 * bundled Node.js, so no node, npm or PATH setup is required on the
 * machine.
 *
 * Bundle selection: the linter CI publishes every bundle twice - under a
 * rolling tag and under an immutable per-commit tag. This build prefers the
 * bundle of exactly the linter commit it pins (LINTER_PIN, injected by
 * esbuild from the lockfile), so what the render gate executes matches what
 * this release was tested with; the rolling tag is the fallback when no
 * per-commit bundle exists for the pin.
 */

const ROLLING_BUNDLE_URL =
  "https://github.com/abap2UI5/linter/releases/download/render-gate-bundle/view-check-bundle.tgz";
// injected at build time by esbuild.js (define) from package-lock.json
const LINTER_PIN = process.env.LINTER_PIN || "";
const PINNED_BUNDLE_URL = LINTER_PIN
  ? `https://github.com/abap2UI5/linter/releases/download/render-gate-bundle-${LINTER_PIN.slice(0, 12)}/view-check-bundle.tgz`
  : undefined;

let installing = false;

function baseDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "render-gate");
}

/** Path of the installed checker CLI, or undefined when not installed. */
export function renderGateCli(
  context: vscode.ExtensionContext
): string | undefined {
  const cli = path.join(baseDir(context), "cli.mjs");
  return fs.existsSync(cli) ? cli : undefined;
}

/** The browsers directory the installed gate uses (PLAYWRIGHT_BROWSERS_PATH). */
export function renderGateBrowsers(context: vscode.ExtensionContext): string {
  return path.join(baseDir(context), "browsers");
}

function runWithVsCodeNode(
  args: string[],
  extraEnv: Record<string, string>,
  log: (m: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...extraEnv },
    });
    let stderr = "";
    child.stdout.on("data", (c) => {
      const line = String(c).trim();
      if (line) {
        log(`render-gate: ${line.slice(0, 200)}`);
      }
    });
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`exit code ${code}${stderr ? `: ${stderr.slice(0, 300)}` : ""}`))
    );
  });
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download failed - HTTP ${res.status} for ${url}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as import("stream/web").ReadableStream),
    fs.createWriteStream(dest)
  );
}

/** Download the checker bundle and Chromium into global storage. Returns
 *  true when the gate is ready afterwards. */
export async function installRenderGate(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): Promise<boolean> {
  if (installing) {
    return false;
  }
  installing = true;
  const dir = baseDir(context);
  // Built next to the real directory and swapped in only once it holds a
  // working gate: installing over the top used to delete the installation
  // first, so re-running the command offline left the user with no gate at
  // all instead of the one they already had.
  const staging = `${dir}.installing`;
  const previous = `${dir}.previous`;
  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "abap2UI5: installing the render gate",
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "downloading the checker bundle (~30 MB)..." });
        log(`render-gate: installing to ${dir}`);
        fs.rmSync(staging, { recursive: true, force: true });
        fs.mkdirSync(staging, { recursive: true });
        const tgz = path.join(staging, "bundle.tgz");
        if (PINNED_BUNDLE_URL) {
          try {
            await download(PINNED_BUNDLE_URL, tgz);
            log(`render-gate: bundle ${LINTER_PIN.slice(0, 12)} (matches the pinned linter)`);
          } catch {
            log(
              `render-gate: no per-commit bundle for ${LINTER_PIN.slice(0, 12)} - falling back to the rolling release`
            );
            await download(ROLLING_BUNDLE_URL, tgz);
          }
        } else {
          await download(ROLLING_BUNDLE_URL, tgz);
        }

        progress.report({ message: "extracting..." });
        await tar.x({ file: tgz, cwd: staging });
        fs.rmSync(tgz, { force: true });
        if (!fs.existsSync(path.join(staging, "cli.mjs"))) {
          throw new Error("bundle did not contain cli.mjs");
        }

        progress.report({
          message: "downloading Chromium for headless rendering (one time)...",
        });
        await runWithVsCodeNode(
          [
            path.join(staging, "node_modules", "playwright", "cli.js"),
            "install",
            "chromium",
          ],
          { PLAYWRIGHT_BROWSERS_PATH: path.join(staging, "browsers") },
          log
        );

        // the download is through and the bundle is complete - only now does
        // the installation that was there make way
        fs.rmSync(previous, { recursive: true, force: true });
        if (fs.existsSync(dir)) {
          fs.renameSync(dir, previous);
        }
        try {
          fs.renameSync(staging, dir);
        } catch (err) {
          if (fs.existsSync(previous) && !fs.existsSync(dir)) {
            fs.renameSync(previous, dir); // put the old one back
          }
          throw err;
        }
        fs.rmSync(previous, { recursive: true, force: true });

        log("render-gate: installed");
        await vscode.workspace
          .getConfiguration("abap2ui5")
          .update("viewCheck.render", true, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          "abap2UI5: render gate installed - from now on view checks also " +
            "render the view in headless Chromium."
        );
        return true;
      }
    );
  } catch (err) {
    log(`render-gate: install failed - ${String(err)}`);
    // only the half-built one goes - whatever was installed before is still
    // where it was, and still works
    fs.rmSync(staging, { recursive: true, force: true });
    vscode.window.showErrorMessage(
      `abap2UI5: render gate install failed (${String(err).slice(0, 120)}). ` +
        "Details in the abap2UI5 output channel."
    );
    return false;
  } finally {
    installing = false;
  }
}

/** One-time offer to install the gate; shown when the render gate is wanted
 *  (or would be useful) but nothing is installed. */
export async function offerInstall(
  context: vscode.ExtensionContext,
  log: (m: string) => void,
  reason: string
): Promise<void> {
  const pick = await vscode.window.showInformationMessage(
    `abap2UI5: ${reason}`,
    "Install render gate",
    "Not now"
  );
  if (pick === "Install render gate") {
    await installRenderGate(context, log);
  }
}

export function registerRenderGate(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("abap2ui5.installRenderGate", () =>
      installRenderGate(context, log)
    )
  );
}
