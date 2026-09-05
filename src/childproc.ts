import { spawn, type ChildProcess } from "child_process";
import { quoteForShell } from "./checkcore";

/*
 * The one way this extension starts a checker.
 *
 * Three places used to spawn the same CLI three times over, and only one of
 * them had learned each lesson:
 *
 * - the render gate had a timeout and a kill, because "npx resolving a GitHub
 *   dependency on a slow line" left a stuck child behind on every save. The
 *   view preview reimplemented the spawn WITHOUT either, so one hung checker
 *   wedged the panel until the window was reloaded and left a Chromium tree
 *   running with nothing holding it.
 * - the render gate quoted its arguments for cmd.exe, because a scratch file
 *   under `C:\Users\John Smith\...` otherwise arrives as two arguments. The
 *   preview did not, so it answered "nothing could be rendered" for every
 *   Windows user whose profile name has a space in it.
 * - and NEITHER quoted the program itself, so an `abap2ui5.viewCheck.command`
 *   pointing at `C:\Program Files\nodejs\node.exe` - the documented shape of
 *   that setting - was split at the space by cmd.exe and reported as "not
 *   recognized", with an offer to install a gate that could not fix it.
 *
 * So the lessons live here now, once. `vscode`-free on purpose: the decisions
 * are testable, and the callers keep the editor-facing parts.
 */

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Run through a shell. Node then hands cmd AND args over unquoted, so both
   *  are quoted here - see `quoteForShell`. */
  shell?: boolean;
  /** Kill the child (and its tree) after this many ms. Omitted = no limit. */
  timeoutMs?: number;
  /** Polled while the child runs; true means nothing will be done with the
   *  answer any more, so stop paying for it. */
  abandoned?: () => boolean;
  /** How often `abandoned` is asked. */
  pollMs?: number;
  platform?: NodeJS.Platform;
}

export type RunOutcome =
  | { kind: "closed"; code: number | null; stdout: string; stderr: string }
  /** The process could not be started at all (ENOENT and friends). */
  | { kind: "spawn-failed"; error: Error }
  /** Killed by `timeoutMs`. */
  | { kind: "timeout"; stdout: string; stderr: string }
  /** Killed because `abandoned()` said so. */
  | { kind: "abandoned" };

/**
 * Kills a child and everything it started.
 *
 * `npx` spawns the real checker, which spawns Chromium - killing only the
 * shell leaves both behind, which is how a cancelled check used to cost a
 * browser process for the rest of the session. On Windows `taskkill /t` walks
 * the tree; elsewhere `run` starts the child as its own process GROUP
 * (`detached`), so the negative-pid kill reaches every descendant - signalling
 * only the direct child left the grandchildren running.
 */
export function killTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform
): void {
  if (child.pid === undefined || child.killed) {
    return;
  }
  try {
    if (platform === "win32") {
      // a taskkill that cannot be started emits "error" asynchronously - the
      // try/catch below does not see it, and unheard it is an uncaught
      // exception in the extension host
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]).on(
        "error",
        () => {}
      );
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // not a group leader (spawned elsewhere) - the child itself, then
        child.kill("SIGKILL");
      }
    }
  } catch {
    /* already gone */
  }
}

/** The command line as it must be handed to the shell - program included.
 *  Exported for the tests; `run` applies it itself. */
export function shellSafe(
  cmd: string,
  args: readonly string[],
  platform: NodeJS.Platform
): { cmd: string; args: string[] } {
  return {
    cmd: quoteForShell(cmd, platform),
    args: args.map((arg) => quoteForShell(arg, platform)),
  };
}

/**
 * Runs a command to completion and reports how it ended - never rejects, so
 * a caller can treat "did not start", "hung" and "said something" the same
 * way and always reach its own cleanup.
 */
export function run(
  cmd: string,
  args: readonly string[],
  options: RunOptions = {}
): Promise<RunOutcome> {
  const platform = options.platform ?? process.platform;
  const shell = options.shell ?? false;
  const safe = shell ? shellSafe(cmd, args, platform) : { cmd, args: [...args] };

  return new Promise<RunOutcome>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    let child: ChildProcess;
    try {
      child = spawn(safe.cmd, safe.args, {
        cwd: options.cwd,
        env: options.env,
        shell,
        // its own process group, so killTree can reach the grandchildren
        detached: platform !== "win32",
      });
    } catch (err) {
      // spawn( ) validates its arguments synchronously: an empty program (a
      // `viewCheck.command` of "" splits into one empty word) throws here
      // instead of emitting "error", and inside a Promise executor a throw is
      // a rejection - which "never rejects" has to cover too
      resolve({
        kind: "spawn-failed",
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    // A failed spawn emits "error" and may still emit "close" - and a timeout
    // races both. Whoever is first wins, and the timers go with it.
    const finish = (outcome: RunOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(limit);
      clearInterval(poll);
      resolve(outcome);
    };

    const limit = options.timeoutMs
      ? setTimeout(() => {
          killTree(child, platform);
          finish({ kind: "timeout", stdout, stderr });
        }, options.timeoutMs)
      : undefined;

    const poll = options.abandoned
      ? setInterval(() => {
          if (options.abandoned?.()) {
            killTree(child, platform);
            finish({ kind: "abandoned" });
          }
        }, options.pollMs ?? 500)
      : undefined;

    // decoded by the stream, not per chunk: String(chunk) cut multibyte
    // UTF-8 at the 64 KiB pipe boundary into two replacement characters
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c) => (stdout += String(c)));
    child.stderr?.on("data", (c) => (stderr += String(c)));
    child.on("error", (error) => finish({ kind: "spawn-failed", error }));
    child.on("close", (code) => finish({ kind: "closed", code, stdout, stderr }));
  });
}
