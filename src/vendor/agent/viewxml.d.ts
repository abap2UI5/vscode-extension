/*
 * Types for the vendored viewxml.js (abap2UI5/mcp-server lib/viewxml.mjs).
 * Hand-written and THIS repository's own - scripts/vendor-agent.mjs copies
 * the JavaScript, not this file - so a re-vendor that changes an export's
 * shape has to update it here; src/test/agentvendor.test.ts exercises every
 * declaration against the real module.
 */

/** One element of a parsed view: namespaces resolved, entities decoded. */
export interface XmlNode {
  tag: string;
  prefix: string;
  local: string;
  /** The namespace URI the prefix resolves to (`sap.m`). */
  ns: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
  nsMap?: Record<string, string>;
}

export function decodeEntities(s: string): string;
export function parseViewXml(xml: string): XmlNode;
export const isAggregation: (node: XmlNode) => boolean;
export const controlName: (node: XmlNode) => string;

export type ParsedBinding =
  | { kind: "literal"; value: string | undefined }
  | {
      kind: "path";
      path: string;
      model: string;
      relative: boolean;
      type?: string;
      formatter?: boolean;
    }
  | { kind: "expression"; expression: string }
  | { kind: "composite"; parts: Array<Record<string, unknown>> };

export function parseBinding(value: string | undefined | null): ParsedBinding;

export function evalExpression(
  src: string,
  get: (path: string) => unknown
): unknown;

/** One argument of an event wire (`describe` is the snapshot's string form). */
export interface ArgDescriptor {
  static: boolean;
  value?: unknown;
  kind?: "row" | "model" | "source" | "parameters" | "event" | "expr" | "action";
  path?: string;
  prop?: string;
  raw?: string;
  describe?: string;
}

export function describeArg(raw: string): ArgDescriptor;

export type Wire =
  | { fn: "eB"; event: string; flags: string[]; args: ArgDescriptor[] }
  | { fn: "eF"; action: string; args: ArgDescriptor[] };

export function parseWire(value: string | undefined | null): Wire | null;
