import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import * as tar from "tar";
import snapshot from "../data/report2ui5.json";
import { CLI_PATH, PARSER_PROBE, cliIn, resolveReport2cloud } from "../report2cloud";
import {
  installPlan,
  installReport2ui5,
  installRoot,
  integrityError,
  isSafeRelative,
  pinProblems,
  fileError,
  tarballUrl,
  type Download,
  type Report2ui5File,
  type Report2ui5Pin,
} from "../report2ui5install";

/*
 * "Install Report Converter" (src/report2ui5install.ts) and the snapshot it
 * installs from (src/data/report2ui5.json, scripts/generate-report2ui5.mjs).
 *
 * Everything here is offline: the archives are built in the test by a
 * minimal tar writer (so a traversal entry and a link can be written on
 * every platform, Windows included - no symlink is created on disk), the
 * downloads are a map from url to bytes, and the generator runs over a
 * fixture tarball handed in with --tarball. Whether the committed snapshot
 * still matches abap-cloud-gui's main is `npm run report2ui5:check`, which
 * needs the network - the same split as the other snapshots.
 */

const ROOT = path.join(__dirname, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  report2ui5Release?: { commit: string };
};
const PIN = snapshot as Report2ui5Pin;

// ---------------------------------------------------- a minimal tar writer

