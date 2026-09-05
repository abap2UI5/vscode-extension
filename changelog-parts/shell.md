- **The `{ }` model button works for a namespace class.** `/UI2/CL_APP` starts
  with a slash, the virtual document's path therefore started with two, and
  the URI validator refused it - the button threw into the host log and did
  visibly nothing. The path uses the file-safe stem now; the raw name stays
  in the header comment.

- **Reloading and revealing an app tab no longer moves it.** `reveal( )`
  MOVES a shown panel to the column it is given, and "Beside" is relative to
  the active group - with three groups every F9 dragged the app tab from
  group 3 to group 2, and with the tab itself active it opened a fourth. An
  existing tab is revealed where it is; "Beside" is where a NEW tab opens.

- **Focus returns to the source only when there is one.** A start from Recent,
  the welcome view, the system search or MCP has no editor, and the previous
  F9's document came back into focus - reopened, even when it had been closed
  since. Such a start forgets the remembered source, and a closed document is
  never reopened.

- **The XML preview no longer freezes after a while.** VS Code drops a hidden
  virtual document after some minutes and asks for it again when the tab
  comes back; the preview read that drop as "tab closed" and stopped
  following the class for good. The open tabs decide now, and being asked
  for the content means the preview is open.

- **A theme or language switch keeps the activation watch running.** The
  preview reloads the version the server already has; nothing about the
  server changed, so a watch waiting behind the "not activated" badge keeps
  waiting instead of being cancelled.

- **No live token in the output channel, no logon parameters in tooltips.**
  A runtime error UI5 reports quotes the page URL - proxy origin and
  capability token included - and it went into the channel users paste into
  issues verbatim; it is redacted like the generated report. The full launch
  URL in the status-bar tooltip and the toolbar tooltip is shown without
  `sap-user`/`sap-password`.

- **`release.yml` accepts an annotated tag.** The retry check compared the
  tag OBJECT's hash with the commit and refused a `workflow_dispatch` retry
  with "already released from commit"; it reads the peeled ref first.

- **`manifest.test.ts` checks two more promises**: every `viewItem == …`
  clause names a contextValue the code sets, and every file the manifest
  points at - the icons, the walkthrough pages - exists.
