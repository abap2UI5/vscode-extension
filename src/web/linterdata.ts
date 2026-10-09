import * as fs from "fs";

/*
 * The bundled linter's own data files in the web build.
 *
 * The icon rules are the one place the linter reads a data file itself: its
 * `icons.mjs` loads `data/icons.json` with `fs.readFileSync` from
 * `path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data",
 * "icons.json")`, and `checkAbapRules` takes no `iconData` to pass the data
 * in. On the desktop that path is the extension root's `data/` (esbuild.js
 * copies the file there). In the browser there is no file system: `fs` is
 * `scripts/web-shims/fs.js`, whose failed read `loadIcons` treats as an empty
 * registry - so `unknown-icon`, `icon-too-new` and `icon-removed` simply never
 * fired on vscode.dev while the desktop editor and CI reported them.
 *
 * So the web entry reads the packaged file through `vscode.workspace.fs` and
 * seeds the shim with it, under the path the linter computes over the web
 * shims (`import.meta.url` is `file:///web/extension.js` there).
 * `webshim.test.ts` evaluates the linter's formula with the shims and holds
 * it to `path`, and runs the icon rule through a web-config bundle.
 *
 * `vscode`-free: the caller supplies the reader.
 */

/** One data file: the path the linter reads, and where the packaged copy
 *  lives relative to the extension root. */
export interface LinterDataFile {
  path: string;
  packaged: string[];
}

export const LINTER_DATA_FILES: readonly LinterDataFile[] = [
  { path: "/data/icons.json", packaged: ["data", "icons.json"] },
];

type Seed = (file: string, text: string) => void;

/**
 * Reads every data file with `read` and hands it to the `fs` shim. Must run
 * before the first check: the linter caches what it loaded per path, an
 * empty registry included. Answers what could not be seeded, for the log -
 * outside the web build (`fs` is node's own) there is nothing to seed and
 * nothing to report.
 */
export async function seedLinterData(
  read: (packaged: string[]) => Promise<string>
): Promise<string[]> {
  const seed = (fs as unknown as { seedFile?: Seed }).seedFile;
  if (typeof seed !== "function") {
    return [];
  }
  const failed: string[] = [];
  for (const file of LINTER_DATA_FILES) {
    try {
      seed(file.path, await read(file.packaged));
    } catch (err) {
      failed.push(
        `${file.packaged.join("/")}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return failed;
}
