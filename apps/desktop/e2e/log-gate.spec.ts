import { test } from "@playwright/test";
import { launchApp } from "./launch";

test("fails a test whose host log lacks a record it declared, once the app is closed", async () => {
  // The gate's own wiring (testing.md, "日志门禁"): this test must fail, and passing is the failure.
  test.fail();
  const launched = await launchApp();
  launched.expectLog({ level: "error", msg: "log gate self-test: never written", times: 1 });

  await launched.close();
});
