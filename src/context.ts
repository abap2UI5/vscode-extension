/*
 * "What is being written here?" — the position analysis behind completion and
 * hover.
 *
 * abap2UI5 views are built by chaining calls on `z2ui5_cl_ui5_view_builder`, so the
 * control a property belongs to is not lexically around the cursor the way it
 * is in XML — it sits in the `ele( )` / `tag( )` call the `a( )` is chained
 * to. Getting that relationship right is the whole job of this module:
 *
 *   view->ele( n = `VBox` )->tag( n = `Button` )->a( n = `text` v = `Hi` )
 *                                        ^ the control            ^ its member
 *
 * Raw `*.view.xml` / `*.fragment.xml` files are handled too, where the same
 * three positions are simply the tag name, an attribute name and an attribute
 * value.
 *
 * This module is the one everybody imports from. The code lives in five
 * modules beside it, cut along what each reads:
 *
 *   contextnames.ts   the shared vocabulary (`WriteContext`, `splitName`)
 *   contextscan.ts    the ABAP call scan and the argument readers (internal)
 *   contextchain.ts   the builder chain: owner, write position, bindings,
 *                     outline, the control call the property editor edits
 *   contextevents.ts  `_event( )`, the WHEN dispatch, `_bind( )` arguments
 *   contextxml.ts     raw view / fragment XML
 *
 * None of them imports this file, so there is no cycle.
 *
 * `vscode`-free by design: this is the part with the interesting edge cases,
 * and the test suite drives it directly.
 */

export { DEFAULT_LIBRARY, splitName } from "./contextnames";
export type { ContextKind, WriteContext } from "./contextnames";

export {
  ContainerStack,
  abapBindingContextAt,
  abapContextAt,
  abapNsMap,
  controlCallAt,
  viewOutline,
} from "./contextchain";
export type {
  BindingContext,
  ChainAttribute,
  ControlCall,
  OutlineNode,
} from "./contextchain";

export {
  bindArgumentAt,
  bindableAttributes,
  checkedEvents,
  eventCaseRegion,
  eventCaseRegions,
  eventLiteralAt,
  eventNameAt,
  eventNameSpans,
  eventRaises,
  eventUsagesOf,
  ownLevel,
  whenBranchOf,
  whenBranches,
  whenLiteralAt,
  whenNameAt,
} from "./contextevents";
export type {
  BindArgument,
  BindableAttribute,
  CaseRegion,
  NamedSpan,
} from "./contextevents";

export {
  xmlContextAt,
  xmlNsMap,
  xmlNsMapAt,
  xmlScopedTags,
} from "./contextxml";
export type { ScopedXmlTag } from "./contextxml";
