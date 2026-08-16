/*
 * The files that turn a class into a PROJECT - what "New Project from
 * Template" writes.
 *
 * Why this exists: "New App from Template" hands out one class, at the cursor
 * or as an untitled document. That is the right thing when you already have a
 * repository. When you do not, it leaves the user with the one artefact the
 * extension cannot check properly: no `abap2ui5lint.jsonc` means the view
 * check falls back to VS Code settings, and the first CI run in that
 * repository disagrees with what the editor had been saying. The config the
 * extension itself searches for is the thing a new project was missing.
 *
 * Deliberately generated rather than cloned. abap2UI5/app-template is the
 * fuller article - it also ships AGENTS.md, a Claude permission allowlist and
 * a rename script - but cloning needs network and git, and an offline,
 * deterministic scaffold is testable, which the rest of this extension is
 * built to be. The notification points at the template repository for the
 * rest.
 *
 * `vscode`-free on purpose: the content is data, so the test suite runs every
 * generated class through the bundled linter the same way it does the
 * single-class templates.
 */

import { AppTemplate, templateSource } from "./template";

export interface ScaffoldFile {
  /** Path relative to the project root, POSIX separators. */
  path: string;
  content: string;
  /** abapGit serializes its XML with a UTF-8 BOM, and a BOM-less file comes
   *  back changed on the first pull - for everyone. */
  bom?: boolean;
}

