import type { Readable, Writable } from "stream";

/*
 * cdp - a minimal client for the Chrome DevTools Protocol over
 * `--remote-debugging-pipe`.
 *
 * `vscode`-free. The browser reads JSON messages from its file descriptor 3
 * and writes its own to descriptor 4, each message ended by a NUL byte - no
 * TCP port, so no listener anybody else on the machine could reach (the
 * AGENTS.md rule for local listeners does not even arise). This is all of the
 * protocol the browser logon needs: commands with an id and their answers,
 * events, and sessions of attached targets (`flatten: true`, one pipe for
 * all of them). No dependency: puppeteer or playwright would add megabytes
 * to the `.vsix` for six commands.
 *
 * Nothing here logs. What the browser sends back can hold cookie values
 * (`Network.getCookies`), so a message is handed to its caller and never
 * printed - an error says which METHOD failed, never what was answered.
 */

/** One protocol message as it travels over the pipe. */
export interface CdpMessage {
  id?: number;
  method?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result?: any;
  error?: { code?: number; message?: string };
  sessionId?: string;
}

/** An event the browser sent - a message without an id. */
export interface CdpEvent {
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any;
  sessionId?: string;
}

/** A command the browser answered with an error, or that never got an answer
 *  because the pipe closed. */
export class CdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpError";
  }
}

interface Pending {
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve(result: any): void;
  reject(err: Error): void;
}

/**
 * The client over the two pipe ends: `input` is what the browser writes
 * (its fd 4), `output` what it reads (its fd 3).
 */
export class CdpPipe {
  readonly #output: Writable;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(event: CdpEvent) => void>();
  readonly #closeListeners = new Set<() => void>();
  #nextId = 1;
  #chunks: Buffer[] = [];
  #closed = false;

  constructor(input: Readable, output: Writable) {
    this.#output = output;
    input.on("data", (chunk: Buffer) => this.#receive(chunk));
    input.on("end", () => this.#close());
    input.on("close", () => this.#close());
    // a broken pipe is a closed browser, not an exception in the host
    input.on("error", () => this.#close());
    output.on("error", () => this.#close());
  }

  /** Whether the pipe is gone - every later `send` rejects. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Sends one command and resolves with its `result`. `sessionId` addresses
   * an attached target (`Target.attachToTarget` with `flatten: true`);
   * without it the command goes to the browser itself.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (this.#closed) {
      return Promise.reject(new CdpError(`${method}: the browser is gone`));
    }
    const id = this.#nextId++;
    const message: CdpMessage = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.#output.write(JSON.stringify(message) + "\0");
    });
  }

  /** Listens to every event; the returned function stops listening. */
  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Called once when the pipe closes (the browser exited or hung up). */
  onClose(listener: () => void): void {
    if (this.#closed) {
      listener();
      return;
    }
    this.#closeListeners.add(listener);
  }

  /** Stops reading and fails what is still waiting. */
  dispose(): void {
    this.#close();
  }

  #receive(chunk: Buffer): void {
    let start = 0;
    let end = chunk.indexOf(0, start);
    while (end >= 0) {
      this.#chunks.push(chunk.subarray(start, end));
      const text = Buffer.concat(this.#chunks).toString("utf8");
      this.#chunks = [];
      this.#dispatch(text);
      start = end + 1;
      end = chunk.indexOf(0, start);
    }
    if (start < chunk.length) {
      this.#chunks.push(chunk.subarray(start));
    }
  }

  #dispatch(text: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(text) as CdpMessage;
    } catch {
      return; // not the protocol - nothing to answer, nothing to print
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new CdpError(`${pending.method}: ${String(message.error.message ?? "failed")}`)
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method === "string") {
      const event: CdpEvent = {
        method: message.method,
        params: message.params ?? {},
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      };
      for (const listener of [...this.#listeners]) {
        try {
          listener(event);
        } catch {
          // one listener's mistake must not starve the others
        }
      }
    }
  }

  #close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const [, pending] of this.#pending) {
      pending.reject(new CdpError(`${pending.method}: the browser is gone`));
    }
    this.#pending.clear();
    for (const listener of [...this.#closeListeners]) {
      listener();
    }
    this.#closeListeners.clear();
    this.#listeners.clear();
  }
}
