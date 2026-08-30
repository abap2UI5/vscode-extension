/*
 * Formatting for the proxy's traffic log.
 *
 * The auth proxy is the one place every request of the embedded app passes
 * through, which makes it a free network tab: method, path, status, size and
 * - the interesting part - the full roundtrip duration. A slow app is almost
 * always one slow POST, and until now the only way to see that was the
 * browser devtools the preview exists to avoid.
 *
 * `vscode`-free: entries in, lines out - covered by the test suite.
 */

import type { TrafficEntry } from "./proxy";
import { redactQueryCredentials } from "./report";

/** `1.2 kB`, `340 B`, `4.0 MB` - coarse on purpose, it is a log line. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} kB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One aligned log line:  `POST  200    342 ms   1.2 kB  /sap/bc/z2ui5`.
 * The columns are fixed so a scan down the duration column works. Status 0
 * is a request that got no answer at all (aborted, or the forward failed
 * before one arrived) and renders as `-`.
 *
 * The path is redacted on the way out. A launch URL is free to carry
 * `sap-user`/`sap-password` - the proxy forwards the query as written, and
 * from here the line goes into an output channel AND into the ring the MCP
 * `get_traffic` tool hands any agent. "Never log credentials" is decided
 * here, at the one formatter both of them share.
 */
export function formatTrafficLine(entry: TrafficEntry): string {
  return [
    entry.method.padEnd(6),
    (entry.status ? String(entry.status) : "-").padEnd(4),
    `${entry.durationMs} ms`.padStart(9),
    formatBytes(entry.bytes).padStart(9),
    ` ${redactQueryCredentials(entry.path)}`,
  ].join(" ");
}

/**
 * True for the requests the toolbar badge times: the POSTs are the app's
 * backend roundtrips (every abap2UI5 event is one), everything else is
 * resource loading. Only 2xx counts - failed roundtrips belong to the error
 * handling, and a redirected POST is a logon dance, not an app event.
 */
export function isRoundtrip(entry: TrafficEntry): boolean {
  return (
    entry.method.toUpperCase() === "POST" &&
    entry.status >= 200 &&
    entry.status < 300
  );
}
