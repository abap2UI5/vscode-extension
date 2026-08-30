import js from "@eslint/js";
import tseslint from "typescript-eslint";

/*
 * The lint gate `npm run lint` runs after tsc. Tuned to the codebase as it
 * stands: the recommended typescript-eslint set, minus what the existing
 * style legitimately does (empty catch as fall-through, require() in the
 * CJS build script) - the gate exists to catch real mistakes, not to
 * reformat the world. Formatting stays with the author.
 */

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dist-test/**",
      "node_modules/**",
      "scripts/web-shims/**", // deliberately empty shims for the web bundle
      "*.vsix",
    ],
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["src/**/*.ts"],
  })),
  {
    files: ["src/**/*.ts"],
    rules: {
      // `catch { /* fall through */ }` is the codebase's deliberate idiom
      // for best-effort probes (see modelRootsOfSource, lintconfig).
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Unused function arguments document callbacks' shapes; the `_`
      // prefix marks the deliberate ones.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
    },
  },
  {
    // The suite's own idiom: a mid-test `require("../mod")` documents that
    // the import exists purely for that assertion.
    files: ["src/test/**/*.ts", "src/web/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // The build script and the generators are plain CJS/ESM Node scripts.
    //
    // They used to declare these globals and NOTHING else: the recommended
    // rule sets above are mapped to `src/**/*.ts`, so no rule at all applied
    // here and `eslint .` caught nothing but parse errors. These are the
    // files that fetch remote content and overwrite committed snapshots, and
    // they are outside tsconfig's `include` too, so `tsc --noEmit` never saw
    // them either - between the two gates they were unchecked. `js.configs
    // .recommended` is the plain-JavaScript half of what `src/**/*.ts` gets,
    // and it is what turns the globals below into a real `no-undef` check
    // rather than documentation.
    files: ["esbuild.js", "scripts/**/*.mjs", "src/test/desktop/*.mjs"],
    languageOptions: {
      // Hand-maintained rather than the `globals` package: it is a short,
      // readable list of what these scripts are actually allowed to reach
      // for, and a name that is not on it is a typo. `__dirname`/`__filename`
      // are here for the two esbuild `inject` shims, which are .mjs files
      // that end up inside a CJS bundle where both do exist.
      globals: {
        require: "readonly",
        module: "writable",
        process: "readonly",
        console: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        Buffer: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // The same idiom the TypeScript half allows: `catch { /* ignore */ }`
      // as a best-effort probe (esbuild.js's linterPin does exactly that).
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Every identifier these scripts use has to be either imported or in
      // the globals list above - the point of the block.
      "no-undef": "error",
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  }
);
