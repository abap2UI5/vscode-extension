/*
 * Renders the settings reference in README.md from the one authoritative
 * source - `contributes.configuration` in package.json.
 *
 * Same lifecycle as the snapshot generators in this directory, minus the
 * upstream fetch (both files live in this repository): regenerate rewrites
 * the section between the two markers, `--check` fails when the committed
 * README no longer matches the manifest - that is what `npm run
 * settings:check` and the test suite run, so a new or reworded setting
 * cannot ship without its documentation moving with it.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { invokedDirectly, parseArgs } from "./lib/snapshot.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const README = path.join(ROOT, "README.md");

export const BEGIN_MARK = "<!-- BEGIN GENERATED SETTINGS (npm run settings) -->";
export const END_MARK = "<!-- END GENERATED SETTINGS -->";

/** The first paragraph of a setting's description, as one table-safe line:
 *  markdown stays (the README renders it), newlines and `|` cannot. The
 *  `#abap2ui5.x#` cross-reference syntax is VS Code's own and means nothing
 *  in a README, so it becomes ordinary code formatting. */
export function summaryOf(property) {
  const md = property.markdownDescription ?? property.description ?? "";
  const firstParagraph = md.split(/\n[ \t]*\n/)[0] ?? "";
  let line = firstParagraph
    // both spellings the manifest uses: `#abap2ui5.x#` (already in backticks)
    // and a bare #abap2ui5.x#
    .replace(/`#(abap2ui5\.[\w.]+)#`/g, "`$1`")
    .replace(/#(abap2ui5\.[\w.]+)#/g, "`$1`")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
  if (property.markdownDeprecationMessage) {
    line += " *(deprecated)*";
  }
  return line;
}

/** The default, as it would stand in settings.json - `[]` and `{}` say more
 *  than a dash, and a string default keeps its quotes. */
export function defaultOf(property) {
  return "default" in property
    ? `\`${JSON.stringify(property.default).replace(/\|/g, "\\|")}\``
    : "";
}

/** The generated section body: one table row per setting, in manifest order
 *  (the manifest groups related settings already). */
export function renderSettings(manifest) {
  const properties = manifest.contributes?.configuration?.properties ?? {};
  const rows = Object.entries(properties).map(
    ([id, property]) =>
      `| \`${id}\` | ${defaultOf(property)} | ${summaryOf(property)} |`
  );
  return [
    "| Setting | Default | Description |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** The README with the section between the markers replaced. Throws when a
 *  marker is missing - a silently appended second table helps nobody. */
export function updatedReadme(readme, section) {
  const begin = readme.indexOf(BEGIN_MARK);
  const end = readme.indexOf(END_MARK);
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error(
      `README.md is missing the ${BEGIN_MARK} / ${END_MARK} markers`
    );
  }
  return (
    readme.slice(0, begin + BEGIN_MARK.length) +
    "\n" +
    section +
    "\n" +
    readme.slice(end)
  );
}

function main() {
  const { check } = parseArgs();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
  );
  const readme = fs.readFileSync(README, "utf8");
  const next = updatedReadme(readme, renderSettings(manifest));
  if (check) {
    if (readme !== next) {
      console.error(
        "generate-settings: STALE - the settings reference in README.md no " +
          "longer matches contributes.configuration. " +
          "Run `npm run settings` and commit the README."
      );
      process.exit(1);
    }
    console.log("generate-settings: README.md is up to date");
    return;
  }
  if (readme === next) {
    console.log("generate-settings: README.md already up to date");
    return;
  }
  fs.writeFileSync(README, next);
  console.log("generate-settings: wrote the settings reference into README.md");
}

if (invokedDirectly(import.meta.url)) {
  main();
}
