#!/usr/bin/env node
/*
 * Builds src/data/report2ui5.json - the pinned report2UI5 converter "Install
 * Report Converter" downloads (src/report2ui5install.ts) - and package.json's
 * `report2ui5Release` record of the same commit.
 *
 * Why a pinned commit: abap-cloud-gui publishes its converter neither on npm
 * nor as a release bundle, so the one immutable artefact there is is the
 * source tarball of a COMMIT from GitHub's codeload. The snapshot records:
 *
 *   commit         the commit (full SHA) the tarball is of
 *   files          the files under tools/report2ui5 (and tools/report2cloud/lib,
 *                  should the CLI reach there) the CLI imports, statically or
 *                  through a literal dynamic import(): esbuild's metafile over
 *                  the tarball's own text - nothing of it is executed - each
 *                  with the size and SHA-256 of its UNPACKED content. The
 *                  tarball's own bytes are deliberately not pinned: GitHub
 *                  does not promise byte-stable compression of its archives,
 *                  and the install holds what the archive CONTAINS to the
 *                  record instead. So the archive read here may come from
 *                  anywhere that has the commit - codeload, or
 *                  `git archive --format=tar.gz <commit>` of a checkout
 *   deps           the npm closure of what the CLI imports beyond node's
 *                  builtins (only @abaplint/core is allowed, deep paths
 *                  included), taken from the package-lock.json IN the tarball:
 *                  name, version, resolved url, integrity, install path - so
 *                  the installed converter parses with exactly the
 *                  @abaplint/core abap-cloud-gui's gates use
 *
 *   node scripts/generate-report2ui5.mjs                 (main's tip: commit from
 *                                                         the GitHub API, tarball
 *                                                         from codeload)
 *   node scripts/generate-report2ui5.mjs --ref <sha|branch>
 *   node scripts/generate-report2ui5.mjs /path/to/abap-cloud-gui
 *                                                        (the checkout's HEAD commit)
 *   node scripts/generate-report2ui5.mjs --tarball <file> (read that archive of the
 *                                                         commit instead of downloading
 *                                                         it - a `git archive` is fine)
 *   node scripts/generate-report2ui5.mjs --check         (fail when the committed
 *                                                         files are stale)
 *
 * `--out` and `--package` move the two outputs (the offline test in
 * src/test/report2ui5.test.ts runs the generator over a fixture tarball).
 * Needs `npm ci` first: it reads the archive with `tar` and the import graph
 * with `esbuild`, both devDependencies.
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { builtinModules } from "module";
import { fileURLToPath } from "url";
import { Parser } from "tar";
import * as esbuild from "esbuild";
import { FETCH_TIMEOUT_MS, emitSnapshot, invokedDirectly, requireShape } from "./lib/snapshot.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "abap2UI5-addons/abap-cloud-gui";
const ENTRY = "tools/report2ui5/cli.mjs";
const TOOL = "generate-report2ui5";
/** The one package the CLI may import beyond node's builtins - the parser. */
export const ALLOWED_PACKAGE = "@abaplint/core";
/** Where the CLI's own files may live. */
export const FILE_RE = /^tools\/(?:report2ui5|report2cloud\/lib)\//;

/** `--flag value` and the positional checkout; parseArgs of the shared
 *  lifecycle knows only `--check`. */
export function parseCli(argv = process.argv.slice(2)) {
  const opts = { check: false };
  const valued = new Set(["--ref", "--tarball", "--out", "--package"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") {
      opts.check = true;
    } else if (valued.has(a)) {
      opts[a.slice(2)] = argv[++i];
    } else if (!a.startsWith("--")) {
      opts.local = a;
    }
  }
  return opts;
}

async function fetchOrExit(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 4) });
  if (!res.ok) {
    console.error(`${TOOL}: ${url} -> HTTP ${res.status}`);
    process.exit(2);
  }
  return res;
}

/** The commit to pin: a full SHA as given, a checkout's HEAD, or the tip of
 *  a branch through the GitHub API. */
