import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { Parser as TarParser, ReadEntry } from "tar";
import { CLI_PATH, PARSER_PROBE } from "./report2cloud";

/*
 * "abap2UI5: Install Report Converter" - the decisions behind the command,
 * without `vscode`: what is downloaded, what it is checked against, what of
 * it is unpacked where, and how a half-done install never becomes the copy
 * the migrate command runs.
 *
 * report2UI5 (abap-cloud-gui's `tools/report2ui5`) is published neither on
 * npm nor as a release bundle. The immutable artefact is therefore the
 * source tarball of a PINNED COMMIT from GitHub's codeload - a branch tip is
 * never downloaded. What is checked is not the tarball's bytes (GitHub does
 * not promise byte-stable compression of its archives) but what it holds:
 * the snapshot `src/data/report2ui5.json` records, for every file the CLI
 * needs, its size and the SHA-256 of its unpacked content, and only those
 * files are taken out of the archive and each held to its record
 * (package.json's `report2ui5Release` repeats the commit,
 * `report2ui5.test.ts` holds the two together). Plus the
 * converter's npm dependency closure, each tarball checked against the
 * `integrity` of abap-cloud-gui's own package-lock.json at that commit - so
 * the converter parses with exactly the @abaplint/core its gates use.
 * `scripts/generate-report2ui5.mjs` writes the snapshot.
 *
 * Layout under the extension's global storage:
 *
 *   <storage>/report2ui5/<commit>/tools/report2ui5/...   the CLI's files only
 *   <storage>/report2ui5/<commit>/node_modules/...       the dependency closure
 *
 * which is the shape of an abap-cloud-gui checkout after `npm ci` as far as
 * the CLI can tell - `report2cloud.ts`'s `cliIn` and `PARSER_PROBE` accept it
 * like one, and node resolves `@abaplint/core` from `tools/` upwards.
 *
 * Nothing is written before its bytes are verified - a package against its
 * integrity before it is read, each pinned file against its size and
 * SHA-256 once it is read out of the source tarball - nothing outside the
 * pinned file list is unpacked from the source tarball, every path is
 * checked (no `..`, nothing absolute, no backslash, no link) and the copy is
 * built in a staging directory beside its final place and renamed into it
 * only once it is complete - so the directory existing IS the install being
 * complete. `tar` is not bundled a second time: the caller hands in its
 * `Parser` (the plumbing from `dist/rendergate-tar.js`, the tests from
 * node_modules).
 */

/** The repository the converter comes from. */
export const SOURCE_REPO = "abap2UI5-addons/abap-cloud-gui";

/** One npm package of the converter's dependency closure, as abap-cloud-gui's
 *  package-lock.json records it. */
export interface Report2ui5Dep {
  name: string;
  version: string;
  /** The registry tarball (`resolved`). */
  url: string;
  /** npm's Subresource Integrity string (`sha512-<base64>`). */
  integrity: string;
  /** Where the lock installs it, relative to the root - `node_modules/<name>`,
   *  or deeper for a nested copy. */
  path: string;
}

/** One file the CLI needs, as the pinned commit holds it. */
export interface Report2ui5File {
  /** Relative to the repository, forward slashes. */
  path: string;
  /** Bytes of the unpacked content. */
  size: number;
  /** SHA-256 (hex) of the unpacked content. */
  sha256: string;
}

/** The snapshot `src/data/report2ui5.json`. */
export interface Report2ui5Pin {
  commit: string;
  /** The files under `tools/` the CLI needs. */
  files: Report2ui5File[];
  deps: Report2ui5Dep[];
}

/** codeload's tarball of one commit - immutable for that commit. */
export function tarballUrl(commit: string): string {
  return `https://codeload.github.com/${SOURCE_REPO}/tar.gz/${commit}`;
}

/** The directory every installed commit lives under. */
export function installBase(storage: string): string {
  return path.join(storage, "report2ui5");
}

/** Where the pinned commit is (or would be) installed. */
export function installRoot(storage: string, commit: string): string {
  return path.join(installBase(storage), commit);
}

