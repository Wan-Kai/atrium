import { defineConfig } from "vitest/config";

/** The spike's own test run: `pnpm --filter @atrium/spike-mobile-mp0 test`. */
export default defineConfig({ test: { include: ["*.test.ts"], testTimeout: 15_000 } });
