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
    files: ["esbuild.js", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        require: "readonly",
        module: "writable",
        process: "readonly",
        console: "readonly",
        __dirname: "readonly",
        URL: "readonly",
        fetch: "readonly",
      },
    },
  }
);
