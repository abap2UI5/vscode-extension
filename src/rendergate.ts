import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import * as tar from "tar";
import { CONFIG_SECTION } from "./settings";

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
  log: (m: string) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    // the signal is what makes Cancel work DURING the Chromium download -
    // without it the button only took effect once playwright was through
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...extraEnv },
      signal,
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

/** How long the bundle download may take before it is treated as stuck. A
 *  fetch without a limit that stalls silently never settles - and with it
 *  the install, whose guard flag then refuses every retry. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** Downloads to `dest` and returns the SHA-256 of what was written. */
async function download(
  url: string,
  dest: string,
  signal: AbortSignal
): Promise<string> {
  const res = await fetch(url, { signal });
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
    fs.createWriteStream(dest),
    { signal }
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
    const res = await fetch(`${url}.sha256`, {
      signal: AbortSignal.timeout(10_000),
    });
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
    // The rolling tag is republished on every linter merge - a changed
    // digest there is the expected case, not the alarm.
    if (url === ROLLING_BUNDLE_URL) {
      log(
        `render-gate: rolling bundle moved since the last install ` +
          `(${remembered.slice(0, 12)}… -> ${actual.slice(0, 12)}…) - expected for a rolling tag`
      );
    } else {
      throw new Error(
        "bundle changed since it was last installed from the same URL. That URL " +
          "names one immutable linter commit, so its content should never move. " +
          `Expected ${remembered.slice(0, 12)}…, got ${actual.slice(0, 12)}…. ` +
          "Nothing was installed."
      );
    }
  }
  await context.globalState.update(digestKey(url), actual);
  log(
    `render-gate: bundle sha256 ${actual.slice(0, 12)}…` +
      (remembered ? " (unchanged since the last install)" : " (first install from this URL)")
  );
}

/** Download the checker bundle and Chromium into global storage. Returns
 *  true when the gate is ready afterwards. `showLog` reveals the output
 *  channel the failure message points at - one click instead of a hunt
 *  through View → Output. */