/** Whether `rel` is a relative path that stays below the directory it is
 *  joined to: forward slashes only, no `..`, nothing absolute, no NUL. */
export function isSafeRelative(rel: string): boolean {
  if (!rel || rel.includes("\0") || rel.includes("\\")) {
    return false;
  }
  if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) {
    return false;
  }
  return !rel.split("/").some((seg) => seg === "..");
}

/** What is wrong with a snapshot, empty when nothing is - the generator's
 *  shape check repeated where the snapshot is consumed, so a hand edit that
 *  would turn into a download of something else fails `npm test`. */
export function pinProblems(pin: Report2ui5Pin): string[] {
  const out: string[] = [];
  if (!/^[0-9a-f]{40}$/.test(pin.commit ?? "")) {
    out.push("commit is not a full 40-hex commit SHA");
  }
  const files = Array.isArray(pin.files) ? pin.files : [];
  if (!files.some((f) => f.path === "tools/report2ui5/cli.mjs")) {
    out.push("files does not contain tools/report2ui5/cli.mjs");
  }
  const seen = new Set<string>();
  for (const f of files) {
    const p = typeof f?.path === "string" ? f.path : "";
    if (!isSafeRelative(p) || !/^tools\/(?:report2ui5|report2cloud\/lib)\//.test(p)) {
      out.push(`file outside tools/report2ui5 and tools/report2cloud/lib: ${p}`);
    }
    if (seen.has(p)) {
      out.push(`file listed twice: ${p}`);
    }
    seen.add(p);
    if (!Number.isSafeInteger(f?.size) || f.size < 0) {
      out.push(`${p}: size is not a byte count`);
    }
    if (!/^[0-9a-f]{64}$/.test(f?.sha256 ?? "")) {
      out.push(`${p}: sha256 is not a 64-hex SHA-256`);
    }
  }
  const deps = Array.isArray(pin.deps) ? pin.deps : [];
  if (!deps.some((d) => d.name === "@abaplint/core")) {
    out.push("deps does not contain @abaplint/core");
  }
  for (const d of deps) {
    if (!/^https:\/\/registry\.npmjs\.org\//.test(d.url ?? "")) {
      out.push(`${d.name}: not a registry.npmjs.org tarball: ${d.url}`);
    }
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(d.integrity ?? "")) {
      out.push(`${d.name}: integrity is not a sha512 SRI string`);
    }
    if (!isSafeRelative(d.path ?? "") || !/^node_modules\//.test(d.path) || !d.path.endsWith(`node_modules/${d.name}`)) {
      out.push(`${d.name}: install path ${d.path} is not node_modules/.../${d.name}`);
    }
  }
  return out;
}

/** One download of a plan. */
export interface PlannedDownload {
  url: string;
  /** What the bytes are held to: a package's integrity before it is read;
   *  the source tarball's files, each to its record, once read. */
  check: { files: Report2ui5File[] } | { integrity: string };
  /** Where its contents go, relative to the install root ("" for the source
   *  tarball, whose own paths are kept). */
  into: string;
  /** For a message: the package and version, or "abap-cloud-gui@<sha12>". */
  label: string;
}

export interface InstallPlan {
  commit: string;
  root: string;
  downloads: PlannedDownload[];
  /** The files the source tarball has to yield. */
  files: Report2ui5File[];
}

/** Everything one install will do, before it does any of it. */
export function installPlan(pin: Report2ui5Pin, storage: string): InstallPlan {
  return {
    commit: pin.commit,
    root: installRoot(storage, pin.commit),
    files: pin.files.map((f) => ({ ...f })),
    downloads: [
      {
        url: tarballUrl(pin.commit),
        check: { files: pin.files.map((f) => ({ ...f })) },
        into: "",
        label: `abap-cloud-gui@${pin.commit.slice(0, 12)}`,
      },
      ...pin.deps.map((d) => ({
        url: d.url,
        check: { integrity: d.integrity },
        into: d.path,
        label: `${d.name}@${d.version}`,
      })),
    ],
  };
}

