#!/usr/bin/env node
/*
 * Vendors the agent-snapshot code of abap2UI5/mcp-server into this
 * extension: the three pure modules behind its app_start / app_describe /
 * app_act tools, and the recorded backend sessions its tests replay.
 *
 *   lib/viewxml.mjs              -> src/vendor/agent/viewxml.js
 *   lib/snapshot.mjs             -> src/vendor/agent/snapshot.js
 *   lib/appclient.mjs            -> src/vendor/agent/appclient.js
 *   test/fixtures/agent/*.json   -> src/test/fixtures/agent/*.json
 *
 * Why vendored and not a dependency: the snapshot is a CONTRACT
 * (docs/agent-snapshot.md upstream) that three implementations share - the
 * MCP server against its transpiled backend, this extension against a real
 * system, the ABAP addon in-system - and the extension must describe a
 * screen exactly as the server does. A second implementation here is how the
 * two would drift; mcp-server is no npm dependency of the extension (it is a
 * program the extension may START), so the code is copied, mechanically, at a
 * recorded COMMIT rather than a moving branch: code, unlike the data
 * snapshots in src/data/, changes behaviour, and a bump has to go through
 * this repository's tests.
 *
 * The one transformation: the sibling imports `./x.mjs` become `./x.js`. The
 * copies are `.js` files because this package is CommonJS for TypeScript -
 * an `.mjs` import from a `.ts` file is refused (TS1479) - and esbuild bundles
 * the ES module syntax inside them either way. The hand-written `.d.ts` next
 * to each copy types the slice of the API the extension uses.
 *
 * Every copy starts with a header naming the repository, the path and the
 * commit; `src/vendor/agent/source.json` records the commit and the sha256 of
 * every file written, and `src/test/agentvendor.test.ts` (npm test, offline)
 * fails when a copy no longer matches its recorded hash - a hand edit.
 *
 *   node scripts/vendor-agent.mjs /path/to/mcp-server            (its HEAD)
 *   node scripts/vendor-agent.mjs /path/to/mcp-server --ref <rev>
 *   node scripts/vendor-agent.mjs --ref <sha>                    (GitHub raw)
 *   node scripts/vendor-agent.mjs [/path/to/mcp-server] --check
 *        (regenerates from the RECORDED commit in memory and fails when a
 *         committed copy differs - the copy drifted from its source commit)
 *
 * A local checkout is read through `git show <commit>:<path>`, so its working
 * tree and branch do not matter - only that it has the commit.
 */
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { FETCH_TIMEOUT_MS, invokedDirectly } from "./lib/snapshot.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "abap2UI5/mcp-server";
const TOOL = "vendor-agent";
const VENDOR_DIR = "src/vendor/agent";
const FIXTURE_DIR = "src/test/fixtures/agent";
export const SOURCE_RECORD = `${VENDOR_DIR}/source.json`;

/** The modules, upstream path -> vendored path. */
export const MODULES = {
  "lib/viewxml.mjs": `${VENDOR_DIR}/viewxml.js`,
  "lib/snapshot.mjs": `${VENDOR_DIR}/snapshot.js`,
  "lib/appclient.mjs": `${VENDOR_DIR}/appclient.js`,
};
const UPSTREAM_FIXTURES = "test/fixtures/agent";

/** The header every vendored module starts with. */
export function moduleHeader(from, commit) {
  return (
    "/*\n" +
    ` * VENDORED - do not edit. ${REPO} ${from}\n` +
    ` * at commit ${commit},\n` +
    " * copied by scripts/vendor-agent.mjs (`npm run agent-vendor`); the only\n" +
    " * change is the sibling imports ending in .js. `npm run agent-vendor:check`\n" +
    " * fails when this copy drifts from that commit. Change it upstream, then\n" +
    " * re-vendor.\n" +
    " */\n"
  );
}

/** One upstream module as it is vendored. */
export function vendorModule(text, from, commit) {
  const body = text
    .replace(/\r\n/g, "\n")
    .replace(/from '\.\/(viewxml|snapshot|appclient)\.mjs'/g, "from './$1.js'");
  return moduleHeader(from, commit) + body;
}

export const sha256 = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function fail(message, code = 1) {
  console.error(`${TOOL}: ${message}`);
  process.exit(code);
}

