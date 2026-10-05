import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["test/fixtures/**"],
  },
  lint: {
    ignorePatterns: ["test/fixtures/**"],
    options: { typeAware: true },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
  pack: {
    outDir: "lib",
    // "type": "module" makes the ESM output `index.js`, the file that `exports` names.
    fixedExtension: false,
    sourcemap: true,
    dts: { sourcemap: true },
    publint: true,
    // The package is ESM only, so the CommonJS resolution modes do not apply.
    attw: { profile: "esm-only" },
    // A publint or attw finding fails the build.
    failOnWarn: true,
  },
  staged: {
    "*": "vp check --fix",
  },
});
