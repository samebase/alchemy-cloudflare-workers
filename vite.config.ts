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
});
