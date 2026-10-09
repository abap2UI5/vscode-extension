// Web-build shim: `fs` exists so the modules that import it load in the
// browser extension host. There is no file system behind it: the web entry
// reads what it needs through vscode.workspace.fs instead.
//
// One exception, and it is the linter's: its icon rules load their own data
// file (`data/icons.json`) with `fs.readFileSync`, from a path computed off
// `import.meta.url`. The extension cannot hand that data in - `checkAbapRules`
// takes no `iconData` - so the web entry reads the file through
// vscode.workspace.fs and SEEDS it here, under exactly the path the linter
// asks for (`src/web/linterdata.ts`). Without the seed `loadIcons` swallows
// the failed read as an empty registry by design, and `unknown-icon`,
// `icon-too-new` and `icon-removed` never fired on vscode.dev.
const seeded = new Map();
const fail = (name) => () => {
  throw new Error(`fs.${name} is not available in the web build`);
};
module.exports = {
  readFileSync: (file) => {
    const text = seeded.get(String(file));
    if (text === undefined) {
      fail("readFileSync")();
    }
    return text;
  },
  existsSync: (file) => seeded.has(String(file)),
  writeFileSync: fail("writeFileSync"),
  mkdtempSync: fail("mkdtempSync"),
  rmSync: fail("rmSync"),
  /** Not a node API: makes `readFileSync(file)` answer `text`. */
  seedFile: (file, text) => {
    seeded.set(String(file), String(text));
  },
};