function git(local, args) {
  return execFileSync("git", ["-C", local, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Where the upstream files come from: a local checkout's git objects, or
 *  GitHub raw at the commit. Both answer `read(path)` and `list(dir)`. */
function upstream(local, commit) {
  if (local) {
    return {
      read: (file) => git(local, ["show", `${commit}:${file}`]),
      list: async (dir) =>
        git(local, ["ls-tree", "--name-only", `${commit}`, `${dir}/`])
          .split("\n")
          .filter(Boolean)
          .map((p) => p.slice(dir.length + 1)),
    };
  }
  const get = async (url, accept) => {
    const res = await fetch(url, {
      headers: accept ? { accept } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      fail(`${url} -> HTTP ${res.status}`, 2);
    }
    return res.text();
  };
  return {
    read: (file) =>
      get(`https://raw.githubusercontent.com/${REPO}/${commit}/${file}`),
    list: async (dir) => {
      const entries = JSON.parse(
        await get(
          `https://api.github.com/repos/${REPO}/contents/${dir}?ref=${commit}`,
          "application/vnd.github+json"
        )
      );
      return entries.filter((e) => e.type === "file").map((e) => e.name);
    },
  };
}

/** The full commit a ref names: from the checkout, or from the GitHub API. */
async function resolveCommit(local, ref) {
  if (/^[0-9a-f]{40}$/.test(ref)) {
    return ref;
  }
  if (local) {
    return git(local, ["rev-parse", `${ref}^{commit}`]).trim();
  }
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${ref}`, {
    headers: { accept: "application/vnd.github.sha" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    fail(`cannot resolve ${REPO}@${ref} -> HTTP ${res.status}`, 2);
  }
  return (await res.text()).trim();
}

/** Every vendored file, path -> content, for one commit. */
async function build(local, commit) {
  const src = upstream(local, commit);
  const files = {};
  const from = {};
  for (const [up, out] of Object.entries(MODULES)) {
    files[out] = vendorModule(await src.read(up), up, commit);
    from[out] = up;
  }
  const fixtures = (await src.list(UPSTREAM_FIXTURES))
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (!fixtures.length) {
    fail(`${REPO}@${commit} has no ${UPSTREAM_FIXTURES}/*.json`);
  }
  for (const f of fixtures) {
    const up = `${UPSTREAM_FIXTURES}/${f}`;
    const out = `${FIXTURE_DIR}/${f}`;
    files[out] = (await src.read(up)).replace(/\r\n/g, "\n");
    from[out] = up;
  }
  const record = {
    note:
      `What scripts/vendor-agent.mjs copied from ${REPO}, at which commit, and ` +
      "the sha256 of every file it wrote. Generated - do not edit; " +
      "src/test/agentvendor.test.ts holds the copies to these hashes.",
    repository: REPO,
    commit,
    files: Object.fromEntries(
      Object.keys(files)
        .sort()
        .map((out) => [out, { from: from[out], sha256: sha256(files[out]) }])
    ),
  };
  files[SOURCE_RECORD] = `${JSON.stringify(record, null, 2)}\n`;
  return files;
}

/** What is committed under the two vendored folders right now. */
function committedFiles() {
  const out = {};
  for (const dir of [VENDOR_DIR, FIXTURE_DIR]) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) {
      continue;
    }
    for (const f of fs.readdirSync(abs)) {
      // the .d.ts files are this repository's own, not vendored
      if (f.endsWith(".d.ts")) {
        continue;
      }
      out[`${dir}/${f}`] = fs.readFileSync(path.join(abs, f), "utf8");
    }
  }
  return out;
}

if (invokedDirectly(import.meta.url)) {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const refAt = argv.indexOf("--ref");
  const ref = refAt >= 0 ? argv[refAt + 1] : undefined;
  if (refAt >= 0 && (!ref || ref.startsWith("--"))) {
    fail("--ref needs a value (a commit, tag or branch)");
  }
  const local = argv.find(
    (a, i) => !a.startsWith("--") && !(refAt >= 0 && i === refAt + 1)
  );

  const recordPath = path.join(ROOT, SOURCE_RECORD);
  const recorded = fs.existsSync(recordPath)
    ? JSON.parse(fs.readFileSync(recordPath, "utf8")).commit
    : undefined;

  if (check) {
    if (!recorded) {
      fail(`${SOURCE_RECORD} is missing - run \`npm run agent-vendor\` first`);
    }
    const want = await build(local, recorded);
    const have = committedFiles();
    const problems = [];
    for (const [file, text] of Object.entries(want)) {
      if (have[file] === undefined) {
        problems.push(`missing: ${file}`);
      } else if (have[file] !== text) {
        problems.push(`differs from ${REPO}@${recorded.slice(0, 12)}: ${file}`);
      }
    }
    for (const file of Object.keys(have)) {
      if (want[file] === undefined) {
        problems.push(`not vendored from upstream (remove it): ${file}`);
      }
    }
    if (problems.length) {
      console.error(
        `${TOOL}: the vendored agent code DRIFTED from ${REPO}@${recorded}:`
      );
      for (const p of problems) {
        console.error(`  ${p}`);
      }
      console.error(
        "Re-vendor with `npm run agent-vendor -- /path/to/mcp-server --ref " +
          `${recorded}\` (or a newer commit) instead of editing the copies.`
      );
      process.exit(1);
    }
    console.log(
      `agent vendor: up to date with ${REPO}@${recorded.slice(0, 12)} ` +
        `(${Object.keys(want).length} files)`
    );
  } else {
    if (!local && !ref) {
      fail(
        "name the source - a local checkout (its HEAD is taken) and/or --ref <commit>"
      );
    }
    const commit = await resolveCommit(local, ref || "HEAD");
    const files = await build(local, commit);
    // a fixture dropped upstream must not linger here
    for (const file of Object.keys(committedFiles())) {
      if (files[file] === undefined) {
        fs.rmSync(path.join(ROOT, file));
      }
    }
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(ROOT, file)), { recursive: true });
      fs.writeFileSync(path.join(ROOT, file), text);
    }
    console.log(
      `agent vendor: ${Object.keys(files).length} files from ${REPO}@${commit}` +
        (recorded && recorded !== commit ? ` (was ${recorded.slice(0, 12)})` : "")
    );
  }
}
