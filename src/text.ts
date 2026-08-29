/*
 * `vscode`-free text helpers for the strings users read.
 *
 * One pluralizer instead of the "(s)" suffix that used to be pasted into
 * every message: "1 file(s)" reads like a form letter, and the UI already
 * knows the count. Log lines are diagnostics and may stay terse - this is
 * for notifications, tooltips, titles and webview text.
 */

/**
 * `plural(3, "file")` -> "3 files", `plural(1, "file")` -> "1 file".
 * Irregular plurals name themselves: `plural(2, "entry", "entries")`.
 * A noun ending in x/s/sh/ch takes "es" ("fix" -> "fixes").
 */
export function plural(count: number, noun: string, plurally?: string): string {
  if (count === 1) {
    return `1 ${noun}`;
  }
  const many =
    plurally ?? (/(?:x|s|sh|ch)$/i.test(noun) ? `${noun}es` : `${noun}s`);
  return `${count} ${many}`;
}
