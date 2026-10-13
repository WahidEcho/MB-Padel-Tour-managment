/**
 * The app's unit tests (`npm test`): pure modules only (no React Native), run
 * with the repository's vitest. `@core` is the one door to the shared code in
 * ../src/lib, as in tsconfig.json.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@core": fileURLToPath(new URL("./src/core/index.ts", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
