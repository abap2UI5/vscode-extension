import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { run } from "./childproc";
import { offerInstall, renderGateBrowsers } from "./rendergate";
import { safeFileStem } from "./previewcore";

/*
 * "Take App Screenshot" - the running app as a PNG, without leaving the
 * editor.
 *
 * A webview cannot rasterise a cross-origin iframe, so the screenshot is
 * taken the honest way: headless Chromium loads the same proxied URL the
 * preview shows (credentials injected by the auth proxy, so no login page)
 * and `--screenshot` writes the PNG. The Chromium is the one the render gate
 * installs - one download shared by both features; without it the command
 * offers the install.
 */

/** Where playwright's CLI puts the browser: <dir>/chromium-<build>/<platform>/…
 *  The newest build wins when several are installed - compared by the build
 *  NUMBER: sorted as strings, "chromium-999" beats "chromium-1181". */
export function findChromium(browsersDir: string): string | undefined {
  const buildNo = (name: string): number =>
    Number(/(\d+)$/.exec(name)?.[1] ?? 0);
  let builds: string[];
  try {
    builds = fs
      .readdirSync(browsersDir)
      .filter((e) => e.startsWith("chromium"))
      .sort((a, b) => buildNo(b) - buildNo(a));
  } catch {
    return undefined;
  }
  const layouts = [
    ["chrome-linux", "chrome"],
    ["chrome-linux64", "chrome"],
    ["chrome-win", "chrome.exe"],
    ["chrome-win64", "chrome.exe"],
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ];
  for (const build of builds) {
    for (const layout of layouts) {
      const candidate = path.join(browsersDir, build, ...layout);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

const SHOT_TIMEOUT_MS = 45_000;

/** How many screenshots stay in global storage. Every shot lands there and
 *  nothing else ever deletes one - unbounded, that directory only grows. */
const KEEP_SHOTS = 20;

/** Resolves with Chromium's stderr - the only witness when it exits cleanly
 *  but writes no PNG. */
async function runChromium(
  chromium: string,
  args: string[],
  log: (m: string) => void
): Promise<string> {
  // Through the shared runner for the kill: a headless Chromium is a process
  // TREE (zygote, GPU, renderers), and the plain SIGTERM this used to send to
  // the parent left the rest of it running after a timeout.
  const outcome = await run(chromium, args, { timeoutMs: SHOT_TIMEOUT_MS });
  if (outcome.kind === "spawn-failed") {
    throw outcome.error;
  }
  if (outcome.kind === "timeout") {
    log(`screenshot: chromium stderr: ${outcome.stderr.slice(0, 400)}`);
    throw new Error(
      `Chromium did not finish within ${Math.round(SHOT_TIMEOUT_MS / 1000)} s`
    );
  }
  if (outcome.kind === "closed" && outcome.code !== 0) {
    log(`screenshot: chromium stderr: ${outcome.stderr.slice(0, 400)}`);
    throw new Error(`Chromium exited with code ${outcome.code}`);
  }
  return outcome.kind === "closed" ? outcome.stderr : "";
}

/** Keeps the newest `keep` PNGs and deletes the rest. Best effort - a
 *  leftover screenshot is not worth failing the fresh one over. */
function pruneScreenshots(dir: string, keep: number): void {
  try {
    const stale = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".png"))
      .map((name) => {
        const full = path.join(dir, name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(keep);
    for (const each of stale) {
      fs.rmSync(each.full, { force: true });
    }
  } catch {
    // unreadable entry mid-prune - the next screenshot tries again
  }
}

/**
 * Renders `url` headless and returns the PNG's path, or undefined when the
 * screenshot could not be taken (the reason is already on screen then).
 */
export async function takeScreenshot(
  context: vscode.ExtensionContext,
  options: { url: string; className: string; width?: number; height?: number },
  log: (m: string) => void,
  showLog?: () => void
): Promise<string | undefined> {
  const chromium = findChromium(renderGateBrowsers(context));
  if (!chromium) {
    void offerInstall(
      context,
      log,
      "taking a screenshot renders the app in headless Chromium, which the " +
        "render gate installs - install it once?",
      showLog
    );
    return undefined;
  }

  const dir = path.join(context.globalStorageUri.fsPath, "screenshots");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[:T]/g, "-");
  // The stem, not the raw name: namespaced classes carry `/`, and the name
  // may arrive over MCP - neither gets to steer where the PNG lands.
  const file = path.join(dir, `${safeFileStem(options.className)}-${stamp}.png`);

  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--window-size=${options.width ?? 1280},${options.height ?? 900}`,
    `--screenshot=${file}`,
    // Fast-forwards the page's timers so the UI5 boot and the first backend
    // roundtrip are through before the shot - deterministic, no sleep.
    "--virtual-time-budget=15000",
    /*
     * KNOWN EXPOSURE, deliberately not worked around here: this is the
     * proxied url, so it carries the proxy's path token, and a process
     * argument vector is readable by other processes of this user (`ps`,
     * /proc/<pid>/cmdline). `report.ts` redacts the same token out of the
     * logs precisely because it authorizes an authenticated session against
     * the system.
     *
     * Headless Chromium takes the page to shoot only as an argument - there
     * is no stdin or file form of it - so removing this needs a different
     * shape (a one-shot token the proxy retires after the shot, or a local
     * redirect page). Both change security-critical code that cannot be
     * verified against a real system from here, and a half-verified change
     * to the credential path is worse than a documented one. The window is
     * the lifetime of one screenshot process.
     */
    options.url,
  ];
  // Chromium refuses its sandbox as root (containers, some CI images).
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    args.unshift("--no-sandbox");
  }

  let stderr = "";
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `abap2UI5: screenshotting ${options.className}`,
      },
      async () => {
        stderr = await runChromium(chromium, args, log);
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      "abap2UI5: screenshot failed - " +
        (err instanceof Error ? err.message : String(err))
    );
    return undefined;
  }
  if (!fs.existsSync(file)) {
    // a clean exit without a PNG says why only on stderr, which the
    // success path otherwise discards - logged here, or the channel the
    // message points at holds nothing about this failure
    log(
      `screenshot: chromium wrote no PNG${
        stderr ? ` - stderr: ${stderr.slice(0, 400)}` : " and said nothing on stderr"
      }`
    );
    const buttons = showLog ? ["Show Log"] : [];
    void vscode.window
      .showErrorMessage(
        "abap2UI5: Chromium finished but wrote no PNG - see the output channel.",
        ...buttons
      )
      .then((pick) => {
        if (pick === "Show Log") {
          showLog?.();
        }
      });
    return undefined;
  }
  log(`screenshot: ${file}`);
  pruneScreenshots(dir, KEEP_SHOTS);
  return file;
}
