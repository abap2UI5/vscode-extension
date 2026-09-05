import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { run } from "./childproc";
import { offerInstall, renderGateBrowsers } from "./rendergate";
import { safeFileStem } from "./previewcore";
import { withoutLogonParams } from "./urls";

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

/** Screenshots taken by this window so far. The file name carries it: two
 *  shots within one second used to share a name (the stamp stopped at the
 *  second), and the later one silently overwrote the earlier - an agent
 *  shooting three viewports in a row got one PNG back three times. */
let shotSequence = 0;

/** `<class stem>-<yyyy-mm-dd-hh-mm-ss-mmm>-<n>.png`. The stem, not the raw
 *  name: namespaced classes carry `/`, and the name may arrive over MCP -
 *  neither gets to steer where the PNG lands. */
function screenshotFileName(className: string, at: Date, sequence: number): string {
  const stamp = at.toISOString().replace(/[:T.]/g, "-").replace(/Z$/, "");
  return `${safeFileStem(className)}-${stamp}-${sequence}.png`;
}

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
  options: {
    /** The proxied page - authorized by a ONE-SHOT token, see below. */
    url: string;
    className: string;
    width?: number;
    height?: number;
  },
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
  shotSequence += 1;
  const file = path.join(
    dir,
    screenshotFileName(options.className, new Date(), shotSequence)
  );

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
     * The page to shoot, and the reason its url is a ONE-SHOT one.
     *
     * Headless Chromium takes it only as an argument - there is no stdin or
     * file form of it - and a process argument vector is readable by every
     * other process of this user (`ps`, /proc/<pid>/cmdline). Carrying the
     * proxy's long-lived capability token there handed any of them an
     * authenticated session against the system for as long as the proxy ran,
     * which is exactly why `report.ts` redacts that token out of the logs.
     *
     * So callers hand in a url authorized by `SapProxy.singleUseUrl`: the
     * token in it is retired the moment Chromium's first request is
     * authorized, and the page's follow-up requests ride on the HttpOnly
     * cookie that first answer plants. What leaks into the argument vector
     * is then a token that is already spent by the time the shot is taken.
     *
     * The same argument vector is why a launch URL's own `sap-user` and
     * `sap-password` do not travel here: the proxy injects the credentials
     * anyway, so the page loads exactly as before without them.
     */
    withoutLogonParams(options.url),
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