async function resolveCommit({ ref, local }) {
  if (ref && /^[0-9a-f]{40}$/.test(ref)) {
    return ref;
  }
  if (local) {
    return execFileSync("git", ["-C", local, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  }
  const headers = { accept: "application/vnd.github.sha" };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const sha = (await (await fetchOrExit(`https://api.github.com/repos/${REPO}/commits/${ref || "main"}`, { headers })).text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    console.error(`${TOOL}: the GitHub API answered no commit SHA for ${ref || "main"}`);
    process.exit(2);
  }
  return sha;
}

/** Every regular file of the archive under its top directory, by inner path
 *  - only those `want` asks for are kept. */
export function readTarball(bytes, want) {
  return new Promise((resolve, reject) => {
    const files = new Map();
    const parser = new Parser({
      strict: true,
      onReadEntry(entry) {
        const rel = entry.path.split("/").filter((s) => s && s !== ".").slice(1).join("/");
        if (entry.type !== "File" && entry.type !== "OldFile") {
          entry.resume();
          return;
        }
        if (!want(rel)) {
          entry.resume();
          return;
        }
        const chunks = [];
        entry.on("data", (c) => chunks.push(c));
        entry.on("end", () => files.set(rel, Buffer.concat(chunks)));
      },
    });
    parser.on("error", reject);
    parser.on("close", () => resolve(files));
    parser.end(bytes);
  });
}

/** The files the CLI imports and the bare specifiers it imports, read by
 *  esbuild out of `files` (in memory) - a bundle that is never written. */
export async function importClosure(files) {
  const bare = new Set();
  const result = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [
      {
        name: "tarball",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === "entry-point") {
              return { path: args.path, namespace: "tarball" };
            }
            if (!/^\.{1,2}\//.test(args.path)) {
              bare.add(args.path);
              return { path: args.path, external: true };
            }
            return { path: path.posix.normalize(path.posix.join(path.posix.dirname(args.importer), args.path)), namespace: "tarball" };
          });
          build.onLoad({ filter: /.*/, namespace: "tarball" }, (args) => {
            const text = files.get(args.path);
            if (text === undefined) {
              return { errors: [{ text: `the archive has no ${args.path}` }] };
            }
            return { contents: text, loader: "js", resolveDir: path.posix.dirname(args.path) };
          });
        },
      },
    ],
  });
  const inputs = Object.keys(result.metafile.inputs).map((k) => k.replace(/^tarball:/, "")).sort();
  return { files: inputs, bare: [...bare].sort() };
}

/** What the CLI may import beyond its own files: node's builtins and the
 *  parser (deep paths included). */
export function disallowedImports(bare) {
  const builtins = new Set(builtinModules);
  return bare.filter((s) => {
    const name = s.replace(/^node:/, "");
    if (s.startsWith("node:") || builtins.has(name.split("/")[0])) {
      return false;
    }
    return s !== ALLOWED_PACKAGE && !s.startsWith(`${ALLOWED_PACKAGE}/`);
  });
}

/** The install closure of `root` in a lockfileVersion 2/3 package-lock: each
 *  dependency resolved the way node does it - the nearest node_modules up
 *  the tree. */
