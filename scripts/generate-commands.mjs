/*
 * Renders the command reference in README.md from the one authoritative
 * source - `contributes.commands` in package.json, with the keys off
 * `contributes.keybindings`.
 *
 * There was no such reference. The extension contributes 43 commands; the
 * README said "All commands are in the Command Palette under abap2UI5" and
 * listed none, and the manual over in abap2UI5/docs sends the reader here for
 * exactly this: "the full settings AND COMMAND tables are in the repository
 * README". The settings half of that sentence was true. This is the other
 * half - and generated rather than typed, for the same reason the settings
 * table is: a command renamed in the manifest and left standing in the prose
 * is a reader looking for something that is not there any more.
 *
 * Same lifecycle as generate-settings.mjs next to it: regenerate rewrites the
 * section between the two markers, `--check` fails when the committed README
 * no longer matches the manifest, and src/test/commands.test.ts runs that
 * check inside `npm test`.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { invokedDirectly, parseArgs } from "./lib/snapshot.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const README = path.join(ROOT, "README.md");

export const BEGIN_MARK = "<!-- BEGIN GENERATED COMMANDS (npm run commands) -->";
export const END_MARK = "<!-- END GENERATED COMMANDS -->";

/** The title as the Command Palette shows it, minus the key the manifest
 *  repeats in it - the key has a column of its own, and "Run App (F9) | F9"
 *  says it twice. */
export function titleOf(command) {
  return String(command.title ?? "")
    .replace(/\s*\((?:F\d+|Ctrl[^)]*|Cmd[^)]*|Alt[^)]*|Shift[^)]*)\)\s*$/i, "")
    .replace(/\|/g, "\\|")
    .trim();
}

/** What a reader presses, if anything. Both platforms when they differ - the
 *  manifest carries `mac` separately, and a Mac reader given only the Windows
 *  chord has to guess. */
export function keysOf(id, keybindings) {
  const hits = keybindings.filter((k) => k.command === id);
  if (!hits.length) return "";
  const pretty = (k) => `\`${k.replace(/\+/g, "+")}\``;
  return [...new Set(hits.flatMap((k) => [pretty(k.key), k.mac && k.mac !== k.key ? pretty(k.mac) : null]
    .filter(Boolean)))].join(" / ");
}

/** The generated section body: one row per command, in manifest order, which
 *  groups them the way the palette does. */
export function renderCommands(manifest) {
  const commands = manifest.contributes?.commands ?? [];
  const keybindings = manifest.contributes?.keybindings ?? [];
  const rows = commands.map(
    (c) => `| ${titleOf(c)} | \`${c.command}\` | ${keysOf(c.command, keybindings)} |`
  );
  return ["| Command | Id | Key |", "| --- | --- | --- |", ...rows].join("\n");
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
  /* EOL-agnostic, for the same reason generate-settings.mjs is: the Windows
   * runner checks out with core.autocrlf=true, so a byte comparison against
   * LF-rendered content could never pass there. */
  const raw = fs.readFileSync(README, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const readme = raw.replace(/\r\n/g, "\n");
  const next = updatedReadme(readme, renderCommands(manifest));
  if (check) {
    if (readme !== next) {
      console.error(
        "generate-commands: STALE - the command reference in README.md no " +
          "longer matches contributes.commands. " +
          "Run `npm run commands` and commit the README."
      );
      process.exit(1);
    }
    console.log("generate-commands: README.md is up to date");
    return;
  }
  if (readme === next) {
    console.log("generate-commands: README.md already up to date");
    return;
  }
  fs.writeFileSync(README, eol === "\n" ? next : next.replace(/\n/g, eol));
  console.log("generate-commands: wrote the command reference into README.md");
}

if (invokedDirectly(import.meta.url)) {
  main();
}