/** Why `data` is not the pinned file, or undefined - size first, then the
 *  SHA-256 of the content. */
export function fileError(data: Uint8Array, file: Report2ui5File, label: string): string | undefined {
  if (data.byteLength !== file.size) {
    return `${label}: ${file.path} is ${data.byteLength} bytes, the pin says ${file.size} - nothing was installed`;
  }
  const actual = createHash("sha256").update(data).digest("hex");
  return actual === file.sha256.toLowerCase()
    ? undefined
    : `${label}: ${file.path} does not match its pinned SHA-256 (expected ${file.sha256}, got ${actual}) - nothing was installed`;
}

/**
 * Why `bytes` do not match an npm `integrity` (Subresource Integrity:
 * space-separated `<algo>-<base64>`), or undefined. The strongest algorithm
 * the string names decides, as in the SRI spec; one this function does not
 * know is no evidence, and a string with none it knows is refused.
 */
export function integrityError(bytes: Uint8Array, integrity: string, label: string): string | undefined {
  const rank = ["sha256", "sha384", "sha512"];
  const parsed = integrity
    .trim()
    .split(/\s+/)
    .map((t) => /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$/.exec(t))
    .filter((m): m is RegExpExecArray => m !== null);
  if (!parsed.length) {
    return `${label}: no usable integrity (${integrity})`;
  }
  const best = Math.max(...parsed.map((m) => rank.indexOf(m[1])));
  const algo = rank[best];
  const actual = createHash(algo).update(bytes).digest("base64");
  return parsed.some((m) => m[1] === algo && m[2] === actual)
    ? undefined
    : `${label}: the download does not match its ${algo} integrity - nothing was unpacked`;
}

/** The `tar` the caller hands in - its `Parser`, which reads an archive
 *  without writing anything (gzip is detected). */
export interface TarApi {
  Parser: typeof TarParser;
}

const FILE_TYPES = new Set(["File", "OldFile", "ContiguousFile"]);

/** An archive entry's path below its top directory (codeload's
 *  `<repo>-<sha>/`, npm's `package/`), refusing every path that could land
 *  anywhere else. */
function innerPath(raw: string, label: string): string {
  if (!isSafeRelative(raw)) {
    throw new Error(`${label}: refused - the archive holds an unsafe path: ${JSON.stringify(raw)}`);
  }
  const segs = raw.split("/").filter((s) => s && s !== ".");
  return segs.slice(1).join("/");
}

/**
 * Reads the archive and returns the regular files it holds, by their path
 * below the top directory - `want` decides which are kept (in memory; the
 * rest are skipped unread). A link is refused when `refuseLink` says so for
 * its path; an entry with an unsafe path is refused wherever it is, and so
 * is a file that appears twice (a later copy would replace a checked one).
 */
export function readArchive(
  tar: TarApi,
  bytes: Uint8Array,
  label: string,
  want: (rel: string) => boolean,
  refuseLink: (rel: string) => boolean
): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const files = new Map<string, Buffer>();
    let failed: Error | undefined;
    const fail = (e: Error): void => {
      failed ??= e;
    };
    const parser = new tar.Parser({
      strict: true,
      onReadEntry: (entry: ReadEntry) => {
        try {
          if (failed) {
            entry.resume();
            return;
          }
          const rel = innerPath(entry.path, label);
          if (entry.type === "SymbolicLink" || entry.type === "Link") {
            if (refuseLink(rel)) {
              fail(new Error(`${label}: refused - ${rel} is a link in the archive`));
            }
            entry.resume();
            return;
          }
          if (!rel || entry.type === "Directory" || !want(rel)) {
            entry.resume();
            return;
          }
          if (!FILE_TYPES.has(entry.type)) {
            fail(new Error(`${label}: refused - ${rel} is a ${entry.type}, not a file`));
            entry.resume();
            return;
          }
          if (files.has(rel)) {
            fail(new Error(`${label}: refused - ${rel} appears twice in the archive`));
            entry.resume();
            return;
          }
          const chunks: Buffer[] = [];
          entry.on("data", (c: Buffer) => chunks.push(c));
          entry.on("end", () => files.set(rel, Buffer.concat(chunks)));
        } catch (e) {
          fail(e as Error);
          entry.resume();
        }
      },
    });
    parser.on("error", (e: Error) => fail(new Error(`${label}: not a readable archive - ${e.message}`)));
    parser.on("close", () => (failed ? reject(failed) : resolve(files)));
    parser.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });
}

