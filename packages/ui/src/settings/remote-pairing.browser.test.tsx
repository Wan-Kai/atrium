import type { RemotePairing } from "@atrium/protocol";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { RemotePairingDialog } from "./remote-pairing";
import "../styles.css";
import "./phone-section.css";

it.each([
  { model: "  iPhone 16 Pro  ", shown: "iPhone 16 Pro" },
  { model: "", shown: "未提供" },
  { model: " \t\n ", shown: "未提供" },
])(
  "labels the confirmation model as self-reported and not hardware attestation: '$model'",
  async ({ model, shown }) => {
    const pairing: RemotePairing = {
      pairingId: "pair_0123456789abcdef",
      qr: "atrium://pair?v=1&psk=synthetic",
      expiresAt: 300000,
      state: "awaiting_confirmation",
      handshaking: false,
      reason: null,
      request: { deviceName: "名字叫 iPhone 99", model, sas: "123456" },
      refused: 0,
    };
    const screen = await render(
      <RemotePairingDialog
        pairing={pairing}
        busy={false}
        online
        onClose={() => undefined}
        onRefresh={() => undefined}
        onConfirm={() => undefined}
        error={null}
      />,
    );
    const request = screen.container.querySelector(".phone-pair-request");
    expect(request?.querySelector("small")?.textContent).toBe(`型号：${shown}（手机自报，非硬件认证）`);
    await expect.element(screen.getByText("密钥已确认 · 2 分钟内确认", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("名字叫 iPhone 99 请求配对", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "确认配对", exact: true })).toBeEnabled();
  },
);
