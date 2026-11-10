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
      "packages/pi/src/config/*.ts",
      "packages/pi/src/events/*.ts",
      "packages/pi/src/history/*.ts",
      "packages/pi/src/sessions/*.ts",
      "packages/pi/src/locate/{version,locate,inspect,fd,node}.ts",
      "packages/pi/src/process/*.ts",
      "packages/pi/src/catalog/*.ts",
      "packages/pi/src/fast/*.ts",
      "packages/pi/src/edit/*.ts",
      "packages/pi/src/plan/*.ts",
      "packages/pi/src/extension/*.ts",
      "packages/pi/src/agent/*.ts",
      "packages/pi/src/task/*.ts",
      "packages/pi/src/study/*.ts",
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
      "packages/host/src/platform/{redact,resources,clock,login-shell,errors,proxy,stray-rejections}.ts",
      "packages/host/src/server/*.ts",
      "packages/host/src/store/*.ts",
      "!packages/host/src/store/learning-records.ts",
      "packages/host/src/sessions/{session-controller,session-metrics,session-catalog,layouts,prompt-line,index-commands,model-lister,titles,plan-usage,child-tree,children-usage,agent-relay,agent-launch,model-rules,stopped-edit}.ts",
      "packages/host/src/sync/*.ts",
      "packages/host/src/transcript/*.ts",
      "packages/host/src/files/*.ts",
      "packages/host/src/setup/*.ts",
    ],
    tests: ["packages/host"],
    skip: [
      "packages/host/src/tasks",
      "packages/host/src/dev/task-replay.test.ts",
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
  // The task core (SPEC-0006, T3): the scheduler's pure `step`, the graph validator and the store. The
  // files that only describe data or help tests are left out.
  tasks: {
    mutate: [
      "packages/host/src/tasks/*.ts",
      "!packages/host/src/tasks/*.test.ts",
      "!packages/host/src/tasks/test-support.ts",
      "!packages/host/src/tasks/scheduler-model.ts",
      "!packages/host/src/tasks/types.ts",
      // T4b: these need a real pi and real git; the host-layer tests (`node-run.host.test.ts`) cover them.
      "!packages/host/src/tasks/{runner,task-service,task-workspaces,new-task,node-ports}.ts",
      // T8a: the review gates and the hub have their own group below, with only their own tests.
      "!packages/host/src/tasks/{task-reviews,graph-diff}.ts",
      // T10: the schedules have their own group below.
      "!packages/host/src/tasks/{cadence,schedule-service,schedule-commands,schedule-rules}.ts",
      "!packages/host/src/tasks/*.break-check.json",
    ],
    tests: [
      "packages/host/src/tasks",
      "packages/host/src/dev/task-replay.test.ts",
      "packages/host/src/dev/task-try.test.ts",
    ],
    skip: [],
  },
  // The restart (SPEC-0006, T9): the runner's recovery, the task workspaces' plan and `recoverAll`, with the unit tests
  // that drive them over a fake session layer. The runner's other code is covered by the host-layer tests, which are
  // too slow per mutant, so a run names the lines it is about (`--mutate=<file>:<from>-<to>`).
  taskrunner: {
    mutate: [
      "packages/host/src/tasks/runner.ts",
      "packages/host/src/tasks/task-workspaces.ts",
      "packages/host/src/tasks/task-service.ts",
    ],
    tests: [
      "packages/host/src/tasks/runner.test.ts",
      "packages/host/src/tasks/t9-runner.test.ts",
      "packages/host/src/tasks/t9-service.test.ts",
      "packages/host/src/tasks/t910-service.test.ts",
      "packages/host/src/tasks/t10-service.test.ts",
      "packages/host/src/tasks/task-workspaces.test.ts",
    ],
    skip: [],
  },
  // The schedules (SPEC-0006, T10): the cadence arithmetic, the service over a fake clock and fake tasks, the commands and
  // the rules file. The host-layer tests (`schedules.host.test.ts`) cover the wiring and are not run per mutant.
  schedules: {
    mutate: [
      "packages/host/src/tasks/cadence.ts",
      "packages/host/src/tasks/schedule-service.ts",
      "packages/host/src/tasks/schedule-commands.ts",
      "packages/host/src/tasks/schedule-rules.ts",
    ],
    tests: [
      "packages/host/src/tasks/cadence.test.ts",
      "packages/host/src/tasks/schedule-service.test.ts",
      "packages/host/src/tasks/schedule-commands.test.ts",
      "packages/host/src/tasks/t910-service.test.ts",
    ],
    skip: [],
  },
  // The task conversation's tools (`task_set_schedule` is T10's) with their own fast unit tests; a run names the lines.
  taskconversation: {
    mutate: ["packages/host/src/tasks/conversation.ts"],
    tests: ["packages/host/src/tasks/conversation.test.ts"],
    skip: [],
  },
  // The task service's schedule parts (T10: saving a rule, making a task of a rule, the template) over a fake session layer;
  // the real-host test (`schedules.host.test.ts`) covers the wiring and is not run per mutant.
  schedulehost: {
    mutate: ["packages/host/src/tasks/task-service.ts"],
    tests: ["packages/host/src/tasks/t10-service.test.ts", "packages/host/src/tasks/t910-service.test.ts"],
    skip: [],
  },
  // The scheduler's pure `step` with only its own fast unit tests: for a run on a few lines of `scheduler.ts`
  // (`--mutate=<file>:<from>-<to>`), where the `tasks` group's host-layer tests would be run for every survivor.
  taskscheduler: {
    mutate: ["packages/host/src/tasks/scheduler.ts"],
    tests: [
      "packages/host/src/tasks/scheduler.test.ts",
      "packages/host/src/tasks/t9-scheduler.test.ts",
      "packages/host/src/tasks/scheduler-resources.test.ts",
      "packages/host/src/tasks/scheduler.prop.test.ts",
    ],
    skip: [],
  },
  // The worktree creator (T9: the plan and `adopt`) with its own tests, which run real git.
  worktreecreator: {
    mutate: ["packages/host/src/workspaces/worktree-creator.ts"],
    tests: ["packages/host/src/workspaces/worktree-creator.test.ts"],
    skip: [],
  },
  // The worktree include copy and the task locks (T9 / T10 review fixes) with their own real-git tests, so that a run on
  // one file does not run the whole `git` group's tests for every mutant.
  worktreeinclude: {
    mutate: ["packages/host/src/workspaces/worktree-include.ts"],
    tests: ["packages/host/src/workspaces/worktree-include.test.ts"],
    skip: [],
  },
  worktreelock: {
    mutate: ["packages/host/src/workspaces/worktree-lock.ts"],
    tests: ["packages/host/src/workspaces/worktree-lock.test.ts"],
    skip: [],
  },
  // The review hub and the task gates (ADR-0018, T8a): pure code, whose unit tests are quick; the real-host tests
  // (`reviews.host.test.ts`) cover the wiring and are not run per mutant.
  reviews: {
    mutate: [
      "packages/host/src/reviews/review-hub.ts",
      "packages/host/src/tasks/task-reviews.ts",
      "packages/host/src/tasks/graph-diff.ts",
    ],
    tests: [
      "packages/host/src/reviews/review-hub.test.ts",
      "packages/host/src/tasks/task-reviews.test.ts",
      "packages/host/src/tasks/graph-diff.test.ts",
      "packages/host/src/tasks/task-view.test.ts",
    ],
    skip: [],
  },
  ui: {
    mutate: [
      "packages/ui/src/chat/turn-layout.ts",
      "packages/ui/src/chat/plantuml.ts",
      "packages/ui/src/chat/plantuml-theme.ts",
      "packages/ui/src/chat/reply-image-source.ts",
      "packages/ui/src/chat/reply-file-target.ts",
      "packages/ui/src/chat/reply-data.ts",
      "packages/ui/src/chat/markdown-transforms.ts",
      "packages/ui/src/chat/image-preview-layout.ts",
      "packages/ui/src/chat/model-choice.ts",
      "packages/ui/src/chat/first-message.ts",
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
      "packages/ui/src/state/stopped-edits.ts",
      "packages/ui/src/state/new-workspace.ts",
      "packages/ui/src/state/panes.ts",
      "packages/ui/src/sidebar/names.ts",
      "packages/ui/src/sidebar/status.ts",
      "packages/ui/src/children/children.ts",
      "packages/ui/src/children/new-child.ts",
      "packages/ui/src/chat/agent-words.ts",
      "packages/ui/src/chat/question-state.ts",
      "packages/ui/src/chat/visual-reference.ts",
      "packages/ui/src/chat/visual-snapshots.ts",
      "packages/ui/src/chat/visual-presses.ts",
      "packages/ui/src/study/learning.ts",
      "packages/ui/src/study/progress.ts",
      "packages/ui/src/study/loop.ts",
      "packages/ui/src/study/home-view.ts",
      "packages/ui/src/study/archive.ts",
    ],
    tests: ["packages/ui"],
    skip: [],
  },
  // Inline visuals (SPEC-0007): the host's files, pages and messages, the desktop's sandbox rules, the extension's prompt.
  visuals: {
    mutate: [
      "packages/host/src/visuals/*.ts",
      "!packages/host/src/visuals/*.test.ts",
      "apps/desktop/src/main/visual-sandbox.ts",
      "apps/desktop/src/main/shortcuts.ts",
      // A learning direction's demo never goes to the browser (SPEC-0008, ML4 review).
      "apps/desktop/src/main/browsable.ts",
      "packages/pi/src/visuals/*.ts",
      "!packages/pi/src/visuals/*.test.ts",
    ],
    tests: [
      "packages/host/src/visuals",
      "packages/host/src/visuals.host.test.ts",
      "apps/desktop/src/main/visual-sandbox.test.ts",
      "apps/desktop/src/main/shortcuts.test.ts",
      "apps/desktop/src/main/browsable.test.ts",
      "packages/pi/src/visuals",
    ],
    skip: [],
  },
  // Study mode's directions on the host (SPEC-0008): scanning, naming, making and moving them.
  study: {
    mutate: [
      "packages/host/src/study/*.ts",
      // Their own group below, as the progress is ML2's.
      "!packages/host/src/study/{progress,progress-file,progress-rules,study-tools}.ts",
      "packages/host/src/store/learning-records.ts",
      "packages/host/src/sessions/read-only-transcripts.ts",
    ],
    tests: [
      "packages/host/src/study",
      "packages/host/src/store/learning-records.test.ts",
      "packages/host/src/sessions/read-only-transcripts.test.ts",
    ],
    skip: [],
  },
  // Study mode's progress on the host (SPEC-0008, "ML2 定的细节"): reading and writing
  // `.atrium-study.json`, the rules of tools, marks and the next step, and the tools' answers.
  studyProgress: {
    mutate: [
      "packages/host/src/study/progress.ts",
      "packages/host/src/study/progress-file.ts",
      "packages/host/src/study/progress-rules.ts",
      "packages/host/src/study/study-tools.ts",
    ],
    tests: ["packages/host/src/study"],
    skip: [],
  },
  // The phone's end-to-end encryption and the host's remote module (SPEC-0005, "Noise 通道", "宿主").
  remote: {
    mutate: ["packages/remote-crypto/src/**/*.ts", "packages/host/src/remote/*.ts", "apps/desktop/src/main/vault.ts"],
    tests: [
      "packages/remote-crypto",
      "packages/host/src/remote",
      "packages/host/test/remote",
      "apps/desktop/src/main/vault.test.ts",
    ],
    skip: [],
  },
  // The phone relay (SPEC-0005); `entry.ts` only wires the real clock and signals to `runCli`.
  relay: {
    mutate: ["apps/relay/src/*.ts", "!apps/relay/src/entry.ts"],
    tests: ["apps/relay"],
    skip: [],
  },
};
