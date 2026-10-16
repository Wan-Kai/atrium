/**
 * The groups mutation testing runs in, each with the files it mutates and the tests it runs.
 *
 * @remarks
 * Every mutant used to run the whole Node suite, nearly four fifths of which is three test files
 * driving real git; a mutant in the protocol does not need them. Each group runs only the tests of
 * its own code and of what uses it most (testing.md, "每个变异只跑本组的测试"). `tests` are
 * directories or files, read by `vitest.mutation.config.ts`; `skip` leaves some of them out.
 */
export const MUTATION_GROUPS = {
  shared: {
    mutate: ["packages/protocol/src/**/*.ts", "packages/client/src/**/*.ts"],
    tests: ["packages/protocol", "packages/client", "packages/host/src/server", "packages/host/src/sync"],
    skip: [],
  },
  pi: {
    mutate: [
      "packages/pi/src/env/*.ts",
      "packages/pi/src/events/*.ts",
      "packages/pi/src/history/*.ts",
      "packages/pi/src/sessions/*.ts",
      "packages/pi/src/locate/{version,locate,inspect,fd,node}.ts",
      "packages/pi/src/process/*.ts",
      "packages/pi/src/catalog/*.ts",
      "packages/pi/src/fast/*.ts",
      "packages/pi/src/plan/*.ts",
      "packages/pi/src/extension/*.ts",
      "packages/pi/src/stats/*.ts",
      "packages/pi/src/oneshot/oneshot.ts",
      "packages/pi/src/auth/login.ts",
      "packages/testkit/src/clock.ts",
    ],
    tests: ["packages/pi", "packages/testkit", "packages/host/src/sessions"],
    skip: [],
  },
  host: {
    mutate: [
      "packages/host/src/platform/{redact,resources,clock,login-shell,errors,proxy}.ts",
      "packages/host/src/server/*.ts",
      "packages/host/src/store/*.ts",
      "packages/host/src/sessions/{session-controller,session-metrics,session-catalog,layouts,prompt-line,index-commands,model-lister,titles,plan-usage}.ts",
      "packages/host/src/sync/*.ts",
      "packages/host/src/transcript/*.ts",
      "packages/host/src/files/*.ts",
      "packages/host/src/setup/*.ts",
    ],
    tests: ["packages/host"],
    skip: [
      "packages/host/src/workspaces",
      "packages/host/src/changes",
      "packages/host/src/projects",
      "packages/host/src/changes.host.test.ts",
      "packages/host/src/index.host.test.ts",
    ],
  },
  git: {
    mutate: [
      "packages/host/src/platform/git.ts",
      "packages/host/src/projects/*.ts",
      "packages/host/src/workspaces/*.ts",
      "packages/host/src/changes/*.ts",
    ],
    tests: [
      "packages/host/src/workspaces",
      "packages/host/src/changes",
      "packages/host/src/projects",
      "packages/host/src/platform/git.test.ts",
      "packages/host/src/changes.host.test.ts",
      "packages/host/src/index.host.test.ts",
    ],
    skip: [],
  },
  ui: {
    mutate: [
      "packages/ui/src/chat/turn-layout.ts",
      "packages/ui/src/chat/model-choice.ts",
      "packages/ui/src/chat/composer-text.ts",
      "packages/ui/src/chat/builtin-commands.ts",
      "packages/ui/src/chat/changes.ts",
      "packages/ui/src/files/file-icons.ts",
      "packages/ui/src/files/trees.ts",
      "packages/ui/src/files/file-facts.ts",
      "packages/ui/src/files/languages.ts",
      "packages/ui/src/files/diff-sides.ts",
      "packages/ui/src/files/workspace-path.ts",
      "packages/ui/src/state/workspace-views.ts",
      "packages/ui/src/chat/status-figures.ts",
      "packages/ui/src/state/drafts.ts",
      "packages/ui/src/state/new-workspace.ts",
      "packages/ui/src/state/panes.ts",
      "packages/ui/src/sidebar/names.ts",
      "packages/ui/src/sidebar/status.ts",
      "packages/ui/src/tabs/hand-off.ts",
    ],
    tests: ["packages/ui"],
    skip: [],
  },
};
