import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
  },
  fmt: {},
  lint: {
    options: { typeAware: true, typeCheck: true },
  },
  pack: {
    entry: "src/index.ts",
    format: ["esm", "cjs"],
    dts: true,
    deps: {
      // Peers must never be bundled — consumers supply their own.
      neverBundle: ["@rocicorp/zero", "vue"],
    },
    publint: true,
    attw: true,
  },
});
