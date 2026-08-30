/*
 * The lifecycle every generated snapshot in src/data/ shares.
 *
 * Three scripts (app-template, client-api, repo-dirs) mirror a file that
 * lives in ANOTHER repository into this bundle, and each of them had grown
 * its own copy of the same five steps: the invoked-directly guard, reading
 * from a local checkout or GitHub raw with a timeout, normalising CRLF,
 * `--check` byte-comparing the committed file with a STALE message, and
 * mkdir + write. Five copies is where the fourth snapshot would have started
 * as a fifth, and where a fix (the fetch timeout was added to two of the
 * three) reaches only some of them.
 *
 * What stays with each script: WHAT it reads, what shape it demands of it
 * (through `requireShape`), and every message it prints - those are the parts
 * a reader of one script needs to see in that script.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/** A stalled fetch fails the weekly run promptly instead of hanging to the
 *  job's cap. Per file - a snapshot is fetched one file at a time. */
export const FETCH_TIMEOUT_MS = 30000;

/** Whether this module's importer was run as a program rather than imported
 *  (the generators export their parsers to the test suite). */
export function invokedDirectly(moduleUrl) {
  return Boolean(
    process.argv[1] &&
      fs.realpathSync(process.argv[1]) === fileURLToPath(moduleUrl)
  );
}

/** The generators' one CLI shape: `--check`, plus an optional local checkout
 *  path (anything that is not a flag). */
export function parseArgs(argv = process.argv.slice(2)) {
  return {
    check: argv.includes("--check"),
    local: argv.find((a) => !a.startsWith("--")),
  };
}

/**
 * One upstream file, from a local checkout when given and from GitHub raw
 * otherwise.
 *
 * Line endings are normalised: the upstream repositories commit LF, and a
 * CRLF checkout on Windows must not produce a different snapshot than the
 * fetch does. An HTTP failure exits 2 - the weekly workflow tells that apart
 * from the exit 1 of "the snapshot is stale".
 */
export async function readUpstream({ tool, file, local, url }) {
  const text = local
    ? fs.readFileSync(path.join(local, file), "utf8")
    : await fetchText({ tool, url });
  return text.replace(/\r\n/g, "\n");
}

async function fetchText({ tool, url }) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    console.error(`${tool}: ${url} -> HTTP ${res.status}`);
    process.exit(2);
  }
  return res.text();
}

/**
 * The shape check a snapshot owes the code that reads it: report what
 * upstream no longer provides and exit 1, rather than write a snapshot the
 * extension silently cannot use. `problems` empty means the shape is intact.
 */
export function requireShape({ problems, header, hint, indent = "  " }) {
  if (!problems.length) {
    return;
  }
  if (header) {
    console.error(header);
  }
  for (const problem of problems) {
    console.error(header ? `${indent}${problem}` : problem);
  }
  if (hint) {
    console.error(hint);
  }
  process.exit(1);
}

/**
 * The end of every generator: `--check` byte-compares the committed file and
 * fails with the caller's STALE message; otherwise the file is written.
 *
 * The messages are the caller's on purpose - each says what a stale snapshot
 * MEANS for this extension, which is the only part of the report a reader
 * cannot reconstruct.
 */
export function emitSnapshot({ out, json, check, stale, upToDate, wrote }) {
  if (check) {
    const current = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
    if (current !== json) {
      console.error(stale);
      process.exit(1);
    }
    console.log(upToDate);
    return;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, json);
  console.log(wrote);
}
