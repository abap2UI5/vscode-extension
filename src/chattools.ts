/*
 * The language model tools the extension contributes to the editor's chat
 * (`contributes.languageModelTools`, `vscode.lm.registerTool`).
 *
 * They exist for what only the WINDOW knows and no MCP server can be asked:
 * the findings the view check has published for a document, the view the
 * linter reconstructs out of an open class, and the model of the app the
 * preview is showing right now. Everything the two MCP servers offer - the
 * checks over a file, the tools that act on a system - stays there and is
 * deliberately NOT repeated here: an agent that sees both surfaces would get
 * every tool twice, and a second path that acts on a system would need the
 * same gates a second time. All three tools only read, so none of them asks
 * for a confirmation (`prepareInvocation`).
 *
 * One implementation per tool: a tool is an `McpTool` (`mcprpc.ts` - name,
 * description, input schema, handler), built over a `ChatToolHost` that
 * hands in what the window knows. `CHAT_TOOLS` is the description the
 * manifest is held to (`manifestEntry`, pinned in `chattools.test.ts`), and
 * `invokeChatTool` is the adapter to the language-model-tool shape: input
 * in, text parts out.
 *
 * `vscode`-free: the host is injected - covered by the test suite.
 */

// types only: `mcprpc.ts` imports node's `crypto`, which the web bundle
// (this module is in its graph) must not pull in
import type { McpTool, McpToolResult } from "./mcprpc";
import { plural } from "./text";

/** Where an entry point runs - the web host has no preview, so no model. */
export type ChatToolSurface = "desktop" | "web";

/** The setting (under the `abap2ui5.` prefix) that switches the tools off. */
export const CHAT_TOOLS_SETTING = "chatTools";

/** What a tool's answer may weigh: a model dump of a real app runs into
 *  megabytes, and all of it would land in the chat's context. */
export const ANSWER_CAP_BYTES = 50 * 1024;

export interface ChatToolDefinition {
  /** The tool's id - `^[\w-]+$`, as the contribution point requires. */
  name: string;
  /** What `#…` in the chat input refers to it by. */
  toolReferenceName: string;
  displayName: string;
  /** For the user, in the tool picker. */
  userDescription: string;
  /** For the model: what it answers, when to call it, what it does not do. */
  modelDescription: string;
  icon: string;
  inputSchema: object;
  /** Needs the embedded preview, which exists in the desktop build only. */
  desktopOnly: boolean;
}

const URI_INPUT = {
  type: "object",
  properties: {
    uri: {
      type: "string",
      description:
        "The document's URI (file:///..., or the URI of a class opened from a " +
        "system), or an absolute file path. Omit it for the active editor.",
    },
  },
} as const;

export const FINDINGS_TOOL = "abap2ui5_get_view_findings";
export const VIEW_TOOL = "abap2ui5_get_reconstructed_view";
export const MODEL_TOOL = "abap2ui5_get_running_app_model";

export const CHAT_TOOLS: readonly ChatToolDefinition[] = [
  {
    name: FINDINGS_TOOL,
    toolReferenceName: "abap2ui5Findings",
    displayName: "abap2UI5 View Findings",
    userDescription:
      "The abap2UI5 view check's findings for the active file, as the Problems panel shows them.",
    modelDescription:
      "Returns the abap2UI5 view check's findings for one document - an abap2UI5 app " +
      "class (*.clas.abap) or an XML view - exactly as the editor's Problems panel " +
      "shows them: rule id, severity, 1-based line and message per finding. Defaults " +
      "to the active editor; pass `uri` for another document. It reads what the " +
      "editor has already published and does not run a check: a file that is neither " +
      "open nor covered by the last \"Check All Views in the Workspace\" has no " +
      "findings to report. Read-only.",
    icon: "$(checklist)",
    inputSchema: URI_INPUT,
    desktopOnly: false,
  },
  {
    name: VIEW_TOOL,
    toolReferenceName: "abap2ui5View",
    displayName: "abap2UI5 Reconstructed XML View",
    userDescription:
      "The XML view an abap2UI5 app class builds, reconstructed from its builder chain.",
    modelDescription:
      "Returns the XML view(s) an abap2UI5 app class builds with " +
      "z2ui5_cl_ui5_view_builder, reconstructed statically from the class source - " +
      "the same document \"Show Reconstructed XML View\" opens. Use it to see the " +
      "control tree, properties and bindings a builder chain produces without " +
      "running the app. Defaults to the active editor; pass `uri` for another " +
      "class. Read-only; no system is contacted.",
    icon: "$(code)",
    inputSchema: URI_INPUT,
    desktopOnly: false,
  },
  {
    name: MODEL_TOOL,
    toolReferenceName: "abap2ui5Model",
    displayName: "abap2UI5 Running App Model",
    userDescription:
      "The live JSON model of the app shown in the abap2UI5 preview.",
    modelDescription:
      "Returns the live JSON model of the abap2UI5 app currently shown in the " +
      "editor's embedded preview - the values the running app actually holds, as " +
      "the preview's { } button shows them. Use it to answer why a bound control " +
      "is empty or shows an unexpected value. Takes no input. Answers with a plain " +
      "sentence when no app is running in the preview. A large model is cut at " +
      `${ANSWER_CAP_BYTES / 1024} KB and the answer says so. Read-only: it asks ` +
      "the page already loaded and sends nothing to the system.",
    icon: "$(json)",
    inputSchema: { type: "object", properties: {} },
    desktopOnly: true,
  },
];

