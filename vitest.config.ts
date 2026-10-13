/**
 * Vitest for the whole repository (`npx vitest run`): the web platform's tests
 * and the Move Score app's pure tests. The app reaches the shared code through
 * `@core` (move-score-app/tsconfig.json); the app's own `npm test` uses
 * move-score-app/vitest.config.ts with the same alias.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@core": fileURLToPath(new URL("./move-score-app/src/core/index.ts", import.meta.url)) } },
});
