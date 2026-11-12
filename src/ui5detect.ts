import * as vscode from "vscode";
import { SapProxy } from "./proxy";
import { CONFIG_SECTION } from "./settings";
import { snapshotUi5Version } from "./snapshot";
import { settingsForSystem } from "./configcore";
import { isListedSystem, withDetectedUi5 } from "./systemprofile";
import type { SystemProfile } from "./systems";

/*
 * "Which UI5 does this system actually run?" - answered by the system.
 *
 * `abap2ui5.viewCheck.minUi5` and `.distribution` decide what the property
 * gate reports, and both are usually guessed. The system can answer: the UI5
 * distribution it serves ships `sap-ui-version.json`, and the proxy already
 * holds credentials for the host. So after the first launch against a system
 * the extension looks once, and when the answer disagrees with the settings
 * it offers - once per system and answer - to adopt it: into the profile of
 * a system of `abap2ui5.systems` (`minUi5` / `distribution`, in effect while
 * that system is active), into the two global settings for the single
 * `launchUrlTemplate`. Silence on every
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
  sapClient?: string,
  /** The system launched against - when it is an entry of `abap2ui5.systems`,
   *  the answer is offered to its profile instead of the global settings. */
  system?: SystemProfile
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
      if (status === 401 || status === 403) {
        // background probes do not trip the proxy's 401 breaker - with a
        // wrong password, trying the remaining paths only adds failed
        // logons on every launch
        break;
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
  // A system of the `systems` setting has a profile the answer belongs in -
  // it is a fact about THAT system. The single `launchUrlTemplate` has none:
  // there the two global settings are what is compared and written, as ever.
  const profile =
    system && isListedSystem(cfg.get<unknown>("systems", []), system.template)
      ? system
      : undefined;
  // what the check is compared against right now - the profile over the
  // settings, by the one rule in configcore.ts
  const inEffect = settingsForSystem(
    {
      minUi5: cfg.get<string>("viewCheck.minUi5", "1.71"),
      // "" is the default now - "not decided", handed to the linter as null
      distribution: cfg.get<string>("viewCheck.distribution", "") || null,
      allow: [],
    },
    profile
  );
  const setMin = inEffect.minUi5;
  const setDist = inEffect.distribution ?? "";
  // a profile may carry a patch level ("1.120.3") - the same minor is no
  // disagreement
  const sameMinor = profile
    ? /^\d+\.\d+/.exec(setMin)?.[0] === info.minor
    : info.minor === setMin;
  const mismatches: string[] = [];
  if (!sameMinor) {
    mismatches.push(`minUi5 ${setMin} → ${info.minor}`);
  }
  if (info.distribution && info.distribution !== setDist) {
    mismatches.push(`distribution ${setDist || "not set"} → ${info.distribution}`);
  }
  if (!mismatches.length) {
    return;
  }

  // One offer per system and answer - a decline is not asked again. The
  // profile offer has a key of its own: declining to change the global
  // settings was not an answer about the profile.
  const stateKey =
    `abap2ui5.ui5detect:${origin}:${info.minor}:${info.distribution ?? "?"}` +
    (profile ? `:profile:${profile.name}` : "");
  if (context.globalState.get<boolean>(stateKey)) {
    return;
  }
  const adopt = profile ? "Write to Profile" : "Adopt";
  const pick = await vscode.window.showInformationMessage(
    (profile
      ? `abap2UI5: ${profile.name} serves UI5 ${info.minor}`
      : `abap2UI5: this system serves UI5 ${info.minor}`) +
      (info.distribution ? ` (${info.distribution})` : "") +
      `, but the view check is set to ${setMin} (${setDist || "distribution not set"}). ` +
      (profile
        ? `Write what the system runs into the profile of ${profile.name} ` +
          "(abap2ui5.systems)? It then applies while that system is active."
        : "Check against what the system runs?"),
    adopt,
    "Keep Settings"
  );
  if (!pick) {
    return; // dismissed - ask again another session
  }
  await context.globalState.update(stateKey, true);
  if (pick !== adopt) {
    return;
  }
  if (profile) {
    // written where the list lives: a workspace's list into the workspace
    // settings, the user's into the user settings
    const scopes = cfg.inspect<unknown>("systems");
    const inWorkspace = scopes?.workspaceValue !== undefined;
    const next = withDetectedUi5(
      inWorkspace ? scopes?.workspaceValue : scopes?.globalValue,
      profile.template,
      { minUi5: info.minor, distribution: info.distribution }
    );
    if (!next) {
      log(`ui5-detect: the profile of ${profile.name} was not found in the settings - nothing written`);
      return;
    }
    await cfg.update(
      "systems",
      next,
      inWorkspace
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global
    );
    log(
      `ui5-detect: profile of ${profile.name} updated in the ` +
        `${inWorkspace ? "workspace" : "user"} settings (${mismatches.join(", ")})`
    );
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
