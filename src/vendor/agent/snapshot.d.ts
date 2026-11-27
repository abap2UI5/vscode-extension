/*
 * Types for the vendored snapshot.js (abap2UI5/mcp-server lib/snapshot.mjs):
 * the agent snapshot v1 shape of mcp-server's docs/agent-snapshot.md.
 * Hand-written and THIS repository's own - scripts/vendor-agent.mjs copies
 * the JavaScript, not this file; src/test/agentvendor.test.ts holds the
 * declared keys to what the real module produces from the vendored fixtures.
 */

export type Layer = "main" | "popup" | "popover";

export interface SnapshotField {
  id: string;
  path: string;
  name: string;
  label: string;
  control: string;
  kind: string;
  value: unknown;
  required: boolean;
  editable: boolean;
  values?: Array<{ key: string | number; text: string }>;
  layer: Layer;
}

export interface SnapshotAction {
  id: string;
  event: string;
  args: unknown[];
  label: string;
  control: string;
  trigger: string;
  enabled: boolean;
  scope: "screen" | "row";
  table?: string;
  layer: Layer;
}

export interface SnapshotTable {
  id: string;
  path: string;
  name: string;
  label: string;
  control: string;
  columns: Array<{ name: string; label: string }>;
  rowCount: number;
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  selectionMode: "None" | "Single" | "Multi";
  editableCells: string[];
  layer: Layer;
  selectionField?: string;
  /** A windowed table (window_bind_tab): the rows the backend holds in all. */
  total?: number;
  /** A windowed table: its window size, and - while rows are left - how
   *  `app_act { session, window: { table } }` loads them. */
  window?: { size: number; more?: string };
}

export interface SnapshotMessage {
  type: "success" | "info" | "warning" | "error";
  text: string;
  source: "toast" | "box" | "strip" | "field" | "model" | "popover" | "messageview";
  field?: string;
  /** Only on a MessagePopover / MessageView item, when not empty. */
  subtitle?: string;
  /** Only on a MessagePopover / MessageView item, when not empty. */
  description?: string;
}

/** Agent snapshot v1. */
export interface AgentSnapshot {
  snapshotVersion: 1;
  session: string;
  app: string;
  title: string;
  layer: Layer;
  fields: SnapshotField[];
  actions: SnapshotAction[];
  tables: SnapshotTable[];
  messages: SnapshotMessage[];
  texts: string[];
  unsupported: string[];
  pending?: string[];
}

/** The folded screen state across roundtrips (opaque to the extension). */
export interface ScreenState {
  app: string;
  id: string;
  slots: Record<string, { xml: string; app: string; options: unknown }>;
  models: Record<string, { app: string; data: unknown }>;
  custom: unknown[];
}

export const SNAPSHOT_VERSION: 1;
export const DEFAULT_MAX_ROWS: number;
export const MAX_ROWS_LIMIT: number;
export const FRONTEND_EVENTS: { POPUP: string; POPOVER: string };

/** One change a response makes to the view slots, in the order the
 *  frontend applies it: a teardown or a display. */
export type ViewChange =
  | { slot: string; destroy: true }
  | { slot: string; xml: string; options: Record<string, unknown> };

/** The order a frontend applies the entries of a protocol-3 VIEWS in. */
export const SLOT_ORDER: readonly string[];
/** The wire a response speaks: 3 when it declares it (S_FRONT.PROTOCOL) or
 *  carries VIEWS, NAV or ACTIONS; 2 otherwise (the S_ACTION envelope). */
export function protocolOf(response: unknown): 2 | 3;
/** VIEWS (protocol 3, in SLOT_ORDER) or the VIEW_SLOTS entries of
 *  S_ACTION.T_SYSTEM (protocol 2, in list order). */
export function viewChanges(response: unknown): ViewChange[];
/** ACTIONS (protocol 3) or S_ACTION.T_CUSTOM (protocol 2). */
export function followUpActions(response: unknown): unknown[];

export function emptyState(): ScreenState;
export function applyResponse(state: ScreenState | null, response: unknown): ScreenState;
export const modelKeyOf: (slot: string) => string;
export function getAt(data: unknown, path: string): unknown;
export function setAt(data: unknown, path: string, value: unknown): void;
export function nameOfPath(path: string): string;

export interface AnalyzeOptions {
  state?: ScreenState;
  response?: unknown;
  app?: string;
  session?: string;
  maxRows?: number;
  /** The linter's UI5 control snapshot (`loadSnapshot()`), or null. */
  metadata?: unknown;
  pending?: string[];
}

export function analyzeScreen(options: AnalyzeOptions): {
  snapshot: AgentSnapshot;
  index: unknown;
};
export function buildSnapshot(options: AnalyzeOptions): AgentSnapshot;