/** Whether `rel` is `file`, or a directory above it. */
function isAtOrAbove(rel: string, file: string): boolean {
  return rel === file || file.startsWith(`${rel}/`);
}

/** The pinned files out of the source tarball - every one of them present
 *  as a regular file, no link at or above any of them, each its pinned size
 *  and SHA-256. Throws on the first that is not; nothing is returned (and
 *  so nothing written) unless all of them are. */
export async function sourceFiles(
  tar: TarApi,
  bytes: Uint8Array,
  files: readonly Report2ui5File[],
  label: string
): Promise<Map<string, Buffer>> {
  const paths = files.map((f) => f.path);
  const wanted = new Set(paths);
  const got = await readArchive(
    tar,
    bytes,
    label,
    (rel) => wanted.has(rel),
    (rel) => paths.some((f) => isAtOrAbove(rel, f))
  );
  const missing = paths.filter((f) => !got.has(f));
  if (missing.length) {
    throw new Error(`${label}: the archive lacks ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}`);
  }
  for (const f of files) {
    const bad = fileError(got.get(f.path)!, f, label);
    if (bad) {
      throw new Error(bad);
    }
  }
  return got;
}

/** Every regular file of a verified npm tarball - which holds no link at
 *  all, or it is refused. */
export function packageFiles(tar: TarApi, bytes: Uint8Array, label: string): Promise<Map<string, Buffer>> {
  return readArchive(tar, bytes, label, () => true, () => true);
}

/** Writes `files` below `dir`, each path checked once more against the
 *  directory it must stay in. */
export async function writeFiles(dir: string, files: Map<string, Buffer>): Promise<number> {
  const base = path.resolve(dir);
  let bytes = 0;
  for (const [rel, data] of files) {
    const target = path.resolve(base, ...rel.split("/"));
    if (!isSafeRelative(rel) || !target.startsWith(base + path.sep)) {
      throw new Error(`refused to write outside the install directory: ${rel}`);
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, data, { mode: 0o644 });
    bytes += data.length;
  }
  return bytes;
}

/** Fetches one URL completely. The plumbing's uses `fetch` with progress and
 *  cancellation; the hand-run check uses node's https. */
export type Download = (url: string, signal?: AbortSignal) => Promise<Uint8Array>;

export interface InstallOptions {
  pin: Report2ui5Pin;
  storage: string;
  download: Download;
  tar: TarApi;
  signal?: AbortSignal;
  /** One line per step, for the output channel. */
  log?: (message: string) => void;
  /** The step and how far along it is, for a progress notification. */
  progress?: (message: string, done: number, total: number) => void;
  /** Reinstall over an existing copy of the same commit. */
  force?: boolean;
  /** The suffix of the staging directory - process id and time by default. */
  unique?: string;
}

export interface InstallResult {
  root: string;
  /** False when the pinned commit was installed already. */
  installed: boolean;
  /** Bytes downloaded and bytes written. */
  downloaded: number;
  written: number;
  files: number;
}

/** A staging directory older than this is a crashed window's leftover; a
 *  younger one may be another window's install in progress. */
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("install cancelled");
  }
}

/** Whether a directory holds a converter install the migrate command can
 *  run - the same two probes the resolution makes. */
export function isInstalled(root: string): boolean {
  return fs.existsSync(path.join(root, CLI_PATH)) && fs.existsSync(path.join(root, PARSER_PROBE));
}