/** The definitions an entry point registers. */
export function chatToolsOn(surface: ChatToolSurface): ChatToolDefinition[] {
  return CHAT_TOOLS.filter((tool) => surface === "desktop" || !tool.desktopOnly);
}

/** The `when` clause of a tool's manifest entry: the setting, and for a
 *  desktop-only tool the host. */
export function whenClauseOf(tool: ChatToolDefinition): string {
  const setting = `config.abap2ui5.${CHAT_TOOLS_SETTING}`;
  return tool.desktopOnly ? `${setting} && !isWeb` : setting;
}

/** A tool's entry under `contributes.languageModelTools`, key for key. */
export function manifestEntry(tool: ChatToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    displayName: tool.displayName,
    toolReferenceName: tool.toolReferenceName,
    canBeReferencedInPrompt: true,
    icon: tool.icon,
    userDescription: tool.userDescription,
    modelDescription: tool.modelDescription,
    inputSchema: tool.inputSchema,
    when: whenClauseOf(tool),
  };
}

// ---------------------------------------------------------------------------
// What the window hands in
// ---------------------------------------------------------------------------

/** A host answer that is not a result: why there is none, as a sentence. */
export interface Unavailable {
  unavailable: string;
}

/** One published finding, as the Problems panel lists it. */
export interface ToolFinding {
  rule: string;
  severity: "error" | "warning" | "hint";
  /** 0-based, as the editor counts - the answer prints it 1-based. */
  line: number;
  message: string;
}

export interface DocumentFindings {
  /** How the document is named in the answer (a path or a uri). */
  document: string;
  findings: ToolFinding[];
}

export interface ReconstructedView {
  document: string;
  className: string;
  /** The formatted XML; empty when nothing could be reconstructed. */
  xml: string;
}

export interface RunningAppModel {
  className: string;
  /** The model as the app serialised it. */
  text: string;
}

export interface ChatToolHost {
  /** The findings published for a document - the active one without `uri`. */
  findings(uri: string | undefined): Promise<DocumentFindings | Unavailable>;
  /** The view reconstructed from a class - the active one without `uri`. */
  reconstructedView(uri: string | undefined): Promise<ReconstructedView | Unavailable>;
  /** The shown app's model - present on the desktop only. */
  runningAppModel?(): Promise<RunningAppModel | Unavailable>;
}

function textResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

function isUnavailable(answer: object): answer is Unavailable {
  return typeof (answer as Unavailable).unavailable === "string";
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

/**
 * Cuts a text at `capBytes` of UTF-8, on a character boundary, and says
 * whether it did. Counted in bytes because that is what the context pays.
 */
export function capText(
  text: string,
  capBytes = ANSWER_CAP_BYTES
): { text: string; truncated: boolean; totalBytes: number } {
  // TextEncoder, not Buffer: the web bundle runs this too
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= capBytes) {
    return { text, truncated: false, totalBytes: bytes.length };
  }
  let end = Math.max(0, capBytes);
  // never end inside a multi-byte sequence: step back off continuation bytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end--;
  }
  return {
    text: new TextDecoder().decode(bytes.subarray(0, end)),
    truncated: true,
    totalBytes: bytes.length,
  };
}

function kilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The sentence that follows a body that was cut. */
function truncationNote(what: string, totalBytes: number, capBytes: number): string {
  return (
    `[Truncated: ${what} is ${kilobytes(totalBytes)}, only the first ` +
    `${kilobytes(capBytes)} are shown.]`
  );
}

const SEVERITY_ORDER = { error: 0, warning: 1, hint: 2 } as const;

