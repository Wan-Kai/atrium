import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { ConnectionStatus } from "./connection-status";

describe("ConnectionStatus", () => {
  it.each([
    [null, "未在桌面应用中运行"],
    [{ status: "connecting", traceId: "t" } as const, "正在连接宿主…"],
    [{ status: "connected", traceId: "t", hostVersion: "0.1.0" } as const, "已连接宿主 0.1.0"],
    [{ status: "rejected", reason: "unauthorized" } as const, "宿主拒绝了连接：凭证不对"],
    [{ status: "disconnected", code: 1006 } as const, "与宿主的连接已断开"],
  ])("describes %j to the user", async (state, text) => {
    const screen = await render(<ConnectionStatus state={state} />);

    await expect.element(screen.getByRole("status")).toHaveTextContent(text);
  });
});
