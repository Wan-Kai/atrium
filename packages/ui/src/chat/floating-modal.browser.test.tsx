import { UNKNOWN_METRICS } from "@atrium/protocol";
import { type ReactElement, useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { MenuButton } from "./menu-button";
import { ModelPicker } from "./model-picker";
import { CapsuleUnit } from "./run-control";
import { StatusBar } from "./status-bar";

beforeEach(() => page.viewport(1280, 820));

type Kind = "menu" | "capsule" | "model" | "status";

/**
 * A real floating consumer whose own open state outlives modal suspension.
 * @remarks Each surface must ignore dismissal intended for a modal above it.
 * @sideEffects Changes local open state as the capsule is clicked; mounts real floating consumers.
 * @param props - Which consumer to exercise.
 * @returns The background surface.
 */
function Background({ kind }: { readonly kind: Kind }): ReactElement | null {
  const [open, setOpen] = useState(false);
  switch (kind) {
    case "menu":
      return (
        <MenuButton label="背景菜单" content="菜单">
          {() => (
            <button type="button" role="menuitem">
              菜单项
            </button>
          )}
        </MenuButton>
      );
    case "capsule":
      return (
        <CapsuleUnit
          open={open}
          onToggle={() => setOpen(!open)}
          onClose={() => setOpen(false)}
          label="背景面板"
          span="content"
          capsule="背景胶囊"
        >
          胶囊内容
        </CapsuleUnit>
      );
    case "model":
      return (
        <ModelPicker
          shown={null}
          list={{ status: "ready", models: [], defaultModel: null, error: null }}
          login={null}
          disabled={false}
          onOpen={() => undefined}
          onRefresh={() => undefined}
          onChooseModel={() => undefined}
          onChooseLevel={() => undefined}
        />
      );
    case "status":
      return (
        <StatusBar
          metrics={UNKNOWN_METRICS}
          plans={[]}
          provider={null}
          choices={{ session: false, tokens: false, context: false }}
          onChoose={() => undefined}
        />
      );
  }
  return null;
}

/**
 * A background consumer and a modal mounted without a preceding outside pointer press.
 * @remarks Hidden popovers model the helper's modal suspension, not a user closing the surface.
 * @sideEffects Reports the modal's cancel and Escape actions.
 * @param props - The consumer, modal state and action record.
 * @returns The test scene.
 */
function Scene({ kind, modal, actions }: { readonly kind: Kind; readonly modal: boolean; readonly actions: string[] }) {
  return (
    <>
      <div
        inert={modal}
        data-testid="background"
        style={{ position: "fixed", left: 100, right: 100, top: 500, display: "flex" }}
      >
        <Background kind={kind} />
      </div>
      {modal ? (
        <div
          role="dialog"
          aria-modal
          aria-label="上层模态"
          style={{ position: "fixed", top: 200, left: 450, padding: 20 }}
          onKeyDown={(event) => {
            if (event.key === "Escape") actions.push("escape");
          }}
        >
          <button type="button" onClick={() => actions.push("cancel")}>
            取消模态
          </button>
        </div>
      ) : null}
    </>
  );
}

const CASES = [
  { kind: "menu", trigger: "背景菜单", role: "menu", name: "" },
  { kind: "capsule", trigger: "背景胶囊", role: "dialog", name: "背景面板" },
  { kind: "model", trigger: "模型与推理强度：未选择", role: "dialog", name: "模型与推理强度" },
  { kind: "status", trigger: "自定义状态栏", role: "dialog", name: "状态栏" },
] as const;

describe("Floating consumers suspended below a modal", () => {
  for (const testCase of CASES) {
    it(`keeps the ${testCase.kind} open while Escape and cancel belong to the modal`, async () => {
      const actions: string[] = [];
      const screen = await render(<Scene kind={testCase.kind} modal={false} actions={actions} />);
      const trigger = screen.getByRole("button", { name: testCase.trigger, exact: true });
      await trigger.click();
      const layer = screen.getByRole(testCase.role, { name: testCase.name }).element() as HTMLDivElement;
      await expect.poll(() => layer.matches(":popover-open")).toBe(true);
      await screen.rerender(<Scene kind={testCase.kind} modal actions={actions} />);
      // Suspension hides only the helper-owned surface; the consumer still owns open=true.
      await expect.poll(() => layer.matches(":popover-open")).toBe(false);
      const cancel = screen.getByRole("button", { name: "取消模态" });
      cancel.element().focus();
      await userEvent.keyboard("{Escape}");
      expect(actions).toStrictEqual(["escape"]);
      await cancel.click();
      expect(actions).toStrictEqual(["escape", "cancel"]);
      expect(screen.getByTestId("background").element().querySelector("button")?.getAttribute("aria-expanded")).toBe(
        "true",
      );
      await screen.rerender(<Scene kind={testCase.kind} modal={false} actions={actions} />);
      await expect.poll(() => layer.matches(":popover-open")).toBe(true);
      await expect
        .element(screen.getByRole("button", { name: testCase.trigger, exact: true }))
        .toHaveAttribute("aria-expanded", "true");
    });
  }

  it("leaves a sibling modal's model shortcuts alone even without an explicit inert background", async () => {
    const opened: string[] = [];
    const screen = await render(
      <>
        <ModelPicker
          shown={null}
          list={{ status: "ready", models: [], defaultModel: null, error: null }}
          login={null}
          disabled={false}
          onOpen={() => opened.push("open")}
          onRefresh={() => undefined}
          onChooseModel={() => undefined}
          onChooseLevel={() => undefined}
        />
        <div role="dialog" aria-modal aria-label="快捷键模态">
          <button type="button">模态内焦点</button>
        </div>
      </>,
    );
    const focus = screen.getByRole("button", { name: "模态内焦点" }).element();
    focus.focus();
    await userEvent.keyboard("{Meta>}{Shift>}i{/Shift}{/Meta}");
    await userEvent.keyboard("{Meta>}{Shift>}e{/Shift}{/Meta}");
    expect(opened).toStrictEqual([]);
    expect(document.activeElement).toBe(focus);
    expect(screen.container.querySelector('[aria-label="模型与推理强度"]')).toBeNull();
  });

  it("does not run a background model shortcut or request focus while its root is inert", async () => {
    const opened: string[] = [];
    const screen = await render(
      <>
        <div inert>
          <ModelPicker
            shown={null}
            list={{ status: "ready", models: [], defaultModel: null, error: null }}
            login={null}
            disabled={false}
            onOpen={() => opened.push("open")}
            onRefresh={() => undefined}
            onChooseModel={() => undefined}
            onChooseLevel={() => undefined}
          />
        </div>
        <button type="button">模态焦点</button>
      </>,
    );
    const focus = screen.getByRole("button", { name: "模态焦点" }).element();
    focus.focus();
    await userEvent.keyboard("{Meta>}{Shift>}i{/Shift}{/Meta}");
    await userEvent.keyboard("{Meta>}{Shift>}e{/Shift}{/Meta}");
    expect(opened).toStrictEqual([]);
    expect(document.activeElement).toBe(focus);
    expect(screen.container.querySelector('[aria-label="模型与推理强度"]')).toBeNull();
  });
});
