#!/usr/bin/env node
/*
 * Launcher for the desktop smoke test (`npm run test:desktop`).
 *
 * Downloads a real VS Code, opens a throwaway workspace folder in it with
 * this checkout loaded as a development extension, and runs
 * `src/test/desktop/suite.ts` (bundled to `dist-test/desktop/suite.js`)
 * inside that host.
 *
 * This is the desktop counterpart of `npm run test:web`, and it is the same
 * kind of gate: it needs to download somebody else's product and it needs a
 * display, so it is NOT part of `npm run check`. `npm run check` stays the
 * commands that work in a restricted environment.
 *
 * How it behaves when the environment cannot provide those things:
 *
 *   - `ABAP2UI5_SKIP_DESKTOP_TEST=1`  - always skips, exit 0. The explicit
 *     opt-out for a sandbox.
 *   - Linux with no display and no `xvfb-run` around it - skips, exit 0,
 *     because a VS Code that cannot open a window is not a failure of this
 *     extension. CI runs it under `xvfb-run -a`.
 *   - VS Code cannot be downloaded (no network, proxy) - skips, exit 0.
 *
 *   - `ABAP2UI5_DESKTOP_TEST_REQUIRED=1` turns every one of those skips into
 *     a failure. CI sets it, so "the smoke test quietly did not run" cannot
 *     become the normal state of the build.
 *
 * A suite that actually RUNS and fails is always a failure, in every
 * environment - none of the above touches that.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SUITE = path.join(ROOT, "dist-test", "desktop", "suite.js");

const required = !!process.env.ABAP2UI5_DESKTOP_TEST_REQUIRED;

/** Ends the run the way this environment deserves: a skip is success unless
 *  the caller declared the test required. */
function unavailable(why) {
  if (required) {
    console.error(
      `::error::the desktop smoke test was required but could not run - ${why}`
    );
    process.exit(1);
  }
  console.log(`test:desktop: skipped - ${why}`);
  console.log(
    "test:desktop: set ABAP2UI5_DESKTOP_TEST_REQUIRED=1 to make this a failure."
  );
  process.exit(0);
}

/** The view the suite checks: one property that exists on no control in any
 *  release, i.e. a guaranteed `unknown-property` error - but only from a
 *  metadata snapshot that actually loaded. XML rather than ABAP so the file
 *  is recognised by its name alone, with no ABAP language extension in the
 *  host. */
const BAD_VIEW =
  '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m">\n' +
  '  <Button text="Go" nosuchprop="x"/>\n' +
  "</mvc:View>\n";

/** The workspace the host opens: one bad view, and settings that pin the
 *  optional render gate off. It is false by default today, and this test must
 *  not start downloading a Chromium bundle if that default ever changes. */
function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abap2ui5-desktop-test-"));
  fs.writeFileSync(path.join(dir, "smoke.view.xml"), BAD_VIEW);
  fs.mkdirSync(path.join(dir, ".vscode"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".vscode", "settings.json"),
    `${JSON.stringify(
      {
        "abap2ui5.viewCheck.render": false,
        "abap2ui5.viewCheck.live": false,
        "abap2ui5.viewCheck.onSave": false,
      },
      null,
      2
    )}\n`
  );
  return dir;
}

async function main() {
  if (process.env.ABAP2UI5_SKIP_DESKTOP_TEST) {
    console.log("test:desktop: skipped - ABAP2UI5_SKIP_DESKTOP_TEST is set");
    return;
  }

  if (!fs.existsSync(SUITE)) {
    console.error(
      `::error::${path.relative(ROOT, SUITE)} is missing - run \`node esbuild.js --desktoptest\` first ` +
        "(the `test:desktop` script does that for you)."
    );
    process.exit(1);
  }

  // An Electron app needs somewhere to draw. Checking here rather than
  // letting VS Code die with an X error keeps the message useful.
  if (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    unavailable(
      "no DISPLAY on linux - VS Code cannot start headless, run it under `xvfb-run -a npm run test:desktop`"
    );
    return;
  }

  let vscodeExecutablePath;
  try {
    vscodeExecutablePath = await downloadAndUnzipVSCode("stable");
  } catch (err) {
    unavailable(`VS Code could not be downloaded - ${err?.message ?? err}`);
    return;
  }

  const workspace = makeWorkspace();
  try {
    // From here on every failure is a real one: the host started, so
    // whatever went wrong is about this extension.
    const code = await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: ROOT,
      extensionTestsPath: SUITE,
      launchArgs: [
        workspace,
        // Nothing else in the host may publish diagnostics or grab the
        // commands - the extension under development stays enabled.
        "--disable-extensions",
        "--disable-gpu",
        "--disable-workspace-trust",
      ],
    });
    if (code !== 0) {
      process.exit(code);
    }
    console.log("test:desktop: the extension activated and the gate found its snapshot");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
