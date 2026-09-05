import * as vscode from "vscode";
import { SapProxy } from "./proxy";
import { CONFIG_SECTION } from "./settings";
import { snapshotUi5Version } from "./snapshot";

/*
 * "Which UI5 does this system actually run?" - answered by the system.
 *
 * `abap2ui5.viewCheck.minUi5` and `.distribution` decide what the property
 * gate reports, and both are usually guessed. The system can answer: the UI5
 * distribution it serves ships `sap-ui-version.json`, and the proxy already
 * holds credentials for the host. So after the first launch against a system
 * the extension looks once, and when the answer disagrees with the settings
 * it offers - once per system and answer - to adopt it. Silence on every
 * failure path: a system not serving the file simply keeps the settings.
 */

/** Where the served UI5 publishes its version - the ABAP paths first. */
const VERSION_PATHS = [
  "/sap/public/bc/ui5_ui5/resources/sap-ui-version.json",
  "/sap/bc/ui5_ui5/resources/sap-ui-version.json",
  "/resources/sap-ui-version.json",
];

interface Ui5VersionInfo {
  /** `major.minor`, e.g. `1.120` - the granularity minUi5 works in. */
  minor: string;
  /** Only claimed when the libraries list is present to judge from. */
  distribution?: "sapui5" | "openui5";
}

function parseVersionJson(body: string): Ui5VersionInfo | undefined {
  try {
    const json = JSON.parse(body) as {
      version?: string;
      libraries?: Array<{ name?: string }>;
    };
    const m = /^(\d+)\.(\d+)/.exec(String(json.version ?? ""));
    if (!m) {
      return undefined;
    }
    const libraries = Array.isArray(json.libraries) ? json.libraries : [];
    return {
      minor: `${m[1]}.${m[2]}`,
      // sap.ui.comp is the marker: SAPUI5 ships it, OpenUI5 does not.
      distribution: libraries.length
        ? libraries.some((lib) => lib.name === "sap.ui.comp")
          ? "sapui5"
          : "openui5"
        : undefined,
    };
  } catch {
    return undefined;
  }
}

/** What each origin answered this session - the probes are per launch, and
 *  three round trips per F9 against an answer that cannot change while the
 *  system runs were three too many. Failures are not cached, so a system
 *  that was merely unreachable is asked again next launch. */
const detected = new Map<string, Ui5VersionInfo>();

/** The detected version, kept visible - guessing it once was the problem. */
let statusItem: vscode.StatusBarItem | undefined;

/** Which origin the status item currently describes. */
let statusOrigin: string | undefined;

function showStatus(
  context: vscode.ExtensionContext,
  origin: string,
  info: Ui5VersionInfo
): void {
  if (!statusItem) {
    statusItem = vscode.window.createStatusBarItem(
      "abap2ui5.ui5version",
      vscode.StatusBarAlignment.Left,
      49 // right next to the running-app item
    );
    statusItem.name = "abap2UI5 UI5 version";
    context.subscriptions.push(statusItem);
  }
  statusItem.text = `UI5 ${info.minor}`;
  statusItem.tooltip = new vscode.MarkdownString(
    `**${origin}** serves UI5 ${info.minor}` +
      (info.distribution ? ` (${info.distribution})` : "") +
      `\n\nClick to open the view-check settings.`
  );
  statusItem.command = {
    title: "Open settings",
    command: "workbench.action.openSettings",
    arguments: ["abap2ui5.viewCheck"],
  };
  statusItem.show();
}

/**
 * Looks up the system's UI5 version and, when it disagrees with the
 * settings, offers once to adopt it. Fire-and-forget from the launch path.
 *
 * The probes carry the launch URL's `sap-client` and run as background
 * fetches: credentials live per client, and a probe against the default
 * client used to trip the proxy's 401 breaker - breaking a launch whose own
 * client and credentials were fine, and counting a failed logon towards a
 * lockout the user never caused.
 */
