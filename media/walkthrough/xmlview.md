# See the XML the builder actually produces

The view a class assembles with `z2ui5_cl_ui5_view_builder` never appears in the
source as XML — until now. *"abap2UI5: Show Reconstructed XML View"* opens
the reconstruction the view check validates as a live, syntax-highlighted
document beside the class:

- it follows the class you are editing - switch to another view-building
  class and the XML swaps along, edits re-render after each pause,
- the view check's findings are mirrored onto the XML lines they concern,
- **Go to Definition** on any line jumps to the `ele( )` / `tag( )` /
  `a( )` call that wrote it.

The Outline pane shows the same hierarchy inside the class itself, and Go to
Definition on an `_event( 'NAME' )` jumps to the `WHEN 'NAME'` that handles
it.
