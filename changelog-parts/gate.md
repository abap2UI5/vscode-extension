- **The bundled property gate reports what the CLI reports, for three more
  rules.** `absent-boolean-overrides-default` never fired in the editor: the
  gate handed the linter's ABAP rules the enum-typed fields of a bound table
  but not the boolean ones whose default is `true`, so a row that omits
  `iconInset` was red in CI and clean here. A class that builds a view and
  never displays it - or builds its views in helper methods the reconstruction
  cannot follow - answered "nothing to check" in the editor while CI reported
  `view-never-displayed`, the flow rules and the ABAP hygiene rules for it;
  the ABAP-side rules now run over such a class too, and "nothing to check"
  is only said when there is indeed no finding. The parity test that holds
  the gate to the linter's own pipeline covers all three with the linter's
  own fixtures.
- **The lightbulb offers every fix `abap2ui5lint --fix` applies.** The
  did-you-mean corrections (a misspelt control, property, aggregation, enum
  value or event parameter) and the deletion of a `json = abap_true` on a
  scalar property were attached by the CLI only - the quick fix, "fix all",
  the Autofix code lens and "Fix Workspace" saw the finding but no fix, in
  ABAP and in XML views alike. The parity test now compares the fixes as
  well, so a fix cannot go missing on one side again.
- **"Suppress on this line" in an XML view now works for an attribute inside a
  multi-line start tag.** The directive was written above the tag's `<`
  line, but the linter records the finding on the attribute's own line and
  reads directives per line - so the comment was placed correctly and
  suppressed nothing. Such a finding now gets an `abap2ui5lint-disable
  <rule>` / `abap2ui5lint-enable` pair around the whole tag, which the linter
  honours; a tag on one line keeps `disable-next-line`. Both are proven
  against the bundled linter.
- **"Check Workspace", "Fix Workspace" and "Update Baseline" look at exactly
  the files the CLI collects.** The sweep used to take every `*.abap` that
  calls the builder - including `*.clas.testclasses.abap`,
  `*.clas.locals_imp.abap` and reports the CLI never looks at - and ignored
  the config's `ignore` patterns and dot-directories. A baseline rebuilt from
  the editor could therefore carry entries CI fails as stale. The sweep now
  follows the CLI's collection rule (`*.clas.abap` and view/fragment XML, no
  `node_modules`, no dot-entries, the config's `ignore` honoured, directories
  included), and the baseline rebuild applies the same rule once more.
- **On vscode.dev, `enum-value-too-new` fires.** The web build's snapshot
  loader attached the enum table and the UI5 version the way the linter does,
  but not the per-value `@since` table the rule reads; the hidden tables are
  now held to the linter's own loader by a test.
- **On vscode.dev, `abap2ui5lint.jsonc` is read the way the CLI reads it.**
  The web build parsed the file as plain JSONC: an unknown key or rule id the
  CLI refuses was accepted, `"distribution": "OpenUI5"` was not recognised
  (which turned `sapui5-only-control` from an error into a hint) and a numeric
  `ui5` stayed a number. The linter's own `parseConfig` validates and
  normalises it now. An `extends` cannot be followed in the browser host and
  is said so in the output channel instead of being dropped silently.
- **Workspace fixes land on the right character in files with a byte-order
  mark.** The sweep read files from disk with the mark kept, the editor's
  document has none, so every fix in such a file was one character off. The
  sweep decodes like the live check does; as a consequence the sweep no
  longer reports `byte-order-mark` for a file on disk - the live check never
  did.
- **`abap2ui5.viewCheck.distribution` can be left undecided.** The setting
  used to default to `sapui5`, which silenced `sapui5-only-control` in every
  workspace that never thought about the distribution - while a configless
  `abap2ui5lint` run reports the control as a hint. The default is now empty,
  meaning "not decided", and the gate answers as the linter does: a hint, and
  the cue to write the distribution into `abap2ui5lint.jsonc`. `sapui5` and
  `openui5` behave as before.
- **A repository with `render: false` no longer hears "view check passed" for
  a render gate that did not run.** The render gate was started regardless of
  the config, came back with an empty report and read as a pass; it is now
  not started, and the message says "render gate off by config". A
  `rules['render-error']` entry with `exclude` patterns is applied against
  the real file's path (the CLI had matched it against the scratch copy in
  the temp directory, where it matched nothing), and its severity reaches the
  Problems panel.
- **A misspelt severity in `abap2ui5.viewCheck.rules` no longer shows as an
  error.** `"some-rule": "critical"` is not a severity the linter knows; it
  used to render every such finding as Error and is shown as Information now.
- **A change to a config named in an `extends` chain is picked up at once.**
  The repo config's cache watched the mtime of the discovered file only, so
  an edit to the base config it extends changed nothing in the editor until
  the extending file was touched; every file in the chain is watched now.
- Changing a setting or a config file re-checked every open document twice;
  once is enough.
