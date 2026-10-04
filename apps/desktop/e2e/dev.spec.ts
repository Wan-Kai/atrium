import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { launchApp } from "./launch";
import { startStaticServer } from "./servers";

test("gives the development page a content security policy and still reaches the host", async () => {
  const devServer = await startStaticServer(join(import.meta.dirname, "..", "..", "..", "packages", "ui", "dist"));
  const launched = await launchApp({ ATRIUM_DEV_URL: devServer.url });

  const csp = await launched.window.evaluate(async () =>
    (await fetch(location.href)).headers.get("content-security-policy"),
  );

  expect(launched.window.url()).toBe(`${devServer.url}/`);
  expect(csp).toMatch(
    /^default-src 'self'; script-src 'self' 'unsafe-inline'; .*connect-src 'self' ws:\/\/127\.0\.0\.1:\d+; /,
  );
  await launched.close();
  await devServer.close();
});
