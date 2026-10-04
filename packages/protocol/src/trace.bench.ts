import { compareWithBaseline } from "@atrium/testkit";
import { expect, test } from "vitest";
import { parseTraceparent } from "./trace";

test("parsing a traceparent stays near its baseline speed", async ({ bench }) => {
  const ratio = await compareWithBaseline(bench, "parseTraceparent", ".bench/protocol/parse-traceparent.json", () =>
    parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
  );

  expect(ratio).toBeLessThan(3);
});
