- **Removing an attribute in the Control Properties view no longer takes its
  neighbour with it.** When two `a( )` calls shared a line, removing the
  second one cut the whole line - the first attribute included, and in the
  last line of a chain everything but the closing `).`. The edit now cuts
  exactly the call it was asked to remove, and keeps the chain balanced.
- **"Add attribute" works on the last control of a chain.** Its block ends
  with `… ).` on the attribute's own line, which the property editor read as
  "not chain style" and refused - on the final control of every chain, in
  all five templates. The new line now goes in front of that `).`, in the
  chain's own layout. A value continued over `&&` lines keeps its
  continuation lines together.
- **Renaming a bound attribute writes the binding path the framework
  derives.** abap2UI5 addresses `DATA mv_title` as `{/MV_TITLE}` - the name
  upper-cased - and F2 wrote the new name into the path as typed:
  `{/mv_header}`, a path that binds to nothing, which is the silently empty
  wire the rename exists to prevent. The identifier is written as typed, the
  path segment upper-cased.
- **F2 refuses a field of a `DATA: BEGIN OF … END OF` structure.** Its
  binding path is nested (`{/MS_DATA/TITLE}`), which the rename deliberately
  leaves alone - so accepting the field renamed its declaration, every
  same-named `TYPES` field and `ls_other-title`, and left the wire behind.
  The structure itself stays renameable, path included.
- **An abbreviation expanded inside a chain closes the containers it opens.**
  `Panel>content>Button` expanded mid-chain used to leave `Panel` and
  `content` open, so the line below the cursor - written for the Page -
  became a child of `content`. The expansion now ends with the `end( )`
  calls the next line's leading `)` completes.
- **F12 on `client->view_display( )` no longer jumps to the class's own
  `view_display`.** Go to Definition looked at the method name alone, and
  every template declares a method of that name. A call on any receiver
  other than `me->` is left to the ABAP extension.
- **The navigation map follows `CAST z2ui5_if_app( NEW zcl_x( ) )` to
  `zcl_x`.** The first Z-name in the call - the interface the result is cast
  to - used to be drawn as the target.
- **`BEGIN OF ENUM` and `BEGIN OF MESH` declare their type,** not a type
  called `ENUM` - which is what the roundtrip-cost annotation and F2 read.
- **A class shown in a diff is not a second class.** The revision side of a
  `git:` diff (and GitLens', the pull-request extensions' and output
  channels' read-only views) has the ABAP language id too, and entered the
  source scan as a duplicate: a second row in the apps tree, and an old
  revision that could shadow the class's inheritance entry. Those schemes
  are excluded; ADT's and every other virtual scheme keep working.
- **Converting XML reports an unquoted attribute.** `enabled=true` is not
  XML and was dropped without a word; the conversion now says so, like it
  does for text content and mismatched tags.
- **Colour swatches follow the builder's ownership rule.** An attribute
  written after `end( )` belongs to the container just closed - the rule
  completion and the view check already applied - not to the last control
  written above it, so a container's colour property gets its swatch even
  when the container has children.
- **Extract to View Method accepts a name starting with `_`,** as ABAP does
  (the framework's own `_bind` and `_event` start that way); the input box
  and the refusal share one rule instead of two copies.
- The property editor never reads a value across a line break (an ABAP
  literal ends at the end of its line), and a `CLASS … DEFINITION` written
  inside a multi-line string template no longer names the class for the
  CodeLens, F9 and the inheritance lookup.