export function lockClosure(lock, rootPackage) {
  const packages = lock.packages || {};
  const resolve = (from, name) => {
    let base = from;
    for (;;) {
      const key = `${base ? `${base}/` : ""}node_modules/${name}`;
      if (packages[key]) {
        return key;
      }
      if (!base) {
        return undefined;
      }
      const i = base.lastIndexOf("/node_modules/");
      base = i < 0 ? "" : base.slice(0, i);
    }
  };
  const problems = [];
  const seen = new Map();
  const walk = (key) => {
    if (seen.has(key)) {
      return;
    }
    const p = packages[key];
    seen.set(key, p);
    for (const dep of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) {
      const at = resolve(key, dep);
      if (at) {
        walk(at);
      } else if (!(p.optionalDependencies && dep in p.optionalDependencies)) {
        problems.push(`${key} needs ${dep}, which the lock does not install`);
      }
    }
  };
  const start = `node_modules/${rootPackage}`;
  if (!packages[start]) {
    return { deps: [], problems: [`package-lock.json installs no ${rootPackage}`] };
  }
  walk(start);
  const deps = [...seen.entries()]
    .map(([key, p]) => ({
      name: key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length),
      version: p.version,
      url: p.resolved,
      integrity: p.integrity,
      path: key,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const d of deps) {
    if (!/^https:\/\/registry\.npmjs\.org\//.test(d.url || "")) {
      problems.push(`${d.name}@${d.version} does not resolve to a registry.npmjs.org tarball: ${d.url}`);
    }
    if (!/^sha512-/.test(d.integrity || "")) {
      problems.push(`${d.name}@${d.version} carries no sha512 integrity`);
    }
  }
  return { deps, problems };
}

/** The snapshot for one commit's tarball bytes - everything the generator
 *  decides, without a file written. */
export async function snapshotOf(commit, bytes) {
  const all = await readTarball(bytes, (rel) => rel === "package-lock.json" || /^tools\//.test(rel));
  const problems = [];
  if (!all.has(ENTRY)) {
    problems.push(`the tarball has no ${ENTRY}`);
  }
  const lockText = all.get("package-lock.json");
  if (!lockText) {
    problems.push("the tarball has no package-lock.json");
  }
  if (problems.length) {
    return { problems };
  }
  const texts = new Map([...all].filter(([k]) => k.startsWith("tools/")).map(([k, v]) => [k, v.toString("utf8")]));
  let closure;
  try {
    closure = await importClosure(texts);
  } catch (e) {
    return { problems: [`the CLI's imports cannot be followed: ${e.message.split("\n")[0]}`] };
  }
  for (const f of closure.files) {
    if (!FILE_RE.test(f)) {
      problems.push(`the CLI imports ${f}, outside tools/report2ui5 and tools/report2cloud/lib`);
    }
  }
  for (const s of disallowedImports(closure.bare)) {
    problems.push(`the CLI imports ${s} - only node builtins and ${ALLOWED_PACKAGE} are installed`);
  }
  const { deps, problems: lockProblems } = lockClosure(JSON.parse(lockText.toString("utf8")), ALLOWED_PACKAGE);
  problems.push(...lockProblems);
  const files = closure.files.map((p) => {
    const data = all.get(p) ?? Buffer.alloc(0);
    return { path: p, size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  });
  return { problems, snapshot: { commit, files, deps } };
}

export function snapshotJson(snapshot) {
  return `${JSON.stringify(
    {
      note: `The report2UI5 converter "Install Report Converter" downloads: codeload's tarball of ${REPO} at \`commit\`, of which only \`files\` are unpacked (each held to its size and the SHA-256 of its content), and the npm closure of @abaplint/core from that commit's package-lock.json (each held to its \`integrity\`). Generated by scripts/generate-report2ui5.mjs - do not edit.`,
      source: REPO,
      ...snapshot,
    },
    null,
    2
  )}\n`;
}

/** package.json with its `report2ui5Release` block set - the record of
 *  which artefact this build installs. */
export function withRelease(pkgText, { commit }) {
  const pkg = JSON.parse(pkgText);
  pkg.report2ui5Release = { commit };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

if (invokedDirectly(import.meta.url)) {
  const opts = parseCli();
  const out = opts.out ? path.resolve(opts.out) : path.join(ROOT, "src", "data", "report2ui5.json");
  const pkgFile = opts.package ? path.resolve(opts.package) : path.join(ROOT, "package.json");

  const commit = await resolveCommit(opts);
  const bytes = opts.tarball
    ? fs.readFileSync(opts.tarball)
    : Buffer.from(await (await fetchOrExit(`https://codeload.github.com/${REPO}/tar.gz/${commit}`)).arrayBuffer());

  const { problems, snapshot } = await snapshotOf(commit, bytes);
  requireShape({
    problems,
    header: `${TOOL}: ${REPO}@${commit.slice(0, 12)} cannot be pinned:`,
    hint: "Fix src/report2ui5install.ts (and this script) rather than committing a converter the install cannot run.",
  });

  const pkgText = fs.readFileSync(pkgFile, "utf8");
  const pkgNext = withRelease(pkgText, snapshot);
  const label = `${snapshot.files.length} files, ${snapshot.deps.length} packages, ${REPO}@${commit.slice(0, 12)}`;
  if (opts.check && pkgNext !== pkgText) {
    console.error(
      "package.json's report2ui5Release is STALE against abap-cloud-gui - the converter this build installs is not the one upstream has. Run `npm run report2ui5` and commit."
    );
    process.exit(1);
  }
  emitSnapshot({
    out,
    json: snapshotJson(snapshot),
    check: opts.check,
    stale:
      "report2ui5.json is STALE against abap-cloud-gui - the converter this build installs is not the one upstream has. Run `npm run report2ui5` and commit.",
    upToDate: `report2ui5.json: up to date (${label})`,
    wrote: `report2ui5.json: ${label}`,
  });
  if (!opts.check && pkgNext !== pkgText) {
    fs.writeFileSync(pkgFile, pkgNext);
  }
}