/** The findings answer: a count line, then one line per finding. */
export function formatFindings(answer: DocumentFindings, capBytes = ANSWER_CAP_BYTES): string {
  if (!answer.findings.length) {
    return (
      `No abap2UI5 view-check findings are published for ${answer.document}. ` +
      "Either the check found nothing, or the document has not been checked: " +
      "the check covers the documents open in the editor and, after \"Check All " +
      "Views in the Workspace\", every file of the workspace."
    );
  }
  const sorted = [...answer.findings].sort(
    (a, b) =>
      a.line - b.line ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.rule.localeCompare(b.rule)
  );
  const count = (severity: ToolFinding["severity"]) =>
    sorted.filter((finding) => finding.severity === severity).length;
  const header =
    `${plural(sorted.length, "abap2UI5 view-check finding")} in ${answer.document} ` +
    `(${plural(count("error"), "error")}, ${plural(count("warning"), "warning")}, ` +
    `${plural(count("hint"), "hint")}):`;
  const lines = sorted.map(
    (finding) =>
      `line ${finding.line + 1} [${finding.severity}] ${finding.rule}: ` +
      finding.message.replace(/\s*\n\s*/g, " ")
  );
  const body = lines.join("\n");
  const capped = capText(body, capBytes);
  if (!capped.truncated) {
    return `${header}\n${body}`;
  }
  // cut on a whole line - half a finding is worse than none
  const whole = capped.text.slice(0, capped.text.lastIndexOf("\n") + 1).trimEnd();
  const shown = whole ? whole.split("\n").length : 0;
  return (
    `${header}\n${whole}\n` +
    `[Truncated: the first ${shown} of ${plural(sorted.length, "finding")} are shown.]`
  );
}

/** The reconstructed-view answer: one naming line, then the XML. */
export function formatReconstructedView(
  answer: ReconstructedView,
  capBytes = ANSWER_CAP_BYTES
): string {
  if (!answer.xml.trim()) {
    return (
      `No view could be reconstructed from ${answer.className} (${answer.document}): ` +
      "nothing checkable came out of its builder chain."
    );
  }
  const capped = capText(answer.xml, capBytes);
  const head = `Reconstructed XML view of ${answer.className} (${answer.document}):`;
  return capped.truncated
    ? `${head}\n${capped.text}\n${truncationNote("the view", capped.totalBytes, capBytes)}`
    : `${head}\n${capped.text}`;
}

/** The model answer: pretty-printed JSON when it parses, capped either way. */
export function formatRunningAppModel(
  answer: RunningAppModel,
  capBytes = ANSWER_CAP_BYTES
): string {
  let body = answer.text;
  try {
    body = JSON.stringify(JSON.parse(answer.text), null, 2);
  } catch {
    // not JSON (the page cut an over-long dump) - still worth reading
  }
  if (!body.trim()) {
    return `${answer.className} is running in the preview, but its model is empty.`;
  }
  const capped = capText(body, capBytes);
  const head = `Live JSON model of ${answer.className}, the app shown in the preview:`;
  return capped.truncated
    ? `${head}\n${capped.text}\n` +
        truncationNote("the model", capped.totalBytes, capBytes) +
        " The JSON above is incomplete."
    : `${head}\n${capped.text}`;
}

// ---------------------------------------------------------------------------
// The tools, and the adapter to the language-model-tool shape
// ---------------------------------------------------------------------------

/** The optional `uri` argument: a non-empty string, or nothing. */
function uriArg(args: Record<string, unknown>): string | undefined {
  const uri = args.uri;
  return typeof uri === "string" && uri.trim() ? uri.trim() : undefined;
}

/**
 * The tools of one surface as `McpTool`s over the given host - the single
 * implementation of each. A problem (no active editor, not a class, no app
 * running) is a plain-text answer the model can act on, never an exception.
 */
export function chatTools(surface: ChatToolSurface, host: ChatToolHost): McpTool[] {
  const handlers: Record<string, McpTool["handler"]> = {
    [FINDINGS_TOOL]: async (args) => {
      const answer = await host.findings(uriArg(args));
      return textResult(isUnavailable(answer) ? answer.unavailable : formatFindings(answer));
    },
    [VIEW_TOOL]: async (args) => {
      const answer = await host.reconstructedView(uriArg(args));
      return textResult(
        isUnavailable(answer) ? answer.unavailable : formatReconstructedView(answer)
      );
    },
    [MODEL_TOOL]: async () => {
      if (!host.runningAppModel) {
        return textResult(
          "The running app's model is not available here: the embedded preview " +
            "exists in the desktop build of the extension only."
        );
      }
      const answer = await host.runningAppModel();
      return textResult(
        isUnavailable(answer) ? answer.unavailable : formatRunningAppModel(answer)
      );
    },
  };
  return chatToolsOn(surface).map((tool) => ({
    name: tool.name,
    description: tool.modelDescription,
    inputSchema: tool.inputSchema,
    handler: handlers[tool.name],
  }));
}

/** What a language model tool answers with: its text parts. */
export interface ChatToolAnswer {
  parts: string[];
}

function textParts(result: McpToolResult): string[] {
  return result.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string);
}

/**
 * Runs an `McpTool` for the language-model-tool surface: whatever the model
 * sent as input becomes the arguments (anything but an object counts as
 * none), the text content becomes the parts, and a handler that throws
 * answers with a sentence - the chat shows a thrown error as a failed tool
 * call the model learns nothing from.
 */
export async function invokeChatTool(tool: McpTool, input: unknown): Promise<ChatToolAnswer> {
  const args =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  try {
    const parts = textParts(await tool.handler(args));
    return { parts: parts.length ? parts : ["The tool returned no text."] };
  } catch (err) {
    return {
      parts: [
        `${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}