interface FakeEntry {
  path: string;
  /** "0" file (default), "2" symlink, "1" hard link, "5" directory, "3" char device. */
  type?: string;
  data?: string;
  linkpath?: string;
}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(e: FakeEntry, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(e.path, 0, 100, "utf8");
  h.write(octal(0o644, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(0, 12), 136);
  h.write("        ", 148);
  h.write(e.type ?? "0", 156);
  h.write(e.linkpath ?? "", 157, 100, "utf8");
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) {
    sum += b;
  }
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

function tgz(entries: FakeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.type && e.type !== "0" ? "" : e.data ?? "", "utf8");
    parts.push(header(e, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const sri = (b: Buffer): string => `sha512-${createHash("sha512").update(b).digest("base64")}`;

// ---------------------------------------------------------------- fixtures

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TOP = `abap-cloud-gui-${COMMIT}`;
const TEXTS: Record<string, string> = {
  "tools/report2ui5/cli.mjs": 'import "./lib/convert.mjs";\n',
  "tools/report2ui5/lib/convert.mjs": 'import "@abaplint/core";\n',
};
const record = (p: string, text = TEXTS[p]): Report2ui5File => ({
  path: p,
  size: Buffer.byteLength(text),
  sha256: sha256(Buffer.from(text)),
});
const FILES: Report2ui5File[] = Object.keys(TEXTS).map((p) => record(p));

function sourceEntries(extra: FakeEntry[] = []): FakeEntry[] {
  return [
    { path: `${TOP}/`, type: "5" },
    { path: `${TOP}/README.md`, data: "# not needed" },
    { path: `${TOP}/tools/report2ui5/cli.mjs`, data: TEXTS["tools/report2ui5/cli.mjs"] },
    { path: `${TOP}/tools/report2ui5/lib/convert.mjs`, data: TEXTS["tools/report2ui5/lib/convert.mjs"] },
    { path: `${TOP}/tools/report2ui5/test/big.abap`, data: "x".repeat(2000) },
    ...extra,
  ];
}

const CORE = tgz([
  { path: "package/package.json", data: '{"name":"@abaplint/core","version":"9.9.9"}' },
  { path: "package/build/src/index.js", data: "module.exports = {};" },
]);
const JSON5 = tgz([{ path: "package/package.json", data: '{"name":"json5"}' }]);
const CORE_URL = "https://registry.npmjs.org/@abaplint/core/-/core-9.9.9.tgz";
const JSON5_URL = "https://registry.npmjs.org/json5/-/json5-2.2.3.tgz";

function fixture(source = tgz(sourceEntries())): { pin: Report2ui5Pin; blobs: Map<string, Buffer> } {
  const pin: Report2ui5Pin = {
    commit: COMMIT,
    files: FILES,
    deps: [
      { name: "@abaplint/core", version: "9.9.9", url: CORE_URL, integrity: sri(CORE), path: "node_modules/@abaplint/core" },
      { name: "json5", version: "2.2.3", url: JSON5_URL, integrity: sri(JSON5), path: "node_modules/json5" },
    ],
  };
  const blobs = new Map([
    [tarballUrl(COMMIT), source],
    [CORE_URL, CORE],
    [JSON5_URL, JSON5],
  ]);
  return { pin, blobs };
}

function downloader(blobs: Map<string, Buffer>, fetched: string[] = []): Download {
  return async (url) => {
    fetched.push(url);
    const b = blobs.get(url);
    if (!b) {
      throw new Error(`HTTP 404 for ${url}`);
    }
    return b;
  };
}

function storage(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "r2u-"));
}

/** Everything under `dir`, as relative forward-slash paths. */
function tree(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .map((p) => p.split(path.sep).join("/"))
    .filter((p) => fs.statSync(path.join(dir, p)).isFile())
    .sort();
}

// ------------------------------------------------- the committed snapshot

test("the committed snapshot passes the install's own shape check", () => {
  assert.deepEqual(pinProblems(PIN), []);
  const paths = PIN.files.map((f) => f.path);
  assert.ok(paths.includes("tools/report2ui5/cli.mjs"));
  assert.deepEqual([...paths].sort(), paths, "the generator writes the files sorted");
  assert.ok(PIN.deps.some((d) => d.name === "@abaplint/core"));
});

test("package.json's report2ui5Release names the snapshot's commit", () => {
  assert.deepEqual(PKG.report2ui5Release, { commit: PIN.commit });
});

test("the snapshot is not bundled code: report2ui5.json carries data only", () => {
  const keys = Object.keys(snapshot).sort();
  assert.deepEqual(keys, ["commit", "deps", "files", "note", "source"]);
  for (const f of PIN.files) {
    assert.deepEqual(Object.keys(f).sort(), ["path", "sha256", "size"]);
  }
});

// -------------------------------------------------------------- the plan

test("the plan: codeload's tarball of the commit, then each package, into <storage>/report2ui5/<commit>", () => {
  const { pin } = fixture();
  const plan = installPlan(pin, path.join(path.sep, "s"));
  assert.equal(plan.root, path.join(path.sep, "s", "report2ui5", COMMIT));
  assert.equal(installRoot(path.join(path.sep, "s"), COMMIT), plan.root);
  assert.deepEqual(
    plan.downloads.map((d) => d.url),
    [`https://codeload.github.com/abap2UI5-addons/abap-cloud-gui/tar.gz/${COMMIT}`, CORE_URL, JSON5_URL]
  );
  assert.deepEqual(plan.downloads[0].check, { files: pin.files });
  assert.deepEqual(plan.downloads[1].check, { integrity: pin.deps[0].integrity });
  assert.equal(plan.downloads[1].into, "node_modules/@abaplint/core");
});

test("a pin that would download a branch, an unknown host or outside the tools is refused", () => {
  const { pin } = fixture();
  assert.deepEqual(pinProblems(pin), []);
  assert.match(pinProblems({ ...pin, commit: "main" }).join(), /commit/);
  assert.match(pinProblems({ ...pin, files: [...FILES, record("tools/report2ui5/cli.mjs")] }).join(), /listed twice/);
  assert.match(pinProblems({ ...pin, files: [...FILES, { ...FILES[0], path: "tools/report2ui5/x.mjs", sha256: "abc" }] }).join(), /sha256/);
  assert.match(pinProblems({ ...pin, files: [...FILES, { ...FILES[0], path: "tools/report2ui5/x.mjs", size: -1 }] }).join(), /size/);
  assert.match(pinProblems({ ...pin, files: [...FILES, record("../etc/passwd", "x")] }).join(), /outside/);
  assert.match(pinProblems({ ...pin, files: [...FILES, record("scripts/x.mjs", "x")] }).join(), /outside/);
  const evil = { ...pin.deps[0], url: "https://example.com/core.tgz" };
  assert.match(pinProblems({ ...pin, deps: [evil] }).join(), /registry\.npmjs\.org/);
  const nested = { ...pin.deps[1], path: "node_modules/../../json5" };
  assert.match(pinProblems({ ...pin, deps: [pin.deps[0], nested] }).join(), /install path/);
});

test("safe relative paths: no .., nothing absolute, no backslash, no NUL", () => {
  assert.ok(isSafeRelative("tools/report2ui5/cli.mjs"));
  for (const bad of ["", "../x", "a/../../x", "/etc/passwd", "C:/x", "a\\..\\x", "a\0b"]) {
    assert.equal(isSafeRelative(bad), false, bad);
  }
});

// ---------------------------------------------------------- verification

test("a pinned file: its size and the SHA-256 of its content, nothing else passes", () => {
  const f = record("tools/report2ui5/cli.mjs", "hello");
  assert.equal(fileError(Buffer.from("hello"), f, "x"), undefined);
  assert.match(fileError(Buffer.from("hellO"), f, "x") ?? "", /tools\/report2ui5\/cli\.mjs does not match its pinned SHA-256/);
  assert.match(fileError(Buffer.from("hello!"), f, "x") ?? "", /is 6 bytes, the pin says 5/);
});

test("integrity: npm's SRI string, the strongest algorithm decides", () => {
  const b = Buffer.from("package");
  assert.equal(integrityError(b, sri(b), "p"), undefined);
  const sha1ish = `sha1-${createHash("sha1").update(b).digest("base64")}`;
  assert.equal(integrityError(b, `${sha1ish} ${sri(b)}`, "p"), undefined, "an unknown algorithm is skipped");
  assert.match(integrityError(b, sri(Buffer.from("other")), "p") ?? "", /sha512 integrity/);
  assert.match(integrityError(b, sha1ish, "p") ?? "", /no usable integrity/);
  // a matching weaker hash does not excuse a wrong sha512
  const weak = `sha256-${createHash("sha256").update(b).digest("base64")}`;
  assert.match(integrityError(b, `${weak} ${sri(Buffer.from("other"))}`, "p") ?? "", /sha512/);
});

// --------------------------------------------------------------- install

test("install: only the pinned files and the packages land, in an npm-ci-shaped root the ladder resolves", async () => {
  const dir = storage();
  try {
    const { pin, blobs } = fixture();
    const fetched: string[] = [];
    const r = await installReport2ui5({ pin, storage: dir, download: downloader(blobs, fetched), tar, unique: "t" });
    assert.equal(r.installed, true);
    assert.equal(r.files, 5);
    assert.deepEqual(tree(r.root), [
      "node_modules/@abaplint/core/build/src/index.js",
      "node_modules/@abaplint/core/package.json",
      "node_modules/json5/package.json",
      "tools/report2ui5/cli.mjs",
      "tools/report2ui5/lib/convert.mjs",
    ]);
    assert.equal(fetched.length, 3);
    // nothing but the commit's directory is left in storage
    assert.deepEqual(fs.readdirSync(path.join(dir, "report2ui5")), [COMMIT]);
    assert.equal(cliIn(r.root, fs.existsSync), path.join(r.root, CLI_PATH));
    assert.ok(fs.existsSync(path.join(r.root, PARSER_PROBE)));
    const res = resolveReport2cloud({ setting: "", env: {}, reposRoot: "", dirs: [], installed: r.root, exists: fs.existsSync });
    assert.equal(res.ok && res.source, "installed");

    // a second run downloads nothing
    const again: string[] = [];
    const r2 = await installReport2ui5({ pin, storage: dir, download: downloader(blobs, again), tar });
    assert.equal(r2.installed, false);
    assert.deepEqual(again, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("install: a copy of an older commit goes once the new one is in place", async () => {
  const dir = storage();
  try {
    const old = path.join(dir, "report2ui5", "f".repeat(40));
    fs.mkdirSync(path.join(old, "tools"), { recursive: true });
    const { pin, blobs } = fixture();
    await installReport2ui5({ pin, storage: dir, download: downloader(blobs), tar });
    assert.equal(fs.existsSync(old), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function refused(
  blobs: Map<string, Buffer>,
  pin: Report2ui5Pin,
  pattern: RegExp,
  keep?: (dir: string) => void
): Promise<void> {
  const dir = storage();
  try {
    keep?.(dir);
    await assert.rejects(installReport2ui5({ pin, storage: dir, download: downloader(blobs), tar }), pattern);
    // no staging directory, no half-installed commit
    const left = fs.existsSync(path.join(dir, "report2ui5")) ? fs.readdirSync(path.join(dir, "report2ui5")) : [];
    assert.deepEqual(left.filter((n) => n !== "f".repeat(40)), []);
    if (keep) {
      assert.ok(left.includes("f".repeat(40)), "the copy that was there before stays");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the tarball's own bytes are not pinned: other compression of the same files installs", async () => {
  const dir = storage();
  try {
    const { pin, blobs } = fixture();
    const plain = zlib.gunzipSync(blobs.get(tarballUrl(COMMIT))!);
    const recompressed = zlib.gzipSync(plain, { level: 1 });
    assert.notDeepEqual(recompressed, blobs.get(tarballUrl(COMMIT)));
    blobs.set(tarballUrl(COMMIT), recompressed);
    const r = await installReport2ui5({ pin, storage: dir, download: downloader(blobs), tar });
    assert.equal(r.installed, true);
    assert.equal(fs.readFileSync(path.join(r.root, "tools/report2ui5/cli.mjs"), "utf8"), TEXTS["tools/report2ui5/cli.mjs"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("one changed byte in one pinned file refuses the whole install, naming the file", async () => {
  const { pin, blobs } = fixture();
  const tampered = sourceEntries().map((e) =>
    e.path.endsWith("lib/convert.mjs") ? { ...e, data: e.data!.replace("core", "corf") } : e
  );
  blobs.set(tarballUrl(COMMIT), tgz(tampered));
  await refused(blobs, pin, /tools\/report2ui5\/lib\/convert\.mjs does not match its pinned SHA-256/);
});

test("a pinned file of another size is refused, and a file the pin does not name is never unpacked", async () => {
  const { pin, blobs } = fixture();
  const longer = sourceEntries().map((e) => (e.path.endsWith("cli.mjs") ? { ...e, data: `${e.data}// more\n` } : e));
  blobs.set(tarballUrl(COMMIT), tgz(longer));
  await refused(blobs, pin, /tools\/report2ui5\/cli\.mjs is \d+ bytes, the pin says/);
  const dir = storage();
  try {
    const extra = fixture(tgz(sourceEntries([{ path: `${TOP}/tools/report2ui5/extra.mjs`, data: "evil" }])));
    const r = await installReport2ui5({ pin: extra.pin, storage: dir, download: downloader(extra.blobs), tar });
    assert.equal(fs.existsSync(path.join(r.root, "tools/report2ui5/extra.mjs")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a package that does not match its integrity is refused, and an older install stays", async () => {
  const { pin, blobs } = fixture();
  blobs.set(JSON5_URL, tgz([{ path: "package/package.json", data: '{"name":"json5","evil":1}' }]));
  const old = (dir: string): void => void fs.mkdirSync(path.join(dir, "report2ui5", "f".repeat(40)), { recursive: true });
  await refused(blobs, pin, /json5@2\.2\.3: the download does not match its sha512 integrity/, old);
});

test("a traversal entry anywhere in the source tarball refuses the whole archive", async () => {
  const source = tgz(sourceEntries([{ path: `${TOP}/../../outside.txt`, data: "x" }]));
  const { pin, blobs } = fixture(source);
  await refused(blobs, pin, /unsafe path/);
});

test("an absolute entry is refused", async () => {
  const source = tgz(sourceEntries([{ path: "/etc/cron.d/x", data: "x" }]));
  const { pin, blobs } = fixture(source);
  await refused(blobs, pin, /unsafe path/);
});

test("a symlink at a pinned file, or at a directory above one, is refused", async () => {
  const atFile = tgz(
    sourceEntries().filter((e) => !e.path.endsWith("convert.mjs")).concat([
      { path: `${TOP}/tools/report2ui5/lib/convert.mjs`, type: "2", linkpath: "/etc/passwd" },
    ])
  );
  let { pin, blobs } = fixture(atFile);
  await refused(blobs, pin, /convert\.mjs is a link/);
  const above = tgz([...sourceEntries(), { path: `${TOP}/tools/report2ui5/lib`, type: "2", linkpath: "/tmp" }]);
  ({ pin, blobs } = fixture(above));
  await refused(blobs, pin, /tools\/report2ui5\/lib is a link/);
});

test("a symlink elsewhere in the repository is skipped - it is never unpacked", async () => {
  const dir = storage();
  try {
    const source = tgz(sourceEntries([{ path: `${TOP}/docs/link`, type: "2", linkpath: "../README.md" }]));
    const { pin, blobs } = fixture(source);
    const r = await installReport2ui5({ pin, storage: dir, download: downloader(blobs), tar });
    assert.equal(fs.existsSync(path.join(r.root, "docs")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a link in a package tarball, a device entry, a pinned file missing or twice - all refused", async () => {
  let { pin, blobs } = fixture();
  const linked = tgz([
    { path: "package/package.json", data: "{}" },
    { path: "package/index.js", type: "1", linkpath: "package/package.json" },
  ]);
  blobs.set(JSON5_URL, linked);
  pin = { ...pin, deps: [pin.deps[0], { ...pin.deps[1], integrity: sri(linked) }] };
  await refused(blobs, pin, /index\.js is a link/);

  const device = tgz(sourceEntries().filter((e) => !e.path.endsWith("cli.mjs")).concat([
    { path: `${TOP}/tools/report2ui5/cli.mjs`, type: "3" },
  ]));
  ({ pin, blobs } = fixture(device));
  await refused(blobs, pin, /cli\.mjs is a CharacterDevice/);

  const missing = tgz(sourceEntries().filter((e) => !e.path.endsWith("convert.mjs")));
  ({ pin, blobs } = fixture(missing));
  await refused(blobs, pin, /lacks tools\/report2ui5\/lib\/convert\.mjs/);

  const twice = tgz(sourceEntries([{ path: `${TOP}/tools/report2ui5/cli.mjs`, data: "second" }]));
  ({ pin, blobs } = fixture(twice));
  await refused(blobs, pin, /appears twice/);
});

test("not a tarball at all (a proxy's block page) is refused", async () => {
  const page = Buffer.from("<html>blocked</html>");
  const { pin, blobs } = fixture(page);
  await refused(blobs, pin, /not a readable archive|lacks/);
});

test("cancelled: the install stops and removes its staging directory", async () => {
  const { pin, blobs } = fixture();
  const dir = storage();
  try {
    const aborter = new AbortController();
    const download: Download = async (url) => {
      aborter.abort(new Error("install cancelled"));
      return blobs.get(url)!;
    };
    await assert.rejects(
      installReport2ui5({ pin, storage: dir, download, tar, signal: aborter.signal }),
      /install cancelled/
    );
    assert.deepEqual(fs.readdirSync(path.join(dir, "report2ui5")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unusable pin is refused before anything is downloaded", async () => {
  const { pin, blobs } = fixture();
  const fetched: string[] = [];
  const dir = storage();
  try {
    await assert.rejects(
      installReport2ui5({ pin: { ...pin, commit: "main" }, storage: dir, download: downloader(blobs, fetched), tar }),
      /unusable/
    );
    assert.deepEqual(fetched, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- generator

const GENERATOR = path.join(ROOT, "scripts", "generate-report2ui5.mjs");

function generatorFixture(cli: string): Buffer {
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { name: "abap-cloud-gui" },
      "node_modules/@abaplint/core": {
        version: "9.9.9",
        resolved: CORE_URL,
        integrity: sri(CORE),
        dependencies: { json5: "^2", strnum: "^2" },
      },
      "node_modules/json5": { version: "2.2.3", resolved: JSON5_URL, integrity: sri(JSON5) },
      "node_modules/@abaplint/core/node_modules/strnum": {
        version: "2.5.1",
        resolved: "https://registry.npmjs.org/strnum/-/strnum-2.5.1.tgz",
        integrity: "sha512-AAAA",
      },
      "node_modules/strnum": { version: "1.0.0", resolved: "https://registry.npmjs.org/strnum/-/strnum-1.0.0.tgz", integrity: "sha512-BBBB" },
      "node_modules/unrelated": { version: "1.0.0", resolved: "https://registry.npmjs.org/u/-/u-1.0.0.tgz", integrity: "sha512-CCCC" },
    },
  };
  return tgz([
    { path: `${TOP}/package-lock.json`, data: JSON.stringify(lock) },
    { path: `${TOP}/tools/report2ui5/cli.mjs`, data: cli },
    {
      path: `${TOP}/tools/report2ui5/lib/convert.mjs`,
      data:
        'import { readFileSync } from "node:fs";\nimport * as path from "path";\nimport * as core from "@abaplint/core";\n' +
        'import { indent } from "@abaplint/core/build/src/pretty_printer/indent.js";\nexport const x = 1;\n',
    },
    { path: `${TOP}/tools/report2ui5/lib/gate.mjs`, data: 'import { spawn } from "node:child_process";\nexport const g = 1;\n' },
    { path: `${TOP}/tools/report2ui5/lib/unused.mjs`, data: "export const u = 1;\n" },
  ]);
}

const GOOD_CLI =
  '// import "./lib/unused.mjs";  - a comment is not an import\n' +
  'import { x } from "./lib/convert.mjs";\n' +
  'const usage = `import "./lib/unused.mjs"`;\n' +
  'export async function check() { return import("./lib/gate.mjs"); }\n';

function generate(dir: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    [GENERATOR, "--ref", COMMIT, "--tarball", path.join(dir, "src.tgz"), "--out", path.join(dir, "r.json"), "--package", path.join(dir, "package.json"), ...args],
    { encoding: "utf8", cwd: ROOT }
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("generator: commit, checksum, the CLI's import closure and the lock's closure - offline over --tarball", () => {
  const dir = storage();
  try {
    const source = generatorFixture(GOOD_CLI);
    fs.writeFileSync(path.join(dir, "src.tgz"), source);
    fs.writeFileSync(path.join(dir, "package.json"), '{\n  "name": "x"\n}\n');
    const r = generate(dir, []);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(fs.readFileSync(path.join(dir, "r.json"), "utf8")) as Report2ui5Pin & { source: string };
    assert.equal(out.commit, COMMIT);
    assert.deepEqual(out.files.map((f) => f.path), ["tools/report2ui5/cli.mjs", "tools/report2ui5/lib/convert.mjs", "tools/report2ui5/lib/gate.mjs"]);
    assert.deepEqual(out.files[0], record("tools/report2ui5/cli.mjs", GOOD_CLI));
    // the archive's compression does not enter the snapshot
    const recompressed = zlib.gzipSync(zlib.gunzipSync(source), { level: 1 });
    fs.writeFileSync(path.join(dir, "src.tgz"), recompressed);
    const same = generate(dir, ["--check"]);
    assert.equal(same.status, 0, same.stderr);
    assert.deepEqual(
      out.deps.map((d) => `${d.path}@${d.version}`),
      ["node_modules/@abaplint/core@9.9.9", "node_modules/@abaplint/core/node_modules/strnum@2.5.1", "node_modules/json5@2.2.3"]
    );
    assert.deepEqual(out.deps.find((d) => d.name === "json5"), {
      name: "json5", version: "2.2.3", url: JSON5_URL, integrity: sri(JSON5), path: "node_modules/json5",
    });
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    assert.deepEqual(pkg.report2ui5Release, { commit: COMMIT });

    // --check over the same artefact: up to date
    const ok = generate(dir, ["--check"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /up to date/);

    // a hand edit of the snapshot is STALE
    fs.writeFileSync(path.join(dir, "r.json"), fs.readFileSync(path.join(dir, "r.json"), "utf8").replace("9.9.9", "9.9.8"));
    const stale = generate(dir, ["--check"]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /report2ui5\.json is STALE/);

    // and so is a package.json record that does not match
    generate(dir, []);
    fs.writeFileSync(path.join(dir, "package.json"), '{\n  "name": "x"\n}\n');
    const pkgStale = generate(dir, ["--check"]);
    assert.equal(pkgStale.status, 1);
    assert.match(pkgStale.stderr, /report2ui5Release is STALE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("generator: a CLI that imports another package is refused", () => {
  const dir = storage();
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
    fs.writeFileSync(path.join(dir, "src.tgz"), generatorFixture('import "lodash";\n'));
    const r = generate(dir, []);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /imports lodash/);
    assert.equal(fs.existsSync(path.join(dir, "r.json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("generator: the npm scripts exist and the weekly bump calls the shared workflow like the others", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.report2ui5, "node scripts/generate-report2ui5.mjs");
  assert.equal(pkg.scripts["report2ui5:check"], "node scripts/generate-report2ui5.mjs --check");
  const wf = fs.readFileSync(path.join(ROOT, ".github", "workflows", "bump-report2ui5.yml"), "utf8");
  assert.match(wf, /uses: \.\/\.github\/workflows\/bump-snapshot\.yml/);
  assert.match(wf, /secrets: inherit/);
  assert.match(wf, /src\/data\/report2ui5\.json/);
  assert.match(wf, /node scripts\/generate-report2ui5\.mjs/);
});