/**
 * Downloads, verifies and unpacks the pinned converter into
 * `<storage>/report2ui5/<commit>/`. Every download is verified before
 * anything of it is unpacked; the copy is assembled in a staging directory
 * and renamed into place only when complete; on any failure the staging
 * directory goes and whatever was installed before stays. Copies of other
 * (older) commits are removed after a successful install.
 */
export async function installReport2ui5(opts: InstallOptions): Promise<InstallResult> {
  const { pin, storage, signal } = opts;
  const log = opts.log ?? (() => undefined);
  const problems = pinProblems(pin);
  if (problems.length) {
    throw new Error(`the converter pin of this build is unusable: ${problems.join("; ")}`);
  }
  const plan = installPlan(pin, storage);
  if (!opts.force && isInstalled(plan.root)) {
    return { root: plan.root, installed: false, downloaded: 0, written: 0, files: 0 };
  }
  const base = installBase(storage);
  await fs.promises.mkdir(base, { recursive: true });
  await removeStale(base);
  const staging = `${plan.root}.installing-${opts.unique ?? `${process.pid}-${Date.now().toString(36)}`}`;
  await fs.promises.rm(staging, { recursive: true, force: true });
  await fs.promises.mkdir(staging, { recursive: true });
  let downloaded = 0;
  let written = 0;
  let count = 0;
  try {
    const total = plan.downloads.length;
    for (const [i, d] of plan.downloads.entries()) {
      cancelled(signal);
      opts.progress?.(`downloading ${d.label}`, i, total);
      log(`report2ui5: ${d.label} from ${d.url}`);
      const bytes = await opts.download(d.url, signal);
      cancelled(signal);
      downloaded += bytes.byteLength;
      let files: Map<string, Buffer>;
      if ("files" in d.check) {
        // the archive's bytes are not pinned (codeload's compression is not
        // promised stable) - its pinned files are, each checked when read
        files = await sourceFiles(opts.tar, bytes, d.check.files, d.label);
      } else {
        const bad = integrityError(bytes, d.check.integrity, d.label);
        if (bad) {
          throw new Error(bad);
        }
        files = await packageFiles(opts.tar, bytes, d.label);
      }
      written += await writeFiles(d.into ? path.join(staging, ...d.into.split("/")) : staging, files);
      count += files.size;
    }
    if (!isInstalled(staging)) {
      throw new Error(`the unpacked copy has no ${CLI_PATH} or no @abaplint/core`);
    }
    cancelled(signal);
    opts.progress?.("finishing", total, total);
    if (fs.existsSync(plan.root)) {
      // --force, or a copy that is not complete: replaced, never merged
      await fs.promises.rm(plan.root, { recursive: true, force: true });
    }
    try {
      await fs.promises.rename(staging, plan.root);
    } catch (err) {
      // another window finished the same commit first - its copy is as good
      if (!isInstalled(plan.root)) {
        throw err;
      }
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
  } catch (err) {
    await fs.promises.rm(staging, { recursive: true, force: true });
    throw err;
  }
  await removeOtherCommits(base, pin.commit);
  log(`report2ui5: installed ${count} files (${written} bytes, ${downloaded} bytes downloaded) to ${plan.root}`);
  return { root: plan.root, installed: true, downloaded, written, files: count };
}

/** Staging directories a crashed window left behind. */
async function removeStale(base: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(base);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^[0-9a-f]{40}\.installing-/.test(name)) {
      continue;
    }
    const full = path.join(base, name);
    try {
      const { mtimeMs } = await fs.promises.stat(full);
      if (Date.now() - mtimeMs > STALE_STAGING_MS) {
        await fs.promises.rm(full, { recursive: true, force: true });
      }
    } catch {
      // gone already
    }
  }
}

/** Installed copies of commits this build no longer pins. */
async function removeOtherCommits(base: string, commit: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(base);
  } catch {
    return;
  }
  for (const name of names) {
    if (/^[0-9a-f]{40}$/.test(name) && name !== commit) {
      await fs.promises.rm(path.join(base, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
