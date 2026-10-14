import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { RenameField } from "./rename-field";

/**
 * The field and its hint, renamed in a row whose text starts 20px in, as a sidebar row's does.
 *
 * @sideEffects Renders.
 * @param props - What the hint offers besides saving and cancelling, and whether it floats above.
 * @returns The row, the field, its hint, and what the field reported.
 * @throws When the field has no hint.
 */
async function renamed(props: { readonly restores?: string; readonly above?: boolean } = {}) {
  const onDone = vi.fn<(name: string | null | undefined) => void>();
  const screen = await render(
    <div style={{ padding: 60 }}>
      <div
        data-testid="row"
        style={{ display: "flex", alignItems: "center", height: 34, paddingLeft: 20, fontSize: 14 }}
      >
        <RenameField initial="atrium" label="项目名称" onDone={onDone} {...props} />
      </div>
    </div>,
  );
  const field = screen.getByRole("textbox", { name: "项目名称" });
  await expect.element(field).toHaveFocus();
  const input = field.element();
  const hint = document.getElementById(input.getAttribute("aria-describedby") ?? "");
  if (hint === null) throw new Error("no hint");
  return { row: screen.getByTestId("row").element(), input, hint, onDone };
}

/**
 * An element's box.
 *
 * @sideEffects none
 * @param element - The element, which must be there.
 * @returns Its box.
 * @throws When it is not there.
 */
function box(element: Element | null): DOMRect {
  if (element === null) throw new Error("not there");
  return element.getBoundingClientRect();
}

describe("RenameField", () => {
  it("lies over the name it renames, its text where the name was, ringed in the tint", async () => {
    const { row, input } = await renamed();

    const style = getComputedStyle(input);
    expect(box(input).left - box(row).left).toBe(14);
    expect([style.paddingLeft, style.height, style.borderRadius, style.fontSize]).toStrictEqual([
      "6px",
      "26px",
      "6px",
      "14px",
    ]);
    expect(style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(style.boxShadow).toBe("rgb(47, 111, 237) 0px 0px 0px 1px inset, rgba(47, 111, 237, 0.16) 0px 0px 0px 3px");
  });

  it("says below it how to save and cancel, in a small float lined up with it, over whatever clips the row", async () => {
    const { input, hint } = await renamed();

    expect(hint.textContent).toBe("⏎保存esc取消");
    expect(box(hint).top - box(input).bottom).toBe(4);
    expect(box(hint).left).toBe(box(input).left);
    const style = getComputedStyle(hint);
    expect([style.position, style.fontSize, style.color, style.borderRadius]).toStrictEqual([
      "fixed",
      "11px",
      "rgb(110, 110, 116)",
      "6px",
    ]);
  });

  it("says too how to go back to the usual name, where there is one", async () => {
    const { hint } = await renamed({ restores: "清空恢复为分支名" });

    expect(hint.textContent).toBe("⏎保存esc取消清空恢复为分支名");
  });

  it("floats its hint above when told", async () => {
    const { input, hint } = await renamed({ above: true });

    expect(box(input).top - box(hint).bottom).toBe(4);
  });

  it("saves what is typed over the name on Enter, once", async () => {
    const { onDone } = await renamed();

    await userEvent.keyboard("pi{Enter}");

    expect(onDone.mock.calls).toStrictEqual([["pi"]]);
  });
});