export async function suggestSystemUi5(
  context: vscode.ExtensionContext,
  proxy: SapProxy,
  origin: string,
  log: (m: string) => void,
  sapClient?: string
): Promise<void> {
  let info = detected.get(origin);
  for (const path of info ? [] : VERSION_PATHS) {
    try {
      const { status, body } = await proxy.fetchFromSystem(
        path + (sapClient ? `?sap-client=${encodeURIComponent(sapClient)}` : ""),
        "application/json, */*",
        { background: true }
      );
      if (status === 200) {
        info = parseVersionJson(body);
        if (info) {
          break;
        }
      }
    } catch {
      // network trouble - the launch already surfaces that where it matters
    }
  }
  if (!info) {
    // no answer from THIS system: a version bar still showing the previous
    // system's answer would be wrong twice over
    if (statusOrigin && statusOrigin !== origin) {
      statusItem?.hide();
      statusOrigin = undefined;
    }
    return;
  }
  detected.set(origin, info);
  log(
    `ui5-detect: ${origin} serves UI5 ${info.minor}` +
      (info.distribution ? ` (${info.distribution})` : "")
  );
  showStatus(context, origin, info);
  statusOrigin = origin;

  // The bundled metadata can only describe what existed when it was built -
  // against a NEWER system, a genuinely new control would be reported as
  // unknown. Said once in the log, not as a popup: it is a caveat, not an
  // error, and the fix (an extension update) is not urgent.
  const snapMinor = /^(\d+)\.(\d+)/.exec(snapshotUi5Version() ?? "");
  const sysMinor = /^(\d+)\.(\d+)/.exec(info.minor);
  if (
    snapMinor &&
    sysMinor &&
    (Number(sysMinor[1]) > Number(snapMinor[1]) ||
      (sysMinor[1] === snapMinor[1] && Number(sysMinor[2]) > Number(snapMinor[2])))
  ) {
    log(
      `ui5-detect: the system's UI5 ${info.minor} is newer than the bundled ` +
        `metadata (${snapMinor[0]}) - controls introduced in between would be ` +
        "reported as unknown; update the extension for current metadata"
    );
  }

  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const setMin = cfg.get<string>("viewCheck.minUi5", "1.71");
  // "" is the default now - "not decided", handed to the linter as null
  const setDist = cfg.get<string>("viewCheck.distribution", "");
  const mismatches: string[] = [];
  if (info.minor !== setMin) {
    mismatches.push(`minUi5 ${setMin} → ${info.minor}`);
  }
  if (info.distribution && info.distribution !== setDist) {
    mismatches.push(`distribution ${setDist || "not set"} → ${info.distribution}`);
  }
  if (!mismatches.length) {
    return;
  }

  // One offer per system and answer - a decline is not asked again.
  const stateKey = `abap2ui5.ui5detect:${origin}:${info.minor}:${info.distribution ?? "?"}`;
  if (context.globalState.get<boolean>(stateKey)) {
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    `abap2UI5: this system serves UI5 ${info.minor}` +
      (info.distribution ? ` (${info.distribution})` : "") +
      `, but the view check is set to ${setMin} (${setDist}). ` +
      "Check against what the system runs?",
    "Adopt",
    "Keep Settings"
  );
  if (!pick) {
    return; // dismissed - ask again another session
  }
  await context.globalState.update(stateKey, true);
  if (pick !== "Adopt") {
    return;
  }
  if (info.minor !== setMin) {
    await cfg.update(
      "viewCheck.minUi5",
      info.minor,
      vscode.ConfigurationTarget.Global
    );
  }
  if (info.distribution && info.distribution !== setDist) {
    await cfg.update(
      "viewCheck.distribution",
      info.distribution,
      vscode.ConfigurationTarget.Global
    );
  }
  log(`ui5-detect: settings updated (${mismatches.join(", ")})`);
}