export async function installRenderGate(
  context: vscode.ExtensionContext,
  log: (m: string) => void,
  showLog?: () => void
): Promise<boolean> {
  if (installing) {
    log("render-gate: an install is already running - not starting a second one");
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
  const aborter = new AbortController();
  const timeout = setTimeout(
    () => aborter.abort(new Error("download timed out")),
    DOWNLOAD_TIMEOUT_MS
  );
  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "abap2UI5: installing the render gate",
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() =>
          aborter.abort(new Error("install cancelled"))
        );
        progress.report({ message: "downloading the checker bundle (~30 MB)..." });
        log(`render-gate: installing to ${dir}`);
        // rm/promises: the leftovers can be a third of a gigabyte (Chromium
        // included), and a sync removal blocks the whole extension host
        await fs.promises.rm(staging, { recursive: true, force: true });
        fs.mkdirSync(staging, { recursive: true });
        const tgz = path.join(staging, "bundle.tgz");
        const allowRolling = vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<boolean>("viewCheck.rollingBundle", false);

        let bundleUrl: string;
        let digest: string;
        if (PINNED_BUNDLE_URL && !allowRolling) {
          try {
            bundleUrl = PINNED_BUNDLE_URL;
            digest = await download(PINNED_BUNDLE_URL, tgz, aborter.signal);
            log(`render-gate: bundle ${LINTER_PIN.slice(0, 12)} (matches the pinned linter)`);
          } catch (e) {
            if (aborter.signal.aborted) {
              throw aborter.signal.reason instanceof Error
                ? aborter.signal.reason
                : e;
            }
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
          digest = await download(ROLLING_BUNDLE_URL, tgz, aborter.signal);
          log(
            PINNED_BUNDLE_URL
              ? "render-gate: rolling bundle (abap2ui5.viewCheck.rollingBundle) - this is the linter's current main, not the commit this build pins"
              : "render-gate: rolling bundle - this build pins no linter commit"
          );
        }

        // before anything out of the archive is unpacked, let alone run
        progress.report({ message: "verifying the download..." });
        await verifyBundle(context, bundleUrl, digest, log);
        // the downloads the deadline guards are through - disarmed here so
        // it cannot fire a pointless abort into a long Chromium install
        clearTimeout(timeout);

        progress.report({ message: "extracting..." });
        await tar.x({ file: tgz, cwd: staging });
        await fs.promises.rm(tgz, { force: true });
        if (!fs.existsSync(path.join(staging, "cli.mjs"))) {
          throw new Error("bundle did not contain cli.mjs");
        }
        if (token.isCancellationRequested) {
          throw new Error("install cancelled");
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
          log,
          aborter.signal
        );
        if (token.isCancellationRequested) {
          throw new Error("install cancelled");
        }

        // the download is through and the bundle is complete - only now does
        // the installation that was there make way
        await fs.promises.rm(previous, { recursive: true, force: true });
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
        await fs.promises.rm(previous, { recursive: true, force: true });

        log("render-gate: installed");
        await vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .update("viewCheck.render", true, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          "abap2UI5: render gate installed - from now on view checks also " +
            "render the view in headless Chromium."
        );
        return true;
      }
    );
  } catch (err) {
    // an aborted spawn reports a generic AbortError - the reason the abort
    // was requested with ("install cancelled", "download timed out") is the
    // message worth showing
    const cause =
      aborter.signal.aborted && aborter.signal.reason instanceof Error
        ? aborter.signal.reason
        : err;
    log(`render-gate: install failed - ${String(cause)}`);
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
    await fs.promises.rm(staging, { recursive: true, force: true });
    if (fs.existsSync(dir)) {
      await fs.promises.rm(previous, { recursive: true, force: true });
    }
    const buttons = showLog ? ["Show Log"] : [];
    void vscode.window
      .showErrorMessage(
        `abap2UI5: render gate install failed (${String(cause).slice(0, 120)}). ` +
          "Details in the abap2UI5 output channel.",
        ...buttons
      )
      .then((pick) => {
        if (pick === "Show Log") {
          showLog?.();
        }
      });
    return false;
  } finally {
    clearTimeout(timeout);
    installing = false;
  }
}

/**
 * What "abap2UI5: Update Render Gate" reports before reinstalling: which
 * bundle URL is in effect (the pinned per-commit one, or the rolling tag),
 * the linter commit this build pins, whether a gate is installed at all, and
 * the digest remembered for that URL - the trust-on-first-use anchor
 * `verifyBundle` compares the next download against.
 */
export function renderGateStatus(context: vscode.ExtensionContext): {
  installed: boolean;
  bundleUrl: string;
  /** The full SHA of the pinned linter commit; undefined in a dev build. */
  pinnedCommit?: string;
  /** The remembered sha256 of the effective bundle URL, when one download
   *  from it has been verified before. */
  storedDigest?: string;
} {
  const allowRolling = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<boolean>("viewCheck.rollingBundle", false);
  const bundleUrl =
    PINNED_BUNDLE_URL && !allowRolling ? PINNED_BUNDLE_URL : ROLLING_BUNDLE_URL;
  return {
    installed: renderGateCli(context) !== undefined,
    bundleUrl,
    pinnedCommit: LINTER_PIN || undefined,
    storedDigest: context.globalState.get<string>(digestKey(bundleUrl)),
  };
}

/** One-time offer to install the gate; shown when the render gate is wanted
 *  (or would be useful) but nothing is installed. */
export async function offerInstall(
  context: vscode.ExtensionContext,
  log: (m: string) => void,
  reason: string,
  showLog?: () => void
): Promise<void> {
  const pick = await vscode.window.showInformationMessage(
    `abap2UI5: ${reason}`,
    "Install Render Gate",
    "Not Now"
  );
  if (pick === "Install Render Gate") {
    await installRenderGate(context, log, showLog);
  }
}

export function registerRenderGate(
  context: vscode.ExtensionContext,
  log: (m: string) => void,
  showLog?: () => void
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("abap2ui5.installRenderGate", () =>
      installRenderGate(context, log, showLog)
    )
  );
}
