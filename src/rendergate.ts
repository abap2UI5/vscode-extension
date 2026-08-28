import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { createHash } from "crypto";
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
 * rolling tag and under an immutable per-commit tag. This build uses the
 * bundle of exactly the linter commit it pins (LINTER_PIN, injected by
 * esbuild from the lockfile), so what the render gate executes is what this
 * release was tested with.
 *
 * The rolling tag is NOT a fallback, and used to be. That made a merge to the
 * linter's main branch change what every already-installed extension
 * downloaded next - no version negotiation, no pull request, no changelog
 * between a commit there and a checker running on somebody's machine here. It
 * is the one path in this ecosystem where merging reaches end users directly,
 * and it reached them silently. A missing per-commit bundle is now an error
 * that says what to do, because "the pinned build is unavailable" and "here is
 * a different build" are not the same answer.
 *
 * `abap2ui5.viewCheck.rollingBundle` opts back in, for somebody deliberately
 * testing an unreleased linter.
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

/** Downloads to `dest` and returns the SHA-256 of what was written. */
async function download(url: string, dest: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download failed - HTTP ${res.status} for ${url}`);
  }
  const digest = createHash("sha256");
  await pipeline(
    Readable.fromWeb(res.body as import("stream/web").ReadableStream),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        digest.update(chunk);
        yield chunk;
      }
    },
    fs.createWriteStream(dest)
  );
  return digest.digest("hex");
}

/** Where the remembered digest of a bundle url lives. Keyed by url, so the
 *  rolling bundle (which is MEANT to change) and each per-commit bundle are
 *  tracked apart. */
const digestKey = (url: string): string => `abap2ui5.bundleDigest:${url}`;

/**
 * What this build is willing to execute from a downloaded archive.
 *
 * The bundle is fetched over HTTPS and then extracted and run with VS Code's
 * Node - so whoever can change that release asset chooses code that runs on
 * every machine that installs the gate. Pinning the URL to a per-commit tag
 * pins WHICH asset, not WHAT IS IN IT.
 *
 * Two checks, strongest first:
 *
 * 1. A `<bundle>.sha256` sibling asset, when the linter publishes one: authoritative,
 *    and a mismatch is refused outright. (It does not publish one today; this
 *    closes the gap the moment it does, with no release here.)
 * 2. Otherwise trust-on-first-use, per url. A per-commit tag is supposed to be
 *    IMMUTABLE, so the same url answering with different bytes than last time
 *    is precisely the signal worth stopping on - it cannot happen by accident.
 *
 * Neither protects a first install against a bundle that was already
 * tampered with; say so rather than implying otherwise.
 */
async function verifyBundle(
  context: vscode.ExtensionContext,
  url: string,
  actual: string,
  log: (m: string) => void
): Promise<void> {
  let published: string | undefined;
  try {
    const res = await fetch(`${url}.sha256`);
    if (res.ok) {
      // `<hex>  view-check-bundle.tgz`, the shasum(1) format
      const hex = /\b([0-9a-f]{64})\b/i.exec(await res.text())?.[1];
      published = hex?.toLowerCase();
    }
  } catch {
    // no checksum asset published, or offline mid-install - fall through to
    // the remembered digest, which is the check that does not need the network
  }
  if (published) {
    if (published !== actual) {
      throw new Error(
        `bundle checksum mismatch - the published sha256 is ${published.slice(0, 12)}… ` +
          `but the download hashes to ${actual.slice(0, 12)}…. Nothing was installed.`
      );
    }
    log(`render-gate: bundle sha256 ${actual.slice(0, 12)}… matches the published checksum`);
    await context.globalState.update(digestKey(url), actual);
    return;
  }

  const remembered = context.globalState.get<string>(digestKey(url));
  if (remembered && remembered !== actual) {
    throw new Error(
      "bundle changed since it was last installed from the same URL. That URL " +
        "names one immutable linter commit, so its content should never move. " +
        `Expected ${remembered.slice(0, 12)}…, got ${actual.slice(0, 12)}…. ` +
        "Nothing was installed."
    );
  }
  await context.globalState.update(digestKey(url), actual);
  log(
    `render-gate: bundle sha256 ${actual.slice(0, 12)}…` +
      (remembered ? " (unchanged since the last install)" : " (first install from this URL)")
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
        const allowRolling = vscode.workspace
          .getConfiguration("abap2ui5")
          .get<boolean>("viewCheck.rollingBundle", false);

        let bundleUrl: string;
        let digest: string;
        if (PINNED_BUNDLE_URL && !allowRolling) {
          try {
            bundleUrl = PINNED_BUNDLE_URL;
            digest = await download(PINNED_BUNDLE_URL, tgz);
            log(`render-gate: bundle ${LINTER_PIN.slice(0, 12)} (matches the pinned linter)`);
          } catch (e) {
            throw new Error(
              `no render-gate bundle published for linter commit ${LINTER_PIN.slice(0, 12)}, ` +
                `which is the one this extension build was tested against. ` +
                `Update the extension - a newer build pins a linter commit that has one - or set ` +
                `abap2ui5.viewCheck.rollingBundle to accept the linter's current main instead. ` +
                `(${e instanceof Error ? e.message : String(e)})`
            );
          }
        } else {
          bundleUrl = ROLLING_BUNDLE_URL;
          digest = await download(ROLLING_BUNDLE_URL, tgz);
          log(
            PINNED_BUNDLE_URL
              ? "render-gate: rolling bundle (abap2ui5.viewCheck.rollingBundle) - this is the linter's current main, not the commit this build pins"
              : "render-gate: rolling bundle - this build pins no linter commit"
          );
        }

        // before anything out of the archive is unpacked, let alone run
        progress.report({ message: "verifying the download..." });
        await verifyBundle(context, bundleUrl, digest, log);

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
    /*
     * Only the half-built one goes - whatever was installed before is still
     * where it was, and still works.
     *
     * `previous` goes with it. A failure AFTER the swap leaves the old
     * installation parked under that name, and nothing but the next install
     * attempt would ever remove it - which is a third of a gigabyte
     * (Chromium included) sitting in global storage for someone who just
     * decided not to try again.
     */
    fs.rmSync(staging, { recursive: true, force: true });
    if (fs.existsSync(dir)) {
      fs.rmSync(previous, { recursive: true, force: true });
    }
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
