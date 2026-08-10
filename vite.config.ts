import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
  },
  fmt: {},
  lint: {
    options: { typeAware: true, typeCheck: true },
    // The playground is a consumer app; it typechecks against the built
    // package (dist/) via the dedicated playground typecheck step.
    ignorePatterns: [".playground/**"],
  },
  pack: {
    entry: "src/index.ts",
    dts: true,
    deps: {
      // Peers must never be bundled — consumers supply their own.
      neverBundle: ["@rocicorp/zero", "vue"],
    },
    publint: true,
    attw: {
      // ESM-only package: node16-cjs consumers resolve to ESM. Intentional.
      ignoreRules: ["cjs-resolves-to-esm"],
    },
  },
});