/** abapGit derives the object name from the file name, so it has to match. */
const sidecar = (className: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_CLAS" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <VSEOCLASS>
    <CLSNAME>${className.toUpperCase()}</CLSNAME>
    <LANGU>E</LANGU>
    <DESCRIPT>abap2UI5 app</DESCRIPT>
    <STATE>1</STATE>
    <CLSCCINCL>X</CLSCCINCL>
    <FIXPT>X</FIXPT>
    <UNICODE>X</UNICODE>
   </VSEOCLASS>
  </asx:values>
 </asx:abap>
</abapGit>
`;

const LINT_CONFIG = `{
  // abap2UI5-linter settings for this repo. Precedence: CLI flag > this file
  // > built-in default. Every rule id has a page at
  // https://abap2ui5.github.io/linter/
  //
  // This file is also what the VS Code extension reads, so the editor and CI
  // judge your views by the same rules - which is the whole reason a new
  // project gets one.
  "$schema": "./node_modules/@abap2ui5/linter/data/abap2ui5lint.schema.json",

  "paths": ["src"],

  // The UI5 version your system serves. 1.71 is abap2UI5's own floor and the
  // safe default: a control or property that arrived later is reported here
  // instead of failing in the browser. Raise it once you know the system.
  "ui5": "1.71",

  // "sapui5" allows the libraries only SAPUI5 ships (sap.ui.comp, sap.suite.*,
  // sap.ushell, sap.fe). Switch to "openui5" if your system serves OpenUI5.
  "distribution": "sapui5",

  // Load every view in a headless browser as well - the check no static rule
  // can make. Saying so here makes it a REQUIREMENT: an unasked-for render
  // gate steps aside when @abap2ui5/render-runtime is missing and the run
  // stays green, which is how a gate quietly stops meaning anything.
  "render": true,

  // Lowest severity that fails the run: error | warning | hint | never.
  "failOn": "warning"
}
`;

const ABAPLINT_CONFIG = `{
  "global": {
    "files": "/src/**/*.*"
  },
  "dependencies": [
    {
      // the abap2UI5 framework this app runs on - cloned by abaplint for
      // dependency resolution (z2ui5_if_app, z2ui5_if_client,
      // z2ui5_cl_ui5_view_builder)
      "url": "https://github.com/abap2UI5/abap2UI5",
      "files": "/src/**/*.*"
    }
  ],
  "syntax": {
    "version": "v750",
    "errorNamespace": "^(Z|Y)"
  },
  "rules": {
    "begin_end_names": true,
    "check_syntax": true,
    "global_class": true,
    "implement_methods": true,
    "parser_error": true,
    "unknown_types": true,
    "obsolete_statement": true,

    // ---- The curated core -------------------------------------------------
    //
    // The same 56 rules abap2UI5/app-template carries, and the same reason:
    // abap2UI5 itself runs 152 abaplint rules, a starter project ran 17, so
    // the framework held itself to a standard it did not hand on. Of the 136
    // in between, 42 cannot fire in an abap2UI5 app at all (CDS, dynpro,
    // FORM, macros, message classes, IDoc) and 38 are taste a template must
    // not impose. These 56 are correctness, portability, SQL, dead weight and
    // the abapGit round trip.
    //
    // Measured before adopting: on abap2UI5/samples (317 files) they report
    // 127 findings, every one a genuine defect class; on a scaffolded project,
    // zero.

    // Correctness - a defect, not a preference
    "ambiguous_statement": true,
    "catch_and_raise": true,
    "check_abstract": true,
    "check_subrc": true,
    "classic_exceptions_overlap": true,
    "cyclic_oo": true,
    "dangerous_statement": true,
    "empty_statement": true,
    "identical_conditions": true,
    "identical_contents": true,
    "identical_descriptions": true,
    "identical_move": true,
    "index_completely_contained": true,
    "invalid_table_index": true,
    "method_overwrites_builtin": true,
    "no_chained_assignment": true,
    "parser_bad_exceptions": true,
    "parser_missing_space": true,
    "sy_modification": true,
    "try_without_catch": true,
    "uncaught_exception": true,
    "unnecessary_return": true,
    "unreachable_code": true,
    "use_class_based_exceptions": true,
    "when_others_last": true,

    // Portability - the app has to survive 7.02, the cloud, and the transpiler
    "cloud_types": true,
    "downport": true,
    "forbidden_void_type": true,
    "fully_type_constants": true,
    "fully_type_itabs": true,
    "inline_data_old_versions": true,
    "parser_702_chaining": true,

    // SQL - correctness and performance of what reaches the database
    "db_operation_in_loop": true,
    "modify_only_own_db_tables": true,
    "select_add_order_by": true,
    "select_performance": true,
    "select_single_full_key": true,
    "sql_escape_host_variables": true,
    "sql_value_conversion": true,
    "strict_sql": true,
    "unsecure_fae": true,

    // Dead weight - shipped, serialized, read by nobody
    "empty_event": true,
    "empty_structure": true,
    "superfluous_value": true,
    "unnecessary_chaining": true,
    "unnecessary_pragma": true,
    "unused_ddic": true,
    "unused_methods": true,
    "unused_types": true,
    "unused_variables": true,

    // The abapGit round trip - the file has to come back byte-identical
    "colon_missing_space": true,
    "contains_tab": true,
    "description_empty": true,
    "line_break_style": true,
    "local_testclass_consistency": true,
    "main_file_contents": true,

    // CLSNAME in the .clas.xml against the file name - the mistake that
    // happens when you copy a class and rename half of it
    "xml_consistency": true,
    // the ABAP editor strips a trailing blank when it saves, so a line that
    // ends in one comes back changed on the next pull, for everyone
    "whitespace_end": true,
    "7bit_ascii": true,
    "definitions_top": false,
    "line_length": { "length": 255 },
    "object_naming": {
      "patternKind": "required",
      "clas": "^ZCL_|^ZCX_",
      "intf": "^ZIF_"
    }
  }
}
`;

const CHECK_WORKFLOW = `# The two gates every abap2UI5 app repo gets for free - both run without an
# SAP system, and both are the versions pinned in package-lock.json, so a
# green \`npm run check\` on your machine means this passes too.
name: check

on:
  push:
    branches: [ main ]
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci

      - name: abaplint (expect 0 issues)
        run: npx abaplint abaplint.jsonc

      # the render gate drives a headless browser; @abap2ui5/render-runtime
      # (a devDependency) brings the UI5 sources it serves
      - name: Install Chromium
        run: npx playwright install chromium --with-deps

      # settings come from abap2ui5lint.jsonc, which asks for the render gate
      - name: abap2UI5-linter
        run: npx abap2ui5lint
`;

const README = (projectName: string, className: string): string =>
  `# ${projectName}

An [abap2UI5](https://github.com/abap2UI5/abap2UI5) app: UI5 in the browser,
written purely in ABAP.

## Run it

1. Install the abap2UI5 framework in your system with
   [abapGit](https://abapgit.org), and set up its HTTP handler
   ([documentation](https://abap2ui5.github.io/docs/get_started/quickstart)).
2. Pull this repository with abapGit too.
3. Open \`<your endpoint>?app_start=${className.toUpperCase()}\`.

## Check it, without a system

\`\`\`sh
npm ci
npx playwright install chromium   # once, for the render gate
npm run check
\`\`\`

\`npm run check\` is what CI runs: abaplint for the ABAP, and the
[abap2UI5-linter](https://github.com/abap2UI5/linter) for the class and the
view it builds together - including loading every view in a real browser.
\`npm run fix\` applies what can be applied.

The VS Code extension reads the same \`abap2ui5lint.jsonc\`, so the editor and
CI never disagree.

## Make it yours

The class is \`${className.toUpperCase()}\`; rename it in
\`src/${className}.clas.abap\` **and** in the \`CLSNAME\` of its \`.clas.xml\`
(\`xml_consistency\` fails the check if only one moves). \`.abapgit.xml\` carries
the repository name, \`src/package.devc.xml\` the ABAP package description.

[abap2UI5/app-template](https://github.com/abap2UI5/app-template) is the
fuller starting point - same gates, plus an \`AGENTS.md\` for AI assistants and
an \`npm run rename\` that does all of the above in one command.
`;

const PACKAGE_JSON = (projectName: string): string =>
  `${JSON.stringify(
    {
      name: projectName,
      private: true,
      version: "1.0.0",
      description: "abap2UI5 app",
      scripts: {
        check: "npm run check:abap && npm run check:abap2ui5",
        "check:abap": "abaplint abaplint.jsonc",
        "check:abap2ui5": "abap2ui5lint",
        "check:abap2ui5:fast": "abap2ui5lint --no-render",
        fix: "abap2ui5lint --fix",
      },
      devDependencies: {
        "@abap2ui5/linter": "^0.1.1",
        "@abap2ui5/render-runtime": "^0.1.1",
        "@abaplint/cli": "^2.119.66",
      },
      engines: { node: ">=22" },
    },
    null,
    2
  )}\n`;

/**
 * Every file a new abap2UI5 project needs, as data.
 *
 * @param projectName  repository/npm name, e.g. `my-app`
 * @param className    the app class, lower case, e.g. `zcl_my_app`
 */
export function scaffoldFiles(
  projectName: string,
  className: string,
  template: AppTemplate
): ScaffoldFile[] {
  const cls = className.toLowerCase();
  return [
    { path: `src/${cls}.clas.abap`, content: `${templateSource(template, cls)}\n` },
    { path: `src/${cls}.clas.xml`, content: sidecar(cls), bom: true },
    {
      path: "src/package.devc.xml",
      bom: true,
      content: `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_DEVC" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <DEVC>
    <CTEXT>${projectName}</CTEXT>
   </DEVC>
  </asx:values>
 </asx:abap>
</abapGit>
`,
    },
    {
      path: ".abapgit.xml",
      bom: true,
      content: `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
 <asx:values>
  <DATA>
   <NAME>${projectName}</NAME>
   <MASTER_LANGUAGE>E</MASTER_LANGUAGE>
   <STARTING_FOLDER>/src/</STARTING_FOLDER>
   <FOLDER_LOGIC>PREFIX</FOLDER_LOGIC>
  </DATA>
 </asx:values>
</asx:abap>
`,
    },
    { path: "abap2ui5lint.jsonc", content: LINT_CONFIG },
    { path: "abaplint.jsonc", content: ABAPLINT_CONFIG },
    { path: "package.json", content: PACKAGE_JSON(projectName) },
    { path: ".github/workflows/check.yml", content: CHECK_WORKFLOW },
    { path: "README.md", content: README(projectName, cls) },
    { path: ".gitignore", content: "node_modules/\n" },
  ];
}

/** Built rather than written literally: an invisible character in a source
 *  file is the kind of thing an editor, a formatter or a paste drops without
 *  anyone noticing. */
const BOM = String.fromCharCode(0xfeff);

/**
 * The exact text to write for one scaffold file - the BOM belongs to the
 * content, so that whether a file gets one is decided (and tested) here
 * rather than at the call site.
 */
export function scaffoldText(file: ScaffoldFile): string {
  return file.bom ? BOM + file.content : file.content;
}

/** npm package names: lower case, no spaces, no leading dot or underscore. */
export function projectNameFrom(folderName: string): string {
  const name = folderName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/-+$/, "");
  return name || "abap2ui5-app";
}
