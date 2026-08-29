/*
 * Inspect: a clicked control in the running app, mapped back to the builder
 * call that wrote it.
 *
 * The runtime hook reports the clicked control's chain - its UI5 type and id,
 * then its parents' - and this module finds the best-matching node in the
 * view outline of the class. An explicit id settles it outright; otherwise
 * the control type plus the ancestor types decide, which also does the right
 * thing for aggregation templates: every cloned row item maps to the one
 * template call that wrote it.
 *
 * `vscode`-free: outline and chain in, node out - covered by the test suite.
 */

import { DEFAULT_LIBRARY, OutlineNode, splitName } from "./context";

/** One control of the runtime chain, innermost (the clicked one) first. */
export interface RuntimeControl {
  /** Library-qualified UI5 type, e.g. `sap.m.Button`. */
  type?: string;
  /** The runtime id - view-prefixed (`__xmlview0--main`) when the builder
   *  set one, generated (`__button3`) when not. */
  id?: string;
}

/** The library-qualified type an outline label resolves to. */
function qualifiedType(
  label: string,
  ns: Record<string, string>
): string | undefined {
  const { prefix, local } = splitName(label);
  const library = ns[prefix] ?? (prefix ? undefined : DEFAULT_LIBRARY);
  return library ? `${library}.${local}` : undefined;
}

/** The id as the builder wrote it: the runtime prefixes the view. */
function localId(runtimeId: string | undefined): string | undefined {
  if (!runtimeId) {
    return undefined;
  }
  const local = runtimeId.split("--").pop();
  // A generated id (`__button3`) names nothing the class wrote.
  return local && !local.startsWith("__") ? local : undefined;
}

/**
 * The outline node the clicked control most plausibly came from, or
 * undefined when nothing matches at all.
 *
 * Scoring: an id written in the class wins outright; otherwise every node of
 * the clicked type is scored by how much of its ancestor chain appears - in
 * order - among the runtime ancestors. Runtime-only layers in between (a
 * control's internal children) are skipped, which is what makes the
 * subsequence comparison rather than an exact one necessary.
 */
export function matchOutline(
  roots: OutlineNode[],
  ns: Record<string, string>,
  chain: RuntimeControl[]
): OutlineNode | undefined {
  const target = chain[0];
  if (!target) {
    return undefined;
  }
  const wantedId = localId(target.id);
  const runtimeAncestors = chain
    .slice(1)
    .map((c) => c.type)
    .filter((t): t is string => !!t);

  let best: OutlineNode | undefined;
  let bestScore = -1;

  const visit = (node: OutlineNode, ancestors: OutlineNode[]): void => {
    const type = qualifiedType(node.label, ns);
    const idMatch = !!wantedId && node.id === wantedId;
    if (idMatch || (!!type && type === target.type)) {
      let score = idMatch ? 1000 : 0;
      // Outline ancestors innermost-first against the runtime parents,
      // consumed monotonically - a subsequence match. An ancestor that is
      // not in the runtime chain at all (an aggregation element like
      // `content` or `items`, which the runtime never reports as a parent)
      // is skipped WITHOUT moving the cursor: exhausting it on the first
      // miss denied every outer ancestor its credit, all candidates scored
      // zero, and the first control of the clicked type won in document
      // order - the wrong builder call for every cloned row item.
      let ri = 0;
      for (let ai = ancestors.length - 1; ai >= 0; ai--) {
        const ancestorType = qualifiedType(ancestors[ai].label, ns);
        if (!ancestorType) {
          continue;
        }
        let probe = ri;
        while (
          probe < runtimeAncestors.length &&
          runtimeAncestors[probe] !== ancestorType
        ) {
          probe++;
        }
        if (probe < runtimeAncestors.length) {
          score++;
          ri = probe + 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    }
    for (const child of node.children) {
      visit(child, [...ancestors, node]);
    }
  };
  for (const root of roots) {
    visit(root, []);
  }
  return best;
}
