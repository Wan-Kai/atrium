import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { MUTATION_GROUPS } from "./mutation-groups.mjs";

const packages = "packages/*/{src,test}/**";
const root = import.meta.dirname;
const group =
  Object.entries(MUTATION_GROUPS).find(([name]) => name === process.env["ATRIUM_MUTATION_GROUP"])?.[1] ?? null;

/**
 * The test files under a directory, or the file itself.
 *
 * @remarks
 * For the groups' `tests` and `skip` (`mutation-groups.mjs`).
 *
 * @sideEffects none
 * @param place - A directory or a test file.
 * @returns Its globs.
 */
function testsIn(place: string): string[] {
  return place.endsWith(".ts") ? [place] : [`${place}/**/*.test.ts`];
}

/**
 * The Node test layers Stryker runs against each mutant, those of its group.
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
    globalSetup: ["./test-temp-root.ts"],
    // A group's run takes only its own tests (testing.md, "每个变异只跑本组的测试").
    include: group === null ? [`${packages}/*.test.ts`] : group.tests.flatMap(testsIn),
    exclude: [
      `${packages}/*.{pi,leak,soak,browser}.test.ts`,
      "**/node_modules/**",
      ...(group === null ? [] : group.skip.flatMap(testsIn)),
    ],
    testTimeout: 15_000,
    // Stryker runs four of these at once; three workers each keeps them within the machine's cores,
    // so a mutant's tests do not slow down past its timeout and pass for caught (testing.md).
    maxWorkers: 3,
  },
});
