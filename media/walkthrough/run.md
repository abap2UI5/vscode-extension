# F9 runs the app

Open an ABAP class that implements `z2ui5_if_app` and press **F9**: the app
opens in an embedded preview next to the source, and the cursor stays in the
code.

The preview toolbar switches device widths (desktop / tablet / phone), UI5
themes and logon languages — and counts the app's **runtime errors** in a
badge; clicking it opens the abap2UI5 output log. The 🎯 button starts an
**inspect** pick (click a control, land on its builder call), and `{ }`
shows the app's **live JSON model** as a document.

If the class is not a z2ui5 app, F9 keeps its usual meaning (toggle
breakpoint), so the key is never lost.

If the preview stays **white or empty**, run *"abap2UI5: Check System
Connection"* — it names the step that fails (URL, host, logon, ICF path)
and the fix. The loading overlay offers the same check once a load takes
too long.
