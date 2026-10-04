import { join } from "node:path";
import { defineConfig } from "vitest/config";

const packages = "packages/*/{src,test}/**";
const root = import.meta.dirname;

/**
 * The Node test layers Stryker runs against each mutant.
 *
 * @remarks
 * Unit, property and host-integration tests together decide whether a mutant is caught
 * (testing.md, "让每个测试都有效"); the browser and Electron layers are too slow to run per mutant.
 * Workspace packages are aliased to the source next to this file: Stryker's sandbox links each
 * package's `node_modules` back to the original checkout, which would otherwise make tests import
 * the unmutated code of other packages.
 */
export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      ["protocol", "client", "testkit", "pi"].map((name) => [
        `@atrium/${name}`,
        join(root, "packages", name, "src", "index.ts"),
      ]),
    ),
  },
  test: {
    include: [`${packages}/*.test.ts`, `${packages}/*.host.test.ts`],
    exclude: [`${packages}/*.{pi,leak,soak,browser}.test.ts`, "**/node_modules/**"],
    testTimeout: 15_000,
  },
});
