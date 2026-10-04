import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { ConnectionStatus, type StatusView } from "./connection-status";

describe("ConnectionStatus", () => {
  it.each<[StatusView, string]>([
    [{ status: "starting" }, "正在启动…"],
    [{ status: "unavailable" }, "未在桌面应用中运行"],
    [{ status: "bootstrap-failed" }, "无法从桌面应用取得连接信息，请重启 Atrium"],
    [{ status: "idle" }, "尚未连接"],
    [{ status: "connecting", traceId: "t" }, "正在连接宿主…"],
    [{ status: "connected", traceId: "t", hostVersion: "0.1.0" }, "已连接宿主 0.1.0"],
    [{ status: "rejected", reason: "unauthorized" }, "宿主拒绝了连接：凭证不对"],
    [{ status: "rejected", reason: "version-mismatch" }, "宿主和界面的版本不一致，请重启 Atrium"],
    [{ status: "rejected", reason: "bad-handshake" }, "宿主拒绝了连接：握手消息无效"],
    [{ status: "rejected", reason: "handshake-timeout" }, "连接宿主超时"],
    [{ status: "rejected", reason: "rate-limited" }, "发送的消息太多，宿主断开了连接"],
    [{ status: "rejected", reason: "too-many-connections" }, "宿主的连接数已满"],
    [{ status: "disconnected", code: 1006 }, "与宿主的连接已断开"],
  ])("describes %j to the user", async (view, text) => {
    const screen = await render(<ConnectionStatus view={view} />);
    const status = screen.getByRole("status");

    await expect.element(status).toBeVisible();
    expect(status.element().textContent).toBe(text);
  });
});
